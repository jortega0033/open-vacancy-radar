import { describe, expect, it, vi } from 'vitest';
import type { AgentEvent, ProviderStatus } from '@agent-dock/shared';
import { superviseProviderSession } from '../src/providers/common/session-supervisor.js';
import { acceptedWorkBoundaryFor } from '../src/providers/compatibility-manifest.js';
import type { AgentProvider, ProviderSessionHandle, StartSessionOptions } from '../src/types.js';

/**
 * Unit tests driving the supervisor against a hand-built `AgentProvider`, with no real process.
 *
 * The per-provider conformance suites (claude/codex-supervisor-contract.test.ts) already cover the
 * real spawn paths. This file exists for the states a real fixture cannot reliably produce on
 * demand: a stream abandoned mid-flight, a `cancel()` that never confirms a reap, and a provider
 * version that is not in the manifest.
 */

function status(overrides: Partial<ProviderStatus> = {}): ProviderStatus {
  return {
    id: 'claude',
    name: 'Claude Code',
    installed: true,
    authenticated: 'authenticated',
    capabilities: {},
    executablePath: '/usr/local/bin/claude',
    version: '2.1.228',
    ...overrides,
  };
}

const start: StartSessionOptions = { sessionId: 'unit-session', cwd: '/workspace', prompt: 'hi' };

interface ScriptedOptions {
  events: AgentEvent[];
  /** Probe callbacks the fake adapter should fire, in order, before yielding events. */
  onStart?: (options: StartSessionOptions) => void;
  cancel?: () => Promise<void>;
}

/** Records the options the supervisor actually passed through to `startSession`. */
function scriptedProvider(script: ScriptedOptions): {
  provider: AgentProvider;
  seen: StartSessionOptions[];
} {
  const seen: StartSessionOptions[] = [];
  const provider: AgentProvider = {
    id: 'claude',
    name: 'Claude Code',
    detect: () => Promise.resolve(status()),
    startSession: (options): ProviderSessionHandle => {
      seen.push(options);
      script.onStart?.(options);
      async function* events(): AsyncGenerator<AgentEvent, void, void> {
        for (const event of script.events) yield event;
      }
      return {
        events: events(),
        cancel: script.cancel ?? (() => Promise.resolve()),
      };
    },
  };
  return { provider, seen };
}

const COMPLETED: AgentEvent[] = [
  { type: 'session.started', sessionId: 'unit-session', provider: 'claude' },
  { type: 'assistant.message', text: 'hello' },
  { type: 'session.completed', providerSessionId: 'prov-123' },
];

describe('superviseProviderSession wiring', () => {
  it('passes a launch probe through to the underlying adapter without disturbing the other options', () => {
    const { provider, seen } = scriptedProvider({ events: COMPLETED });
    superviseProviderSession({ provider, status: status(), start });

    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ sessionId: 'unit-session', cwd: '/workspace', prompt: 'hi' });
    expect(typeof seen[0]!.launchProbe?.onSpawnAttempt).toBe('function');
    expect(typeof seen[0]!.launchProbe?.onPromptDelivered).toBe('function');
    expect(typeof seen[0]!.launchProbe?.onUnknownFrame).toBe('function');
  });

  it('defaults to the one transport this repo ships', () => {
    const { provider } = scriptedProvider({ events: COMPLETED });
    const handle = superviseProviderSession({ provider, status: status(), start });
    expect(handle.transportId).toBe('legacy-one-shot');
    expect(handle.sessionId).toBe('unit-session');
  });

  it('honors an explicit transport id, which then misses the manifest', () => {
    const { provider } = scriptedProvider({ events: COMPLETED });
    const handle = superviseProviderSession({
      provider,
      status: status(),
      start,
      transportId: 'some-future-transport',
    });
    expect(handle.transportId).toBe('some-future-transport');
    expect(handle.compatibility).toBeUndefined();
  });
});

describe('accepted-work boundary selection', () => {
  it('records accepted on a stdin flush when the manifest says the boundary is the stdin write', async () => {
    const { provider } = scriptedProvider({
      events: COMPLETED,
      onStart: (options) => options.launchProbe?.onPromptDelivered?.(),
    });
    const handle = superviseProviderSession({ provider, status: status(), start });
    expect(handle.acceptedWork()).toBe('accepted');
    await expect(handle.accepted).resolves.toBe('accepted');
  });

  it('records accepted on a spawn attempt when the adapter embeds the prompt in argv (viaStdin: false)', () => {
    const { provider } = scriptedProvider({
      events: COMPLETED,
      onStart: (options) => options.launchProbe?.onSpawnAttempt?.({ viaStdin: false }),
    });
    // Codex-shaped: `evidence.viaStdin` is ground truth reported by runProviderSession itself, not
    // derived from the manifest -- the prompt is already in argv, so process creation hands it over
    // unconditionally, regardless of what any manifest entry claims.
    const handle = superviseProviderSession({
      provider,
      status: status({ id: 'codex', version: '0.147.0' }),
      start,
    });
    expect(handle.acceptedWork()).toBe('accepted');
  });

  it('ignores a spawn attempt when the adapter delivers the prompt over stdin (viaStdin: true)', () => {
    const { provider } = scriptedProvider({
      events: COMPLETED,
      onStart: (options) => options.launchProbe?.onSpawnAttempt?.({ viaStdin: true }),
    });
    const handle = superviseProviderSession({ provider, status: status(), start });
    // viaStdin: true means the spawn attempt alone proves nothing; no stdin write happened, so
    // nothing was delivered.
    expect(handle.acceptedWork()).toBe('not_accepted');
  });

  it('stays accepted, never downgrading, if a stdin flush is observed after a spawn attempt', () => {
    // A latch monotonicity check: once the spawn attempt (viaStdin: false) puts the latch at
    // 'accepted', a later onPromptDelivered() (which wouldn't normally fire alongside viaStdin:
    // false, but could for a provider with both signals) must join, never regress, the state.
    const { provider } = scriptedProvider({
      events: COMPLETED,
      onStart: (options) => {
        options.launchProbe?.onSpawnAttempt?.({ viaStdin: false });
        options.launchProbe?.onPromptDelivered?.();
      },
    });
    const handle = superviseProviderSession({
      provider,
      status: status({ id: 'codex', version: '0.147.0' }),
      start,
    });
    expect(handle.acceptedWork()).toBe('accepted');
  });

  it('leaves work not_accepted when the spawn itself failed', () => {
    const { provider } = scriptedProvider({
      events: COMPLETED,
      onStart: (options) => options.launchProbe?.onSpawnFailed?.(),
    });
    const handle = superviseProviderSession({ provider, status: status(), start });
    expect(handle.acceptedWork()).toBe('not_accepted');
  });

  /**
   * The manifest-miss diagnostic, independent of the accepted-work decision.
   *
   * `acceptedWorkBoundaryFor` still fails closed to the conservative boundary for an unrecognized
   * CLI build, and `handle.compatibility` still correctly reports the miss -- both remain true and
   * are asserted here. But the actual accepted-work LATCH is driven by `evidence.viaStdin` (ground
   * truth from `runProviderSession`), not by this manifest lookup, so an unrecognized version's
   * accepted-work state is exactly whatever the real adapter's transport says it is -- correctly
   * conservative for a real viaStdin:true adapter, and correctly 'accepted' at spawn for a real
   * viaStdin:false one, regardless of whether the version was recognized.
   */
  describe('unrecognized provider version', () => {
    it.each([
      ['an unpinned version', { version: '99.99.99' }],
      ['no detected version at all', { version: undefined }],
    ])('still reports a manifest miss and the conservative boundary for %s, independent of accepted-work', (_label, overrides) => {
      const { provider } = scriptedProvider({
        events: COMPLETED,
        onStart: (options) => options.launchProbe?.onSpawnAttempt?.({ viaStdin: false }),
      });
      const handle = superviseProviderSession({
        provider,
        status: status(overrides),
        start,
      });

      expect(handle.compatibility).toBeUndefined();
      expect(acceptedWorkBoundaryFor(handle.compatibility)).toBe('process-spawn-attempt');
      // Ground truth (viaStdin: false, an argv-embedded prompt) drives this, not the manifest miss.
      expect(handle.acceptedWork()).toBe('accepted');
    });
  });

  it('logs (but never acts on) a mismatch between the manifest boundary and the adapter\'s actual transport', () => {
    // Regression guard for a real, fixed bug: accepted-work timing used to be driven by this
    // manifest boundary directly, which could silently drift from what the adapter actually does.
    // Ground truth now drives behavior; this only proves the drift is still detected and logged.
    const warn = vi.fn();
    const { provider } = scriptedProvider({
      events: COMPLETED,
      // Claude's pinned manifest entry declares 'first-prompt-byte-to-stdin', but this reports
      // viaStdin: false at spawn -- as if a future adapter change embedded the prompt in argv
      // without the manifest being updated to match.
      onStart: (options) => options.launchProbe?.onSpawnAttempt?.({ viaStdin: false }),
    });
    const handle = superviseProviderSession({
      provider,
      status: status(),
      start,
      logger: { debug: () => {}, info: () => {}, warn, error: () => {} },
    });

    // Ground truth wins: ends up 'accepted' at the spawn attempt, exactly as a real viaStdin:false
    // adapter should, regardless of what the (now-stale) manifest entry claims.
    expect(handle.acceptedWork()).toBe('accepted');
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('disagrees with the adapter'),
      expect.objectContaining({ manifestBoundary: 'first-prompt-byte-to-stdin', actualViaStdin: false }),
    );
  });
});

describe('event pass-through and settlement', () => {
  it('re-yields every event unchanged, by identity', async () => {
    const { provider } = scriptedProvider({ events: COMPLETED });
    const handle = superviseProviderSession({ provider, status: status(), start });

    const seen: AgentEvent[] = [];
    for await (const event of handle.events) seen.push(event);

    expect(seen).toEqual(COMPLETED);
    // Identity, not just deep equality: proves nothing was cloned or rebuilt on the way through.
    seen.forEach((event, index) => expect(event).toBe(COMPLETED[index]));
  });

  it('settles completed and carries the provider session id from the terminal event', async () => {
    const { provider } = scriptedProvider({ events: COMPLETED });
    const handle = superviseProviderSession({ provider, status: status(), start });
    for await (const _event of handle.events) void _event;

    const outcome = await handle.settled;
    expect(outcome.terminal).toBe('completed');
    expect(outcome.providerSessionId).toBe('prov-123');
    expect(outcome.reaped).toBe(true);
  });

  it.each([
    ['session.failed', 'failed'],
    ['session.cancelled', 'cancelled'],
  ] as const)('maps %s to terminal %s', async (eventType, terminal) => {
    const { provider } = scriptedProvider({
      events: [{ type: eventType } as AgentEvent],
    });
    const handle = superviseProviderSession({ provider, status: status(), start });
    for await (const _event of handle.events) void _event;
    expect((await handle.settled).terminal).toBe(terminal);
  });

  it('keeps the first error code as the failure reason, not the last', async () => {
    const { provider } = scriptedProvider({
      events: [
        { type: 'error', code: 'REAL_CAUSE', message: 'first', recoverable: false },
        { type: 'error', code: 'DOWNSTREAM_SYMPTOM', message: 'second', recoverable: false },
        { type: 'session.failed', message: 'failed' },
      ],
    });
    const handle = superviseProviderSession({ provider, status: status(), start });
    for await (const _event of handle.events) void _event;
    expect((await handle.settled).failureReasonCode).toBe('REAL_CAUSE');
  });

  it('substitutes a code when an error event carries none', async () => {
    const { provider } = scriptedProvider({
      events: [
        { type: 'error', message: 'no code here', recoverable: false },
        { type: 'session.failed', message: 'failed' },
      ],
    });
    const handle = superviseProviderSession({ provider, status: status(), start });
    for await (const _event of handle.events) void _event;
    expect((await handle.settled).failureReasonCode).toBe('PROVIDER_ERROR');
  });

  it('still settles when the consumer abandons the stream before a terminal event', async () => {
    const { provider } = scriptedProvider({ events: COMPLETED });
    const handle = superviseProviderSession({ provider, status: status(), start });

    for await (const _event of handle.events) {
      break; // abandon after the first event
    }

    // Without a `finally` in the supervisor's generator, `settled` would hang forever here.
    const outcome = await handle.settled;
    expect(outcome.terminal).toBe('failed');
    expect(outcome.failureReasonCode).toBe('SUPERVISED_STREAM_ABANDONED');
  });
});

describe('cancellation and reap confirmation', () => {
  it('marks reaped true when the underlying cancel confirms', async () => {
    const cancel = vi.fn(() => Promise.resolve());
    const { provider } = scriptedProvider({ events: [{ type: 'session.cancelled' }], cancel });
    const handle = superviseProviderSession({ provider, status: status(), start });

    await handle.cancel();
    for await (const _event of handle.events) void _event;

    expect(cancel).toHaveBeenCalledOnce();
    expect((await handle.settled).reaped).toBe(true);
  });

  /**
   * The case that matters operationally: cancellation was requested but the process tree could not
   * be proven dead. `cancel()` must still resolve (so the caller keeps going) while the outcome
   * records `reaped: false` (so the caller knows not to treat the working directory as free).
   */
  it('resolves cancel() but reports reaped false when the reap cannot be confirmed', async () => {
    const cancel = vi.fn(() =>
      Promise.reject(new Error('provider process could not be confirmed reaped')),
    );
    const warn = vi.fn();
    const { provider } = scriptedProvider({ events: [{ type: 'session.cancelled' }], cancel });
    const handle = superviseProviderSession({
      provider,
      status: status(),
      start,
      logger: { debug: () => {}, info: () => {}, warn, error: () => {} },
    });

    await expect(handle.cancel()).resolves.toBeUndefined();
    for await (const _event of handle.events) void _event;

    expect((await handle.settled).reaped).toBe(false);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('could not confirm a process-tree reap'),
      expect.objectContaining({ sessionId: 'unit-session' }),
    );
  });

  it('bounds a cancel whose underlying handle never settles, and reports reaped false', async () => {
    const { provider } = scriptedProvider({
      events: [{ type: 'session.cancelled' }],
      cancel: () => new Promise<void>(() => undefined),
    });
    const handle = superviseProviderSession({
      provider,
      status: status(),
      start,
      limits: { cancelTimeoutMs: 25 },
    });

    const startedAt = Date.now();
    await handle.cancel();
    expect(Date.now() - startedAt).toBeLessThan(2_000);

    for await (const _event of handle.events) void _event;
    expect((await handle.settled).reaped).toBe(false);
  });
});

describe('unknown frame ledger integration', () => {
  it('tallies frames reported through the probe, and exposes them on the outcome', async () => {
    const { provider } = scriptedProvider({
      events: COMPLETED,
      onStart: (options) => {
        options.launchProbe?.onUnknownFrame?.('unrecognized_event_type', '{"type":"weird"}', 'weird');
        options.launchProbe?.onUnknownFrame?.('unrecognized_event_type', '{"type":"weird"}', 'weird');
        options.launchProbe?.onUnknownFrame?.('unparseable_line', 'not json');
      },
    });
    const handle = superviseProviderSession({ provider, status: status(), start });
    for await (const _event of handle.events) void _event;

    const frames = (await handle.settled).unknownFrames;
    expect(frames).toHaveLength(2);
    expect(frames.find((f) => f.kind === 'unrecognized_event_type')?.occurrences).toBe(2);
    expect(handle.unknownFrames()).toEqual(frames);
  });

  it('applies the caller-supplied ledger limits', async () => {
    const { provider } = scriptedProvider({
      events: COMPLETED,
      onStart: (options) => {
        for (let i = 0; i < 20; i += 1) {
          options.launchProbe?.onUnknownFrame?.('unrecognized_event_type', `{"type":"t${i}"}`, `t${i}`);
        }
      },
    });
    const handle = superviseProviderSession({
      provider,
      status: status(),
      start,
      limits: { maxUnknownFrameKinds: 3 },
    });
    for await (const _event of handle.events) void _event;

    // 3 distinct kinds plus the single overflow bucket.
    expect((await handle.settled).unknownFrames).toHaveLength(4);
  });
});
