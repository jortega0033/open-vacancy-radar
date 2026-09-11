import { z } from 'zod';

import type { WorldwideSponsorMatch } from '../companies/worldwide-sponsor-match.js';

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
  'excluded_location',
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

export type DiscoveryVacancyAudit = {
  key: string;
  provider: DiscoveryProvider;
  company: string;
  title: string;
  url: string;
  location: string;
  employmentType: string | null;
  currency: string | null;
  salaryPeriod: string | null;
  advertisedMinimum: number | null;
  annualizedMinimumUsd: number | null;
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
};

export type DiscoverySourceAudit = {
  id: string;
  provider: DiscoveryVacancyAudit['provider'];
  url: string;
  requests: number;
  listings: number;
  status: 'success' | 'partial' | 'blocked' | 'error';
  error: string | null;
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
  criteria: {
    role: string;
    fullyRemote: true;
    applicantLocation: string;
    usCitizenshipRequired: false;
    minimumAnnualBaseUsd: number | null;
    currency: 'USD';
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
