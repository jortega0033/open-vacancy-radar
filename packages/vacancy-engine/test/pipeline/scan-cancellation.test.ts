import { describe, expect, it, vi } from 'vitest';

import { SCAN_PROGRESS_SOURCE_IDS } from '../../src/global-remote/discovery.js';
import type { DiscoverySourceAudit, DiscoveryVacancyAudit } from '../../src/global-remote/models.js';
import {
  awaitAiWebDiscoveryJoin,
  cancellable,
  isScanCancelledError,
  runGlobalRemoteScan,
  ScanCancelledError,
  type AiWebDiscoveryJoinResult,
} from '../../src/pipeline/global-remote.js';

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

  describe('joining an AI web discovery branch that is still running (#685)', () => {
    const aiRow = { key: 'ai_web_search:x', provider: 'ai_web_search', url: 'https://acme.example/x' } as DiscoveryVacancyAudit;
    const aiAudit = { id: 'ai_web_search', provider: 'ai_web_search', status: 'success' } as DiscoverySourceAudit;
    const joined: AiWebDiscoveryJoinResult = { vacancies: [aiRow], sourceAudit: aiAudit };

    it('waits for the branch and returns what it produced', async () => {
      let resolve!: (value: AiWebDiscoveryJoinResult) => void;
      const join = vi.fn(() => new Promise<AiWebDiscoveryJoinResult>((res) => (resolve = res)));
      const pending = awaitAiWebDiscoveryJoin({ joinAiWebDiscovery: join }, new AbortController().signal);
      resolve(joined);
      await expect(pending).resolves.toEqual(joined);
      expect(join).toHaveBeenCalledTimes(1);
    });

    it('a stop while the branch is pending rejects at once, and a value arriving afterwards is dropped', async () => {
      const controller = new AbortController();
      let resolve!: (value: AiWebDiscoveryJoinResult) => void;
      const pending = awaitAiWebDiscoveryJoin(
        { joinAiWebDiscovery: () => new Promise<AiWebDiscoveryJoinResult>((res) => (resolve = res)) },
        controller.signal,
      );
      controller.abort();
      await expect(pending).rejects.toBeInstanceOf(ScanCancelledError);
      resolve(joined);
      await expect(pending).rejects.toBeInstanceOf(ScanCancelledError);
    });

    it('a stop that lands as the branch resolves still wins, and an already-stopped scan never calls the branch', async () => {
      const controller = new AbortController();
      const racing = awaitAiWebDiscoveryJoin(
        {
          joinAiWebDiscovery: async () => {
            controller.abort();
            return joined;
          },
        },
        controller.signal,
      );
      await expect(racing).rejects.toBeInstanceOf(ScanCancelledError);
      const join = vi.fn(async () => joined);
      await expect(awaitAiWebDiscoveryJoin({ joinAiWebDiscovery: join }, controller.signal)).rejects.toBeInstanceOf(ScanCancelledError);
      expect(join).not.toHaveBeenCalled();
    });

    it('a branch with nothing to merge resolves undefined', async () => {
      await expect(awaitAiWebDiscoveryJoin({ joinAiWebDiscovery: async () => undefined }, undefined)).resolves.toBeUndefined();
    });

    it('keeps the already-finished form unchanged, and refuses both forms at once', async () => {
      await expect(awaitAiWebDiscoveryJoin({}, undefined)).resolves.toBeUndefined();
      await expect(
        awaitAiWebDiscoveryJoin({ aiWebDiscoveryVacancies: [aiRow], aiWebDiscoverySourceAudit: aiAudit }, undefined),
      ).resolves.toEqual({ vacancies: [aiRow], sourceAudit: aiAudit });
      await expect(awaitAiWebDiscoveryJoin({ aiWebDiscoverySourceAudit: aiAudit }, undefined)).resolves.toEqual({
        vacancies: [],
        sourceAudit: aiAudit,
      });
      await expect(
        awaitAiWebDiscoveryJoin({ aiWebDiscoveryVacancies: [aiRow], joinAiWebDiscovery: async () => joined }, undefined),
      ).rejects.toThrow('joinAiWebDiscovery cannot be combined');
    });
  });

  it('publishes one progress id per discovery group plus the Workable listing, with no duplicates', () => {
    expect(new Set(SCAN_PROGRESS_SOURCE_IDS).size).toBe(SCAN_PROGRESS_SOURCE_IDS.length);
    expect(SCAN_PROGRESS_SOURCE_IDS).toContain('workable_global');
    expect(SCAN_PROGRESS_SOURCE_IDS.length).toBe(13);
  });
});
