import { createHash } from 'node:crypto';
import { describeBlockers, parseFieldMap, type FormSnapshot } from '@agent-dock/application-executor';
import { stageApplicationDocuments, stageLetterArtifact, StagingAbandonedError } from './application-artifact-staging.js';
import {
  INTERRUPTED_ATTEMPT_RESTART,
  isInterruptedCheckpoint,
  isSettledCheckpoint,
  resolveAttemptRecovery,
  resolveAttemptTransition,
  resolveQueueDirective,
  type ApplicationQueueDirective,
  type ApplicationQueueEntryState,
} from './application-attempt-transitions.js';
import {
  generateApplicationCoverLetter,
  type ApplicationCoverLetterGenerationResult,
} from './application-cover-letter.js';
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
import type { TailoredResume } from './resume-schema.js';
import {
  generateApplicationTailoredResume,
  type ApplicationTailoringGenerationResult,
} from './application-tailoring.js';
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

/** Re-exported, not re-declared: the daemon's queue state is now one half of the transition table in
 * `application-attempt-transitions.ts`, and `main.ts` and this module's tests keep importing it from
 * here exactly as they always have. */
export type { ApplicationQueueEntryState };

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
  /** Runs source-grounded, vacancy-specific CV tailoring in the app-owned scratch workspace. */
  generateTailoredResume(prompt: string): Promise<ApplicationTailoringGenerationResult>;
  /** Runs source-grounded cover-letter generation when no final requested letter is available. */
  generateCoverLetter(prompt: string): Promise<ApplicationCoverLetterGenerationResult>;
  /** The configured candidate profile, or null when there is none. Never defaulted: an unconfigured
   * profile contributes no values rather than assumed ones. */
  loadProfile(): Promise<ApplicationValueProfile | null>;
  /**
   * Best-effort on-demand fetch for a vacancy the scan itself captured no description for (some
   * sources' list endpoints never carry one at all -- see `jobgetherOfferIdFromUrl`/
   * `fetchJobgetherOfferDetail` and `workableJobReferenceFromUrl`/`fetchWorkableJobDetail` in
   * `@open-vacancy-radar/vacancy-engine`). Called only when
   * `jdSnapshot` is empty, so a settled attempt or one the scan already covered never triggers a
   * network request. Optional, and never required to succeed: a source this cannot fetch from (an
   * unrecognised URL, a bot-protected page, a timeout) resolves to `null` and the existing "no job
   * description was captured" refusal below still applies -- this only adds a chance to avoid that
   * refusal, it never replaces it.
   */
  fetchMissingJobDescription?(canonicalUrl: string): Promise<{ description: string; complete: boolean } | null>;
  /**
   * How long one attempt's preparation may go without settling before `runNextApplicationAttempt`
   * stops waiting for it, hands the daemon's lease back, and fences everything the abandoned run
   * might still write (see "the preparation fence" below).
   *
   * Omitted means "wait forever", which is what every caller that is not the recurring worker wants:
   * a run started from the UI, or from a test, has someone actually waiting for its result. Only the
   * worker has the problem this solves -- nobody is waiting for its turn, so a single stuck step used
   * to hold the one global lease until the whole app was restarted.
   */
  abandonPreparationAfterMs?: number;
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

async function enqueueApplicationAttempt(deps: ApplicationPipelineDeps, attemptId: string): Promise<void> {
  try {
    await deps.queue.enqueue(attemptId);
  } catch (firstError) {
    // A lost response can mean the daemon committed the enqueue even though this process saw an
    // error. Reconcile durable queue state before retrying, so one action never schedules twice.
    let queueState: ApplicationQueueEntryState | null;
    try {
      queueState = await deps.queue.entryState(attemptId);
    } catch {
      queueState = null;
    }
    if (queueState === null) {
      try {
        await deps.queue.enqueue(attemptId);
      } catch (retryError) {
        settle(
          { deps },
          attemptId,
          'failed',
          `application preparation could not be queued: ${describeError(retryError)}`,
          'failed',
        );
        throw retryError;
      }
    } else if (queueState === 'cancelled' || queueState === 'done' || queueState === 'failed') {
      settle(
        { deps },
        attemptId,
        'failed',
        `application preparation could not be queued: ${describeError(firstError)}`,
        'failed',
      );
      throw firstError;
    }
  }
}

/** Identifies which version of this pipeline produced an attempt, so a later change to the
 * contract cannot silently reinterpret an already-recorded one (see `applicationAttempts`'
 * `workflowVersion` column). */
export const APPLICATION_PIPELINE_WORKFLOW_VERSION = 'review-mode-v2-ai-tailored';

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

  await enqueueApplicationAttempt(deps, attempt.id);
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

export interface RestartApplicationTailoringResult {
  ok: boolean;
  attemptId: string;
  tailoringMode: ApplicationAttemptRecord['tailoringMode'];
  detail?: string;
}

/**
 * Which checkpoint may be worked on, which queue state still wants it worked on, and where a run
 * that may not continue has to leave the attempt, all live in
 * `application-attempt-transitions.ts` -- see its header for why.
 *
 * Four constants used to live here instead: `SETTLED_CHECKPOINTS`, `IN_FLIGHT_CHECKPOINTS`,
 * `UNSCHEDULED_QUEUE_STATES` and the body of `queueStillWantsThis`, each a partial view of the same
 * checkpoint-times-queue-state pairing, separately named and separately maintained. They agreed
 * with each other only by convention, and the one place they stopped agreeing (`user_reported`) is
 * documented on its row in that table. Every one of them is now derived from it, so this module
 * reasons about the pairing in one vocabulary rather than four.
 */

// ------------------------------------------------------------------- the preparation fence

/**
 * Which run of a given attempt's preparation is the live one, and therefore the only one allowed to
 * write anything down for it.
 *
 * A worker that hits its ceiling can stop *waiting* for a preparation; it cannot stop the
 * preparation itself, because every slow step in one (a CDP round trip, a generation session, a PDF
 * render) is a promise nothing here can cancel. Handing the daemon's lease back at that moment is
 * still the right thing to do -- it is the whole point of noticing the hang, since otherwise the one
 * global lease stays held by a run nobody is watching and the queue is wedged until the app is
 * restarted -- but it does mean the next tick can legitimately acquire a fresh lease for the same
 * attempt while the abandoned run is still going. Two runs then race over one attempt's checkpoint
 * column, its `preparedFields` and its staged PDFs, and last-write-wins would let the older,
 * abandoned run flap the checkpoint backwards or replace the newer run's documents with its own.
 * Which CV and which cover letter end up attached to a real application is exactly the thing this
 * module is not allowed to get wrong.
 *
 * So each run carries a generation, minted when its lease is acquired, and every durable write it
 * makes checks that its generation is still the current one for that attempt before it lands.
 * Abandoning a run discards the entry outright rather than waiting for the next lease to replace it,
 * so the abandoned run is fenced out from that instant -- there is no window between "the lease is
 * free again" and "the old run can no longer write". Generations come from one process-wide counter
 * and are never reused, so a token left over from an earlier cycle can never compare equal to a
 * later one's.
 *
 * In-process only, and deliberately so: a preparation cannot outlive the process running it, and a
 * lease that outlives the process is already reconciled when the daemon next starts
 * (`ApplicationQueueStore#reconcileStaleLeaseOnStartup`). This is the same shape as
 * `submittingAttemptIds` in `application-review-session.ts` -- an in-process guard for an in-process
 * race -- applied to the different problem of *preparation*. It neither replaces nor weakens that
 * one: a real submission is fenced there, independently, however many stale preparations are in
 * flight.
 */
const livePreparations = new Map<string, number>();
let nextPreparationGeneration = 0;

/** One run's claim on an attempt's preparation. Opaque on purpose: the only thing a caller ever does
 * with one is hand it back to `runApplicationAttempt`. */
export interface PreparationFence {
  readonly attemptId: string;
  readonly generation: number;
}

function beginPreparationFence(attemptId: string): PreparationFence {
  nextPreparationGeneration += 1;
  livePreparations.set(attemptId, nextPreparationGeneration);
  return { attemptId, generation: nextPreparationGeneration };
}

/** Fences out whichever run currently holds this attempt, without minting a replacement -- the next
 * `beginPreparationFence` does that, if and when a new lease is acquired. */
function abandonPreparationFence(attemptId: string): void {
  livePreparations.delete(attemptId);
}

/** Drops a settled run's entry, so a process that runs for weeks does not accumulate one per attempt
 * it ever prepared. Guarded on the generation still matching, so a run settling late can never clear
 * the entry belonging to the run that replaced it. */
function endPreparationFence(fence: PreparationFence): void {
  if (livePreparations.get(fence.attemptId) === fence.generation) livePreparations.delete(fence.attemptId);
}

/**
 * One `runApplicationAttempt` call's context: its dependencies, plus the fence saying whether this
 * run is still the one entitled to write for its attempt.
 *
 * `fence` is absent for every path that does not run under a queue lease at all -- the failure write
 * `startApplicationAttempt` makes when the queue cannot be reached, and a direct
 * `runApplicationAttempt` call that passes no fence. Those write unconditionally, exactly as they
 * did before any of this existed: with no second run possible, there is nothing to fence against.
 */
interface PipelineRun {
  deps: ApplicationPipelineDeps;
  fence?: PreparationFence;
}

/** Whether this run is still the live preparation for its attempt. Always true for a run holding no
 * fence. */
function isLivePreparation(run: PipelineRun): boolean {
  return run.fence === undefined || livePreparations.get(run.fence.attemptId) === run.fence.generation;
}

/**
 * The single chokepoint every durable write on the preparation path goes through, so that fencing is
 * one decision made in one place rather than a check copy-pasted next to a dozen repository calls.
 *
 * A write from a fenced-out run is dropped and reported as `undefined`. Dropped *silently*, and
 * never thrown: an abandoned run is not an error condition. It is the expected end of a run nobody
 * is waiting for any more, whose attempt is meanwhile being prepared perfectly well by the run that
 * replaced it. Turning that into a thrown error would only manufacture a failure for a person to
 * read about an application that is in fact fine.
 */
function fencedWrite<T>(run: PipelineRun, write: () => T): T | undefined {
  if (!isLivePreparation(run)) return undefined;
  return write();
}

/**
 * Why `fencedWrite` alone is not enough for the two steps below that go out to the world.
 *
 * `fencedWrite` gates *starting* the write, which is the same thing as gating the write itself for
 * every synchronous `workspace.*` call it wraps: nothing can move the fence between the check and
 * the row landing, because nothing else runs. It is not the same thing for a step whose durable part
 * happens inside an already-started async call -- staging (an offscreen `printToPDF` that can hang
 * for minutes, and only then a file write and the row swap that makes it the attempt's current
 * document) and form filling (a CDP round trip per field, into a page a replacement run may own by
 * the time the next one goes out). For those, "checked when the promise was created" is a check made
 * long before anything happened, and the fenced-out run's own `if (!staged) return` afterwards
 * cannot help: it gets a perfectly good result object back, because the work really did run.
 *
 * So both of those steps take this callback and re-ask it on their own trailing edge, immediately
 * before each durable effect: `stageApplicationDocuments`/`stageLetterArtifact` bail inside
 * `writeAndRegisterArtifact` (throwing `StagingAbandonedError`, caught below), and
 * `applyApplicationFieldMap` bails before each fill/select/attach.
 *
 * What each of those two can still promise differs, and the difference is worth knowing. Staging
 * owns both ends of its own writes, so it orders them to put every irreversible one -- the row swap
 * that takes the live run's document away -- after its trailing check, and compensates the one that
 * cannot wait (see `writeAndRegisterArtifact`'s own comment): an abandoned staging run leaves no row
 * behind at all. Form filling does not own the far end -- a keystroke that has reached the page is
 * in someone else's document -- so the gap that remains there is one fill already in flight, which
 * nothing in this process can cancel and nothing can undo either.
 */
function stillLiveCheck(run: PipelineRun): () => boolean {
  return () => isLivePreparation(run);
}

/**
 * What a fenced-out run returns in place of a checkpoint it is no longer entitled to write.
 *
 * Nothing consumes this in production -- `runNextApplicationAttempt` stopped waiting for this run
 * long before it got here -- so the fields are inert by construction: `halted` and `queued` describe
 * the queue entry the abandonment already requeued, not a claim about the attempt row, which now
 * belongs to whichever run replaced this one. The log line is the part that matters, because a run
 * fenced out mid-flight is otherwise completely invisible.
 */
function abandoned(run: PipelineRun, attemptId: string): RunApplicationAttemptResult {
  run.deps.log?.('an abandoned preparation stopped; its remaining writes were discarded', { attemptId });
  return {
    attemptId,
    outcome: 'halted',
    checkpoint: 'queued',
    detail: 'this preparation was abandoned after it stopped making progress; a newer run owns this attempt',
  };
}

function settle(
  run: PipelineRun,
  attemptId: string,
  checkpoint: ApplicationAttemptCheckpoint,
  detail: string,
  outcome: RunApplicationAttemptOutcome,
): RunApplicationAttemptResult {
  fencedWrite(run, () => workspace.updateApplicationAttempt(run.deps.db, attemptId, { checkpoint, checkpointDetail: detail }));
  return { attemptId, outcome, checkpoint, detail };
}

/**
 * Whether the queue still wants this attempt worked on, and where to leave it if not. Re-read
 * between stages rather than once at the top: a person can pause or cancel at any point, and each
 * stage below is slow enough (a real PDF render, a real generation session, a real page load) that
 * "checked at the start" would mean "ignored in practice".
 *
 * The verdict itself, including the sentence a person reads afterwards, comes from the queue half of
 * the transition table; this function is only the round trip that fetches the state to look up.
 */
async function queueStillWantsThis(deps: ApplicationPipelineDeps, attemptId: string): Promise<ApplicationQueueDirective> {
  return resolveQueueDirective(await deps.queue.entryState(attemptId));
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

/** The letters the user already wrote for this vacancy and marked final. These take precedence over
 * automatic generation: the pipeline stages the person's requested final document as-is. */
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
 *
 * `fence`, when given, is this run's claim on the attempt (see "the preparation fence"): every write
 * below is dropped once a newer run holds it. `runNextApplicationAttempt` is the only caller that
 * passes one, because it is the only caller that can ever be abandoned mid-run.
 */
export async function runApplicationAttempt(
  deps: ApplicationPipelineDeps,
  attemptId: string,
  fence?: PreparationFence,
): Promise<RunApplicationAttemptResult> {
  const run: PipelineRun = { deps, fence };
  let attempt = workspace.getApplicationAttempt(deps.db, attemptId);
  // Answered from the checkpoint alone, and deliberately before any queue round trip: the table
  // returns `already_settled` for a settled checkpoint whatever the queue happens to say, so asking
  // the daemon could not change this answer -- and every already-prepared attempt a second tick or a
  // re-opened Applications page brings through here would pay for that question.
  if (isSettledCheckpoint(attempt.checkpoint)) {
    return { attemptId, outcome: 'already_settled', checkpoint: attempt.checkpoint, detail: attempt.checkpointDetail };
  }

  const transition = resolveAttemptTransition(attempt.checkpoint, await deps.queue.entryState(attemptId));
  if (transition.action === 'halt') return settle(run, attemptId, transition.checkpoint, transition.detail, 'halted');

  // ------------------------------------------------------------------- 1. the job description
  fencedWrite(run, () => workspace.updateApplicationAttempt(deps.db, attemptId, { checkpoint: 'reading_jd', checkpointDetail: '' }));
  if (attempt.jdSnapshot.trim().length === 0 && deps.fetchMissingJobDescription) {
    // The scan captured nothing for this vacancy -- some sources' list endpoints never carry a
    // description at all. One last, best-effort try before refusing: a live fetch of the specific
    // page this attempt is actually for, not a retry of the scan.
    const fetched = await deps.fetchMissingJobDescription(attempt.canonicalUrl).catch((error) => {
      deps.log?.('on-demand job description fetch failed', { attemptId, error: describeError(error) });
      return null;
    });
    if (fetched && fetched.description.trim().length > 0) {
      const jdSnapshot = fetched.description;
      const jdSnapshotHash = sha256(jdSnapshot);
      const recorded = fencedWrite(run, () =>
        workspace.recordFetchedJobDescription(deps.db, attemptId, {
          jdSnapshot,
          jdSnapshotHash,
          jdComplete: fetched.complete,
        }),
      );
      // `null` means the attempt moved on (cancelled/reset) while the fetch was in flight, and
      // `undefined` that this run was fenced out while it was; either way, don't trust this run's own
      // in-memory `attempt` with a jd that was never actually persisted for it.
      // Merging just the three fields that changed, rather than adopting `recorded` wholesale, keeps
      // `attempt` exactly the snapshot this run started with everywhere else in this function.
      if (recorded) attempt = { ...attempt, jdSnapshot, jdSnapshotHash, jdComplete: fetched.complete };
    }
  }
  if (attempt.jdSnapshot.trim().length === 0) {
    return settle(
      run,
      attemptId,
      'needs_user',
      'no job description was captured for this vacancy, so there is nothing to tailor an application from',
      'needs_user',
    );
  }
  if (!attempt.jdComplete) {
    return settle(
      run,
      attemptId,
      'needs_user',
      'the job description this app captured is incomplete, so requirements may be missing; open the posting and apply from it directly',
      'needs_user',
    );
  }

  // ---------------------------------------------------------------------- 2. the documents
  fencedWrite(run, () => workspace.updateApplicationAttempt(deps.db, attemptId, { checkpoint: 'tailoring', checkpointDetail: '' }));
  const cv = workspace.listCvDocuments(deps.db).find((document) => document.id === attempt.sourceCvId);
  if (!cv) {
    return settle(
      run,
      attemptId,
      'needs_user',
      'the CV this application was started from is no longer in your library',
      'needs_user',
    );
  }

  const profile = await deps.loadProfile();
  const target = { company: attempt.company, role: attempt.role };
  let resume: TailoredResume;
  let tailoringSummary: string;
  if (attempt.tailoringMode === 'original') {
    resume = cvDocumentToTailoredResume(cv, profile);
    tailoringSummary = 'Original reviewed CV used by your explicit choice after automatic tailoring stopped.';
  } else {
    tailoringSummary = 'CV tailored for this vacancy from the reviewed source.';
    try {
      const tailored = await generateApplicationTailoredResume(attempt, cv, deps.generateTailoredResume);
      resume = tailored.resume;
      if (tailored.dropped.length > 0) {
        tailoringSummary += ` Removed unsupported output: ${tailored.dropped.join('; ')}.`;
      }
    } catch (err) {
      return settle(
        run,
        attemptId,
        'needs_user',
        `Automatic CV tailoring stopped: ${describeError(err)}`,
        'needs_user',
      );
    }
  }

  // The first checkpoint after the longest step a run can hang in. If the worker gave up on this
  // preparation while the tailoring session was out, stop here rather than spending a cover-letter
  // session, two PDF renders and a page load on documents that would be discarded anyway.
  if (!isLivePreparation(run)) return abandoned(run, attemptId);

  fencedWrite(run, () => workspace.updateApplicationAttempt(deps.db, attemptId, { checkpoint: 'rendering', checkpointDetail: '' }));
  let stagedRecords: ReturnType<typeof workspace.listApplicationArtifacts>;
  let letters = requestedLetters(deps.db, attempt);
  let letterBlocker: string | null = null;
  // Policy cannot truthfully be guessed from a URL before the policy resolver runs. #326 requires
  // every unsupported-target handoff to contain a letter, so an absent user-final letter is the
  // narrow pre-policy signal that this attempt needs an automatically generated cover letter.
  if (letters.length === 0) {
    try {
      letters = [{
        kind: 'cover_letter',
        title: 'Cover Letter',
        body: await generateApplicationCoverLetter(attempt, cv, deps.generateCoverLetter),
      }];
    } catch (err) {
      letterBlocker = `automatic cover letter generation stopped: ${describeError(err)}`;
    }
  }

  try {
    // Stage the useful CV independently. A failed letter must not erase the manual handoff an
    // unsupported target can still offer with this accepted attempt-owned artifact.
    // Fenced like every other write, and for a stronger reason than most: staging replaces this
    // attempt's artifact rows *and* the PDFs under `storageRoot/<attemptId>/`, so an abandoned run
    // reaching here would overwrite the documents the run that replaced it had already produced.
    // `stillLive` is what actually enforces that -- the check below it only says this run was live
    // when the render *started*, and the render is the part that can hang for minutes.
    const staged = await fencedWrite(run, () =>
      stageApplicationDocuments({
        db: deps.db,
        attemptId,
        storageRoot: deps.storageRoot,
        target,
        resume,
        // Employers the reviewed source CV attests to, so a genuine re-application to a previous
        // employer is not mistaken for a fabricated one by the acceptance contract.
        verifiedEmployers: (cv.source?.experience ?? []).map((entry) => entry.company),
        letters: [],
        stillLive: stillLiveCheck(run),
      }),
    );
    if (!staged) return abandoned(run, attemptId);
    stagedRecords = staged.records;
  } catch (err) {
    // Not a failed document: a document this run was no longer entitled to write. No artifact row
    // was registered and none was taken away, and the attempt belongs to a newer run -- so this
    // stops quietly rather than settling `needs_user` about an application that is in fact fine.
    if (err instanceof StagingAbandonedError) return abandoned(run, attemptId);
    return settle(run, attemptId, 'needs_user', `the tailored CV could not be produced: ${describeError(err)}`, 'needs_user');
  }

  for (const letter of letters) {
    if (letter.body.trim().length === 0) {
      letterBlocker ??= `the requested ${letter.kind.replaceAll('_', ' ')} has no final content`;
      continue;
    }
    try {
      const stagedLetter = await fencedWrite(run, () =>
        stageLetterArtifact({
          db: deps.db,
          attemptId,
          kind: letter.kind,
          title: letter.title,
          body: letter.body,
          candidateName: resume.contact.name,
          target,
          storageRoot: deps.storageRoot,
          stillLive: stillLiveCheck(run),
        }),
      );
      if (!stagedLetter) return abandoned(run, attemptId);
      stagedRecords.push(stagedLetter);
    } catch (err) {
      // As above: an abandoned letter render is not a letter blocker to tell anyone about.
      if (err instanceof StagingAbandonedError) return abandoned(run, attemptId);
      letterBlocker ??= `the ${letter.kind.replaceAll('_', ' ')} could not be produced: ${describeError(err)}`;
    }
  }

  // --------------------------------------------------------- 3. where this application goes
  // Documents are useful on every employer site, so target policy is resolved only after staging.
  // An unsupported destination still never inherits another target's permissions; it reaches a
  // manual review card with attempt-owned documents instead of stopping before anything useful is
  // produced.
  const policyId = resolvePolicyIdForCanonicalUrl(attempt.canonicalUrl);
  if (!policyId) {
    const detail = letterBlocker
      ? `${tailoringSummary} Your tailored CV is ready. Cover letter blocker: ${letterBlocker}. Use Generate letter to create and review one, then return here, or provide one on the employer site.`
      : `${tailoringSummary} Your application documents are ready. This employer site is not approved for automated submission, so apply on the site yourself and mark the attempt when you finish.`;
    return settle(
      run,
      attemptId,
      'needs_user',
      detail,
      'needs_user',
    );
  }

  if (letterBlocker) {
    return settle(
      run,
      attemptId,
      'needs_user',
      `Automatic cover letter preparation stopped: ${letterBlocker}. Your tailored CV is ready. Generate and review a cover letter, then resume the application.`,
      'needs_user',
    );
  }

  const stillWanted = await queueStillWantsThis(deps, attemptId);
  if (stillWanted.action === 'halt') return settle(run, attemptId, stillWanted.checkpoint, stillWanted.detail, 'halted');

  // ------------------------------------------------------------------------- 4. the form
  if (!isLivePreparation(run)) return abandoned(run, attemptId);
  fencedWrite(run, () => workspace.updateApplicationAttempt(deps.db, attemptId, { checkpoint: 'filling', checkpointDetail: '' }));
  // Cleared before filling starts, not after it finishes: an attempt being prepared again must
  // never show a previous run's answers while this one is still in progress.
  fencedWrite(run, () => workspace.recordPreparedApplicationFields(deps.db, attemptId, null));

  let formResult: RunApplicationAttemptResult;
  try {
    formResult = await fillApplicationForm(run, { attempt, policyId, cv, profile, stagedArtifacts: stagedRecords });
  } catch (err) {
    return settle(run, attemptId, 'failed', `preparing this application failed: ${describeError(err)}`, 'failed');
  }
  // Checked before the view is touched rather than after: the live `WebContentsView` for an attempt
  // is shared by whoever is preparing it (`openApplicationReview` hands a second caller the same
  // one), so an abandoned run closing "its" view would close the review belonging to the run that
  // replaced it -- and a person would watch a prepared application disappear.
  if (!isLivePreparation(run)) return abandoned(run, attemptId);
  if (formResult.outcome !== 'ready' && formResult.outcome !== 'needs_user') {
    await closeApplicationReview(attemptId).catch((err: unknown) => {
      deps.log?.('could not close the preparation browser view', { attemptId, error: describeError(err) });
    });
  }
  if (formResult.outcome === 'ready') {
    fencedWrite(run, () =>
      workspace.updateApplicationAttempt(deps.db, attemptId, {
        checkpointDetail: `${tailoringSummary}${formResult.detail ? ` ${formResult.detail}` : ''}`,
      }),
    );
  }
  return formResult;
}

/** Requeues one failed tailoring attempt after the person chooses retry or the original-CV path. */
export async function restartApplicationTailoring(
  deps: ApplicationPipelineDeps,
  attemptId: string,
  tailoringMode: ApplicationAttemptRecord['tailoringMode'],
): Promise<RestartApplicationTailoringResult> {
  const attempt = workspace.getApplicationAttempt(deps.db, attemptId);
  if (attempt.checkpoint !== 'needs_user' || !attempt.checkpointDetail.startsWith('Automatic CV tailoring stopped:')) {
    return { ok: false, attemptId, tailoringMode, detail: 'this application is not waiting on a tailoring failure' };
  }
  workspace.restartApplicationTailoring(deps.db, attemptId, tailoringMode);
  await enqueueApplicationAttempt(deps, attemptId);
  return { ok: true, attemptId, tailoringMode };
}

/** Re-runs preparation after a person addresses a durable needs-user blocker such as a required
 * letter. Manual-target handoffs are already complete preparation and cannot be restarted here. */
export async function resumeApplicationAttempt(
  deps: ApplicationPipelineDeps,
  attemptId: string,
): Promise<RestartApplicationTailoringResult> {
  const attempt = workspace.getApplicationAttempt(deps.db, attemptId);
  if (attempt.checkpoint !== 'needs_user' || attempt.checkpointDetail.includes('Your application documents are ready.')) {
    return {
      ok: false,
      attemptId,
      tailoringMode: attempt.tailoringMode,
      detail: 'this application is not waiting on a preparation blocker',
    };
  }
  await closeApplicationReview(attemptId).catch(() => {});
  workspace.restartApplicationTailoring(deps.db, attemptId, attempt.tailoringMode);
  await enqueueApplicationAttempt(deps, attemptId);
  return { ok: true, attemptId, tailoringMode: attempt.tailoringMode };
}

interface FillApplicationFormInput {
  attempt: ApplicationAttemptRecord;
  policyId: string;
  cv: CvDocumentRecord;
  profile: ApplicationValueProfile | null;
  stagedArtifacts: ReturnType<typeof workspace.listApplicationArtifacts>;
}

/** The open-snapshot-generate-validate-apply half, split out only so `runApplicationAttempt`'s
 * caller can decide whether to retain the prepared live view for review or close it after failure. */
async function fillApplicationForm(
  run: PipelineRun,
  input: FillApplicationFormInput,
): Promise<RunApplicationAttemptResult> {
  const deps = run.deps;
  const attemptId = input.attempt.id;
  // Nothing below is only a database write: this half opens a real page and types into it. A run
  // that has been fenced out must not reach any of that, so the fence is checked before the view is
  // opened and again after the one long external call inside here.
  if (!isLivePreparation(run)) return abandoned(run, attemptId);

  let snapshot: FormSnapshot;
  try {
    ({ snapshot } = await openApplicationReview({
      attemptId,
      policyId: input.policyId,
      targetUrl: input.attempt.canonicalUrl,
    }));
  } catch (err) {
    return settle(run, attemptId, 'needs_user', `the application page could not be opened: ${describeError(err)}`, 'needs_user');
  }

  if (snapshot.challengeDetected) {
    return settle(
      run,
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
      run,
      attemptId,
      'needs_user',
      'none of your saved details could be used to fill this form; review your CV contact details and candidate profile',
      'needs_user',
    );
  }

  const generation = await deps.generateFieldMap(buildFieldMapGenerationPrompt({ attemptId, snapshot, valueTable }));
  // The field-map session is the other step with no timeout of its own, and the one most likely to
  // have been what the worker gave up waiting for. Everything after this line commits keystrokes to
  // a live page, so this is the last honest place to stop.
  if (!isLivePreparation(run)) return abandoned(run, attemptId);
  if (!generation.ok) {
    return settle(run, attemptId, 'needs_user', `working out what goes in each field did not finish: ${generation.error ?? 'no reason given'}`, 'needs_user');
  }

  const parsed = parseFieldMap(extractJsonObject(generation.text));
  if (!parsed) {
    return settle(run, attemptId, 'needs_user', 'the field-mapping step returned something this app could not read, so nothing was typed into the form', 'needs_user');
  }

  const sanitised = sanitiseGeneratedFieldMap(parsed, snapshot, input.stagedArtifacts);
  const applied = await applyApplicationFieldMap(
    deps.db,
    {
      attemptId,
      // Still raw as far as the executor is concerned: `validateFieldMap` inside `applyApplicationFieldMap`
      // re-checks every rule from scratch against the live snapshot. The narrowing above removes
      // assignment kinds this pipeline will not commit; it is not, and must not be read as, validation.
      fieldMap: sanitised.fieldMap,
      valueTable: valueTable.map((entry) => ({ valueRef: entry.valueRef, value: entry.value, provenance: entry.provenance })),
    },
    // Re-asked before every keystroke and every upload inside there, not just here: applying is a
    // round trip per field into a page this run can stop owning part-way through.
    stillLiveCheck(run),
  );
  // Not a refused form: a run that stopped being entitled to type into it. Reported the way every
  // other abandoned step is, rather than as a `needs_user` about somebody else's healthy attempt.
  if (applied.reason === 'preparation_abandoned') return abandoned(run, attemptId);
  if (!applied.ok) {
    return settle(run, attemptId, 'needs_user', `the answers for this form were refused (${applied.reason ?? 'unknown reason'}): ${applied.detail ?? 'no detail'}`, 'needs_user');
  }

  const summary = summarisePreparedFields({
    snapshot,
    fieldMap: sanitised.fieldMap,
    valueTable,
    uploadFieldRefs: sanitised.uploadFieldRefs,
    optionFieldRefs: sanitised.optionFieldRefs,
    readinessBlockers: applied.readiness?.blockers ?? [],
    attachments: applied.attachments ?? [],
    company: input.attempt.company,
    role: input.attempt.role,
    preparedAt: nowIso(deps),
  });
  fencedWrite(run, () => workspace.recordPreparedApplicationFields(deps.db, attemptId, summary.prepared));

  if (applied.readiness && !applied.readiness.ready) {
    return settle(run, attemptId, 'needs_user', describeBlockers(applied.readiness.blockers), 'needs_user');
  }
  if (summary.blockers.length > 0) {
    return settle(run, attemptId, 'needs_user', summary.blockers.join('; '), 'needs_user');
  }
  return settle(run, attemptId, 'ready', '', 'ready');
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
  /** Null when the queue had nothing schedulable, and when this turn was abandoned: an abandoned run
   * is by definition one whose outcome this turn never learned. */
  result: RunApplicationAttemptResult | null;
  /** True when this turn stopped waiting for a preparation that had not settled within
   * `abandonPreparationAfterMs`, gave its lease back, and fenced the run out. */
  abandoned?: boolean;
}

/** Resolved by `withAbandonCeiling` in place of a result that never arrived. */
const ABANDONED = Symbol('abandoned preparation');

/**
 * Resolves with `work`'s own result, or with `ABANDONED` once `ms` has elapsed without it settling.
 *
 * Deliberately not `Promise.race`: the loser of a race is not cancelled, so a `work` that rejects
 * long after this gave up on it would be an unhandled rejection with nothing left to catch it --
 * which in Electron main is a process-level warning at best and a crash at worst. Attaching the
 * handlers directly makes that late rejection genuinely handled, and then discarded like everything
 * else an abandoned run produces.
 */
function withAbandonCeiling<T>(work: Promise<T>, ms: number): Promise<T | typeof ABANDONED> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => resolve(ABANDONED), ms);
    work.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
}

/**
 * One turn of the worker: ask the daemon for a lease, run whatever it hands back, release it.
 *
 * The lease is released on every path, including a thrown one and one that never finishes at all.
 * `release` is a no-op on the daemon's side when the lease has already moved on (paused or cancelled
 * from elsewhere mid-run), so this can never take a lease away from a later run.
 *
 * `needs_user` releases as `completed`, not `failed`: the queue's job was to schedule this
 * attempt's preparation, and that finished. Whether the *application* still needs something is the
 * attempt's own durable checkpoint, which is where a person reads it from.
 *
 * With `abandonPreparationAfterMs` set, a run that has not settled by then is abandoned: the lease
 * goes back as `requeue` so the queue is not left wedged behind it, and the run is fenced out so
 * that when it eventually does settle -- minutes later, or never -- nothing it does can reach the
 * attempt the next lease is meanwhile preparing properly. Its review is closed here too, so a run
 * that hung on the page opening cannot leave behind a snapshot-less registration that every
 * replacement run then trips over. That ordering matters and is not incidental: the fence is
 * discarded, and the review closed, *before* the lease is released, so there is never an instant
 * where the lease is re-acquirable and the abandoned run can still write or still owns a view.
 *
 * This is the half that a hard timeout around the whole tick cannot do on its own. That timeout
 * frees the *ticker* (see `createTick` in `tick.ts`), which stops the worker wedging, but the
 * abandoned call it walks away from still holds the daemon's one global lease until it settles --
 * which for a genuinely stuck CDP call or an untimed generation session is "never", and the queue
 * stays stopped until someone restarts the whole app. That is the incident this closes.
 */
export async function runNextApplicationAttempt(deps: ApplicationPipelineDeps): Promise<RunNextApplicationAttemptResult> {
  const lease = await deps.queue.acquireLease();
  if (!lease) return { result: null };

  const fence = beginPreparationFence(lease.attemptId);
  const work = runApplicationAttempt(deps, lease.attemptId, fence);

  let settled: RunApplicationAttemptResult | typeof ABANDONED;
  try {
    settled = deps.abandonPreparationAfterMs === undefined ? await work : await withAbandonCeiling(work, deps.abandonPreparationAfterMs);
  } catch (err) {
    endPreparationFence(fence);
    await deps.queue.release(lease.leaseId, 'failed').catch(() => {});
    throw err;
  }

  if (settled === ABANDONED) {
    abandonPreparationFence(lease.attemptId);
    // The abandoned run's review has to be closed from *here*, and cannot be closed by the run
    // itself.
    //
    // `openApplicationReview` registers an attempt before it awaits `openTarget`, so a run that
    // hangs on the page opening leaves an entry behind whose executor has no snapshot yet. Fencing
    // that run out does not remove the entry -- and the abandoned run must not remove it either,
    // since by the time it notices, the view it would destroy may already be the replacement run's
    // (see the check in `runApplicationAttempt` just before `closeApplicationReview` there). So the
    // next run reopens, hits the existing-review branch, finds no snapshot, and throws; the *live*
    // run then settles `needs_user` with a message about a review that is nobody's, and every later
    // resume hits the same wall for the rest of the process's life.
    //
    // This is the one moment where closing it is unambiguously right: the fence is already
    // discarded, and the lease has not been released yet, so no replacement run can exist to have
    // its view pulled out from under it.
    await closeApplicationReview(lease.attemptId).catch((error: unknown) => {
      deps.log?.('could not close an abandoned preparation\'s browser view', {
        attemptId: lease.attemptId,
        error: describeError(error),
      });
    });
    deps.log?.('stopped waiting for a preparation and gave its lease back', {
      attemptId: lease.attemptId,
      afterMs: deps.abandonPreparationAfterMs,
    });
    await deps.queue.release(lease.leaseId, 'requeue').catch((error: unknown) => {
      // Nothing useful is left to do about it here, but it must not be silent: a lease that could
      // not be given back is the one condition under which the queue is still wedged afterwards.
      deps.log?.('could not give back the lease of an abandoned preparation', {
        attemptId: lease.attemptId,
        error: describeError(error),
      });
    });
    return { result: null, abandoned: true };
  }

  endPreparationFence(fence);
  await deps.queue.release(lease.leaseId, settled.outcome === 'failed' ? 'failed' : settled.outcome === 'halted' ? 'requeue' : 'completed');
  return { result: settled };
}

// ------------------------------------------------------------------------- restart recovery

export interface RecoveredApplicationAttempt {
  attemptId: string;
  from: ApplicationAttemptCheckpoint;
}

/**
 * Puts back on the queue every attempt a previous run of the app left mid-preparation.
 *
 * The four in-flight checkpoints can only be set by a run that is happening right now, so finding
 * one at startup means that run was interrupted -- the app quit, the machine slept, the process
 * died. The browser view and the generation session it held are gone with it, so there is nothing
 * to resume *into*: the attempt returns to `queued` and the queue schedules it again from the top.
 * That verdict does not consult the queue at all, and does not need to: the table returns the same
 * restart for an interrupted checkpoint paired with every one of the seven queue states, which is a
 * property its own test pins rather than an assumption made here.
 *
 * Also re-queues an attempt sitting at `queued` that the queue has no schedulable entry for. That
 * is the state a start leaves behind when the daemon was unreachable at the moment it was asked to
 * enqueue: the attempt is durably recorded, the queue never heard about it, and the dedup rule
 * would refuse a fresh start for the same vacancy -- so without this it would sit there forever.
 * Nothing about its checkpoint changes; it is only handed to the queue again. This is the one
 * question that genuinely needs both halves of an attempt's state, because `queued` is the one
 * checkpoint whose meaning depends entirely on whether the daemon ever heard about it.
 *
 * Deliberately narrow otherwise. `ready` attempts are left exactly as they are (their documents are
 * staged and their answers recorded; re-running would throw that away and re-render it
 * identically), and so are `needs_user` ones -- a handoff to the person survives a restart
 * precisely because nothing here clears it. A `paused` queue entry survives too: its row says
 * recovery may not re-queue from it, so it is never re-enqueued out from under the person who
 * paused it.
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

  for (const attempt of attempts.filter((candidate) => isInterruptedCheckpoint(candidate.checkpoint))) {
    workspace.updateApplicationAttempt(deps.db, attempt.id, {
      checkpoint: INTERRUPTED_ATTEMPT_RESTART.checkpoint,
      checkpointDetail: INTERRUPTED_ATTEMPT_RESTART.detail,
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
    if (resolveAttemptRecovery(attempt.checkpoint, state).action !== 'requeue') continue;
    await enqueue(attempt.id);
    recovered.push({ attemptId: attempt.id, from: 'queued' });
  }

  return recovered;
}
