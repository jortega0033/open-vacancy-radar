import { describe, expect, it } from 'vitest';
import {
  APPLICATION_ATTEMPT_CHECKPOINT_KEYS,
  APPLICATION_ATTEMPT_CHECKPOINT_ROLES,
  APPLICATION_QUEUE_STATE_KEYS,
  APPLICATION_QUEUE_STATE_ROLES,
  INTERRUPTED_ATTEMPT_RESTART,
  awaitsScheduling,
  isInterruptedCheckpoint,
  isSettledCheckpoint,
  resolveAttemptRecovery,
  resolveAttemptTransition,
  resolveQueueDirective,
  type ApplicationQueueEntryState,
} from '../electron/application-attempt-transitions.js';
import type { ApplicationAttemptCheckpoint } from '../electron/workspace/types.js';

/**
 * Pins the completeness and consistency properties `application-attempt-transitions.ts`'s own doc
 * comments claim the table has -- the ones four separately hand-maintained arrays could not prove
 * about themselves, and the reason `user_reported` fell out of `SETTLED_CHECKPOINTS` unnoticed before
 * this module existed. If a future checkpoint or queue state is added without a row here, the
 * exhaustive `Record` types make that a compile error on their own; the tests below are about the
 * *relationships* between rows, which the type system cannot check for us.
 */

describe('APPLICATION_ATTEMPT_CHECKPOINT_ROLES', () => {
  it('has exactly one row per checkpoint, matching the declared key order', () => {
    expect(Object.keys(APPLICATION_ATTEMPT_CHECKPOINT_ROLES).sort()).toEqual([...APPLICATION_ATTEMPT_CHECKPOINT_KEYS].sort());
  });

  it('interruptedWhenAtRest and awaitsScheduling both imply preparationMayRun', () => {
    for (const checkpoint of APPLICATION_ATTEMPT_CHECKPOINT_KEYS) {
      const role = APPLICATION_ATTEMPT_CHECKPOINT_ROLES[checkpoint];
      if (role.interruptedWhenAtRest || role.awaitsScheduling) {
        expect(role.preparationMayRun, `${checkpoint}: interrupted/awaiting but not preparationMayRun`).toBe(true);
      }
    }
  });

  it('interruptedWhenAtRest and awaitsScheduling are mutually exclusive', () => {
    for (const checkpoint of APPLICATION_ATTEMPT_CHECKPOINT_KEYS) {
      const role = APPLICATION_ATTEMPT_CHECKPOINT_ROLES[checkpoint];
      expect(role.interruptedWhenAtRest && role.awaitsScheduling, `${checkpoint}: both true`).toBe(false);
    }
  });

  it('the three facts partition every checkpoint into exactly one of: settled, interrupted, awaiting scheduling', () => {
    for (const checkpoint of APPLICATION_ATTEMPT_CHECKPOINT_KEYS) {
      const role = APPLICATION_ATTEMPT_CHECKPOINT_ROLES[checkpoint];
      const buckets = [!role.preparationMayRun, role.interruptedWhenAtRest, role.awaitsScheduling].filter(Boolean);
      expect(buckets, `${checkpoint}: expected exactly one bucket, got ${buckets.length}`).toHaveLength(1);
    }
  });

  it('awaitsScheduling is true only for queued', () => {
    for (const checkpoint of APPLICATION_ATTEMPT_CHECKPOINT_KEYS) {
      expect(awaitsScheduling(checkpoint)).toBe(checkpoint === 'queued');
    }
  });

  it('the four in-flight checkpoints, and only those, are interruptedWhenAtRest', () => {
    const interrupted = APPLICATION_ATTEMPT_CHECKPOINT_KEYS.filter((c) => isInterruptedCheckpoint(c));
    expect(interrupted.sort()).toEqual(['filling', 'reading_jd', 'rendering', 'tailoring'].sort());
  });

  it('user_reported is settled -- the exact gap the old four-array approach missed', () => {
    expect(isSettledCheckpoint('user_reported')).toBe(true);
  });

  it('submitted, submission_unknown, needs_user, skipped, failed and ready are all settled', () => {
    for (const checkpoint of ['submitted', 'submission_unknown', 'needs_user', 'skipped', 'failed', 'ready'] as const) {
      expect(isSettledCheckpoint(checkpoint), checkpoint).toBe(true);
    }
  });

  it('submitting is settled: preparation must never touch the submit half', () => {
    expect(isSettledCheckpoint('submitting')).toBe(true);
  });
});

describe('APPLICATION_QUEUE_STATE_ROLES', () => {
  it('has exactly one row per queue-state key, including absent', () => {
    expect(Object.keys(APPLICATION_QUEUE_STATE_ROLES).sort()).toEqual([...APPLICATION_QUEUE_STATE_KEYS].sort());
  });

  it('done, failed and absent continue during a run rather than halting it', () => {
    for (const state of [null, 'done', 'failed'] as const) {
      expect(resolveQueueDirective(state as ApplicationQueueEntryState | null)).toEqual({ action: 'continue' });
    }
  });

  it('paused halts a run back to queued, with a person-readable reason', () => {
    expect(resolveQueueDirective('paused')).toMatchObject({ action: 'halt', checkpoint: 'queued' });
  });

  it('cancelled halts a run to skipped, with a person-readable reason', () => {
    expect(resolveQueueDirective('cancelled')).toMatchObject({ action: 'halt', checkpoint: 'skipped' });
  });

  it('recoveryMayReQueue is true only for absent, done and failed -- never a live or held state', () => {
    const mayRequeue = APPLICATION_QUEUE_STATE_KEYS.filter((key) => APPLICATION_QUEUE_STATE_ROLES[key].recoveryMayReQueue);
    expect(mayRequeue.sort()).toEqual(['absent', 'done', 'failed'].sort());
  });
});

describe('resolveAttemptTransition', () => {
  it('short-circuits to already_settled for every settled checkpoint, whatever the queue says', () => {
    const settled = APPLICATION_ATTEMPT_CHECKPOINT_KEYS.filter((c) => isSettledCheckpoint(c));
    for (const checkpoint of settled) {
      for (const state of [...APPLICATION_QUEUE_STATE_KEYS.map((k) => (k === 'absent' ? null : k))] as (ApplicationQueueEntryState | null)[]) {
        expect(resolveAttemptTransition(checkpoint, state), `${checkpoint}/${state}`).toEqual({ action: 'already_settled' });
      }
    }
  });

  it('a non-settled checkpoint with an unheld queue state may prepare', () => {
    expect(resolveAttemptTransition('reading_jd', null)).toEqual({ action: 'prepare' });
    expect(resolveAttemptTransition('queued', 'queued')).toEqual({ action: 'prepare' });
  });

  it('a non-settled checkpoint whose queue entry was paused halts back to queued', () => {
    expect(resolveAttemptTransition('tailoring', 'paused')).toMatchObject({ action: 'halt', checkpoint: 'queued' });
  });

  it('a non-settled checkpoint whose queue entry was cancelled halts to skipped', () => {
    expect(resolveAttemptTransition('rendering', 'cancelled')).toMatchObject({ action: 'halt', checkpoint: 'skipped' });
  });
});

describe('resolveAttemptRecovery', () => {
  /**
   * The specific property `application-attempt-transitions.ts`'s own doc comment on
   * `INTERRUPTED_ATTEMPT_RESTART` claims: the verdict for an interrupted checkpoint does not vary
   * with the queue state at all. `recoverInterruptedApplicationAttempts` relies on this to act
   * without spending a round trip to the daemon for these rows -- this test is what makes that
   * shortcut a proven property of the table instead of an assumption at the call site.
   */
  it('every interrupted checkpoint restarts identically regardless of queue state', () => {
    const interrupted = APPLICATION_ATTEMPT_CHECKPOINT_KEYS.filter((c) => isInterruptedCheckpoint(c));
    const allStates: (ApplicationQueueEntryState | null)[] = [null, 'queued', 'active', 'paused', 'cancelled', 'done', 'failed'];
    for (const checkpoint of interrupted) {
      for (const state of allStates) {
        expect(resolveAttemptRecovery(checkpoint, state), `${checkpoint}/${state}`).toEqual(INTERRUPTED_ATTEMPT_RESTART);
      }
    }
  });

  it('a queued attempt the queue has no entry for (absent) may be re-queued', () => {
    expect(resolveAttemptRecovery('queued', null)).toEqual({ action: 'requeue' });
  });

  it('a queued attempt whose queue entry is done or failed may be re-queued', () => {
    expect(resolveAttemptRecovery('queued', 'done')).toEqual({ action: 'requeue' });
    expect(resolveAttemptRecovery('queued', 'failed')).toEqual({ action: 'requeue' });
  });

  it('a queued attempt already live in the queue (queued/active/paused/cancelled) is left alone', () => {
    for (const state of ['queued', 'active', 'paused', 'cancelled'] as const) {
      expect(resolveAttemptRecovery('queued', state), state).toEqual({ action: 'leave' });
    }
  });

  it('a non-interrupted, non-queued checkpoint is always left alone regardless of queue state', () => {
    const other = APPLICATION_ATTEMPT_CHECKPOINT_KEYS.filter(
      (c) => !isInterruptedCheckpoint(c) && c !== ('queued' as ApplicationAttemptCheckpoint),
    );
    for (const checkpoint of other) {
      expect(resolveAttemptRecovery(checkpoint, null), checkpoint).toEqual({ action: 'leave' });
    }
  });
});
