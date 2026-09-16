import { mkdtempSync, rmSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  latestDiscoveryRun,
  listRecentDiscoveryRuns,
  recordDiscoveryRun,
} from '../../src/global-remote/discovery-runs-repository.js';
import { writeGlobalRemoteReport } from '../../src/global-remote/report.js';
import type { GlobalRemoteReport } from '../../src/global-remote/models.js';
import {
  createDatabaseClient,
  migrateDatabase,
  type Database,
  type DatabaseClient,
} from '../../src/db/client.js';

const migrationsFolder = fileURLToPath(new URL('../../drizzle', import.meta.url));
const temporaryDirectory = mkdtempSync(path.join(tmpdir(), 'vacancy-engine-discovery-runs-'));

let client: DatabaseClient | undefined;

function db(): Database {
  if (client === undefined) throw new Error('test database is not initialized');
  return client.db;
}

describe('discovery_runs repository', () => {
  beforeAll(async () => {
    client = createDatabaseClient(path.join(temporaryDirectory, 'discovery-runs.db'));
    await migrateDatabase(client.db, migrationsFolder);
  }, 30_000);

  beforeEach(() => {
    client?.connection.exec('delete from "discovery_runs";');
  });

  afterAll(() => {
    client?.close();
    client = undefined;
    rmSync(temporaryDirectory, { recursive: true, force: true });
  });

  it('records a scan and reads it back with the paths and count it was given', async () => {
    const generatedAt = new Date('2026-06-01T12:00:00.000Z');

    const inserted = await recordDiscoveryRun(db(), {
      generatedAt,
      vacancyCount: 42,
      reportJsonPath: '/reports/global-remote/2026-06-01T12-00-00-000Z.json',
      reportHtmlPath: '/reports/global-remote/2026-06-01T12-00-00-000Z.html',
    });

    expect(inserted).toEqual({
      id: inserted.id,
      generatedAt,
      vacancyCount: 42,
      reportJsonPath: '/reports/global-remote/2026-06-01T12-00-00-000Z.json',
      reportHtmlPath: '/reports/global-remote/2026-06-01T12-00-00-000Z.html',
    });
    expect(inserted.id).toEqual(expect.any(String));

    expect(await latestDiscoveryRun(db())).toEqual(inserted);
  });

  it('returns null from latestDiscoveryRun when no scan has ever completed', async () => {
    expect(await latestDiscoveryRun(db())).toBeNull();
  });

  it('lists recent scans newest first, capped at the requested limit', async () => {
    for (let index = 0; index < 5; index += 1) {
      await recordDiscoveryRun(db(), {
        generatedAt: new Date(Date.UTC(2026, 0, index + 1)),
        vacancyCount: index,
        reportJsonPath: `/reports/global-remote/run-${index}.json`,
        reportHtmlPath: `/reports/global-remote/run-${index}.html`,
      });
    }

    const recent = await listRecentDiscoveryRuns(db(), 3);

    expect(recent.map((run) => run.vacancyCount)).toEqual([4, 3, 2]);
  });

  it('inserts one independent row per scan rather than upserting over the last one', async () => {
    await recordDiscoveryRun(db(), {
      generatedAt: new Date('2026-06-01T00:00:00.000Z'),
      vacancyCount: 10,
      reportJsonPath: '/reports/global-remote/a.json',
      reportHtmlPath: '/reports/global-remote/a.html',
    });
    await recordDiscoveryRun(db(), {
      generatedAt: new Date('2026-06-02T00:00:00.000Z'),
      vacancyCount: 12,
      reportJsonPath: '/reports/global-remote/b.json',
      reportHtmlPath: '/reports/global-remote/b.html',
    });

    const rows = client?.connection.prepare('SELECT count(*) as count FROM discovery_runs').get() as {
      count: number;
    };

    expect(rows.count).toBe(2);
  });
});

/**
 * A minimal `GlobalRemoteReport`, matching `test/global-remote/report.test.ts`'s own fixture, with
 * `discoveryAudit` populated so `vacancyCount` has something real to count.
 */
function sampleReport(): GlobalRemoteReport {
  return {
    runId: 'run-1',
    generatedAt: '2026-06-01T12:00:00.000Z',
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
      discoveryUniqueListings: 2,
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
    // `decision: 'role_mismatch'` keeps these out of `renderGlobalRemoteHtml`'s discovery table
    // (see `discoveryRows`'s filter in report.ts), so this fixture only needs to be a real
    // `discoveryAudit` length to count, not a fully-populated vacancy row.
    discoveryAudit: [
      { key: 'discovery-1', decision: 'role_mismatch' } as GlobalRemoteReport['discoveryAudit'][number],
      { key: 'discovery-2', decision: 'role_mismatch' } as GlobalRemoteReport['discoveryAudit'][number],
    ],
    methodology: [],
    attribution: [],
  };
}

/**
 * Exercises `recordDiscoveryRun` wired exactly the way `runGlobalRemoteScan` calls it: after
 * `writeGlobalRemoteReport` has returned, against the timestamped file paths it wrote (never
 * `latest.*`, which the next scan overwrites) and `discoveryAudit.length` for the count. This is
 * the write half of the ticket's acceptance criteria that a full scan is too heavy (network,
 * multiple discovery sources) to exercise directly in this suite.
 */
describe('recordDiscoveryRun wired the way runGlobalRemoteScan calls it', () => {
  const migrationsFolder2 = fileURLToPath(new URL('../../drizzle', import.meta.url));
  const dbDirectory = mkdtempSync(path.join(tmpdir(), 'vacancy-engine-discovery-runs-wiring-'));
  let wiringClient: DatabaseClient | undefined;
  let projectRoot: string;

  function wiringDb(): Database {
    if (wiringClient === undefined) throw new Error('test database is not initialized');
    return wiringClient.db;
  }

  beforeAll(async () => {
    wiringClient = createDatabaseClient(path.join(dbDirectory, 'discovery-runs.db'));
    await migrateDatabase(wiringClient.db, migrationsFolder2);
  }, 30_000);

  beforeEach(async () => {
    wiringClient?.connection.exec('delete from "discovery_runs";');
    projectRoot = mkdtempSync(path.join(tmpdir(), 'vacancy-engine-discovery-runs-report-'));
  });

  afterEach(async () => {
    await rm(projectRoot, { recursive: true, force: true });
  });

  afterAll(() => {
    wiringClient?.close();
    wiringClient = undefined;
    rmSync(dbDirectory, { recursive: true, force: true });
  });

  it('inserts a row naming the timestamped report files and the discovery audit count', async () => {
    const report = sampleReport();
    const files = await writeGlobalRemoteReport(report, projectRoot);

    const recorded = await recordDiscoveryRun(wiringDb(), {
      generatedAt: new Date(report.generatedAt),
      vacancyCount: report.discoveryAudit.length,
      reportJsonPath: files.timestampedJson,
      reportHtmlPath: files.timestampedHtml,
    });

    expect(recorded.vacancyCount).toBe(2);
    expect(recorded.reportJsonPath).toBe(files.timestampedJson);
    expect(recorded.reportHtmlPath).toBe(files.timestampedHtml);
    expect(recorded.generatedAt).toEqual(new Date(report.generatedAt));
    expect(await latestDiscoveryRun(wiringDb())).toEqual(recorded);
  });
});
