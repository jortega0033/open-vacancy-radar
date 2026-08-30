/**
 * Public programmatic API surface for embedding this engine in a host process (e.g. Electron's
 * main process) instead of invoking it as a CLI. Re-exports only what a host needs to migrate its
 * database, run a scan, and read back a report, never `process.exit`/argv-parsing concerns, which
 * stay in cli.ts and would be wrong to carry into a long-lived host process.
 */
export { loadConfig, type AppConfig } from './config.js';
export { createLogger } from './logger.js';
export { createDatabaseClient, migrateDatabase, type Database, type DatabaseClient } from './db/client.js';
export { createScanLock, withScanAdvisoryTryLock, type ScanLock } from './db/advisory-lock.js';

export {
  runEndToEndScan,
  type EndToEndScanCommandResult,
  type EndToEndScanOptions,
} from './pipeline/full-scan.js';
export { runGlobalRemoteScan, type GlobalRemoteScanResult } from './pipeline/global-remote.js';
export { runSponsorSync } from './pipeline/sponsors.js';
export { runPersistedDeterministicScoring } from './scoring/index.js';
export { generateJobRadarReport } from './reporting/repository.js';

export type { GlobalRemoteReport, DiscoveryVacancyAudit, OfficialVacancyAudit } from './global-remote/models.js';
export type { JobRadarReport, ReportVacancy } from './reporting/report.js';
