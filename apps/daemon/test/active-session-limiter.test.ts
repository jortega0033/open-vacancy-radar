import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { ProviderId } from '@agent-dock/shared';
import {
  ACTIVE_SESSION_LIMITS,
  ActiveSessionLimitError,
  ActiveSessionLimiter,
} from '../src/active-session-limiter.js';

const PROVIDERS: readonly ProviderId[] = ['claude', 'codex'];

function ids(count: number): string[] {
  return Array.from({ length: count }, () => randomUUID());
}

describe('ActiveSessionLimiter: limits', () => {
  it('exposes the reviewed limits as a frozen constant', () => {
    expect(ACTIVE_SESSION_LIMITS).toEqual({ global: 4, perProvider: 2 });
    expect(Object.isFrozen(ACTIVE_SESSION_LIMITS)).toBe(true);
  });

  it('admits exactly perProvider sessions for one provider and refuses the next with scope "provider"', () => {
    const limiter = new ActiveSessionLimiter();
    const [a, b, c] = ids(3) as [string, string, string];

    limiter.reserve('claude', a);
    limiter.reserve('claude', b);

    let thrown: unknown;
    try {
      limiter.reserve('claude', c);
    } catch (err) {
      thrown = err;
    }

    expect(thrown).toBeInstanceOf(ActiveSessionLimitError);
    const error = thrown as ActiveSessionLimitError;
    expect(error.scope).toBe('provider');
    expect(error.code).toBe('active_session_limit');
    expect(error.statusCode).toBe(409);
    expect(error.capacity).toEqual({
      global: { active: 2, limit: 4 },
      provider: { active: 2, limit: 2 },
    });
    // The refused session must leave no trace: a partial reservation would permanently shrink
    // capacity for the lifetime of the process.
    expect(limiter.holds(c)).toBe(false);
    expect(limiter.snapshot()).toEqual({ global: 2, byProvider: { claude: 2 } });
  });

  it('admits exactly global sessions across providers and refuses the next with scope "global"', () => {
    const limiter = new ActiveSessionLimiter();
    const [a, b, c, d, e] = ids(5) as [string, string, string, string, string];

    limiter.reserve('claude', a);
    limiter.reserve('claude', b);
    limiter.reserve('codex', c);
    limiter.reserve('codex', d);

    expect(() => limiter.reserve('claude', e)).toThrow(ActiveSessionLimitError);
    try {
      limiter.reserve('codex', e);
    } catch (err) {
      // Global is checked first, so a machine that is entirely full says so rather than blaming a
      // provider the caller could pointlessly switch away from.
      expect((err as ActiveSessionLimitError).scope).toBe('global');
    }
    expect(limiter.snapshot().global).toBe(4);
  });

  it('sweeps the full 5x5 admission table: every (claude, codex) pair is admitted iff both bounds hold', () => {
    for (let claudeCount = 0; claudeCount <= 4; claudeCount++) {
      for (let codexCount = 0; codexCount <= 4; codexCount++) {
        const limiter = new ActiveSessionLimiter();
        let admittedClaude = 0;
        let admittedCodex = 0;

        for (let i = 0; i < claudeCount; i++) {
          try {
            limiter.reserve('claude', randomUUID());
            admittedClaude += 1;
          } catch {
            /* refused, which the expectation below accounts for */
          }
        }
        for (let i = 0; i < codexCount; i++) {
          try {
            limiter.reserve('codex', randomUUID());
            admittedCodex += 1;
          } catch {
            /* refused */
          }
        }

        // Per-provider caps first, then whatever the global cap still leaves for the second
        // provider. This is the exact arithmetic the implementation must produce, derived
        // independently of it rather than read back from the same code path.
        const expectedClaude = Math.min(claudeCount, ACTIVE_SESSION_LIMITS.perProvider);
        const expectedCodex = Math.min(
          codexCount,
          ACTIVE_SESSION_LIMITS.perProvider,
          ACTIVE_SESSION_LIMITS.global - expectedClaude,
        );

        expect({ admittedClaude, admittedCodex }).toEqual({
          admittedClaude: expectedClaude,
          admittedCodex: expectedCodex,
        });
        expect(limiter.snapshot().global).toBe(expectedClaude + expectedCodex);
      }
    }
  });

  it('reports capacity per provider without mutating anything', () => {
    const limiter = new ActiveSessionLimiter();
    limiter.reserve('claude', randomUUID());
    expect(limiter.capacityFor('claude')).toEqual({
      global: { active: 1, limit: 4 },
      provider: { active: 1, limit: 2 },
    });
    expect(limiter.capacityFor('codex')).toEqual({
      global: { active: 1, limit: 4 },
      provider: { active: 0, limit: 2 },
    });
    expect(limiter.snapshot()).toEqual({ global: 1, byProvider: { claude: 1 } });
  });
});

describe('ActiveSessionLimiter: release', () => {
  it('frees both the global and the per-provider slot', () => {
    const limiter = new ActiveSessionLimiter();
    const [a, b, c] = ids(3) as [string, string, string];
    limiter.reserve('claude', a);
    limiter.reserve('claude', b);
    expect(() => limiter.reserve('claude', c)).toThrow(ActiveSessionLimitError);

    expect(limiter.release(a)).toBe(true);
    expect(() => limiter.reserve('claude', c)).not.toThrow();
    expect(limiter.snapshot()).toEqual({ global: 2, byProvider: { claude: 2 } });
  });

  it('is idempotent: a second release returns false and changes nothing', () => {
    const limiter = new ActiveSessionLimiter();
    const a = randomUUID();
    limiter.reserve('codex', a);

    expect(limiter.release(a)).toBe(true);
    expect(limiter.release(a)).toBe(false);
    expect(limiter.release(a)).toBe(false);
    expect(limiter.snapshot()).toEqual({ global: 0, byProvider: {} });
  });

  it('returns false for an id that never held a reservation', () => {
    const limiter = new ActiveSessionLimiter();
    expect(limiter.release(randomUUID())).toBe(false);
  });

  it('refuses to reserve the same session id twice', () => {
    const limiter = new ActiveSessionLimiter();
    const a = randomUUID();
    limiter.reserve('claude', a);
    expect(() => limiter.reserve('claude', a)).toThrow(/already holds/);
  });

  it('carries an explicit underflow guard rather than clamping a broken counter to zero', () => {
    // The two counters are true ECMAScript private fields, so no test can corrupt one from the
    // outside to drive this branch -- which is the point: the state is unreachable through the
    // class's own API and only a future bug inside it could produce it. What is asserted here is
    // that the branch exists and throws, rather than clamping, because a clamped counter would turn
    // a real accounting bug into a silent, permanent capacity leak instead of a loud failure.
    const source = ActiveSessionLimiter.prototype.release.toString();
    expect(source).toMatch(/underflow/);
    expect(source).toMatch(/throw new Error/);

    const limiter = new ActiveSessionLimiter();
    const a = randomUUID();
    limiter.reserve('claude', a);
    expect(limiter.release(a)).toBe(true);
    expect(limiter.snapshot()).toEqual({ global: 0, byProvider: {} });
  });
});

describe('ActiveSessionLimiter: structural guarantees', () => {
  it('reserve() is a plain synchronous function, not an async one', () => {
    // If this ever becomes an AsyncFunction, the check-then-increment stops being atomic on the
    // event loop and concurrent requests can over-admit. See the class docstring.
    expect(ActiveSessionLimiter.prototype.reserve.constructor.name).toBe('Function');
    expect(ActiveSessionLimiter.prototype.reserve.constructor.name).not.toBe('AsyncFunction');
  });

  it('reserve() contains no await and no promise handling in its source text', () => {
    const source = ActiveSessionLimiter.prototype.reserve.toString();
    expect(source).not.toMatch(/\bawait\b/);
    expect(source).not.toMatch(/\.then\s*\(/);
    expect(source).not.toMatch(/\byield\b/);
  });

  it('exposes no bulk release: capacity can only be returned by the session that took it', () => {
    const limiter = new ActiveSessionLimiter() as unknown as Record<string, unknown>;
    expect(limiter.releaseAll).toBeUndefined();
    expect(Object.getOwnPropertyNames(ActiveSessionLimiter.prototype)).not.toContain('releaseAll');
  });

  it('keeps each provider accounted separately across a mixed churn sequence', () => {
    const limiter = new ActiveSessionLimiter();
    const held: Array<{ id: string; provider: ProviderId }> = [];

    for (let round = 0; round < 50; round++) {
      const provider = PROVIDERS[round % PROVIDERS.length] as ProviderId;
      const id = randomUUID();
      try {
        limiter.reserve(provider, id);
        held.push({ id, provider });
      } catch (err) {
        expect(err).toBeInstanceOf(ActiveSessionLimitError);
      }
      if (held.length > 0 && round % 3 === 0) {
        const victim = held.shift() as { id: string; provider: ProviderId };
        expect(limiter.release(victim.id)).toBe(true);
      }

      const snapshot = limiter.snapshot();
      expect(snapshot.global).toBe(held.length);
      expect(snapshot.global).toBeLessThanOrEqual(ACTIVE_SESSION_LIMITS.global);
      for (const count of Object.values(snapshot.byProvider)) {
        expect(count).toBeLessThanOrEqual(ACTIVE_SESSION_LIMITS.perProvider);
      }
    }
  });
});
