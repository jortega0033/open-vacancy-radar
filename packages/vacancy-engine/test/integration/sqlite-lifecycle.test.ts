import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { eq } from 'drizzle-orm';
import type { Logger } from 'pino';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { type CompanyMappingFile } from '../../src/companies/mappings.js';
import { syncVerifiedCompanyMappings } from '../../src/companies/repository.js';
import type { CompanyDomainCandidateFile } from '../../src/companies/domain-candidates.js';
import { promoteDiscoveredCareerSources } from '../../src/companies/discovery-promotion.js';
import {
  getDiscoveryCoverage,
  listDueDiscoveryCandidates,
  persistDiscoveryAttempt,
  seedSponsorDiscovery,
} from '../../src/companies/discovery-repository.js';
import {
  checkpointCompanyDiscoveryCampaign,
  completeCompanyDiscoveryCampaignItems,
  finalizeCompanyDiscoveryCampaign,
  getCompanyDiscoveryCampaignProgress,
  listCompanyDiscoveryCampaignItemsForExport,
  startOrResumeCompanyDiscoveryCampaign,
} from '../../src/companies/discovery-campaign-repository.js';
import {
  createDatabaseClient,
  migrateDatabase,
  type Database,
  type DatabaseClient,
} from '../../src/db/client.js';
import {
  careerSources,
  companies,
  companyAliases,
  companyDiscoveryCampaignItems,
  companyDiscoveryAttempts,
  companySponsors,
  indSponsors,
  scanErrors,
  scanRuns,
  scanSourceOutcomes,
  sponsorDiscovery,
  vacancies,
  vacancyScores,
  vacancySnapshots,
} from '../../src/db/schema.js';
import type { NormalizedVacancy } from '../../src/domain/models.js';
import { DETERMINISTIC_SCORING_VERSION } from '../../src/filtering/index.js';
import { normalizeLegalName } from '../../src/ind/normalize.js';
import {
  commitFailedSourceScan,
  commitSuccessfulSourceScan,
} from '../../src/pipeline/vacancies.js';
import { loadCandidateProfile } from '../../src/candidate/profile.js';
import { buildJobRadarReport } from '../../src/reporting/repository.js';
import { persistVacancyScan } from '../../src/vacancies/repository.js';

/**
 * The embedded engine needs no external service, so this suite always runs. It
 * owns a throwaway SQLite file in a temporary directory, applies the real
 * migrations to it, and truncates every table between cases.
 */
const migrationsFolder = fileURLToPath(new URL('../../drizzle', import.meta.url));
const temporaryDirectory = mkdtempSync(path.join(tmpdir(), 'vacancy-engine-lifecycle-'));
const testDatabasePath = path.join(temporaryDirectory, 'lifecycle-test.db');
// A fixture profile, independent of the shipped default (which is intentionally empty -- see
// issue #56 -- and would make every report in this file look like an unconfigured-profile run
// regardless of the real vacancyScores rows these tests seed directly).
const testProfilePath = path.join(temporaryDirectory, 'candidate-profile-v1.json');
writeFileSync(
  testProfilePath,
  JSON.stringify({
    profileVersion: 'candidate-profile-lifecycle-test',
    candidateName: 'Test Candidate',
    currentRole: 'Frontend Engineer',
    location: 'Netherlands',
    experienceYears: 5,
    strongestSkills: ['TypeScript'],
    additionalSkills: [],
    targetRoles: ['Frontend Engineer'],
    consideredRoles: [],
    excludedRoleFamilies: [],
    constraints: {
      professionalLanguage: 'English',
      dutchRequired: false,
      primaryCountry: 'Netherlands',
      allowRemoteEuSupportingNetherlands: true,
      minimumMonthlyBaseEur: 4000,
    },
  }),
  'utf8',
);

/**
 * Child-first order so `restrict` and `cascade` references stay satisfied while
 * foreign keys remain enforced.
 */
const INTEGRATION_TABLES = [
  'application_status',
  'scan_errors',
  'scan_source_outcomes',
  'company_discovery_campaign_items',
  'company_discovery_attempts',
  'sponsor_discovery',
  'scan_runs',
  'vacancy_scores',
  'vacancy_snapshots',
  'vacancies',
  'career_sources',
  'company_sponsors',
  'company_aliases',
  'companies',
  'ind_sponsor_snapshots',
  'ind_sponsors',
  'http_cache',
] as const;

let client: DatabaseClient | undefined;
let candidateProfileVersion = '';

function database(): Database {
  if (client === undefined) throw new Error('SQLite integration-test client is not initialized');
  return client.db;
}

function cleanIntegrationTables(): void {
  if (client === undefined) return;
  client.connection.exec(INTEGRATION_TABLES.map((table) => `delete from "${table}";`).join(' '));
}

function vacancy(externalId: string, source = 'integration-fixture'): NormalizedVacancy {
  return {
    externalId,
    title: 'Senior TypeScript Engineer',
    description: 'Build a TypeScript and React platform with Node.js services.',
    location: 'Amsterdam, Netherlands',
    remote: false,
    workplaceMode: 'onsite',
    url: `https://jobs.integration.test/vacancies/${externalId}`,
    postedAt: new Date('2026-08-20T12:00:00.000Z'),
    employmentType: 'Full-time',
    source,
  };
}

async function insertCompanyAndSource(): Promise<{ companyId: string; careerSourceId: string }> {
  const [company] = await database()
    .insert(companies)
    .values({
      brandName: 'Lifecycle Integration Company',
      domain: 'lifecycle.integration.test',
      mappingConfidence: 'high',
      mappingSource: 'integration-test',
      scanEnabled: true,
    })
    .returning({ id: companies.id });
  if (company === undefined) throw new Error('Company fixture insert did not return an id');

  const [source] = await database()
    .insert(careerSources)
    .values({
      companyId: company.id,
      sourceType: 'ats_api',
      provider: 'greenhouse',
      baseUrl: 'https://boards-api.greenhouse.io/v1/boards/integration/jobs',
      boardIdentifier: 'integration',
      discoveryMethod: 'integration-test',
      status: 'active',
    })
    .returning({ id: careerSources.id });
  if (source === undefined) throw new Error('Career-source fixture insert did not return an id');

  return { companyId: company.id, careerSourceId: source.id };
}

const recognisedSponsor = {
  legalName: 'Integration Sponsor B.V.',
  kvkNumber: '87654321',
};

async function insertRecognisedSponsor(): Promise<string> {
  const normalizedName = normalizeLegalName(recognisedSponsor.legalName);
  const [sponsor] = await database()
    .insert(indSponsors)
    .values({
      sourceIdentityKey: 'integration-test-sponsor-87654321',
      legalName: recognisedSponsor.legalName,
      normalizedName,
      searchName: normalizedName,
      kvkNumber: recognisedSponsor.kvkNumber,
      sourceUrl: 'https://ind.nl/integration-test',
      sourceRetrievedAt: new Date('2026-08-28T08:00:00.000Z'),
      sourceLastUpdated: new Date('2026-08-03T00:00:00.000Z'),
      active: true,
    })
    .returning({ id: indSponsors.id });
  if (sponsor === undefined) throw new Error('Sponsor fixture insert did not return an id');
  return sponsor.id;
}

type MappingOptions = {
  version: string;
  verifiedAt: string;
  baseUrl: string;
  sponsor?: { legalName: string; kvkNumber: string };
  domain?: string;
};

function mappingFile(options: MappingOptions): CompanyMappingFile {
  const sponsor = options.sponsor ?? recognisedSponsor;
  return {
    version: options.version,
    verifiedAt: options.verifiedAt,
    mappings: [
      {
        brandName: 'Mapping Integration Company',
        domain: options.domain ?? 'mapping.integration.test',
        mappingConfidence: 'high',
        mappingSource: 'integration-test',
        evidenceUrls: ['https://mapping.integration.test/evidence'],
        scanEnabled: true,
        sponsors: [
          {
            legalName: sponsor.legalName,
            kvkNumber: sponsor.kvkNumber,
            confidence: 'high',
            source: 'integration-test',
            evidenceUrls: ['https://mapping.integration.test/sponsor-evidence'],
          },
        ],
        careerSources: [
          {
            sourceType: 'ats_api',
            provider: 'greenhouse',
            baseUrl: options.baseUrl,
            boardIdentifier: 'mapping-integration',
            discoveryMethod: 'integration-test',
            evidenceUrls: ['https://mapping.integration.test/source-evidence'],
            status: 'active',
          },
        ],
      },
    ],
  };
}

describe('Embedded SQLite destructive lifecycle integration', () => {
  beforeAll(async () => {
    client = createDatabaseClient(testDatabasePath);
    await migrateDatabase(client.db, migrationsFolder);
    candidateProfileVersion = (await loadCandidateProfile(testProfilePath)).profileVersion;
  }, 30_000);

  beforeEach(() => {
    cleanIntegrationTables();
  });

  afterAll(() => {
    cleanIntegrationTables();
    client?.close();
    client = undefined;
    rmSync(temporaryDirectory, { recursive: true, force: true });
  });

  it('advances misses only on complete scans, deactivates after two, and reactivates without duplicating a snapshot', async () => {
    const ids = await insertCompanyAndSource();
    const firstObservation = new Date('2026-08-28T09:00:00.000Z');
    const normalized = vacancy('lifecycle-1');
    const reposted = { ...normalized, postedAt: new Date('2026-08-21T12:00:00.000Z') };

    expect(
      await persistVacancyScan(database(), {
        ...ids,
        vacancies: [normalized],
        complete: true,
        observedAt: firstObservation,
      }),
    ).toMatchObject({ created: 1, inactive: 0 });

    const [inserted] = await database()
      .select({
        id: vacancies.id,
        active: vacancies.active,
        missingCompleteScans: vacancies.missingCompleteScans,
      })
      .from(vacancies)
      .where(eq(vacancies.externalId, normalized.externalId));
    expect(inserted).toMatchObject({ active: true, missingCompleteScans: 0 });
    if (inserted === undefined) throw new Error('Vacancy fixture was not persisted');

    expect(
      await persistVacancyScan(database(), {
        ...ids,
        vacancies: [reposted],
        complete: true,
        observedAt: new Date('2026-08-28T09:30:00.000Z'),
      }),
    ).toMatchObject({ changed: 1, unchanged: 0 });

    await persistVacancyScan(database(), {
      ...ids,
      vacancies: [],
      complete: false,
      observedAt: new Date('2026-08-28T10:00:00.000Z'),
    });
    expect(
      await database()
        .select({ active: vacancies.active, misses: vacancies.missingCompleteScans })
        .from(vacancies)
        .where(eq(vacancies.id, inserted.id)),
    ).toEqual([{ active: true, misses: 0 }]);

    const invalidCompleteResult = await persistVacancyScan(database(), {
      ...ids,
      vacancies: [{ ...normalized, description: '' }],
      complete: true,
      observedAt: new Date('2026-08-28T10:30:00.000Z'),
    });
    expect(invalidCompleteResult.invalid).toBe(1);
    expect(
      await database()
        .select({ active: vacancies.active, misses: vacancies.missingCompleteScans })
        .from(vacancies)
        .where(eq(vacancies.id, inserted.id)),
    ).toEqual([{ active: true, misses: 0 }]);

    const firstMiss = await persistVacancyScan(database(), {
      ...ids,
      vacancies: [],
      complete: true,
      observedAt: new Date('2026-08-28T11:00:00.000Z'),
    });
    expect(firstMiss.inactive).toBe(0);
    expect(
      await database()
        .select({ active: vacancies.active, misses: vacancies.missingCompleteScans })
        .from(vacancies)
        .where(eq(vacancies.id, inserted.id)),
    ).toEqual([{ active: true, misses: 1 }]);

    const secondMiss = await persistVacancyScan(database(), {
      ...ids,
      vacancies: [],
      complete: true,
      observedAt: new Date('2026-08-28T12:00:00.000Z'),
    });
    expect(secondMiss.inactive).toBe(1);
    expect(
      await database()
        .select({ active: vacancies.active, misses: vacancies.missingCompleteScans })
        .from(vacancies)
        .where(eq(vacancies.id, inserted.id)),
    ).toEqual([{ active: false, misses: 2 }]);

    expect(
      await persistVacancyScan(database(), {
        ...ids,
        vacancies: [reposted],
        complete: true,
        observedAt: new Date('2026-08-28T13:00:00.000Z'),
      }),
    ).toMatchObject({ unchanged: 1, inactive: 0 });
    expect(
      await database()
        .select({ active: vacancies.active, misses: vacancies.missingCompleteScans })
        .from(vacancies)
        .where(eq(vacancies.id, inserted.id)),
    ).toEqual([{ active: true, misses: 0 }]);

    const snapshots = await database()
      .select({ id: vacancySnapshots.id })
      .from(vacancySnapshots)
      .where(eq(vacancySnapshots.vacancyId, inserted.id));
    expect(snapshots).toHaveLength(2);
  });

  it('rolls back vacancy lifecycle state when post-persistence source bookkeeping fails', async () => {
    const ids = await insertCompanyAndSource();
    const attemptedAt = new Date('2026-08-28T09:00:00.000Z');

    await expect(
      commitSuccessfulSourceScan(database(), {
        scanRunId: '00000000-0000-0000-0000-000000000000',
        row: {
          id: ids.careerSourceId,
          companyId: ids.companyId,
          companyName: 'Lifecycle Integration Company',
          companyScanEnabled: true,
          provider: 'greenhouse',
          baseUrl: 'https://boards-api.greenhouse.io/v1/boards/integration/jobs',
          boardIdentifier: 'integration',
          status: 'active',
        },
        adapterResult: {
          vacancies: [vacancy('rollback-fixture')],
          complete: true,
          requestCount: 1,
          invalidCount: 0,
        },
        requestCount: 1,
        durationMs: 100,
        completedAt: attemptedAt,
      }),
    ).rejects.toThrow();

    expect(
      await database()
        .select({ id: vacancies.id })
        .from(vacancies)
        .where(eq(vacancies.careerSourceId, ids.careerSourceId)),
    ).toEqual([]);
    expect(
      await database()
        .select({ lastSuccessAt: careerSources.lastSuccessAt })
        .from(careerSources)
        .where(eq(careerSources.id, ids.careerSourceId)),
    ).toEqual([{ lastSuccessAt: null }]);
    expect(
      await database()
        .select({ lastScannedAt: companies.lastScannedAt })
        .from(companies)
        .where(eq(companies.id, ids.companyId)),
    ).toEqual([{ lastScannedAt: null }]);
  });

  it('rolls back source and company failure state when diagnostic persistence fails', async () => {
    const ids = await insertCompanyAndSource();
    const failedAt = new Date('2026-08-28T09:00:00.000Z');

    await expect(
      commitFailedSourceScan(database(), {
        scanRunId: '00000000-0000-0000-0000-000000000000',
        row: {
          id: ids.careerSourceId,
          companyId: ids.companyId,
          companyName: 'Lifecycle Integration Company',
          companyScanEnabled: true,
          provider: 'greenhouse',
          baseUrl: 'https://boards-api.greenhouse.io/v1/boards/integration/jobs',
          boardIdentifier: 'integration',
          status: 'active',
        },
        outcomeStatus: 'failed',
        sourceStatus: 'error',
        diagnostic: { category: 'network_error', message: 'Controlled failure' },
        requestCount: 1,
        durationMs: 100,
        completedAt: failedAt,
      }),
    ).rejects.toThrow();

    expect(
      await database()
        .select({ status: careerSources.status, lastFailureAt: careerSources.lastFailureAt })
        .from(careerSources)
        .where(eq(careerSources.id, ids.careerSourceId)),
    ).toEqual([{ status: 'active', lastFailureAt: null }]);
    expect(
      await database()
        .select({ lastScannedAt: companies.lastScannedAt })
        .from(companies)
        .where(eq(companies.id, ids.companyId)),
    ).toEqual([{ lastScannedAt: null }]);
  });

  it('quarantines severe complete-feed drops without aging unseen vacancies', async () => {
    const ids = await insertCompanyAndSource();
    const baseline = Array.from({ length: 20 }, (_value, index) => vacancy(`baseline-${index}`));
    const firstBaselineVacancy = baseline[0];
    if (firstBaselineVacancy === undefined) throw new Error('Baseline vacancy fixture is empty');
    await persistVacancyScan(database(), {
      ...ids,
      vacancies: baseline,
      complete: true,
      observedAt: new Date('2026-08-28T08:00:00.000Z'),
    });
    const [scanRun] = await database()
      .insert(scanRuns)
      .values({ command: 'feed-anomaly-integration', status: 'running' })
      .returning({ id: scanRuns.id });
    if (scanRun === undefined) throw new Error('Feed-anomaly scan run was not persisted');

    const result = await commitSuccessfulSourceScan(database(), {
      scanRunId: scanRun.id,
      row: {
        id: ids.careerSourceId,
        companyId: ids.companyId,
        companyName: 'Lifecycle Integration Company',
        companyScanEnabled: true,
        provider: 'greenhouse',
        baseUrl: 'https://boards-api.greenhouse.io/v1/boards/integration/jobs',
        boardIdentifier: 'integration',
        status: 'active',
      },
      adapterResult: {
        vacancies: [firstBaselineVacancy],
        complete: true,
        requestCount: 1,
        invalidCount: 0,
      },
      requestCount: 1,
      durationMs: 100,
      completedAt: new Date('2026-08-28T09:00:00.000Z'),
    });

    expect(result).toMatchObject({
      complete: false,
      persisted: {
        completeAccepted: false,
        feedAnomaly: { baselineActive: 20, observed: 1 },
        inactive: 0,
      },
    });
    expect(
      await database()
        .select({ status: careerSources.status })
        .from(careerSources)
        .where(eq(careerSources.id, ids.careerSourceId)),
    ).toEqual([{ status: 'manual_review' }]);
    expect(
      await database()
        .select({ active: vacancies.active, misses: vacancies.missingCompleteScans })
        .from(vacancies)
        .where(eq(vacancies.careerSourceId, ids.careerSourceId)),
    ).toEqual(
      expect.arrayContaining(
        Array.from({ length: 20 }, () => ({ active: true, misses: 0 })),
      ),
    );
    expect(
      await database()
        .select({ category: scanErrors.category })
        .from(scanErrors)
        .where(eq(scanErrors.scanRunId, scanRun.id)),
    ).toEqual([{ category: 'parse_error' }]);
    expect(
      await database()
        .select({
          status: scanSourceOutcomes.status,
          complete: scanSourceOutcomes.complete,
        })
        .from(scanSourceOutcomes)
        .where(eq(scanSourceOutcomes.scanRunId, scanRun.id)),
    ).toEqual([{ status: 'manual_review', complete: false }]);
  });

  it('does not advance misses when an adapter reports dropped entries', async () => {
    const ids = await insertCompanyAndSource();
    await persistVacancyScan(database(), {
      ...ids,
      vacancies: [vacancy('adapter-invalid-existing')],
      complete: true,
    });
    const [scanRun] = await database()
      .insert(scanRuns)
      .values({ command: 'adapter-invalid-integration', status: 'running' })
      .returning({ id: scanRuns.id });
    if (scanRun === undefined) throw new Error('Adapter-invalid scan run was not persisted');
    const row = {
      id: ids.careerSourceId,
      companyId: ids.companyId,
      companyName: 'Lifecycle Integration Company',
      companyScanEnabled: true,
      provider: 'greenhouse',
      baseUrl: 'https://boards-api.greenhouse.io/v1/boards/integration/jobs',
      boardIdentifier: 'integration',
      status: 'active' as const,
    };

    for (let attempt = 0; attempt < 2; attempt += 1) {
      await commitSuccessfulSourceScan(database(), {
        scanRunId: scanRun.id,
        row,
        adapterResult: { vacancies: [], complete: true, requestCount: 1, invalidCount: 1 },
        requestCount: 1,
        durationMs: 100,
        completedAt: new Date(`2026-08-28T1${attempt}:00:00.000Z`),
      });
    }

    expect(
      await database()
        .select({ active: vacancies.active, misses: vacancies.missingCompleteScans })
        .from(vacancies)
        .where(eq(vacancies.careerSourceId, ids.careerSourceId)),
    ).toEqual([{ active: true, misses: 0 }]);
  });

  it('retires removed sources and mappings while preserving state during a transient sponsor mismatch', async () => {
    await insertRecognisedSponsor();
    const sourceAUrl = 'https://boards-api.greenhouse.io/v1/boards/mapping-a/jobs';
    const sourceBUrl = 'https://boards-api.greenhouse.io/v1/boards/mapping-b/jobs';

    await syncVerifiedCompanyMappings(
      database(),
      mappingFile({
        version: 'integration-v1',
        verifiedAt: '2026-08-28T08:00:00.000Z',
        baseUrl: sourceAUrl,
      }),
    );
    const [company] = await database()
      .select({ id: companies.id })
      .from(companies)
      .where(eq(companies.domain, 'mapping.integration.test'));
    if (company === undefined) throw new Error('Mapped company was not persisted');
    const [sourceA] = await database()
      .select({ id: careerSources.id })
      .from(careerSources)
      .where(eq(careerSources.baseUrl, sourceAUrl));
    if (sourceA === undefined) throw new Error('First mapped source was not persisted');

    await persistVacancyScan(database(), {
      companyId: company.id,
      careerSourceId: sourceA.id,
      vacancies: [vacancy('source-a-vacancy', 'source-a')],
      complete: true,
    });

    await syncVerifiedCompanyMappings(
      database(),
      mappingFile({
        version: 'integration-v2',
        verifiedAt: '2026-08-28T09:00:00.000Z',
        baseUrl: sourceBUrl,
      }),
    );
    expect(
      await database()
        .select({ status: careerSources.status, retiredAt: careerSources.retiredAt })
        .from(careerSources)
        .where(eq(careerSources.id, sourceA.id)),
    ).toEqual([
      { status: 'unsupported', retiredAt: new Date('2026-08-28T09:00:00.000Z') },
    ]);
    expect(
      await database()
        .select({ active: vacancies.active })
        .from(vacancies)
        .where(eq(vacancies.careerSourceId, sourceA.id)),
    ).toEqual([{ active: false }]);

    const [sourceB] = await database()
      .select({
        id: careerSources.id,
        status: careerSources.status,
        retiredAt: careerSources.retiredAt,
      })
      .from(careerSources)
      .where(eq(careerSources.baseUrl, sourceBUrl));
    expect(sourceB?.status).toBe('active');
    expect(sourceB?.retiredAt).toBeNull();
    if (sourceB === undefined) throw new Error('Replacement source was not persisted');
    await persistVacancyScan(database(), {
      companyId: company.id,
      careerSourceId: sourceB.id,
      vacancies: [vacancy('source-b-vacancy', 'source-b')],
      complete: true,
    });

    await expect(
      syncVerifiedCompanyMappings(
        database(),
        mappingFile({
          version: 'integration-conflicting-same-time',
          verifiedAt: '2026-08-28T09:00:00.000Z',
          baseUrl: sourceAUrl,
        }),
      ),
    ).rejects.toThrow('content changed without advancing verifiedAt');

    await expect(
      syncVerifiedCompanyMappings(
        database(),
        mappingFile({
          version: 'integration-older',
          verifiedAt: '2026-08-28T08:30:00.000Z',
          baseUrl: sourceAUrl,
        }),
      ),
    ).rejects.toThrow('mapping regression');
    expect(
      await database()
        .select({ baseUrl: careerSources.baseUrl, status: careerSources.status })
        .from(careerSources)
        .where(eq(careerSources.companyId, company.id)),
    ).toEqual([
      { baseUrl: sourceAUrl, status: 'unsupported' },
      { baseUrl: sourceBUrl, status: 'active' },
    ]);

    const transientMismatch = await syncVerifiedCompanyMappings(
      database(),
      mappingFile({
        version: 'integration-v3',
        verifiedAt: '2026-08-28T10:00:00.000Z',
        baseUrl: sourceBUrl,
        sponsor: { legalName: 'Temporarily Missing Sponsor B.V.', kvkNumber: '00000000' },
      }),
    );
    expect(transientMismatch.skippedCompanies).toEqual(['Mapping Integration Company']);
    expect(
      await database()
        .select({ enabled: companies.scanEnabled, confidence: companies.mappingConfidence })
        .from(companies)
        .where(eq(companies.id, company.id)),
    ).toEqual([{ enabled: false, confidence: 'unknown' }]);
    expect(
      await database()
        .select({ status: careerSources.status, retiredAt: careerSources.retiredAt })
        .from(careerSources)
        .where(eq(careerSources.id, sourceB.id)),
    ).toEqual([{ status: 'manual_review', retiredAt: null }]);
    expect(
      await database()
        .select({ sponsorId: companySponsors.sponsorId })
        .from(companySponsors)
        .where(eq(companySponsors.companyId, company.id)),
    ).toHaveLength(1);
    expect(
      await database()
        .select({ active: vacancies.active })
        .from(vacancies)
        .where(eq(vacancies.careerSourceId, sourceB.id)),
    ).toEqual([{ active: true }]);

    await syncVerifiedCompanyMappings(database(), {
      version: 'integration-v4',
      verifiedAt: '2026-08-28T11:00:00.000Z',
      mappings: [],
    });
    expect(
      await database()
        .select({ enabled: companies.scanEnabled })
        .from(companies)
        .where(eq(companies.id, company.id)),
    ).toEqual([{ enabled: false }]);
    expect(
      await database()
        .select({ status: careerSources.status, retiredAt: careerSources.retiredAt })
        .from(careerSources)
        .where(eq(careerSources.companyId, company.id)),
    ).toEqual([
      { status: 'unsupported', retiredAt: new Date('2026-08-28T11:00:00.000Z') },
      { status: 'unsupported', retiredAt: new Date('2026-08-28T11:00:00.000Z') },
    ]);
    expect(
      await database()
        .select({ sponsorId: companySponsors.sponsorId })
        .from(companySponsors)
        .where(eq(companySponsors.companyId, company.id)),
    ).toHaveLength(0);
    expect(
      await database()
        .select({ active: vacancies.active })
        .from(vacancies)
        .where(eq(vacancies.companyId, company.id)),
    ).toEqual([{ active: false }, { active: false }]);
  });

  it('uses normalized aliases to retain company identity when a verified domain changes', async () => {
    await insertRecognisedSponsor();
    const sourceUrl = 'https://boards-api.greenhouse.io/v1/boards/alias-integration/jobs';
    await syncVerifiedCompanyMappings(
      database(),
      mappingFile({
        version: 'alias-v1',
        verifiedAt: '2026-08-28T08:00:00.000Z',
        baseUrl: sourceUrl,
      }),
    );
    const [original] = await database()
      .select({ id: companies.id })
      .from(companies)
      .where(eq(companies.domain, 'mapping.integration.test'));
    if (original === undefined) throw new Error('Alias fixture company was not persisted');

    await syncVerifiedCompanyMappings(
      database(),
      mappingFile({
        version: 'alias-v2',
        verifiedAt: '2026-08-28T09:00:00.000Z',
        baseUrl: sourceUrl,
        domain: 'mapping-renamed.integration.test',
      }),
    );

    expect(
      await database().select({ id: companies.id, domain: companies.domain }).from(companies),
    ).toEqual([{ id: original.id, domain: 'mapping-renamed.integration.test' }]);
    expect(
      await database()
        .select({ alias: companyAliases.alias })
        .from(companyAliases)
        .where(eq(companyAliases.companyId, original.id)),
    ).toEqual(
      expect.arrayContaining([
        { alias: 'Mapping Integration Company' },
        { alias: recognisedSponsor.legalName },
      ]),
    );
  });

  it('preserves discovery ownership when the curated catalog later withdraws the same mapping', async () => {
    await insertRecognisedSponsor();
    const sourceUrl = 'https://boards-api.greenhouse.io/v1/boards/mapping-integration/jobs';
    const automaticRelationshipEvidence = {
      kind: 'verified_official_site_observation',
      inspectionAttemptId: 'ownership-discovery-attempt',
      officialUrl: 'https://mapping.integration.test/careers',
    };
    await syncVerifiedCompanyMappings(
      database(),
      mappingFile({
        version: 'ownership-v1',
        verifiedAt: '2026-08-28T08:00:00.000Z',
        baseUrl: sourceUrl,
      }),
    );
    const [company] = await database()
      .select({ id: companies.id })
      .from(companies)
      .where(eq(companies.domain, 'mapping.integration.test'));
    if (company === undefined) throw new Error('Ownership fixture company was not persisted');
    const [source] = await database()
      .select({ id: careerSources.id })
      .from(careerSources)
      .where(eq(careerSources.companyId, company.id));
    if (source === undefined) throw new Error('Ownership fixture source was not persisted');

    await database()
      .update(companySponsors)
      .set({
        discoveryManaged: true,
        evidence: { automaticDiscovery: automaticRelationshipEvidence },
      })
      .where(eq(companySponsors.companyId, company.id));
    await database()
      .update(careerSources)
      .set({ discoveryManaged: true })
      .where(eq(careerSources.id, source.id));
    await persistVacancyScan(database(), {
      companyId: company.id,
      careerSourceId: source.id,
      vacancies: [vacancy('discovery-owned-vacancy')],
      complete: true,
    });

    await syncVerifiedCompanyMappings(
      database(),
      mappingFile({
        version: 'ownership-v2',
        verifiedAt: '2026-08-28T09:00:00.000Z',
        baseUrl: sourceUrl,
      }),
    );
    expect(
      await database()
        .select({ evidence: companySponsors.evidence })
        .from(companySponsors)
        .where(eq(companySponsors.companyId, company.id)),
    ).toEqual([
      {
        evidence: {
          automaticDiscovery: automaticRelationshipEvidence,
          mappingVersion: 'ownership-v2',
          urls: ['https://mapping.integration.test/sponsor-evidence'],
        },
      },
    ]);

    await syncVerifiedCompanyMappings(database(), {
      version: 'ownership-v3',
      verifiedAt: '2026-08-28T10:00:00.000Z',
      mappings: [],
    });

    expect(
      await database()
        .select({
          catalogManaged: companySponsors.catalogManaged,
          discoveryManaged: companySponsors.discoveryManaged,
          evidence: companySponsors.evidence,
        })
        .from(companySponsors)
        .where(eq(companySponsors.companyId, company.id)),
    ).toEqual([
      {
        catalogManaged: false,
        discoveryManaged: true,
        evidence: {
          automaticDiscovery: automaticRelationshipEvidence,
          mappingVersion: 'ownership-v2',
          urls: ['https://mapping.integration.test/sponsor-evidence'],
        },
      },
    ]);
    expect(
      await database()
        .select({
          status: careerSources.status,
          retiredAt: careerSources.retiredAt,
          catalogManaged: careerSources.catalogManaged,
          discoveryManaged: careerSources.discoveryManaged,
        })
        .from(careerSources)
        .where(eq(careerSources.id, source.id)),
    ).toEqual([
      {
        status: 'active',
        retiredAt: null,
        catalogManaged: false,
        discoveryManaged: true,
      },
    ]);
    expect(
      await database()
        .select({ enabled: companies.scanEnabled })
        .from(companies)
        .where(eq(companies.id, company.id)),
    ).toEqual([{ enabled: true }]);
    expect(
      await database()
        .select({ active: vacancies.active })
        .from(vacancies)
        .where(eq(vacancies.careerSourceId, source.id)),
    ).toEqual([{ active: true }]);
  });

  it('reports only current sponsor-eligible vacancies and collapses exact reposts', async () => {
    await insertRecognisedSponsor();
    const sourceUrl = 'https://boards-api.greenhouse.io/v1/boards/report-integration/jobs';
    await syncVerifiedCompanyMappings(
      database(),
      mappingFile({
        version: 'report-v1',
        verifiedAt: '2026-08-28T08:00:00.000Z',
        baseUrl: sourceUrl,
      }),
    );
    const [company] = await database()
      .select({ id: companies.id })
      .from(companies)
      .where(eq(companies.domain, 'mapping.integration.test'));
    const [source] = await database()
      .select({ id: careerSources.id })
      .from(careerSources)
      .where(eq(careerSources.baseUrl, sourceUrl));
    if (company === undefined || source === undefined) {
      throw new Error('Report eligibility fixtures were not persisted');
    }

    const firstRepost = vacancy('repost-a');
    const secondRepost = {
      ...vacancy('repost-b'),
      url: 'https://jobs.integration.test/vacancies/reposted-copy',
    };
    const stale = {
      ...vacancy('stale-role'),
      title: 'Senior React Engineer',
      postedAt: new Date('2024-01-01T00:00:00.000Z'),
    };
    await persistVacancyScan(database(), {
      companyId: company.id,
      careerSourceId: source.id,
      vacancies: [firstRepost, secondRepost, stale],
      complete: true,
      observedAt: new Date('2026-08-28T09:00:00.000Z'),
    });
    const persistedVacancies = await database()
      .select({ id: vacancies.id, contentHash: vacancies.contentHash })
      .from(vacancies)
      .where(eq(vacancies.companyId, company.id));
    await database().insert(vacancyScores).values(
      persistedVacancies.map((persisted) => ({
        vacancyId: persisted.id,
        // The report only joins scores written for the profile version the
        // checked-in candidate profile currently declares.
        candidateProfileVersion: candidateProfileVersion,
        scoringVersion: DETERMINISTIC_SCORING_VERSION,
        deterministicScore: 85,
        finalScore: 85,
        technicalFit: 90,
        roleFit: 85,
        seniorityFit: 90,
        languageFit: 100,
        locationFit: 100,
        dutchRequired: false,
        dutchPreferred: false,
        languageEvidence: [],
        primaryFit: 'Frontend product engineering',
        matchingSkills: ['TypeScript', 'React'],
        gaps: [],
        reasons: ['Integration fixture'],
        contentHash: persisted.contentHash,
        scoredAt: new Date('2026-08-28T09:05:00.000Z'),
      })),
    );
    const [scanRun] = await database()
      .insert(scanRuns)
      .values({
        command: 'integration-report',
        status: 'partial',
        finishedAt: new Date('2026-08-28T09:10:00.000Z'),
      })
      .returning({ id: scanRuns.id });
    if (scanRun === undefined) throw new Error('Report scan-run fixture was not persisted');
    await database().insert(scanSourceOutcomes).values({
      scanRunId: scanRun.id,
      careerSourceId: source.id,
      status: 'failed',
      complete: false,
      vacanciesSeen: 0,
      requestCount: 1,
      durationMs: 100,
    });

    const report = await buildJobRadarReport(database(), {
      scanRunId: scanRun.id,
      generatedAt: new Date('2026-08-28T12:00:00.000Z'),
      maximumPostingAgeDays: 365,
      profilePath: testProfilePath,
    });
    expect(report.statistics).toMatchObject({
      deterministicCandidates: 3,
      staleVacanciesExcluded: 1,
      duplicateVacanciesCollapsed: 1,
      relevantVacancies: 1,
    });
    expect(report.vacancies).toHaveLength(1);
    expect(report.vacancies[0]?.sponsorLegalNames).toEqual([recognisedSponsor.legalName]);
    expect(report.vacancies[0]).toMatchObject({
      verifiedInRun: false,
      sourceOutcomeStatus: 'failed',
      lastSeenAt: '2026-08-28T09:00:00.000Z',
    });

    await database()
      .update(scanRuns)
      .set({
        startedAt: new Date('2026-08-28T10:00:00.000Z'),
        status: 'succeeded',
        statistics: { sponsorsLoaded: 3, errorCount: 2 },
      })
      .where(eq(scanRuns.id, scanRun.id));
    await database()
      .update(scanSourceOutcomes)
      .set({ status: 'succeeded', complete: true })
      .where(eq(scanSourceOutcomes.scanRunId, scanRun.id));
    const laterSuccessfulReport = await buildJobRadarReport(database(), {
      scanRunId: scanRun.id,
      generatedAt: new Date('2026-08-28T12:00:00.000Z'),
      maximumPostingAgeDays: 365,
      profilePath: testProfilePath,
    });
    expect(laterSuccessfulReport.vacancies[0]).toMatchObject({
      verifiedInRun: false,
      sourceOutcomeStatus: 'succeeded',
    });
    expect(laterSuccessfulReport.statistics).toMatchObject({
      sponsorsLoaded: 3,
      careerSourcesScanned: 1,
      incompleteSources: 0,
      errorCount: 2,
    });

    await database()
      .update(scanSourceOutcomes)
      .set({ complete: false })
      .where(eq(scanSourceOutcomes.scanRunId, scanRun.id));
    const incompleteReport = await buildJobRadarReport(database(), {
      scanRunId: scanRun.id,
      generatedAt: new Date('2026-08-28T12:00:00.000Z'),
      maximumPostingAgeDays: 365,
      profilePath: testProfilePath,
    });
    expect(incompleteReport.statistics).toMatchObject({
      careerSourcesScanned: 0,
      incompleteSources: 1,
    });

    await syncVerifiedCompanyMappings(
      database(),
      mappingFile({
        version: 'report-v2',
        verifiedAt: '2026-08-28T10:00:00.000Z',
        baseUrl: sourceUrl,
        sponsor: { legalName: 'Temporarily Missing Sponsor B.V.', kvkNumber: '00000000' },
      }),
    );
    expect(
      await database()
        .select({ active: vacancies.active })
        .from(vacancies)
        .where(eq(vacancies.companyId, company.id)),
    ).toEqual([{ active: true }, { active: true }, { active: true }]);
    const gatedReport = await buildJobRadarReport(database(), {
      scanRunId: scanRun.id,
      generatedAt: new Date('2026-08-28T12:00:00.000Z'),
      maximumPostingAgeDays: 365,
      profilePath: testProfilePath,
    });
    expect(gatedReport.vacancies).toEqual([]);
    expect(gatedReport.statistics.deterministicCandidates).toBe(0);
  });

  it('returns every discovered vacancy unscored, not an empty list, when the candidate profile is unconfigured', async () => {
    await insertRecognisedSponsor();
    const sourceUrl = 'https://boards-api.greenhouse.io/v1/boards/unconfigured-profile/jobs';
    await syncVerifiedCompanyMappings(
      database(),
      mappingFile({
        version: 'unconfigured-profile-v1',
        verifiedAt: '2026-08-28T08:00:00.000Z',
        baseUrl: sourceUrl,
      }),
    );
    const [company] = await database()
      .select({ id: companies.id })
      .from(companies)
      .where(eq(companies.domain, 'mapping.integration.test'));
    const [source] = await database()
      .select({ id: careerSources.id })
      .from(careerSources)
      .where(eq(careerSources.baseUrl, sourceUrl));
    if (company === undefined || source === undefined) {
      throw new Error('Unconfigured-profile report fixtures were not persisted');
    }
    await persistVacancyScan(database(), {
      companyId: company.id,
      careerSourceId: source.id,
      vacancies: [vacancy('unscored-role')],
      complete: true,
      observedAt: new Date('2026-08-28T09:00:00.000Z'),
    });
    // Deliberately no vacancyScores insert: an unconfigured profile means scoring never ran.
    const [scanRun] = await database()
      .insert(scanRuns)
      .values({ command: 'integration-report', status: 'succeeded', finishedAt: new Date('2026-08-28T09:10:00.000Z') })
      .returning({ id: scanRuns.id });
    if (scanRun === undefined) throw new Error('Unconfigured-profile scan-run fixture was not persisted');

    const emptyProfilePath = path.join(temporaryDirectory, 'candidate-profile-unconfigured.json');
    writeFileSync(
      emptyProfilePath,
      JSON.stringify({
        profileVersion: 'candidate-profile-unconfigured-test',
        candidateName: '',
        currentRole: '',
        location: '',
        experienceYears: 0,
        strongestSkills: [],
        additionalSkills: [],
        targetRoles: [],
        consideredRoles: [],
        excludedRoleFamilies: [],
        constraints: {
          professionalLanguage: '',
          dutchRequired: false,
          primaryCountry: '',
          allowRemoteEuSupportingNetherlands: true,
          minimumMonthlyBaseEur: 0,
        },
      }),
      'utf8',
    );

    const report = await buildJobRadarReport(database(), {
      scanRunId: scanRun.id,
      generatedAt: new Date('2026-08-28T12:00:00.000Z'),
      maximumPostingAgeDays: 365,
      profilePath: emptyProfilePath,
    });

    expect(report.profileConfigured).toBe(false);
    // The bug this test guards against: an inner join on vacancyScores (which has zero rows for
    // this profile version) would silently return an empty list here, indistinguishable from a
    // real "nothing matched" result.
    expect(report.vacancies).toHaveLength(1);
    expect(report.vacancies[0]?.title).toBe('Senior TypeScript Engineer');
    expect(report.vacancies[0]?.score).toBeUndefined();
    expect(report.vacancies[0]?.matchingSkills).toBeUndefined();
    expect(report.statistics.deterministicCandidates).toBe(0);
    // The vacancy above is real (score !== undefined would make it "relevant"), but nothing was
    // ever scored against the empty profile, so it must not be counted as a relevance match.
    expect(report.statistics.relevantVacancies).toBe(0);
  });

  it('seeds trusted discovery inventory and commits bounded attempts atomically without promoting candidates', async () => {
    const sponsorFixtures = [
      { legalName: 'Discovery High Priority B.V.', kvkNumber: '10000001' },
      { legalName: 'Discovery Lower Priority B.V.', kvkNumber: '10000002' },
      { legalName: 'Discovery Medium Confidence B.V.', kvkNumber: '10000003' },
      { legalName: 'Discovery Needs Domain B.V.', kvkNumber: '10000004' },
      { legalName: 'Discovery Mapped Active B.V.', kvkNumber: '10000005' },
      { legalName: 'Discovery Mapped Manual B.V.', kvkNumber: '10000006' },
    ];
    const insertedSponsors = await database()
      .insert(indSponsors)
      .values(
        sponsorFixtures.map((sponsor) => {
          const normalizedName = normalizeLegalName(sponsor.legalName);
          return {
            sourceIdentityKey: `discovery-${sponsor.kvkNumber}`,
            legalName: sponsor.legalName,
            normalizedName,
            searchName: normalizedName,
            kvkNumber: sponsor.kvkNumber,
            sourceUrl: 'https://ind.nl/discovery-integration',
            sourceRetrievedAt: new Date('2026-08-28T08:00:00.000Z'),
            sourceLastUpdated: new Date('2026-08-03T00:00:00.000Z'),
            active: true,
          };
        }),
      )
      .returning({ id: indSponsors.id, kvkNumber: indSponsors.kvkNumber });
    const sponsorIdByKvk = new Map(
      insertedSponsors.map((sponsor) => [sponsor.kvkNumber, sponsor.id]),
    );
    const mappedActiveSponsorId = sponsorIdByKvk.get('10000005');
    const mappedManualSponsorId = sponsorIdByKvk.get('10000006');
    if (mappedActiveSponsorId === undefined || mappedManualSponsorId === undefined) {
      throw new Error('Mapped discovery sponsor fixtures were not persisted');
    }

    const mappedCompanies = await database()
      .insert(companies)
      .values([
        {
          brandName: 'Mapped Active',
          domain: 'mapped-active.discovery.test',
          mappingConfidence: 'high',
          mappingSource: 'integration-test',
          mappingEvidence: { evidenceUrls: ['https://evidence.test/mapped-active'] },
          scanEnabled: true,
        },
        {
          brandName: 'Mapped Manual',
          domain: 'mapped-manual.discovery.test',
          mappingConfidence: 'high',
          mappingSource: 'integration-test',
          mappingEvidence: { evidenceUrls: ['https://evidence.test/mapped-manual'] },
          scanEnabled: true,
        },
      ])
      .returning({ id: companies.id, brandName: companies.brandName });
    const mappedActiveCompany = mappedCompanies.find((company) => company.brandName === 'Mapped Active');
    const mappedManualCompany = mappedCompanies.find((company) => company.brandName === 'Mapped Manual');
    if (mappedActiveCompany === undefined || mappedManualCompany === undefined) {
      throw new Error('Mapped discovery company fixtures were not persisted');
    }
    await database().insert(companySponsors).values([
      {
        companyId: mappedActiveCompany.id,
        sponsorId: mappedActiveSponsorId,
        confidence: 'high',
        source: 'integration-test',
      },
      {
        companyId: mappedManualCompany.id,
        sponsorId: mappedManualSponsorId,
        confidence: 'high',
        source: 'integration-test',
      },
    ]);
    await database().insert(careerSources).values([
      {
        companyId: mappedActiveCompany.id,
        sourceType: 'ats_api',
        provider: 'greenhouse',
        baseUrl: 'https://boards-api.greenhouse.io/v1/boards/discovery-active/jobs',
        boardIdentifier: 'discovery-active',
        discoveryMethod: 'integration-test',
        status: 'active',
      },
      {
        companyId: mappedManualCompany.id,
        sourceType: 'ats_api',
        provider: 'greenhouse',
        baseUrl: 'https://boards-api.greenhouse.io/v1/boards/discovery-manual/jobs',
        boardIdentifier: 'discovery-manual',
        discoveryMethod: 'integration-test',
        status: 'blocked',
      },
    ]);

    const candidateFile = {
      version: 'discovery-integration-v1',
      verifiedAt: '2026-08-28T09:00:00.000Z',
      candidates: [
        {
          legalName: 'Discovery High Priority BV',
          kvkNumber: '10000001',
          brandName: 'Discovery High',
          officialUrl: 'https://high.discovery.test/',
          confidence: 'high',
          source: 'integration-test',
          evidenceUrls: ['https://evidence.test/high'],
          priority: 90,
        },
        {
          legalName: 'Discovery Lower Priority B.V.',
          kvkNumber: '10000002',
          brandName: 'Discovery Lower',
          officialUrl: 'https://lower.discovery.test/',
          confidence: 'high',
          source: 'integration-test',
          evidenceUrls: ['https://evidence.test/lower'],
          priority: 10,
        },
        {
          legalName: 'Discovery Medium Confidence B.V.',
          kvkNumber: '10000003',
          brandName: 'Discovery Medium',
          officialUrl: 'https://medium.discovery.test/',
          confidence: 'medium',
          source: 'integration-test',
          evidenceUrls: ['https://evidence.test/medium'],
          priority: 50,
        },
        {
          legalName: 'Discovery Mapped Active B.V.',
          kvkNumber: '10000005',
          brandName: 'Wrong Candidate Active',
          officialUrl: 'https://wrong-active.discovery.test/',
          confidence: 'high',
          source: 'integration-test',
          evidenceUrls: ['https://evidence.test/wrong-active'],
          priority: 100,
        },
        {
          legalName: 'Discovery Mapped Manual B.V.',
          kvkNumber: '10000006',
          brandName: 'Wrong Candidate Manual',
          officialUrl: 'https://wrong-manual.discovery.test/',
          confidence: 'high',
          source: 'integration-test',
          evidenceUrls: ['https://evidence.test/wrong-manual'],
          priority: 100,
        },
        {
          legalName: 'Candidate Missing From IND B.V.',
          kvkNumber: '19999999',
          brandName: 'Missing',
          officialUrl: 'https://missing.discovery.test/',
          confidence: 'high',
          source: 'integration-test',
          evidenceUrls: ['https://evidence.test/missing'],
          priority: 100,
        },
      ],
    } satisfies CompanyDomainCandidateFile;

    const firstSeed = await seedSponsorDiscovery(
      database(),
      candidateFile,
      new Date('2026-08-28T09:05:00.000Z'),
    );
    expect(firstSeed).toMatchObject({
      activeSponsors: 6,
      inventoryInserted: 6,
      candidateMatches: 5,
      candidateReady: 2,
      candidateManualReview: 1,
      candidateNotFound: 1,
      candidateAmbiguous: 0,
      mappedSponsors: 2,
      mappedActive: 1,
      mappedManualReview: 1,
    });
    expect(await getDiscoveryCoverage(database())).toEqual([
      { status: 'needs_domain', count: 1 },
      { status: 'candidate_ready', count: 2 },
      { status: 'active', count: 1 },
      { status: 'manual_review', count: 2 },
    ]);

    const secondSeed = await seedSponsorDiscovery(
      database(),
      candidateFile,
      new Date('2026-08-28T09:10:00.000Z'),
    );
    expect(secondSeed.inventoryInserted).toBe(0);
    expect(
      await database().select({ sponsorId: sponsorDiscovery.sponsorId }).from(sponsorDiscovery),
    ).toHaveLength(6);

    await expect(listDueDiscoveryCandidates(database(), 101)).rejects.toThrow(
      'Discovery batch limit',
    );
    const dueCandidates = await listDueDiscoveryCandidates(
      database(),
      100,
      new Date('2026-08-28T10:00:00.000Z'),
    );
    expect(dueCandidates.map((candidate) => candidate.brandName)).toEqual([
      'Discovery High',
      'Discovery Lower',
    ]);

    const firstCandidate = dueCandidates[0];
    if (firstCandidate === undefined) throw new Error('Due candidate fixture is empty');
    const [scanRun] = await database()
      .insert(scanRuns)
      .values({ command: 'companies:discovery:run', status: 'running' })
      .returning({ id: scanRuns.id });
    if (scanRun === undefined) throw new Error('Discovery scan run was not persisted');
    const secondCandidate = dueCandidates[1];
    if (secondCandidate === undefined) throw new Error('Second due candidate fixture is empty');
    const [raceCompany] = await database()
      .insert(companies)
      .values({
        brandName: 'In-flight Mapping',
        domain: 'lower.discovery.test',
        mappingConfidence: 'high',
        mappingSource: 'integration-test',
        scanEnabled: true,
      })
      .returning({ id: companies.id });
    if (raceCompany === undefined) throw new Error('In-flight mapping fixture was not persisted');
    await database().insert(companySponsors).values({
      companyId: raceCompany.id,
      sponsorId: secondCandidate.sponsorId,
      confidence: 'high',
      source: 'integration-test',
    });
    await database().insert(careerSources).values({
      companyId: raceCompany.id,
      sourceType: 'ats_api',
      provider: 'greenhouse',
      baseUrl: 'https://boards-api.greenhouse.io/v1/boards/in-flight/jobs',
      boardIdentifier: 'in-flight',
      discoveryMethod: 'integration-test',
      status: 'active',
    });
    await seedSponsorDiscovery(database(), candidateFile);
    expect(
      await database()
        .select({
          status: sponsorDiscovery.status,
          officialUrl: sponsorDiscovery.officialUrl,
          candidateHash: sponsorDiscovery.candidateHash,
        })
        .from(sponsorDiscovery)
        .where(eq(sponsorDiscovery.sponsorId, secondCandidate.sponsorId)),
    ).toEqual([
      {
        status: 'active',
        officialUrl: secondCandidate.officialUrl,
        candidateHash: secondCandidate.candidateHash,
      },
    ]);
    await expect(
      persistDiscoveryAttempt(database(), {
        scanRunId: scanRun.id,
        sponsorId: secondCandidate.sponsorId,
        officialUrl: secondCandidate.officialUrl,
        candidateSource: secondCandidate.candidateSource,
        candidateVersion: secondCandidate.candidateVersion,
        candidateHash: secondCandidate.candidateHash,
        inspectionPolicyVersion: 'official-site-inspection-v1',
        outcome: 'no_public_careers',
        pagesInspected: 1,
        physicalRequestCount: 1,
        durationMs: 25,
        diagnostic: 'Stale in-flight observation',
      }),
    ).rejects.toThrow('stale discovery attempt');
    expect(
      await database()
        .select({ status: sponsorDiscovery.status })
        .from(sponsorDiscovery)
        .where(eq(sponsorDiscovery.sponsorId, secondCandidate.sponsorId)),
    ).toEqual([{ status: 'active' }]);
    await database().delete(companies).where(eq(companies.id, raceCompany.id));
    await seedSponsorDiscovery(database(), candidateFile);
    expect(
      await database()
        .select({ status: sponsorDiscovery.status })
        .from(sponsorDiscovery)
        .where(eq(sponsorDiscovery.sponsorId, secondCandidate.sponsorId)),
    ).toEqual([{ status: 'candidate_ready' }]);

    const attemptInput = {
      scanRunId: scanRun.id,
      sponsorId: firstCandidate.sponsorId,
      officialUrl: firstCandidate.officialUrl,
      candidateSource: firstCandidate.candidateSource,
      candidateVersion: firstCandidate.candidateVersion,
      candidateHash: firstCandidate.candidateHash,
      inspectionPolicyVersion: 'official-site-inspection-v1',
      outcome: 'careers_found' as const,
      pagesInspected: 2,
      physicalRequestCount: 3,
      durationMs: 250,
      httpStatus: 200,
      diagnostic: 'Recognized public ATS link',
      result: { observationOnly: true },
      careersUrl: 'https://high.discovery.test/careers',
      provider: 'greenhouse',
      sourceBaseUrl: 'https://boards-api.greenhouse.io/v1/boards/discovery/jobs',
      boardIdentifier: 'discovery',
      nextCheckAt: new Date('2026-11-28T09:00:00.000Z'),
      attemptedAt: new Date('2026-08-28T10:05:00.000Z'),
    };
    await persistDiscoveryAttempt(database(), attemptInput);
    expect(
      await database()
        .select({
          status: sponsorDiscovery.status,
          attemptCount: sponsorDiscovery.attemptCount,
          provider: sponsorDiscovery.provider,
        })
        .from(sponsorDiscovery)
        .where(eq(sponsorDiscovery.sponsorId, firstCandidate.sponsorId)),
    ).toEqual([{ status: 'careers_found', attemptCount: 1, provider: 'greenhouse' }]);
    expect(
      await database()
        .select({
          pagesInspected: companyDiscoveryAttempts.pagesInspected,
          physicalRequestCount: companyDiscoveryAttempts.physicalRequestCount,
          outcome: companyDiscoveryAttempts.outcome,
        })
        .from(companyDiscoveryAttempts),
    ).toEqual([{ pagesInspected: 2, physicalRequestCount: 3, outcome: 'careers_found' }]);

    await expect(
      database().delete(indSponsors).where(eq(indSponsors.id, firstCandidate.sponsorId)),
    ).rejects.toThrow();
    await expect(
      database().delete(scanRuns).where(eq(scanRuns.id, scanRun.id)),
    ).rejects.toThrow();
    expect(
      await database()
        .select({ id: indSponsors.id })
        .from(indSponsors)
        .where(eq(indSponsors.id, firstCandidate.sponsorId)),
    ).toEqual([{ id: firstCandidate.sponsorId }]);
    expect(
      await database()
        .select({ id: scanRuns.id })
        .from(scanRuns)
        .where(eq(scanRuns.id, scanRun.id)),
    ).toEqual([{ id: scanRun.id }]);

    await expect(
      persistDiscoveryAttempt(database(), { ...attemptInput, outcome: 'manual_review' }),
    ).rejects.toThrow();
    expect(
      await database()
        .select({ status: sponsorDiscovery.status, attemptCount: sponsorDiscovery.attemptCount })
        .from(sponsorDiscovery)
        .where(eq(sponsorDiscovery.sponsorId, firstCandidate.sponsorId)),
    ).toEqual([{ status: 'careers_found', attemptCount: 1 }]);

    const reverifiedCandidateFile = {
      ...candidateFile,
      version: 'discovery-integration-v1-reverified',
      verifiedAt: '2026-08-28T11:00:00.000Z',
    } satisfies CompanyDomainCandidateFile;
    await seedSponsorDiscovery(database(), reverifiedCandidateFile);
    expect(
      await database()
        .select({
          status: sponsorDiscovery.status,
          attemptCount: sponsorDiscovery.attemptCount,
          lastAttemptAt: sponsorDiscovery.lastAttemptAt,
          nextCheckAt: sponsorDiscovery.nextCheckAt,
          candidateVersion: sponsorDiscovery.candidateVersion,
        })
        .from(sponsorDiscovery)
        .where(eq(sponsorDiscovery.sponsorId, firstCandidate.sponsorId)),
    ).toEqual([
      {
        status: 'careers_found',
        attemptCount: 1,
        lastAttemptAt: new Date('2026-08-28T10:05:00.000Z'),
        nextCheckAt: new Date('2026-11-28T09:00:00.000Z'),
        candidateVersion: 'discovery-integration-v1-reverified',
      },
    ]);

    await expect(
      seedSponsorDiscovery(database(), {
        ...candidateFile,
        verifiedAt: '2026-08-28T08:59:59.000Z',
      }),
    ).rejects.toThrow('candidate regression');
    await expect(
      seedSponsorDiscovery(database(), {
        ...reverifiedCandidateFile,
        candidates: reverifiedCandidateFile.candidates.map((candidate, index) =>
          index === 0
            ? { ...candidate, officialUrl: 'https://conflict.discovery.test/' }
            : candidate,
        ),
      }),
    ).rejects.toThrow('content changed without advancing verifiedAt');

    const newerCandidateFile = {
      ...candidateFile,
      version: 'discovery-integration-v2',
      verifiedAt: '2026-08-29T09:00:00.000Z',
      candidates: candidateFile.candidates.map((candidate, index) =>
        index === 0
          ? { ...candidate, officialUrl: 'https://new-high.discovery.test/' }
          : candidate,
      ),
    } satisfies CompanyDomainCandidateFile;
    await seedSponsorDiscovery(database(), newerCandidateFile);
    expect(
      await database()
        .select({
          status: sponsorDiscovery.status,
          officialUrl: sponsorDiscovery.officialUrl,
          attemptCount: sponsorDiscovery.attemptCount,
        })
        .from(sponsorDiscovery)
        .where(eq(sponsorDiscovery.sponsorId, firstCandidate.sponsorId)),
    ).toEqual([
      {
        status: 'candidate_ready',
        officialUrl: 'https://new-high.discovery.test/',
        attemptCount: 1,
      },
    ]);

    expect(await database().select({ id: companies.id }).from(companies)).toHaveLength(2);
    expect(await database().select({ sponsorId: companySponsors.sponsorId }).from(companySponsors)).toHaveLength(2);
    expect(await database().select({ id: careerSources.id }).from(careerSources)).toHaveLength(2);

    await database()
      .delete(companySponsors)
      .where(eq(companySponsors.sponsorId, mappedActiveSponsorId));
    await seedSponsorDiscovery(database(), newerCandidateFile);
    expect(
      await database()
        .select({
          status: sponsorDiscovery.status,
          brandName: sponsorDiscovery.brandName,
          officialUrl: sponsorDiscovery.officialUrl,
        })
        .from(sponsorDiscovery)
        .where(eq(sponsorDiscovery.sponsorId, mappedActiveSponsorId)),
    ).toEqual([
      {
        status: 'candidate_ready',
        brandName: 'Wrong Candidate Active',
        officialUrl: 'https://wrong-active.discovery.test/',
      },
    ]);
    expect(
      await database().select({ sponsorId: companySponsors.sponsorId }).from(companySponsors),
    ).toHaveLength(1);

    const lowerNormalizedName = normalizeLegalName('Discovery Lower Priority B.V.');
    const [ambiguousSponsor] = await database()
      .insert(indSponsors)
      .values({
        sourceIdentityKey: 'discovery-ambiguous-10000002',
        legalName: 'Discovery Lower Priority BV',
        normalizedName: lowerNormalizedName,
        searchName: lowerNormalizedName,
        kvkNumber: '10000002',
        sourceUrl: 'https://ind.nl/discovery-integration',
        sourceRetrievedAt: new Date('2026-08-30T08:00:00.000Z'),
        sourceLastUpdated: new Date('2026-08-03T00:00:00.000Z'),
        active: true,
      })
      .returning({ id: indSponsors.id });
    if (ambiguousSponsor === undefined) throw new Error('Ambiguous sponsor fixture was not persisted');
    const ambiguousCandidateFile = {
      ...newerCandidateFile,
      version: 'discovery-integration-v3-ambiguous',
      verifiedAt: '2026-08-30T09:00:00.000Z',
    } satisfies CompanyDomainCandidateFile;
    const ambiguousSeed = await seedSponsorDiscovery(database(), ambiguousCandidateFile);
    expect(ambiguousSeed.candidateAmbiguous).toBe(1);
    expect(
      await database()
        .select({
          status: sponsorDiscovery.status,
          officialUrl: sponsorDiscovery.officialUrl,
          candidateSource: sponsorDiscovery.candidateSource,
        })
        .from(sponsorDiscovery)
        .where(eq(sponsorDiscovery.sponsorId, secondCandidate.sponsorId)),
    ).toEqual([
      {
        status: 'needs_domain',
        officialUrl: null,
        candidateSource: 'trusted-domain-catalog-withdrawal',
      },
    ]);
    await database()
      .update(indSponsors)
      .set({ active: false })
      .where(eq(indSponsors.id, ambiguousSponsor.id));

    await expect(
      seedSponsorDiscovery(database(), {
        version: 'discovery-empty-equal-conflict',
        verifiedAt: ambiguousCandidateFile.verifiedAt,
        candidates: [],
      }),
    ).rejects.toThrow('withdrawal conflict');
    await expect(
      seedSponsorDiscovery(database(), {
        version: 'discovery-empty-older',
        verifiedAt: '2026-08-30T08:59:59.000Z',
        candidates: [],
      }),
    ).rejects.toThrow('withdrawal regression');

    const emptyCandidateFile = {
      version: 'discovery-integration-empty-v4',
      verifiedAt: '2026-08-31T09:00:00.000Z',
      candidates: [],
    } satisfies CompanyDomainCandidateFile;
    await seedSponsorDiscovery(database(), emptyCandidateFile);
    expect(
      await database()
        .select({
          status: sponsorDiscovery.status,
          officialUrl: sponsorDiscovery.officialUrl,
          careersUrl: sponsorDiscovery.careersUrl,
          provider: sponsorDiscovery.provider,
          attemptCount: sponsorDiscovery.attemptCount,
          candidateVersion: sponsorDiscovery.candidateVersion,
          candidateVerifiedAt: sponsorDiscovery.candidateVerifiedAt,
        })
        .from(sponsorDiscovery)
        .where(eq(sponsorDiscovery.sponsorId, firstCandidate.sponsorId)),
    ).toEqual([
      {
        status: 'needs_domain',
        officialUrl: null,
        careersUrl: null,
        provider: null,
        attemptCount: 1,
        candidateVersion: emptyCandidateFile.version,
        candidateVerifiedAt: new Date(emptyCandidateFile.verifiedAt),
      },
    ]);
    expect(
      await database()
        .select({ sponsorId: companyDiscoveryAttempts.sponsorId })
        .from(companyDiscoveryAttempts),
    ).toEqual([{ sponsorId: firstCandidate.sponsorId }]);
    const repeatedEmptySeed = await seedSponsorDiscovery(database(), emptyCandidateFile);
    expect(repeatedEmptySeed.inventoryInserted).toBe(0);
  });

  it('promotes persisted ATS evidence when URL serialization adds a root slash', async () => {
    const now = new Date('2026-08-28T12:00:00.000Z');
    const [sponsor] = await database()
      .insert(indSponsors)
      .values({
        sourceIdentityKey: 'promotion-sponsor',
        legalName: 'Promotion Sponsor B.V.',
        normalizedName: 'promotion sponsor',
        searchName: 'promotion sponsor',
        kvkNumber: '30000001',
        sourceUrl: 'https://ind.nl/promotion-integration',
        sourceRetrievedAt: now,
        active: true,
      })
      .returning({ id: indSponsors.id });
    if (sponsor === undefined) throw new Error('Promotion sponsor fixture was not inserted');
    const candidateFile = {
      version: 'promotion-integration-v1',
      verifiedAt: now.toISOString(),
      candidates: [
        {
          legalName: 'Promotion Sponsor B.V.',
          kvkNumber: '30000001',
          brandName: 'Promotion Sponsor',
          officialUrl: 'https://promotion.integration.test/',
          confidence: 'high',
          source: 'integration-test',
          evidenceUrls: ['https://evidence.integration.test/promotion'],
          priority: 100,
        },
      ],
    } satisfies CompanyDomainCandidateFile;
    await seedSponsorDiscovery(database(), candidateFile, now);
    const [candidate] = await listDueDiscoveryCandidates(
      database(),
      100,
      new Date('2026-08-28T12:01:00.000Z'),
    );
    if (candidate === undefined) throw new Error('Promotion candidate fixture was not queued');
    const [scanRun] = await database()
      .insert(scanRuns)
      .values({ command: 'companies:discovery:run', status: 'running', startedAt: now })
      .returning({ id: scanRuns.id });
    if (scanRun === undefined) throw new Error('Promotion scan run fixture was not inserted');
    const sourceBaseUrl = 'https://promotion.recruitee.com';
    const careersUrl = 'https://promotion.recruitee.com/o/frontend-engineer';
    await persistDiscoveryAttempt(database(), {
      scanRunId: scanRun.id,
      sponsorId: candidate.sponsorId,
      officialUrl: candidate.officialUrl,
      candidateSource: candidate.candidateSource,
      candidateVersion: candidate.candidateVersion,
      candidateHash: candidate.candidateHash,
      inspectionPolicyVersion: 'official-site-inspection-v1',
      outcome: 'careers_found',
      pagesInspected: 2,
      physicalRequestCount: 2,
      durationMs: 50,
      result: {
        status: 'careers_found',
        provider: 'recruitee',
        careersUrl,
        sourceBaseUrl,
        boardIdentifier: 'promotion',
        observations: [
          {
            provider: 'recruitee',
            observedUrl: careersUrl,
            sourceBaseUrl,
            boardIdentifier: 'promotion',
            observedOnPage: 'https://promotion.integration.test/careers',
            element: 'anchor',
          },
        ],
      },
      careersUrl,
      provider: 'recruitee',
      sourceBaseUrl,
      boardIdentifier: 'promotion',
      attemptedAt: new Date('2026-08-28T12:02:00.000Z'),
    });
    const [persistedAttempt] = await database()
      .select({ result: companyDiscoveryAttempts.result })
      .from(companyDiscoveryAttempts)
      .where(eq(companyDiscoveryAttempts.sponsorId, sponsor.id));
    expect(persistedAttempt?.result.sourceBaseUrl).toBe('https://promotion.recruitee.com/');
    await database()
      .update(sponsorDiscovery)
      .set({
        status: 'manual_review',
        diagnostic: 'Latest inspection result no longer matches current discovery state',
      })
      .where(eq(sponsorDiscovery.sponsorId, sponsor.id));

    const promotion = await promoteDiscoveredCareerSources(
      database(),
      { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as unknown as Logger,
      { now: new Date('2026-08-28T12:03:00.000Z') },
    );
    expect(promotion).toMatchObject({ examined: 1, promoted: 1, terminalized: 0, errors: 0 });
    expect(
      await database()
        .select({
          status: sponsorDiscovery.status,
          provider: sponsorDiscovery.provider,
          sourceBaseUrl: sponsorDiscovery.sourceBaseUrl,
        })
        .from(sponsorDiscovery)
        .where(eq(sponsorDiscovery.sponsorId, sponsor.id)),
    ).toEqual([
      {
        status: 'source_verified',
        provider: 'recruitee',
        sourceBaseUrl: 'https://promotion.recruitee.com',
      },
    ]);
    expect(
      await database()
        .select({
          provider: careerSources.provider,
          canonicalKey: careerSources.canonicalKey,
          discoveryManaged: careerSources.discoveryManaged,
        })
        .from(careerSources),
    ).toEqual([
      {
        provider: 'recruitee',
        canonicalKey: 'recruitee:promotion',
        discoveryManaged: true,
      },
    ]);
  });

  it('snapshots, resumes, completes, and finalizes one durable outcome per campaign sponsor', async () => {
    const snapshotTime = new Date('2026-08-28T12:00:00.000Z');
    const sponsors = await database()
      .insert(indSponsors)
      .values([
        {
          sourceIdentityKey: 'campaign-a',
          legalName: 'Campaign A B.V.',
          normalizedName: 'campaign a',
          searchName: 'campaign a',
          kvkNumber: '20000001',
          sourceUrl: 'https://ind.nl/campaign-integration',
          sourceRetrievedAt: snapshotTime,
          active: true,
        },
        {
          sourceIdentityKey: 'campaign-b',
          legalName: 'Campaign B B.V.',
          normalizedName: 'campaign b',
          searchName: 'campaign b',
          kvkNumber: null,
          sourceUrl: 'https://ind.nl/campaign-integration',
          sourceRetrievedAt: snapshotTime,
          active: true,
        },
        {
          sourceIdentityKey: 'campaign-inactive',
          legalName: 'Campaign Inactive B.V.',
          normalizedName: 'campaign inactive',
          searchName: 'campaign inactive',
          kvkNumber: '20000003',
          sourceUrl: 'https://ind.nl/campaign-integration',
          sourceRetrievedAt: snapshotTime,
          active: false,
        },
      ])
      .returning({
        id: indSponsors.id,
        sourceIdentityKey: indSponsors.sourceIdentityKey,
      });
    const sponsorA = sponsors.find((sponsor) => sponsor.sourceIdentityKey === 'campaign-a');
    const sponsorB = sponsors.find((sponsor) => sponsor.sourceIdentityKey === 'campaign-b');
    if (sponsorA === undefined || sponsorB === undefined) {
      throw new Error('Campaign sponsor fixtures were not persisted');
    }

    const started = await startOrResumeCompanyDiscoveryCampaign(database(), snapshotTime);
    expect(started).toMatchObject({ resumed: false, expectedSponsors: 2 });
    const inspectionRunId = '40000000-0000-4000-8000-000000000001';
    const sourceScanRunId = '40000000-0000-4000-8000-000000000002';
    await checkpointCompanyDiscoveryCampaign(database(), started.campaignRunId, {
      inspectionRunIds: [inspectionRunId],
      structuredSourceRequestCount: 3,
      sourceScanRunId,
      sourceScanPhysicalRequestCount: 4,
    });
    await expect(
      startOrResumeCompanyDiscoveryCampaign(database(), new Date('2026-08-28T12:01:00.000Z')),
    ).resolves.toEqual({
      ...started,
      resumed: true,
      inspectionRunIds: [inspectionRunId],
    });
    expect(await listCompanyDiscoveryCampaignItemsForExport(database(), started.campaignRunId)).toMatchObject([
      { ordinal: 1, sourceIdentityKey: 'campaign-a', legalName: 'Campaign A B.V.' },
      { ordinal: 2, sourceIdentityKey: 'campaign-b', legalName: 'Campaign B B.V.' },
    ]);

    await database()
      .update(indSponsors)
      .set({ legalName: 'Changed After Snapshot B.V.' })
      .where(eq(indSponsors.id, sponsorA.id));
    const fetchedAt = new Date('2026-08-28T12:05:00.000Z');
    const fetchedOutcome = {
      sponsorId: sponsorA.id,
      finalPhase: 'site_inspection',
      outcome: 'careers_found' as const,
      reasonCode: 'supported_ats_found',
      networkAttempted: true,
      pagesAttempted: 2,
      pagesFetched: 2,
      physicalRequestCount: 3,
      httpStatus: 200,
      details: {
        provider: 'greenhouse',
        authorization: 'Bearer should-not-persist',
      },
      completedAt: fetchedAt,
    };
    const firstCompletion = await completeCompanyDiscoveryCampaignItems(
      database(),
      started.campaignRunId,
      [fetchedOutcome],
    );
    expect(firstCompletion).toMatchObject({
      completed: 1,
      unchanged: 0,
      progress: {
        terminalSponsors: 1,
        pendingSponsors: 1,
        sitePhysicalRequestCount: 3,
        structuredSourceRequestCount: 3,
        sourceScanRunId,
        sourceScanPhysicalRequestCount: 4,
        totalPhysicalRequestCount: 10,
      },
    });
    await expect(
      completeCompanyDiscoveryCampaignItems(database(), started.campaignRunId, [fetchedOutcome]),
    ).resolves.toMatchObject({ completed: 0, unchanged: 1 });
    await expect(
      completeCompanyDiscoveryCampaignItems(database(), started.campaignRunId, [
        { ...fetchedOutcome, reasonCode: 'conflicting_result' },
      ]),
    ).rejects.toThrow('Conflicting terminal outcome');
    await expect(
      finalizeCompanyDiscoveryCampaign(database(), started.campaignRunId),
    ).rejects.toThrow('still has 1 pending sponsors');

    const noDomainAt = new Date('2026-08-28T12:06:00.000Z');
    await completeCompanyDiscoveryCampaignItems(database(), started.campaignRunId, [
      {
        sponsorId: sponsorB.id,
        finalPhase: 'domain_resolution',
        outcome: 'needs_domain',
        reasonCode: 'missing_kvk',
        networkAttempted: false,
        pagesAttempted: 0,
        pagesFetched: 0,
        physicalRequestCount: 0,
        details: { reviewed: true },
        completedAt: noDomainAt,
      },
    ]);
    const finalized = await finalizeCompanyDiscoveryCampaign(
      database(),
      started.campaignRunId,
      new Date('2026-08-28T12:07:00.000Z'),
    );
    expect(finalized).toMatchObject({
      runStatus: 'partial',
      expectedSponsors: 2,
      totalSponsors: 2,
      pendingSponsors: 0,
      terminalSponsors: 2,
      siteInspectionAttemptedSponsors: 1,
      sitePagesAttempted: 2,
      sitePagesFetched: 2,
      sitePhysicalRequestCount: 3,
      outcomeCounts: { careers_found: 1, needs_domain: 1 },
      reasonCounts: { supported_ats_found: 1, missing_kvk: 1 },
    });
    await expect(
      finalizeCompanyDiscoveryCampaign(database(), started.campaignRunId),
    ).resolves.toMatchObject({ runStatus: 'partial', terminalSponsors: 2 });
    expect(await getCompanyDiscoveryCampaignProgress(database(), started.campaignRunId)).toMatchObject({
      runStatus: 'partial',
      pendingSponsors: 0,
    });
    expect(
      await database()
        .select({
          ordinal: companyDiscoveryCampaignItems.ordinal,
          legalName: companyDiscoveryCampaignItems.legalNameSnapshot,
          details: companyDiscoveryCampaignItems.details,
        })
        .from(companyDiscoveryCampaignItems)
        .where(eq(companyDiscoveryCampaignItems.campaignRunId, started.campaignRunId))
        .orderBy(companyDiscoveryCampaignItems.ordinal),
    ).toEqual([
      {
        ordinal: 1,
        legalName: 'Campaign A B.V.',
        details: { provider: 'greenhouse', authorization: '[REDACTED]' },
      },
      { ordinal: 2, legalName: 'Campaign B B.V.', details: { reviewed: true } },
    ]);
    await expect(database().delete(indSponsors).where(eq(indSponsors.id, sponsorA.id))).rejects.toThrow();
  });
});
