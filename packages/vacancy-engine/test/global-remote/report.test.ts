import { mkdtemp, rm, writeFile, mkdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readGlobalRemoteReport, writeGlobalRemoteReport } from '../../src/global-remote/report.js';
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
