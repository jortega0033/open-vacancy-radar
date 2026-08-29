import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  serializeCompanyDiscoveryCampaignCsv,
  serializeCompanyDiscoveryCampaignNdjson,
  writeCompanyDiscoveryCampaignExportSnapshot,
} from '../../src/companies/discovery-campaign-export.js';
import type {
  CompanyDiscoveryCampaignExportRow,
  CompanyDiscoveryCampaignProgress,
} from '../../src/companies/discovery-campaign-repository.js';

const temporaryDirectories: string[] = [];
const campaignRunId = '10000000-0000-4000-8000-000000000001';

function row(
  ordinal: number,
  overrides: Partial<CompanyDiscoveryCampaignExportRow> = {},
): CompanyDiscoveryCampaignExportRow {
  return {
    campaignRunId,
    ordinal,
    sponsorId: `20000000-0000-4000-8000-${String(ordinal).padStart(12, '0')}`,
    sourceIdentityKey: `source-${ordinal}`,
    legalName: `Sponsor ${ordinal} B.V.`,
    kvkNumber: '12345678',
    state: 'terminal',
    finalPhase: 'site_inspection',
    outcome: 'careers_found',
    reasonCode: 'supported_ats_found',
    networkAttempted: true,
    pagesAttempted: 2,
    pagesFetched: 2,
    physicalRequestCount: 2,
    httpStatus: 200,
    details: { provider: 'greenhouse' },
    completedAt: new Date('2026-08-28T12:05:00.000Z'),
    createdAt: new Date('2026-08-28T12:00:00.000Z'),
    updatedAt: new Date('2026-08-28T12:05:00.000Z'),
    ...overrides,
  };
}

function progress(): CompanyDiscoveryCampaignProgress {
  return {
    campaignRunId,
    runStatus: 'partial',
    startedAt: new Date('2026-08-28T12:00:00.000Z'),
    finishedAt: new Date('2026-08-28T12:10:00.000Z'),
    expectedSponsors: 2,
    totalSponsors: 2,
    pendingSponsors: 0,
    terminalSponsors: 2,
    siteInspectionAttemptedSponsors: 1,
    sitePagesAttempted: 2,
    sitePagesFetched: 2,
    sitePhysicalRequestCount: 2,
    structuredSourceRequestCount: 3,
    sourceScanRunId: '30000000-0000-4000-8000-000000000001',
    sourceScanPhysicalRequestCount: 4,
    totalPhysicalRequestCount: 9,
    outcomeCounts: { careers_found: 1, needs_domain: 1 },
    reasonCounts: { supported_ats_found: 1, no_verified_domain: 1 },
  };
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true })));
});

describe('company discovery campaign export', () => {
  it('serializes one stable NDJSON record per sponsor and formula-safe CSV cells', () => {
    const rows = [
      row(1, { legalName: '=DANGEROUS, "B.V."' }),
      row(2, {
        state: 'terminal',
        finalPhase: 'domain_resolution',
        outcome: 'needs_domain',
        reasonCode: 'no_verified_domain',
        networkAttempted: false,
        pagesAttempted: 0,
        pagesFetched: 0,
        physicalRequestCount: 0,
        httpStatus: null,
        details: {},
      }),
    ];

    const ndjson = serializeCompanyDiscoveryCampaignNdjson(rows);
    const ndjsonLines = ndjson.trimEnd().split('\n');
    expect(ndjsonLines).toHaveLength(2);
    ndjsonLines.forEach((line) => {
      const parsed: unknown = JSON.parse(line);
      expect(parsed).toBeTypeOf('object');
    });
    expect(ndjson).toContain('"completedAt":"2026-08-28T12:05:00.000Z"');
    expect(ndjson).toContain('"siteInspectionAttempted":true');
    expect(ndjson).not.toContain('"networkAttempted"');

    const csv = serializeCompanyDiscoveryCampaignCsv(rows);
    expect(csv.trimEnd().split('\n')).toHaveLength(3);
    expect(csv).toContain('"\'=DANGEROUS, ""B.V."""');
    expect(csv).toContain('"no_verified_domain"');
  });

  it('publishes NDJSON, CSV, and summary snapshots without temporary leftovers', async () => {
    const projectRoot = await mkdtemp(path.join(os.tmpdir(), 'ind-job-radar-campaign-'));
    temporaryDirectories.push(projectRoot);
    const rows = [
      row(1),
      row(2, {
        finalPhase: 'domain_resolution',
        outcome: 'needs_domain',
        reasonCode: 'no_verified_domain',
        networkAttempted: false,
        pagesAttempted: 0,
        pagesFetched: 0,
        physicalRequestCount: 0,
        httpStatus: null,
        details: {},
      }),
    ];

    const result = await writeCompanyDiscoveryCampaignExportSnapshot(progress(), rows, {
      projectRoot,
      generatedAt: new Date('2026-08-28T12:11:00.000Z'),
    });

    expect(result.exportedRows).toBe(2);
    expect((await readFile(result.files.ndjson, 'utf8')).trimEnd().split('\n')).toHaveLength(2);
    expect((await readFile(result.files.csv, 'utf8')).trimEnd().split('\n')).toHaveLength(3);
    expect(JSON.parse(await readFile(result.files.summary, 'utf8'))).toMatchObject({
      generatedAt: '2026-08-28T12:11:00.000Z',
      exportedRows: 2,
      campaignRunId,
      terminalSponsors: 2,
    });
    expect((await readdir(result.files.outputDirectory)).sort()).toEqual([
      'outcomes.csv',
      'outcomes.ndjson',
      'summary.json',
    ]);
  });

  it('rejects paths outside the project and non-contiguous export rows', async () => {
    const projectRoot = await mkdtemp(path.join(os.tmpdir(), 'ind-job-radar-campaign-'));
    temporaryDirectories.push(projectRoot);
    await expect(
      writeCompanyDiscoveryCampaignExportSnapshot(progress(), [row(1), row(2)], {
        projectRoot,
        outputDirectory: '../outside',
      }),
    ).rejects.toThrow('must remain inside the project');
    await expect(
      writeCompanyDiscoveryCampaignExportSnapshot(progress(), [row(2), row(1)], {
        projectRoot,
      }),
    ).rejects.toThrow('contiguous stable ordinals');
    await expect(
      writeCompanyDiscoveryCampaignExportSnapshot(
        { ...progress(), finishedAt: null, pendingSponsors: 1, terminalSponsors: 1 },
        [row(1), row(2)],
        { projectRoot },
      ),
    ).rejects.toThrow('must be finalized');
  });
});
