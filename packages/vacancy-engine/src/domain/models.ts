import { z } from 'zod';

export const atsProviderSchema = z.enum([
  'ashby',
  'greenhouse',
  'lever',
  'recruitee',
  'teamtailor',
  'smartrecruiters',
  'personio',
  'workable',
  'workday',
  'successfactors',
  'json_ld',
  'html',
  'unknown',
]);
export type AtsProvider = z.infer<typeof atsProviderSchema>;

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
