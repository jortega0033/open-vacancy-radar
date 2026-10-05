import { describe, expect, it, vi } from 'vitest';

import { SCAN_PROGRESS_SOURCE_IDS } from '../../src/global-remote/discovery.js';
import { cancellable, isScanCancelledError, runGlobalRemoteScan, ScanCancelledError } from '../../src/pipeline/global-remote.js';

describe('scan cancellation (#459)', () => {
  it('refuses to start a scan whose signal is already aborted, before touching disk or network', async () => {
    const controller = new AbortController();
    controller.abort();
    const run = runGlobalRemoteScan({} as never, {} as never, {} as never, '/does/not/exist', { signal: controller.signal });
    await expect(run).rejects.toBeInstanceOf(ScanCancelledError);
    await expect(run).rejects.toSatisfy(isScanCancelledError);
  });

  it('lets requests through until the signal aborts, then refuses every new one', async () => {
    const controller = new AbortController();
    const get = vi.fn().mockResolvedValue('ok');
    const client = cancellable({ get, label: 'ats' }, controller.signal);

    await expect(client.get()).resolves.toBe('ok');
    expect(client.label).toBe('ats');

    controller.abort();
    expect(() => client.get()).toThrow(ScanCancelledError);
    expect(get).toHaveBeenCalledTimes(1);
  });

  it('returns the client itself when there is no signal, so uncancellable callers are untouched', () => {
    const client = { get: vi.fn() };
    expect(cancellable(client, undefined)).toBe(client);
  });

  it('publishes one progress id per discovery group plus the Workable listing, with no duplicates', () => {
    expect(new Set(SCAN_PROGRESS_SOURCE_IDS).size).toBe(SCAN_PROGRESS_SOURCE_IDS.length);
    expect(SCAN_PROGRESS_SOURCE_IDS).toContain('workable_global');
    expect(SCAN_PROGRESS_SOURCE_IDS.length).toBe(12);
  });
});
