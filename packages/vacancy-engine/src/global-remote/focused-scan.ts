import type { DiscoveryProvider, DiscoverySourceAudit, DiscoveryVacancyAudit } from './models.js';
import { ALL_COUNTRIES, normalizeCountry, UNSPECIFIED_LOCATION } from '../geo/countries.js';
import { assessSalary, type SalaryFilterCriteria } from './salary.js';

export type FocusedCriterion = 'role' | 'country' | 'employment' | 'salary';

export type FocusedScanCriteria = {
  role: string;
  country: string | null;
  employment: string | null;
  salary?: SalaryFilterCriteria | null;
};

export type UpstreamFilterSupport = {
  parameter: string;
  valueFormat: 'free_text' | 'exact' | 'enumerated';
  pagination: 'filtered_pages' | 'not_applicable';
  limitations: string;
};

export type SourceFilterCapability = Readonly<
  Partial<Record<FocusedCriterion, UpstreamFilterSupport>>
>;

const NO_UPSTREAM_FILTERS: SourceFilterCapability = Object.freeze({});

function exactCountry(
  parameter: string,
  pagination: UpstreamFilterSupport['pagination'],
  limitations: string,
): UpstreamFilterSupport {
  return { parameter, valueFormat: 'exact', pagination, limitations };
}

function role(
  parameter: string,
  pagination: UpstreamFilterSupport['pagination'] = 'filtered_pages',
  limitations = 'The source ranks or tokenizes the query independently; local matching remains authoritative.',
): SourceFilterCapability {
  return Object.freeze({
    role: {
      parameter,
      valueFormat: 'free_text',
      pagination,
      limitations,
    },
  });
}

/**
 * Reviewed request contracts. Absence is intentional: an adapter must opt in here before a caller
 * can describe a criterion as upstream-applied. This prevents a new filter from turning into an
 * invented query parameter at one of the many independently maintained feeds.
 */
export const SOURCE_FILTER_CAPABILITIES: Readonly<
  Record<DiscoveryProvider, SourceFilterCapability>
> = Object.freeze({
  himalayas: Object.freeze({
    ...role('q'),
    country: exactCountry(
      'country',
      'filtered_pages',
      'Country values use the source country vocabulary.',
    ),
    employment: {
      parameter: 'employment_type',
      valueFormat: 'enumerated',
      pagination: 'filtered_pages',
      limitations: 'Only Himalayas documented employment values are sent; local matching remains authoritative.',
    } as const satisfies UpstreamFilterSupport,
  }),
  jobicy: role('tag', 'not_applicable', 'Jobicy issues one bounded request; the tag is sent once.'),
  remotive: NO_UPSTREAM_FILTERS,
  freehire: role('category', 'not_applicable', 'Freehire issues one bounded request; the category is sent once.'),
  job_opportunities: role('q', 'not_applicable', 'Job Opportunities issues one bounded request; the query is sent once.'),
  remote_landers: NO_UPSTREAM_FILTERS,
  jobgether: role('keyword'),
  we_work_remotely: NO_UPSTREAM_FILTERS,
  remote_first_jobs: NO_UPSTREAM_FILTERS,
  job_remotely: NO_UPSTREAM_FILTERS,
  remote_ok: NO_UPSTREAM_FILTERS,
  arbeitnow: NO_UPSTREAM_FILTERS,
  startup_jobs: NO_UPSTREAM_FILTERS,
  devitjobs_nl: NO_UPSTREAM_FILTERS,
  jobs_collider: NO_UPSTREAM_FILTERS,
  working_nomads: NO_UPSTREAM_FILTERS,
  real_work_from_anywhere: NO_UPSTREAM_FILTERS,
  devitjobs_uk: NO_UPSTREAM_FILTERS,
  dice: role('keyword'),
  remoote: Object.freeze({
    country: exactCountry(
      'country',
      'not_applicable',
      'The anonymous endpoint returns one bounded result set.',
    ),
  }),
  ai_dev_jobs: role('q'),
  taiwan_jobs: NO_UPSTREAM_FILTERS,
  the_muse: NO_UPSTREAM_FILTERS,
  jobspresso: NO_UPSTREAM_FILTERS,
  remote_frontend_jobs: NO_UPSTREAM_FILTERS,
  un_careers: NO_UPSTREAM_FILTERS,
  jobtech_sweden: role('q', 'not_applicable', 'JobTech issues one bounded request; the query is sent once.'),
  workable_global: NO_UPSTREAM_FILTERS,
  adzuna: role('what'),
  jooble: role('keywords', 'not_applicable', 'Jooble issues one bounded request; the keywords are sent once.'),
  reed: role('keywords', 'not_applicable', 'Reed issues one bounded request; the keywords are sent once.'),
  jobspipe: role('job_title_or', 'not_applicable', 'JobsPipe issues one bounded request; the title is sent once.'),
  ats_roster_greenhouse: NO_UPSTREAM_FILTERS,
  ats_roster_lever: NO_UPSTREAM_FILTERS,
  ats_roster_ashby: NO_UPSTREAM_FILTERS,
  ats_roster_recruitee: NO_UPSTREAM_FILTERS,
  ats_roster_personio: NO_UPSTREAM_FILTERS,
  nav_arbeidsplassen: NO_UPSTREAM_FILTERS,
});

function normalized(value: string): string {
  return value.trim().toLocaleLowerCase();
}

function isUnspecifiedCountry(value: string): boolean {
  return normalized(value) === normalized(UNSPECIFIED_LOCATION);
}

function canonicalCountry(value: string): string | null {
  return isUnspecifiedCountry(value) ? null : normalizeCountry(value);
}

const ISO_COUNTRY_NAME_OVERRIDES: Readonly<Record<string, string>> = {
  'Antigua and Barbuda': 'AG',
  'Bosnia and Herzegovina': 'BA',
  'Cabo Verde': 'CV',
  Congo: 'CG',
  'Democratic Republic of the Congo': 'CD',
  'Ivory Coast': 'CI',
  Myanmar: 'MM',
  Palestine: 'PS',
  'Saint Kitts and Nevis': 'KN',
  'Saint Lucia': 'LC',
  'Saint Vincent and the Grenadines': 'VC',
  'Sao Tome and Principe': 'ST',
  'Trinidad and Tobago': 'TT',
  Turkey: 'TR',
};

const ISO_BY_COUNTRY_NAME = (() => {
  const displayNames = new Intl.DisplayNames(['en'], { type: 'region' });
  const codes = new Map<string, string>();
  for (let first = 65; first <= 90; first += 1) {
    for (let second = 65; second <= 90; second += 1) {
      const code = String.fromCharCode(first, second);
      const name = displayNames.of(code);
      if (name !== undefined && name !== code) codes.set(name, code);
    }
  }
  return new Map(ALL_COUNTRIES.flatMap((country) => {
    const code = ISO_COUNTRY_NAME_OVERRIDES[country] ?? codes.get(country);
    return code ? [[country, code] as const] : [];
  }));
})();

const HIMALAYAS_EMPLOYMENT_TYPES: Readonly<Record<string, string>> = {
  full_time: 'Full Time',
  part_time: 'Part Time',
  contract: 'Contractor',
  contractor: 'Contractor',
  temporary: 'Temporary',
  internship: 'Intern',
  intern: 'Intern',
  volunteer: 'Volunteer',
  other: 'Other',
};

function canonicalEmployment(value: string): string {
  return normalized(value).replace(/[\s-]+/gu, '_');
}

/** Maps UI country names to a source's documented request vocabulary. */
export function upstreamCountryFor(
  provider: DiscoveryProvider,
  country: string | null | undefined,
): string | null {
  if (!country) return null;
  const canonical = canonicalCountry(country);
  if (canonical === null) return null;
  if (provider === 'himalayas') return ISO_BY_COUNTRY_NAME.get(canonical) ?? null;
  return provider === 'remoote' ? canonical : null;
}

export function upstreamEmploymentFor(
  provider: DiscoveryProvider,
  employment: string | null | undefined,
): string | null {
  if (!employment || provider !== 'himalayas') return null;
  return HIMALAYAS_EMPLOYMENT_TYPES[canonicalEmployment(employment)] ?? null;
}

function normalizedRequestValue(criterion: FocusedCriterion, value: string): string {
  if (criterion === 'country') return isUnspecifiedCountry(value) ? UNSPECIFIED_LOCATION : canonicalCountry(value) ?? normalized(value);
  return criterion === 'employment' ? canonicalEmployment(value) : normalized(value);
}

function requestedEntries(
  criteria: FocusedScanCriteria,
): ReadonlyArray<readonly [FocusedCriterion, string]> {
  return [
    ...(criteria.role ? [['role', criteria.role] as const] : []),
    ...(criteria.country ? [['country', criteria.country] as const] : []),
    ...(criteria.employment ? [['employment', criteria.employment] as const] : []),
    ...(criteria.salary ? [['salary', `${criteria.salary.currency} ${criteria.salary.minimumAnnual}`] as const] : []),
  ];
}

export function withFocusedScanPlan(
  source: DiscoverySourceAudit,
  criteria: FocusedScanCriteria,
): DiscoverySourceAudit {
  const capability = SOURCE_FILTER_CAPABILITIES[source.provider];
  const requested = requestedEntries(criteria);
  const planned = requested.map(([criterion, value]) => {
    const support = capability[criterion];
    const upstreamValue = criterion === 'country'
      ? upstreamCountryFor(source.provider, value)
      : criterion === 'employment'
        ? upstreamEmploymentFor(source.provider, value)
        : criterion === 'salary'
          ? null
          : value;
    const normalizedValue = normalizedRequestValue(criterion, value);
    const reason = support === undefined
      ? 'This source has no documented upstream parameter for this criterion.'
      : upstreamValue === null
        ? 'The requested value has no documented source-specific upstream mapping.'
        : null;
    return { criterion, value, normalizedValue, support, upstreamValue, reason };
  });
  const applied = planned
    .filter((entry) => entry.support !== undefined && entry.upstreamValue !== null)
    .map(({ criterion, upstreamValue, support }) => ({
      criterion,
      value: upstreamValue!,
      ...support!,
    }));
  const deferred = planned
    .filter((entry) => entry.reason !== null)
    .map(({ criterion, value, normalizedValue, reason }) => ({ criterion, value, normalizedValue, reason: reason! }));
  return {
    ...source,
    focusedScan: {
      requested: Object.fromEntries(requested),
      applied,
      deferred,
      unsupported: deferred,
    },
  };
}

function countryMatches(locations: readonly string[], requested: string): boolean {
  if (isUnspecifiedCountry(requested)) {
    return locations.every((location) => normalizeCountry(location) === null);
  }
  const canonical = canonicalCountry(requested);
  return canonical !== null && locations.some((location) => normalizeCountry(location) === canonical);
}

/** The final filter is shared by every adapter, so upstream support can only reduce fetching. */
export function applyFocusedScanCriteria(
  vacancies: readonly DiscoveryVacancyAudit[],
  criteria: FocusedScanCriteria,
): {
  vacancies: DiscoveryVacancyAudit[];
  unknownEmployment: number;
  explicitEmploymentMismatch: number;
  salaryComparable: number;
  salaryUnknown: number;
  salaryBelowMinimum: number;
} {
  let unknownEmployment = 0;
  let explicitEmploymentMismatch = 0;
  let salaryComparable = 0;
  let salaryUnknown = 0;
  let salaryBelowMinimum = 0;
  const role = normalized(criteria.role);
  const employment = criteria.employment ? canonicalEmployment(criteria.employment) : null;
  return {
    vacancies: vacancies.filter((vacancy) => {
      const searchableText = vacancy.searchableText ?? [`${vacancy.title} ${vacancy.description ?? ''}`];
      if (role && !searchableText.some((text) => normalized(text).includes(role)))
        return false;
      if (
        criteria.country &&
        !countryMatches(vacancy.locations ?? [vacancy.location], criteria.country)
      )
        return false;
      if (employment) {
        const employmentTypes = vacancy.employmentTypes ?? (vacancy.employmentType ? [vacancy.employmentType] : []);
        if (employmentTypes.length === 0) {
          unknownEmployment += 1;
          return false;
        }
        if (!employmentTypes.some((type) => canonicalEmployment(type) === employment)) {
          explicitEmploymentMismatch += 1;
          return false;
        }
      }
      const salaryAssessment = assessSalary(vacancy, criteria.salary);
      if (salaryAssessment.kind === 'not_applicable') return true;
      if (salaryAssessment.kind === 'comparable') {
        salaryComparable += 1;
        return true;
      }
      if (salaryAssessment.kind === 'below_floor') {
        salaryComparable += 1;
        salaryBelowMinimum += 1;
        return false;
      }
      salaryUnknown += 1;
      return criteria.salary?.includeUnknown ?? true;
    }),
    unknownEmployment,
    explicitEmploymentMismatch,
    salaryComparable,
    salaryUnknown,
    salaryBelowMinimum,
  };
}
