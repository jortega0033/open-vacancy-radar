import type { Logger } from 'pino';
import { describe, expect, it, vi } from 'vitest';

import type { AppConfig } from '../../src/config.js';
import type { ScanLock } from '../../src/db/advisory-lock.js';
import type { Database } from '../../src/db/client.js';
import type { JobRadarReport } from '../../src/reporting/report.js';
import {
  finishScanAndPublishReport,
  reportStatisticsForVacancyScan,
  runEndToEndScan,
  runSponsorStageWithFallback,
  runVacancyScanCommand,
} from '../../src/pipeline/full-scan.js';

function heldScanLock(): ScanLock {
  return { tryAcquire: vi.fn().mockReturnValue(null) };
}

function warningLogger(): { logger: Logger; warn: ReturnType<typeof vi.fn> } {
  const warn = vi.fn();
  return { logger: { warn } as unknown as Logger, warn };
}

const unusedDatabase = {} as Database;
const unusedConfig = {} as AppConfig;

describe('scan command overlap protection', () => {
  it('skips vacancies:scan before creating a scan run when the shared lock is held', async () => {
    const { logger, warn } = warningLogger();

    await expect(
      runVacancyScanCommand(unusedDatabase, unusedConfig, logger, heldScanLock()),
    ).resolves.toEqual({ status: 'skipped', reason: 'already-running' });

    expect(warn).toHaveBeenCalledWith(
      expect.any(Object),
      expect.stringContaining('Vacancy scan skipped'),
    );
  });

  it('uses the same clean skip semantics for the end-to-end scan', async () => {
    const { logger, warn } = warningLogger();

    await expect(
      runEndToEndScan(unusedDatabase, unusedConfig, logger, heldScanLock()),
    ).resolves.toEqual({ status: 'skipped', reason: 'already-running' });

    expect(warn).toHaveBeenCalledWith(
      expect.any(Object),
      expect.stringContaining('End-to-end scan skipped'),
    );
  });
});

describe('vacancy scan report statistics', () => {
  it('reports incomplete sources separately from completely scanned sources', () => {
    const statistics = reportStatisticsForVacancyScan({
      status: 'partial',
      sourcesDiscovered: 2,
      sourcesAttempted: 2,
      sourcesScanned: 1,
      incompleteSources: 1,
      blockedSources: 0,
      manualReviewSources: 0,
      unsupportedSources: 0,
      vacanciesDiscovered: 10,
      vacanciesNew: 1,
      vacanciesChanged: 0,
      vacanciesInactive: 0,
      invalidVacancies: 1,
      errorCount: 1,
      requestCount: 3,
      durationMs: 50,
    });

    expect(statistics.careerSourcesScanned).toBe(1);
    expect(statistics.incompleteSources).toBe(1);
  });
});

describe('scan finalization and report publication', () => {
  const statistics = reportStatisticsForVacancyScan({
    status: 'succeeded',
    sourcesDiscovered: 0,
    sourcesAttempted: 0,
    sourcesScanned: 0,
    incompleteSources: 0,
    blockedSources: 0,
    manualReviewSources: 0,
    unsupportedSources: 0,
    vacanciesDiscovered: 0,
    vacanciesNew: 0,
    vacanciesChanged: 0,
    vacanciesInactive: 0,
    invalidVacancies: 0,
    errorCount: 0,
    requestCount: 0,
    durationMs: 1,
  });
  const report = { scanStatus: 'succeeded', statistics } as JobRadarReport;
  const files = {
    latestHtml: 'reports/latest.html',
    latestJson: 'reports/latest.json',
    timestampedHtml: 'reports/run.html',
    timestampedJson: 'reports/run.json',
  };

  it('finalizes the database run before publishing report files', async () => {
    const events: string[] = [];
    const finish = vi.fn(() => {
      events.push('finish');
      return Promise.resolve();
    });
    const write = vi.fn(() => {
      events.push('write');
      return Promise.resolve(files);
    });

    await expect(
      finishScanAndPublishReport(unusedDatabase, 'run-1', report, { finish, write }),
    ).resolves.toEqual(files);
    expect(events).toEqual(['finish', 'write']);
  });

  it('leaves the previously published latest report untouched when finalization fails', async () => {
    const write = vi.fn(() => Promise.resolve(files));

    await expect(
      finishScanAndPublishReport(unusedDatabase, 'run-1', report, {
        finish: vi.fn().mockRejectedValue(new Error('database unavailable')),
        write,
      }),
    ).rejects.toThrow('database unavailable');
    expect(write).not.toHaveBeenCalled();
  });
});

describe('official sponsor refresh fallback', () => {
  it('continues from a trusted recent baseline and records a partial-run diagnostic', async () => {
    const recordError = vi.fn().mockResolvedValue(undefined);
    const { logger, warn } = warningLogger();
    const baseline = {
      sourceRows: 12_935,
      uniqueSponsors: 12_933,
      duplicatesIgnored: 2,
      sourceLastUpdated: new Date('2026-08-03T00:00:00.000Z'),
      membershipHash: 'baseline-hash',
      retrievedAt: new Date('2026-08-27T00:00:00.000Z'),
    };

    const result = await runSponsorStageWithFallback(
      unusedDatabase,
      { sponsorBaselineMaxAgeDays: 45 } as AppConfig,
      logger,
      'run-1',
      {
        sync: () => Promise.reject(new Error('offline')),
        loadBaseline: () => Promise.resolve(baseline),
        recordError,
      },
    );

    expect(result).toMatchObject({
      fallbackUsed: true,
      sponsorSync: { uniqueSponsors: 12_933, requestCount: 0 },
    });
    expect(recordError).toHaveBeenCalledOnce();
    const recordedInput: unknown = recordError.mock.calls[0]?.[1];
    expect(recordedInput).toMatchObject({
      scanRunId: 'run-1',
      category: 'network_error',
      context: { fallback: 'accepted_age_bounded_snapshot' },
    });
    expect(warn).toHaveBeenCalledWith(
      expect.any(Object),
      expect.stringContaining('trusted recent baseline'),
    );
  });

  it('fails closed on cold start when no trusted baseline exists', async () => {
    const { logger } = warningLogger();

    await expect(
      runSponsorStageWithFallback(
        unusedDatabase,
        { sponsorBaselineMaxAgeDays: 45 } as AppConfig,
        logger,
        'run-1',
        {
          sync: () => Promise.reject(new Error('offline')),
          loadBaseline: () => Promise.resolve(null),
          recordError: vi.fn(),
        },
      ),
    ).rejects.toThrow('offline');
  });
});
