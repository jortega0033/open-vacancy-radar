import { createHash } from 'node:crypto';
import { parseFieldMap, type FormSnapshot } from '@agent-dock/application-executor';
import { stageApplicationDocuments } from './application-artifact-staging.js';
import {
  applyApplicationFieldMap,
  closeApplicationReview,
  openApplicationReview,
} from './application-review-session.js';
import { resolvePolicyIdForCanonicalUrl } from './application-target-policies.js';
import type { StartApplicationAttemptRefusal, StartApplicationAttemptResult } from './application-pipeline-types.js';
import {
  buildApplicationValueTable,
  buildFieldMapGenerationPrompt,
  sanitiseGeneratedFieldMap,
  summarisePreparedFields,
  type ApplicationValueCvContact,
  type ApplicationValueProfile,
  type ApplicationValueTableEntry,
} from './application-value-table.js';
import { cvDocumentToTailoredResume } from './cv-export.js';
import * as workspace from './workspace/repository.js';
import { ApplicationAttemptDuplicateError } from './workspace/repository.js';
import type { WorkspaceDb } from './workspace/client.js';
import type {
  ApplicationAttemptCheckpoint,
  ApplicationAttemptRecord,
  CvDocumentRecord,
} from './workspace/types.js';

/**
 * The production path from "this vacancy, please" to "ready for you to review" (issue #272, R02a).
 *
 * Before this module the pieces all existed and nothing joined them: #198's attempt table, #199's
 * staging, #200's daemon queue, #201's executor and generation runner, #202's review UI. There was
 * no caller that carried one vacancy through them, which is why
 * `application-generation-runner.ts`'s `runFieldMapGeneration` had no production caller and why
 * `ApplicationReviewSwipeCard` documented a screenshot it could not promise anything about.
 *
 * Ownership boundaries this module is careful not to blur:
 *
 *  - **The daemon owns the queue.** Scheduling ("may I work on an attempt right now?") is a lease
 *    acquired from the daemon's durable store over `ApplicationQueuePort`; this process never keeps
 *    its own idea of what is next, and never writes queue state. Pause, resume, skip and cancel are
 *    the daemon's transitions, and this module re-reads the entry's state between stages rather
 *    than assuming the lease it holds is still good.
 *  - **Electron main owns the browser.** Every page interaction goes through
 *    `application-review-session.ts`, which owns the isolated `WebContentsView` and the CDP
 *    transport. The renderer is never in this path, and neither is the daemon.
 *  - **Nothing is fabricated.** Documents are rendered from the reviewed source CV (#274) and from
 *    letters the user themselves wrote; form values come from the closed value table in
 *    `application-value-table.ts`. A detail this app does not have produces a visible "you answer
 *    this" row, never a guess.
 *
 * Durability: every transition this module makes is a checkpoint write in `workspace.db`, and the
 * queue's own state is a durable snapshot the daemon owns. Nothing meaningful lives only in memory,
 * which is what makes `recoverInterruptedApplicationAttempts` below a small, honest function rather
 * than a reconstruction.
 */

export type ApplicationQueueEntryState = 'queued' | 'active' | 'paused' | 'cancelled' | 'done' | 'failed';

export interface ApplicationQueueLeaseHandle {
  leaseId: string;
  attemptId: string;
}

/** The daemon-owned queue, as this module needs it. An interface rather than a direct import of
 * `main.ts`'s `daemonFetch` so the pipeline can be driven by a test with no daemon running, and so
 * it is obvious at a glance that this module only ever *asks* the queue for things. */
export interface ApplicationQueuePort {
  enqueue(attemptId: string): Promise<void>;
  /** `null` when nothing is schedulable -- a normal outcome for a poller, never an error. */
  acquireLease(): Promise<ApplicationQueueLeaseHandle | null>;
  release(leaseId: string, outcome: 'completed' | 'failed' | 'requeue'): Promise<void>;
  /** `null` when the queue has no entry for this attempt at all. */
  entryState(attemptId: string): Promise<ApplicationQueueEntryState | null>;
}

/** Result of one Domain A generation session, matching `runFieldMapGeneration`'s own shape. */
export interface FieldMapGenerationOutcome {
  ok: boolean;
  text: string;
  error?: string;
}

export interface ApplicationPipelineDeps {
  db: WorkspaceDb;
  /** Where staged artifacts are written, e.g. `join(app.getPath('userData'), 'application-artifacts')`. */
  storageRoot: string;
  queue: ApplicationQueuePort;
  /** Runs the daemon's hardened, text-only field-map generation session. The one genuinely external
   * step in the pipeline, and the only thing a test stands in for. */
  generateFieldMap(prompt: string): Promise<FieldMapGenerationOutcome>;
  /** The configured candidate profile, or null when there is none. Never defaulted: an unconfigured
   * profile contributes no values rather than assumed ones. */
  loadProfile(): Promise<ApplicationValueProfile | null>;
  now?(): Date;
  log?(message: string, meta?: Record<string, unknown>): void;
}

function nowIso(deps: ApplicationPipelineDeps): string {
  return (deps.now?.() ?? new Date()).toISOString();
}

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

function describeError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Identifies which version of this pipeline produced an attempt, so a later change to the
 * contract cannot silently reinterpret an already-recorded one (see `applicationAttempts`'
 * `workflowVersion` column). */
export const APPLICATION_PIPELINE_WORKFLOW_VERSION = 'review-mode-v1';

// --------------------------------------------------------------------------------- starting

/** One vacancy as this app's own discovery data records it. Assembled by the caller from the
 * discovery report, never from anything the renderer supplies: the renderer names a vacancy key,
 * and main resolves every other field itself. */
export interface PipelineVacancy {
  vacancyKey: string | null;
  company: string;
  role: string;
  /** The URL this attempt would actually apply through. */
  applyUrl: string;
  /** The job description exactly as the source returned it, or null where the source carried none.
   * Never an empty string standing in for "missing". */
  description: string | null;
  /** False when the description is known to have been truncated by a source-side limit. #193's own
   * gap: silently dropping requirements past a character limit must never happen unlabeled. */
  descriptionComplete: boolean;
}

export type { StartApplicationAttemptRefusal, StartApplicationAttemptResult };

/** The CV this application is generated from: the explicitly chosen one, else the library default,
 * else nothing at all (which refuses rather than picking arbitrarily). */
function resolveSourceCv(db: WorkspaceDb, cvId: string | null): CvDocumentRecord | undefined {
  const documents = workspace.listCvDocuments(db);
  if (cvId) return documents.find((document) => document.id === cvId);
  const defaultCvId = workspace.getSettings(db).defaultCvId;
  return documents.find((document) => document.id === defaultCvId) ?? documents.find((document) => document.isDefault);
}

export interface StartApplicationAttemptInput {
  vacancy: PipelineVacancy;
  /** Null to use the library's default CV. */
  cvId?: string | null;
  /** Deliberately re-applying to a vacancy that already has a non-terminal attempt (#198's own
   * escape hatch). Defaults to false: a caller has to opt in. */
  force?: boolean;
}

/**
 * The production entry point. Records the attempt -- with the full JD text and the exact source-CV
 * hash the pre-submit gate will later re-derive -- and hands its id to the daemon queue.
 *
 * Does no work of its own beyond that: everything after this point happens under a queue lease, so
 * opening the app, navigating away, or starting the same vacancy twice cannot run two preparations
 * at once. The dedup refusal comes from `createApplicationAttempt` itself, not from a check here,
 * so a second start racing the first inside one transaction still loses.
 */
export async function startApplicationAttempt(
  deps: ApplicationPipelineDeps,
  input: StartApplicationAttemptInput,
): Promise<StartApplicationAttemptResult> {
  const { vacancy } = input;
  if (vacancy.applyUrl.trim().length === 0) {
    return { ok: false, reason: 'no_apply_url', detail: 'this vacancy has no application URL recorded, so there is nothing to apply through' };
  }

  const cv = resolveSourceCv(deps.db, input.cvId ?? null);
  if (!cv) {
    return { ok: false, reason: 'no_cv_available', detail: 'add a CV to your library before preparing an application' };
  }

  const jdSnapshot = vacancy.description ?? '';
  let attempt: ApplicationAttemptRecord;
  try {
    attempt = workspace.createApplicationAttempt(deps.db, {
      vacancyKey: vacancy.vacancyKey,
      canonicalUrl: vacancy.applyUrl,
      company: vacancy.company,
      role: vacancy.role,
      sourceCvId: cv.id,
      // Exactly what `submitApplicationReview`'s pre-submit gate recomputes from the live library
      // record later. Hashing anything else here would make that comparison fail for every attempt.
      sourceCvContentHash: sha256(cv.text),
      jdSnapshot,
      jdSnapshotHash: sha256(jdSnapshot),
      jdComplete: vacancy.description !== null && vacancy.descriptionComplete,
      workflowVersion: APPLICATION_PIPELINE_WORKFLOW_VERSION,
      checkpoint: 'queued',
      ...(input.force ? { force: true } : {}),
    });
  } catch (err) {
    if (err instanceof ApplicationAttemptDuplicateError) {
      return {
        ok: false,
        reason: 'attempt_already_in_progress',
        attemptId: err.existingAttemptId,
        detail: 'an application for this vacancy is already in progress',
      };
    }
    throw err;
  }

  // The queue's own enqueue is idempotent for an attempt it already tracks, so a retry after a
  // transient daemon failure adds nothing twice.
  await deps.queue.enqueue(attempt.id);
  return { ok: true, attemptId: attempt.id };
}

// ---------------------------------------------------------------------------------- running

export type RunApplicationAttemptOutcome =
  /** Prepared and waiting for the person: checkpoint `ready`. */
  | 'ready'
  /** Something needs a human before this can go further: checkpoint `needs_user`. */
  | 'needs_user'
  /** The pipeline could not continue: checkpoint `failed`. */
  | 'failed'
  /** The attempt had already been prepared (or decided) and was left exactly as it was. */
  | 'already_settled'
  /** The queue said to stop: paused, or cancelled/skipped from elsewhere. */
  | 'halted';

export interface RunApplicationAttemptResult {
  attemptId: string;
  outcome: RunApplicationAttemptOutcome;
  checkpoint: ApplicationAttemptCheckpoint;
  detail?: string;
}

/** Checkpoints a run must leave completely alone. `ready` and the submit-side checkpoints mean the
 * attempt already reached or passed review; `needs_user` is a durable, deliberate handoff to the
 * person and is never cleared by the pipeline running again; `skipped`/`failed` are decided. */
const SETTLED_CHECKPOINTS: readonly ApplicationAttemptCheckpoint[] = [
  'ready',
  'submitting',
  'submitted',
  'submission_unknown',
  'needs_user',
  'skipped',
  'failed',
];

/** Checkpoints that can only mean "a previous run of this pipeline was interrupted": nothing is
 * running them right now, because the only thing that ever sets them is a run in progress. */
const IN_FLIGHT_CHECKPOINTS: readonly ApplicationAttemptCheckpoint[] = ['reading_jd', 'tailoring', 'rendering', 'filling'];

function settle(
  deps: ApplicationPipelineDeps,
  attemptId: string,
  checkpoint: ApplicationAttemptCheckpoint,
  detail: string,
  outcome: RunApplicationAttemptOutcome,
): RunApplicationAttemptResult {
  workspace.updateApplicationAttempt(deps.db, attemptId, { checkpoint, checkpointDetail: detail });
  return { attemptId, outcome, checkpoint, detail };
}

/**
 * Whether the queue still wants this attempt worked on. Re-read between stages rather than once at
 * the top: a person can pause or cancel at any point, and each stage below is slow enough (a real
 * PDF render, a real generation session, a real page load) that "checked at the start" would mean
 * "ignored in practice".
 */
async function queueStillWantsThis(deps: ApplicationPipelineDeps, attemptId: string): Promise<'continue' | 'paused' | 'cancelled'> {
  const state = await deps.queue.entryState(attemptId);
  if (state === 'paused') return 'paused';
  if (state === 'cancelled') return 'cancelled';
  return 'continue';
}

function cvContactOf(cv: CvDocumentRecord | undefined): ApplicationValueCvContact | null {
  if (!cv?.source) return null;
  return {
    name: cv.source.contact.name,
    title: cv.source.contact.title,
    location: cv.source.contact.location,
    email: cv.source.contact.email,
    phone: cv.source.contact.phone,
    links: cv.source.contact.links,
  };
}

/** The letters this application asks for: ones the user actually wrote for this vacancy and marked
 * final. Never a letter generated here from the job description -- a letter this app composed on
 * its own is exactly the fabricated content #274/#281's structured-source model exists to prevent,
 * and this ticket does not add one. */
function requestedLetters(db: WorkspaceDb, attempt: ApplicationAttemptRecord): RequestedLetter[] {
  if (!attempt.vacancyKey) return [];
  const requested: RequestedLetter[] = [];
  for (const letter of workspace.listLetters(db)) {
    if (letter.vacancyKey !== attempt.vacancyKey || letter.status !== 'final') continue;
    if (letter.type !== 'cover_letter' && letter.type !== 'motivation_letter') continue;
    requested.push({ kind: letter.type, title: letter.title, body: letter.body });
  }
  return requested;
}

interface RequestedLetter {
  kind: 'cover_letter' | 'motivation_letter';
  title: string;
  body: string;
}

/**
 * Carries one attempt from `queued` to `ready` (or to an honest stop short of it).
 *
 * Safe to call more than once for the same attempt: a settled attempt is returned untouched rather
 * than re-run, which is what makes reopening the app, re-navigating to the Applications page, or a
 * second queue tick incapable of preparing the same application twice.
 *
 * The browser view is always closed before returning, on every path. A review the person opens
 * afterwards opens its own view against the same page -- `openApplicationReview` refuses a second
 * concurrent review for one attempt, so leaving this one open would make the prepared attempt
 * unreviewable.
 */
export async function runApplicationAttempt(deps: ApplicationPipelineDeps, attemptId: string): Promise<RunApplicationAttemptResult> {
  const attempt = workspace.getApplicationAttempt(deps.db, attemptId);
  if (SETTLED_CHECKPOINTS.includes(attempt.checkpoint)) {
    return { attemptId, outcome: 'already_settled', checkpoint: attempt.checkpoint, detail: attempt.checkpointDetail };
  }

  const wanted = await queueStillWantsThis(deps, attemptId);
  if (wanted === 'cancelled') return settle(deps, attemptId, 'skipped', 'this application was cancelled from the queue', 'halted');
  if (wanted === 'paused') {
    return settle(deps, attemptId, 'queued', 'paused; it will pick up again when you resume it', 'halted');
  }

  // ------------------------------------------------------------------- 1. the job description
  workspace.updateApplicationAttempt(deps.db, attemptId, { checkpoint: 'reading_jd', checkpointDetail: '' });
  if (attempt.jdSnapshot.trim().length === 0) {
    return settle(
      deps,
      attemptId,
      'needs_user',
      'no job description was captured for this vacancy, so there is nothing to tailor an application from',
      'needs_user',
    );
  }
  if (!attempt.jdComplete) {
    return settle(
      deps,
      attemptId,
      'needs_user',
      'the job description this app captured is incomplete, so requirements may be missing; open the posting and apply from it directly',
      'needs_user',
    );
  }

  // --------------------------------------------------------- 2. where this application goes
  // Resolved before any work is done, so an unsupported destination costs nothing and, crucially,
  // never falls back to a policy that was compiled for something else. The fixture policy covers
  // exactly two local files by full URL; every real employer URL resolves to nothing here, and gets
  // a handoff rather than the fixture's permissions.
  const policyId = resolvePolicyIdForCanonicalUrl(attempt.canonicalUrl);
  if (!policyId) {
    return settle(
      deps,
      attemptId,
      'needs_user',
      'this employer’s application site is not one this app is cleared to fill in for you. Your tailored documents are kept with this attempt; apply on the site yourself and then mark this attempt done.',
      'needs_user',
    );
  }

  // ---------------------------------------------------------------------- 3. the documents
  workspace.updateApplicationAttempt(deps.db, attemptId, { checkpoint: 'tailoring', checkpointDetail: '' });
  const cv = workspace.listCvDocuments(deps.db).find((document) => document.id === attempt.sourceCvId);
  if (!cv) {
    return settle(
      deps,
      attemptId,
      'needs_user',
      'the CV this application was started from is no longer in your library',
      'needs_user',
    );
  }

  const profile = await deps.loadProfile();
  const target = { company: attempt.company, role: attempt.role };
  const resume = cvDocumentToTailoredResume(cv, profile);

  workspace.updateApplicationAttempt(deps.db, attemptId, { checkpoint: 'rendering', checkpointDetail: '' });
  let readinessRefusals: string[];
  try {
    const staged = await stageApplicationDocuments({
      db: deps.db,
      attemptId,
      storageRoot: deps.storageRoot,
      target,
      resume,
      // Employers the reviewed source CV attests to, so a genuine re-application to a previous
      // employer is not mistaken for a fabricated one by the acceptance contract.
      verifiedEmployers: (cv.source?.experience ?? []).map((entry) => entry.company),
      letters: requestedLetters(deps.db, attempt),
    });
    readinessRefusals = staged.readiness.ok ? [] : staged.readiness.refusals.map((refusal) => refusal.detail);
  } catch (err) {
    return settle(deps, attemptId, 'needs_user', `the application documents could not be produced: ${describeError(err)}`, 'needs_user');
  }
  if (readinessRefusals.length > 0) {
    return settle(deps, attemptId, 'needs_user', `the application documents are not ready: ${readinessRefusals.join('; ')}`, 'needs_user');
  }

  const stillWanted = await queueStillWantsThis(deps, attemptId);
  if (stillWanted === 'cancelled') return settle(deps, attemptId, 'skipped', 'this application was cancelled from the queue', 'halted');
  if (stillWanted === 'paused') return settle(deps, attemptId, 'queued', 'paused; it will pick up again when you resume it', 'halted');

  // ------------------------------------------------------------------------- 4. the form
  workspace.updateApplicationAttempt(deps.db, attemptId, { checkpoint: 'filling', checkpointDetail: '' });
  // Cleared before filling starts, not after it finishes: an attempt being prepared again must
  // never show a previous run's answers while this one is still in progress.
  workspace.recordPreparedApplicationFields(deps.db, attemptId, null);

  try {
    return await fillApplicationForm(deps, { attempt, policyId, cv, profile });
  } catch (err) {
    return settle(deps, attemptId, 'failed', `preparing this application failed: ${describeError(err)}`, 'failed');
  } finally {
    // Always, on every path including a thrown error: see this function's own doc comment.
    await closeApplicationReview(attemptId).catch((err: unknown) => {
      deps.log?.('could not close the preparation browser view', { attemptId, error: describeError(err) });
    });
  }
}

interface FillApplicationFormInput {
  attempt: ApplicationAttemptRecord;
  policyId: string;
  cv: CvDocumentRecord;
  profile: ApplicationValueProfile | null;
}

/** The open-snapshot-generate-validate-apply half, split out only so `runApplicationAttempt`'s
 * `finally` can guarantee the view is closed around all of it. */
async function fillApplicationForm(
  deps: ApplicationPipelineDeps,
  input: FillApplicationFormInput,
): Promise<RunApplicationAttemptResult> {
  const attemptId = input.attempt.id;
  let snapshot: FormSnapshot;
  try {
    ({ snapshot } = await openApplicationReview({
      attemptId,
      policyId: input.policyId,
      targetUrl: input.attempt.canonicalUrl,
    }));
  } catch (err) {
    return settle(deps, attemptId, 'needs_user', `the application page could not be opened: ${describeError(err)}`, 'needs_user');
  }

  if (snapshot.challengeDetected) {
    return settle(
      deps,
      attemptId,
      'needs_user',
      'this page is showing a CAPTCHA or bot check. This app never answers those; open the application yourself to continue.',
      'needs_user',
    );
  }

  const valueTable: ApplicationValueTableEntry[] = buildApplicationValueTable({
    cvContact: cvContactOf(input.cv),
    profile: input.profile,
  });
  if (valueTable.length === 0) {
    return settle(
      deps,
      attemptId,
      'needs_user',
      'none of your saved details could be used to fill this form; review your CV contact details and candidate profile',
      'needs_user',
    );
  }

  const generation = await deps.generateFieldMap(buildFieldMapGenerationPrompt({ attemptId, snapshot, valueTable }));
  if (!generation.ok) {
    return settle(deps, attemptId, 'needs_user', `working out what goes in each field did not finish: ${generation.error ?? 'no reason given'}`, 'needs_user');
  }

  const parsed = parseFieldMap(extractJsonObject(generation.text));
  if (!parsed) {
    return settle(deps, attemptId, 'needs_user', 'the field-mapping step returned something this app could not read, so nothing was typed into the form', 'needs_user');
  }

  const sanitised = sanitiseGeneratedFieldMap(parsed);
  const applied = await applyApplicationFieldMap({
    attemptId,
    // Still raw as far as the executor is concerned: `validateFieldMap` inside `applyApplicationFieldMap`
    // re-checks every rule from scratch against the live snapshot. The narrowing above removes
    // assignment kinds this pipeline will not commit; it is not, and must not be read as, validation.
    fieldMap: sanitised.fieldMap,
    valueTable: valueTable.map((entry) => ({ valueRef: entry.valueRef, value: entry.value, provenance: entry.provenance })),
  });
  if (!applied.ok) {
    return settle(deps, attemptId, 'needs_user', `the answers for this form were refused (${applied.reason ?? 'unknown reason'}): ${applied.detail ?? 'no detail'}`, 'needs_user');
  }

  const summary = summarisePreparedFields({
    snapshot,
    fieldMap: sanitised.fieldMap,
    valueTable,
    uploadFieldRefs: sanitised.uploadFieldRefs,
    optionFieldRefs: sanitised.optionFieldRefs,
    company: input.attempt.company,
    role: input.attempt.role,
    preparedAt: nowIso(deps),
  });
  workspace.recordPreparedApplicationFields(deps.db, attemptId, summary.prepared);

  if (summary.blockers.length > 0) {
    return settle(deps, attemptId, 'needs_user', summary.blockers.join('; '), 'needs_user');
  }
  return settle(deps, attemptId, 'ready', '', 'ready');
}

/**
 * Pulls the one JSON object out of a generation response. A model asked for "JSON and nothing else"
 * still sometimes wraps it in a markdown fence or adds a sentence; refusing those outright would
 * turn a recoverable formatting habit into a failed application, while accepting arbitrary text
 * would not. Returns the raw string unchanged when no object is found, so `parseFieldMap` produces
 * the refusal rather than this helper inventing one.
 */
function extractJsonObject(text: string): unknown {
  const trimmed = text.trim();
  const start = trimmed.indexOf('{');
  const end = trimmed.lastIndexOf('}');
  const candidate = start >= 0 && end > start ? trimmed.slice(start, end + 1) : trimmed;
  try {
    return JSON.parse(candidate);
  } catch {
    return candidate;
  }
}

// ------------------------------------------------------------------------- the worker tick

export interface RunNextApplicationAttemptResult {
  /** Null when the queue had nothing schedulable. */
  result: RunApplicationAttemptResult | null;
}

/**
 * One turn of the worker: ask the daemon for a lease, run whatever it hands back, release it.
 *
 * The lease is released on every path, including a thrown one. `release` is a no-op on the daemon's
 * side when the lease has already moved on (paused or cancelled from elsewhere mid-run), so this
 * can never take a lease away from a later run.
 *
 * `needs_user` releases as `completed`, not `failed`: the queue's job was to schedule this
 * attempt's preparation, and that finished. Whether the *application* still needs something is the
 * attempt's own durable checkpoint, which is where a person reads it from.
 */
export async function runNextApplicationAttempt(deps: ApplicationPipelineDeps): Promise<RunNextApplicationAttemptResult> {
  const lease = await deps.queue.acquireLease();
  if (!lease) return { result: null };

  let result: RunApplicationAttemptResult;
  try {
    result = await runApplicationAttempt(deps, lease.attemptId);
  } catch (err) {
    await deps.queue.release(lease.leaseId, 'failed').catch(() => {});
    throw err;
  }
  await deps.queue.release(lease.leaseId, result.outcome === 'failed' ? 'failed' : result.outcome === 'halted' ? 'requeue' : 'completed');
  return { result };
}

// ------------------------------------------------------------------------- restart recovery

export interface RecoveredApplicationAttempt {
  attemptId: string;
  from: ApplicationAttemptCheckpoint;
}

/** States that mean the queue is not going to schedule this attempt again on its own. `paused` is
 * deliberately absent: a person put it there, and re-enqueuing would undo that. */
const UNSCHEDULED_QUEUE_STATES: readonly (ApplicationQueueEntryState | null)[] = [null, 'done', 'failed'];

/**
 * Puts back on the queue every attempt a previous run of the app left mid-preparation.
 *
 * The four in-flight checkpoints can only be set by a run that is happening right now, so finding
 * one at startup means that run was interrupted -- the app quit, the machine slept, the process
 * died. The browser view and the generation session it held are gone with it, so there is nothing
 * to resume *into*: the attempt returns to `queued` and the queue schedules it again from the top.
 *
 * Also re-queues an attempt sitting at `queued` that the queue has no schedulable entry for. That
 * is the state a start leaves behind when the daemon was unreachable at the moment it was asked to
 * enqueue: the attempt is durably recorded, the queue never heard about it, and the dedup rule
 * would refuse a fresh start for the same vacancy -- so without this it would sit there forever.
 * Nothing about its checkpoint changes; it is only handed to the queue again.
 *
 * Deliberately narrow otherwise. `ready` attempts are left exactly as they are (their documents are
 * staged and their answers recorded; re-running would throw that away and re-render it
 * identically), and so are `needs_user` ones -- a handoff to the person survives a restart
 * precisely because nothing here clears it. A `paused` queue entry survives too: it is not one of
 * the states above, so it is never re-enqueued out from under the person who paused it.
 */
export async function recoverInterruptedApplicationAttempts(
  deps: ApplicationPipelineDeps,
): Promise<RecoveredApplicationAttempt[]> {
  const attempts = workspace.listApplicationAttempts(deps.db);
  const recovered: RecoveredApplicationAttempt[] = [];

  async function enqueue(attemptId: string): Promise<void> {
    try {
      await deps.queue.enqueue(attemptId);
    } catch (err) {
      deps.log?.('could not re-queue an application attempt', { attemptId, error: describeError(err) });
    }
  }

  for (const attempt of attempts.filter((candidate) => IN_FLIGHT_CHECKPOINTS.includes(candidate.checkpoint))) {
    workspace.updateApplicationAttempt(deps.db, attempt.id, {
      checkpoint: 'queued',
      checkpointDetail: 'the app closed while this was being prepared; it will start again from the beginning',
    });
    // Any answers the interrupted run had already committed describe a page this process no longer
    // has open, so they are not this attempt's prepared state any more.
    workspace.recordPreparedApplicationFields(deps.db, attempt.id, null);
    await enqueue(attempt.id);
    recovered.push({ attemptId: attempt.id, from: attempt.checkpoint });
  }

  for (const attempt of attempts.filter((candidate) => candidate.checkpoint === 'queued')) {
    if (recovered.some((entry) => entry.attemptId === attempt.id)) continue;
    let state: ApplicationQueueEntryState | null;
    try {
      state = await deps.queue.entryState(attempt.id);
    } catch (err) {
      deps.log?.('could not read an application attempt\'s queue state', { attemptId: attempt.id, error: describeError(err) });
      continue;
    }
    if (!UNSCHEDULED_QUEUE_STATES.includes(state)) continue;
    await enqueue(attempt.id);
    recovered.push({ attemptId: attempt.id, from: 'queued' });
  }

  return recovered;
}
