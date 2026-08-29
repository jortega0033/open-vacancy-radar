import { z } from 'zod';

const reviewAnswerSchema = z.enum(['yes', 'no', 'uncertain']);

export const globalRemoteSourceSchema = z.object({
  id: z.string().min(1),
  company: z.string().min(1),
  provider: z.enum(['ashby', 'greenhouse', 'lever', 'recruitee', 'html']),
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
  minimumAnnualBaseUsd: z.number().positive(),
  discovery: z.object({
    himalayasQueries: z.array(z.string().min(3)).min(1).max(10),
    himalayasCountry: z.string().min(2).max(30),
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
  | 'the_muse'
  | 'jobspresso'
  | 'remote_frontend_jobs'
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

export type SourceRegistryEntry = {
  id: string;
  name: string;
  url: string;
  transport: 'api' | 'rss' | 'mcp' | 'structured' | 'none';
  state: SourceRegistryState;
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
    minimumAnnualBaseUsd: number;
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
