import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterAll, describe, expect, it, vi } from 'vitest';

import {
  createScanLock,
  withScanAdvisoryTryLock,
  type ScanLock,
} from '../../src/db/advisory-lock.js';

function fakeLock(release: () => void, acquirable = true): ScanLock {
  return { tryAcquire: () => (acquirable ? release : null) };
}

describe('embedded scan lock', () => {
  it('runs the operation and releases the lock', async () => {
    const release = vi.fn();
    const operation = vi.fn().mockResolvedValue('complete');

    await expect(
      withScanAdvisoryTryLock(fakeLock(release), operation),
    ).resolves.toEqual({ acquired: true, value: 'complete' });

    expect(operation).toHaveBeenCalledOnce();
    expect(release).toHaveBeenCalledOnce();
  });

  it('skips the operation without releasing anything when the lock is held', async () => {
    const release = vi.fn();
    const operation = vi.fn();

    await expect(
      withScanAdvisoryTryLock(fakeLock(release, false), operation),
    ).resolves.toEqual({ acquired: false });

    expect(operation).not.toHaveBeenCalled();
    expect(release).not.toHaveBeenCalled();
  });

  it('always releases when the protected operation rejects', async () => {
    const release = vi.fn();
    const failure = new Error('scan failed');

    await expect(
      withScanAdvisoryTryLock(fakeLock(release), () => Promise.reject(failure)),
    ).rejects.toBe(failure);

    expect(release).toHaveBeenCalledOnce();
  });

  it('propagates a failed release instead of reporting a clean run', async () => {
    const release = vi.fn(() => {
      throw new Error('lock file disappeared');
    });

    await expect(
      withScanAdvisoryTryLock(fakeLock(release), () => Promise.resolve(undefined)),
    ).rejects.toThrow('lock file disappeared');
  });
});

describe('file-backed scan lock', () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'vacancy-engine-lock-'));
  const databasePath = path.join(directory, 'engine.db');

  afterAll(() => {
    rmSync(directory, { recursive: true, force: true });
  });

  it('refuses a second holder while the first still owns the lock, then hands it over', () => {
    const first = createScanLock(databasePath);
    const second = createScanLock(databasePath);

    const release = first.tryAcquire();
    expect(release).not.toBeNull();
    expect(second.tryAcquire()).toBeNull();

    release?.();

    const afterRelease = second.tryAcquire();
    expect(afterRelease).not.toBeNull();
    afterRelease?.();
  });

  it('keeps in-memory databases exclusive within the process', () => {
    const lock = createScanLock(':memory:');
    const release = lock.tryAcquire();
    expect(release).not.toBeNull();
    expect(lock.tryAcquire()).toBeNull();
    release?.();
    expect(lock.tryAcquire()).not.toBeNull();
  });
});
