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
  runGlobalRemoteScan,
  type GlobalRemoteScanOptions,
  type GlobalRemoteScanResult,
} from './pipeline/global-remote.js';
export { readGlobalRemoteReport } from './global-remote/report.js';
export {
  generateGapReportHtml,
  generateGapReportText,
} from './global-remote/gap-report.js';
export {
  aggregateGapRecords,
  classifyFailure,
  detectAtsProviderFromError,
  loadGapRecords,
  recordDiscoveryGapTelemetry,
  redactUrl,
  recordFromSourceAudit,
} from './global-remote/source-gap-telemetry.js';
export { runSponsorSync } from './pipeline/sponsors.js';
export {
  candidateProfileSchema,
  isCandidateProfileConfigured,
  loadCandidateProfile,
  type CandidateProfile,
} from './candidate/profile.js';

/**
 * The ATS-roster import step (issue #251/#264): re-runnable on a deliberate refresh cadence, never
 * invoked automatically at scan time (see `pipeline/ats-roster-import.ts`'s own doc comment). A host
 * process (the desktop app's main process, today) is the one place this can be triggered from
 * outside the CLI; `readAtsRosterStatus` lets that same host show an honest "last refreshed" status
 * without loading the full roster across an IPC boundary.
 */
export {
  runAtsRosterImport,
  type AtsRosterImportResult,
  type AtsRosterProviderImportResult,
} from './pipeline/ats-roster-import.js';
export {
  readAtsRosterStatus,
  type AtsRosterStatus,
} from './companies/ats-roster-repository.js';

export type {
  GlobalRemoteReport,
  DiscoveryProvider,
  DiscoveryVacancyAudit,
  OfficialVacancyAudit,
  ScanProgressEvent,
  ScanProgressCallback,
  GapTelemetryReport,
} from './global-remote/models.js';
export {
  descriptionShingleSimilarity,
  findCrossCompanyDuplicateGroups,
  CROSS_COMPANY_DUPLICATE_VERSION,
  CROSS_COMPANY_MINIMUM_DESCRIPTION_TOKENS,
  CROSS_COMPANY_MINIMUM_SUBSTANTIVE_DESCRIPTION_TOKENS,
  CROSS_COMPANY_SHINGLE_LENGTH,
  CROSS_COMPANY_SHINGLE_SIMILARITY_THRESHOLD,
  type CrossCompanyDuplicateCandidate,
  type CrossCompanyDuplicateGroup,
} from './reporting/cross-company-duplicates.js';

export { ALL_COUNTRIES, normalizeCountry, UNSPECIFIED_LOCATION } from './geo/countries.js';
