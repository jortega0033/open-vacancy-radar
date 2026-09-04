// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import type { ScanLock } from '@open-vacancy-radar/vacancy-engine';
import { createScanGuard, SCAN_BUSY_IN_PROCESS, SCAN_BUSY_OTHER_PROCESS } from '../electron/scan-guard.js';

interface CountingLock extends ScanLock {
  acquisitions: number;
  releases: number;
}

/** A lock that always grants, recording how many times it was taken and released. */
function grantingLock(): CountingLock {
  const lock: CountingLock = {
    acquisitions: 0,
    releases: 0,
    tryAcquire() {
      lock.acquisitions += 1;
      return () => {
        lock.releases += 1;
      };
    },
  };
  return lock;
}

/** A lock already held by somebody else: what a second process looks like from here. */
const heldLock: ScanLock = { tryAcquire: () => null };

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('createScanGuard', () => {
  it('refuses a second scan of the SAME kind while one is in flight', async () => {
    const guard = createScanGuard(() => grantingLock());
    const first = deferred<string>();

    const running = guard(() => first.promise, { takeAdvisoryLock: true });
    await expect(guard(async () => 'second', { takeAdvisoryLock: true })).rejects.toThrow(SCAN_BUSY_IN_PROCESS);

    first.resolve('first');
    await expect(running).resolves.toBe('first');
  });

  it('refuses a second scan even with a different takeAdvisoryLock option: one guard, one in-flight flag', async () => {
    const guard = createScanGuard(() => grantingLock());
    const globalRemote = deferred<string>();

    const running = guard(() => globalRemote.promise, { takeAdvisoryLock: true });
    await expect(guard(async () => 'second', { takeAdvisoryLock: false })).rejects.toThrow(SCAN_BUSY_IN_PROCESS);

    globalRemote.resolve('worldwide');
    await running;
  });

  it('clears the in-flight flag when a scan fails, so the next one is not wedged shut', async () => {
    const guard = createScanGuard(() => grantingLock());
    await expect(guard(async () => Promise.reject(new Error('network down')), { takeAdvisoryLock: true })).rejects.toThrow(
      'network down',
    );
    await expect(guard(async () => 'ok', { takeAdvisoryLock: true })).resolves.toBe('ok');
  });

  it('refuses to start when another process holds the advisory lock, with a distinguishable message', async () => {
    const guard = createScanGuard(() => heldLock);
    const run = vi.fn();
    await expect(guard(run, { takeAdvisoryLock: true })).rejects.toThrow(SCAN_BUSY_OTHER_PROCESS);
    expect(run).not.toHaveBeenCalled();
  });

  it('recovers after a cross-process refusal rather than staying refused forever', async () => {
    let lock: ScanLock = heldLock;
    const guard = createScanGuard(() => lock);
    await expect(guard(async () => 'x', { takeAdvisoryLock: true })).rejects.toThrow(SCAN_BUSY_OTHER_PROCESS);

    lock = grantingLock();
    await expect(guard(async () => 'x', { takeAdvisoryLock: true })).resolves.toBe('x');
  });

  it('takes and releases the advisory lock exactly once around a scan', async () => {
    const lock = grantingLock();
    const guard = createScanGuard(() => lock);
    await guard(async () => 'done', { takeAdvisoryLock: true });
    expect(lock.acquisitions).toBe(1);
    expect(lock.releases).toBe(1);
  });

  it('does not touch the advisory lock for a scan that takes it itself', async () => {
    // Double-acquiring would deadlock against the engine's own acquisition on any platform where
    // the SQLite file lock is per-handle rather than per-process.
    const lock = grantingLock();
    const guard = createScanGuard(() => lock);
    await guard(async () => 'done', { takeAdvisoryLock: false });
    expect(lock.acquisitions).toBe(0);
  });

  it('fails clearly when the engine (and therefore the lock) has not initialized yet', async () => {
    const guard = createScanGuard(() => undefined);
    await expect(guard(async () => 'x', { takeAdvisoryLock: true })).rejects.toThrow(/not initialized/);
  });
});
