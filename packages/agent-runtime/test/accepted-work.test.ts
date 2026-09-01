import { describe, expect, it } from 'vitest';
import {
  ACCEPTED_WORK_RANK,
  AcceptedWorkLatch,
  type AcceptedWorkState,
} from '../src/providers/common/accepted-work.js';

const ALL_STATES: readonly AcceptedWorkState[] = ['not_accepted', 'unknown', 'accepted'];

describe('ACCEPTED_WORK_RANK', () => {
  it('ranks unknown above not_accepted, so "we cannot tell" never reads as "safe to retry"', () => {
    expect(ACCEPTED_WORK_RANK.unknown).toBeGreaterThan(ACCEPTED_WORK_RANK.not_accepted);
    expect(ACCEPTED_WORK_RANK.accepted).toBeGreaterThan(ACCEPTED_WORK_RANK.unknown);
  });

  it('is frozen, so no caller can retune the safety ordering at runtime', () => {
    expect(Object.isFrozen(ACCEPTED_WORK_RANK)).toBe(true);
  });
});

describe('AcceptedWorkLatch', () => {
  it('starts not_accepted', () => {
    expect(new AcceptedWorkLatch().state).toBe('not_accepted');
  });

  /**
   * The exhaustive monotonicity proof: all 9 ordered pairs of states. This is the property the
   * whole safety model rests on — no sequence of observations, in any order, may ever lower the
   * recorded rank — so it is checked by enumeration rather than by a few representative cases.
   */
  describe.each(ALL_STATES)('after observe(%s)', (first) => {
    it.each(ALL_STATES)('observe(%s) never decreases rank', (second) => {
      const latch = new AcceptedWorkLatch();
      latch.observe(first);
      const rankAfterFirst = ACCEPTED_WORK_RANK[latch.state];

      const returned = latch.observe(second);

      expect(ACCEPTED_WORK_RANK[latch.state]).toBeGreaterThanOrEqual(rankAfterFirst);
      // The join result, not the argument: a caller observing a weaker state must be told the
      // real (stronger) answer rather than believing its own observation won.
      expect(returned).toBe(latch.state);
      expect(ACCEPTED_WORK_RANK[latch.state]).toBe(
        Math.max(ACCEPTED_WORK_RANK[first], ACCEPTED_WORK_RANK[second]),
      );
    });
  });

  it('is idempotent under repeated identical observations', () => {
    const latch = new AcceptedWorkLatch();
    latch.observe('unknown');
    latch.observe('unknown');
    latch.observe('unknown');
    expect(latch.state).toBe('unknown');
  });

  it('settles `accepted` the first time the state leaves not_accepted, carrying that state', async () => {
    const latch = new AcceptedWorkLatch();
    latch.observe('unknown');
    await expect(latch.accepted).resolves.toBe('unknown');
  });

  it('keeps the settled value from the first departure even after a later upgrade', async () => {
    const latch = new AcceptedWorkLatch();
    latch.observe('unknown');
    latch.observe('accepted');
    // The promise marks the *edge* at which work stopped being provably undelivered, which is a
    // one-time event; `state` is what reports the current, upgraded value.
    await expect(latch.accepted).resolves.toBe('unknown');
    expect(latch.state).toBe('accepted');
  });

  it('never settles `accepted` for a session that only ever observed not_accepted', async () => {
    const latch = new AcceptedWorkLatch();
    latch.observe('not_accepted');
    const sentinel = Symbol('pending');
    const raced = await Promise.race([
      latch.accepted,
      new Promise((resolve) => setTimeout(() => resolve(sentinel), 25)),
    ]);
    expect(raced).toBe(sentinel);
  });
});
