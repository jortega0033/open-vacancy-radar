import { mkdtempSync, rmSync } from 'node:fs';
import { access, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { recordDiscoveryRun } from '../../src/global-remote/discovery-runs-repository.js';
import { pruneGlobalRemoteReports, writeGlobalRemoteReport } from '../../src/global-remote/report.js';
import type { GlobalRemoteReport } from '../../src/global-remote/models.js';
import {
  createDatabaseClient,
  migrateDatabase,
  type Database,
  type DatabaseClient,
} from '../../src/db/client.js';

/**
 * `pruneGlobalRemoteReports` is exercised against a real database and real files on disk -- the
 * same shape `discovery-runs-repository.test.ts` already uses for `recordDiscoveryRun` -- since the
 * function's whole job is coordinating those two things (delete files named by rows, then drop the
 * rows), which a mock of either side would just assert away.
 */

function sampleReport(generatedAt: string): GlobalRemoteReport {
  return {
    runId: `run-${generatedAt}`,
    generatedAt,
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

async function exists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

const migrationsFolder = fileURLToPath(new URL('../../drizzle', import.meta.url));
const dbDirectory = mkdtempSync(path.join(tmpdir(), 'vacancy-engine-report-retention-'));

let client: DatabaseClient | undefined;
let projectRoot: string;

function db(): Database {
  if (client === undefined) throw new Error('test database is not initialized');
  return client.db;
}

describe('pruneGlobalRemoteReports', () => {
  beforeAll(async () => {
    client = createDatabaseClient(path.join(dbDirectory, 'report-retention.db'));
    await migrateDatabase(client.db, migrationsFolder);
  }, 30_000);

  beforeEach(async () => {
    client?.connection.exec('delete from "discovery_runs";');
    projectRoot = mkdtempSync(path.join(tmpdir(), 'vacancy-engine-report-retention-project-'));
  });

  afterEach(async () => {
    await rm(projectRoot, { recursive: true, force: true });
  });

  afterAll(() => {
    client?.close();
    client = undefined;
    rmSync(dbDirectory, { recursive: true, force: true });
  });

  it('does nothing on a fresh install with no discovery_runs rows and no report files', async () => {
    const result = await pruneGlobalRemoteReports(db(), 90, projectRoot);

    expect(result).toEqual({ deletedRunIds: [], deletedFiles: [] });
  });

  it('deletes a timestamped triple past the retention window and drops its discovery_runs row, but keeps one inside it', async () => {
    const oldReport = sampleReport('2020-01-01T00:00:00.000Z');
    const oldFiles = await writeGlobalRemoteReport(oldReport, projectRoot);
    const oldRun = await recordDiscoveryRun(db(), {
      generatedAt: new Date(oldReport.generatedAt),
      vacancyCount: 0,
      reportJsonPath: oldFiles.timestampedJson,
      reportHtmlPath: oldFiles.timestampedHtml,
    });

    const recentReport = sampleReport(new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString());
    const recentFiles = await writeGlobalRemoteReport(recentReport, projectRoot);
    await recordDiscoveryRun(db(), {
      generatedAt: new Date(recentReport.generatedAt),
      vacancyCount: 0,
      reportJsonPath: recentFiles.timestampedJson,
      reportHtmlPath: recentFiles.timestampedHtml,
    });

    const result = await pruneGlobalRemoteReports(db(), 7, projectRoot);

    expect(result.deletedRunIds).toEqual([oldRun.id]);
    expect(result.deletedFiles.sort()).toEqual(
      [oldFiles.timestampedJson, oldFiles.timestampedHtml, oldFiles.timestampedAudit].sort(),
    );
    await expect(exists(oldFiles.timestampedJson)).resolves.toBe(false);
    await expect(exists(oldFiles.timestampedHtml)).resolves.toBe(false);
    await expect(exists(oldFiles.timestampedAudit)).resolves.toBe(false);
    await expect(exists(recentFiles.timestampedJson)).resolves.toBe(true);
    await expect(exists(recentFiles.timestampedHtml)).resolves.toBe(true);
    await expect(exists(recentFiles.timestampedAudit)).resolves.toBe(true);

    const remainingRows = client?.connection.prepare('SELECT count(*) as count FROM discovery_runs').get() as {
      count: number;
    };
    expect(remainingRows.count).toBe(1);
  });

  it('never deletes latest.json, latest.html, or latest.audit.ndjson regardless of age', async () => {
    const oldReport = sampleReport('2020-01-01T00:00:00.000Z');
    const files = await writeGlobalRemoteReport(oldReport, projectRoot);
    await recordDiscoveryRun(db(), {
      generatedAt: new Date(oldReport.generatedAt),
      vacancyCount: 0,
      reportJsonPath: files.timestampedJson,
      reportHtmlPath: files.timestampedHtml,
    });

    await pruneGlobalRemoteReports(db(), 7, projectRoot);

    await expect(exists(files.latestJson)).resolves.toBe(true);
    await expect(exists(files.latestHtml)).resolves.toBe(true);
    await expect(exists(files.latestAudit)).resolves.toBe(true);
  });

  it('does not crash when the report directory only has latest.* files and no rows reference them', async () => {
    await writeGlobalRemoteReport(sampleReport('2026-01-01T00:00:00.000Z'), projectRoot);

    const result = await pruneGlobalRemoteReports(db(), 7, projectRoot);

    expect(result).toEqual({ deletedRunIds: [], deletedFiles: [] });
  });
});
