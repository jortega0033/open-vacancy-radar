import 'dotenv/config';

import type { Logger } from 'pino';

import { loadConfig } from './config.js';
import {
  MAX_WORKDAY_BACKFILL_BATCH_SIZE,
  runWorkdayEvidenceBackfill,
} from './companies/workday-backfill.js';
import {
  createScanLock,
  SCAN_ADVISORY_LOCK,
  withScanAdvisoryTryLock,
  type ScanLock,
} from './db/advisory-lock.js';
import { createDatabaseClient, migrateDatabase } from './db/client.js';
import { atsProviderSchema } from './domain/models.js';
import { createLogger } from './logger.js';
import {
  getCompanyDiscoveryStatus,
  runCompanyDiscoveryInspection,
  seedCompanyDiscoveryInventory,
} from './pipeline/company-discovery.js';
import {
  getLatestCompanyCampaignRunId,
  runFullCompanyCampaign,
} from './pipeline/company-campaign.js';
import { runCompanyDomainEnrichment } from './pipeline/company-domain-enrichment.js';
import { runCompanyDomainSearch } from './pipeline/company-domain-search.js';
import { getCompanyDiscoveryCampaignProgress } from './companies/discovery-campaign-repository.js';
import { writeCompanyDiscoveryCampaignExport } from './companies/discovery-campaign-export.js';
import { runCompanyMappingSync } from './pipeline/companies.js';
import { runEndToEndScan, runVacancyScanCommand } from './pipeline/full-scan.js';
import { runGlobalRemoteScan } from './pipeline/global-remote.js';
import { runSponsorSync } from './pipeline/sponsors.js';
import { MAX_SCOPED_VACANCY_SCAN_SOURCES } from './pipeline/vacancies.js';
import { generateJobRadarReport } from './reporting/repository.js';
import { runPersistedDeterministicScoring } from './scoring/index.js';

function boundedIntegerArgument(
  value: string | undefined,
  fallback: number,
  maximum: number,
  label: string,
): number {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > maximum) {
    throw new RangeError(`${label} must be an integer from 1 through ${maximum}`);
  }
  return parsed;
}

async function runExclusiveCommand(
  scanLock: ScanLock,
  logger: Logger,
  command: string,
  operation: () => Promise<void>,
): Promise<void> {
  const outcome = await withScanAdvisoryTryLock(scanLock, operation);
  if (!outcome.acquired) {
    logger.warn(
      { command, lock: SCAN_ADVISORY_LOCK },
      'Command skipped because a scan-sensitive operation is already running',
    );
    throw new Error(`Command ${command} did not run because the scan lock is held`);
  }
}

async function main(): Promise<void> {
  const command = process.argv[2];
  const config = loadConfig();
  const logger = createLogger(config);
  const database = createDatabaseClient(config.databasePath);
  const scanLock = createScanLock(config.databasePath);

  try {
    switch (command) {
      case 'db:migrate':
        await runExclusiveCommand(scanLock, logger, command, async () => {
          await migrateDatabase(database.db);
          logger.info('Database migrations applied');
        });
        break;
      case 'sponsors:sync':
        await runExclusiveCommand(scanLock, logger, command, async () => {
          await runSponsorSync(database.db, config, logger);
        });
        break;
      case 'companies:discover':
        await runExclusiveCommand(scanLock, logger, command, async () => {
          await runCompanyMappingSync(database.db, logger);
        });
        break;
      case 'companies:discovery:seed':
        await runExclusiveCommand(scanLock, logger, command, async () => {
          const result = await seedCompanyDiscoveryInventory(database.db);
          logger.info(result, 'Company discovery inventory seeded from trusted candidates');
        });
        break;
      case 'companies:discovery:run':
        await runExclusiveCommand(scanLock, logger, command, async () => {
          const result = await runCompanyDiscoveryInspection(database.db, config, logger);
          logger.info(result, 'Bounded official company-site discovery run completed');
        });
        break;
      case 'companies:discovery:status': {
        const coverage = await getCompanyDiscoveryStatus(database.db);
        const total = coverage.reduce((sum, row) => sum + row.count, 0);
        logger.info({ total, coverage }, 'Company discovery coverage loaded');
        break;
      }
      case 'companies:workday:backfill':
        await runExclusiveCommand(scanLock, logger, command, async () => {
          const limit = boundedIntegerArgument(
            process.argv[3],
            MAX_WORKDAY_BACKFILL_BATCH_SIZE,
            MAX_WORKDAY_BACKFILL_BATCH_SIZE,
            'Workday backfill limit',
          );
          const result = await runWorkdayEvidenceBackfill(database.db, logger, { limit });
          logger.info(
            {
              scanRunId: result.scanRunId,
              ...result.reclassification,
              promotionExamined: result.promotion.examined,
              promoted: result.promotion.promoted,
              promotionErrors: result.promotion.errors,
            },
            'Preserved Workday evidence reclassified and promoted without network access',
          );
        });
        break;
      case 'companies:domains:enrich':
        await runExclusiveCommand(scanLock, logger, command, async () => {
          const result = await runCompanyDomainEnrichment(database.db, config, logger);
          logger.info(
            {
              activeSponsors: result.activeSponsors,
              candidates: result.candidatesGenerated,
              manualReview: result.ambiguous,
              noStructuredMatch: result.notFound,
              missingKvk: result.missingKvk,
              catalogPath: result.catalogPath,
            },
            'Company domain enrichment command completed',
          );
        });
        break;
      case 'companies:domains:search':
        await runExclusiveCommand(scanLock, logger, command, async () => {
          const result = await runCompanyDomainSearch(database.db, config, logger);
          logger.info(
            {
              attempted: result.attempted,
              candidateHigh: result.candidateHigh,
              candidateManual: result.candidateManual,
              notFound: result.notFound,
              blocked: result.blocked,
              errors: result.errors,
              physicalRequests: result.physicalRequests,
              catalogPath: result.catalogPath,
              audit: result.latestAudit,
            },
            'Bounded resumable employer-domain search completed',
          );
        });
        break;
      case 'companies:campaign:run':
        await runExclusiveCommand(scanLock, logger, command, async () => {
          const result = await runFullCompanyCampaign(database.db, config, logger);
          logger.info(
            {
              campaignRunId: result.campaignRunId,
              expectedSponsors: result.expectedSponsors,
              resumed: result.resumed,
              candidates: result.domainEnrichment?.candidatesGenerated ?? 0,
              searchedDomains: result.domainSearch?.attempted ?? 0,
              searchedDomainCandidates:
                (result.domainSearch?.candidateHigh ?? 0) + (result.domainSearch?.candidateManual ?? 0),
              inspectionRequests: result.inspectionRequests,
              promotedSources: result.promotedSources,
              vacancyScanRunId: result.vacancyScanRunId,
              vacanciesDiscovered: result.vacancyScan.vacanciesDiscovered,
              relevantVacanciesComputed: result.scoring.relevantComputed,
              latestReport: result.reportFiles.latestHtml,
              campaignLog: result.campaignExport.files.ndjson,
            },
            'Full 12k-company campaign completed',
          );
        });
        break;
      case 'companies:campaign:status': {
        const campaignRunId = process.argv[3] ?? await getLatestCompanyCampaignRunId(database.db);
        const progress = await getCompanyDiscoveryCampaignProgress(database.db, campaignRunId);
        logger.info(progress, 'Company campaign progress loaded');
        break;
      }
      case 'companies:campaign:export':
        await runExclusiveCommand(scanLock, logger, command, async () => {
          const campaignRunId = process.argv[3] ?? await getLatestCompanyCampaignRunId(database.db);
          const result = await writeCompanyDiscoveryCampaignExport(database.db, campaignRunId);
          logger.info(
            { campaignRunId, exportedRows: result.exportedRows, ...result.files },
            'Company campaign audit files exported',
          );
        });
        break;
      case 'global-remote:scan':
        await runExclusiveCommand(scanLock, logger, command, async () => {
          const result = await runGlobalRemoteScan(database.db, config, logger, process.cwd(), {
            officialOnly: process.argv.includes('--official-only'),
            offlineReclassify: process.argv.includes('--offline-reclassify'),
          });
          logger.info(
            {
              runId: result.report.runId,
              discoveryListings: result.report.statistics.discoveryUniqueListings,
              strictMatches: result.report.statistics.strictMatches,
              manualReview: result.report.statistics.manualReview,
              nearMisses: result.report.statistics.nearMisses,
              latestHtml: result.files.latestHtml,
              latestAudit: result.files.latestAudit,
            },
            'Worldwide / Remote frontend scan completed',
          );
        });
        break;
      case 'vacancies:scan': {
        const result = await runVacancyScanCommand(
          database.db,
          config,
          logger,
          scanLock,
        );
        if (result.status === 'completed') {
          logger.info(
            { scanRunId: result.scanRunId, ...result.vacancyScan },
            'Vacancy retrieval command completed',
          );
        } else {
          throw new Error('Command vacancies:scan did not run because the scan lock is held');
        }
        break;
      }
      case 'vacancies:provider:scan': {
        const provider = atsProviderSchema.parse(process.argv[3]);
        const careerSourceIds = process.argv.slice(4);
        if (careerSourceIds.length > MAX_SCOPED_VACANCY_SCAN_SOURCES) {
          throw new RangeError(
            `Provider scan cannot contain more than ${MAX_SCOPED_VACANCY_SCAN_SOURCES} source ids`,
          );
        }
        const limit = careerSourceIds.length === 0
          ? MAX_SCOPED_VACANCY_SCAN_SOURCES
          : careerSourceIds.length;
        const result = await runVacancyScanCommand(
          database.db,
          config,
          logger,
          scanLock,
          {
            command,
            scope: {
              provider,
              limit,
              ...(careerSourceIds.length === 0 ? {} : { careerSourceIds }),
            },
          },
        );
        if (result.status === 'completed') {
          logger.info(
            {
              scanRunId: result.scanRunId,
              provider,
              careerSourceIds,
              ...result.vacancyScan,
            },
            'Bounded provider vacancy scan completed',
          );
        } else {
          throw new Error('Command vacancies:provider:scan did not run because the scan lock is held');
        }
        break;
      }
      case 'vacancies:workday:pilot': {
        const limit = boundedIntegerArgument(
          process.argv[3],
          MAX_SCOPED_VACANCY_SCAN_SOURCES,
          MAX_SCOPED_VACANCY_SCAN_SOURCES,
          'Workday pilot limit',
        );
        const careerSourceIds = process.argv.slice(4);
        const result = await runVacancyScanCommand(
          database.db,
          config,
          logger,
          scanLock,
          {
            command,
            scope: {
              provider: 'workday',
              limit,
              ...(careerSourceIds.length === 0 ? {} : { careerSourceIds }),
            },
          },
        );
        if (result.status === 'completed') {
          logger.info(
            {
              scanRunId: result.scanRunId,
              provider: 'workday',
              limit,
              careerSourceIds,
              ...result.vacancyScan,
            },
            'Bounded Workday vacancy pilot completed',
          );
        } else {
          throw new Error('Command vacancies:workday:pilot did not run because the scan lock is held');
        }
        break;
      }
      case 'vacancies:score': {
        await runExclusiveCommand(scanLock, logger, command, async () => {
          const result = await runPersistedDeterministicScoring(database.db);
          logger.info(result, 'Deterministic vacancy scoring completed');
        });
        break;
      }
      case 'report': {
        await runExclusiveCommand(scanLock, logger, command, async () => {
          const result = await generateJobRadarReport(database.db, {
            minimumScore: config.reportMinScore,
            maximumPostingAgeDays: config.maxPostingAgeDays,
          });
          logger.info(
            {
              runId: result.report.runId,
              relevantVacancies: result.report.statistics.relevantVacancies,
              latestHtml: result.files.latestHtml,
              latestJson: result.files.latestJson,
            },
            'Job Radar report generated',
          );
        });
        break;
      }
      case 'scan': {
        const result = await runEndToEndScan(database.db, config, logger, scanLock);
        if (result.status === 'skipped') {
          throw new Error('Command scan did not run because the scan lock is held');
        }
        break;
      }
      default:
        throw new Error(
          `Unknown command: ${command ?? '(missing)'}. Available: db:migrate, sponsors:sync, companies:discover, companies:discovery:seed, companies:discovery:run, companies:discovery:status, companies:workday:backfill, companies:domains:enrich, companies:domains:search, companies:campaign:run, companies:campaign:status, companies:campaign:export, global-remote:scan, vacancies:scan, vacancies:provider:scan, vacancies:workday:pilot, vacancies:score, report, scan`,
        );
    }
  } finally {
    database.close();
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`Open Vacancy Radar failed: ${message}\n`);
  process.exitCode = 1;
});
