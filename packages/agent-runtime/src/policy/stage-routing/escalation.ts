/**
 * What to do when a stage's answer does not validate (issue #284, acceptance check 3).
 *
 * The rule this file exists to enforce is narrow and worth stating plainly: **a missing fact is
 * never answered by a bigger model.** Escalating on a missing fact pays more money to make the same
 * unanswerable question sound more confident, and the thing it produces is an invention the
 * candidate then sends to an employer. A missing fact goes to a deterministic lookup if the stage
 * has one, and to the user if it does not.
 *
 * Escalation *is* allowed for one failure kind -- an answer that was grounded badly rather than
 * grounded incompletely -- and even then only once, only to a tier the caller confirms is actually
 * available, and only within the stage contract's own attempt ceiling. Everything else retries at
 * most once on the same model or hands off.
 *
 * This planner is pure: it decides, it does not run anything, and it holds no timers, budgets or
 * provider handles. The caller does the work and comes back with the next failure, which is what
 * makes "bounded" checkable -- the attempt counter is an input, so a caller cannot loop without the
 * planner seeing the count rise.
 */
import { stageContract, type GenerationStage, type ModelTier } from './stages.js';

/**
 * Why an attempt did not produce a usable answer.
 *
 * - `schema_invalid` -- the answer did not parse into the stage's shape at all (a field map that is
 *   not a `FieldMap`, a CV parse that is not the profile object). Cheap to retry: the model had the
 *   information and formatted it wrongly.
 * - `grounding_unverified` -- the answer parsed, but a reconciliation step could not match its
 *   content back to the reviewed source (`reconcileTailoredResumeWithSource`, #274). The model had
 *   the information and used it wrongly.
 * - `missing_fact` -- the answer is incomplete because a fact it needs is not in the inputs at all.
 *   No model has this information. This is the one that must never escalate.
 * - `transport_error` -- the session failed before producing an answer (a dropped stream, a killed
 *   CLI). Says nothing about the model, so it retries on the same one.
 */
export type StageFailureKind = 'schema_invalid' | 'grounding_unverified' | 'missing_fact' | 'transport_error';

export type HandoffReason =
  | 'attempt_budget_exhausted'
  | 'schema_unrecoverable'
  | 'grounding_unrecoverable'
  | 'no_capable_tier_available'
  | 'missing_facts_need_the_candidate';

export type EscalationPlan =
  | { readonly action: 'retry_same_model'; readonly attempt: number; readonly failure: StageFailureKind }
  | {
      readonly action: 'escalate_tier';
      readonly attempt: number;
      readonly toTier: ModelTier;
      readonly failure: StageFailureKind;
    }
  | {
      readonly action: 'retrieve_missing_facts';
      /** The specific facts to look up, echoed back so a caller cannot start an open-ended search. */
      readonly missing: readonly string[];
    }
  | { readonly action: 'hand_off_to_user'; readonly reason: HandoffReason; readonly missing?: readonly string[] };

export interface EscalationState {
  readonly stage: GenerationStage;
  /** Attempts already made at this unit of work, including the one that just failed. */
  readonly attemptsMade: number;
  /** The tier the failed attempt ran on. */
  readonly currentTier: ModelTier;
  /** Whether a capable-tier pairing is eligible for this stage *right now* -- the caller answers
   * this from a fresh `routeStage` over today's candidates, never from an assumption. */
  readonly capableTierAvailable: boolean;
  /** Whether a deterministic retrieval has already run for this unit of work. One is the budget:
   * a second lookup of the same missing facts against the same source returns the same nothing. */
  readonly retrievalAttempted: boolean;
}

export interface StageFailure {
  readonly kind: StageFailureKind;
  /**
   * For `missing_fact`, the specific facts the answer needed and could not find. Required in
   * practice for that kind: a handoff that cannot tell the candidate *what* is missing is not a
   * handoff, it is a dead end, and a retrieval with no list of what to retrieve is a search.
   */
  readonly missing?: readonly string[];
}

/**
 * The next bounded step after a failed attempt.
 *
 * The attempt ceiling is checked first, before the failure kind, so no combination of failures can
 * outlast `StageContract.maxAttempts`. A caller that ignores the plan and retries anyway will be
 * told `attempt_budget_exhausted` on the next call regardless of what changed, which is the
 * property that makes this bounded rather than merely conventional.
 */
export function planNextAttempt(state: EscalationState, failure: StageFailure): EscalationPlan {
  const contract = stageContract(state.stage);

  // A missing fact is resolved before the attempt budget is even consulted, because neither of its
  // outcomes spends a model attempt: a deterministic lookup is not a generation, and a handoff ends
  // the run. Ordering it after the budget check would turn "we need one fact from you" into
  // "attempt budget exhausted", which tells the candidate nothing they can act on.
  if (failure.kind === 'missing_fact') {
    const missing = failure.missing ?? [];
    if (contract.retrievalAvailable && !state.retrievalAttempted && missing.length > 0) {
      return { action: 'retrieve_missing_facts', missing };
    }
    return {
      action: 'hand_off_to_user',
      reason: 'missing_facts_need_the_candidate',
      ...(missing.length > 0 ? { missing } : {}),
    };
  }

  if (state.attemptsMade >= contract.maxAttempts) {
    return { action: 'hand_off_to_user', reason: 'attempt_budget_exhausted' };
  }
  const nextAttempt = state.attemptsMade + 1;

  switch (failure.kind) {
    case 'schema_invalid':
      // The same model, once. A tier change cannot fix a formatting failure that the stage's own
      // schema will judge identically, and paying more for the same judgement is the definition of
      // expensive guessing.
      return { action: 'retry_same_model', attempt: nextAttempt, failure: failure.kind };
    case 'grounding_unverified':
      if (state.currentTier === 'capable') {
        return { action: 'hand_off_to_user', reason: 'grounding_unrecoverable' };
      }
      if (!state.capableTierAvailable) {
        return { action: 'hand_off_to_user', reason: 'no_capable_tier_available' };
      }
      return { action: 'escalate_tier', attempt: nextAttempt, toTier: 'capable', failure: failure.kind };
    case 'transport_error':
      return { action: 'retry_same_model', attempt: nextAttempt, failure: failure.kind };
    default: {
      // Exhaustiveness, in the same shape `resolveCapability` uses in apps/daemon: a new failure
      // kind added without a branch here fails the build rather than silently falling through to a
      // retry it was never reviewed for.
      const unhandled: never = failure.kind;
      void unhandled;
      return { action: 'hand_off_to_user', reason: 'schema_unrecoverable' };
    }
  }
}
