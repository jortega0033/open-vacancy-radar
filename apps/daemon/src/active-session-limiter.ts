import type { ProviderId } from '@agent-dock/shared';

/**
 * Caps on how many sessions may be *actively running* at once.
 *
 * These are not throughput tuning knobs. Each active session is a provider CLI process spawned into
 * the user's own working directory, holding a model context and doing real work; four of them at
 * once on a single-user desktop machine is already more than any reviewed workflow here needs, and
 * an unbounded number is how one runaway caller turns a local daemon into a fork bomb with the
 * user's credentials. The per-provider cap exists on top of the global one so a single provider's
 * rate limits and cost budget cannot be exhausted by a client that only ever talks to one CLI.
 */
export const ACTIVE_SESSION_LIMITS = Object.freeze({ global: 4, perProvider: 2 } as const);

export type ActiveSessionLimitScope = 'global' | 'provider';

export interface ActiveSessionCapacity {
  readonly global: { active: number; limit: number };
  readonly provider: { active: number; limit: number };
}

/**
 * Thrown by `reserve()` when a session cannot be admitted. Carries the capacity snapshot as it was
 * at the moment of refusal so the HTTP layer can render a 409 body without a second, racy read.
 */
export class ActiveSessionLimitError extends Error {
  readonly code = 'active_session_limit' as const;
  readonly statusCode = 409 as const;

  constructor(
    readonly scope: ActiveSessionLimitScope,
    readonly provider: ProviderId,
    readonly capacity: ActiveSessionCapacity,
  ) {
    super('too many active sessions');
    this.name = 'ActiveSessionLimitError';
  }
}

/**
 * The admission gate for new sessions.
 *
 * ## Why this is safe against concurrent requests
 *
 * Node runs one JavaScript thread. A function that contains no `await` and calls nothing that can
 * re-enter this instance therefore executes as an *indivisible* unit with respect to every other
 * request: no other handler can observe or mutate the counters between the check and the
 * increment. `reserve()` is written that way on purpose, and `SessionManager.create()` is written
 * to call it before its own first `await` for the same reason (the route's `await
 * providerImpl.detect()` happens *before* `create()` is entered, so the suspension point is on the
 * far side of the reservation).
 *
 * Break either property -- add an `await` here, make `create()` await something before reserving,
 * or have a hook re-enter this object mid-`reserve` -- and five concurrent requests can each read
 * "3 active" and all five proceed. `apps/daemon/test/active-session-limiter.test.ts` pins the
 * synchronous property structurally (the function is not an `AsyncFunction` and its source text
 * contains no `await`), and `apps/daemon/test/server.limits.test.ts` pins the behavior by firing
 * genuinely concurrent HTTP requests through a provider parked on a deferred.
 *
 * ## Why there is no `releaseAll()`
 *
 * There is deliberately no bulk-release method. A hold is released exactly where the session it
 * belongs to reaches a terminal state -- `SessionManager.consume()`'s `finally` -- and that single
 * site covers completion, failure, cancellation, a throwing generator, and stream abandonment
 * alike. A `releaseAll()` would be reached for only one caller (daemon shutdown), where it is
 * useless: the process is about to exit and take the whole map with it. Its real effect would be
 * offering a shortcut that lets a future caller zero the counters while sessions are still running,
 * which is precisely the state this class exists to make unrepresentable.
 */
export class ActiveSessionLimiter {
  /** sessionId -> provider. `size` **is** the global active count: no second counter to desync. */
  readonly #held = new Map<string, ProviderId>();
  readonly #perProvider = new Map<ProviderId, number>();

  /**
   * Admits one session, or throws `ActiveSessionLimitError`.
   *
   * MUST stay synchronous and `await`-free: see the class docstring. State is mutated only after
   * *both* checks pass, so a per-provider refusal never leaves the global counter incremented.
   */
  reserve(provider: ProviderId, sessionId: string): void {
    if (this.#held.has(sessionId)) {
      throw new Error(`session ${sessionId} already holds an active-session reservation`);
    }

    const globalActive = this.#held.size;
    const providerActive = this.#perProvider.get(provider) ?? 0;

    // Global first, then per-provider. The order is what determines which `scope` a caller is told
    // about when both are full, and "the machine is busy" is the more actionable answer than
    // "this provider is busy" -- switching providers would not help.
    if (globalActive >= ACTIVE_SESSION_LIMITS.global) {
      throw new ActiveSessionLimitError('global', provider, this.#capacity(globalActive, providerActive));
    }
    if (providerActive >= ACTIVE_SESSION_LIMITS.perProvider) {
      throw new ActiveSessionLimitError('provider', provider, this.#capacity(globalActive, providerActive));
    }

    this.#held.set(sessionId, provider);
    this.#perProvider.set(provider, providerActive + 1);
  }

  /**
   * Releases a hold. Idempotent: returns `false` for an id that never held one or was already
   * released, so the single release site in `consume()`'s `finally` can run unconditionally without
   * the caller tracking whether it already ran.
   *
   * An internal underflow (a hold recorded globally but with a zero per-provider count) throws
   * rather than clamping: that state is unreachable through this class's own API, so reaching it
   * means an invariant is already broken and quietly repairing the counter would hide it.
   */
  release(sessionId: string): boolean {
    const provider = this.#held.get(sessionId);
    if (provider === undefined) return false;

    this.#held.delete(sessionId);
    const providerActive = this.#perProvider.get(provider) ?? 0;
    if (providerActive <= 0) {
      throw new Error(`active-session accounting underflow releasing ${sessionId} for provider ${provider}`);
    }
    if (providerActive === 1) this.#perProvider.delete(provider);
    else this.#perProvider.set(provider, providerActive - 1);
    return true;
  }

  holds(sessionId: string): boolean {
    return this.#held.has(sessionId);
  }

  capacityFor(provider: ProviderId): ActiveSessionCapacity {
    return this.#capacity(this.#held.size, this.#perProvider.get(provider) ?? 0);
  }

  snapshot(): { global: number; byProvider: Record<string, number> } {
    return {
      global: this.#held.size,
      byProvider: Object.fromEntries(this.#perProvider.entries()),
    };
  }

  #capacity(globalActive: number, providerActive: number): ActiveSessionCapacity {
    return {
      global: { active: globalActive, limit: ACTIVE_SESSION_LIMITS.global },
      provider: { active: providerActive, limit: ACTIVE_SESSION_LIMITS.perProvider },
    };
  }
}
