import { z } from 'zod';

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
    museEnabled: z.boolean().default(false),
    museMaxPages: z.number().int().min(1).max(10).default(6),
    adzunaAppId: z.string().default(''),
    adzunaAppKey: z.string().default(''),
    adzunaMaxPages: z.number().int().min(1).max(10).default(2),
    joobleApiKey: z.string().default(''),
    reedApiKey: z.string().default(''),
    jobspipeApiKey: z.string().default(''),
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
  | 'the_muse'
  | 'jobspresso'
  | 'remote_frontend_jobs'
  | 'un_careers'
  | 'jobtech_sweden'
  | 'workable_global'
  | 'adzuna'
  | 'jooble'
  | 'reed'
  | 'jobspipe';

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
