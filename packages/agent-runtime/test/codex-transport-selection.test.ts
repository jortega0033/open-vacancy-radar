import { describe, expect, it, vi } from 'vitest';
import type { AgentEvent, ProviderStatus } from '@agent-dock/shared';
import { AsyncChannel } from '../src/process/async-channel.js';
import type { ProviderSessionHandle, StartSessionOptions } from '../src/types.js';
import {
  createCodexTransportWithFallback,
  type CodexTransportSelectionDeps,
} from '../src/providers/codex/transport-selection.js';
import type { CodexAppServerTransportOptions } from '../src/providers/codex/app-server/transport.js';

const start: StartSessionOptions = { sessionId: 'selection-session', cwd: '/workspace', prompt: 'hi' };

function baseStatus(overrides: Partial<ProviderStatus> = {}): ProviderStatus {
  return {
    id: 'codex',
    name: 'Codex',
    installed: true,
    authenticated: 'authenticated',
    capabilities: {},
    executablePath: '/usr/local/bin/codex',
    version: '0.147.0',
    authSource: 'chatgpt',
    ...overrides,
  };
}

async function collect(events: AsyncGenerator<AgentEvent, void, void>): Promise<AgentEvent[]> {
  const out: AgentEvent[] = [];
  for await (const event of events) out.push(event);
  return out;
}

/**
 * Yields until every currently-queued microtask has drained, not just one. `AsyncChannel`'s
 * push-then-consume path takes several microtask hops (resolving a waiter's promise, the async
 * generator resuming to its `yield`, the `for await` consuming that yield) to actually deliver a
 * pushed item to a consumer's loop body -- a single `await Promise.resolve()` is not reliably
 * enough of a gap to guarantee the consumer has processed an event yet, which is exactly what let
 * an earlier version of these tests pass without ever genuinely exercising buffering (the real bug
 * this file's "passes a successful app-server session through verbatim" test exists to catch). A
 * macrotask boundary is the smallest gap that reliably outlasts any number of microtask hops.
 */
function flushMicrotasks(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

/**
 * A scripted fake transport: `steps` runs against a live channel and an `onPromptDelivered`
 * trigger the real caller wired through `options.launchProbe`, so a test can control exactly when
 * (or whether) the accepted-work boundary fires relative to the events it emits -- the one thing
 * `transport-selection.ts`'s fallback decision actually watches.
 */
function scriptedTransport(
  steps: (channel: AsyncChannel<AgentEvent>, firePromptDelivered: () => void) => Promise<void> | void,
): { create: NonNullable<CodexTransportSelectionDeps['createAppServerTransport']>; cancelCalls: () => number } {
  let cancelCalls = 0;
  const create = ((options: CodexAppServerTransportOptions): ProviderSessionHandle => {
    const channel = new AsyncChannel<AgentEvent>();
    void Promise.resolve().then(() => steps(channel, () => options.launchProbe?.onPromptDelivered?.()));
    return {
      events: channel[Symbol.asyncIterator](),
      cancel: async () => {
        cancelCalls += 1;
      },
    };
  }) as NonNullable<CodexTransportSelectionDeps['createAppServerTransport']>;
  return { create, cancelCalls: () => cancelCalls };
}

function scriptedExec(
  events: AgentEvent[],
): { create: NonNullable<CodexTransportSelectionDeps['createExecTransport']>; cancelCalls: () => number; calls: () => number } {
  let cancelCalls = 0;
  let calls = 0;
  const create: NonNullable<CodexTransportSelectionDeps['createExecTransport']> = () => {
    calls += 1;
    const channel = new AsyncChannel<AgentEvent>();
    void Promise.resolve().then(() => {
      for (const event of events) channel.push(event);
      channel.close();
    });
    return {
      events: channel[Symbol.asyncIterator](),
      cancel: async () => {
        cancelCalls += 1;
      },
    };
  };
  return { create, cancelCalls: () => cancelCalls, calls: () => calls };
}

describe('createCodexTransportWithFallback: pre-spawn routing (zero delivery risk, no gate involved)', () => {
  it('routes api_key auth straight to exec, never attempting app-server', async () => {
    const exec = scriptedExec([{ type: 'session.started', sessionId: start.sessionId, provider: 'codex' }, { type: 'session.completed' }]);
    const appServer = scriptedTransport(() => {
      throw new Error('must not be called for api_key auth');
    });
    const events = await collect(
      createCodexTransportWithFallback(start, undefined, {
        detect: async () => baseStatus({ authSource: 'api_key' }),
        createAppServerTransport: appServer.create,
        createExecTransport: exec.create,
      }).events,
    );
    expect(events.at(-1)).toEqual({ type: 'session.completed' });
    expect(exec.calls()).toBe(1);
  });

  it('routes a compatibility-manifest miss (unrecognized version) straight to exec', async () => {
    const exec = scriptedExec([{ type: 'session.started', sessionId: start.sessionId, provider: 'codex' }, { type: 'session.completed' }]);
    const events = await collect(
      createCodexTransportWithFallback(start, undefined, {
        detect: async () => baseStatus({ version: '99.99.99' }),
        createExecTransport: exec.create,
      }).events,
    );
    expect(events.at(-1)).toEqual({ type: 'session.completed' });
    expect(exec.calls()).toBe(1);
  });

  it('routes a missing executablePath straight to exec', async () => {
    const exec = scriptedExec([{ type: 'session.completed' }]);
    const events = await collect(
      createCodexTransportWithFallback(start, undefined, {
        detect: async () => baseStatus({ executablePath: undefined }),
        createExecTransport: exec.create,
      }).events,
    );
    expect(events.at(-1)).toEqual({ type: 'session.completed' });
    expect(exec.calls()).toBe(1);
  });

  it('routes to exec when detect() itself throws', async () => {
    const exec = scriptedExec([{ type: 'session.completed' }]);
    const events = await collect(
      createCodexTransportWithFallback(start, undefined, {
        detect: async () => {
          throw new Error('codex vanished');
        },
        createExecTransport: exec.create,
      }).events,
    );
    expect(events.at(-1)).toEqual({ type: 'session.completed' });
    expect(exec.calls()).toBe(1);
  });
});

describe('createCodexTransportWithFallback: app-server attempted when compatible and not api_key', () => {
  it('passes a successful app-server session through verbatim, never touching exec', async () => {
    const appServer = scriptedTransport(async (channel, firePromptDelivered) => {
      channel.push({ type: 'session.started', sessionId: start.sessionId, provider: 'codex' });
      // The real transport.ts only fires onPromptDelivered after real process I/O (initialize ->
      // model/list -> thread/start round trips), so by the time it fires, the consumer has always
      // already had a chance to pull session.started off the channel into its own pre-commit
      // buffer. A synchronous script (push, then fire, with no gap) would let the fake commit
      // before the consumer's loop ever ran a single iteration, hiding exactly the bug this yield
      // is here to catch: a real implementation that forgot to flush its buffer on commit would
      // still pass a test that never lets anything accumulate in that buffer in the first place.
      await flushMicrotasks();
      firePromptDelivered();
      channel.push({ type: 'assistant.message', text: 'hi' });
      channel.push({ type: 'session.completed', providerSessionId: 'thread-1' });
      channel.close();
    });
    const exec = scriptedExec([]);
    const events = await collect(
      createCodexTransportWithFallback(start, undefined, {
        detect: async () => baseStatus(),
        createAppServerTransport: appServer.create,
        createExecTransport: exec.create,
      }).events,
    );
    expect(events).toEqual([
      { type: 'session.started', sessionId: start.sessionId, provider: 'codex' },
      { type: 'assistant.message', text: 'hi' },
      { type: 'session.completed', providerSessionId: 'thread-1' },
    ]);
    expect(exec.calls()).toBe(0);
  });

  it('forwards onPromptDelivered to the caller-supplied launchProbe once the app-server attempt commits', async () => {
    const appServer = scriptedTransport(async (channel, firePromptDelivered) => {
      channel.push({ type: 'session.started', sessionId: start.sessionId, provider: 'codex' });
      firePromptDelivered();
      channel.push({ type: 'session.completed' });
      channel.close();
    });
    const onPromptDelivered = vi.fn();
    await collect(
      createCodexTransportWithFallback(
        { ...start, launchProbe: { onPromptDelivered } },
        undefined,
        { detect: async () => baseStatus(), createAppServerTransport: appServer.create },
      ).events,
    );
    expect(onPromptDelivered).toHaveBeenCalledTimes(1);
  });
});

describe('createCodexTransportWithFallback: startup-failure fallback (the gate\'s first real caller)', () => {
  it('falls back to exec, discarding the app-server attempt entirely, when it fails before turn/start was ever attempted', async () => {
    const appServer = scriptedTransport(async (channel) => {
      channel.push({ type: 'session.started', sessionId: start.sessionId, provider: 'codex' });
      channel.push({ type: 'error', code: 'PROCESS_FAILED', message: 'app-server crashed', recoverable: false });
      channel.push({ type: 'session.failed', message: 'app-server crashed' });
      channel.close();
    });
    const exec = scriptedExec([
      { type: 'session.started', sessionId: start.sessionId, provider: 'codex' },
      { type: 'session.completed', providerSessionId: 'thread-legacy' },
    ]);
    const events = await collect(
      createCodexTransportWithFallback(start, undefined, {
        detect: async () => baseStatus(),
        createAppServerTransport: appServer.create,
        createExecTransport: exec.create,
      }).events,
    );
    // Exactly the exec transport's events -- no trace of the app-server attempt's own
    // session.started/error/session.failed sequence anywhere in what the caller sees.
    expect(events).toEqual([
      { type: 'session.started', sessionId: start.sessionId, provider: 'codex' },
      { type: 'session.completed', providerSessionId: 'thread-legacy' },
    ]);
    expect(exec.calls()).toBe(1);
  });

  it('surfaces the app-server failure as-is, never falling back, once turn/start was actually attempted', async () => {
    const appServer = scriptedTransport(async (channel, firePromptDelivered) => {
      channel.push({ type: 'session.started', sessionId: start.sessionId, provider: 'codex' });
      // See the "passes a successful app-server session through verbatim" test above for why this
      // gap matters: it lets the consumer actually buffer session.started before commit, so this
      // test also exercises the real flush-on-commit path, not just a same-tick pass-through.
      await flushMicrotasks();
      firePromptDelivered();
      channel.push({ type: 'error', code: 'PROCESS_FAILED', message: 'crashed mid-turn', recoverable: false });
      channel.push({ type: 'session.failed', message: 'crashed mid-turn' });
      channel.close();
    });
    const exec = scriptedExec([{ type: 'session.completed' }]);
    const events = await collect(
      createCodexTransportWithFallback(start, undefined, {
        detect: async () => baseStatus(),
        createAppServerTransport: appServer.create,
        createExecTransport: exec.create,
      }).events,
    );
    expect(events).toEqual([
      { type: 'session.started', sessionId: start.sessionId, provider: 'codex' },
      { type: 'error', code: 'PROCESS_FAILED', message: 'crashed mid-turn', recoverable: false },
      { type: 'session.failed', message: 'crashed mid-turn' },
    ]);
    expect(exec.calls()).toBe(0);
  });

  /**
   * A session the caller already asked to stop must end stopped, not silently restart on another
   * transport -- even when the app-server process happens to crash for an unrelated reason (e.g.
   * an OOM kill) while a cancellation is still in flight, racing ahead of it. Without passing
   * `terminal: cancelled` into `gate.authorize()`, this would otherwise look identical to an
   * ordinary pre-commit startup failure and get "safely" retried over exec -- which is not safe at
   * all for a session the caller has already moved on from.
   */
  it('does not attempt a fallback when cancel() already raced in before a natural pre-commit app-server failure arrives', async () => {
    // Deliberately NOT calling cancel() before the app-server attempt even starts: `run()` has its
    // own earlier `if (cancelled)` checkpoint right after detect() resolves, before app-server is
    // ever attempted at all, which would end the session in session.cancelled without ever
    // reaching this code path -- a real, already-tested case ("ends in session.cancelled without
    // ever spawning anything, when cancel() races detect()" above), but not the one this test is
    // for. Here cancel() must land genuinely mid-attempt, after the app-server handle already
    // exists, racing its own natural (not caller-requested) failure.
    let createdResolve!: () => void;
    const created = new Promise<void>((resolve) => {
      createdResolve = resolve;
    });
    const appServer = scriptedTransport(async (channel) => {
      createdResolve();
      channel.push({ type: 'session.started', sessionId: start.sessionId, provider: 'codex' });
      // Give the test's own handle.cancel() call below a chance to actually run and flip
      // `cancelled` to true before this "crash" arrives.
      await flushMicrotasks();
      channel.push({ type: 'error', code: 'PROCESS_FAILED', message: 'crashed', recoverable: false });
      channel.push({ type: 'session.failed', message: 'crashed' });
      channel.close();
    });
    const exec = scriptedExec([{ type: 'session.completed' }]);
    const handle = createCodexTransportWithFallback(start, undefined, {
      detect: async () => baseStatus(),
      createAppServerTransport: appServer.create,
      createExecTransport: exec.create,
    });
    await created;
    await handle.cancel();
    const events = await collect(handle.events);
    // The real crash-derived failure, exactly as the app-server attempt produced it -- no fallback
    // was attempted (exec.calls() is 0), because FallbackGate denied with session_terminal.
    expect(events).toEqual([
      { type: 'session.started', sessionId: start.sessionId, provider: 'codex' },
      { type: 'error', code: 'PROCESS_FAILED', message: 'crashed', recoverable: false },
      { type: 'session.failed', message: 'crashed' },
    ]);
    expect(exec.calls()).toBe(0);
  });
});

describe('createCodexTransportWithFallback: cancellation', () => {
  it('ends in session.cancelled without ever spawning anything, when cancel() races detect()', async () => {
    let resolveDetect!: (status: ProviderStatus) => void;
    const detect = () => new Promise<ProviderStatus>((resolve) => { resolveDetect = resolve; });
    const appServer = scriptedTransport(() => {
      throw new Error('must not be called');
    });
    const exec = scriptedExec([]);
    const handle = createCodexTransportWithFallback(start, undefined, {
      detect,
      createAppServerTransport: appServer.create,
      createExecTransport: exec.create,
    });
    const collected = collect(handle.events);
    await handle.cancel();
    resolveDetect(baseStatus());
    expect(await collected).toEqual([{ type: 'session.cancelled' }]);
    expect(exec.calls()).toBe(0);
  });

  it('delegates cancel() to the app-server attempt while it is still being decided (pre-commit, nothing external visible yet)', async () => {
    // Nothing is externally observable from the outer handle at this point by design (the
    // buffering commits only once turn/start is attempted or the attempt fails) -- so this test
    // observes the app-server fake's own creation instead of reading an event, to know `active` has
    // been set before it calls cancel().
    let releaseScript!: () => void;
    const held = new Promise<void>((resolve) => {
      releaseScript = resolve;
    });
    let createdResolve!: () => void;
    const created = new Promise<void>((resolve) => {
      createdResolve = resolve;
    });
    const appServer = scriptedTransport(async (channel) => {
      createdResolve();
      channel.push({ type: 'session.started', sessionId: start.sessionId, provider: 'codex' });
      await held;
      channel.push({ type: 'session.completed' });
      channel.close();
    });
    const handle = createCodexTransportWithFallback(start, undefined, {
      detect: async () => baseStatus(),
      createAppServerTransport: appServer.create,
    });
    await created;
    await handle.cancel();
    expect(appServer.cancelCalls()).toBe(1);
    releaseScript();
  });
});
