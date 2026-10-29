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
  resolveFocusedLeads,
  runGlobalRemoteScan,
  ScanCancelledError,
  isScanCancelledError,
  awaitAiWebDiscoveryJoin,
  type AiWebDiscoveryJoinResult,
  type GlobalRemoteScanOptions,
  type GlobalRemoteScanResult,
} from './pipeline/global-remote.js';
// Canonical job identity (#278), so a host can recognise two source copies of one requisition (#688).
export { vacancyIdentityFor, type VacancyIdentity, type VacancyIdentityKind } from './vacancies/identity.js';
export { readGlobalRemoteReport, readGlobalRemoteReportWithFallback, type LoadedGlobalRemoteReport } from './global-remote/report.js';
export { createDatabaseBackedAtsHttpClient } from './pipeline/ats-http-client.js';
export { AtsResponseError, type AtsHttpClient, type AtsHttpRequestOptions, type AtsHttpResponse } from './ats/http.js';
export { CrawlerHttpError, isCrawlerHttpError } from './crawler/errors.js';
export {
  DEFAULT_ATS_SOURCE_SCOUT_LIMITS,
  emptyAtsSourceScoutCounters,
  resolveAtsSourceScoutLimits,
  runAtsSourceScout,
  scoutExplorationQuota,
  type AtsSourceScoutCounters,
  type AtsSourceScoutLimits,
  type AtsSourceScoutOptions,
  type AtsSourceScoutResult,
  type AtsSourceScoutStopReason,
} from './global-remote/ats-source-scout.js';
export {
  fetchJobgetherOfferDetail,
  fetchWorkableJobDetail,
  jobgetherOfferIdFromUrl,
  workableJobReferenceFromUrl,
  type JobgetherOfferDetail,
  type WorkableJobDetail,
  type WorkableJobReference,
} from './global-remote/structured-discovery.js';
export {
  comparePostingText,
  createPostingVerifier,
  normalizePostingText,
  observePosting,
  parseStatedDeadline,
  postingContentHash,
  POSTING_FRESHNESS_WINDOW_MS,
  POSTING_MARKUP_BUDGET,
  POSTING_REQUEST_ENVELOPE,
  POSTING_TEXT_MAX_CHARS,
  PostingCheckDeadline,
  POSTING_UNABLE_RETRY_AFTER_MS,
  POSTING_VERIFY_TIMEOUT_MS,
  resolvePostingProbe,
  type PostingChangeKind,
  type PostingDeadline,
  type PostingObservation,
  type PostingObservationOutcome,
  type PostingObservationReason,
  type PostingProbe,
  type PostingSource,
  type PostingTextComparison,
  type PostingValidators,
  type PostingVerifier,
  type PostingVerifyInput,
} from './verification/posting-verification.js';
export { applyFocusedScanCriteria, isUnspecifiedCountry, SOURCE_FILTER_CAPABILITIES, vacancyMatchesRole, vacancyTitleMatches, planQueryMatchField, type FocusedScanCriteria } from './global-remote/focused-scan.js';
export {
  addSearchPlanSuggestions,
  approveSearchPlanDraft,
  backupUnreadableSearchPlan,
  isSearchableTitle,
  isSearchPlanReadError,
  parseSearchPlanDraft,
  SearchPlanReadError,
  SearchPlanValidationError,
  searchPlanVariantId,
  type SearchPlanReadFailure,
  captureSearchPlanSnapshot,
  dismissSearchPlanSuggestion,
  EMPTY_SEARCH_PLAN,
  isSearchPlanUsable,
  loadSearchPlan,
  normalizeSearchPlanDraft,
  SEARCH_PLAN_MAX_MARKETS,
  SEARCH_PLAN_MAX_VARIANTS,
  searchPlanDraftSchema,
  searchPlanSchema,
  searchPlanVariantKey,
  writeSearchPlan,
  type SearchPlan,
  type SearchPlanDraft,
  type SearchPlanSnapshot,
  type SearchPlanSuggestion,
  type SearchPlanVariant,
  type SearchPlanVariantOrigin,
} from './candidate/search-plan.js';
export {
  compileSearchPlanQueries,
  DEFAULT_SEARCH_PLAN_ENVELOPE,
  finalizeLeadProvenance,
  LITERAL_QUERY_ID,
  OUTSIDE_ENVELOPE_PROVIDERS,
  roleFilteredProviders,
  runSearchPlan,
  SEARCH_PLAN_BUDGET_SCOPE,
  SEARCH_PLAN_PASS_PROVIDERS,
  searchPlanCriteria,
  searchPlanCriteriaForSource,
  searchPlanHandlingForSource,
  type SearchPlanRunInput,
  type SearchPlanRunResult,
} from './global-remote/search-plan.js';
export {
  admitSearchPlanAttempt,
  isSearchPlanBudgetError,
  SearchPlanBudgetError,
  SearchPlanLedger,
  SearchPlanTransportError,
  type SearchPlanRefusal,
} from './global-remote/search-plan-ledger.js';
export {
  AiWebDiscoveryCandidateSchema,
  AiWebDiscoveryResponseSchema,
  isBlockedDiscoveryDomain,
  normalizeAiWebDiscoveryCandidates,
  type AiWebDiscoveryCandidate,
  type AiWebDiscoveryResponse,
} from './global-remote/ai-web-discovery.js';
export {
  globalRemoteSourceRegistry,
  prohibitedOrBlockedSourceRegistryEntries,
} from './global-remote/source-registry.js';
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
  EMPTY_CANDIDATE_PROFILE,
  isCandidateProfileConfigured,
  loadCandidateProfile,
  type CandidateProfile,
  type ProfileFieldSource,
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
  loadAtsRoster,
  readAtsRosterStatus,
  type AtsRosterStatus,
} from './companies/ats-roster-repository.js';
export {
  atsSourceObservationFilePath,
  loadAtsSourceObservations,
  parseAtsSourceObservationImport,
  planAtsRosterScan,
  type AtsRosterScanPlan,
  type AtsSourceFailureCategory,
  type AtsSourceObservation,
  type AtsSourceObservationFile,
} from './companies/ats-source-observation-repository.js';
export {
  runAtsSourceObservationImport,
  type AtsSourceObservationImportResult,
} from './pipeline/ats-source-observation-import.js';

export type {
  AiSearchIntentCriterion,
  AiSearchIntentProvenance,
  AiSearchIntentPushdown,
  GlobalRemoteReport,
  DiscoveryProvider,
  DiscoverySourceAudit,
  DiscoveryVacancyAudit,
  LeadQueryProvenance,
  OfficialVacancyAudit,
  ProfileMatchBreakdown,
  SearchPlanCriterionTreatment,
  SearchPlanEnvelope,
  SearchPlanHandling,
  SearchPlanRunStatus,
  SearchPlanVariantResult,
  SearchPlanQueryRef,
  SearchPlanReport,
  SearchPlanSourceHandling,
  ScanProgressEvent,
  ScanProgressCallback,
  SourceRegistryEntry,
  GapTelemetryReport,
} from './global-remote/models.js';
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
export { SCAN_PROGRESS_SOURCE_IDS } from './global-remote/discovery.js';
