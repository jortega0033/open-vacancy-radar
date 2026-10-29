import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { classifyProviderError } from '../src/provider-error.js';
import {
  buildCritiqueInputs,
  buildCritiquePrompt,
  changedInputs,
  checkLetterRevision,
  checkResumeRevision,
  DRAFT_KINDS,
  DRAFT_LABEL,
  draftArtifactFileName,
  draftArtifactKind,
  FINDING_LABEL,
  INPUT_LABEL,
  letterRevisionKind,
  parseCritiqueResponse,
  REFUSAL_LABEL,
  sourceCvPlainText,
  stableStringify,
  verifyFindings,
  type CritiqueDraft,
  type CritiqueInputs,
  type DraftKind,
  type DraftOrigin,
  type InputKey,
  type RefusedFinding,
  type StoredFinding,
  type StoredProposal,
} from './application-critique.js';
import {
  DocumentAcceptanceError,
  printHtmlToPdf,
  stageLetterArtifact,
  stageTailoredResumeArtifact,
  StagingAbandonedError,
} from './application-artifact-staging.js';
import { closeApplicationReview } from './application-review-session.js';
import type { CompanyEvidenceProseFact } from './company-evidence.js';
import { acceptRenderedDocument } from './document-acceptance.js';
import { letterAcceptanceContract, resumeAcceptanceContract } from './document-contracts.js';
import { renderLetterHtml } from './letter-html.js';
import { renderResumeHtml } from './resume-html.js';
import type { TailoredResume } from './resume-schema.js';
import { renderResumePlainText } from './resume-text.js';
import { recordEvidenceUses } from './workspace/company-evidence-store.js';
import {
  critiqueTx,
  currentDrafts,
  getCritique,
  saveProposals,
  saveReview,
  saveRunOutcome,
  type CritiqueRecord,
  type DraftRecord,
  type LastRunOutcome,
} from './workspace/application-critique-store.js';
import { syncApplicationForAttempt } from './workspace/attempt-application-sync.js';
import type { WorkspaceDb } from './workspace/client.js';
import { getPendingPostingFinding, isHistoricalAttempt } from './workspace/posting-verification-store.js';
import * as workspace from './workspace/repository.js';
import { applicationAttempts, applicationCritiques as workspaceCritiqueTable } from './workspace/schema.js';
import type { ApplicationAttemptRecord, CvDocumentRecord } from './workspace/types.js';

/**
 * The service behind "Review this application" (#690). It owns the whole life of one critique:
 *
 *  - **view** (`getCritiqueView`): local reads only. Opening the panel, re-opening it, or looking at
 *    an old review never starts a session; staleness is recomputed from the stored fence.
 *  - **run** (`runCritique`): the explicit action. Exactly one model call in a fresh session, no retry.
 *    The result is committed only if the inputs it was made against are still the current ones.
 *  - **reject / accept** a proposed revision. Accepting re-validates, renders and accepts the document
 *    through the existing staging path, appends a NEW draft version, and invalidates only the
 *    confirmations that described the old document.
 *
 * What it never does: change profile facts, the brief, company evidence, a posting, a submission
 * state or a submitted attempt; start research; or start a second session on its own.
 */

export interface CritiqueGenerateResult {
  ok: boolean;
  text: string;
  error?: string;
  usage?: { inputTokens?: number; outputTokens?: number };
}

export interface CritiqueDeps {
  db: WorkspaceDb;
  storageRoot: string;
  now(): Date;
  /** ONE fresh closed-tool, no-network session. The only step that can reach a model. */
  generate(prompt: string, signal: AbortSignal): Promise<CritiqueGenerateResult>;
  /** Only what the support policy already approved for a letter. Local reads; never researches. */
  loadCompanyEvidence(attempt: ApplicationAttemptRecord): CompanyEvidenceProseFact[] | Promise<CompanyEvidenceProseFact[]>;
  provider: string;
  log?(message: string, meta?: Record<string, unknown>): void;
}

/* ----------------------------------------------------------------------------- view types ----- */

export type UnavailableCode =
  | 'sent'
  | 'not_prepared'
  | 'held'
  | 'source_cv_missing'
  | 'no_reviewed_source'
  | 'no_job_description'
  | 'package_not_recorded';

export interface CritiqueDocumentView {
  kind: DraftKind;
  label: string;
  version: number;
  origin: DraftOrigin;
  authored: 'generated' | 'user' | null;
}

export interface FindingView extends StoredFinding {
  label: string;
  current: boolean;
  outdatedBecause: string[];
}

export interface RefusedView extends RefusedFinding {
  reason: string;
}

export interface ProposalView {
  document: DraftKind;
  label: string;
  status: StoredProposal['status'];
  reasons: string[];
  changes: string[];
  /** The revised text the person is deciding on (null for a refused proposal). */
  preview: string | null;
  baseVersion: number;
  baseContentHash: string;
  current: boolean;
  outdatedBecause: string[];
  acceptable: boolean;
  acceptedVersion: number | null;
}

export interface ReviewView {
  runId: string;
  reviewedAt: string;
  provider: string;
  model: string | null;
  calls: number;
  tokens: { inputTokens?: number; outputTokens?: number } | null;
  state: 'current' | 'partly_outdated' | 'outdated';
  outdatedBecause: string[];
  noFindings: boolean;
  findings: FindingView[];
  refused: RefusedView[];
  proposals: ProposalView[];
}

export interface CritiqueView {
  attemptId: string;
  canReview: boolean;
  unavailable: { code: UnavailableCode; message: string } | null;
  running: boolean;
  documents: CritiqueDocumentView[];
  review: ReviewView | null;
  lastRun: { outcome: LastRunOutcome; detail: string; at: string } | null;
}

export type CritiqueActionCode =
  | 'not_available'
  | 'already_running'
  | 'failed'
  | 'cancelled'
  | 'timed_out'
  | 'provider_limit'
  | 'invalid_output'
  | 'discarded'
  | 'outdated'
  | 'not_found'
  | 'not_accepted'
  | 'busy';

export type CritiqueActionResult =
  | { ok: true; view: CritiqueView }
  | { ok: false; code: CritiqueActionCode; message: string; view: CritiqueView | null };

const UNAVAILABLE_MESSAGE: Record<UnavailableCode, string> = {
  sent: 'This application was already sent. Its documents stay exactly as they were and cannot be reviewed or changed.',
  not_prepared: 'A review is available once the application is prepared and waiting for you.',
  held: 'The posting changed or closed and this package is on hold. Decide about the posting first.',
  source_cv_missing: 'The CV this application was built from is no longer in your library.',
  no_reviewed_source: 'This CV has no reviewed source record, so there is nothing to check the documents against.',
  no_job_description: 'This application has no job description to review against.',
  package_not_recorded: 'This package was prepared before drafts were kept, so it cannot be reviewed. Prepare it again to review it.',
};

const RUN_MESSAGE: Record<Exclude<CritiqueActionCode, 'not_available' | 'outdated' | 'not_found' | 'not_accepted' | 'busy' | 'already_running'>, string> = {
  failed: 'The review did not finish. Your documents were not changed.',
  cancelled: 'The review was cancelled. Your documents were not changed.',
  timed_out: 'The reviewer did not answer in time. Your documents were not changed.',
  provider_limit: 'The reviewer hit a usage limit. Your documents were not changed. Try again after it resets.',
  invalid_output: 'The reviewer answered in a form this app could not use, so nothing was kept. Your documents were not changed.',
  discarded: 'Your documents or the job changed while the review ran, so its result was discarded. Review again to get a current one.',
};

/** One in-flight run per attempt; and one accept per attempt. Process-local, like the preparation fence. */
const runs = new Map<string, { runId: string; controller: AbortController }>();
const accepting = new Set<string>();

export function isCritiqueRunning(attemptId: string): boolean {
  return runs.has(attemptId);
}

/** Aborts a running review (and a data reset aborts every one). True when something was running. */
export function cancelCritique(attemptId: string): boolean {
  const run = runs.get(attemptId);
  if (!run) return false;
  run.controller.abort();
  return true;
}

export function cancelAllCritiques(): void {
  for (const run of runs.values()) run.controller.abort();
}

/* ----------------------------------------------------------------------------- state ----- */

interface State {
  attempt: ApplicationAttemptRecord;
  cv: CvDocumentRecord | null;
  drafts: CritiqueDraft[];
  inputs: CritiqueInputs | null;
  unavailable: { code: UnavailableCode; message: string } | null;
}

function unavailable(code: UnavailableCode): { code: UnavailableCode; message: string } {
  return { code, message: UNAVAILABLE_MESSAGE[code] };
}

function toCritiqueDraft(record: DraftRecord): CritiqueDraft {
  return {
    kind: record.kind,
    version: record.version,
    origin: record.origin,
    content: record.content,
    contentHash: record.contentHash,
    artifactHash: record.artifactHash,
    text: record.content.type === 'cv' ? renderPlain(record.content.resume) : record.content.body,
  };
}

function renderPlain(resume: TailoredResume): string {
  return renderResumePlainText(resume);
}

/** A draft counts only while the artifact it produced is still the attempt's current document. */
function packageDrafts(db: WorkspaceDb, attemptId: string): CritiqueDraft[] {
  const artifacts = workspace.listApplicationArtifacts(db, attemptId);
  return currentDrafts(db, attemptId)
    .filter((draft) =>
      artifacts.some(
        (artifact) =>
          artifact.kind === draftArtifactKind(draft.kind) &&
          artifact.fileName === draftArtifactFileName(draft.kind) &&
          artifact.contentHash === draft.artifactHash,
      ),
    )
    .map(toCritiqueDraft);
}

async function loadState(deps: CritiqueDeps, attemptId: string): Promise<State> {
  const attempt = workspace.getApplicationAttempt(deps.db, attemptId);
  const cv = attempt.sourceCvId ? (workspace.listCvDocuments(deps.db).find((doc) => doc.id === attempt.sourceCvId) ?? null) : null;
  const drafts = packageDrafts(deps.db, attemptId);
  const base = { attempt, cv, drafts };

  if (isHistoricalAttempt(attempt)) return { ...base, inputs: null, unavailable: unavailable('sent') };
  if (attempt.checkpoint !== 'ready' && attempt.checkpoint !== 'needs_user') return { ...base, inputs: null, unavailable: unavailable('not_prepared') };
  if (getPendingPostingFinding(deps.db, attemptId)?.held) return { ...base, inputs: null, unavailable: unavailable('held') };
  if (!cv) return { ...base, inputs: null, unavailable: unavailable('source_cv_missing') };
  if (!cv.source) return { ...base, inputs: null, unavailable: unavailable('no_reviewed_source') };
  if (attempt.jdSnapshot.trim().length === 0) return { ...base, inputs: null, unavailable: unavailable('no_job_description') };
  if (!drafts.some((draft) => draft.kind === 'cv')) return { ...base, inputs: null, unavailable: unavailable('package_not_recorded') };

  let companyEvidence: CompanyEvidenceProseFact[] = [];
  try {
    companyEvidence = [...(await deps.loadCompanyEvidence(attempt))];
  } catch (error) {
    // Company facts are optional input: a store problem means the critic gets none, never a guess.
    deps.log?.('company facts unavailable for the review; continuing without them', { error: describe(error) });
  }
  return { ...base, inputs: buildCritiqueInputs({ attempt, cv, drafts, companyEvidence }), unavailable: null };
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function documentViews(drafts: readonly CritiqueDraft[]): CritiqueDocumentView[] {
  return drafts.map((draft) => ({
    kind: draft.kind,
    label: DRAFT_LABEL[draft.kind],
    version: draft.version,
    origin: draft.origin,
    authored: draft.content.type === 'letter' ? draft.content.authored : null,
  }));
}

function outdatedLabels(keys: Iterable<InputKey>): string[] {
  return [...keys].map((key) => INPUT_LABEL[key] ?? key);
}

function proposalPreview(proposal: StoredProposal): string | null {
  if (!proposal.proposed) return null;
  return proposal.proposed.type === 'cv' ? renderPlain(proposal.proposed.resume) : proposal.proposed.body;
}

function buildReviewView(record: CritiqueRecord, state: State): ReviewView | null {
  if (!record.reviewedAt || !record.fence) return null;
  const changed = state.inputs
    ? changedInputs(record.fence, state.inputs.fence)
    : new Set<InputKey>(['jd', 'cvSource', 'company', ...DRAFT_KINDS.map((kind) => `draft:${kind}` as const)]);
  const findings: FindingView[] = record.findings.map((finding) => {
    const hit = finding.dependsOn.filter((key) => changed.has(key));
    return { ...finding, label: FINDING_LABEL[finding.kind], current: hit.length === 0, outdatedBecause: outdatedLabels(hit) };
  });
  const proposals: ProposalView[] = record.proposals.map((proposal) => {
    const hit = proposal.dependsOn.filter((key) => changed.has(key));
    const current = hit.length === 0;
    return {
      document: proposal.document,
      label: DRAFT_LABEL[proposal.document],
      status: proposal.status,
      reasons: proposal.reasons,
      changes: proposal.changes,
      preview: proposalPreview(proposal),
      baseVersion: proposal.base.version,
      baseContentHash: proposal.base.contentHash,
      current,
      outdatedBecause: outdatedLabels(hit),
      acceptable: proposal.status === 'pending' && current && state.unavailable === null,
      acceptedVersion: proposal.acceptedVersion,
    };
  });
  const anyOutdated = findings.some((finding) => !finding.current) || proposals.some((p) => !p.current);
  const allOutdated = changed.size > 0 && findings.every((finding) => !finding.current) && proposals.every((p) => !p.current);
  return {
    runId: record.runId,
    reviewedAt: record.reviewedAt,
    provider: record.provider,
    model: record.model,
    calls: record.callCount,
    tokens: record.usage,
    state: changed.size === 0 ? 'current' : allOutdated && (findings.length > 0 || proposals.length > 0) ? 'outdated' : anyOutdated ? 'partly_outdated' : 'current',
    outdatedBecause: outdatedLabels(changed),
    noFindings: record.findings.length === 0 && record.refused.length === 0,
    findings,
    refused: record.refused.map((entry) => ({ ...entry, reason: REFUSAL_LABEL[entry.code] })),
    proposals,
  };
}

/** The panel's one read. Never starts a session, a render or a request. */
export async function getCritiqueView(deps: CritiqueDeps, attemptId: string): Promise<CritiqueView> {
  const state = await loadState(deps, attemptId);
  const record = getCritique(deps.db, attemptId);
  return {
    attemptId,
    canReview: state.unavailable === null && !runs.has(attemptId),
    unavailable: state.unavailable,
    running: runs.has(attemptId),
    documents: documentViews(state.drafts),
    review: record ? buildReviewView(record, state) : null,
    lastRun:
      record?.lastRunOutcome && record.lastRunAt
        ? { outcome: record.lastRunOutcome, detail: record.lastRunDetail, at: record.lastRunAt }
        : null,
  };
}

async function failure(deps: CritiqueDeps, attemptId: string, code: CritiqueActionCode, message: string): Promise<CritiqueActionResult> {
  try {
    return { ok: false, code, message, view: await getCritiqueView(deps, attemptId) };
  } catch {
    return { ok: false, code, message, view: null };
  }
}

/* ------------------------------------------------------------------------------ run ----- */

function usageOf(result: CritiqueGenerateResult): { inputTokens?: number; outputTokens?: number } | null {
  const usage = result.usage;
  if (!usage) return null;
  const out: { inputTokens?: number; outputTokens?: number } = {};
  if (typeof usage.inputTokens === 'number') out.inputTokens = usage.inputTokens;
  if (typeof usage.outputTokens === 'number') out.outputTokens = usage.outputTokens;
  return Object.keys(out).length > 0 ? out : null;
}

function classifyFailure(error: string): Exclude<LastRunOutcome, 'reviewed' | 'discarded' | 'invalid_output'> {
  if (/\bwas cancelled\b|\bcancelled\b/iu.test(error)) return 'cancelled';
  if (/no response after \d+s/iu.test(error)) return 'timed_out';
  if (classifyProviderError(error).kind === 'usage_limit') return 'provider_limit';
  return 'failed';
}

function recordOutcome(deps: CritiqueDeps, attemptId: string, runId: string, outcome: Exclude<LastRunOutcome, 'reviewed'>, detail: string): void {
  try {
    saveRunOutcome(deps.db, { attemptId, runId, outcome, detail, provider: deps.provider, now: deps.now() });
  } catch (error) {
    deps.log?.('could not record how the review ended', { attemptId, error: describe(error) });
  }
}

/** Renders the revised document and runs the SAME document acceptance contract staging uses. */
async function dryRunAcceptance(input: {
  draft: CritiqueDraft;
  proposed: { resume: TailoredResume } | { body: string };
  cv: CvDocumentRecord;
  attempt: ApplicationAttemptRecord;
}): Promise<string[]> {
  const target = { company: input.attempt.company, role: input.attempt.role };
  try {
    const contract =
      'resume' in input.proposed
        ? resumeAcceptanceContract(input.proposed.resume, { target, verifiedEmployers: (input.cv.source?.experience ?? []).map((entry) => entry.company) })
        : letterAcceptanceContract({
            kind: input.draft.kind as 'cover_letter' | 'motivation_letter',
            title: input.draft.content.type === 'letter' ? input.draft.content.title : 'Cover Letter',
            body: input.proposed.body,
            candidateName: input.cv.source?.contact.name ?? '',
            target,
          });
    const html =
      'resume' in input.proposed
        ? renderResumeHtml(input.proposed.resume)
        : renderLetterHtml(input.draft.content.type === 'letter' ? input.draft.content.title : 'Cover Letter', input.proposed.body, {
            candidateName: input.cv.source?.contact.name ?? '',
          });
    const pdf = await printHtmlToPdf(html);
    const acceptance = await acceptRenderedDocument(Uint8Array.from(pdf), contract);
    return acceptance.ok ? [] : acceptance.findings.map((finding) => finding.detail);
  } catch (error) {
    return [describe(error)];
  }
}

async function buildProposals(
  deps: CritiqueDeps,
  inputs: CritiqueInputs,
  accepted: readonly StoredFinding[],
  revisions: { cv: unknown; letter: unknown },
  refused: RefusedFinding[],
): Promise<StoredProposal[]> {
  const proposals: StoredProposal[] = [];
  const concerning = (kind: DraftKind): boolean => accepted.some((finding) => finding.documents.includes(kind));
  const refuseRevision = (detail: string): void => {
    refused.push({ kind: 'revision', summary: 'Proposed revision', code: 'insufficient_evidence', detail });
  };

  if (revisions.cv !== null) {
    const draft = inputs.drafts.find((d) => d.kind === 'cv');
    if (!draft || draft.content.type !== 'cv') refuseRevision('There is no CV in this package to revise.');
    else if (!concerning('cv')) refuseRevision('A CV revision was proposed but no accepted finding concerns the CV, so it was not offered.');
    else {
      const check = checkResumeRevision({ raw: revisions.cv, current: draft.content.resume, attempt: inputs.attempt, cv: inputs.cv });
      const base = { version: draft.version, contentHash: draft.contentHash };
      const dependsOn: InputKey[] = ['draft:cv', 'cvSource', 'jd'];
      if (check.ok) {
        const dry = await dryRunAcceptance({ draft, proposed: { resume: check.value }, cv: inputs.cv, attempt: inputs.attempt });
        proposals.push({
          document: 'cv',
          status: dry.length === 0 ? 'pending' : 'refused',
          reasons: dry.map((reason) => `The revised CV did not pass the document checks: ${reason}`),
          changes: check.changes,
          base,
          proposed: dry.length === 0 ? { type: 'cv', resume: check.value } : null,
          dependsOn,
          decidedAt: null,
          acceptedVersion: null,
        });
      } else if (!check.noChange) {
        proposals.push({ document: 'cv', status: 'refused', reasons: check.reasons, changes: [], base, proposed: null, dependsOn, decidedAt: null, acceptedVersion: null });
      }
    }
  }

  if (revisions.letter !== null) {
    const kind = letterRevisionKind(revisions.letter);
    const draft = kind ? inputs.drafts.find((d) => d.kind === kind) : undefined;
    if (!kind || !draft) refuseRevision('The letter revision did not name a letter in this package.');
    else if (!concerning(kind)) refuseRevision(`A ${DRAFT_LABEL[kind]} revision was proposed but no accepted finding concerns it, so it was not offered.`);
    else {
      const check = await checkLetterRevision({ raw: revisions.letter, current: draft, inputs, now: deps.now });
      const base = { version: draft.version, contentHash: draft.contentHash };
      const dependsOn: InputKey[] = [`draft:${kind}`, 'cvSource', 'jd', 'company'];
      if (check.ok) {
        const dry = await dryRunAcceptance({ draft, proposed: { body: check.value.body }, cv: inputs.cv, attempt: inputs.attempt });
        proposals.push({
          document: kind,
          status: dry.length === 0 ? 'pending' : 'refused',
          reasons: dry.map((reason) => `The revised letter did not pass the document checks: ${reason}`),
          changes: check.changes,
          base,
          proposed: dry.length === 0 ? { type: 'letter', ...check.value } : null,
          dependsOn,
          decidedAt: null,
          acceptedVersion: null,
        });
      } else if (!check.noChange) {
        proposals.push({ document: kind, status: 'refused', reasons: check.reasons, changes: [], base, proposed: null, dependsOn, decidedAt: null, acceptedVersion: null });
      }
    }
  }
  return proposals;
}

/**
 * The explicit "Review this application". One call, no retry, no loop. A failed, cancelled, timed-out
 * or rate-limited run records WHY and changes nothing else; a result whose inputs moved while it ran
 * is discarded.
 */
export async function runCritique(deps: CritiqueDeps, attemptId: string): Promise<CritiqueActionResult> {
  if (runs.has(attemptId)) return failure(deps, attemptId, 'already_running', 'A review of this application is already running.');
  let state: State;
  try {
    state = await loadState(deps, attemptId);
  } catch {
    return { ok: false, code: 'not_found', message: 'That application is no longer available.', view: null };
  }
  if (state.unavailable || !state.inputs) {
    return failure(deps, attemptId, 'not_available', state.unavailable?.message ?? 'This application cannot be reviewed right now.');
  }
  const inputs = state.inputs;
  const runId = randomUUID();
  const controller = new AbortController();
  runs.set(attemptId, { runId, controller });

  let result: CritiqueGenerateResult;
  try {
    result = await deps.generate(buildCritiquePrompt(inputs), controller.signal);
  } catch (error) {
    result = { ok: false, text: '', error: describe(error) };
  }

  try {
    if (controller.signal.aborted) {
      recordOutcome(deps, attemptId, runId, 'cancelled', RUN_MESSAGE.cancelled);
      return await failure(deps, attemptId, 'cancelled', RUN_MESSAGE.cancelled);
    }
    if (!result.ok) {
      const outcome = classifyFailure(result.error ?? '');
      recordOutcome(deps, attemptId, runId, outcome, RUN_MESSAGE[outcome]);
      return await failure(deps, attemptId, outcome, RUN_MESSAGE[outcome]);
    }
    const parsed = parseCritiqueResponse(result.text);
    if (!parsed.ok) {
      recordOutcome(deps, attemptId, runId, 'invalid_output', RUN_MESSAGE.invalid_output);
      return await failure(deps, attemptId, 'invalid_output', RUN_MESSAGE.invalid_output);
    }

    const { accepted, refused } = verifyFindings(parsed.findings, {
      jdShown: inputs.jdShown,
      drafts: inputs.drafts,
      sourceFacts: inputs.sourceFacts,
      companyFacts: inputs.companyFacts,
      sourceCvText: sourceCvPlainText(inputs.cv),
    });
    const proposals =
      accepted.length > 0
        ? await buildProposals(deps, inputs, accepted, parsed.revisions, refused)
        : (() => {
            if (parsed.revisions.cv !== null || parsed.revisions.letter !== null) {
              refused.push({
                kind: 'revision',
                summary: 'Proposed revision',
                code: 'insufficient_evidence',
                detail: 'A revision was proposed without any accepted finding, so it was not offered.',
              });
            }
            return [] as StoredProposal[];
          })();

    // The late-result fence: whatever moved while the session ran, this result does not describe it.
    let after: State | null = null;
    try {
      after = await loadState(deps, attemptId);
    } catch {
      after = null;
    }
    const live = runs.get(attemptId);
    if (
      controller.signal.aborted ||
      !live ||
      live.runId !== runId ||
      !after?.inputs ||
      changedInputs(inputs.fence, after.inputs.fence).size > 0
    ) {
      if (after) recordOutcome(deps, attemptId, runId, 'discarded', RUN_MESSAGE.discarded);
      return await failure(deps, attemptId, 'discarded', RUN_MESSAGE.discarded);
    }

    const saved = saveReview(deps.db, {
      attemptId,
      runId,
      fence: inputs.fence,
      findings: accepted,
      refused,
      proposals,
      provider: deps.provider,
      model: null,
      usage: usageOf(result),
      now: deps.now(),
    });
    if (!saved) return await failure(deps, attemptId, 'not_available', UNAVAILABLE_MESSAGE.sent);
    return { ok: true, view: await getCritiqueView(deps, attemptId) };
  } catch (error) {
    deps.log?.('the review could not be completed', { attemptId, error: describe(error) });
    return await failure(deps, attemptId, 'failed', RUN_MESSAGE.failed);
  } finally {
    if (runs.get(attemptId)?.runId === runId) runs.delete(attemptId);
  }
}

/* ------------------------------------------------------------------- reject / accept ----- */

export interface ProposalTarget {
  attemptId: string;
  runId: string;
  document: DraftKind;
  baseContentHash: string;
}

function findPending(record: CritiqueRecord | null, target: ProposalTarget): StoredProposal | null {
  if (!record || record.runId !== target.runId) return null;
  return (
    record.proposals.find(
      (proposal) => proposal.document === target.document && proposal.base.contentHash === target.baseContentHash && proposal.status === 'pending',
    ) ?? null
  );
}

export async function rejectProposal(deps: CritiqueDeps, target: ProposalTarget): Promise<CritiqueActionResult> {
  const record = getCritique(deps.db, target.attemptId);
  const proposal = findPending(record, target);
  if (!record || !proposal) return failure(deps, target.attemptId, 'outdated', 'That suggestion is no longer current.');
  const next = record.proposals.map((entry) =>
    entry === proposal || stableStringify(entry) === stableStringify(proposal)
      ? { ...entry, status: 'rejected' as const, decidedAt: deps.now().toISOString() }
      : entry,
  );
  if (!saveProposals(deps.db, target.attemptId, next, deps.now())) {
    return failure(deps, target.attemptId, 'not_available', UNAVAILABLE_MESSAGE.sent);
  }
  return { ok: true, view: await getCritiqueView(deps, target.attemptId) };
}

/**
 * Accepting is the only way a revision reaches a document. Everything is re-checked first, the
 * existing staging path renders and accepts the new file (a failure there leaves every current
 * document untouched), and only then does the new draft version replace the old one.
 */
export async function acceptProposal(deps: CritiqueDeps, target: ProposalTarget): Promise<CritiqueActionResult> {
  const { attemptId } = target;
  if (accepting.has(attemptId) || runs.has(attemptId)) return failure(deps, attemptId, 'busy', 'Wait for the current action on this application to finish.');
  accepting.add(attemptId);
  try {
    let state: State;
    try {
      state = await loadState(deps, attemptId);
    } catch {
      return { ok: false, code: 'not_found', message: 'That application is no longer available.', view: null };
    }
    if (state.unavailable || !state.inputs || !state.cv?.source) {
      return failure(deps, attemptId, 'not_available', state.unavailable?.message ?? 'This application cannot be changed right now.');
    }
    const record = getCritique(deps.db, attemptId);
    const proposal = findPending(record, target);
    if (!record?.fence || !proposal || !proposal.proposed) return failure(deps, attemptId, 'outdated', 'That suggestion is no longer current.');
    const stale = (s: State): boolean =>
      !s.inputs || proposal.dependsOn.some((key) => changedInputs(record.fence!, s.inputs!.fence).has(key));
    if (stale(state)) return failure(deps, attemptId, 'outdated', 'The documents or the job changed after this review, so the suggestion no longer applies. Review again.');

    const inputs = state.inputs;
    const draft = inputs.drafts.find((d) => d.kind === target.document);
    if (!draft) return failure(deps, attemptId, 'outdated', 'That document is no longer in the package.');

    // Re-validate the stored proposal from scratch, exactly as when it was offered.
    const proposed = proposal.proposed;
    if (proposed.type === 'cv') {
      if (draft.content.type !== 'cv') return failure(deps, attemptId, 'outdated', 'That document changed.');
      const check = checkResumeRevision({ raw: proposed.resume, current: draft.content.resume, attempt: inputs.attempt, cv: inputs.cv });
      if (!check.ok || stableStringify(check.value) !== stableStringify(proposed.resume)) {
        return failure(deps, attemptId, 'not_accepted', 'The revised CV no longer passes the checks against your reviewed CV, so it was not applied.');
      }
    } else {
      const check = await checkLetterRevision({
        raw: { kind: target.document, factIds: proposed.factIds },
        current: draft,
        inputs,
        now: deps.now,
      });
      if (!check.ok || check.value.body !== proposed.body) {
        return failure(deps, attemptId, 'not_accepted', 'The revised letter no longer passes the checks, so it was not applied.');
      }
    }

    const stillLive = (): boolean => {
      try {
        const attempt = workspace.getApplicationAttempt(deps.db, attemptId);
        if (isHistoricalAttempt(attempt) || (attempt.checkpoint !== 'ready' && attempt.checkpoint !== 'needs_user')) return false;
        if (getPendingPostingFinding(deps.db, attemptId)?.held) return false;
        const current = getCritique(deps.db, attemptId);
        if (!current || current.runId !== target.runId || !findPending(current, target)) return false;
        const drafts = packageDrafts(deps.db, attemptId);
        const now = drafts.find((d) => d.kind === target.document);
        return now?.contentHash === draft.contentHash && now.artifactHash === draft.artifactHash && attempt.jdSnapshotHash === inputs.attempt.jdSnapshotHash;
      } catch {
        return false;
      }
    };

    const t = { company: inputs.attempt.company, role: inputs.attempt.role };
    let artifactHash: string;
    try {
      const staged =
        proposed.type === 'cv'
          ? await stageTailoredResumeArtifact({
              db: deps.db,
              attemptId,
              resume: proposed.resume,
              storageRoot: deps.storageRoot,
              target: t,
              verifiedEmployers: state.cv.source.experience.map((entry) => entry.company),
              stillLive,
            })
          : await stageLetterArtifact({
              db: deps.db,
              attemptId,
              kind: target.document as 'cover_letter' | 'motivation_letter',
              title: draft.content.type === 'letter' ? draft.content.title : 'Cover Letter',
              body: proposed.body,
              candidateName: state.cv.source.contact.name,
              target: t,
              storageRoot: deps.storageRoot,
              stillLive,
            });
      artifactHash = staged.contentHash;
    } catch (error) {
      if (error instanceof StagingAbandonedError) {
        return failure(deps, attemptId, 'outdated', 'The application changed while the revision was being prepared, so nothing was applied.');
      }
      if (error instanceof DocumentAcceptanceError) {
        return failure(deps, attemptId, 'not_accepted', `The revised ${DRAFT_LABEL[target.document]} did not pass the document checks, so nothing was changed.`);
      }
      deps.log?.('a revision could not be applied', { attemptId, error: describe(error) });
      return failure(deps, attemptId, 'failed', 'The revision could not be applied. Your documents were not changed.');
    }

    // One synchronous step: the new version, the decision, and the confirmations it invalidates.
    const now = deps.now();
    let wasReady = false;
    deps.db.transaction((tx) => {
      const attempt = critiqueTx.writableAttempt(tx, attemptId);
      if (!attempt) throw new Error('attempt is no longer writable');
      const content =
        proposed.type === 'cv'
          ? ({ type: 'cv', resume: proposed.resume, basis: 'revision' } as const)
          : ({
              type: 'letter',
              title: draft.content.type === 'letter' ? draft.content.title : 'Cover Letter',
              body: proposed.body,
              authored: 'generated',
              factIds: proposed.factIds,
              companyClaims: proposed.companyClaims,
            } as const);
      const row = critiqueTx.appendDraft(tx, {
        attemptId,
        kind: target.document,
        origin: 'critique_revision',
        content,
        artifactHash,
        jdHash: inputs.fence.jdHash,
        sourceCvHash: inputs.fence.sourceCvHash,
        critiqueRunId: target.runId,
        now,
      });
      const proposals = record.proposals.map((entry) =>
        entry.document === target.document && entry.base.contentHash === target.baseContentHash && entry.status === 'pending'
          ? { ...entry, status: 'accepted' as const, decidedAt: now.toISOString(), acceptedVersion: row.version }
          : entry,
      );
      saveProposalsTx(tx, attemptId, proposals, now);

      // Only what described the OLD document: a scheduled automatic send, and a form that already
      // holds the old file. Everything else (other attempts, receipts, the brief, company facts) stays.
      wasReady = attempt.checkpoint === 'ready';
      const note = `Revised ${DRAFT_LABEL[target.document]} accepted from your review (version ${row.version}).`;
      tx.update(applicationAttempts)
        .set({
          scheduledAutomaticSubmitAt: null,
          ...(wasReady
            ? {
                checkpoint: 'needs_user' as const,
                checkpointDetail: `${note} The application form still held the earlier file, so it was closed. Prepare the application again to attach the revised documents.`,
                preparedFields: null,
              }
            : { checkpointDetail: `${attempt.checkpointDetail} ${note}`.trim().slice(0, 2000) }),
          updatedAt: now,
        })
        .where(eq(applicationAttempts.id, attemptId))
        .run();
      syncApplicationForAttempt(tx as WorkspaceDb, attemptId);
      if (target.document === 'cover_letter' && proposed.type === 'letter') {
        const used = inputs.companyEvidence.filter((fact) => proposed.companyClaims.includes(fact.claim));
        recordEvidenceUses(tx as WorkspaceDb, attemptId, used, now);
      }
    });
    if (wasReady) {
      await closeApplicationReview(attemptId).catch((error: unknown) => {
        deps.log?.('could not close the earlier review after a revision', { attemptId, error: describe(error) });
      });
    }
    return { ok: true, view: await getCritiqueView(deps, attemptId) };
  } finally {
    accepting.delete(attemptId);
  }
}

function saveProposalsTx(tx: Parameters<Parameters<WorkspaceDb['transaction']>[0]>[0], attemptId: string, proposals: StoredProposal[], now: Date): void {
  // Same write as `saveProposals`, inside the caller's transaction.
  tx.update(workspaceCritiqueTable).set({ proposals, updatedAt: now }).where(eq(workspaceCritiqueTable.attemptId, attemptId)).run();
}
