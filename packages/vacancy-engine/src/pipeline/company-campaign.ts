import { desc, eq, inArray, sql } from 'drizzle-orm';
import type { Logger } from 'pino';

import {
  checkpointCompanyDiscoveryCampaign,
  completeCompanyDiscoveryCampaignItems,
  finalizeCompanyDiscoveryCampaign,
  listCompanyDiscoveryCampaignItemsForExport,
  startOrResumeCompanyDiscoveryCampaign,
  type CompanyDiscoveryCampaignOutcome,
  type CompleteCompanyDiscoveryCampaignItemInput,
} from '../companies/discovery-campaign-repository.js';
import { writeCompanyDiscoveryCampaignExport } from '../companies/discovery-campaign-export.js';
import {
  promoteDiscoveredCareerSources,
  reconcileDiscoverySourceOutcomes,
} from '../companies/discovery-promotion.js';
import type { StructuredDomainMergeOutcome } from '../companies/structured-domain-merge.js';
import type { AppConfig } from '../config.js';
import { safeErrorClassification } from '../crawler/errors.js';
import type { Database } from '../db/client.js';
import {
  careerSources,
  companies,
  companyDiscoveryAttempts,
  companySponsors,
  scanRuns,
  scanSourceOutcomes,
  sponsorDiscovery,
  vacancies,
} from '../db/schema.js';
import { writeReportFiles } from '../reporting/report.js';
import { buildJobRadarReport } from '../reporting/repository.js';
import {
  finishOperationalRun,
  recordScanError,
  startScanRun,
} from '../scans/repository.js';
import { runPersistedDeterministicScoring } from '../scoring/index.js';
import { runCompanyDiscoveryInspection, seedCompanyDiscoveryInventory } from './company-discovery.js';
import {
  runCompanyDomainEnrichment,
  type CompanyDomainEnrichmentResult,
} from './company-domain-enrichment.js';
import {
  runCompanyDomainSearch,
  type CompanyDomainSearchResult,
} from './company-domain-search.js';
import { runCompanyMappingSync } from './companies.js';
import { reportStatisticsForVacancyScan } from './full-scan.js';
import { runVacancyScan, type VacancyScanWorkflowResult } from './vacancies.js';

const MAX_INSPECTION_BATCHES = 1_000;
const MAX_PROMOTION_BATCHES = 1_000;

type SourceAudit = {
  companyId: string;
  companyName: string;
  companyScanEnabled: boolean;
  careerSourceId: string | null;
  provider: string | null;
  baseUrl: string | null;
  canonicalKey: string | null;
  status: string | null;
  retiredAt: string | null;
  lastSuccessAt: string | null;
  lastFailureAt: string | null;
  sourceOutcome: {
    status: string;
    complete: boolean;
    vacanciesSeen: number;
    requestCount: number;
    durationMs: number;
  } | null;
  activeVacancies: number;
};

export type CompanyCampaignResult = {
  campaignRunId: string;
  expectedSponsors: number;
  resumed: boolean;
  domainEnrichment: Omit<CompanyDomainEnrichmentResult, 'outcomes'> | null;
  domainEnrichmentError: string | null;
  domainSearch: Omit<CompanyDomainSearchResult, 'audits'> | null;
  domainSearchError: string | null;
  inspectionRunIds: string[];
  inspectionRequests: number;
  promotedSources: number;
  vacancyScanRunId: string;
  vacancyScan: VacancyScanWorkflowResult;
  scoring: Awaited<ReturnType<typeof runPersistedDeterministicScoring>>;
  reportFiles: Awaited<ReturnType<typeof writeReportFiles>>;
  campaignExport: Awaited<ReturnType<typeof writeCompanyDiscoveryCampaignExport>>;
};

function sourceAuditRank(source: SourceAudit): number {
  if (source.sourceOutcome?.status === 'succeeded') return 0;
  if (source.status === 'active' && source.retiredAt === null) return 1;
  if (source.sourceOutcome?.status === 'manual_review') return 2;
  if (source.sourceOutcome?.status === 'blocked') return 3;
  if (source.sourceOutcome?.status === 'unsupported') return 4;
  if (source.sourceOutcome?.status === 'failed') return 5;
  return 6;
}

function mappedReason(status: string, sources: readonly SourceAudit[]): string {
  const succeeded = sources.find((source) => source.sourceOutcome?.status === 'succeeded');
  if (status === 'active' && succeeded !== undefined) {
    return (succeeded.sourceOutcome?.vacanciesSeen ?? 0) > 0
      ? 'vacancies_scanned'
      : 'active_source_no_vacancies';
  }
  switch (status) {
    case 'active':
      return 'verified_active_mapping';
    case 'source_verified':
      return 'source_verification_pending';
    case 'careers_found':
      return 'careers_source_not_activated';
    case 'no_public_careers':
      return 'no_public_careers';
    case 'unsupported':
      return 'unsupported_source';
    case 'blocked':
      return 'source_or_site_blocked';
    case 'manual_review':
      return 'manual_review_required';
    case 'error':
      return 'source_or_site_error';
    case 'candidate_ready':
      return 'candidate_not_inspected';
    case 'domain_verified':
      return 'domain_verified_no_source_result';
    default:
      return 'no_verified_domain';
  }
}

export function deriveCampaignSourceScanResult(
  outcomes: readonly { status: string; vacanciesSeen: number }[],
): { outcome: CompanyDiscoveryCampaignOutcome; reasonCode: string } | null {
  if (outcomes.length === 0) return null;
  const succeeded = outcomes.find((outcome) => outcome.status === 'succeeded');
  if (succeeded !== undefined) {
    return {
      outcome: 'active',
      reasonCode: succeeded.vacanciesSeen > 0
        ? 'vacancies_scanned'
        : 'active_source_no_vacancies',
    };
  }
  const precedence = [
    ['blocked', 'blocked', 'source_scan_blocked'],
    ['failed', 'error', 'source_scan_failed'],
    ['manual_review', 'manual_review', 'source_scan_manual_review'],
    ['unsupported', 'unsupported', 'source_scan_unsupported'],
  ] as const;
  for (const [sourceStatus, outcome, reasonCode] of precedence) {
    if (outcomes.some((sourceOutcome) => sourceOutcome.status === sourceStatus)) {
      return { outcome, reasonCode };
    }
  }
  return { outcome: 'error', reasonCode: 'source_scan_unknown_outcome' };
}

function sourceScanCampaignResult(
  sources: readonly SourceAudit[],
): { outcome: CompanyDiscoveryCampaignOutcome; reasonCode: string } | null {
  return deriveCampaignSourceScanResult(
    sources.flatMap((source) =>
      source.sourceOutcome === null
        ? []
        : [{ status: source.sourceOutcome.status, vacanciesSeen: source.sourceOutcome.vacanciesSeen }],
    ),
  );
}

function finalPhase(status: string, sources: readonly SourceAudit[], hasAttempt: boolean): string {
  if (sources.some((source) => source.sourceOutcome !== null)) return 'vacancy_scan';
  if (['active', 'source_verified'].includes(status)) return 'source_verification';
  if (hasAttempt) return 'site_inspection';
  return 'domain_resolution';
}

function domainOutcomeDetails(outcome: StructuredDomainMergeOutcome | undefined): Record<string, unknown> | null {
  if (outcome === undefined) return null;
  if (outcome.status === 'candidate') {
    return {
      status: outcome.status,
      reasonCode: outcome.reasonCode,
      officialUrl: outcome.candidate.officialUrl,
      sources: outcome.candidate.sources,
      provenance: outcome.candidate.provenance,
    };
  }
  return { ...outcome };
}

async function buildCampaignCompletionInputs(
  database: Database,
  campaignRunId: string,
  inspectionRunIds: readonly string[],
  vacancyScanRunId: string,
  domainOutcomes: readonly StructuredDomainMergeOutcome[],
  domainEnrichmentError: string | null,
): Promise<CompleteCompanyDiscoveryCampaignItemInput[]> {
  const campaignRows = await listCompanyDiscoveryCampaignItemsForExport(database, campaignRunId);
  const discoveryRows = await database.select().from(sponsorDiscovery);
  const discoveryBySponsor = new Map(discoveryRows.map((row) => [row.sponsorId, row]));
  const attempts = inspectionRunIds.length === 0
    ? []
    : await database
        .select()
        .from(companyDiscoveryAttempts)
        .where(inArray(companyDiscoveryAttempts.scanRunId, [...inspectionRunIds]))
        .orderBy(desc(companyDiscoveryAttempts.createdAt), desc(companyDiscoveryAttempts.id));
  const attemptBySponsor = new Map<string, (typeof attempts)[number]>();
  for (const attempt of attempts) {
    if (!attemptBySponsor.has(attempt.sponsorId)) attemptBySponsor.set(attempt.sponsorId, attempt);
  }
  const domainBySponsor = new Map(domainOutcomes.map((outcome) => [outcome.sponsorId, outcome]));

  const sourceOutcomeRows = await database
    .select()
    .from(scanSourceOutcomes)
    .where(eq(scanSourceOutcomes.scanRunId, vacancyScanRunId));
  const sourceOutcomeBySource = new Map(
    sourceOutcomeRows.map((row) => [row.careerSourceId, row]),
  );
  const activeVacancyRows = await database
    .select({
      careerSourceId: vacancies.careerSourceId,
      count: sql<number>`count(*)`,
    })
    .from(vacancies)
    .where(eq(vacancies.active, true))
    .groupBy(vacancies.careerSourceId);
  const activeVacanciesBySource = new Map(
    activeVacancyRows.map((row) => [row.careerSourceId, row.count]),
  );
  const relationshipRows = await database
    .select({
      sponsorId: companySponsors.sponsorId,
      companyId: companies.id,
      companyName: companies.brandName,
      companyScanEnabled: companies.scanEnabled,
      careerSourceId: careerSources.id,
      provider: careerSources.provider,
      baseUrl: careerSources.baseUrl,
      canonicalKey: careerSources.canonicalKey,
      status: careerSources.status,
      retiredAt: careerSources.retiredAt,
      lastSuccessAt: careerSources.lastSuccessAt,
      lastFailureAt: careerSources.lastFailureAt,
    })
    .from(companySponsors)
    .innerJoin(companies, eq(companies.id, companySponsors.companyId))
    .leftJoin(careerSources, eq(careerSources.companyId, companies.id));
  const sourcesBySponsor = new Map<string, SourceAudit[]>();
  for (const row of relationshipRows) {
    const sourceOutcome = row.careerSourceId === null
      ? undefined
      : sourceOutcomeBySource.get(row.careerSourceId);
    const audit: SourceAudit = {
      companyId: row.companyId,
      companyName: row.companyName,
      companyScanEnabled: row.companyScanEnabled,
      careerSourceId: row.careerSourceId,
      provider: row.provider,
      baseUrl: row.baseUrl,
      canonicalKey: row.canonicalKey,
      status: row.status,
      retiredAt: row.retiredAt?.toISOString() ?? null,
      lastSuccessAt: row.lastSuccessAt?.toISOString() ?? null,
      lastFailureAt: row.lastFailureAt?.toISOString() ?? null,
      sourceOutcome: sourceOutcome === undefined
        ? null
        : {
            status: sourceOutcome.status,
            complete: sourceOutcome.complete,
            vacanciesSeen: sourceOutcome.vacanciesSeen,
            requestCount: sourceOutcome.requestCount,
            durationMs: sourceOutcome.durationMs,
          },
      activeVacancies: row.careerSourceId === null
        ? 0
        : (activeVacanciesBySource.get(row.careerSourceId) ?? 0),
    };
    const group = sourcesBySponsor.get(row.sponsorId) ?? [];
    group.push(audit);
    sourcesBySponsor.set(row.sponsorId, group);
  }

  return campaignRows.filter((campaignRow) => campaignRow.state === 'pending').map((campaignRow) => {
    const discovery = discoveryBySponsor.get(campaignRow.sponsorId);
    const attempt = attemptBySponsor.get(campaignRow.sponsorId);
    const domainOutcome = domainBySponsor.get(campaignRow.sponsorId);
    const sources = (sourcesBySponsor.get(campaignRow.sponsorId) ?? [])
      .sort((left, right) => sourceAuditRank(left) - sourceAuditRank(right));
    const sourceScanResult = sourceScanCampaignResult(sources);
    let outcome = sourceScanResult?.outcome ?? discovery?.status ?? 'needs_domain';
    let reasonCode = sourceScanResult?.reasonCode ?? mappedReason(outcome, sources);
    if (
      sourceScanResult === null &&
      attempt === undefined &&
      sources.length === 0 &&
      domainOutcome !== undefined
    ) {
      if (domainOutcome.status === 'manual_review') {
        outcome = 'manual_review';
        reasonCode = domainOutcome.reasonCode;
      } else if (domainOutcome.status === 'missing_kvk' || domainOutcome.status === 'not_found') {
        outcome = 'needs_domain';
        reasonCode = domainOutcome.reasonCode;
      }
    } else if (
      sourceScanResult === null &&
      attempt?.category !== null &&
      attempt?.category !== undefined
    ) {
      reasonCode = /^[a-z][a-z0-9_]{0,99}$/u.test(attempt.category)
        ? attempt.category
        : reasonCode;
    }
    if (
      sourceScanResult === null &&
      domainEnrichmentError !== null &&
      attempt === undefined &&
      sources.length === 0 &&
      domainOutcome === undefined
    ) {
      outcome = 'error';
      reasonCode = 'domain_enrichment_failed';
    }
    const pagesAttempted = attempt?.pagesInspected ?? 0;
    const pagesFetched = attempt === undefined
      ? 0
      : attempt.outcome === 'error' && attempt.httpStatus === null
        ? 0
        : pagesAttempted;
    return {
      sponsorId: campaignRow.sponsorId,
      finalPhase: finalPhase(outcome, sources, attempt !== undefined),
      outcome,
      reasonCode,
      networkAttempted: pagesAttempted > 0,
      pagesAttempted,
      pagesFetched,
      physicalRequestCount: attempt?.physicalRequestCount ?? 0,
      httpStatus: attempt?.httpStatus ?? null,
      details: {
        officialUrl: discovery?.officialUrl ?? null,
        officialHostname: discovery?.officialHostname ?? null,
        brandName: discovery?.brandName ?? null,
        discoveryStatus: discovery?.status ?? null,
        discoveryDiagnostic: discovery?.diagnostic ?? null,
        careersUrl: discovery?.careersUrl ?? null,
        provider: discovery?.provider ?? null,
        boardIdentifier: discovery?.boardIdentifier ?? null,
        domainResolution: domainOutcomeDetails(domainOutcome),
        domainEnrichmentError,
        inspection: attempt === undefined
          ? null
          : {
              attemptId: attempt.id,
              scanRunId: attempt.scanRunId,
              outcome: attempt.outcome,
              category: attempt.category,
              diagnostic: attempt.diagnostic,
              durationMs: attempt.durationMs,
              result: attempt.result,
            },
        sources,
      },
    };
  });
}

async function persistCampaignOutcomes(
  database: Database,
  logger: Logger,
  campaignRunId: string,
  inputs: readonly CompleteCompanyDiscoveryCampaignItemInput[],
): Promise<void> {
  for (let offset = 0; offset < inputs.length; offset += 100) {
    const batch = inputs.slice(offset, offset + 100);
    await completeCompanyDiscoveryCampaignItems(database, campaignRunId, batch);
    for (const [index, input] of batch.entries()) {
      logger.info(
        {
          event: 'company_discovery_campaign_outcome',
          campaignRunId,
          ordinal: offset + index + 1,
          totalSponsors: inputs.length,
          sponsorId: input.sponsorId,
          finalPhase: input.finalPhase,
          outcome: input.outcome,
          reasonCode: input.reasonCode,
          siteInspectionAttempted: input.networkAttempted,
          sitePagesAttempted: input.pagesAttempted,
          sitePagesFetched: input.pagesFetched,
          sitePhysicalRequestCount: input.physicalRequestCount,
          httpStatus: input.httpStatus ?? null,
        },
        'Per-company campaign outcome committed',
      );
    }
  }
}

function emptyVacancyScan(): VacancyScanWorkflowResult {
  return {
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
    errorCount: 1,
    requestCount: 0,
    durationMs: 0,
  };
}

export async function runFullCompanyCampaign(
  database: Database,
  config: AppConfig,
  logger: Logger,
): Promise<CompanyCampaignResult> {
  await runCompanyMappingSync(database, logger);
  const campaign = await startOrResumeCompanyDiscoveryCampaign(database);

  let domainEnrichment: CompanyDomainEnrichmentResult | null = null;
  let domainEnrichmentError: string | null = null;
  try {
    domainEnrichment = await runCompanyDomainEnrichment(database, config, logger);
    await checkpointCompanyDiscoveryCampaign(database, campaign.campaignRunId, {
      structuredSourceRequestCount: domainEnrichment.sourceRequests,
    });
  } catch (error) {
    domainEnrichmentError = safeErrorClassification(error).errorType;
    logger.error(
      { ...safeErrorClassification(error), campaignRunId: campaign.campaignRunId },
      'Structured domain enrichment failed; continuing with the last trusted catalog',
    );
  }
  await seedCompanyDiscoveryInventory(database);

  let domainSearch: CompanyDomainSearchResult | null = null;
  let domainSearchError: string | null = null;
  if (config.braveSearch.apiKey.trim().length > 0) {
    try {
      domainSearch = await runCompanyDomainSearch(database, config, logger);
    } catch (error) {
      domainSearchError = safeErrorClassification(error).errorType;
      logger.error(
        { ...safeErrorClassification(error), campaignRunId: campaign.campaignRunId },
        'Optional employer-domain search failed; continuing with trusted candidates already available',
      );
    }
  }

  const inspectionRunIds = [...campaign.inspectionRunIds];
  let inspectionRequests = 0;
  for (let batch = 0; batch < MAX_INSPECTION_BATCHES; batch += 1) {
    const result = await runCompanyDiscoveryInspection(database, config, logger, {
      startRun: async (inspectionDatabase, command, aiEnabled) => {
        const scanRunId = await startScanRun(inspectionDatabase, command, aiEnabled);
        await checkpointCompanyDiscoveryCampaign(database, campaign.campaignRunId, {
          inspectionRunIds: [...inspectionRunIds, scanRunId],
        });
        inspectionRunIds.push(scanRunId);
        return scanRunId;
      },
    });
    inspectionRequests += result.statistics.requestCount;
    if (result.statistics.candidatesQueued === 0) break;
    if (batch === MAX_INSPECTION_BATCHES - 1) {
      throw new Error('Company inspection exceeded the bounded campaign batch limit');
    }
  }

  let promotedSources = 0;
  for (let batch = 0; batch < MAX_PROMOTION_BATCHES; batch += 1) {
    const result = await promoteDiscoveredCareerSources(database, logger);
    promotedSources += result.promoted;
    if (result.examined === 0) break;
    if (batch === MAX_PROMOTION_BATCHES - 1) {
      throw new Error('Career-source promotion exceeded the bounded campaign batch limit');
    }
  }

  const vacancyScanRunId = await startScanRun(database, 'companies:campaign:vacancies', false);
  let vacancyScan = emptyVacancyScan();
  try {
    vacancyScan = await runVacancyScan(database, config, logger, vacancyScanRunId);
    const { status, ...statistics } = vacancyScan;
    await finishOperationalRun(database, vacancyScanRunId, status, statistics);
  } catch (error) {
    await recordScanError(database, {
      scanRunId: vacancyScanRunId,
      category: 'parse_error',
      message: `Fatal campaign vacancy scan failure (${safeErrorClassification(error).errorType})`,
      context: { stage: 'vacancy_scan' },
    });
    await finishOperationalRun(
      database,
      vacancyScanRunId,
      'failed',
      reportStatisticsForVacancyScan(vacancyScan),
    );
    logger.error(
      { ...safeErrorClassification(error), vacancyScanRunId },
      'Campaign vacancy scan failed globally; per-company campaign finalization will continue',
    );
  }
  await checkpointCompanyDiscoveryCampaign(database, campaign.campaignRunId, {
    sourceScanRunId: vacancyScanRunId,
    sourceScanPhysicalRequestCount: vacancyScan.requestCount,
  });
  await reconcileDiscoverySourceOutcomes(database, vacancyScanRunId);
  const scoring = await runPersistedDeterministicScoring(database);
  const reportStatistics = {
    ...reportStatisticsForVacancyScan(
      vacancyScan,
      vacancyScan.durationMs,
      vacancyScan.requestCount
        + inspectionRequests
        + (domainEnrichment?.sourceRequests ?? 0)
        + (domainSearch?.physicalRequests ?? 0),
    ),
    sponsorsLoaded: campaign.expectedSponsors,
    activeSponsors: campaign.expectedSponsors,
  };
  const report = await buildJobRadarReport(database, {
    scanRunId: vacancyScanRunId,
    scanStatus: vacancyScan.status,
    minimumScore: config.reportMinScore,
    maximumPostingAgeDays: config.maxPostingAgeDays,
    statistics: reportStatistics,
  });
  const reportFiles = await writeReportFiles(report);

  const completionInputs = await buildCampaignCompletionInputs(
    database,
    campaign.campaignRunId,
    inspectionRunIds,
    vacancyScanRunId,
    domainEnrichment?.outcomes ?? [],
    domainEnrichmentError,
  );
  await persistCampaignOutcomes(database, logger, campaign.campaignRunId, completionInputs);
  await finalizeCompanyDiscoveryCampaign(database, campaign.campaignRunId);
  const campaignExport = await writeCompanyDiscoveryCampaignExport(
    database,
    campaign.campaignRunId,
  );
  const domainEnrichmentSummary: Omit<CompanyDomainEnrichmentResult, 'outcomes'> | null =
    domainEnrichment === null
      ? null
      : {
          activeSponsors: domainEnrichment.activeSponsors,
          sourceRequests: domainEnrichment.sourceRequests,
          structuredBindings: domainEnrichment.structuredBindings,
          invalidBindings: domainEnrichment.invalidBindings,
          candidatesGenerated: domainEnrichment.candidatesGenerated,
          candidatesPersisted: domainEnrichment.candidatesPersisted,
          manualCandidatesPreserved: domainEnrichment.manualCandidatesPreserved,
          notFound: domainEnrichment.notFound,
          missingKvk: domainEnrichment.missingKvk,
          ambiguous: domainEnrichment.ambiguous,
          responseHash: domainEnrichment.responseHash,
          responseHashes: domainEnrichment.responseHashes,
          sourceStatistics: domainEnrichment.sourceStatistics,
          catalogPath: domainEnrichment.catalogPath,
        };
  return {
    campaignRunId: campaign.campaignRunId,
    expectedSponsors: campaign.expectedSponsors,
    resumed: campaign.resumed,
    domainEnrichment: domainEnrichmentSummary,
    domainEnrichmentError,
    domainSearch: domainSearch === null ? null : {
      attempted: domainSearch.attempted,
      candidateHigh: domainSearch.candidateHigh,
      candidateManual: domainSearch.candidateManual,
      notFound: domainSearch.notFound,
      blocked: domainSearch.blocked,
      errors: domainSearch.errors,
      physicalRequests: domainSearch.physicalRequests,
      candidatesPersisted: domainSearch.candidatesPersisted,
      remainingBatchCapacity: domainSearch.remainingBatchCapacity,
      catalogPath: domainSearch.catalogPath,
      latestAudit: domainSearch.latestAudit,
      timestampedAudit: domainSearch.timestampedAudit,
    },
    domainSearchError,
    inspectionRunIds,
    inspectionRequests,
    promotedSources,
    vacancyScanRunId,
    vacancyScan,
    scoring,
    reportFiles,
    campaignExport,
  };
}

export async function getLatestCompanyCampaignRunId(database: Database): Promise<string> {
  const [run] = await database
    .select({ id: scanRuns.id })
    .from(scanRuns)
    .where(eq(scanRuns.command, 'companies:discovery:campaign'))
    .orderBy(desc(scanRuns.startedAt), desc(scanRuns.id))
    .limit(1);
  if (run === undefined) throw new Error('No company discovery campaign exists');
  return run.id;
}
