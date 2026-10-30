import { randomUUID } from 'node:crypto';
import { classifyProviderError } from '../src/provider-error.js';
import {
  classifySubmission,
  parseCalendarDate,
  type FollowUpDraftBasis,
  type RowFacts,
  type SubmissionClass,
} from './application-actions-core.js';
import {
  DRAFTABLE_CLASSES,
  NOT_SUBMITTED_MESSAGE,
  failureResult,
  okResult,
  type ActionsDeps,
  type FailureCode,
} from './application-actions-service.js';
import type {
  ActionsResult,
  DraftDecisionRequest,
  EditDraftRequest,
  GenerateDraftRequest,
  ReportSentRequest,
} from './application-actions-types.js';
import { getInterviewContextBasis, type InterviewContextBasis } from './interview-context-service.js';
import {
  buildFollowUpPrompt,
  factsHash,
  parseFollowUpOutput,
  ungroundedTokens,
  type FollowUpFacts,
} from './follow-up-draft.js';
import { cancelFollowUp, isRunLive, releaseRun, reserveRun } from './follow-up-runs.js';
import { getAction } from './workspace/application-action-store.js';
import {
  approveDraft,
  discardDraft,
  editDraft,
  getDraftByRequest,
  insertDraft,
  reportSent,
} from './workspace/follow-up-draft-store.js';
import type { WorkspaceDb } from './workspace/client.js';
import * as workspace from './workspace/repository.js';
import { WorkspaceNotFoundError } from './workspace/repository.js';
import type { ApplicationRecord } from './workspace/types.js';

/**
 * #692: reviewed follow-up drafts. Everything here starts from a person's explicit button press and
 * produces TEXT they review and send themselves, somewhere this app does not reach.
 *
 *  - One model call per request, in the same closed-tool, no-network text session the independent review
 *    uses. No retry, no second session, no background run.
 *  - A draft is saved only if the application, the planned step and the recorded documents are still what
 *    it was written from. A cancelled, failed, invalid, ungrounded, stale or reset run saves nothing and
 *    never touches an earlier draft.
 *  - Writing, editing and approving a draft are preparation. Whether a message was SENT is only ever the
 *    person's own report (`reportDraftSent`); nothing here sends, reads a mailbox, writes a calendar or
 *    changes the application's status, next step or notes.
 */

export interface GenerateResult {
  ok: boolean;
  text: string;
  error?: string;
  usage?: { inputTokens?: number; outputTokens?: number };
}

export interface FollowUpDeps extends ActionsDeps {
  /** ONE fresh closed-tool, no-network session. The only step that can reach a model. */
  generate(prompt: string, signal: AbortSignal): Promise<GenerateResult>;
  provider: string;
  log?(message: string, meta?: Record<string, unknown>): void;
}

const RUN_MESSAGE = {
  failed: 'The draft did not finish. Nothing was saved and your earlier drafts are unchanged.',
  cancelled: 'The draft was cancelled. Nothing was saved and your earlier drafts are unchanged.',
  timed_out: 'The assistant did not answer in time. Nothing was saved and your earlier drafts are unchanged.',
  provider_limit: 'The assistant hit a usage limit. Nothing was saved. Try again after it resets.',
  invalid_output: 'The assistant answered in a form this app could not use, so nothing was kept.',
  ungrounded: 'The draft mentioned a date, link or address that is not in your records, so nothing was kept.',
  discarded:
    'The application, the follow-up or the recorded documents changed while the draft was being written, so the result was thrown away. Ask again for a current one.',
} as const;

const DRAFT_MESSAGE = {
  not_found: 'That draft is no longer available.',
  outdated: 'This draft changed since you opened it. Check it and try again.',
  frozen: 'You reported this draft as sent, so its text is kept as it was.',
  discarded: 'That draft was discarded.',
  limit: 'This application already has the most drafts this app keeps. Discard one you no longer need.',
} as const;

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function classifyFailure(error: string): 'cancelled' | 'timed_out' | 'provider_limit' | 'failed' {
  if (/\bwas cancelled\b|\bcancelled\b/iu.test(error)) return 'cancelled';
  if (/no response after \d+s/iu.test(error)) return 'timed_out';
  if (classifyProviderError(error).kind === 'usage_limit') return 'provider_limit';
  return 'failed';
}

const PROVENANCE_WORDING: Record<string, string> = {
  prepared: 'prepared by this app; nobody confirmed it is the file that was sent',
  user_confirmed: 'the candidate confirmed this is what they sent',
  receipt_backed: 'attached by this app, and the employer confirmation was seen',
  unknown: 'the candidate said they do not know exactly what was sent',
};

function factsOf(record: ApplicationRecord): RowFacts {
  return {
    status: record.status,
    archived: record.archived,
    appliedAt: record.appliedAt,
    attempt: record.attempt ? { checkpoint: record.attempt.checkpoint, evidence: record.attempt.evidence } : null,
  };
}

interface Prepared {
  facts: FollowUpFacts;
  prompt: string;
  hash: string;
  basis: Omit<FollowUpDraftBasis, 'factsHash'>;
  actionVersion: number | null;
}

type PrepareResult = { ok: true; value: Prepared } | { ok: false; code: FailureCode; message: string };

/**
 * Collects the grounded facts. The recorded package is used only when #691's resolver names ONE sent
 * package for this application; otherwise the CURRENT linked documents are used and the draft says so.
 *
 * Synchronous on purpose (nothing here reads a file or calls a provider), so the same function runs once
 * before the model call and again INSIDE the write transaction, against that transaction's own view of the
 * database, and the two hashes can be compared with nothing able to change in between.
 */
function prepare(db: WorkspaceDb, applicationId: string, actionId: string | null, log?: FollowUpDeps['log']): PrepareResult {
  const record = workspace.listApplications(db, 'all').find((candidate) => candidate.id === applicationId);
  if (!record) return { ok: false, code: 'not_found', message: 'That application is no longer available.' };
  const action = actionId ? getAction(db, applicationId, actionId) : null;
  if (actionId && !action) return { ok: false, code: 'not_found', message: 'That follow-up is no longer available.' };
  if (action && action.state !== 'open') return { ok: false, code: 'not_open', message: 'That follow-up was already completed or dismissed.' };
  const submissionClass: SubmissionClass = classifySubmission(factsOf(record));
  if (!DRAFTABLE_CLASSES.has(submissionClass)) return { ok: false, code: 'not_submitted', message: NOT_SUBMITTED_MESSAGE };

  let view: InterviewContextBasis | null;
  try {
    view = getInterviewContextBasis(db, applicationId);
  } catch (error) {
    log?.('recorded documents unavailable for the draft; using current documents', { error: describe(error) });
    view = null;
  }
  const chosen = view && view.selection !== 'choose' && view.defaultPackageId ? view.packages.find((pkg) => pkg.id === view.defaultPackageId) : undefined;
  const sentPackage = chosen && (chosen.kind === 'recorded' || chosen.kind === 'legacy' || (chosen.kind === 'row' && chosen.documents.length > 0)) ? chosen : null;

  let basis: Omit<FollowUpDraftBasis, 'factsHash'>;
  let documents: FollowUpFacts['basis']['documents'];
  let letterText: string | null;
  let label: string;
  if (sentPackage) {
    const letter = sentPackage.documents.find((doc) => doc.slot === 'letter');
    documents = sentPackage.documents.map((doc) => ({
      slot: doc.slot,
      provenance: PROVENANCE_WORDING[doc.provenance] ?? doc.provenance,
      version: doc.version,
      name: doc.fileName,
    }));
    letterText = letter && letter.textState === 'available' ? letter.text : null;
    label =
      sentPackage.kind === 'row'
        ? 'Written from the documents you told this app you sent.'
        : `Written from the documents recorded for this submission${sentPackage.version ? ` (record ${sentPackage.version})` : ''}.`;
    basis = {
      mode: 'submitted_package',
      label,
      submissionClass,
      packageId: sentPackage.id,
      packageVersion: sentPackage.version,
      manifestHash: sentPackage.manifestHash,
      documents: sentPackage.documents.map((doc) => ({ slot: doc.slot, provenance: doc.provenance, version: doc.version })),
    };
  } else {
    const cv = record.cvId ? (workspace.listCvDocuments(db).find((doc) => doc.id === record.cvId) ?? null) : null;
    const letter = record.letterId ? (workspace.listLetters(db).find((row) => row.id === record.letterId) ?? null) : null;
    documents = [
      ...(cv ? [{ slot: 'cv' as const, provenance: 'your current linked CV; it may differ from what was sent', version: null, name: cv.name }] : []),
      ...(letter ? [{ slot: 'letter' as const, provenance: 'your current linked letter; it may differ from what was sent', version: null, name: null }] : []),
    ];
    letterText = letter ? letter.body : null;
    label =
      view?.selection === 'choose'
        ? 'Several submitted packages exist and none is chosen, so this draft uses your current linked documents, which may differ from what you sent.'
        : 'No recorded submission package, so this draft uses your current linked documents, which may differ from what you sent.';
    basis = {
      mode: 'current_context',
      label,
      submissionClass,
      packageId: null,
      packageVersion: null,
      manifestHash: null,
      documents: documents.map((doc) => ({ slot: doc.slot, provenance: 'current', version: null })),
    };
  }

  const facts: FollowUpFacts = {
    role: record.role,
    company: record.company,
    location: record.location,
    status: record.status.replace('_', ' '),
    submissionClass,
    appliedOn: record.appliedAt ? record.appliedAt.slice(0, 10) : null,
    action: action ? { kind: action.kind, title: action.title, note: action.note, channel: action.channel, contactDetail: action.contactDetail } : null,
    kind: action?.kind ?? 'follow_up',
    basis: { mode: basis.mode, label, documents, letterText },
  };
  const hash = factsHash(facts, { actionVersion: action?.version ?? null, manifestHash: basis.manifestHash, packageId: basis.packageId });
  return { ok: true, value: { facts, prompt: buildFollowUpPrompt(facts), hash, basis, actionVersion: action?.version ?? null } };
}

/* ------------------------------------------------------------------------------ generate ----- */

export async function generateDraftRequest(deps: FollowUpDeps, input: GenerateDraftRequest): Promise<ActionsResult> {
  // A retry of a request that already produced a draft returns that draft: no second model call, no second record.
  const replay = getDraftByRequest(deps.db, input.applicationId, input.requestId);
  if (replay) return okResult(deps, input.applicationId, null, true, replay.id);

  const runId = randomUUID();
  const controller = new AbortController();
  // The slot is reserved before the first await: a second press while this one reads its inputs is refused,
  // and Cancel reaches this run's controller from now on.
  if (!reserveRun(input.applicationId, runId, controller)) {
    return failureResult(deps, input.applicationId, 'already_running', 'A draft for this application is already being written.');
  }
  try {
    return await run(deps, input, runId, controller);
  } finally {
    releaseRun(input.applicationId, runId);
  }
}

async function run(deps: FollowUpDeps, input: GenerateDraftRequest, runId: string, controller: AbortController): Promise<ActionsResult> {
  // The run stops being "running" BEFORE the view that reports its outcome is built, and only ever releases
  // its OWN slot (the outer "finally" is just a safety net).
  const release = (): void => releaseRun(input.applicationId, runId);
  const fail = (code: keyof typeof RUN_MESSAGE): ActionsResult => {
    release();
    return failureResult(deps, input.applicationId, code, RUN_MESSAGE[code]);
  };
  const before = ((): PrepareResult => {
    try {
      return prepare(deps.db, input.applicationId, input.actionId, deps.log);
    } catch (error) {
      if (error instanceof WorkspaceNotFoundError) return { ok: false, code: 'not_found', message: 'That application is no longer available.' };
      throw error;
    }
  })();
  if (!before.ok) {
    release();
    return failureResult(deps, input.applicationId, before.code, before.message);
  }
  if (controller.signal.aborted) return fail('cancelled');

  let result: GenerateResult;
  try {
    result = await deps.generate(before.value.prompt, controller.signal);
  } catch (error) {
    result = { ok: false, text: '', error: describe(error) };
  }

  try {
    if (controller.signal.aborted) return fail('cancelled');
    if (!result.ok) return fail(classifyFailure(result.error ?? ''));
    const parsed = parseFollowUpOutput(result.text);
    if (!parsed.ok) return fail('invalid_output');
    if (ungroundedTokens(`${parsed.subject}\n${parsed.body}`, before.value.prompt).length > 0) return fail('ungrounded');

    const usage: { inputTokens?: number; outputTokens?: number } = {};
    if (typeof result.usage?.inputTokens === 'number') usage.inputTokens = result.usage.inputTokens;
    if (typeof result.usage?.outputTokens === 'number') usage.outputTokens = result.usage.outputTokens;

    const committed = await deps.mutate(() =>
      deps.db.transaction((tx) => {
        if (controller.signal.aborted || !isRunLive(input.applicationId, runId)) return { ok: false as const, code: 'discarded' as const };
        // The late-result fence, INSIDE the write: the exact application row, sent class, planned step, recorded
        // package and linked documents are read again here, synchronously, against this transaction's own view of
        // the database, and compared with what the model was asked about. Nothing can change between this check
        // and the insert, so a draft is never saved against a basis it was not written from.
        let now: PrepareResult;
        try {
          now = prepare(tx as unknown as WorkspaceDb, input.applicationId, input.actionId, deps.log);
        } catch {
          return { ok: false as const, code: 'discarded' as const };
        }
        if (!now.ok || now.value.hash !== before.value.hash) return { ok: false as const, code: 'discarded' as const };
        return insertDraft(
          tx,
          {
            applicationId: input.applicationId,
            actionId: input.actionId,
            requestId: input.requestId,
            kind: before.value.facts.kind,
            basis: { ...before.value.basis, factsHash: before.value.hash },
            subject: parsed.subject,
            body: parsed.body,
            provider: deps.provider,
            usage: Object.keys(usage).length > 0 ? usage : null,
          },
          deps.now(),
        );
      }),
    );
    if (!committed.ok) {
      if (committed.code === 'limit') {
        release();
        return failureResult(deps, input.applicationId, 'limit', DRAFT_MESSAGE.limit);
      }
      return fail('discarded');
    }
    release();
    return okResult(deps, input.applicationId, null, committed.reused, committed.draft.id);
  } catch (error) {
    deps.log?.('the follow-up draft could not be completed', { applicationId: input.applicationId, error: describe(error) });
    return fail('failed');
  }
}

export function cancelDraftRequest(deps: FollowUpDeps, applicationId: string): ActionsResult {
  cancelFollowUp(applicationId);
  return okResult(deps, applicationId, null, false);
}

/* --------------------------------------------------------------------- review and reporting ----- */

type DraftOutcome = ReturnType<typeof editDraft>;

async function decide(deps: FollowUpDeps, applicationId: string, task: (tx: WorkspaceDb) => DraftOutcome): Promise<ActionsResult> {
  const result = await deps.mutate(() => deps.db.transaction((tx) => task(tx as unknown as WorkspaceDb)));
  if (!result.ok) return failureResult(deps, applicationId, result.code, DRAFT_MESSAGE[result.code]);
  return okResult(deps, applicationId, null, result.unchanged, result.draft.id);
}

export const editDraftRequest = (deps: FollowUpDeps, input: EditDraftRequest): Promise<ActionsResult> =>
  decide(deps, input.applicationId, (tx) => editDraft(tx, { ...input, subject: input.subject.trim() }, deps.now()));

export const approveDraftRequest = (deps: FollowUpDeps, input: DraftDecisionRequest): Promise<ActionsResult> =>
  decide(deps, input.applicationId, (tx) => approveDraft(tx, input, deps.now()));

export const discardDraftRequest = (deps: FollowUpDeps, input: DraftDecisionRequest): Promise<ActionsResult> =>
  decide(deps, input.applicationId, (tx) => discardDraft(tx, input, deps.now()));

/**
 * Records the person's own statement that they sent this message. It is never inferred from a draft being
 * prepared, approved, copied or opened, and it changes nothing else: not the follow-up, not the status.
 */
export async function reportDraftSentRequest(deps: FollowUpDeps, input: ReportSentRequest): Promise<ActionsResult> {
  let sentOn: string | null = null;
  if (input.sentOn !== null && input.sentOn !== '') {
    const day = parseCalendarDate(input.sentOn);
    // The latest "today" anywhere on earth is UTC+14, so a date beyond that cannot be a date already past.
    const latest = new Date(deps.now().getTime() + 14 * 3_600_000).toISOString().slice(0, 10);
    if (!day || input.sentOn > latest) {
      return failureResult(deps, input.applicationId, 'invalid_date', 'Use a real date that is not in the future, or leave it empty.');
    }
    sentOn = input.sentOn;
  }
  return decide(deps, input.applicationId, (tx) => reportSent(tx, { ...input, sentOn }, deps.now()));
}
