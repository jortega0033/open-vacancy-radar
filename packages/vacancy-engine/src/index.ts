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
export { applyFocusedScanCriteria, SOURCE_FILTER_CAPABILITIES, type FocusedScanCriteria } from './global-remote/focused-scan.js';
export {
  assessSalary,
  normalizeSalary,
  parseMinimumAnnualSalary,
  DEFAULT_SALARY_HOURS_PER_WEEK,
  DEFAULT_SALARY_WEEKS_PER_YEAR,
  type SalaryAssessment,
  type SalaryFilterCriteria,
  type SalaryNormalization,
  type SalaryNormalizationMethod,
  type SalaryProvenance,
} from './global-remote/salary.js';
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

/**
 * The work-eligibility evidence model (issue #280). A host process reads
 * `DiscoveryVacancyAudit.eligibility` off a report and needs these types to render it; the
 * assessor and the language extractor are exported alongside so a host can also assess a vacancy
 * it holds outside a full scan without reimplementing either.
 */
export {
  assessWorkEligibility,
  candidateWorkLanguages,
  canonicalLanguageName,
  detectLanguageRequirements,
  detectWorkLocationStatement,
  evidenceFreshness,
  parseCandidateLanguages,
  uncoveredMandatoryLanguages,
  workEligibilityEvidenceSchema,
  EVIDENCE_AGING_MAX_DAYS,
  EVIDENCE_FRESH_MAX_DAYS,
  type EligibilityAnswer,
  type EligibilityEvidence,
  type EmployerRegisterEvidence,
  type EvidenceFreshness,
  type EvidenceScope,
  type EvidenceSource,
  type LanguageObligation,
  type LanguageRequirement,
  type SalaryBasis,
  type SalaryGeographyEvidence,
  type WorkEligibilityEvidence,
  type WorkEligibilityInput,
  type WorkLocationStatement,
} from './eligibility/index.js';
