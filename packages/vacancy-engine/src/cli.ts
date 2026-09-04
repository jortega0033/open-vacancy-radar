import 'dotenv/config';

import type { Logger } from 'pino';

import { loadConfig } from './config.js';
import {
  createScanLock,
  SCAN_ADVISORY_LOCK,
  withScanAdvisoryTryLock,
  type ScanLock,
} from './db/advisory-lock.js';
import { createDatabaseClient, migrateDatabase } from './db/client.js';
import { createLogger } from './logger.js';
import { runGlobalRemoteScan } from './pipeline/global-remote.js';
import { runSponsorSync } from './pipeline/sponsors.js';

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
            'Global remote frontend scan completed',
          );
        });
        break;
      default:
        throw new Error(
          `Unknown command: ${command ?? '(missing)'}. Available: db:migrate, sponsors:sync, global-remote:scan`,
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
