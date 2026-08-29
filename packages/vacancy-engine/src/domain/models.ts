import { z } from 'zod';

export const atsProviderSchema = z.enum([
  'ashby',
  'greenhouse',
  'lever',
  'recruitee',
  'teamtailor',
  'smartrecruiters',
  'personio',
  'workday',
  'successfactors',
  'json_ld',
  'html',
  'unknown',
]);
export type AtsProvider = z.infer<typeof atsProviderSchema>;

export const mappingConfidenceSchema = z.enum(['high', 'medium', 'low', 'unknown']);
export type MappingConfidence = z.infer<typeof mappingConfidenceSchema>;

export const workplaceModeSchema = z.enum(['remote', 'hybrid', 'onsite', 'unknown']);
export type WorkplaceMode = z.infer<typeof workplaceModeSchema>;

export const normalizedVacancySchema = z.object({
  externalId: z.string().min(1).max(500),
  title: z.string().trim().min(1).max(500),
  description: z.string().trim().min(1),
  location: z.string().trim().min(1).nullable(),
  remote: z.boolean().nullable(),
  workplaceMode: workplaceModeSchema.default('unknown'),
  url: z.url().refine((value) => {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol) && url.username === '' && url.password === '';
  }, {
    message: 'Vacancy URLs must use HTTP or HTTPS and must not contain credentials',
  }),
  postedAt: z.date().nullable(),
  employmentType: z.string().trim().min(1).nullable(),
  source: z.string().min(1),
});
export type NormalizedVacancy = z.infer<typeof normalizedVacancySchema>;
export type NormalizedVacancyInput = z.input<typeof normalizedVacancySchema>;

export type CareerSourceDescriptor = {
  id: string;
  companyId: string;
  companyName: string;
  provider: AtsProvider;
  baseUrl: string;
  boardIdentifier: string | null;
  /** Explicit review assertion; omitted/false keeps fallback discovery non-authoritative. */
  lifecycleAuthoritative?: boolean;
};

export type AdapterResult = {
  vacancies: NormalizedVacancy[];
  complete: boolean;
  requestCount: number;
  invalidCount: number;
};

export type VacancyAdapter = {
  readonly provider: AtsProvider;
  supports(source: CareerSourceDescriptor): boolean;
  listVacancies(source: CareerSourceDescriptor): Promise<AdapterResult>;
};

export const deterministicScoreSchema = z.object({
  relevant: z.boolean(),
  deterministicScore: z.number().int().min(0).max(100),
  technicalFit: z.number().int().min(0).max(100),
  roleFit: z.number().int().min(0).max(100),
  seniorityFit: z.number().int().min(0).max(100),
  languageFit: z.number().int().min(0).max(100),
  locationFit: z.number().int().min(0).max(100),
  dutchRequired: z.boolean(),
  dutchPreferred: z.boolean(),
  languageEvidence: z.array(z.string()),
  primaryFit: z.string(),
  matchingSkills: z.array(z.string()),
  gaps: z.array(z.string()),
  reasons: z.array(z.string()),
});
export type DeterministicScore = z.infer<typeof deterministicScoreSchema>;

export const semanticScoreSchema = z.object({
  relevant: z.boolean(),
  score: z.number().int().min(0).max(100),
  technicalFit: z.number().int().min(0).max(100),
  seniorityFit: z.number().int().min(0).max(100),
  languageFit: z.number().int().min(0).max(100),
  locationFit: z.number().int().min(0).max(100),
  dutchRequired: z.boolean(),
  primaryFit: z.string(),
  matchingSkills: z.array(z.string()),
  gaps: z.array(z.string()),
  reasons: z.array(z.string()),
}).strict();
export type SemanticScore = z.infer<typeof semanticScoreSchema>;

export const scanErrorCategorySchema = z.enum([
  'network_error',
  'timeout',
  'blocked',
  'parse_error',
  'unsupported_ats',
  'invalid_vacancy',
  'company_mapping_error',
  'semantic_score_error',
  'rate_limited',
  'unsafe_url',
  'http_error',
]);
export type ScanErrorCategory = z.infer<typeof scanErrorCategorySchema>;
