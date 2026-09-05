import { describe, expect, it, vi } from 'vitest';
import {
  ApplicationQueueRelay,
  type ApplicationQueueEvent,
  type ApplicationQueueEventSource,
} from '../electron/application-queue-relay.js';

/** A controllable fake SSE stream, mirroring `agent-workspace-relay.test.ts`'s `makeSource`. */
function makeSource(): {
  source: ApplicationQueueEventSource;
  emit(event: ApplicationQueueEvent): Promise<void>;
  end(): void;
  fail(error: Error): void;
  opened: number;
  lastEventIds: Array<string | undefined>;
  aborted(): boolean;
} {
  const queue: ApplicationQueueEvent[] = [];
  let waiter: (() => void) | undefined;
  let ended = false;
  let failure: Error | undefined;
  let signal: AbortSignal | undefined;
  let opened = 0;
  const lastEventIds: Array<string | undefined> = [];

  const wake = () => {
    if (waiter) {
      const w = waiter;
      waiter = undefined;
      w();
    }
  };

  const source: ApplicationQueueEventSource = {
    events(options) {
      opened += 1;
      lastEventIds.push(options.lastEventId);
      signal = options.signal;
      return {
        async *[Symbol.asyncIterator]() {
          for (;;) {
            while (queue.length > 0) yield queue.shift() as ApplicationQueueEvent;
            if (failure) throw failure;
            if (ended) return;
            if (options.signal.aborted) return;
            await new Promise<void>((resolve) => (waiter = resolve));
          }
        },
      };
    },
  };

  return {
    source,
    async emit(event) {
      queue.push(event);
      wake();
      await Promise.resolve();
      await Promise.resolve();
    },
    end() {
      ended = true;
      wake();
    },
    fail(error) {
      failure = error;
      wake();
    },
    get opened() {
      return opened;
    },
    lastEventIds,
    aborted: () => signal?.aborted === true,
  };
}

const EVENT_A: ApplicationQueueEvent = { seq: 0, at: '2026-01-01T00:00:00.000Z', type: 'enqueued', attemptId: 'a1' };
const EVENT_B: ApplicationQueueEvent = { seq: 1, at: '2026-01-01T00:00:01.000Z', type: 'lease_acquired', attemptId: 'a1' };

describe('ApplicationQueueRelay', () => {
  it('delivers events pushed on the stream', async () => {
    const { source, emit } = makeSource();
    const pushed: ApplicationQueueEvent[] = [];
    const relay = new ApplicationQueueRelay({ client: () => source, push: (e) => pushed.push(e) });

    relay.attach();
    await emit(EVENT_A);
    await emit(EVENT_B);

    expect(pushed).toEqual([EVENT_A, EVENT_B]);
  });

  it('is idempotent: a second attach while already streaming does not open a second connection', async () => {
    const { source, emit } = makeSource();
    const pushed: ApplicationQueueEvent[] = [];
    const relay = new ApplicationQueueRelay({ client: () => source, push: (e) => pushed.push(e) });

    relay.attach();
    relay.attach();
    relay.attach();
    await emit(EVENT_A);

    expect(pushed).toEqual([EVENT_A]); // not delivered three times
  });

  it('does nothing when no client is available yet', () => {
    const pushed: ApplicationQueueEvent[] = [];
    const relay = new ApplicationQueueRelay({ client: () => undefined, push: (e) => pushed.push(e) });
    expect(() => relay.attach()).not.toThrow();
    expect(relay.isAttached).toBe(false);
  });

  it('detach aborts the underlying stream', async () => {
    const { source, aborted } = makeSource();
    const relay = new ApplicationQueueRelay({ client: () => source, push: () => {} });
    relay.attach();
    expect(relay.isAttached).toBe(true);
    relay.detach();
    expect(aborted()).toBe(true);
    expect(relay.isAttached).toBe(false);
  });

  it('resumes from the last delivered seq on a fresh attach after a stream ends', async () => {
    const { source, emit, end, lastEventIds } = makeSource();
    const relay = new ApplicationQueueRelay({ client: () => source, push: () => {} });

    relay.attach();
    expect(lastEventIds).toEqual([undefined]);
    await emit(EVENT_B); // seq 1
    end();
    await Promise.resolve();
    await Promise.resolve();
    expect(relay.isAttached).toBe(false);

    relay.attach();
    expect(lastEventIds).toEqual([undefined, '1']);
  });

  it('reports a stream failure via onEvent without throwing, and clears isAttached', async () => {
    const { source, fail } = makeSource();
    const onEvent = vi.fn();
    const relay = new ApplicationQueueRelay({ client: () => source, push: () => {}, onEvent });

    relay.attach();
    fail(new Error('socket reset'));
    await Promise.resolve();
    await Promise.resolve();

    expect(relay.isAttached).toBe(false);
    expect(onEvent).toHaveBeenCalledWith(
      'the application queue stream ended unexpectedly',
      expect.objectContaining({ error: 'socket reset' }),
    );
  });

  it('never reports a failure or leaves isAttached true after a deliberate detach', async () => {
    const { source, fail } = makeSource();
    const onEvent = vi.fn();
    const relay = new ApplicationQueueRelay({ client: () => source, push: () => {}, onEvent });

    relay.attach();
    relay.detach();
    // A failure racing in after detach must not be reported: the caller already knows it's gone.
    fail(new Error('too late'));
    await Promise.resolve();
    await Promise.resolve();

    expect(onEvent).not.toHaveBeenCalled();
  });
});
