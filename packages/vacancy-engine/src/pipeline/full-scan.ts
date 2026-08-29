import type { Logger } from 'pino';

import type { AppConfig } from '../config.js';
import { pruneHttpCache } from '../crawler/database-cache.js';
import { isCrawlerHttpError, safeErrorClassification } from '../crawler/errors.js';
import {
  SCAN_ADVISORY_LOCK,
  withScanAdvisoryTryLock,
  type ScanLock,
} from '../db/advisory-lock.js';
import type { Database } from '../db/client.js';
import { findUsableSponsorBaseline, type UsableSponsorBaseline } from '../ind/repository.js';
import {
  writeReportFiles,
  type JobRadarReport,
  type ReportStatistics,
} from '../reporting/report.js';
import { buildJobRadarReport } from '../reporting/repository.js';
import { finishScanRun, recordScanError, startScanRun } from '../scans/repository.js';
import { runPersistedDeterministicScoring } from '../scoring/index.js';
import { runCompanyMappingSync } from './companies.js';
import { runSponsorSync, type SponsorSyncWorkflowResult } from './sponsors.js';
import {
  runVacancyScan,
  type VacancyScanScope,
  type VacancyScanWorkflowResult,
} from './vacancies.js';

const MILLISECONDS_PER_DAY = 86_400_000;

export type VacancyScanCommandOptions = {
  command?: string;
  scope?: VacancyScanScope;
};

type SponsorStageDependencies = {
  sync?: typeof runSponsorSync;
  loadBaseline?: (
    database: Database,
    maximumAgeDays: number,
  ) => Promise<UsableSponsorBaseline | null>;
  recordError?: typeof recordScanError;
};

export async function runSponsorStageWithFallback(
  database: Database,
  config: AppConfig,
  logger: Logger,
  scanRunId: string,
  dependencies: SponsorStageDependencies = {},
): Promise<{ sponsorSync: SponsorSyncWorkflowResult; fallbackUsed: boolean }> {
  const sync = dependencies.sync ?? runSponsorSync;
  try {
    return { sponsorSync: await sync(database, config, logger), fallbackUsed: false };
  } catch (error) {
    const loadBaseline = dependencies.loadBaseline ?? findUsableSponsorBaseline;
    const baseline = await loadBaseline(database, config.sponsorBaselineMaxAgeDays);
    if (baseline === null) throw error;
    const diagnostic = isCrawlerHttpError(error)
      ? {
          category: error.category,
          message: error.message,
          ...(error.status === undefined ? {} : { httpStatus: error.status }),
        }
      : {
          category: 'network_error' as const,
          message: `Official sponsor refresh failed (${safeErrorClassification(error).errorType})`,
        };
    const recordError = dependencies.recordError ?? recordScanError;
    await recordError(database, {
      scanRunId,
      ...diagnostic,
      context: {
        stage: 'sponsor_sync',
        fallback: 'accepted_age_bounded_snapshot',
        baselineRetrievedAt: baseline.retrievedAt.toISOString(),
      },
    });
    logger.warn(
      {
        baselineRetrievedAt: baseline.retrievedAt.toISOString(),
        activeSponsors: baseline.uniqueSponsors,
      },
      'Official sponsor refresh failed; continuing with a trusted recent baseline',
    );
    return {
      sponsorSync: {
        sourceRows: baseline.sourceRows,
        uniqueSponsors: baseline.uniqueSponsors,
        duplicatesIgnored: baseline.duplicatesIgnored,
        sourceLastUpdated: baseline.sourceLastUpdated,
        membershipHash: baseline.membershipHash,
        retrievedFromConditionalCache: false,
        requestCount: 0,
      },
      fallbackUsed: true,
    };
  }
}

async function pruneStaleHttpCache(
  database: Database,
  config: AppConfig,
  logger: Logger,
): Promise<void> {
  const cutoff = new Date(Date.now() - config.httpCacheRetentionDays * MILLISECONDS_PER_DAY);
  try {
    const removedEntries = await pruneHttpCache(database, cutoff);
    if (removedEntries > 0) {
      logger.info(
        { removedEntries, retentionDays: config.httpCacheRetentionDays },
        'Stale HTTP cache entries pruned',
      );
    }
  } catch (error) {
    logger.warn({ err: error }, 'HTTP cache pruning failed; scan results remain usable');
  }
}

export function reportStatisticsForVacancyScan(
  vacancyScan: VacancyScanWorkflowResult,
  durationMs = vacancyScan.durationMs,
  requestCount = vacancyScan.requestCount,
): ReportStatistics {
  return {
    sponsorsLoaded: 0,
    activeSponsors: 0,
    companiesMapped: 0,
    careerSourcesDiscovered: vacancyScan.sourcesDiscovered,
    careerSourcesScanned: vacancyScan.sourcesScanned,
    incompleteSources: vacancyScan.incompleteSources,
    blockedSources: vacancyScan.blockedSources,
    manualReviewSources: vacancyScan.manualReviewSources,
    unsupportedSources: vacancyScan.unsupportedSources,
    vacanciesDiscovered: vacancyScan.vacanciesDiscovered,
    vacanciesNew: vacancyScan.vacanciesNew,
    vacanciesChanged: vacancyScan.vacanciesChanged,
    vacanciesInactive: vacancyScan.vacanciesInactive,
    staleVacanciesExcluded: 0,
    duplicateVacanciesCollapsed: 0,
    deterministicCandidates: 0,
    semanticScored: 0,
    relevantVacancies: 0,
    excellentMatches: 0,
    errorCount: vacancyScan.errorCount,
    requestCount,
    durationMs,
  };
}

async function runUnlockedVacancyScanCommand(
  database: Database,
  config: AppConfig,
  logger: Logger,
  options: VacancyScanCommandOptions,
): Promise<{ scanRunId: string; vacancyScan: VacancyScanWorkflowResult }> {
  const commandStartedAt = Date.now();
  const scanRunId = await startScanRun(database, options.command ?? 'vacancies:scan', false);
  let fallbackStatistics = reportStatisticsForVacancyScan({
    status: 'failed',
    sourcesDiscovered: 0,
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
  });
  try {
    const vacancyScan = await runVacancyScan(database, config, logger, scanRunId, options.scope);
    fallbackStatistics = reportStatisticsForVacancyScan(vacancyScan);
    if (options.scope === undefined) {
      await pruneStaleHttpCache(database, config, logger);
    }
    await finishScanRun(
      database,
      scanRunId,
      vacancyScan.status,
      reportStatisticsForVacancyScan(vacancyScan),
    );
    return { scanRunId, vacancyScan };
  } catch (error) {
    const diagnostic = isCrawlerHttpError(error)
      ? {
          category: error.category,
          message: error.message,
          ...(error.status === undefined ? {} : { httpStatus: error.status }),
        }
      : {
          category: 'parse_error' as const,
          message: `Fatal vacancy-scan failure (${safeErrorClassification(error).errorType})`,
        };
    try {
      await recordScanError(database, { scanRunId, ...diagnostic, context: { stage: 'vacancy_scan' } });
    } catch (diagnosticError) {
      logger.warn(
        { ...safeErrorClassification(diagnosticError) },
        'Fatal vacancy-scan diagnostic could not be persisted',
      );
    }
    await finishScanRun(database, scanRunId, 'failed', {
      ...fallbackStatistics,
      errorCount: Math.max(1, fallbackStatistics.errorCount),
      durationMs: Date.now() - commandStartedAt,
    });
    throw error;
  }
}

export type VacancyScanCommandResult =
  | {
      status: 'completed';
      scanRunId: string;
      vacancyScan: VacancyScanWorkflowResult;
    }
  | { status: 'skipped'; reason: 'already-running' };

export async function runVacancyScanCommand(
  database: Database,
  config: AppConfig,
  logger: Logger,
  scanLock: ScanLock,
  options: VacancyScanCommandOptions = {},
): Promise<VacancyScanCommandResult> {
  const outcome = await withScanAdvisoryTryLock(scanLock, async () =>
    runUnlockedVacancyScanCommand(database, config, logger, options),
  );

  if (!outcome.acquired) {
    logger.warn(
      { lock: SCAN_ADVISORY_LOCK },
      'Vacancy scan skipped because another scan is already running',
    );
    return { status: 'skipped', reason: 'already-running' };
  }

  return { status: 'completed', ...outcome.value };
}

type ReportPublicationDependencies = {
  finish?: typeof finishScanRun;
  write?: typeof writeReportFiles;
};

export async function finishScanAndPublishReport(
  database: Database,
  scanRunId: string,
  report: JobRadarReport,
  dependencies: ReportPublicationDependencies = {},
): Promise<Awaited<ReturnType<typeof writeReportFiles>>> {
  const finish = dependencies.finish ?? finishScanRun;
  const write = dependencies.write ?? writeReportFiles;
  if (report.scanStatus === 'running') {
    throw new Error('A running scan cannot publish a final report');
  }
  await finish(database, scanRunId, report.scanStatus, report.statistics);
  return write(report);
}

async function runUnlockedEndToEndScan(
  database: Database,
  config: AppConfig,
  logger: Logger,
): Promise<{
  scanRunId: string;
  reportFiles: Awaited<ReturnType<typeof writeReportFiles>>;
  statistics: ReportStatistics;
  status: VacancyScanWorkflowResult['status'];
}> {
  const fullScanStartedAt = Date.now();
  const scanRunId = await startScanRun(database, 'scan', false);
  let fallbackStatistics = reportStatisticsForVacancyScan({
    status: 'failed',
    sourcesDiscovered: 0,
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
  });
  let stage = 'sponsor_sync';

  try {
    const sponsorStage = await runSponsorStageWithFallback(
      database,
      config,
      logger,
      scanRunId,
    );
    const sponsorSync = sponsorStage.sponsorSync;
    fallbackStatistics = {
      ...fallbackStatistics,
      sponsorsLoaded: sponsorSync.uniqueSponsors,
      activeSponsors: sponsorSync.uniqueSponsors,
      requestCount: sponsorSync.requestCount,
      durationMs: Date.now() - fullScanStartedAt,
    };
    stage = 'company_mapping';
    const companyMapping = await runCompanyMappingSync(database, logger);
    fallbackStatistics = {
      ...fallbackStatistics,
      companiesMapped: companyMapping.companiesMapped,
      careerSourcesDiscovered: companyMapping.careerSources,
      durationMs: Date.now() - fullScanStartedAt,
    };
    stage = 'vacancy_scan';
    const vacancyScan = await runVacancyScan(database, config, logger, scanRunId);
    await pruneStaleHttpCache(database, config, logger);
    stage = 'deterministic_scoring';
    const scoring = await runPersistedDeterministicScoring(database);
    const durationMs = Date.now() - fullScanStartedAt;
    fallbackStatistics = reportStatisticsForVacancyScan(
      vacancyScan,
      durationMs,
      vacancyScan.requestCount + sponsorSync.requestCount,
    );
    fallbackStatistics = {
      ...fallbackStatistics,
      sponsorsLoaded: sponsorSync.uniqueSponsors,
      activeSponsors: sponsorSync.uniqueSponsors,
      companiesMapped: companyMapping.companiesMapped,
      errorCount: vacancyScan.errorCount + (sponsorStage.fallbackUsed ? 1 : 0),
    };
    stage = 'report_generation';
    const scanStatus =
      sponsorStage.fallbackUsed && vacancyScan.status === 'succeeded'
        ? 'partial'
        : vacancyScan.status;
    const report = await buildJobRadarReport(database, {
      scanRunId,
      scanStatus,
      minimumScore: config.reportMinScore,
      maximumPostingAgeDays: config.maxPostingAgeDays,
      statistics: fallbackStatistics,
    });
    stage = 'scan_finalization_and_report_publication';
    const reportFiles = await finishScanAndPublishReport(database, scanRunId, report);
    logger.info(
      {
        scanRunId,
        status: scanStatus,
        activeVacancies: scoring.activeVacancies,
        scoringCacheHits: scoring.cacheHits,
        scoresComputed: scoring.computed,
        relevantVacancies: report.statistics.relevantVacancies,
        latestHtml: reportFiles.latestHtml,
      },
      'End-to-end IND Job Radar scan completed',
    );
    return {
      scanRunId,
      reportFiles,
      statistics: report.statistics,
      status: scanStatus,
    };
  } catch (error) {
    const diagnostic = isCrawlerHttpError(error)
      ? {
          category: error.category,
          message: error.message,
          ...(error.status === undefined ? {} : { httpStatus: error.status }),
        }
      : {
          category: 'parse_error' as const,
          message: `Fatal scan failure (${safeErrorClassification(error).errorType})`,
        };
    try {
      await recordScanError(database, {
        scanRunId,
        ...diagnostic,
        context: { stage },
      });
    } catch (diagnosticError) {
      logger.warn(
        { ...safeErrorClassification(diagnosticError), stage },
        'Fatal scan diagnostic could not be persisted',
      );
    }
    await finishScanRun(database, scanRunId, 'failed', {
      ...fallbackStatistics,
      errorCount: Math.max(1, fallbackStatistics.errorCount),
      durationMs: Date.now() - fullScanStartedAt,
    });
    throw error;
  }
}

export type EndToEndScanCommandResult =
  | Awaited<ReturnType<typeof runUnlockedEndToEndScan>>
  | { status: 'skipped'; reason: 'already-running' };

export async function runEndToEndScan(
  database: Database,
  config: AppConfig,
  logger: Logger,
  scanLock: ScanLock,
): Promise<EndToEndScanCommandResult> {
  const outcome = await withScanAdvisoryTryLock(scanLock, async () =>
    runUnlockedEndToEndScan(database, config, logger),
  );

  if (!outcome.acquired) {
    logger.warn(
      { lock: SCAN_ADVISORY_LOCK },
      'End-to-end scan skipped because another scan is already running',
    );
    return { status: 'skipped', reason: 'already-running' };
  }

  return outcome.value;
}
