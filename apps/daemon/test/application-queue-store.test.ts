import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  ApplicationQueueInvalidTransitionError,
  ApplicationQueueNotFoundError,
  ApplicationQueueStore,
} from '../src/application-queue-store.js';

let stateRoot: string;

beforeEach(() => {
  stateRoot = mkdtempSync(join(tmpdir(), 'ovr-application-queue-'));
});

afterEach(() => {
  rmSync(stateRoot, { recursive: true, force: true });
});

describe('enqueue', () => {
  it('adds a new attempt as queued', () => {
    const store = new ApplicationQueueStore({ stateRoot });
    const entry = store.enqueue('attempt-1');
    expect(entry.state).toBe('queued');
    expect(store.list()).toHaveLength(1);
  });

  it('is idempotent for an attempt already tracked in a non-terminal state', () => {
    const store = new ApplicationQueueStore({ stateRoot });
    const first = store.enqueue('attempt-1');
    store.acquireNextLease(); // now 'active'
    const second = store.enqueue('attempt-1');
    expect(second.state).toBe('active');
    expect(store.list()).toHaveLength(1);
    expect(second.queuedAt).toBe(first.queuedAt);
  });

  it('replaces a terminal entry rather than refusing a genuinely new attempt', () => {
    const store = new ApplicationQueueStore({ stateRoot });
    store.enqueue('attempt-1');
    const lease = store.acquireNextLease()!;
    store.release(lease.leaseId, 'completed');
    expect(store.get('attempt-1')!.state).toBe('done');

    const reEnqueued = store.enqueue('attempt-1');
    expect(reEnqueued.state).toBe('queued');
    expect(store.list()).toHaveLength(1);
  });
});

describe('single-worker lease', () => {
  it('acquires the oldest queued entry', () => {
    const store = new ApplicationQueueStore({ stateRoot });
    store.enqueue('attempt-1');
    store.enqueue('attempt-2');
    const lease = store.acquireNextLease();
    expect(lease?.attemptId).toBe('attempt-1');
    expect(store.get('attempt-1')!.state).toBe('active');
  });

  it('refuses to grant a second lease while one is held', () => {
    const store = new ApplicationQueueStore({ stateRoot });
    store.enqueue('attempt-1');
    store.enqueue('attempt-2');
    store.acquireNextLease();
    expect(store.acquireNextLease()).toBeNull();
    expect(store.get('attempt-2')!.state).toBe('queued');
  });

  it('returns null rather than throwing when there is nothing to schedule', () => {
    const store = new ApplicationQueueStore({ stateRoot });
    expect(store.acquireNextLease()).toBeNull();
  });

  it('hands the lease to the next queued entry once the current one is released', () => {
    const store = new ApplicationQueueStore({ stateRoot });
    store.enqueue('attempt-1');
    store.enqueue('attempt-2');
    const first = store.acquireNextLease()!;
    store.release(first.leaseId, 'completed');
    const second = store.acquireNextLease();
    expect(second?.attemptId).toBe('attempt-2');
  });

  it('ignores a release for a lease id that no longer matches the current lease', () => {
    const store = new ApplicationQueueStore({ stateRoot });
    store.enqueue('attempt-1');
    const lease = store.acquireNextLease()!;
    store.release('some-other-lease-id', 'completed');
    // The real lease is untouched: still held, entry still active.
    expect(store.currentLease()?.leaseId).toBe(lease.leaseId);
    expect(store.get('attempt-1')!.state).toBe('active');
  });

  it('requeues on a graceful handoff rather than marking the attempt terminal', () => {
    const store = new ApplicationQueueStore({ stateRoot });
    store.enqueue('attempt-1');
    const lease = store.acquireNextLease()!;
    store.release(lease.leaseId, 'requeue');
    expect(store.get('attempt-1')!.state).toBe('queued');
    expect(store.currentLease()).toBeNull();
  });
});

describe('pause / resume / skip / cancel', () => {
  it('pauses a queued entry and releases its lease if it was the active one', () => {
    const store = new ApplicationQueueStore({ stateRoot });
    store.enqueue('attempt-1');
    const lease = store.acquireNextLease()!;
    const paused = store.pause('attempt-1');
    expect(paused.state).toBe('paused');
    expect(store.currentLease()).toBeNull();
    expect(lease.attemptId).toBe('attempt-1'); // sanity: this was in fact the leased attempt
  });

  it('resumes a paused entry back to queued, eligible for scheduling again', () => {
    const store = new ApplicationQueueStore({ stateRoot });
    store.enqueue('attempt-1');
    store.pause('attempt-1');
    const resumed = store.resume('attempt-1');
    expect(resumed.state).toBe('queued');
    expect(store.acquireNextLease()?.attemptId).toBe('attempt-1');
  });

  it('refuses to resume an entry that is not paused', () => {
    const store = new ApplicationQueueStore({ stateRoot });
    store.enqueue('attempt-1');
    expect(() => store.resume('attempt-1')).toThrow(ApplicationQueueInvalidTransitionError);
  });

  it('skip and cancel both leave the entry cancelled', () => {
    const store = new ApplicationQueueStore({ stateRoot });
    store.enqueue('attempt-1');
    store.enqueue('attempt-2');
    expect(store.skip('attempt-1').state).toBe('cancelled');
    expect(store.cancel('attempt-2').state).toBe('cancelled');
  });

  it('refuses to skip or cancel an already-terminal entry', () => {
    const store = new ApplicationQueueStore({ stateRoot });
    store.enqueue('attempt-1');
    store.cancel('attempt-1');
    expect(() => store.cancel('attempt-1')).toThrow(ApplicationQueueInvalidTransitionError);
    expect(() => store.skip('attempt-1')).toThrow(ApplicationQueueInvalidTransitionError);
  });

  it('throws a distinguishable not-found error for an unknown attempt id', () => {
    const store = new ApplicationQueueStore({ stateRoot });
    expect(() => store.pause('nope')).toThrow(ApplicationQueueNotFoundError);
  });
});

describe('crash / restart recovery', () => {
  it('reclaims the lease and keeps the checkpoint intact across a simulated restart', () => {
    const first = new ApplicationQueueStore({ stateRoot });
    first.enqueue('attempt-1');
    const lease = first.acquireNextLease()!;

    // Simulate a daemon crash and restart: a fresh instance against the same directory, with no
    // graceful shutdown call on `first`.
    const second = new ApplicationQueueStore({ stateRoot });

    expect(second.currentLease()).toEqual(lease);
    expect(second.get('attempt-1')!.state).toBe('active');
  });

  it('is a no-op to construct repeatedly: no duplicate entries, no drift', () => {
    const first = new ApplicationQueueStore({ stateRoot });
    first.enqueue('attempt-1');
    first.enqueue('attempt-2');

    const second = new ApplicationQueueStore({ stateRoot });
    const third = new ApplicationQueueStore({ stateRoot });

    expect(third.list()).toHaveLength(2);
    expect(second.list().map((e) => e.attemptId).sort()).toEqual(['attempt-1', 'attempt-2']);
  });

  it('starts with an empty queue rather than failing when the snapshot file is corrupt', () => {
    const first = new ApplicationQueueStore({ stateRoot });
    first.enqueue('attempt-1');

    const snapshotPath = join(stateRoot, 'application-queue-v1', 'queue.json');
    writeFileSync(snapshotPath, '{ not valid json');

    const second = new ApplicationQueueStore({ stateRoot });
    expect(second.list()).toHaveLength(0);
  });
});

describe('subscribe', () => {
  it('replays buffered events since a given sequence, then delivers new ones live', () => {
    const store = new ApplicationQueueStore({ stateRoot });
    store.enqueue('attempt-1');
    store.enqueue('attempt-2');

    const received: string[] = [];
    const unsubscribe = store.subscribe(0, (event) => received.push(`${event.type}:${event.attemptId}`));
    expect(received).toEqual(['enqueued:attempt-1', 'enqueued:attempt-2']);

    store.acquireNextLease();
    expect(received).toContain('lease_acquired:attempt-1');

    unsubscribe();
    store.pause('attempt-1');
    expect(received.filter((e) => e.startsWith('paused'))).toHaveLength(0);
  });

  it('replays only events at or after sinceSeq, not the full history', () => {
    const store = new ApplicationQueueStore({ stateRoot });
    store.enqueue('attempt-1'); // seq 0
    store.enqueue('attempt-2'); // seq 1

    const received: number[] = [];
    store.subscribe(1, (event) => received.push(event.seq));
    expect(received).toEqual([1]);
  });

  it('replays history across a restart, from the durable event log', () => {
    const first = new ApplicationQueueStore({ stateRoot });
    first.enqueue('attempt-1');
    first.enqueue('attempt-2');

    const second = new ApplicationQueueStore({ stateRoot });
    const received: string[] = [];
    second.subscribe(0, (event) => received.push(event.attemptId));
    expect(received).toEqual(['attempt-1', 'attempt-2']);
  });
});
