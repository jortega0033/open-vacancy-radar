import type { ApplicationAttemptCheckpoint } from './workspace/types.js';

/**
 * Where the two state machines that together describe one application attempt are finally written
 * down in the same place.
 *
 * An attempt has two owners, and always has had. `workspace.db` owns its **checkpoint** -- the
 * thirteen values of `ApplicationAttemptCheckpoint`, every one of them a statement about the
 * application itself (its job description was read, its documents were rendered, a person was asked
 * for something, it was submitted). The daemon's `ApplicationQueueStore` owns its **queue state** --
 * six values that say nothing about the application at all, only whether Electron main may work on
 * it right now.
 *
 * That split stays, and this module deliberately does nothing to narrow it. The daemon has no SQLite
 * dependency and never opens `workspace.db`, precisely so that the process holding the scheduling
 * decision structurally cannot hold a CV, a job description or an employer's name (see
 * `apps/daemon/src/application-queue-store.ts`'s own header, and the same content-free discipline
 * `application-queue-types.ts` applies to the renderer bridge). Handing the daemon the checkpoint --
 * or handing it a database -- would buy one state machine at the cost of the isolation that
 * separation exists for. So the pairing is reconciled on this side of the boundary, which is where
 * both facts can be held at once, and this module is the one place that reconciliation is written.
 *
 * What was never deliberate is that the *relationship* between the two used to live nowhere.
 * `application-pipeline.ts` carried four separately-named, separately-reasoned-about constants --
 * `SETTLED_CHECKPOINTS`, `IN_FLIGHT_CHECKPOINTS`, `UNSCHEDULED_QUEUE_STATES`, and the body of
 * `queueStillWantsThis` -- each encoding one partial view of the same pairing, none of them aware
 * the others existed. Four hand-maintained lists that merely happen to agree is exactly the shape
 * that lets a state added to one be forgotten in another, and that is not hypothetical here: see
 * `user_reported`'s row below.
 *
 * So this module holds two small, orthogonal fact tables -- one row per checkpoint, one row per
 * queue state, both keyed exhaustively so that adding a value to either union is a compile error
 * here rather than a silent omission -- plus the handful of rules that combine them. Nothing here
 * reads or writes either store: a checkpoint is still written only by Electron main, a queue state
 * only by the daemon. The only thing that moved is where their relationship is stated, and the fact
 * that it can now be reviewed as a table and tested as one, pair by pair.
 */

/**
 * The daemon's queue state, as the desktop side needs it. Declared here rather than in
 * `application-pipeline.ts` because it is half of every row below; `application-pipeline.ts`
 * re-exports it so its own public surface is unchanged.
 *
 * Spelled out locally, not imported from the daemon, for the same reason `application-queue-types.ts`
 * spells it out for the renderer: this is a wire contract between two processes, and a shared import
 * would make a daemon-side refactor able to change what Electron main believes without a visible
 * edit on this side.
 */
export type ApplicationQueueEntryState = 'queued' | 'active' | 'paused' | 'cancelled' | 'done' | 'failed';

/**
 * A queue state as a *row key*, with `absent` standing in for the `null` every read can return.
 *
 * `null` is not a missing answer, it is a real and common one: the queue genuinely has no entry for
 * an attempt whose enqueue never reached the daemon, and for every attempt a caller runs directly
 * without going through the queue at all. Giving it a row rather than a special case is what makes
 * the table below total.
 */
export type ApplicationQueueStateKey = ApplicationQueueEntryState | 'absent';

function queueStateKey(state: ApplicationQueueEntryState | null): ApplicationQueueStateKey {
  return state ?? 'absent';
}

/** Every key of the queue half of the table, in a fixed order, so a test can walk all of them. */
export const APPLICATION_QUEUE_STATE_KEYS: readonly ApplicationQueueStateKey[] = [
  'absent',
  'queued',
  'active',
  'paused',
  'cancelled',
  'done',
  'failed',
];

/** Every key of the checkpoint half, in the order `ApplicationAttemptCheckpoint` declares them. */
export const APPLICATION_ATTEMPT_CHECKPOINT_KEYS: readonly ApplicationAttemptCheckpoint[] = [
  'queued',
  'reading_jd',
  'tailoring',
  'rendering',
  'filling',
  'ready',
  'submitting',
  'submitted',
  'needs_user',
  'skipped',
  'failed',
  'submission_unknown',
  'user_reported',
];

// ------------------------------------------------------------------ what a checkpoint means here

/**
 * What one checkpoint tells the preparation pipeline, as three independent yes/no facts rather than
 * one "phase" enum.
 *
 * Three booleans, not a single category, because the questions are genuinely separate and were
 * asked separately by the four constants this replaces. Keeping them separate is also what makes
 * their relationship assertable: `interruptedWhenAtRest` and `awaitsScheduling` both imply
 * `preparationMayRun` (you do not restart something you are not allowed to run), the two of them are
 * mutually exclusive, and between them the three facts partition all thirteen checkpoints into
 * exactly one of "leave it alone", "a run died under it", and "it is waiting to be scheduled".
 * `application-attempt-transitions.test.ts` pins all of that, which is a completeness check four
 * hand-written arrays could not have.
 */
export interface ApplicationCheckpointRole {
  /**
   * Whether `runApplicationAttempt` may carry an attempt sitting here forward, or must hand it back
   * untouched. False is the old `SETTLED_CHECKPOINTS`: the attempt already reached or passed review,
   * is a durable handoff to a person, or was decided.
   */
  readonly preparationMayRun: boolean;
  /**
   * Whether finding this checkpoint with nothing running proves a previous run was interrupted. True
   * only for the checkpoints a live run is the sole writer of -- the old `IN_FLIGHT_CHECKPOINTS`.
   * The browser view and generation session that run held died with it, so there is nothing to
   * resume into and the attempt starts again from the top.
   */
  readonly interruptedWhenAtRest: boolean;
  /**
   * Whether this checkpoint means the attempt is waiting for the queue to schedule it, so an attempt
   * sitting here that the queue has no live entry for is stranded and must be handed back. True only
   * for `queued`.
   */
  readonly awaitsScheduling: boolean;
}

/**
 * One row per checkpoint. `Record<ApplicationAttemptCheckpoint, ...>` on purpose: a fourteenth
 * checkpoint added to the union does not compile until it has a row here, which is the property the
 * four arrays this replaces did not have.
 */
export const APPLICATION_ATTEMPT_CHECKPOINT_ROLES: Readonly<
  Record<ApplicationAttemptCheckpoint, ApplicationCheckpointRole>
> = {
  /** Recorded and handed to the queue; the only checkpoint a run ever starts from. */
  queued: { preparationMayRun: true, interruptedWhenAtRest: false, awaitsScheduling: true },

  // The four a run in progress is the sole writer of. Each is written immediately before the slow
  // step it names, so at rest each one means that step's process is gone.
  reading_jd: { preparationMayRun: true, interruptedWhenAtRest: true, awaitsScheduling: false },
  tailoring: { preparationMayRun: true, interruptedWhenAtRest: true, awaitsScheduling: false },
  rendering: { preparationMayRun: true, interruptedWhenAtRest: true, awaitsScheduling: false },
  filling: { preparationMayRun: true, interruptedWhenAtRest: true, awaitsScheduling: false },

  /** Prepared and waiting for the person: documents staged, answers recorded. Re-running would throw
   * both away and rebuild them identically. */
  ready: { preparationMayRun: false, interruptedWhenAtRest: false, awaitsScheduling: false },

  // The submit side. None of these is preparation's to touch: a submit is either in progress, done,
  // or of unknown outcome, and re-preparing any of them risks a second real application.
  submitting: { preparationMayRun: false, interruptedWhenAtRest: false, awaitsScheduling: false },
  submitted: { preparationMayRun: false, interruptedWhenAtRest: false, awaitsScheduling: false },
  submission_unknown: { preparationMayRun: false, interruptedWhenAtRest: false, awaitsScheduling: false },

  /** A durable, deliberate handoff to a person. Never cleared by the pipeline running again -- that
   * is precisely what makes it survive a restart. */
  needs_user: { preparationMayRun: false, interruptedWhenAtRest: false, awaitsScheduling: false },

  // Decided.
  skipped: { preparationMayRun: false, interruptedWhenAtRest: false, awaitsScheduling: false },
  failed: { preparationMayRun: false, interruptedWhenAtRest: false, awaitsScheduling: false },

  /**
   * #271's "a person told this app they completed the application themselves".
   *
   * Settled for the same reason `submitted` is: the application reached the employer, so there is
   * nothing preparation could do to it now that would not be destructive -- it would re-render this
   * attempt's documents and re-fill a form for an application that is already finished.
   *
   * This row is the reason the table exists. `user_reported` was added to
   * `COMPLETED_ATTEMPT_CHECKPOINTS`, to `submitApplicationReview`'s pre-submit gate and to
   * `checkAutomaticSubmissionEligibility`, and missed `SETTLED_CHECKPOINTS` -- the one "is this
   * finished?" list that lived in a different file from the other three. Nothing broke, because
   * nothing could reach it: by the time a person can report a completion the attempt has been
   * prepared, its lease released as `completed` and its queue entry left `done`, so no tick hands it
   * back, and restart recovery only ever re-queues the rows marked `interruptedWhenAtRest` or
   * `awaitsScheduling`. Stating it correctly here changes no reachable behavior today and removes
   * the chance that a later path which *can* reach it silently re-prepares a finished application.
   */
  user_reported: { preparationMayRun: false, interruptedWhenAtRest: false, awaitsScheduling: false },
};

// ----------------------------------------------------------------- what a queue state means here

/**
 * Where a run that cannot continue must leave the attempt.
 *
 * Carrying the checkpoint *and* the sentence that goes with it, rather than just a reason code, is
 * the point: these two sentences are what a person reads on the review card, they were previously
 * duplicated at two call sites each, and "which checkpoint does a pause land on" is exactly the kind
 * of allowed-next-state fact this table is supposed to answer.
 */
export interface ApplicationAttemptHalt {
  readonly action: 'halt';
  readonly checkpoint: Extract<ApplicationAttemptCheckpoint, 'queued' | 'skipped'>;
  readonly detail: string;
}

/** What a run must do about the queue state it just re-read. */
export type ApplicationQueueDirective = { readonly action: 'continue' } | ApplicationAttemptHalt;

const CONTINUE: ApplicationQueueDirective = { action: 'continue' };

/** What one queue state tells the desktop side, in the two places it is ever asked. */
export interface ApplicationQueueStateRole {
  /**
   * What a run in progress must do when it re-reads this state between stages. The old body of
   * `queueStillWantsThis`.
   *
   * `done` and `failed` continue rather than halting, and that is deliberate rather than an
   * oversight: a run only ever sees them on a path that does not hold a lease at all (a direct
   * `runApplicationAttempt` call, or a re-run of an attempt whose earlier lease was already
   * released), where the queue's terminal state describes a finished scheduling decision and not a
   * verdict on this run. `absent` continues for the same reason, and is what lets a caller drive the
   * pipeline with a queue that has never heard of the attempt.
   */
  readonly duringRun: ApplicationQueueDirective;
  /**
   * Whether restart recovery may hand an attempt back to the queue from this state. The old
   * `UNSCHEDULED_QUEUE_STATES`, whose name undersold it: `cancelled` will never be scheduled again
   * either, and is false here anyway, because re-queuing it would undo a decision rather than
   * recover from a crash.
   */
  readonly recoveryMayReQueue: boolean;
}

/** One row per queue state, plus the `absent` row for "the queue has no entry for this attempt". */
export const APPLICATION_QUEUE_STATE_ROLES: Readonly<
  Record<ApplicationQueueStateKey, ApplicationQueueStateRole>
> = {
  /**
   * The queue never heard of this attempt. For a run, nothing to object to. For recovery, this is
   * the whole reason the second pass exists: it is what a start leaves behind when the daemon was
   * unreachable at the moment it was asked to enqueue, and the dedup rule would refuse a fresh start
   * for the same vacancy, so without a re-queue the attempt sits there forever.
   */
  absent: { duringRun: CONTINUE, recoveryMayReQueue: true },

  /** Already waiting its turn; handing it back would be a no-op on the daemon's side anyway. */
  queued: { duringRun: CONTINUE, recoveryMayReQueue: false },
  /** Leased right now. At startup this cannot be a lease from a previous process life -- the daemon
   * clears one of those itself on boot -- so it is a live one and nothing is stranded. */
  active: { duringRun: CONTINUE, recoveryMayReQueue: false },

  /**
   * A person put this on hold. The run stops and the attempt goes back to `queued`, so resuming
   * picks it up from the top with nothing half-written; recovery never re-queues it, because
   * re-queuing would undo the hold.
   */
  paused: {
    duringRun: { action: 'halt', checkpoint: 'queued', detail: 'paused; it will pick up again when you resume it' },
    recoveryMayReQueue: false,
  },

  /** Cancelled or skipped from elsewhere. The attempt is recorded as `skipped` so the decision is
   * visible on the attempt itself and not only in the daemon's queue. */
  cancelled: {
    duringRun: { action: 'halt', checkpoint: 'skipped', detail: 'this application was cancelled from the queue' },
    recoveryMayReQueue: false,
  },

  // Terminal scheduling outcomes. See `duringRun` above for why a run does not treat them as a stop
  // signal; recovery may re-queue from them because the daemon's own `enqueue` replaces a terminal
  // entry outright, which is what an attempt still sitting at `queued` after a failed cycle needs.
  done: { duringRun: CONTINUE, recoveryMayReQueue: true },
  failed: { duringRun: CONTINUE, recoveryMayReQueue: true },
};

// ------------------------------------------------------------------------ the combined verdicts

/** What `runApplicationAttempt` may do with an attempt, given both halves of its state. */
export type ApplicationAttemptTransition =
  /** Leave the attempt exactly as it is and report what it already says. */
  | { readonly action: 'already_settled' }
  | ApplicationAttemptHalt
  /** Carry it forward. The first checkpoint a preparation writes is the pipeline's own business. */
  | { readonly action: 'prepare' };

/** Reset the checkpoint and hand the attempt back to the queue: a run died under it. Carries the
 * sentence the attempt records about why, for the same reason `ApplicationAttemptHalt` does. */
export interface ApplicationAttemptRestart {
  readonly action: 'restart';
  readonly checkpoint: Extract<ApplicationAttemptCheckpoint, 'queued'>;
  readonly detail: string;
}

/** What restart recovery may do with an attempt a previous life of the app left behind. */
export type ApplicationAttemptRecovery =
  | ApplicationAttemptRestart
  /** Hand it back to the queue without touching its checkpoint: only the queue lost track of it. */
  | { readonly action: 'requeue' }
  | { readonly action: 'leave' };

/**
 * The verdict for every checkpoint whose row says a run died under it.
 *
 * A constant rather than a computed row because it genuinely does not vary: `resolveAttemptRecovery`
 * returns exactly this for an interrupted checkpoint paired with *any* of the seven queue states,
 * which is what lets `recoverInterruptedApplicationAttempts` act on an interrupted attempt without
 * spending a round trip to the daemon asking a question whose answer cannot change the outcome.
 * `application-attempt-transitions.test.ts` pins that equality across all seven pairings, so the
 * shortcut is a proven property of the table rather than an assumption at the call site.
 */
export const INTERRUPTED_ATTEMPT_RESTART: ApplicationAttemptRestart = {
  action: 'restart',
  checkpoint: 'queued',
  detail: 'the app closed while this was being prepared; it will start again from the beginning',
};

/** Whether a run must leave this checkpoint completely alone. */
export function isSettledCheckpoint(checkpoint: ApplicationAttemptCheckpoint): boolean {
  return !APPLICATION_ATTEMPT_CHECKPOINT_ROLES[checkpoint].preparationMayRun;
}

/** Whether finding this checkpoint at rest means a previous run of the app was interrupted. */
export function isInterruptedCheckpoint(checkpoint: ApplicationAttemptCheckpoint): boolean {
  return APPLICATION_ATTEMPT_CHECKPOINT_ROLES[checkpoint].interruptedWhenAtRest;
}

/** Whether this checkpoint means the attempt is waiting on the queue to schedule it. */
export function awaitsScheduling(checkpoint: ApplicationAttemptCheckpoint): boolean {
  return APPLICATION_ATTEMPT_CHECKPOINT_ROLES[checkpoint].awaitsScheduling;
}

/** What a run in progress must do about the queue state it just re-read. */
export function resolveQueueDirective(state: ApplicationQueueEntryState | null): ApplicationQueueDirective {
  return APPLICATION_QUEUE_STATE_ROLES[queueStateKey(state)].duringRun;
}

/**
 * The checkpoint-times-queue-state table itself, for a run that is about to start.
 *
 * Total over all thirteen checkpoints and all seven queue-state keys, including the pairings no
 * caller reaches today, because a table with holes in it is the thing this module exists to stop
 * being. The checkpoint half is asked first and short-circuits: a settled attempt is settled
 * whatever the queue says, which is why `runApplicationAttempt` is entitled to answer that case
 * before it spends a round trip on `entryState` at all.
 */
export function resolveAttemptTransition(
  checkpoint: ApplicationAttemptCheckpoint,
  queueState: ApplicationQueueEntryState | null,
): ApplicationAttemptTransition {
  if (isSettledCheckpoint(checkpoint)) return { action: 'already_settled' };
  const directive = resolveQueueDirective(queueState);
  return directive.action === 'halt' ? directive : { action: 'prepare' };
}

/**
 * The same table, for the different question restart recovery asks: not "may this run continue" but
 * "did a previous life of the app leave this attempt somewhere it can never leave on its own".
 *
 * An interrupted checkpoint decides on its own (see `INTERRUPTED_ATTEMPT_RESTART`). Only an attempt
 * still sitting at `queued` needs both halves, and it needs them precisely because that is the one
 * checkpoint whose meaning depends entirely on whether the daemon ever heard about it.
 */
export function resolveAttemptRecovery(
  checkpoint: ApplicationAttemptCheckpoint,
  queueState: ApplicationQueueEntryState | null,
): ApplicationAttemptRecovery {
  if (isInterruptedCheckpoint(checkpoint)) return INTERRUPTED_ATTEMPT_RESTART;
  if (!awaitsScheduling(checkpoint)) return { action: 'leave' };
  return APPLICATION_QUEUE_STATE_ROLES[queueStateKey(queueState)].recoveryMayReQueue
    ? { action: 'requeue' }
    : { action: 'leave' };
}
