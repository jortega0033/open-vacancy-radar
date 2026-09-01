import type { AcceptedWorkState } from './accepted-work.js';
import { launchScopesEqual, type FrozenLaunchScope } from './launch-scope.js';

/**
 * What we know about whether the *transport* handed the prompt to the provider, as distinct from
 * whether the provider *accepted work* (`AcceptedWorkState`). The two can disagree: a transport
 * can confirm delivery of bytes that the provider then rejected, and a transport can be unsure
 * about bytes the provider demonstrably acted on.
 */
export type ProviderDeliveryState = 'not_delivered' | 'ambiguous' | 'delivered';

/**
 * A failure raised while a transport was starting up, carrying the two facts a fallback decision
 * needs and that a bare `Error` throws away: a stable reason code for logging/telemetry, and what
 * the failure implies about delivery.
 *
 * `deliveryState` is not derivable from the message. "connection refused" means nothing was
 * delivered; "wrote the prompt, then the socket died" means delivery is ambiguous. Only the code
 * that raised the error knows which, so it must say so at the throw site.
 */
export class ProviderTransportStartupError extends Error {
  constructor(
    readonly reasonCode: string,
    readonly deliveryState: ProviderDeliveryState,
    message: string,
  ) {
    super(message);
    this.name = 'ProviderTransportStartupError';
  }
}

export type FallbackDeniedReason =
  | 'no_alternate_transport'
  | 'work_accepted'
  | 'work_acceptance_unknown'
  | 'delivery_ambiguous'
  | 'delivery_confirmed'
  | 'fallback_already_consumed'
  | 'scope_mismatch'
  | 'session_terminal';

/**
 * `attempt` is typed as the literal `1`, not `number`: this gate authorizes at most one fallback
 * per session, ever, and encoding that in the type means a caller cannot construct or propagate a
 * "second attempt" decision even by mistake.
 */
export type FallbackDecision =
  | { allowed: true; attempt: 1; scope: FrozenLaunchScope }
  | { allowed: false; reason: FallbackDeniedReason };

export interface FallbackAuthorizeInput {
  candidate: FrozenLaunchScope;
  acceptedWork: AcceptedWorkState;
  delivery: ProviderDeliveryState;
  /** Transport ids other than the primary that this session could be restarted on. */
  alternateTransportIds: readonly string[];
  /** True once the session has reached a terminal state and can no longer be restarted at all. */
  terminal: boolean;
}

/**
 * Decides whether a session may be restarted on a different transport after its primary transport
 * failed to start, and refuses in every case where doing so could duplicate a side effect the user
 * has already paid for.
 *
 * ## This gate is always-deny in the configuration this repo ships
 *
 * Check (1) below denies whenever `alternateTransportIds` is empty, and nothing anywhere in this
 * repo registers a second transport: `providers/compatibility-manifest.ts` defines exactly one
 * transport id, and both adapters use it. So `authorize()` returns
 * `{ allowed: false, reason: 'no_alternate_transport' }` for *every* reachable input today. That
 * is a deliberate shipped invariant, not an accident of the current call sites, and
 * `test/fallback-gate.test.ts` pins it by exhausting the full
 * `AcceptedWorkState x ProviderDeliveryState x terminal` product against an empty alternate list.
 *
 * The rest of the logic is written and tested anyway so that the ticket which introduces a second
 * transport turns the gate on against already-reviewed rules, rather than writing safety logic
 * under the pressure of a feature deadline.
 */
export class FallbackGate {
  /** Not a boolean: counting makes "consume called twice" detectable rather than idempotent. */
  private consumed = 0;

  constructor(private readonly primary: FrozenLaunchScope) {}

  /**
   * The check order below is load-bearing and must not be reordered for readability.
   *
   * A denial reason is a diagnostic that operators and tests reason about, so it has to be a
   * deterministic function of the input rather than "whichever failing condition happened to be
   * checked first this time". Each check short-circuits before the next, which means the reason
   * returned is always the *first* applicable one in this fixed order:
   *
   *   1. `no_alternate_transport` — structural: there is nowhere to fall back to, so nothing else
   *      about this session is even relevant. Checked first so the shipped always-deny path
   *      reports the actual reason (no second transport exists) rather than incidentally reporting
   *      a work/delivery state that only looks like the cause.
   *   2. `session_terminal` — lifecycle: a finished session cannot be restarted regardless of how
   *      safe a restart would have been.
   *   3. `fallback_already_consumed` — the one-shot budget. Checked before the safety conditions
   *      so a second attempt is refused as replay, not re-litigated on its (possibly still-clean)
   *      work and delivery state.
   *   4. delivery state — the transport's own evidence. Checked before accepted-work because it
   *      is the more primitive fact: bytes on the wire are observed directly, whereas acceptance
   *      is inferred from a boundary model.
   *   5. accepted-work state — the inferred safety conclusion.
   *   6. `scope_mismatch` — checked last and never skipped: even a session that is provably safe
   *      to retry may only be retried into the *same* launch context.
   */
  authorize(input: FallbackAuthorizeInput): FallbackDecision {
    if (input.alternateTransportIds.length === 0) {
      return { allowed: false, reason: 'no_alternate_transport' };
    }
    if (input.terminal) {
      return { allowed: false, reason: 'session_terminal' };
    }
    if (this.consumed !== 0) {
      return { allowed: false, reason: 'fallback_already_consumed' };
    }
    if (input.delivery !== 'not_delivered') {
      return {
        allowed: false,
        reason: input.delivery === 'ambiguous' ? 'delivery_ambiguous' : 'delivery_confirmed',
      };
    }
    if (input.acceptedWork !== 'not_accepted') {
      return {
        allowed: false,
        reason: input.acceptedWork === 'accepted' ? 'work_accepted' : 'work_acceptance_unknown',
      };
    }
    if (!launchScopesEqual(this.primary, input.candidate)) {
      return { allowed: false, reason: 'scope_mismatch' };
    }
    return { allowed: true, attempt: 1, scope: input.candidate };
  }

  /**
   * Spends the single fallback budget. Throws rather than no-ops on a second call: a caller
   * consuming twice has lost track of its own state machine, and silently absorbing that would
   * hide precisely the bug this class exists to prevent. `authorize` reports the same condition
   * as a denial rather than a throw, so the throw only ever fires on a caller that ignored a
   * denial and consumed anyway.
   */
  consume(): void {
    if (this.consumed !== 0) {
      throw new Error('fallback budget already consumed for this session');
    }
    this.consumed += 1;
  }
}
