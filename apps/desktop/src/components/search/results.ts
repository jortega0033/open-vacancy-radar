import type {
  DiscoveryVacancyAudit,
  GlobalRemoteReport,
  JobRadarReport,
  OfficialVacancyAudit,
  ReportVacancy,
} from '@open-vacancy-radar/vacancy-engine';
import type { Market } from '../../window.js';
import type { VacancyLead } from '../cv/types.js';
import { ALL_COUNTRIES, normalizeCountry, UNSPECIFIED_LOCATION } from './countries.js';

/**
 * Normalisation layer between the two *genuinely different* scan pipelines and one search UI.
 *
 * `window.vacancyRadar` exposes two report shapes that are not variants of each other:
 *
 * - `JobRadarReport.vacancies: ReportVacancy[]`: the Netherlands pipeline. Carries a deterministic
 *   relevance score with sub-dimensions, matched/missing skills, Dutch-language evidence, a posting
 *   date, a workplace mode, and (the reason this pipeline exists) the IND recognised-sponsor
 *   legal entities matched to the employer plus the confidence of that mapping. It carries no
 *   salary and no employment type.
 * - `GlobalRemoteReport.discoveryAudit: DiscoveryVacancyAudit[]`: the worldwide/remote pipeline.
 *   Carries advertised salary, employment type and a discovery decision. It has no posting date, no
 *   workplace mode, no score, and **no employer-verification concept at all**.
 *
 * The single most important rule encoded here: the absence of employer verification in the
 * worldwide pipeline is reported as *absent*, never as a negative result. "We did not check" and
 * "we checked and the employer is not a recognised sponsor" are different claims, and only the
 * Netherlands pipeline is capable of making the second one. Likewise "no sponsor entity was
 * matched" is a missing match, not a finding of non-recognition.
 */

export type SearchMarket = Market;

export const MARKET_OPTIONS: { value: SearchMarket; label: string }[] = [
  { value: 'netherlands', label: 'Netherlands' },
  { value: 'worldwide', label: 'Worldwide / Remote' },
];

export function marketLabel(market: SearchMarket): string {
  return MARKET_OPTIONS.find((option) => option.value === market)?.label ?? market;
}

export type VerificationLevel =
  | 'recognised_sponsor'
  | 'possible_sponsor_match'
  | 'sponsor_unresolved'
  | 'not_available';

export interface Verification {
  level: VerificationLevel;
  /** Short status, always rendered as text. Colour is never the only signal. */
  label: string;
  /** The honest explanation of what was and was not checked. */
  note: string;
  /**
   * State hue for the status dot, or `null` for a market where no check exists. A market with no
   * verification step must not get a green, amber or red dot, because it has no outcome to colour.
   */
  tone: 'success' | 'warning' | null;
}

export const WORLDWIDE_VERIFICATION: Verification = {
  level: 'not_available',
  label: 'Not available for this market',
  tone: null,
  note:
    'The worldwide/remote pipeline discovers vacancies from public job feeds and does not check employers against any register. Nothing was verified about this employer: that is an absent check, not a negative result.',
};

export type ArrangementValue = 'remote' | 'hybrid' | 'onsite' | 'unknown';

interface CommonResult {
  /** Stable identity for selection and for `savedJobs.vacancyKey`. */
  key: string;
  title: string;
  company: string;
  location: string | null;
  url: string;
  /** The source that produced this row: an ATS/provider name for NL, a feed id for worldwide. */
  provider: string;
  /** Present only where the pipeline actually records one (Netherlands). */
  arrangement: string | null;
  arrangementValue: ArrangementValue;
  employmentType: string | null;
  /** Pre-formatted advertised salary, or null where the pipeline carries no salary data. */
  salary: string | null;
  /** ISO-8601, or null where the pipeline carries no posting date. */
  postedAt: string | null;
  /** Null where the source carried no description text at all, never an empty string. */
  description: string | null;
  verification: Verification;
  /**
   * The Netherlands pipeline's deterministic relevance score. This is scored against the engine's
   * configured candidate profile, **not** against any CV in the CV library, so it must never be
   * labelled "CV match". Null for worldwide, which computes no score.
   */
  profileScore: number | null;
  /** Deterministic engine findings, where the pipeline produces them. */
  strongPoints: string[];
  gaps: string[];
  reasons: string[];
  /** The subset of fields the CV assistant needs to write a prompt. */
  lead: VacancyLead;
}

export type SearchResult =
  | (CommonResult & { market: 'netherlands'; raw: ReportVacancy })
  | (CommonResult & {
      market: 'worldwide';
      raw: DiscoveryVacancyAudit;
      /**
       * The official-source audit row for this exact URL, when the same run happened to verify it.
       * Matched on exact URL only. A fuzzy company/title match would manufacture evidence.
       */
      official: OfficialVacancyAudit | null;
    });

const WORKPLACE_LABEL: Record<ReportVacancy['workplaceMode'], string | null> = {
  remote: 'Remote',
  hybrid: 'Hybrid',
  onsite: 'On-site',
  unknown: null,
};

/**
 * `null` is "the pipeline did not record this", which is different from an empty string. Kept as a
 * helper so every call site renders the same words for a missing value.
 */
export function orNotStated(value: string | null | undefined): string {
  return value && value.trim().length > 0 ? value : 'Not stated';
}

export const VERIFICATION_DISABLED: Verification = {
  level: 'not_available',
  label: 'Verification turned off',
  tone: null,
  note:
    'IND recognised sponsor verification is turned off in Settings, so vacancies here are not filtered by (or checked against) the sponsor register. Nothing was verified about this employer: that is a disabled check, not a negative result.',
};

export function netherlandsVerification(vacancy: ReportVacancy, indVerificationEnabled: boolean): Verification {
  if (!indVerificationEnabled) return VERIFICATION_DISABLED;

  const names = vacancy.sponsorLegalNames.filter((name) => name.trim().length > 0);

  if (names.length === 0) {
    return {
      level: 'sponsor_unresolved',
      label: 'Sponsor entity not resolved',
      tone: 'warning',
      note:
        'No IND-recognised legal entity was matched to this employer in this run. That is a missing match, not a finding that the employer is unrecognised: a trading name often differs from the registered legal entity.',
    };
  }

  if (vacancy.mappingConfidence === 'high') {
    return {
      level: 'recognised_sponsor',
      label: 'Recognised sponsor',
      tone: 'success',
      note: `Matched with high confidence to ${names.join(', ')} on the IND public register. Recognition applies to the employer, not to this individual vacancy.`,
    };
  }

  return {
    level: 'possible_sponsor_match',
    label: 'Possible sponsor match',
    tone: 'warning',
    note: `Matched to ${names.join(', ')} with ${vacancy.mappingConfidence} confidence. Confirm the legal entity on the vacancy itself before relying on sponsorship.`,
  };
}

export function formatDiscoverySalary(vacancy: DiscoveryVacancyAudit): string | null {
  if (vacancy.advertisedMinimum == null) return null;
  const currency = vacancy.currency ?? '';
  const period = vacancy.salaryPeriod ? `/${vacancy.salaryPeriod}` : '';
  return `${currency} ${vacancy.advertisedMinimum.toLocaleString()}${period}`.trim();
}

export function decisionLabel(decision: DiscoveryVacancyAudit['decision']): string {
  return decision.replace(/_/g, ' ');
}

/** Renderer-side scheme guard, mirroring `electron/external-url.ts`. A feed controls this string. */
export function isWebUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

export function toNetherlandsResults(report: JobRadarReport): SearchResult[] {
  return report.vacancies.map((vacancy) => ({
    market: 'netherlands' as const,
    raw: vacancy,
    key: vacancy.id,
    title: vacancy.title,
    company: vacancy.company,
    location: vacancy.location,
    url: vacancy.url,
    provider: vacancy.provider,
    arrangement: WORKPLACE_LABEL[vacancy.workplaceMode],
    arrangementValue: vacancy.workplaceMode,
    // The Netherlands report carries neither salary nor employment type. Rather than deriving one
    // from the title, both stay null and the UI says so.
    employmentType: null,
    salary: null,
    postedAt: vacancy.postedAt,
    description: vacancy.description,
    verification: netherlandsVerification(vacancy, report.indVerificationEnabled),
    // Undefined, not present, when the candidate profile wasn't configured for this run (see
    // JobRadarReport.profileConfigured) -- deterministic scoring never ran for this vacancy.
    profileScore: vacancy.score ?? null,
    strongPoints: vacancy.matchingSkills ?? [],
    gaps: vacancy.gaps ?? [],
    reasons: vacancy.reasons ?? [],
    lead: {
      title: vacancy.title,
      company: vacancy.company,
      location: orNotStated(vacancy.location),
      url: vacancy.url,
    },
  }));
}

export function toWorldwideResults(report: GlobalRemoteReport): SearchResult[] {
  const officialByUrl = new Map<string, OfficialVacancyAudit>();
  for (const entry of report.officialAudit) officialByUrl.set(entry.url, entry);

  return report.discoveryAudit.map((vacancy) => ({
    market: 'worldwide' as const,
    raw: vacancy,
    official: officialByUrl.get(vacancy.url) ?? null,
    key: vacancy.key,
    title: vacancy.title,
    company: vacancy.company,
    location: vacancy.location,
    url: vacancy.url,
    provider: vacancy.provider,
    // The worldwide profile *searches* for fully-remote work, but a discovery lead is not per-row
    // evidence that this vacancy is remote. `location_restricted` is one of its decisions. So no
    // arrangement is claimed for a worldwide row.
    arrangement: null,
    arrangementValue: 'unknown' as const,
    employmentType: vacancy.employmentType,
    salary: formatDiscoverySalary(vacancy),
    // Null for most sources, which genuinely carry no posting date; real for the sources that do.
    postedAt: vacancy.postedAt,
    description: vacancy.description,
    verification: WORLDWIDE_VERIFICATION,
    profileScore: null,
    strongPoints: [],
    gaps: [],
    reasons: vacancy.reasons,
    lead: {
      title: vacancy.title,
      company: vacancy.company,
      location: orNotStated(vacancy.location),
      url: vacancy.url,
      employmentType: vacancy.employmentType,
      currency: vacancy.currency,
      salaryPeriod: vacancy.salaryPeriod,
      advertisedMinimum: vacancy.advertisedMinimum,
    },
  }));
}

export type PostedWithin = 'any' | '1' | '7' | '30';

export interface SearchFilters {
  /** Role or keyword, matched against title and company. */
  query: string;
  /** City or region, matched against the row's location. */
  location: string;
  /** Netherlands only: keep only rows with a resolved IND sponsor legal entity. */
  sponsorOnly: boolean;
  /** Netherlands only: the worldwide pipeline records no workplace mode. */
  arrangement: 'any' | ArrangementValue;
  /**
   * Both markets. Most worldwide sources still record no posting date at all -- a row with an
   * unknown date is dropped rather than kept when this filter is active, never assumed recent.
   */
  postedWithin: PostedWithin;
  /** Both markets: the discovery source / ATS provider. */
  source: string;
  /** Worldwide only: the Netherlands pipeline records no employment type. */
  employment: string;
  /**
   * Worldwide only: which country a vacancy's own `location` text normalizes to (see
   * `countries.ts`). `'all'` applies no filter; the Netherlands pipeline is already scoped to one
   * country and carries no comparable free-text location to normalize against a worldwide list.
   */
  country: string;
}

export const DEFAULT_FILTERS: SearchFilters = {
  query: '',
  location: '',
  sponsorOnly: false,
  arrangement: 'any',
  postedWithin: 'any',
  source: 'all',
  employment: 'any',
  country: 'all',
};

/** The secondary filters that are meaningful for a given market, given what its data carries. */
export function supportedFilters(market: SearchMarket): {
  sponsorOnly: boolean;
  arrangement: boolean;
  postedWithin: boolean;
  employment: boolean;
  country: boolean;
} {
  const isNetherlands = market === 'netherlands';
  return {
    sponsorOnly: isNetherlands,
    arrangement: isNetherlands,
    postedWithin: true,
    employment: !isNetherlands,
    country: !isNetherlands,
  };
}

/**
 * Every selectable country plus the honest fallback for a vacancy whose location text didn't
 * confidently normalize to any of them. Static and complete — not derived from the loaded report,
 * since the worldwide pipeline's sources can return any country regardless of what's shown up yet.
 */
export function countryOptions(): string[] {
  return [...ALL_COUNTRIES, UNSPECIFIED_LOCATION];
}

export function sourceOptions(results: SearchResult[]): string[] {
  return [...new Set(results.map((result) => result.provider))].sort((a, b) => a.localeCompare(b));
}

export function employmentOptions(results: SearchResult[]): string[] {
  const values = results
    .map((result) => result.employmentType)
    .filter((value): value is string => !!value && value.trim().length > 0);
  return [...new Set(values)].sort((a, b) => a.localeCompare(b));
}

const MILLISECONDS_PER_DAY = 86_400_000;

function matches(haystack: string | null, needle: string): boolean {
  if (!needle.trim()) return true;
  return (haystack ?? '').toLowerCase().includes(needle.trim().toLowerCase());
}

/**
 * Client-side filtering over an already-fetched report. There is no server-side filtered search.
 * Both pipelines produce a whole report per run, and narrowing it must never trigger a new scan.
 *
 * Every predicate is skipped for a market whose data cannot support it, so switching market can
 * never silently drop rows on a dimension that market does not record.
 */
export function filterResults(
  results: SearchResult[],
  filters: SearchFilters,
  now: Date = new Date(),
): SearchResult[] {
  const supported = results.length > 0 ? supportedFilters(results[0]!.market) : supportedFilters('netherlands');

  return results.filter((result) => {
    if (filters.query.trim()) {
      const needle = filters.query.trim().toLowerCase();
      const inTitle = result.title.toLowerCase().includes(needle);
      const inCompany = result.company.toLowerCase().includes(needle);
      if (!inTitle && !inCompany) return false;
    }

    if (!matches(result.location, filters.location)) return false;

    if (filters.source !== 'all' && result.provider !== filters.source) return false;

    if (supported.sponsorOnly && filters.sponsorOnly) {
      if (result.market !== 'netherlands' || result.raw.sponsorLegalNames.length === 0) return false;
    }

    if (supported.arrangement && filters.arrangement !== 'any') {
      if (result.arrangementValue !== filters.arrangement) return false;
    }

    if (supported.postedWithin && filters.postedWithin !== 'any') {
      // A row with no known posting date cannot satisfy "posted in the last N days". It is dropped
      // rather than kept, so the narrowed list means exactly what it says; the filter bar states it.
      if (!result.postedAt) return false;
      const posted = new Date(result.postedAt);
      if (Number.isNaN(posted.valueOf())) return false;
      const maximumAgeMs = Number(filters.postedWithin) * MILLISECONDS_PER_DAY;
      if (now.getTime() - posted.getTime() > maximumAgeMs) return false;
    }

    if (supported.employment && filters.employment !== 'any') {
      if (result.employmentType !== filters.employment) return false;
    }

    if (supported.country && filters.country !== 'all') {
      const resolved = normalizeCountry(result.location) ?? UNSPECIFIED_LOCATION;
      if (resolved !== filters.country) return false;
    }

    return true;
  });
}

function postedAtTimestamp(value: string | null): number | null {
  if (!value) return null;
  const parsed = new Date(value).getTime();
  return Number.isNaN(parsed) ? null : parsed;
}

/**
 * Highest profile score first (Netherlands only -- worldwide never scores a vacancy against the
 * candidate profile), then most recently posted first among ties or scoreless rows, then title.
 * A row with no known posting date sorts after every row that has one, never assumed recent.
 */
export function sortResults(results: SearchResult[]): SearchResult[] {
  return [...results].sort((left, right) => {
    if (
      left.profileScore != null &&
      right.profileScore != null &&
      left.profileScore !== right.profileScore
    ) {
      return right.profileScore - left.profileScore;
    }
    const leftPosted = postedAtTimestamp(left.postedAt);
    const rightPosted = postedAtTimestamp(right.postedAt);
    if (leftPosted !== null && rightPosted !== null && leftPosted !== rightPosted) {
      return rightPosted - leftPosted;
    }
    if ((leftPosted === null) !== (rightPosted === null)) {
      return leftPosted === null ? 1 : -1;
    }
    return left.title.localeCompare(right.title);
  });
}

export function formatDate(value: string | null): string {
  if (!value) return 'Unknown';
  const parsed = new Date(value);
  if (Number.isNaN(parsed.valueOf())) return 'Unknown';
  return parsed.toLocaleDateString();
}

/**
 * Matches the Netherlands pipeline's own `freshnessPolicy.maximumPostingAgeDays` (30): that
 * pipeline enforces it server-side and never reports an older row at all, so a worldwide row past
 * the same age is flagged, not hidden, since nothing here re-checks whether the posting is still
 * live before the user applies to it.
 */
const STALE_POSTING_THRESHOLD_DAYS = 30;

export function isStalePosting(postedAt: string | null, now: Date = new Date()): boolean {
  if (!postedAt) return false;
  const posted = new Date(postedAt);
  if (Number.isNaN(posted.valueOf())) return false;
  return now.getTime() - posted.getTime() > STALE_POSTING_THRESHOLD_DAYS * MILLISECONDS_PER_DAY;
}
