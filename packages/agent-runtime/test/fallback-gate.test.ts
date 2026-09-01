import { describe, expect, it } from 'vitest';
import type { ProviderStatus } from '@agent-dock/shared';
import type { AcceptedWorkState } from '../src/providers/common/accepted-work.js';
import {
  FallbackGate,
  ProviderTransportStartupError,
  type FallbackAuthorizeInput,
  type ProviderDeliveryState,
} from '../src/providers/common/fallback-gate.js';
import { freezeLaunchScope, type FrozenLaunchScope } from '../src/providers/common/launch-scope.js';
import { LEGACY_ONE_SHOT_TRANSPORT_ID } from '../src/providers/compatibility-manifest.js';
import type { StartSessionOptions } from '../src/types.js';

const status: ProviderStatus = {
  id: 'claude',
  name: 'Claude Code',
  installed: true,
  authenticated: 'authenticated',
  capabilities: {},
  executablePath: '/usr/local/bin/claude',
  version: '2.1.228',
};
const start: StartSessionOptions = { sessionId: 'gate-session', cwd: '/workspace', prompt: 'hi' };

function primaryScope(): FrozenLaunchScope {
  return freezeLaunchScope(status, start, LEGACY_ONE_SHOT_TRANSPORT_ID);
}

/** The one input shape that passes every check, used as the base for single-condition variations. */
function allowableInput(): FallbackAuthorizeInput {
  return {
    candidate: primaryScope(),
    acceptedWork: 'not_accepted',
    delivery: 'not_delivered',
    alternateTransportIds: ['some-future-transport'],
    terminal: false,
  };
}

const ACCEPTED_WORK_STATES: readonly AcceptedWorkState[] = ['not_accepted', 'unknown', 'accepted'];
const DELIVERY_STATES: readonly ProviderDeliveryState[] = ['not_delivered', 'ambiguous', 'delivered'];

describe('ProviderTransportStartupError', () => {
  it('carries a reason code and a delivery state that a bare Error would lose', () => {
    const error = new ProviderTransportStartupError('socket_closed', 'ambiguous', 'connection died');
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe('ProviderTransportStartupError');
    expect(error.reasonCode).toBe('socket_closed');
    expect(error.deliveryState).toBe('ambiguous');
    expect(error.message).toBe('connection died');
  });
});

/**
 * The criterion that matters most in this ticket.
 *
 * "Rich transports remain disabled" is only a real guarantee if code enforces it, so this exhausts
 * the entire `AcceptedWorkState x ProviderDeliveryState x terminal` product (3 x 3 x 2 = 18 cases)
 * against the shipped configuration: an empty `alternateTransportIds`, because nothing anywhere in
 * this repo registers a second transport id. Every one of them must deny, and deny for the
 * structural reason rather than incidentally.
 */
describe('shipped configuration is provably always-deny', () => {
  const cases = ACCEPTED_WORK_STATES.flatMap((acceptedWork) =>
    DELIVERY_STATES.flatMap((delivery) =>
      [false, true].map((terminal) => ({ acceptedWork, delivery, terminal })),
    ),
  );

  it('covers the full cartesian product', () => {
    expect(cases).toHaveLength(18);
  });

  it.each(cases)(
    'denies with no_alternate_transport for acceptedWork=$acceptedWork delivery=$delivery terminal=$terminal',
    ({ acceptedWork, delivery, terminal }) => {
      const gate = new FallbackGate(primaryScope());
      expect(
        gate.authorize({
          candidate: primaryScope(),
          acceptedWork,
          delivery,
          alternateTransportIds: [],
          terminal,
        }),
      ).toEqual({ allowed: false, reason: 'no_alternate_transport' });
    },
  );

  it('still denies when the candidate scope differs, so no input shape reaches an allow', () => {
    const gate = new FallbackGate(primaryScope());
    const decision = gate.authorize({
      ...allowableInput(),
      candidate: freezeLaunchScope(status, { ...start, cwd: '/elsewhere' }, LEGACY_ONE_SHOT_TRANSPORT_ID),
      alternateTransportIds: [],
    });
    expect(decision.allowed).toBe(false);
  });
});

describe('FallbackGate.authorize', () => {
  it('allows exactly one fallback when every condition is clean', () => {
    const gate = new FallbackGate(primaryScope());
    const decision = gate.authorize(allowableInput());
    expect(decision).toEqual({ allowed: true, attempt: 1, scope: primaryScope() });
  });

  it.each([
    ['no_alternate_transport', { alternateTransportIds: [] }],
    ['session_terminal', { terminal: true }],
    ['delivery_ambiguous', { delivery: 'ambiguous' as const }],
    ['delivery_confirmed', { delivery: 'delivered' as const }],
    ['work_accepted', { acceptedWork: 'accepted' as const }],
    ['work_acceptance_unknown', { acceptedWork: 'unknown' as const }],
  ])('denies with %s', (reason, override) => {
    const gate = new FallbackGate(primaryScope());
    expect(gate.authorize({ ...allowableInput(), ...override })).toEqual({
      allowed: false,
      reason,
    });
  });

  it('denies with scope_mismatch when the candidate launch differs from the primary', () => {
    const gate = new FallbackGate(primaryScope());
    const candidate = freezeLaunchScope(
      { ...status, version: '2.1.229' },
      start,
      LEGACY_ONE_SHOT_TRANSPORT_ID,
    );
    expect(gate.authorize({ ...allowableInput(), candidate })).toEqual({
      allowed: false,
      reason: 'scope_mismatch',
    });
  });

  /**
   * Denial reasons must be a deterministic function of the input, not "whichever check ran first
   * this time". Each case below violates several conditions at once and pins which reason wins,
   * which is what makes the documented check order enforced rather than merely described.
   */
  describe('denial reason precedence', () => {
    it('reports no_alternate_transport ahead of every other violation', () => {
      const gate = new FallbackGate(primaryScope());
      expect(
        gate.authorize({
          ...allowableInput(),
          alternateTransportIds: [],
          terminal: true,
          delivery: 'delivered',
          acceptedWork: 'accepted',
        }),
      ).toEqual({ allowed: false, reason: 'no_alternate_transport' });
    });

    it('reports session_terminal ahead of delivery and accepted-work violations', () => {
      const gate = new FallbackGate(primaryScope());
      expect(
        gate.authorize({
          ...allowableInput(),
          terminal: true,
          delivery: 'delivered',
          acceptedWork: 'accepted',
        }),
      ).toEqual({ allowed: false, reason: 'session_terminal' });
    });

    it('reports fallback_already_consumed ahead of delivery and accepted-work violations', () => {
      const gate = new FallbackGate(primaryScope());
      gate.consume();
      expect(
        gate.authorize({ ...allowableInput(), delivery: 'delivered', acceptedWork: 'accepted' }),
      ).toEqual({ allowed: false, reason: 'fallback_already_consumed' });
    });

    it('reports the delivery violation ahead of the accepted-work one', () => {
      const gate = new FallbackGate(primaryScope());
      expect(
        gate.authorize({ ...allowableInput(), delivery: 'ambiguous', acceptedWork: 'accepted' }),
      ).toEqual({ allowed: false, reason: 'delivery_ambiguous' });
    });

    it('reports scope_mismatch only once every other condition is clean', () => {
      const gate = new FallbackGate(primaryScope());
      const candidate = freezeLaunchScope(status, { ...start, cwd: '/elsewhere' }, LEGACY_ONE_SHOT_TRANSPORT_ID);
      expect(gate.authorize({ ...allowableInput(), candidate })).toEqual({
        allowed: false,
        reason: 'scope_mismatch',
      });
    });
  });
});

describe('FallbackGate one-shot budget (no replay)', () => {
  it('denies a second authorize after the first was consumed, for the identical input', () => {
    const gate = new FallbackGate(primaryScope());
    const input = allowableInput();

    const first = gate.authorize(input);
    expect(first).toEqual({ allowed: true, attempt: 1, scope: primaryScope() });

    gate.consume();

    expect(gate.authorize(input)).toEqual({ allowed: false, reason: 'fallback_already_consumed' });
  });

  it('does not spend the budget merely by asking: authorize alone is repeatable', () => {
    const gate = new FallbackGate(primaryScope());
    expect(gate.authorize(allowableInput()).allowed).toBe(true);
    expect(gate.authorize(allowableInput()).allowed).toBe(true);
  });

  it('throws rather than silently no-opping when consume is called twice', () => {
    const gate = new FallbackGate(primaryScope());
    gate.consume();
    expect(() => gate.consume()).toThrow('already consumed');
  });
});
