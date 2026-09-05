import { describe, expect, it, vi } from 'vitest';
import type { AgentEvent, AgentEventEnvelope } from '@agent-dock/shared';
import { FIELD_MAP_GENERATION_TIMEOUT_MS, runFieldMapGeneration } from '../electron/application-generation-runner.js';

/**
 * A minimal stand-in for the slice of `AgentDockClient` this runner actually calls. Typed loosely
 * (not `AgentDockClient` itself) because constructing a real one requires a live `fetch` and a
 * protocol-compatibility round trip this file has no interest in faking.
 */
interface FakeClient {
  sessions: {
    createFieldMapGeneration: ReturnType<typeof vi.fn>;
    events: ReturnType<typeof vi.fn>;
    cancel: ReturnType<typeof vi.fn>;
  };
}

function envelope(event: AgentEvent): AgentEventEnvelope {
  return { ...event, sequence: 0, timestamp: new Date().toISOString() } as AgentEventEnvelope;
}

async function* eventsOf(events: AgentEvent[]): AsyncGenerator<AgentEventEnvelope, void, void> {
  for (const event of events) yield envelope(event);
}

type EventsFactory = (signal: AbortSignal) => AsyncGenerator<AgentEventEnvelope, void, void>;

function fakeClient(events: AgentEvent[] | EventsFactory): FakeClient {
  return {
    sessions: {
      createFieldMapGeneration: vi.fn().mockResolvedValue({
        id: 'sess-1',
        provider: 'claude',
        cwd: '/tmp',
        prompt: 'map these fields',
        status: 'starting',
        startedAt: new Date().toISOString(),
      }),
      events: vi
        .fn()
        .mockImplementation((_id: string, options?: { signal?: AbortSignal }) =>
          Array.isArray(events) ? eventsOf(events) : events(options?.signal ?? new AbortController().signal),
        ),
      cancel: vi.fn().mockResolvedValue(undefined),
    },
  };
}

const INPUT = { provider: 'claude' as const, cwd: '/tmp', prompt: 'map these fields' };

describe('runFieldMapGeneration', () => {
  it('creates the session through the dedicated field-map-generation call, not the general one', async () => {
    const client = fakeClient([
      { type: 'assistant.message', text: '{"assignments":[]}' },
      { type: 'session.completed' },
    ]);
    await runFieldMapGeneration(client as never, INPUT);
    expect(client.sessions.createFieldMapGeneration).toHaveBeenCalledWith(INPUT);
  });

  it('joins assistant.message chunks with no separator, so one JSON object stays parseable', async () => {
    const client = fakeClient([
      { type: 'assistant.message', text: '{"assignments":' },
      { type: 'assistant.message', text: '[]}' },
      { type: 'session.completed' },
    ]);
    const result = await runFieldMapGeneration(client as never, INPUT);
    expect(result.ok).toBe(true);
    expect(result.text).toBe('{"assignments":[]}');
    expect(() => JSON.parse(result.text)).not.toThrow();
  });

  it('reports session.completed with no text as a failure, not an empty success', async () => {
    const client = fakeClient([{ type: 'session.completed' }]);
    const result = await runFieldMapGeneration(client as never, INPUT);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/finished without returning any text/);
  });

  it('reports session.failed as a failure carrying the daemon-supplied message', async () => {
    const client = fakeClient([{ type: 'session.failed', message: 'the provider crashed' }]);
    const result = await runFieldMapGeneration(client as never, INPUT);
    expect(result.ok).toBe(false);
    expect(result.error).toBe('the provider crashed');
  });

  it('reports session.cancelled as a failure', async () => {
    const client = fakeClient([{ type: 'session.cancelled' }]);
    const result = await runFieldMapGeneration(client as never, INPUT);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/cancelled/);
  });

  it('treats a non-recoverable error event as immediately terminal', async () => {
    const client = fakeClient([
      { type: 'error', message: 'event stream failed: socket hang up', recoverable: false },
      // A well-behaved daemon never emits after a non-recoverable error, but this runner must not
      // depend on that -- it should already have decided the outcome by the time this arrives.
      { type: 'assistant.message', text: 'too late' },
    ]);
    const result = await runFieldMapGeneration(client as never, INPUT);
    expect(result.ok).toBe(false);
    expect(result.error).toBe('event stream failed: socket hang up');
  });

  it('keeps a recoverable error as a fallback message, not an immediate failure', async () => {
    const client = fakeClient([
      { type: 'error', message: 'a recoverable hiccup', recoverable: true },
      { type: 'assistant.message', text: '{}' },
      { type: 'session.completed' },
    ]);
    const result = await runFieldMapGeneration(client as never, INPUT);
    expect(result.ok).toBe(true);
    expect(result.text).toBe('{}');
  });

  it('times out and cancels the session when the stream never reaches a terminal event', async () => {
    vi.useFakeTimers();
    try {
      // Mirrors what a real aborted fetch does to the client's SSE generator: it never yields
      // another event and instead throws once the signal fires -- see `streamSessionEvents` and
      // `main.ts`'s own `forwardSessionEvents`, which distinguishes this from a real failure by
      // checking `controller.signal.aborted` in the catch block, exactly as this runner does.
      const client = fakeClient(async function* (signal: AbortSignal): AsyncGenerator<AgentEventEnvelope, void, void> {
        await new Promise((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
        });
        yield envelope({ type: 'session.completed' }); // unreachable; satisfies require-yield
      });
      const resultPromise = runFieldMapGeneration(client as never, INPUT);
      await vi.advanceTimersByTimeAsync(FIELD_MAP_GENERATION_TIMEOUT_MS);
      const result = await resultPromise;
      expect(result.ok).toBe(false);
      expect(result.error).toMatch(/no response after/);
      expect(client.sessions.cancel).toHaveBeenCalledWith('sess-1');
    } finally {
      vi.useRealTimers();
    }
  });

  it('propagates a genuinely unexpected error instead of swallowing it as a timeout', async () => {
    const client = fakeClient(async function* (): AsyncGenerator<AgentEventEnvelope, void, void> {
      throw new Error('daemon unreachable');
      yield envelope({ type: 'session.completed' }); // unreachable; satisfies require-yield
    });
    await expect(runFieldMapGeneration(client as never, INPUT)).rejects.toThrow('daemon unreachable');
  });
});
