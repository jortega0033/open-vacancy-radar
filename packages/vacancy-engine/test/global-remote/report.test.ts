import { mkdtemp, rm, writeFile, mkdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  readGlobalRemoteReport,
  readGlobalRemoteReportWithFallback,
  writeGlobalRemoteReport,
} from '../../src/global-remote/report.js';
import { discoveryAudit } from '../../src/global-remote/discovery-shared.js';
import type { GlobalRemoteReport } from '../../src/global-remote/models.js';

/**
 * `readGlobalRemoteReport` is the read half of the write path `pipeline/global-remote.ts` already
 * exercises end to end -- this suite is scoped to the read function itself: a real write-then-read
 * round trip, and the "there is nothing usable yet" cases (#195) it must resolve to `undefined`
 * for rather than throw, since a fresh install or a corrupted file are both expected states a
 * caller must be able to shrug off during startup.
 */

function sampleReport(): GlobalRemoteReport {
  return {
    runId: 'run-1',
    generatedAt: '2026-01-01T00:00:00.000Z',
    profileVersion: 'v1',
    criteria: {
      role: 'Engineer',
      fullyRemote: true,
      applicantLocation: 'Worldwide',
      usCitizenshipRequired: false,
      minimumAnnualBaseUsd: null,
      currency: 'USD',
    },
    statistics: {
      discoveryRequests: 0,
      discoveryListings: 0,
      discoveryUniqueListings: 0,
      discoveryOfficialReviewCandidates: 0,
      officialBoardsOrPagesAttempted: 0,
      officialRequests: 0,
      strictMatches: 0,
      manualReview: 0,
      nearMisses: 0,
      excludedOrInactive: 0,
      blockedOrErrored: 0,
      registrySources: 0,
      activeRegistrySources: 0,
      gatedRegistrySources: 0,
      manualOrProhibitedRegistrySources: 0,
    },
    sourceRegistry: [],
    discoverySources: [],
    strictMatches: [],
    manualReview: [],
    nearMisses: [],
    excludedOrInactive: [],
    blockedOrErrored: [],
    officialAudit: [],
    discoveryAudit: [],
    methodology: [],
    attribution: [],
  };
}

let projectRoot: string;

beforeEach(async () => {
  projectRoot = await mkdtemp(join(tmpdir(), 'ovr-global-remote-report-'));
});

afterEach(async () => {
  await rm(projectRoot, { recursive: true, force: true });
});

describe('readGlobalRemoteReport', () => {
  it('reads back exactly what writeGlobalRemoteReport wrote', async () => {
    const report = sampleReport();
    await writeGlobalRemoteReport(report, projectRoot);

    const read = await readGlobalRemoteReport(projectRoot);
    expect(read).toEqual(report);
  });

  it('keeps a previous non-empty latest report after an empty desktop scan', async () => {
    const previous = sampleReport();
    previous.discoveryAudit = [
      discoveryAudit({
        key: 'remote_first_jobs:1',
        provider: 'remote_first_jobs',
        company: 'Example',
        title: 'Earlier Role',
        url: 'https://example.com/jobs/1',
        location: 'Remote',
        employmentType: null,
        currency: null,
        salaryPeriod: null,
        advertisedMinimum: null,
        raw: { id: '1' },
        minimumAnnualBaseUsd: null,
      }),
    ];
    await writeGlobalRemoteReport(previous, projectRoot);

    const empty = { ...sampleReport(), runId: 'run-2', generatedAt: '2026-01-02T00:00:00.000Z' };
    const files = await writeGlobalRemoteReport(empty, projectRoot, {
      preserveNonEmptyLatest: true,
    });

    expect(JSON.parse(await readFile(files.timestampedJson, 'utf8'))).toEqual(empty);
    expect(await readGlobalRemoteReport(projectRoot)).toEqual(previous);
  });

  it('writes browse-all cap state into the HTML report', async () => {
    const report = {
      ...sampleReport(),
      scanBounds: {
        mode: 'browse_all' as const,
        resultCap: 5_000,
        resultCountBeforeCap: 5_001,
        complete: false,
        completenessReason: 'Browse-all result cap kept 5,000 of 5,001 discovered vacancies.',
      },
    };

    const files = await writeGlobalRemoteReport(report, projectRoot);
    const html = await readFile(files.latestHtml, 'utf8');

    expect(html).toContain('Incomplete browse-all report');
    expect(html).toContain('Browse-all result cap kept 5,000 of 5,001 discovered vacancies.');
  });

  it('resolves to undefined when no report has ever been written', async () => {
    await expect(readGlobalRemoteReport(projectRoot)).resolves.toBeUndefined();
  });

  it('resolves to undefined rather than throwing when latest.json is corrupt', async () => {
    const output = join(projectRoot, 'reports', 'global-remote');
    await mkdir(output, { recursive: true });
    await writeFile(join(output, 'latest.json'), '{ not valid json', 'utf8');

    await expect(readGlobalRemoteReport(projectRoot)).resolves.toBeUndefined();
  });
});

describe('readGlobalRemoteReportWithFallback (#577)', () => {
  function withVacancy(runId: string, generatedAt: string, id: string): GlobalRemoteReport {
    const report = { ...sampleReport(), runId, generatedAt };
    report.discoveryAudit = [
      discoveryAudit({
        key: `remote_first_jobs:${id}`,
        provider: 'remote_first_jobs',
        company: 'Example',
        title: `Role ${id}`,
        url: `https://example.com/jobs/${id}`,
        location: 'Remote',
        employmentType: null,
        currency: null,
        salaryPeriod: null,
        advertisedMinimum: null,
        raw: { id },
        minimumAnnualBaseUsd: null,
      }),
    ];
    return report;
  }
  const emptyScan = (): GlobalRemoteReport => {
    const report = { ...sampleReport(), runId: 'run-empty', generatedAt: '2026-01-03T00:00:00.000Z' };
    report.statistics = { ...report.statistics, rawRowsFetched: 42 };
    return report;
  };
  const output = () => join(projectRoot, 'reports', 'global-remote');

  it('writes the kept copy only for a report with vacancies, and reads latest as-is while it has some', async () => {
    const first = withVacancy('run-1', '2026-01-01T00:00:00.000Z', '1');
    const files = await writeGlobalRemoteReport(first, projectRoot);

    expect(files.latestNonEmptyJson).toBe(join(output(), 'latest-nonempty.json'));
    expect(JSON.parse(await readFile(join(output(), 'latest-nonempty.json'), 'utf8'))).toEqual(first);
    expect((await writeGlobalRemoteReport(emptyScan(), projectRoot)).latestNonEmptyJson).toBeUndefined();
    expect(JSON.parse(await readFile(join(output(), 'latest-nonempty.json'), 'utf8'))).toEqual(first);
    expect(await readGlobalRemoteReportWithFallback(projectRoot)).toMatchObject({ keptPrevious: { checked: 42 } });
  });

  it('falls back to the kept report when latest.json has no vacancies', async () => {
    const first = withVacancy('run-1', '2026-01-01T00:00:00.000Z', '1');
    await writeGlobalRemoteReport(first, projectRoot);
    await writeGlobalRemoteReport(emptyScan(), projectRoot);

    const loaded = await readGlobalRemoteReportWithFallback(projectRoot);
    expect(loaded?.report).toEqual(first);
    expect(loaded?.keptPrevious).toEqual({ checked: 42 });
  });

  it('returns latest without a notice when it has vacancies', async () => {
    const first = withVacancy('run-1', '2026-01-01T00:00:00.000Z', '1');
    await writeGlobalRemoteReport(first, projectRoot);

    const loaded = await readGlobalRemoteReportWithFallback(projectRoot);
    expect(loaded).toEqual({ report: first });
  });

  it('replaces the kept report when a later scan has vacancies', async () => {
    await writeGlobalRemoteReport(withVacancy('run-1', '2026-01-01T00:00:00.000Z', '1'), projectRoot);
    await writeGlobalRemoteReport(emptyScan(), projectRoot);
    const later = withVacancy('run-4', '2026-01-04T00:00:00.000Z', '2');
    await writeGlobalRemoteReport(later, projectRoot);

    expect(JSON.parse(await readFile(join(output(), 'latest-nonempty.json'), 'utf8'))).toEqual(later);
    expect(await readGlobalRemoteReportWithFallback(projectRoot)).toEqual({ report: later });
  });

  it('returns the empty latest report when the kept file is missing or corrupt', async () => {
    const empty = emptyScan();
    await writeGlobalRemoteReport(empty, projectRoot);
    expect(await readGlobalRemoteReportWithFallback(projectRoot)).toEqual({ report: empty });

    await writeFile(join(output(), 'latest-nonempty.json'), '{ not valid json', 'utf8');
    expect(await readGlobalRemoteReportWithFallback(projectRoot)).toEqual({ report: empty });

    await writeFile(join(output(), 'latest-nonempty.json'), JSON.stringify(sampleReport()), 'utf8');
    expect(await readGlobalRemoteReportWithFallback(projectRoot)).toEqual({ report: empty });
  });

  it('resolves to undefined when nothing was ever written', async () => {
    await expect(readGlobalRemoteReportWithFallback(projectRoot)).resolves.toBeUndefined();
  });

  it('uses the kept report when latest.json is gone or corrupt', async () => {
    const first = withVacancy('run-1', '2026-01-01T00:00:00.000Z', '1');
    await writeGlobalRemoteReport(first, projectRoot);
    await writeFile(join(output(), 'latest.json'), '{ not valid json', 'utf8');

    expect(await readGlobalRemoteReportWithFallback(projectRoot)).toEqual({ report: first });
  });
});
