import { mkdtempSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AgentEvent } from '@agent-dock/shared';
import { createCodexAppServerTransport, type CodexAppServerTransportOptions } from '../src/providers/codex/app-server/transport.js';

const FIXTURE = fileURLToPath(new URL('./fixtures/fake-app-server-turn.mjs', import.meta.url));

let cwd: string;

beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), 'agent-dock-transport-test-'));
});

afterEach(async () => {
  await rm(cwd, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

function start(scenario: string, overrides: Partial<CodexAppServerTransportOptions> = {}) {
  return createCodexAppServerTransport({
    sessionId: 'transport-test-session',
    executable: process.execPath,
    executableArgs: [FIXTURE, scenario],
    cwd,
    prompt: 'say hello',
    processPlatform: 'linux',
    ...overrides,
  });
}

async function collect(events: AsyncGenerator<AgentEvent, void, void>): Promise<AgentEvent[]> {
  const out: AgentEvent[] = [];
  for await (const event of events) out.push(event);
  return out;
}

describe('createCodexAppServerTransport: successful turn', () => {
  it('starts with session.started and ends with exactly one session.completed, last', async () => {
    const handle = start('success');
    const events = await collect(handle.events);
    expect(events[0]).toMatchObject({ type: 'session.started', provider: 'codex', sessionId: 'transport-test-session' });
    const last = events.at(-1)!;
    expect(last).toEqual({ type: 'session.completed', providerSessionId: 'thread-fixture-1-via-start' });
    // Exactly one terminal event, and it really is last.
    const terminalTypes = new Set(['session.completed', 'session.failed', 'session.cancelled']);
    expect(events.filter((event) => terminalTypes.has(event.type))).toHaveLength(1);
  }, 10_000);

  it('emits the assistant.message content from the completed agentMessage item', async () => {
    const events = await collect(start('success').events);
    expect(events).toContainEqual({ type: 'assistant.message', text: 'hello from codex' });
  }, 10_000);
}, 15_000);

describe('createCodexAppServerTransport: failed turn', () => {
  it('ends with session.failed when turn/completed reports status: failed', async () => {
    const events = await collect(start('failure').events);
    expect(events.at(-1)).toEqual({ type: 'session.failed', message: 'Codex turn failed' });
  }, 10_000);
}, 15_000);

describe('createCodexAppServerTransport: launchProbe.onPromptDelivered (ADI-08 stage 7)', () => {
  it('fires exactly once, immediately before turn/start is written -- not before thread/start, not after the response', async () => {
    const calls: string[] = [];
    const events = await collect(
      start('success', {
        launchProbe: { onPromptDelivered: () => calls.push('onPromptDelivered') },
      }).events,
    );
    expect(events.at(-1)).toMatchObject({ type: 'session.completed' });
    expect(calls).toEqual(['onPromptDelivered']);
  }, 10_000);

  it('never fires when the session fails before turn/start is ever reached (malformed thread/start response)', async () => {
    const calls: string[] = [];
    const events = await collect(
      start('malformed-thread', {
        launchProbe: { onPromptDelivered: () => calls.push('onPromptDelivered') },
      }).events,
    );
    expect(events.at(-1)).toMatchObject({ type: 'session.failed' });
    expect(calls).toEqual([]);
  }, 10_000);

  it('still fires even when the turn itself later fails, since the write was genuinely attempted', async () => {
    const calls: string[] = [];
    const events = await collect(
      start('failure', {
        launchProbe: { onPromptDelivered: () => calls.push('onPromptDelivered') },
      }).events,
    );
    expect(events.at(-1)).toMatchObject({ type: 'session.failed' });
    expect(calls).toEqual(['onPromptDelivered']);
  }, 10_000);
});

describe('createCodexAppServerTransport: process failure with a genuinely in-flight request', () => {
  it('ends promptly in session.failed(PROCESS_FAILED) when the process exits while turn/start is unanswered', async () => {
    const startedAt = Date.now();
    const events = await collect(start('crash-mid-turn-start').events);
    const elapsedMs = Date.now() - startedAt;
    expect(events).toContainEqual(expect.objectContaining({ type: 'error', code: 'PROCESS_FAILED' }));
    expect(events.at(-1)).toMatchObject({ type: 'session.failed' });
    // turn/start's request is still pending in rpc.ts when the process dies here. Without
    // transport.ts's onFailure handler also calling rpc.fail() (not just finish()), that request's
    // Deferred never settles, run()'s `await rpc.request('turn/start', ...)` never returns, and
    // run() never reaches its `finally` block. This test cannot observe that internal hang
    // directly (nothing public awaits run() itself), but a prompt, bounded resolution here is at
    // least consistent with the fix, not the leak.
    expect(elapsedMs).toBeLessThan(5_000);
  }, 10_000);
});

describe('createCodexAppServerTransport: malformed responses fail closed', () => {
  it('ends with session.failed when thread/start\'s response has no valid thread id', async () => {
    const events = await collect(start('malformed-thread').events);
    expect(events.at(-1)).toMatchObject({ type: 'session.failed' });
  }, 10_000);
}, 15_000);

describe('createCodexAppServerTransport: cancellation', () => {
  it('cancel() drives a real turn/interrupt round trip and resolves fast, ending in session.cancelled', async () => {
    const handle = start('interrupt');
    const collected: AgentEvent[] = [];
    const iterator = handle.events;
    // Pull the first event (session.started) so the turn has genuinely started before cancelling.
    const first = await iterator.next();
    if (!first.done) collected.push(first.value);
    const startedAt = Date.now();
    await handle.cancel();
    const elapsedMs = Date.now() - startedAt;
    for await (const event of iterator) collected.push(event);
    expect(collected.at(-1)).toEqual({ type: 'session.cancelled' });
    const terminalTypes = new Set(['session.completed', 'session.failed', 'session.cancelled']);
    expect(collected.filter((event) => terminalTypes.has(event.type))).toHaveLength(1);
    // The fixture answers turn/interrupt immediately in this scenario. A broken cancel() that
    // never actually sent turn/interrupt would still end in session.cancelled via the
    // CANCEL_TERMINAL_WAIT_MS (5s) fallback -- this bound proves the fast, real-interrupt path
    // fired instead, not just that *some* path eventually produced the right terminal event.
    expect(elapsedMs).toBeLessThan(2_000);
  }, 10_000);

  it('cancel() falls back to its own timeout and self-resolves when the process never confirms the interrupt', async () => {
    const handle = start('interrupt-unresponsive');
    const collected: AgentEvent[] = [];
    const iterator = handle.events;
    // Pull events until the fixture's tool.started (from item/started(commandExecution)) proves
    // turn/start's response has genuinely landed and the turn is running -- not a guess at
    // subprocess/IPC timing. Only then is turn/interrupt (which this scenario never answers)
    // actually in flight when cancel() is called, so this test genuinely exercises the
    // CANCEL_TERMINAL_WAIT_MS fallback rather than racing an earlier `if (cancelled)` checkpoint.
    let sawToolStarted = false;
    while (!sawToolStarted) {
      const next = await iterator.next();
      if (next.done) throw new Error('session ended before tool.started was observed');
      collected.push(next.value);
      sawToolStarted = next.value.type === 'tool.started';
    }
    const startedAt = Date.now();
    await handle.cancel();
    const elapsedMs = Date.now() - startedAt;
    for await (const event of iterator) collected.push(event);
    expect(collected.at(-1)).toEqual({ type: 'session.cancelled' });
    const terminalTypes = new Set(['session.completed', 'session.failed', 'session.cancelled']);
    expect(collected.filter((event) => terminalTypes.has(event.type))).toHaveLength(1);
    // Proves cancel() actually waited out its own fallback timer rather than resolving some other,
    // faster way -- the fixture never answers turn/interrupt in this scenario, so the only path to
    // session.cancelled is CANCEL_TERMINAL_WAIT_MS (5s) elapsing.
    expect(elapsedMs).toBeGreaterThanOrEqual(4_500);
  }, 15_000);

  it('cancel() before the process even reaches thread/start resolves fast via the pre-thread checkpoint, not the timeout fallback', async () => {
    const handle = start('hang');
    const first = await handle.events.next();
    expect(first.done).toBe(false);
    const startedAt = Date.now();
    await handle.cancel();
    const elapsedMs = Date.now() - startedAt;
    const rest: AgentEvent[] = [];
    for await (const event of handle.events) rest.push(event);
    expect(rest.at(-1)).toEqual({ type: 'session.cancelled' });
    // No threadId/turnId ever existed in this scenario, so cancel() cannot send turn/interrupt at
    // all -- it must be the `if (cancelled)` checkpoint right after model/list (run()'s earliest
    // cancellation exit) that ends the session here, well before CANCEL_TERMINAL_WAIT_MS (5s).
    expect(elapsedMs).toBeLessThan(2_000);
  }, 15_000);

  it('cancel() is safe to call after the session has already completed naturally', async () => {
    const handle = start('success');
    const events = await collect(handle.events);
    expect(events.at(-1)).toMatchObject({ type: 'session.completed' });
    // Must not throw, and must not somehow re-open or duplicate a terminal event.
    await expect(handle.cancel()).resolves.toBeUndefined();
  }, 10_000);
});

describe('createCodexAppServerTransport: resume', () => {
  it('calls thread/resume, not thread/start, when resumeProviderSessionId is supplied', async () => {
    const handle = start('success', { resumeProviderSessionId: 'thread-from-a-prior-turn' });
    const events = await collect(handle.events);
    // The fixture encodes which method it actually received into the returned thread id, so this
    // distinguishes a real thread/resume call from a wrong thread/start call the fixture would
    // otherwise silently accept identically.
    expect(events.at(-1)).toEqual({ type: 'session.completed', providerSessionId: 'thread-fixture-1-via-resume' });
  }, 10_000);

  it('calls thread/start, not thread/resume, when no resumeProviderSessionId is supplied', async () => {
    const events = await collect(start('success').events);
    expect(events.at(-1)).toEqual({ type: 'session.completed', providerSessionId: 'thread-fixture-1-via-start' });
  }, 10_000);
});
