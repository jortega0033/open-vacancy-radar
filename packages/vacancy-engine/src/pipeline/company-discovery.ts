import { AsyncLocalStorage } from 'node:async_hooks';

import type { Logger } from 'pino';

import { AtsResponseError, type AtsHttpClient } from '../ats/http.js';
import {
  getDiscoveryCoverage,
  listDueDiscoveryCandidates,
  persistDiscoveryAttempt,
  seedSponsorDiscovery,
} from '../companies/discovery-repository.js';
import {
  hashDomainCandidate,
  loadCompanyDomainCandidates,
  normalizeOfficialUrl,
} from '../companies/domain-candidates.js';
import {
  inspectOfficialCompanySite,
  type OfficialSiteDiscoveryResult,
} from '../companies/site-discovery.js';
import type { AppConfig } from '../config.js';
import { isCrawlerHttpError, safeErrorClassification } from '../crawler/index.js';
import type { Database } from '../db/client.js';
import {
  finishOperationalRun,
  startScanRun,
  type ScanStatus,
} from '../scans/repository.js';
import { createDatabaseBackedAtsHttpClient } from './ats-http-client.js';

export const COMPANY_DISCOVERY_INSPECTION_POLICY_VERSION = 'official-company-discovery-v1';
export const COMPANY_DISCOVERY_RUN_LIMIT = 100;
export const COMPANY_DISCOVERY_GLOBAL_CONCURRENCY = 4;
export const COMPANY_DISCOVERY_PER_DOMAIN_CONCURRENCY = 1;

type CandidateRow = Awaited<ReturnType<typeof listDueDiscoveryCandidates>>[number];
type PersistAttemptInput = Parameters<typeof persistDiscoveryAttempt>[1];

export type CompanyDiscoveryRunStatistics = {
  candidatesQueued: number;
  candidatesExcludedByCatalog: number;
  candidatesAttempted: number;
  sitesInspected: number;
  hostCappedCandidates: number;
  careersFound: number;
  noPublicCareers: number;
  unsupported: number;
  blocked: number;
  manualReview: number;
  errors: number;
  persistenceErrors: number;
  requestCount: number;
  durationMs: number;
};

export type CompanyDiscoveryRunResult = {
  scanRunId: string;
  status: ScanStatus;
  statistics: CompanyDiscoveryRunStatistics;
};

export type CompanyDiscoveryRunDependencies = {
  listCandidates?: typeof listDueDiscoveryCandidates;
  prepare?: (database: Database) => Promise<ReadonlySet<string>>;
  persistAttempt?: typeof persistDiscoveryAttempt;
  inspect?: typeof inspectOfficialCompanySite;
  startRun?: typeof startScanRun;
  finishRun?: typeof finishOperationalRun;
  createHttp?: typeof createDatabaseBackedAtsHttpClient;
  now?: () => number;
};

type FailedInspection = {
  outcome: 'blocked' | 'manual_review' | 'error';
  category: string;
  diagnostic: string;
  httpStatus?: number;
};

class DiscoveryRequestAttribution {
  readonly #context = new AsyncLocalStorage<string>();
  readonly #bySponsor = new Map<string, number>();
  #total = 0;

  public runForSponsor<T>(sponsorId: string, operation: () => Promise<T>): Promise<T> {
    return this.#context.run(sponsorId, operation);
  }

  public recordPhysicalRequest(): void {
    this.#total += 1;
    const sponsorId = this.#context.getStore();
    if (sponsorId !== undefined) {
      this.#bySponsor.set(sponsorId, (this.#bySponsor.get(sponsorId) ?? 0) + 1);
    }
  }

  public countForSponsor(sponsorId: string): number {
    return this.#bySponsor.get(sponsorId) ?? 0;
  }

  public get total(): number {
    return this.#total;
  }
}

function createStatistics(): CompanyDiscoveryRunStatistics {
  return {
    candidatesQueued: 0,
    candidatesExcludedByCatalog: 0,
    candidatesAttempted: 0,
    sitesInspected: 0,
    hostCappedCandidates: 0,
    careersFound: 0,
    noPublicCareers: 0,
    unsupported: 0,
    blocked: 0,
    manualReview: 0,
    errors: 0,
    persistenceErrors: 0,
    requestCount: 0,
    durationMs: 0,
  };
}

function recordOutcome(
  statistics: CompanyDiscoveryRunStatistics,
  outcome: OfficialSiteDiscoveryResult['status'] | 'blocked' | 'error',
): void {
  switch (outcome) {
    case 'careers_found':
      statistics.careersFound += 1;
      break;
    case 'no_public_careers':
      statistics.noPublicCareers += 1;
      break;
    case 'unsupported':
      statistics.unsupported += 1;
      break;
    case 'blocked':
      statistics.blocked += 1;
      break;
    case 'manual_review':
      statistics.manualReview += 1;
      break;
    case 'error':
      statistics.errors += 1;
      break;
  }
}

function classifyInspectionFailure(error: unknown): FailedInspection {
  if (isCrawlerHttpError(error)) {
    const outcome =
      error.category === 'blocked' || error.category === 'rate_limited'
        ? 'blocked'
        : error.category === 'unsafe_url'
          ? 'manual_review'
          : 'error';
    return {
      outcome,
      category: error.category,
      diagnostic: `Official-site inspection failed (${error.category}/${error.code})`,
      ...(error.status === undefined ? {} : { httpStatus: error.status }),
    };
  }
  if (error instanceof AtsResponseError) {
    const blocked =
      error.status !== null && new Set([401, 403, 407, 451]).has(error.status);
    return {
      outcome: blocked ? 'blocked' : 'error',
      category: blocked ? 'blocked' : error.status === null ? 'parse_error' : 'http_error',
      diagnostic: blocked
        ? 'Official-site inspection encountered a recognizable access challenge'
        : 'Official-site inspection returned an unusable response',
      ...(error.status === null ? {} : { httpStatus: error.status }),
    };
  }
  return {
    outcome: 'error',
    category: 'unexpected_error',
    diagnostic: `Official-site inspection failed (${safeErrorClassification(error).errorType})`,
  };
}

function resultRecord(result: OfficialSiteDiscoveryResult): Record<string, unknown> {
  return {
    status: result.status,
    pagesInspected: result.pagesInspected,
    careersUrl: result.careersUrl,
    provider: result.provider,
    sourceBaseUrl: result.sourceBaseUrl,
    boardIdentifier: result.boardIdentifier,
    observations: result.observations,
  };
}

function groupCandidatesByOfficialUrl(candidates: readonly CandidateRow[]): CandidateRow[][] {
  const groups = new Map<string, CandidateRow[]>();
  for (const candidate of candidates) {
    const key = normalizeOfficialUrl(candidate.officialUrl);
    const group = groups.get(key) ?? [];
    group.push(candidate);
    groups.set(key, group);
  }
  return [...groups.values()];
}

function attemptIdentity(candidate: CandidateRow): Pick<
  PersistAttemptInput,
  | 'sponsorId'
  | 'officialUrl'
  | 'candidateSource'
  | 'candidateVersion'
  | 'candidateHash'
> {
  return {
    sponsorId: candidate.sponsorId,
    officialUrl: candidate.officialUrl,
    candidateSource: candidate.candidateSource,
    candidateVersion: candidate.candidateVersion,
    candidateHash: candidate.candidateHash,
  };
}

export type CompanyDiscoveryPreparation = {
  seedResult: Awaited<ReturnType<typeof seedSponsorDiscovery>>;
  trustedCandidateHashes: ReadonlySet<string>;
};

export async function prepareCompanyDiscoveryInventory(
  database: Database,
  candidateFilePath?: string,
): Promise<CompanyDiscoveryPreparation> {
  const candidateFile = await loadCompanyDomainCandidates(candidateFilePath);
  const seedResult = await seedSponsorDiscovery(database, candidateFile);
  return {
    seedResult,
    trustedCandidateHashes: new Set(
      candidateFile.candidates.map((candidate) => hashDomainCandidate(candidate)),
    ),
  };
}

async function prepareCurrentTrustedCandidateHashes(database: Database): Promise<ReadonlySet<string>> {
  return (await prepareCompanyDiscoveryInventory(database)).trustedCandidateHashes;
}

export async function seedCompanyDiscoveryInventory(
  database: Database,
  candidateFilePath?: string,
): Promise<Awaited<ReturnType<typeof seedSponsorDiscovery>>> {
  return (await prepareCompanyDiscoveryInventory(database, candidateFilePath)).seedResult;
}

export async function getCompanyDiscoveryStatus(
  database: Database,
): Promise<Awaited<ReturnType<typeof getDiscoveryCoverage>>> {
  return getDiscoveryCoverage(database);
}

export async function runCompanyDiscoveryInspection(
  database: Database,
  config: AppConfig,
  logger: Logger,
  dependencies: CompanyDiscoveryRunDependencies = {},
): Promise<CompanyDiscoveryRunResult> {
  const listCandidates = dependencies.listCandidates ?? listDueDiscoveryCandidates;
  const prepare = dependencies.prepare ?? prepareCurrentTrustedCandidateHashes;
  const persistAttempt = dependencies.persistAttempt ?? persistDiscoveryAttempt;
  const inspect = dependencies.inspect ?? inspectOfficialCompanySite;
  const startRun = dependencies.startRun ?? startScanRun;
  const finishRun = dependencies.finishRun ?? finishOperationalRun;
  const createHttp = dependencies.createHttp ?? createDatabaseBackedAtsHttpClient;
  const now = dependencies.now ?? Date.now;
  const startedAt = now();
  const statistics = createStatistics();
  const scanRunId = await startRun(database, 'companies:discovery:run', false);
  const attribution = new DiscoveryRequestAttribution();

  try {
    const trustedCandidateHashes = await prepare(database);
    const listedCandidates = await listCandidates(database, COMPANY_DISCOVERY_RUN_LIMIT);
    if (listedCandidates.length > COMPANY_DISCOVERY_RUN_LIMIT) {
      throw new Error(`Discovery repository returned more than ${COMPANY_DISCOVERY_RUN_LIMIT} candidates`);
    }
    const candidates = listedCandidates.filter((candidate) =>
      trustedCandidateHashes.has(candidate.candidateHash),
    );
    statistics.candidatesQueued = candidates.length;
    statistics.candidatesExcludedByCatalog = listedCandidates.length - candidates.length;
    if (candidates.length === 0) {
      statistics.durationMs = Math.max(0, now() - startedAt);
      await finishRun(database, scanRunId, 'succeeded', statistics);
      return { scanRunId, status: 'succeeded', statistics };
    }
    const candidateGroups = groupCandidatesByOfficialUrl(candidates);
    const selectedHostnames = new Set<string>();
    const inspectionGroups: CandidateRow[][] = [];
    const hostCappedGroups: CandidateRow[][] = [];
    for (const group of candidateGroups) {
      const representative = group[0];
      if (representative === undefined) continue;
      const hostname = new URL(normalizeOfficialUrl(representative.officialUrl))
        .hostname
        .toLowerCase()
        .replace(/\.$/u, '');
      if (selectedHostnames.has(hostname)) hostCappedGroups.push(group);
      else {
        selectedHostnames.add(hostname);
        inspectionGroups.push(group);
      }
    }

    for (const group of hostCappedGroups) {
      const representative = group[0];
      if (representative === undefined) continue;
      statistics.candidatesAttempted += group.length;
      statistics.hostCappedCandidates += group.length;
      const sharedObservation = {
        normalizedOfficialUrl: normalizeOfficialUrl(representative.officialUrl),
        sponsorCount: group.length,
        representativeSponsorId: representative.sponsorId,
        physicalRequestsAttributedToSponsorId: null,
      };
      for (const candidate of group) {
        recordOutcome(statistics, 'manual_review');
        try {
          await persistAttempt(database, {
            scanRunId,
            ...attemptIdentity(candidate),
            inspectionPolicyVersion: COMPANY_DISCOVERY_INSPECTION_POLICY_VERSION,
            outcome: 'manual_review',
            pagesInspected: 0,
            physicalRequestCount: 0,
            durationMs: 0,
            category: 'per_host_distinct_url_cap',
            diagnostic:
              'Automatic inspection skipped because another distinct URL on this hostname was already selected for this run',
            result: {
              status: 'manual_review',
              reason: 'per_host_distinct_url_cap',
              sharedObservation,
            },
          });
        } catch (error) {
          statistics.persistenceErrors += 1;
          statistics.errors += 1;
          logger.error(
            { ...safeErrorClassification(error), sponsorId: candidate.sponsorId },
            'Host-capped company discovery attempt persistence failed; continuing',
          );
        }
      }
    }

    const http = createHttp(
      {
        ...config,
        globalConcurrency: Math.min(
          config.globalConcurrency,
          COMPANY_DISCOVERY_GLOBAL_CONCURRENCY,
        ),
        perDomainConcurrency: COMPANY_DISCOVERY_PER_DOMAIN_CONCURRENCY,
      },
      database,
      {
        onNetworkRequest: () => attribution.recordPhysicalRequest(),
        onCacheError: (error, operation, safeUrl) =>
          logger.warn(
            { ...safeErrorClassification(error), operation, url: safeUrl },
            'Discovery HTTP cache operation failed; continuing without it',
          ),
      },
    );

    await Promise.all(
      inspectionGroups.map((group) => {
        const representative = group[0];
        if (representative === undefined) return Promise.resolve();
        return attribution.runForSponsor(representative.sponsorId, async () => {
          statistics.candidatesAttempted += group.length;
          statistics.sitesInspected += 1;
          const inspectionStartedAt = now();
          let pagesInspected = 0;
          const candidateHttp: AtsHttpClient = {
            async get(url, options) {
              if (pagesInspected >= 2) {
                throw new AtsResponseError(
                  'company_discovery',
                  'inspection attempted to exceed the two-page policy limit',
                );
              }
              pagesInspected += 1;
              return options === undefined ? http.get(url) : http.get(url, options);
            },
            postJson() {
              throw new AtsResponseError(
                'company_discovery',
                'official-site inspection permits GET requests only',
              );
            },
          };

          let inspectionResult: OfficialSiteDiscoveryResult | null = null;
          let inspectionFailure: FailedInspection | null = null;
          try {
            inspectionResult = await inspect(candidateHttp, representative.officialUrl);
          } catch (error) {
            inspectionFailure = classifyInspectionFailure(error);
            logger.warn(
              {
                ...safeErrorClassification(error),
                sponsorId: representative.sponsorId,
                sharedSponsorCount: group.length,
                category: inspectionFailure.category,
              },
              'Official company-site inspection failed; continuing with other candidates',
            );
          }

          const durationMs = Math.max(0, now() - inspectionStartedAt);
          const sharedPhysicalRequestCount = attribution.countForSponsor(representative.sponsorId);
          const sharedObservation = {
            normalizedOfficialUrl: normalizeOfficialUrl(representative.officialUrl),
            sponsorCount: group.length,
            representativeSponsorId: representative.sponsorId,
            physicalRequestsAttributedToSponsorId: representative.sponsorId,
          };

          for (const [index, candidate] of group.entries()) {
            const physicalRequestCount = index === 0 ? sharedPhysicalRequestCount : 0;
            let attempt: PersistAttemptInput;
            if (inspectionResult !== null) {
              recordOutcome(statistics, inspectionResult.status);
              attempt = {
                scanRunId,
                ...attemptIdentity(candidate),
                inspectionPolicyVersion: COMPANY_DISCOVERY_INSPECTION_POLICY_VERSION,
                outcome: inspectionResult.status,
                pagesInspected,
                physicalRequestCount,
                durationMs,
                diagnostic: inspectionResult.diagnostic,
                result: { ...resultRecord(inspectionResult), sharedObservation },
                careersUrl: inspectionResult.careersUrl,
                provider: inspectionResult.provider,
                sourceBaseUrl: inspectionResult.sourceBaseUrl,
                boardIdentifier: inspectionResult.boardIdentifier,
              };
            } else {
              const failure = inspectionFailure ?? {
                outcome: 'error' as const,
                category: 'unexpected_error',
                diagnostic: 'Official-site inspection ended without a result',
              };
              recordOutcome(statistics, failure.outcome);
              attempt = {
                scanRunId,
                ...attemptIdentity(candidate),
                inspectionPolicyVersion: COMPANY_DISCOVERY_INSPECTION_POLICY_VERSION,
                outcome: failure.outcome,
                pagesInspected,
                physicalRequestCount,
                durationMs,
                category: failure.category,
                diagnostic: failure.diagnostic,
                result: { status: failure.outcome, sharedObservation },
                ...(failure.httpStatus === undefined ? {} : { httpStatus: failure.httpStatus }),
              };
            }

            try {
              await persistAttempt(database, attempt);
            } catch (error) {
              statistics.persistenceErrors += 1;
              statistics.errors += 1;
              logger.error(
                { ...safeErrorClassification(error), sponsorId: candidate.sponsorId },
                'Company discovery attempt persistence failed; continuing with other candidates',
              );
            }
          }
        });
      }),
    );

    statistics.requestCount = attribution.total;
    statistics.durationMs = Math.max(0, now() - startedAt);
    const status: ScanStatus =
      statistics.errors +
        statistics.blocked +
        statistics.manualReview +
        statistics.unsupported >
      0
        ? 'partial'
        : 'succeeded';
    await finishRun(database, scanRunId, status, statistics);
    return { scanRunId, status, statistics };
  } catch (error) {
    statistics.errors += 1;
    statistics.requestCount = attribution.total;
    statistics.durationMs = Math.max(0, now() - startedAt);
    await finishRun(database, scanRunId, 'failed', statistics);
    throw error;
  }
}
