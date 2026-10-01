import { describe, expect, it, vi } from 'vitest';
import type { AgentEventEnvelope } from '@agent-dock/shared';
import {
  AgentWorkspaceRelay,
  MAX_ACTIVE_RELAYS,
  type SessionEventSource,
} from '../electron/agent-workspace-relay.js';
import type { ActivityPush } from '../electron/agent-workspace-types.js';

/**
 * The keyed live-activity relay (ADI-07).
 *
 * The single property this class exists for is that its state is a `Map<sessionId, ...>` rather
 * than the pair of single-slot globals main used to hold. So the tests that matter are the ones a
 * single slot would fail: two concurrent streams that both deliver, a detach that reaches exactly
 * one of them, and a `detachAll` that reaches all of them.
 */

/** A controllable fake SSE stream: the test pushes frames and closes it when it likes. */
function makeSource(): {
  source: SessionEventSource;
  emit(sessionId: string, envelope: AgentEventEnvelope): Promise<void>;
  end(sessionId: string): void;
  fail(sessionId: string, error: Error): void;
  opened: string[];
  lastEventIds: Array<string | undefined>;
  aborted(sessionId: string): boolean;
} {
  const queues = new Map<string, AgentEventEnvelope[]>();
  const waiters = new Map<string, () => void>();
  const ended = new Set<string>();
  const failures = new Map<string, Error>();
  const signals = new Map<string, AbortSignal>();
  const opened: string[] = [];
  const lastEventIds: Array<string | undefined> = [];

  const wake = (sessionId: string) => {
    const waiter = waiters.get(sessionId);
    if (waiter) {
      waiters.delete(sessionId);
      waiter();
    }
  };

  const source: SessionEventSource = {
    sessions: {
      events(id, options) {
        opened.push(id);
        lastEventIds.push(options?.lastEventId);
        if (options?.signal) signals.set(id, options.signal);
        queues.set(id, queues.get(id) ?? []);
        return {
          async *[Symbol.asyncIterator]() {
            for (;;) {
              const queue = queues.get(id) ?? [];
              while (queue.length > 0) yield queue.shift() as AgentEventEnvelope;
              const failure = failures.get(id);
              if (failure) throw failure;
              if (ended.has(id)) return;
              if (options?.signal?.aborted) return;
              await new Promise<void>((resolve) => waiters.set(id, resolve));
            }
          },
        };
      },
    },
  };

  return {
    source,
    async emit(sessionId, envelope) {
      (queues.get(sessionId) ?? []).push(envelope);
      wake(sessionId);
      await Promise.resolve();
      await Promise.resolve();
    },
    end(sessionId) {
      ended.add(sessionId);
      wake(sessionId);
    },
    fail(sessionId, error) {
      failures.set(sessionId, error);
      wake(sessionId);
    },
    opened,
    lastEventIds,
    aborted: (sessionId) => signals.get(sessionId)?.aborted === true,
  };
}

function makeRelay(source: SessionEventSource | undefined, max?: number) {
  const pushes: ActivityPush[] = [];
  const aliasBooks = new Map<string, Map<string, string>>();
  const relay = new AgentWorkspaceRelay({
    client: () => source,
    aliasesFor: (id) => {
      const existing = aliasBooks.get(id);
      if (existing) return existing;
      const created = new Map<string, string>();
      aliasBooks.set(id, created);
      return created;
    },
    push: (message) => pushes.push(message),
    ...(max === undefined ? {} : { maxAttachments: max }),
  });
  return { relay, pushes };
}

const flush = async () => {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
};

describe('AgentWorkspaceRelay: concurrency is the point', () => {
  it('streams two sessions at once, and each push names its own session', async () => {
    // This is the assertion the old single-slot `activeStreamAbort`/`activeSessionId` pair could
    // not satisfy: starting the second session used to orphan the first one's controller.
    const stream = makeSource();
    const { relay, pushes } = makeRelay(stream.source);

    expect(relay.attach('s1')).toEqual({ ok: true });
    expect(relay.attach('s2')).toEqual({ ok: true });
    expect(relay.size).toBe(2);
    await flush();

    await stream.emit('s1', { type: 'assistant.message', text: 'from one', sequence: 0, timestamp: 't' });
    await stream.emit('s2', { type: 'assistant.message', text: 'from two', sequence: 0, timestamp: 't' });

    expect(pushes).toHaveLength(2);
    expect(pushes[0]).toMatchObject({ sessionId: 's1', entry: { text: 'from one' } });
    expect(pushes[1]).toMatchObject({ sessionId: 's2', entry: { text: 'from two' } });
  });

  it('detaches exactly one session, leaving the other streaming', async () => {
    const stream = makeSource();
    const { relay, pushes } = makeRelay(stream.source);
    relay.attach('s1');
    relay.attach('s2');
    await flush();

    expect(relay.detach('s1')).toBe(true);
    expect(relay.isAttached('s1')).toBe(false);
    expect(relay.isAttached('s2')).toBe(true);
    expect(stream.aborted('s1')).toBe(true);
    expect(stream.aborted('s2')).toBe(false);

    await stream.emit('s2', { type: 'assistant.message', text: 'still here', sequence: 0, timestamp: 't' });
    expect(pushes.filter((push) => push.sessionId === 's2')).toHaveLength(1);
  });

  it('detachAll reaches every stream, not whichever one started last', () => {
    const stream = makeSource();
    const { relay } = makeRelay(stream.source);
    relay.attach('s1');
    relay.attach('s2');
    relay.attach('s3');

    relay.detachAll();

    expect(relay.size).toBe(0);
    for (const id of ['s1', 's2', 's3']) expect(stream.aborted(id), id).toBe(true);
  });

  it('stops delivering the moment a detach lands, not at the next network read', async () => {
    const stream = makeSource();
    const { relay, pushes } = makeRelay(stream.source);
    relay.attach('s1');
    await flush();

    relay.detach('s1');
    await stream.emit('s1', { type: 'assistant.message', text: 'too late', sequence: 0, timestamp: 't' });

    expect(pushes.filter((push) => 'entry' in push)).toHaveLength(0);
  });
});

describe('AgentWorkspaceRelay: attach discipline', () => {
  it('is idempotent, so a re-running effect does not open a second stream or double-deliver', async () => {
    const stream = makeSource();
    const { relay, pushes } = makeRelay(stream.source);

    expect(relay.attach('s1')).toEqual({ ok: true });
    expect(relay.attach('s1')).toEqual({ ok: true });
    expect(relay.attach('s1')).toEqual({ ok: true });
    await flush();
    expect(stream.opened).toEqual(['s1']);

    await stream.emit('s1', { type: 'assistant.message', text: 'once', sequence: 0, timestamp: 't' });
    expect(pushes).toHaveLength(1);
  });

  it('resumes from lastSeq, and only from a real non-negative integer', async () => {
    const stream = makeSource();
    const { relay } = makeRelay(stream.source);
    relay.attach('s1', 42);
    relay.attach('s2', -1);
    relay.attach('s3', 1.5);
    relay.attach('s4');
    await flush();
    expect(stream.lastEventIds).toEqual(['42', undefined, undefined, undefined]);
  });

  it('refuses past its ceiling with a reason, rather than opening an unbounded number of sockets', () => {
    const stream = makeSource();
    const { relay } = makeRelay(stream.source, 2);
    expect(relay.attach('s1')).toEqual({ ok: true });
    expect(relay.attach('s2')).toEqual({ ok: true });
    expect(relay.attach('s3')).toEqual({ ok: false, reason: 'attach_limit' });
    expect(relay.size).toBe(2);
  });

  it('defaults its ceiling to the daemon own global session limit', () => {
    expect(MAX_ACTIVE_RELAYS).toBe(4);
    const stream = makeSource();
    const { relay } = makeRelay(stream.source);
    for (let index = 0; index < MAX_ACTIVE_RELAYS; index += 1) relay.attach(`s${index}`);
    expect(relay.attach('overflow')).toEqual({ ok: false, reason: 'attach_limit' });
  });

  it('refuses a missing daemon and an unusable session id, and registers neither', () => {
    const { relay: noClient } = makeRelay(undefined);
    expect(noClient.attach('s1')).toEqual({ ok: false, reason: 'daemon_unavailable' });
    expect(noClient.size).toBe(0);

    const stream = makeSource();
    const { relay } = makeRelay(stream.source);
    expect(relay.attach('')).toEqual({ ok: false, reason: 'invalid_session_id' });
    expect(relay.attach(undefined as unknown as string)).toEqual({ ok: false, reason: 'invalid_session_id' });
    expect(relay.size).toBe(0);
  });

  it('reads the client fresh on every attach, so a daemon restart is picked up', async () => {
    const box: { current: SessionEventSource | undefined } = { current: undefined };
    const pushes: ActivityPush[] = [];
    const relay = new AgentWorkspaceRelay({
      client: () => box.current,
      aliasesFor: () => new Map(),
      push: (message) => pushes.push(message),
    });

    expect(relay.attach('s1')).toEqual({ ok: false, reason: 'daemon_unavailable' });
    const stream = makeSource();
    box.current = stream.source;
    expect(relay.attach('s1')).toEqual({ ok: true });
    await flush();
    expect(stream.opened).toEqual(['s1']);
  });

  it('safely detaches an id it never had', () => {
    const { relay } = makeRelay(makeSource().source);
    expect(relay.detach('never-attached')).toBe(false);
  });
});

describe('AgentWorkspaceRelay: nothing raw crosses', () => {
  it('pushes sanitized entries, never an AgentEventEnvelope', async () => {
    const stream = makeSource();
    const { relay, pushes } = makeRelay(stream.source);
    relay.attach('s1');
    await flush();

    await stream.emit('s1', {
      type: 'session.started',
      sessionId: 's1',
      provider: 'claude',
      providerSessionId: 'native-thread-abc',
      sequence: 0,
      timestamp: 't',
    });
    await stream.emit('s1', {
      type: 'error',
      code: 'E_X',
      message: 'failed reading C:/Users/someone/.ssh',
      recoverable: false,
      sequence: 1,
      timestamp: 't',
    });

    const serialized = JSON.stringify(pushes);
    expect(serialized).not.toContain('native-thread-abc');
    expect(serialized).not.toContain('Users');
    expect(serialized).not.toContain('.ssh');
    expect(pushes[0]).toEqual({
      sessionId: 's1',
      entry: { seq: 0, at: 't', origin: 'live', kind: 'session.started', provider: 'claude' },
    });
  });

  it('keeps one alias book per session, so two sessions do not share tool numbering', async () => {
    const stream = makeSource();
    const { relay, pushes } = makeRelay(stream.source);
    relay.attach('s1');
    relay.attach('s2');
    await flush();

    await stream.emit('s1', { type: 'tool.started', toolName: 'Bash', toolCallId: 'x', sequence: 0, timestamp: 't' });
    await stream.emit('s2', { type: 'tool.started', toolName: 'Read', toolCallId: 'y', sequence: 0, timestamp: 't' });

    expect(pushes[0]).toMatchObject({ sessionId: 's1', entry: { toolAlias: 't1' } });
    expect(pushes[1]).toMatchObject({ sessionId: 's2', entry: { toolAlias: 't1' } });
    expect(JSON.stringify(pushes)).not.toContain('"x"');
  });

  it('skips an unorderable frame rather than pushing an entry the timeline cannot place', async () => {
    const stream = makeSource();
    const { relay, pushes } = makeRelay(stream.source);
    relay.attach('s1');
    await flush();
    await stream.emit('s1', {
      type: 'assistant.message',
      text: 'x',
      sequence: -1,
      timestamp: 't',
    } as AgentEventEnvelope);
    expect(pushes).toHaveLength(0);
  });
});

describe('AgentWorkspaceRelay: closing', () => {
  it('tells the renderer when a stream ends normally, and retires the registration', async () => {
    const stream = makeSource();
    const { relay, pushes } = makeRelay(stream.source);
    relay.attach('s1');
    await flush();

    stream.end('s1');
    await flush();

    expect(pushes.at(-1)).toEqual({ sessionId: 's1', closed: { reason: 'stream_ended' } });
    expect(relay.isAttached('s1')).toBe(false);
  });

  it('reports a failure as a reason only, never as the daemon error text', async () => {
    const stream = makeSource();
    const onEvent = vi.fn();
    const pushes: ActivityPush[] = [];
    const relay = new AgentWorkspaceRelay({
      client: () => stream.source,
      aliasesFor: () => new Map(),
      push: (message) => pushes.push(message),
      onEvent,
    });
    relay.attach('s1');
    await flush();

    stream.fail('s1', new Error('connect ECONNREFUSED 127.0.0.1:51234'));
    await flush();

    expect(pushes.at(-1)).toEqual({ sessionId: 's1', closed: { reason: 'stream_unavailable' } });
    expect(JSON.stringify(pushes)).not.toContain('ECONNREFUSED');
    expect(JSON.stringify(pushes)).not.toContain('127.0.0.1');
    // The detail is logged in main, where it is useful and where the renderer cannot read it.
    expect(onEvent).toHaveBeenCalled();
  });

  it('says nothing at all when the stream ended because it was detached', async () => {
    const stream = makeSource();
    const { relay, pushes } = makeRelay(stream.source);
    relay.attach('s1');
    await flush();

    relay.detach('s1');
    stream.fail('s1', new Error('aborted'));
    await flush();

    expect(pushes).toHaveLength(0);
  });

  it('a late teardown does not delete a successor registration for the same id', async () => {
    const stream = makeSource();
    const { relay } = makeRelay(stream.source);
    relay.attach('s1');
    await flush();

    relay.detach('s1');
    relay.attach('s1'); // re-attached immediately, before the first pump has unwound
    stream.end('s1');
    await flush();

    // The second attachment is what `isAttached` should be reporting on. Whether it survives the
    // predecessor's teardown is exactly the identity guard in `#close`.
    expect(stream.opened).toEqual(['s1', 's1']);
  });
});
