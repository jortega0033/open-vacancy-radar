import { AsyncLocalStorage } from 'node:async_hooks';

import { and, asc, eq, inArray, isNull } from 'drizzle-orm';
import type { Logger } from 'pino';

import {
  AshbyAdapter,
  AtsResponseError,
  CompanySiteJsonLdAdapter,
  GreenhouseAdapter,
  LeverAdapter,
  RecruiteeAdapter,
  SmartRecruitersAdapter,
  TeamtailorAdapter,
  WorkdayAdapter,
  type AtsHttpClient,
} from '../ats/index.js';
import type { AppConfig } from '../config.js';
import { isCrawlerHttpError, safeErrorClassification } from '../crawler/index.js';
import { withTransaction, type Database } from '../db/client.js';
import { careerSources, companies } from '../db/schema.js';
import {
  atsProviderSchema,
  type AdapterResult,
  type AtsProvider,
  type CareerSourceDescriptor,
  type ScanErrorCategory,
  type VacancyAdapter,
} from '../domain/models.js';
import { persistVacancyScan } from '../vacancies/repository.js';
import { recordScanError, recordSourceOutcome, type ScanStatus } from '../scans/repository.js';
import { createDatabaseBackedAtsHttpClient } from './ats-http-client.js';

export type VacancyScanStatistics = {
  sourcesDiscovered: number;
  sourcesAttempted: number;
  sourcesScanned: number;
  blockedSources: number;
  manualReviewSources: number;
  unsupportedSources: number;
  incompleteSources: number;
  vacanciesDiscovered: number;
  vacanciesNew: number;
  vacanciesChanged: number;
  vacanciesInactive: number;
  invalidVacancies: number;
  errorCount: number;
  requestCount: number;
  durationMs: number;
};

export type VacancyScanWorkflowResult = VacancyScanStatistics & {
  status: ScanStatus;
};

export const MAX_SCOPED_VACANCY_SCAN_SOURCES = 50;

export type VacancyScanScope = {
  provider: AtsProvider;
  limit: number;
  careerSourceIds?: readonly string[];
};

type NormalizedVacancyScanScope = {
  provider: AtsProvider;
  limit: number;
  careerSourceIds: string[];
};

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

export function normalizeVacancyScanScope(
  scope: VacancyScanScope,
): NormalizedVacancyScanScope {
  const provider = atsProviderSchema.parse(scope.provider);
  if (
    !Number.isInteger(scope.limit) ||
    scope.limit < 1 ||
    scope.limit > MAX_SCOPED_VACANCY_SCAN_SOURCES
  ) {
    throw new RangeError(
      `Scoped vacancy scan limit must be an integer from 1 through ${MAX_SCOPED_VACANCY_SCAN_SOURCES}`,
    );
  }
  const careerSourceIds = [...new Set((scope.careerSourceIds ?? []).map((id) => id.trim()))];
  if (careerSourceIds.length > scope.limit) {
    throw new RangeError('Scoped vacancy scan cannot request more source ids than its limit');
  }
  const invalidSourceId = careerSourceIds.find((id) => !UUID_PATTERN.test(id));
  if (invalidSourceId !== undefined) {
    throw new Error(`Scoped vacancy scan source id is not a UUID: ${invalidSourceId}`);
  }
  return { provider, limit: scope.limit, careerSourceIds };
}

export function assertRequestedCareerSourcesResolved(
  provider: AtsProvider,
  requestedSourceIds: readonly string[],
  resolvedSources: readonly { id: string }[],
): void {
  if (requestedSourceIds.length === 0) return;
  const resolvedIds = new Set(resolvedSources.map((source) => source.id));
  const missingSourceIds = requestedSourceIds.filter((id) => !resolvedIds.has(id));
  if (missingSourceIds.length > 0) {
    throw new Error(
      `Scoped ${provider} vacancy scan could not resolve requested source ids: ${missingSourceIds.join(', ')}`,
    );
  }
}

export type SourceRow = {
  id: string;
  companyId: string;
  companyName: string;
  companyScanEnabled: boolean;
  provider: string;
  baseUrl: string;
  boardIdentifier: string | null;
  discoveryEvidence?: Record<string, unknown>;
  status: 'active' | 'blocked' | 'manual_review' | 'unsupported' | 'error';
};

export type SuccessfulSourceCommitInput = {
  scanRunId: string;
  row: SourceRow;
  adapterResult: AdapterResult;
  requestCount: number;
  durationMs: number;
  completedAt: Date;
};

export type FailedSourceCommitInput = {
  scanRunId: string;
  row: SourceRow;
  outcomeStatus: 'failed' | 'blocked' | 'unsupported';
  sourceStatus: 'error' | 'blocked' | 'unsupported';
  diagnostic: {
    category: ScanErrorCategory;
    message: string;
    httpStatus?: number;
  };
  requestCount: number;
  durationMs: number;
  completedAt: Date;
};

type MutableStatistics = VacancyScanStatistics;

export class NetworkRequestAttribution {
  readonly #context = new AsyncLocalStorage<string>();
  readonly #bySource = new Map<string, number>();
  #total = 0;

  public runForSource<T>(sourceId: string, operation: () => Promise<T>): Promise<T> {
    return this.#context.run(sourceId, operation);
  }

  public recordNetworkRequest(): void {
    this.#total += 1;
    const sourceId = this.#context.getStore();
    if (sourceId !== undefined) {
      this.#bySource.set(sourceId, (this.#bySource.get(sourceId) ?? 0) + 1);
    }
  }

  public countForSource(sourceId: string): number {
    return this.#bySource.get(sourceId) ?? 0;
  }

  public get total(): number {
    return this.#total;
  }
}

function createStatistics(sourceCount: number): MutableStatistics {
  return {
    sourcesDiscovered: sourceCount,
    sourcesAttempted: 0,
    sourcesScanned: 0,
    blockedSources: 0,
    manualReviewSources: 0,
    unsupportedSources: 0,
    incompleteSources: 0,
    vacanciesDiscovered: 0,
    vacanciesNew: 0,
    vacanciesChanged: 0,
    vacanciesInactive: 0,
    invalidVacancies: 0,
    errorCount: 0,
    requestCount: 0,
    durationMs: 0,
  };
}

export function createVacancyAdapter(
  provider: string,
  http: AtsHttpClient,
): VacancyAdapter | null {
  switch (provider) {
    case 'ashby':
      return new AshbyAdapter(http);
    case 'greenhouse':
      return new GreenhouseAdapter(http);
    case 'lever':
      return new LeverAdapter(http);
    case 'teamtailor':
      return new TeamtailorAdapter(http);
    case 'recruitee':
      return new RecruiteeAdapter(http);
    case 'smartrecruiters':
      return new SmartRecruitersAdapter(http);
    case 'workday':
      return new WorkdayAdapter(http);
    case 'json_ld':
      return new CompanySiteJsonLdAdapter(http);
    default:
      return null;
  }
}

export function categorizeSourceError(error: unknown): {
  category: ScanErrorCategory;
  httpStatus?: number;
  message: string;
} {
  if (isCrawlerHttpError(error)) {
    return {
      category: error.category,
      ...(error.status === undefined ? {} : { httpStatus: error.status }),
      message: error.message,
    };
  }
  if (error instanceof AtsResponseError) {
    const blocked = error.status !== null && [401, 403, 406, 407, 451].includes(error.status);
    return {
      category: error.status === null ? 'parse_error' : blocked ? 'blocked' : 'http_error',
      ...(error.status === null ? {} : { httpStatus: error.status }),
      message: error.message,
    };
  }
  return {
    category: 'parse_error',
    message: `Unexpected source scan failure (${safeErrorClassification(error).errorType})`,
  };
}

function descriptorFor(row: SourceRow): CareerSourceDescriptor | null {
  const parsedProvider = atsProviderSchema.safeParse(row.provider);
  if (!parsedProvider.success) return null;
  return {
    id: row.id,
    companyId: row.companyId,
    companyName: row.companyName,
    provider: parsedProvider.data,
    baseUrl: row.baseUrl,
    boardIdentifier: row.boardIdentifier,
    ...(row.discoveryEvidence?.lifecycleAuthoritative === true
      ? { lifecycleAuthoritative: true }
      : {}),
  };
}

async function markNotScanned(
  database: Database,
  scanRunId: string,
  row: SourceRow,
  statistics: MutableStatistics,
): Promise<void> {
  const outcomeStatus =
    row.status === 'blocked'
      ? 'blocked'
      : row.status === 'unsupported'
        ? 'unsupported'
        : 'manual_review';
  if (outcomeStatus === 'blocked') statistics.blockedSources += 1;
  else if (outcomeStatus === 'unsupported') statistics.unsupportedSources += 1;
  else statistics.manualReviewSources += 1;
  await recordSourceOutcome(database, {
    scanRunId,
    careerSourceId: row.id,
    status: outcomeStatus,
    complete: false,
    vacanciesSeen: 0,
    requestCount: 0,
    durationMs: 0,
  });
}

export async function commitSuccessfulSourceScan(
  database: Database,
  input: SuccessfulSourceCommitInput,
): Promise<{
  persisted: Awaited<ReturnType<typeof persistVacancyScan>>;
  invalidCount: number;
  complete: boolean;
}> {
  return withTransaction(database, async (transaction) => {
    const persisted = await persistVacancyScan(transaction, {
      companyId: input.row.companyId,
      careerSourceId: input.row.id,
      vacancies: input.adapterResult.vacancies,
      complete: input.adapterResult.complete && input.adapterResult.invalidCount === 0,
      observedAt: input.completedAt,
    });
    const invalidCount = persisted.invalid + input.adapterResult.invalidCount;
    const complete =
      input.adapterResult.complete && invalidCount === 0 && persisted.completeAccepted;
    if (invalidCount > 0) {
      await recordScanError(transaction, {
        scanRunId: input.scanRunId,
        companyId: input.row.companyId,
        careerSourceId: input.row.id,
        category: 'invalid_vacancy',
        message: `${invalidCount} vacancies were dropped during adapter or persistence validation`,
        context: {
          provider: input.row.provider,
          adapterInvalid: input.adapterResult.invalidCount,
          persistenceInvalid: persisted.invalid,
        },
      });
    }
    if (persisted.feedAnomaly !== null) {
      await recordScanError(transaction, {
        scanRunId: input.scanRunId,
        companyId: input.row.companyId,
        careerSourceId: input.row.id,
        category: 'parse_error',
        message: 'A severe source count drop was quarantined as an incomplete feed',
        context: {
          provider: input.row.provider,
          ...persisted.feedAnomaly,
        },
      });
    }
    await transaction
      .update(careerSources)
      .set({
        status: persisted.feedAnomaly === null ? 'active' : 'manual_review',
        lastSuccessAt: input.completedAt,
        updatedAt: input.completedAt,
      })
      .where(eq(careerSources.id, input.row.id));
    await transaction
      .update(companies)
      .set({ lastScannedAt: input.completedAt, updatedAt: input.completedAt })
      .where(eq(companies.id, input.row.companyId));
    await recordSourceOutcome(transaction, {
      scanRunId: input.scanRunId,
      careerSourceId: input.row.id,
      status: persisted.feedAnomaly === null ? 'succeeded' : 'manual_review',
      complete,
      vacanciesSeen: persisted.discovered,
      requestCount: input.requestCount,
      durationMs: input.durationMs,
    });
    return { persisted, invalidCount, complete };
  });
}

export async function commitFailedSourceScan(
  database: Database,
  input: FailedSourceCommitInput,
): Promise<void> {
  await withTransaction(database, async (transaction) => {
    await transaction
      .update(careerSources)
      .set({
        status: input.sourceStatus,
        lastFailureAt: input.completedAt,
        updatedAt: input.completedAt,
      })
      .where(eq(careerSources.id, input.row.id));
    await transaction
      .update(companies)
      .set({ lastScannedAt: input.completedAt, updatedAt: input.completedAt })
      .where(eq(companies.id, input.row.companyId));
    await recordScanError(transaction, {
      scanRunId: input.scanRunId,
      companyId: input.row.companyId,
      careerSourceId: input.row.id,
      category: input.diagnostic.category,
      message: input.diagnostic.message,
      ...(input.diagnostic.httpStatus === undefined
        ? {}
        : { httpStatus: input.diagnostic.httpStatus }),
      context: { provider: input.row.provider, sourceUrl: input.row.baseUrl },
    });
    await recordSourceOutcome(transaction, {
      scanRunId: input.scanRunId,
      careerSourceId: input.row.id,
      status: input.outcomeStatus,
      complete: false,
      vacanciesSeen: 0,
      requestCount: input.requestCount,
      durationMs: input.durationMs,
    });
  });
}

async function scanOneSource(
  database: Database,
  baseHttp: AtsHttpClient,
  scanRunId: string,
  row: SourceRow,
  statistics: MutableStatistics,
  logger: Logger,
  requestAttribution: NetworkRequestAttribution,
): Promise<void> {
  if (!row.companyScanEnabled || ['blocked', 'manual_review', 'unsupported'].includes(row.status)) {
    await markNotScanned(database, scanRunId, row, statistics);
    return;
  }

  const startedAt = Date.now();
  const descriptor = descriptorFor(row);
  const adapter = descriptor === null ? null : createVacancyAdapter(row.provider, baseHttp);
  if (adapter === null || descriptor === null || !adapter.supports(descriptor)) {
    statistics.unsupportedSources += 1;
    statistics.errorCount += 1;
    const completedAt = new Date();
    try {
      await commitFailedSourceScan(database, {
        scanRunId,
        row,
        outcomeStatus: 'unsupported',
        sourceStatus: 'unsupported',
        diagnostic: {
          category: 'unsupported_ats',
          message: `No production adapter accepts provider ${row.provider}`,
        },
        requestCount: requestAttribution.countForSource(row.id),
        durationMs: Date.now() - startedAt,
        completedAt,
      });
    } catch (bookkeepingError) {
      logger.error(
        { ...safeErrorClassification(bookkeepingError), company: row.companyName },
        'Unsupported-source bookkeeping failed; continuing with other sources',
      );
    }
    return;
  }

  statistics.sourcesAttempted += 1;
  try {
    const adapterResult = await adapter.listVacancies(descriptor);
    const completedAt = new Date();
    const requestCount = requestAttribution.countForSource(row.id);
    const { persisted, invalidCount, complete } = await commitSuccessfulSourceScan(database, {
      scanRunId,
      row,
      adapterResult,
      requestCount,
      durationMs: Date.now() - startedAt,
      completedAt,
    });
    if (complete) statistics.sourcesScanned += 1;
    statistics.vacanciesDiscovered += persisted.discovered;
    statistics.vacanciesNew += persisted.created;
    statistics.vacanciesChanged += persisted.changed;
    statistics.vacanciesInactive += persisted.inactive;
    statistics.invalidVacancies += invalidCount;
    if (!complete) statistics.incompleteSources += 1;
    if (persisted.feedAnomaly !== null) statistics.manualReviewSources += 1;
    if (invalidCount > 0 || persisted.feedAnomaly !== null) {
      statistics.errorCount += 1;
    }
    logger.info(
      {
        company: row.companyName,
        provider: row.provider,
        vacancies: persisted.discovered,
        newVacancies: persisted.created,
        changedVacancies: persisted.changed,
        complete,
        requests: requestCount,
      },
      'Career source scan completed',
    );
  } catch (error) {
    statistics.errorCount += 1;
    const diagnostic = categorizeSourceError(error);
    const blocked = diagnostic.category === 'blocked';
    if (blocked) statistics.blockedSources += 1;
    const completedAt = new Date();
    const requestCount = requestAttribution.countForSource(row.id);
    try {
      await commitFailedSourceScan(database, {
        scanRunId,
        row,
        outcomeStatus: blocked ? 'blocked' : 'failed',
        sourceStatus: blocked ? 'blocked' : 'error',
        diagnostic,
        requestCount,
        durationMs: Date.now() - startedAt,
        completedAt,
      });
    } catch (bookkeepingError) {
      logger.error(
        { ...safeErrorClassification(bookkeepingError), company: row.companyName },
        'Failed-source bookkeeping failed; continuing with other sources',
      );
    }
    logger.warn(
      {
        company: row.companyName,
        provider: row.provider,
        category: diagnostic.category,
        status: diagnostic.httpStatus,
      },
      'Career source scan failed; continuing with other sources',
    );
  }
}

export async function runVacancyScan(
  database: Database,
  config: AppConfig,
  logger: Logger,
  scanRunId: string,
  scope?: VacancyScanScope,
): Promise<VacancyScanWorkflowResult> {
  const startedAt = Date.now();
  const fields = {
    id: careerSources.id,
    companyId: companies.id,
    companyName: companies.brandName,
    companyScanEnabled: companies.scanEnabled,
    provider: careerSources.provider,
    baseUrl: careerSources.baseUrl,
    boardIdentifier: careerSources.boardIdentifier,
    discoveryEvidence: careerSources.discoveryEvidence,
    status: careerSources.status,
  };
  let rows: SourceRow[];
  if (scope === undefined) {
    rows = await database
      .select(fields)
      .from(careerSources)
      .innerJoin(companies, eq(careerSources.companyId, companies.id))
      .where(isNull(careerSources.retiredAt));
  } else {
    const normalizedScope = normalizeVacancyScanScope(scope);
    const sourcePredicates = [
      isNull(careerSources.retiredAt),
      eq(careerSources.provider, normalizedScope.provider),
    ];
    if (normalizedScope.careerSourceIds.length > 0) {
      sourcePredicates.push(inArray(careerSources.id, normalizedScope.careerSourceIds));
    }
    rows = await database
      .select(fields)
      .from(careerSources)
      .innerJoin(companies, eq(careerSources.companyId, companies.id))
      .where(and(...sourcePredicates))
      .orderBy(asc(companies.brandName), asc(careerSources.id))
      .limit(normalizedScope.limit);
    assertRequestedCareerSourcesResolved(
      normalizedScope.provider,
      normalizedScope.careerSourceIds,
      rows,
    );
  }
  const statistics = createStatistics(rows.length);
  const requestAttribution = new NetworkRequestAttribution();
  const http = createDatabaseBackedAtsHttpClient(config, database, {
    onNetworkRequest: () => {
      requestAttribution.recordNetworkRequest();
    },
    onCacheError: (error, operation, safeUrl) =>
      logger.warn(
        { ...safeErrorClassification(error), operation, url: safeUrl },
        'HTTP cache operation failed; continuing without it',
      ),
  });

  for (let offset = 0; offset < rows.length; offset += config.scanBatchSize) {
    const batch = rows.slice(offset, offset + config.scanBatchSize);
    await Promise.all(
      batch.map((row) =>
        requestAttribution.runForSource(row.id, async () =>
          scanOneSource(
            database,
            http,
            scanRunId,
            row,
            statistics,
            logger,
            requestAttribution,
          ).catch((error: unknown) => {
            statistics.errorCount += 1;
            logger.error(
              { ...safeErrorClassification(error), company: row.companyName },
              'Unexpected per-source workflow failure; continuing with other sources',
            );
          }),
        ),
      ),
    );
  }
  statistics.requestCount = requestAttribution.total;
  statistics.durationMs = Date.now() - startedAt;
  const failedOrIncomplete = statistics.errorCount + statistics.incompleteSources;
  const status: ScanStatus =
    statistics.sourcesAttempted === 0 && statistics.errorCount > 0
      ? 'failed'
      : failedOrIncomplete > 0 || statistics.blockedSources > 0
        ? 'partial'
        : 'succeeded';
  return { ...statistics, status };
}
