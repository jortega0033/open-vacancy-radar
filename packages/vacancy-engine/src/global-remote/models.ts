import { z } from 'zod';

import type { WorldwideSponsorMatch } from '../companies/worldwide-sponsor-match.js';
import type { ApplyUrlEvidence, VacancyIdentity } from '../vacancies/identity.js';

export type {
  ApplyUrlEvidence,
  ApplyUrlStatus,
  VacancyIdentity,
  VacancyIdentityKind,
} from '../vacancies/identity.js';
import type { WorkEligibilityEvidence } from '../eligibility/models.js';

const reviewAnswerSchema = z.enum(['yes', 'no', 'uncertain']);

export const globalRemoteSourceSchema = z.object({
  id: z.string().min(1),
  company: z.string().min(1),
  provider: z.enum([
    'ashby',
    'greenhouse',
    'lever',
    'personio',
    'recruitee',
    'rippling',
    'smartrecruiters',
    'successfactors',
    'teamtailor',
    'workable',
    'workday',
    'html',
  ]),
  boardIdentifier: z.string().min(1).nullable(),
  externalId: z.string().min(1),
  expectedTitle: z.string().min(1),
  url: z.url(),
  reviewedAt: z.iso.date(),
  reviewedContentHash: z.string().regex(/^[a-f0-9]{64}$/u).nullable(),
  review: z.object({
    roleFrontendOnly: z.boolean(),
    usMarketRole: reviewAnswerSchema,
    fullyRemote: reviewAnswerSchema,
    outsideUsEligible: reviewAnswerSchema,
    minimumAnnualBaseUsd: z.number().nonnegative().nullable(),
    salaryAppliesOutsideUs: reviewAnswerSchema,
    /**
     * The one language the reviewer recorded as mandatory for this vacancy, or empty for "the
     * posting states none" (issue #280). Empty by default, so a profile written before this field
     * existed still parses and still gates nothing: no language, and therefore no country or
     * market, is assumed on anybody's behalf. A *preferred* language is deliberately not
     * representable here, because a preferred language never gates a vacancy.
     */
    mandatoryLanguage: z.string().default(''),
    notes: z.array(z.string()),
  }),
});
export type GlobalRemoteSource = z.infer<typeof globalRemoteSourceSchema>;

export const globalRemoteConfigSchema = z.object({
  version: z.string().min(1),
  minimumAnnualBaseUsd: z.number().nonnegative().nullable(),
  discovery: z.object({
    /**
     * The single role/keyword query term sent to every discovery source below whose API takes one
     * (`q`/`query`/`category`/`keyword`/`search`). Defaults to empty: no role bias ships by
     * default, and an empty string is omitted from the request entirely rather than sent literally
     * (see each call site) so an unconfigured search returns each source's normal remote-jobs feed
     * unfiltered by role, not zero results.
     */
    roleQuery: z.string().trim().max(200).default(''),
    himalayasQueries: z.array(z.string().min(3)).max(10),
    /** Empty means worldwide/no country filter: the param is omitted from the request entirely. */
    himalayasCountry: z.string().max(30).default(''),
    /** Himalayas' documented employment_type enum, omitted when no focused employment filter maps. */
    himalayasEmploymentType: z.string().max(30).optional(),
    himalayasMaxPagesPerQuery: z.number().int().min(1).max(25),
    jobicyCount: z.number().int().min(1).max(100),
    freehireLimit: z.number().int().min(1).max(100),
    jobOpportunitiesLimit: z.number().int().min(1).max(50),
    remoteLandersMaxPages: z.number().int().min(1).max(10),
    jobgetherMaxPages: z.number().int().min(1).max(10),
    remoteFirstMaxPages: z.number().int().min(1).max(5),
    jobRemotelyMaxPages: z.number().int().min(1).max(10),
    arbeitnowMaxPages: z.number().int().min(1).max(10),
    diceMaxPages: z.number().int().min(1).max(5).default(2),
    remooteRoleTitle: z.string().trim().max(200).default(''),
    /** Empty means worldwide/no country filter: the key is omitted from the request entirely. */
    remooteCountry: z.string().trim().max(100).default(''),
    remooteLimit: z.number().int().min(1).max(10).default(10),
    /** Bounded page budget for AI Dev Jobs; each page is requested at the documented 50-row max. */
    aiDevJobsMaxPages: z.number().int().min(1).max(10).default(2),
    /**
     * Bounded partition budget for Taiwan Jobs: how many of the 22 documented county/city codes
     * (see `TAIWAN_JOBS_CITY_CODES`) are queried per run, each at the documented 1,000-record max.
     * Defaults to all 22 -- every region of Taiwan is covered equally by default, never a subset
     * that would favor some counties/cities over others.
     */
    taiwanJobsMaxCities: z.number().int().min(1).max(22).default(22),
    museEnabled: z.boolean().default(false),
    museMaxPages: z.number().int().min(1).max(10).default(6),
    adzunaAppId: z.string().default(''),
    adzunaAppKey: z.string().default(''),
    adzunaMaxPages: z.number().int().min(1).max(10).default(2),
    joobleApiKey: z.string().default(''),
    reedApiKey: z.string().default(''),
    jobspipeApiKey: z.string().default(''),
    /** Bounded worker pool for the imported ATS company roster scan (see
     * `global-remote/ats-roster-discovery.ts`); each company is one to a few requests, and the
     * roster can hold thousands of entries, so this only bounds how many `listVacancies` calls are
     * in flight at once, on top of the shared HTTP client's own concurrency limits. */
    atsRosterConcurrency: z.number().int().min(1).max(50).default(8),
    /** NAV Arbeidsplassen consumer bearer token (free, self-service registration; see
     * https://arbeidsplassen.nav.no/vilkar-api). Empty means the source stays
     * `configuration_required` and is never called. */
    navArbeidsplassenApiKey: z.string().default(''),
    /** Bounded feed-page walk budget for one run, mirroring `aiDevJobsMaxPages`: this pipeline is a
     * stateless one-shot scan (see `runGlobalRemoteScan`) with no persisted cross-run cursor, so
     * each run re-walks the feed from its first page up to this many pages. */
    navArbeidsplassenMaxPages: z.number().int().min(1).max(10).default(3),
  }),
  officialSources: z.array(globalRemoteSourceSchema),
});
export type GlobalRemoteConfig = z.infer<typeof globalRemoteConfigSchema>;

export const globalRemoteDecisionSchema = z.enum([
  'strict_match',
  'salary_confirmation',
  'location_confirmation',
  'remote_confirmation',
  'company_confirmation',
  'salary_unknown',
  'salary_below_threshold',
  'language_confirmation',
  'excluded_location',
  'excluded_language',
  'excluded_not_remote',
  'excluded_not_us_market',
  'excluded_role',
  'inactive',
  'changed_since_review',
  'blocked',
  'error',
]);
export type GlobalRemoteDecision = z.infer<typeof globalRemoteDecisionSchema>;

export type OfficialSourceState = 'active' | 'inactive' | 'blocked' | 'error';

export type OfficialVacancyAudit = {
  id: string;
  company: string;
  title: string;
  url: string;
  provider: GlobalRemoteSource['provider'];
  state: OfficialSourceState;
  decision: GlobalRemoteDecision;
  reasons: string[];
  evidence: string[];
  minimumAnnualBaseUsd: number | null;
  contentHash: string | null;
  reviewedContentHash: string | null;
  reviewedAt: string;
  requestCount: number;
  httpStatus: number | null;
};

export type DiscoveryDecision =
  | 'official_review_candidate'
  | 'salary_unverified'
  | 'salary_below_threshold'
  | 'location_restricted'
  | 'language_mismatch'
  | 'non_vacancy'
  | 'role_mismatch';

export type DiscoveryProvider =
  | 'himalayas'
  | 'jobicy'
  | 'remotive'
  | 'freehire'
  | 'job_opportunities'
  | 'remote_landers'
  | 'jobgether'
  | 'we_work_remotely'
  | 'remote_first_jobs'
  | 'job_remotely'
  | 'remote_ok'
  | 'arbeitnow'
  | 'startup_jobs'
  | 'devitjobs_nl'
  | 'jobs_collider'
  | 'working_nomads'
  | 'real_work_from_anywhere'
  | 'devitjobs_uk'
  | 'dice'
  | 'remoote'
  | 'ai_dev_jobs'
  | 'taiwan_jobs'
  | 'the_muse'
  | 'jobspresso'
  | 'remote_frontend_jobs'
  | 'un_careers'
  | 'jobtech_sweden'
  | 'workable_global'
  | 'adzuna'
  | 'jooble'
  | 'reed'
  | 'jobspipe'
  | 'ats_roster_greenhouse'
  | 'ats_roster_lever'
  | 'ats_roster_ashby'
  | 'ats_roster_recruitee'
  | 'ats_roster_personio'
  | 'nav_arbeidsplassen';

/** One discovery source's contribution to a (possibly merged) vacancy row -- issue #278. */
export type VacancySourceReference = {
  provider: DiscoveryProvider;
  key: string;
  url: string;
};

export type DiscoveryVacancyAudit = {
  key: string;
  provider: DiscoveryProvider;
  company: string;
  title: string;
  url: string;
  location: string;
  /** Every location string retained when same-identity rows are merged. */
  locations?: string[];
  /** Role-search text retained from every same-identity discovery row. */
  searchableText?: string[];
  /** Employment labels retained from every same-identity discovery row. */
  employmentTypes?: string[];
  employmentType: string | null;
  currency: string | null;
  salaryPeriod: string | null;
  advertisedMinimum: number | null;
  annualizedMinimumUsd: number | null;
  /** Audited comparison fields. Optional for reports written before issue #327. */
  normalizedAnnualMinimum?: number | null;
  normalizedCurrency?: string | null;
  normalizationMethod?: import('./salary.js').SalaryNormalizationMethod;
  assumptionProvenance?: string | null;
  /** Explicit source audit for salary evidence. Missing provenance is never comparable. */
  salaryProvenance?: import('./salary.js').SalaryProvenance;
  salaryProvider?: DiscoveryProvider | null;
  salarySourceKey?: string | null;
  salarySourceUrl?: string | null;
  decision: DiscoveryDecision;
  reasons: string[];
  contentHash: string;
  /** Null where the source's raw response carried no description text at all (not every worldwide
   * feed does), never an empty string standing in for "missing". */
  description: string | null;
  /** Null where the source's raw response carried no posting date at all. Never derived or
   * estimated -- a wrong staleness signal is worse than an honestly absent one. */
  postedAt: string | null;
  /** Null until `applyWorldwideProfileScores` runs after discovery (no candidate profile configured,
   * or the run hasn't scored yet), never a real-looking zero. See `scoreWorldwideVacancy`. */
  profileScore: number | null;
  /**
   * Null until `applyWorldwideSponsorMatches` runs after discovery, and null afterwards too unless
   * this vacancy's `location` normalizes to "Netherlands" *and* a best-effort Wikidata name search
   * found an unambiguous employer whose KVK number is an active IND-recognised sponsor (see
   * `worldwide-sponsor-match.ts`). Never a stand-in for `recognised_sponsor` confidence -- the
   * desktop UI's `worldwideVerification()` reports a non-null value here as `possible_sponsor_match`
   * at most, matching this path's much weaker evidence chain than the Netherlands pipeline's.
   */
  worldwideSponsorMatch: WorldwideSponsorMatch | null;
  /**
   * Evidence-backed yes/no/unknown answers for work country, mandatory language, visa sponsorship
   * and Employer of Record, each carrying its source, scope and freshness, plus the candidate's own
   * relocation willingness kept separate from the employer's relocation offer and a caption for any
   * geographic salary assumption (issue #280). See `eligibility/models.ts`.
   *
   * Null until `applyWorkEligibilityEvidence` runs after discovery, exactly like `profileScore`:
   * a partial row reads as "found, not yet assessed" rather than carrying real-looking answers it
   * was never given. Optional (rather than always present) for the same reason
   * `GlobalRemoteReport.statistics`' sponsor-match counters are: a report persisted by an engine
   * version from before this field existed carries none of it, and reading such a row must not
   * crash.
   */
  eligibility?: WorkEligibilityEvidence | null;
  /**
   * Issue #278: this row's canonical job identity -- requisition, canonical URL, or semantic, in
   * that trust order. Always set by `discoveryAudit()` (`global-remote/discovery-shared.ts`) for a
   * freshly discovered row; optional only so a `latest.json` report written by an engine version
   * from before this field existed still deserializes, matching `eligibility`'s own compatibility
   * reasoning above. `uniqueDiscovery` (`pipeline/global-remote.ts`) never trusts this field
   * directly for grouping -- it recomputes identity from `url`/`company`/`title`/`location`
   * instead, so an old row missing this field still merges correctly.
   */
  identity?: VacancyIdentity;
  /**
   * Issue #278: the exact URL this discovery source returned. Same value as `url`, added purely for
   * explicit source-attribution naming alongside the new `applyUrl` below -- `url` itself is left
   * untouched (still the same raw discovered URL it always was) so every existing reader of `.url`
   * keeps working unchanged.
   */
  sourceUrl?: string;
  /**
   * Issue #278: whether `url` has actually been confirmed to resolve to this exact role, with the
   * evidence behind that answer. A generic careers page, aggregator listing page or search-result
   * snippet can only ever be `unresolved` here, never `verified` -- see `resolveApplyUrl`
   * (`vacancies/identity.ts`). Optional for the same old-report-compatibility reason as `identity`.
   */
  applyUrl?: ApplyUrlEvidence;
  /**
   * Issue #278: every discovery source reference that contributed to this row after
   * `uniqueDiscovery` merged same-identity duplicates -- e.g. an aggregator and an ATS-roster
   * adapter that both resolved to the same requisition. Always at least one entry (this row's own
   * source) for a freshly discovered row; optional for the same old-report-compatibility reason as
   * `identity`.
   */
  sources?: VacancySourceReference[];
};

export type DiscoverySourceAudit = {
  id: string;
  provider: DiscoveryVacancyAudit['provider'];
  url: string;
  /** Logical fetch calls this source's own adapter code issued (one per page/cursor it walked),
   * unchanged in meaning since before issue #279: `SafeHttpClient` may have retried underneath any
   * one of these transparently, which `requests` alone never showed. See `networkAttempts`. */
  requests: number;
  listings: number;
  status: 'success' | 'partial' | 'blocked' | 'error';
  error: string | null;
  /**
   * Actual network attempts `SafeHttpClient` made on this source's behalf, including every bounded
   * retry (429/5xx/timeout) and every redirect hop -- always `>= requests`. Attributed via
   * `discovery-attribution.ts`'s `AsyncLocalStorage`-based wrapper so two sources running
   * concurrently (every `Promise.all` fan-out in this package) never pool into the same counter
   * (issue #279). A source not yet wired through that wrapper reports this equal to `requests`
   * (no retry visibility beyond the logical count, never an undercount).
   */
  networkAttempts: number;
  /**
   * The subset of `networkAttempts` beyond the first attempt of each logical request -- i.e.
   * retries `SafeHttpClient` performed after a 429/5xx/timeout response, whether or not the retry
   * eventually succeeded. A 429 followed by an eventual success is recorded here even though
   * `status` stays `'success'`: observing a retry must never by itself downgrade `status` to
   * `'partial'`, which only ever describes *coverage*, not how many attempts a request needed.
   */
  retries: number;
  /**
   * Whether this source's own coverage claim is definitively complete for this run. Distinct from
   * `status`, which already existed and describes whether the underlying request(s) succeeded: a
   * source can be `status: 'success'` yet `complete: false` (a page walk that hit its configured
   * cap without ever erroring), and a `status` other than `'success'` is always `complete: false`.
   * An empty result set that genuinely reached the end of the source (no cap hit, no error) is
   * `complete: true` with zero `listings` -- "nothing to show" is not the same claim as "did not
   * finish looking".
   */
  complete: boolean;
  /** Set whenever `complete` is false: why this source did not reach the end of its available
   * listings (a configured page/result cap, retries exhausted, a timeout, cancellation, an upstream
   * error, ...). Never inferred by a reader from string-matching `error` -- this is the field meant
   * for that. `null` exactly when `complete` is true. */
  completenessReason: string | null;
  /**
   * Resumable evidence of where a capped or interrupted source stopped, carried through from
   * whatever the adapter already tracks internally (a next-page URL, a next page/offset number, a
   * remaining-partition marker) -- never invented for a source whose contract has no such thing.
   * `null` whenever the source has nothing to resume from, including every `complete: true` row.
   */
  continuationCursor: string | null;
  /** Per-source evidence of which focused criteria were actually sent upstream. */
  focusedScan?: {
    requested: Partial<Record<'role' | 'country' | 'employment' | 'salary', string>>;
    applied: { criterion: import('./focused-scan.js').FocusedCriterion; value: string; parameter: string; valueFormat: 'free_text' | 'exact' | 'enumerated'; pagination: 'filtered_pages' | 'not_applicable'; limitations: string }[];
    deferred: { criterion: import('./focused-scan.js').FocusedCriterion; value: string; normalizedValue: string; reason: string }[];
    unsupported: { criterion: import('./focused-scan.js').FocusedCriterion; value: string; normalizedValue: string; reason: string }[];
  };
};

export type DiscoveryRun = {
  sources: DiscoverySourceAudit[];
  vacancies: DiscoveryVacancyAudit[];
};

/**
 * Fired once per discovery sub-source (and the Workable "all customers" global source) as it
 * resolves inside `runGlobalRemoteScan`'s underlying parallel `Promise.all`s -- see
 * `runGlobalRemoteDiscovery` and `runGlobalRemoteScan` for the exact call sites. `vacancies` is
 * only that one source's own contribution, not a running total: a consumer that wants a growing
 * list accumulates across calls itself (see the desktop app's `SearchPage.tsx`).
 *
 * Never the trigger for scoring or sponsor-matching, which still only run once, after every source
 * has finished discovering -- a listener always sees a source's raw discovery rows exactly as fresh
 * discovery produced them, with `profileScore: null` and `worldwideSponsorMatch: null`, before
 * either enrichment step has had a chance to touch them. That is intentional, not a bug: partial
 * rows are meant to read as "found, not yet scored", never as a real-looking (and possibly wrong)
 * score or sponsor match.
 */
export type ScanProgressEvent = {
  sourceId: string;
  vacancies: DiscoveryVacancyAudit[];
};

export type ScanProgressCallback = (event: ScanProgressEvent) => void;

export type SourceRegistryState =
  | 'active'
  | 'configuration_required'
  | 'partner_required'
  | 'manual_only'
  | 'blocked'
  | 'prohibited';

export type SourceIngestionMode = 'full_ingestion' | 'linked_index' | 'disabled';

export type SourceRegistryEntry = {
  id: string;
  name: string;
  url: string;
  transport: 'api' | 'rss' | 'mcp' | 'structured' | 'none';
  state: SourceRegistryState;
  ingestionMode: SourceIngestionMode;
  provider: DiscoveryProvider | null;
  adapter: 'active' | 'ready' | 'none';
  reason: string;
};

export type GlobalRemoteReport = {
  runId: string;
  generatedAt: string;
  profileVersion: string;
  scanBounds?: {
    mode: 'focused' | 'browse_all';
    resultCap: number | null;
    resultCountBeforeCap: number;
    complete: boolean;
    completenessReason: string | null;
  };
  criteria: {
    role: string;
    fullyRemote: true;
    applicantLocation: string;
    usCitizenshipRequired: false;
    minimumAnnualBaseUsd: number | null;
    currency: 'USD';
    salary?: {
      minimumAnnual: number | null;
      currency: string;
      includeUnknown: boolean;
    };
  };
  statistics: {
    discoveryRequests: number;
    discoveryListings: number;
    discoveryUniqueListings: number;
    discoveryOfficialReviewCandidates: number;
    officialBoardsOrPagesAttempted: number;
    officialRequests: number;
    strictMatches: number;
    manualReview: number;
    nearMisses: number;
    excludedOrInactive: number;
    blockedOrErrored: number;
    registrySources: number;
    activeRegistrySources: number;
    gatedRegistrySources: number;
    manualOrProhibitedRegistrySources: number;
    /**
     * The best-effort IND sponsor cross-check's own coverage for this run, in the same spirit as
     * `discoverySources`' per-source request/listing counts: a bounded enrichment has to report
     * what it did *not* reach, not just what it found. See `applyWorldwideSponsorMatches`.
     *
     * Optional only because a report persisted by an engine version from before that check was
     * bounded carries none of these fields; a run of this engine always writes all five.
     */
    sponsorMatchEligibleRows?: number;
    sponsorMatchEligibleCompanies?: number;
    /** Resolved for this report, whether from an earlier scan's persisted lookup or freshly. */
    sponsorMatchResolvedCompanies?: number;
    /** The subset of the above that cost this run a Wikidata request. */
    sponsorMatchLookedUpCompanies?: number;
    sponsorMatchUnverifiedCompanies?: number;
    /**
     * Sums of `DiscoverySourceAudit.networkAttempts`/`.retries` across every discovery source this
     * run made (issue #279) -- `discoveryRetries` is always `<= discoveryNetworkAttempts -
     * discoveryRequests` and is zero whenever no source needed a bounded retry. Optional for the
     * same reason `sponsorMatchEligibleRows` above is: a report persisted by an engine version from
     * before issue #279 carries none of these three fields. Every run of this engine writes all
     * three together.
     */
    discoveryNetworkAttempts?: number;
    discoveryRetries?: number;
    /**
     * Total vacancy rows emitted across every `ScanProgressEvent` this run fired (issue #252's
     * streaming rows), before final dedup/confirmation -- a purely additive count of what a
     * listener was shown provisionally, never deduplicated against `discoveryUniqueListings` and
     * never itself added into it. The two counts can overlap (the same row is normally shown
     * provisionally and then also appears in the final `discoveryAudit`) without either counter
     * double-counting that row, because each is computed independently: this one by summing what
     * `onProgress` was called with as it happened, `discoveryUniqueListings` by deduplicating the
     * final merged result once, after every source finished. Zero on every run with no `onProgress`
     * listener attached (`officialOnly`/`offlineReclassify` reruns included, since those make no
     * new discovery requests either).
     */
    discoveryProgressiveRowsEmitted?: number;
    rawRowsFetched?: number;
    focusedMatches?: number;
    focusedUnknownEmployment?: number;
    focusedEmploymentMismatches?: number;
    focusedSalaryComparable?: number;
    focusedSalaryUnknown?: number;
    focusedSalaryBelowMinimum?: number;
  };
  sourceRegistry: SourceRegistryEntry[];
  discoverySources: DiscoverySourceAudit[];
  strictMatches: OfficialVacancyAudit[];
  manualReview: OfficialVacancyAudit[];
  nearMisses: OfficialVacancyAudit[];
  excludedOrInactive: OfficialVacancyAudit[];
  blockedOrErrored: OfficialVacancyAudit[];
  officialAudit: OfficialVacancyAudit[];
  discoveryAudit: DiscoveryVacancyAudit[];
  methodology: string[];
  attribution: { name: string; url: string }[];
};

export type FailureCategory =
  | 'unsupported_ats'
  | 'blocked'
  | 'malformed'
  | 'empty'
  | 'transient';

export type GapRecord = {
  timestamp: string;
  category: FailureCategory;
  detectedProvider: string | null;
  redactedUrl: string;
  httpStatus: number | null;
  failureReason: string;
};

export type GapTelemetryReport = {
  generatedAt: string;
  totalRecords: number;
  records: GapRecord[];
  aggregatedByProvider: Record<string, number>;
  aggregatedByCategory: Record<FailureCategory, number>;
};
