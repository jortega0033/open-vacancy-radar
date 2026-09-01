/**
 * The monotonic "did the provider accept the user's work?" safety state.
 *
 * This is the single fact every retry, fallback, and cancellation decision in the supervisor is
 * built on, so it is modelled as a lattice with an explicit join rather than as a mutable boolean
 * somebody can flip back. See docs/adr-agentdock-v2-provenance.md for why this lives in memory
 * only today (a daemon crash loses it; persisting it is ADI-05's job).
 */

/**
 * - `'not_accepted'` — provably nothing was delivered. Retrying is safe.
 * - `'unknown'` — we cannot prove work was *not* delivered. Retrying is NOT safe.
 * - `'accepted'` — we observed delivery. Retrying is NOT safe.
 */
export type AcceptedWorkState = 'not_accepted' | 'accepted' | 'unknown';

/**
 * The lattice order. `unknown` ranks **above** `not_accepted`, which is the whole point of this
 * table and the easiest thing to get backwards.
 *
 * The naive reading is that `unknown` means "less than accepted", so it should sort below
 * `not_accepted` as a kind of null. That is exactly wrong for a safety state. The question this
 * value answers is not "how much do we know?" but "is it safe to do the work again?", and for
 * that question `unknown` and `accepted` give the same answer: no. Only `not_accepted` is a
 * positive proof of safety, so only `not_accepted` may sit at the bottom.
 *
 * Ranking `unknown` at the bottom would mean an observation of "we could not determine what
 * happened" *downgrades* a session back into "safe to retry", which is the precise bug this
 * ordering exists to make unrepresentable.
 */
export const ACCEPTED_WORK_RANK: Readonly<Record<AcceptedWorkState, 0 | 1 | 2>> = Object.freeze({
  not_accepted: 0,
  unknown: 1,
  accepted: 2,
});

/**
 * A one-way ratchet over `AcceptedWorkState`.
 *
 * `observe` is a monotone join: it can only ever move the state up the lattice, so no ordering of
 * observations — including out-of-order or duplicated ones from racing callbacks — can produce a
 * less-safe answer than the observations collectively justify. This matters because the
 * observations genuinely do race: a spawn callback, a stdin-flush callback, and a first-event
 * callback all run on different turns of the event loop with no guaranteed order between them.
 *
 * `accepted` settles the first time the state leaves `'not_accepted'`, so a caller can await
 * "the moment this session stopped being safe to retry" without polling. It never rejects, and it
 * simply never settles for a session that never accepted work — callers must always race it
 * against `settled` rather than awaiting it alone.
 */
export class AcceptedWorkLatch {
  private current: AcceptedWorkState = 'not_accepted';
  private settle!: (state: AcceptedWorkState) => void;

  /** Settles once, the first time the state leaves `'not_accepted'`. Never rejects. */
  readonly accepted: Promise<AcceptedWorkState>;

  constructor() {
    this.accepted = new Promise<AcceptedWorkState>((resolve) => {
      this.settle = resolve;
    });
  }

  get state(): AcceptedWorkState {
    return this.current;
  }

  /**
   * Joins `next` into the current state and returns the resulting state (not `next`), so a caller
   * that observes a weaker state than one already recorded sees the real, stronger answer rather
   * than believing its own observation won.
   */
  observe(next: AcceptedWorkState): AcceptedWorkState {
    if (ACCEPTED_WORK_RANK[next] > ACCEPTED_WORK_RANK[this.current]) {
      const wasNotAccepted = this.current === 'not_accepted';
      this.current = next;
      // Only the first departure from 'not_accepted' settles the promise. A later
      // 'unknown' -> 'accepted' upgrade is a real state change but not a new "work is now at
      // risk" edge, and resolving an already-resolved promise would be silently ignored anyway;
      // the guard makes that intent explicit rather than accidental.
      if (wasNotAccepted) this.settle(this.current);
    }
    return this.current;
  }
}
