import { describe, expect, it, vi } from 'vitest';
import type { AgentEventEnvelope } from '@agent-dock/shared';
import { BoundedSseWriter, type SseOutput } from '../src/sse-writer.js';

class TestOutput implements SseOutput {
  readonly writes: string[] = [];
  readonly endings: Array<string | undefined> = [];
  private drainListener: (() => void) | undefined;

  constructor(private readonly readiness: boolean[] = []) {}

  write(chunk: string): boolean {
    this.writes.push(chunk);
    return this.readiness.shift() ?? true;
  }

  end(chunk?: string): void {
    this.endings.push(chunk);
  }

  once(_event: 'drain', listener: () => void): void {
    this.drainListener = listener;
  }

  drain(): void {
    const listener = this.drainListener;
    this.drainListener = undefined;
    listener?.();
  }
}

function messageEvent(sequence: number, size = 1): AgentEventEnvelope {
  return { type: 'assistant.message', text: 'x'.repeat(size), sequence, timestamp: '2026-08-31T00:00:00.000Z' };
}

function terminalEvent(sequence: number): AgentEventEnvelope {
  return { type: 'session.completed', sequence, timestamp: '2026-08-31T00:00:00.000Z' };
}

function frameData(frame: string | undefined): unknown {
  const data = frame?.split('\n').find((line) => line.startsWith('data: '));
  return data ? JSON.parse(data.slice('data: '.length)) : undefined;
}

describe('BoundedSseWriter (ADI-17)', () => {
  it('writes immediately, queues under backpressure, and ends only after a queued terminal drains', () => {
    const output = new TestOutput([true, false, true, false]);
    const onClose = vi.fn();
    const writer = new BoundedSseWriter(output, onClose);

    writer.write(messageEvent(0));
    writer.write(messageEvent(1));
    writer.write(messageEvent(2));
    writer.write(terminalEvent(3));

    expect(output.writes).toHaveLength(2);
    expect(output.endings).toEqual([]);
    expect(onClose).not.toHaveBeenCalled();

    output.drain();

    expect(output.writes.map(frameData)).toEqual([messageEvent(0), messageEvent(1), messageEvent(2), terminalEvent(3)]);
    expect(output.endings).toEqual([]);
    expect(onClose).not.toHaveBeenCalled();

    output.drain();

    expect(output.endings).toEqual([undefined]);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('stamps every frame with the SSE id: line matching the event sequence', () => {
    const output = new TestOutput();
    const writer = new BoundedSseWriter(output, vi.fn());
    writer.write(messageEvent(42));
    expect(output.writes[0]).toMatch(/^id: 42\nevent: assistant\.message\ndata: /);
  });

  it('does not discard a queued terminal frame when finishReplay() is also called', () => {
    const output = new TestOutput([false, true]);
    const onClose = vi.fn();
    const writer = new BoundedSseWriter(output, onClose);

    writer.start();
    writer.write(terminalEvent(0));
    writer.finishReplay(); // a no-op here: a terminal event was already written

    expect(output.endings).toEqual([]);
    output.drain();
    expect(output.writes.map(frameData)).toEqual([undefined, terminalEvent(0)]);
    expect(output.endings).toEqual([undefined]);
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('finishReplay() closes the connection when nothing terminal was ever written -- the reconnect-past-terminal case', () => {
    const output = new TestOutput();
    const onClose = vi.fn();
    const writer = new BoundedSseWriter(output, onClose);

    writer.start();
    writer.write(messageEvent(0)); // a non-terminal event; nothing terminal follows
    writer.finishReplay();

    expect(output.endings).toEqual([undefined]);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('ends the connection with no extra frame on overflow -- v1 has no wire-level overflow signal -- and terminates only this subscriber', () => {
    const output = new TestOutput([false]);
    const onClose = vi.fn();
    const writer = new BoundedSseWriter(output, onClose);

    writer.write(messageEvent(0));
    for (let sequence = 1; sequence <= 257; sequence += 1) writer.write(messageEvent(sequence));

    expect(output.writes).toHaveLength(1); // only the first write ever reached the real socket
    expect(output.endings).toEqual([undefined]);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('applies the 4 MiB byte bound before the 256-event count bound', () => {
    const output = new TestOutput([false]);
    const writer = new BoundedSseWriter(output, vi.fn());

    writer.write(messageEvent(0));
    for (let sequence = 1; sequence <= 20 && output.endings.length === 0; sequence += 1) {
      writer.write(messageEvent(sequence, 256 * 1024));
    }

    expect(output.writes).toHaveLength(1);
    expect(output.endings).toEqual([undefined]); // overflowed well before 20 events at 256 KiB each
  });

  it('a slow subscriber that never drains is disconnected -- it never buffers indefinitely', () => {
    const output = new TestOutput([false]); // the very first write is already backpressured
    const onClose = vi.fn();
    const writer = new BoundedSseWriter(output, onClose);

    writer.write(messageEvent(0));
    for (let sequence = 1; sequence <= 300; sequence += 1) writer.write(messageEvent(sequence));

    // No matter how many more events arrive, this connection was closed once it overflowed --
    // never grew its queue past the bound waiting for a drain that never came.
    expect(onClose).toHaveBeenCalledTimes(1);
    for (let sequence = 301; sequence <= 400; sequence += 1) writer.write(messageEvent(sequence));
    expect(onClose).toHaveBeenCalledTimes(1); // still exactly once -- write() after close() is a no-op
  });

  it('keeps connection state independent between subscribers, and closes each subscription exactly once', () => {
    const blockedOutput = new TestOutput([false]);
    const readyOutput = new TestOutput([true]);
    const blockedClose = vi.fn();
    const readyClose = vi.fn();
    const blocked = new BoundedSseWriter(blockedOutput, blockedClose);
    const ready = new BoundedSseWriter(readyOutput, readyClose);

    blocked.write(messageEvent(0));
    ready.write(terminalEvent(0));

    expect(blockedOutput.endings).toEqual([]);
    expect(readyOutput.endings).toEqual([undefined]);
    expect(readyClose).toHaveBeenCalledTimes(1);

    blocked.close();
    blocked.close(); // idempotent
    blockedOutput.drain(); // a drain arriving after close() must not reopen anything
    expect(blockedClose).toHaveBeenCalledTimes(1);
    expect(blockedOutput.endings).toHaveLength(1);
  });

  it('an output.write() that throws ends the connection instead of propagating into the provider event producer', () => {
    const onClose = vi.fn();
    const throwingOutput: SseOutput = {
      write: () => {
        throw new Error('socket already destroyed');
      },
      end: vi.fn(),
      once: vi.fn(),
    };
    const writer = new BoundedSseWriter(throwingOutput, onClose);
    expect(() => writer.write(messageEvent(0))).not.toThrow();
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
