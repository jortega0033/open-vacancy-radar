import type { DiscoveryVacancyAudit, OfficialVacancyAudit, GlobalRemoteReport } from '@open-vacancy-radar/vacancy-engine';
import type { VacancyLead } from '../cv/types.js';
import { ALL_COUNTRIES, normalizeCountry, UNSPECIFIED_LOCATION } from './countries.js';

/**
 * Normalisation layer between the worldwide/remote scan pipeline and the search UI.
 *
 * The app used to run a second, curated Netherlands pipeline (a SQL-backed scan of companies
 * pre-mapped to the IND recognised-sponsor register, with its own Dutch-language candidate
 * matching and a higher-confidence `recognised_sponsor` verification tier). It has been removed
 * entirely: the special-casing it required throughout this UI was exactly the kind of default
 * country/role bias this app is supposed to never ship, and its higher-confidence sponsor evidence
 * chain had no equivalent for any other country -- keeping it meant the app could only ever be
 * fully "IND-verified" for one country's employers.
 *
 * What survives, unconditionally, for every vacancy regardless of location: a best-effort
 * Wikidata-based sponsor check (`worldwideVerification` below), always capped at
 * `possible_sponsor_match`, never the old `recognised_sponsor` label -- that stronger claim rested
 * on a curated evidence chain this app no longer maintains. The single most important rule encoded
 * here is unchanged: the absence of employer verification is reported as *absent*, never as a
 * negative result. "We did not check" and "we checked and found nothing" render identically, by
 * design (see `resolveWorldwideSponsorMatch`'s own reasoning for treating both as one honest
 * `null`).
 */

export type VerificationLevel = 'possible_sponsor_match' | 'not_available';

export interface Verification {
  level: VerificationLevel;
  /** Short status, always rendered as text. Colour is never the only signal. */
  label: string;
  /** The honest explanation of what was and was not checked. */
  note: string;
  /**
   * State hue for the status dot, or `null` when there is no outcome to colour (no match found, or
   * the check was never attempted for this vacancy's location).
   */
  tone: 'success' | 'warning' | null;
}

export const WORLDWIDE_VERIFICATION: Verification = {
  level: 'not_available',
  label: 'Not available for this vacancy',
  tone: null,
  note:
    'No sponsor register match was found (or attempted, for a non-Netherlands location) for this employer. Nothing was verified: that is an absent check, not a negative result.',
};

interface CommonResult {
  /** Stable identity for selection and for `savedJobs.vacancyKey`. */
  key: string;
  title: string;
  company: string;
  location: string | null;
  url: string;
  /** The feed/source id that produced this row. */
  provider: string;
  employmentType: string | null;
  /** Pre-formatted advertised salary, or null where the source carries no salary data. */
  salary: string | null;
  /** ISO-8601, or null where the source carries no posting date. */
  postedAt: string | null;
  /** Null where the source carried no description text at all, never an empty string. */
  description: string | null;
  verification: Verification;
  /**
   * The engine's deterministic relevance score, scored against the configured candidate profile,
   * **not** against any CV in the CV library, so it must never be labelled "CV match". Returns
   * null rather than a real-looking zero when the candidate profile has no target roles or
   * strongest skills configured for this run.
   */
  profileScore: number | null;
  /** Deterministic engine findings, where the pipeline produces them. */
  strongPoints: string[];
  gaps: string[];
  reasons: string[];
  /** The subset of fields the CV assistant needs to write a prompt. */
  lead: VacancyLead;
}

export interface SearchResult extends CommonResult {
  raw: DiscoveryVacancyAudit;
  /**
   * The official-source audit row for this exact URL, when the same run happened to verify it.
   * Matched on exact URL only. A fuzzy company/title match would manufacture evidence.
   */
  official: OfficialVacancyAudit | null;
}

/**
 * `null` is "the pipeline did not record this", which is different from an empty string. Kept as a
 * helper so every call site renders the same words for a missing value.
 */
export function orNotStated(value: string | null | undefined): string {
  return value && value.trim().length > 0 ? value : 'Not stated';
}

/**
 * Reports a match from `vacancy.worldwideSponsorMatch` (computed once, engine-side, in
 * `applyWorldwideSponsorMatches` -- see `packages/vacancy-engine/src/companies/
 * worldwide-sponsor-match.ts`). Every non-match row -- which includes every non-Netherlands-located
 * row, since the engine never even attempts the lookup for those -- falls back to exactly
 * `WORLDWIDE_VERIFICATION` unchanged, so "not the Netherlands" and "checked and found nothing"
 * render identically here too.
 *
 * A match is capped at `possible_sponsor_match`: a name-keyed Wikidata search carries none of the
 * evidence-chain rigor a curated, manually-verified company-mapping would.
 */
export function worldwideVerification(vacancy: DiscoveryVacancyAudit): Verification {
  const match = vacancy.worldwideSponsorMatch;
  if (match === null) return WORLDWIDE_VERIFICATION;

  return {
    level: 'possible_sponsor_match',
    label: 'Possible sponsor match (best effort)',
    tone: 'warning',
    note: `A best-effort Wikidata name search matched this employer to ${match.legalName} (KVK ${match.kvkNumber}) on the IND public register. This is a best-effort, name-keyed match, not a curated verification: confirm the legal entity yourself before relying on sponsorship.`,
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

export function toWorldwideResults(report: GlobalRemoteReport): SearchResult[] {
  const officialByUrl = new Map<string, OfficialVacancyAudit>();
  for (const entry of report.officialAudit) officialByUrl.set(entry.url, entry);

  return report.discoveryAudit.map((vacancy) => ({
    raw: vacancy,
    official: officialByUrl.get(vacancy.url) ?? null,
    key: vacancy.key,
    title: vacancy.title,
    company: vacancy.company,
    location: vacancy.location,
    url: vacancy.url,
    provider: vacancy.provider,
    employmentType: vacancy.employmentType,
    salary: formatDiscoverySalary(vacancy),
    // Null for most sources, which genuinely carry no posting date; real for the sources that do.
    postedAt: vacancy.postedAt,
    description: vacancy.description,
    verification: worldwideVerification(vacancy),
    profileScore: vacancy.profileScore,
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
  /** Keep only rows with a possible IND sponsor match (best-effort; see `worldwideVerification`). */
  sponsorOnly: boolean;
  /** Most sources still record no posting date at all -- a row with an unknown date is dropped
   * rather than kept when this filter is active, never assumed recent. */
  postedWithin: PostedWithin;
  /** The discovery source / feed id. */
  source: string;
  employment: string;
  /** Which country a vacancy's own `location` text normalizes to (see `countries.ts`). `'all'`
   * applies no filter. */
  country: string;
}

export const DEFAULT_FILTERS: SearchFilters = {
  query: '',
  location: '',
  sponsorOnly: false,
  postedWithin: 'any',
  source: 'all',
  employment: 'any',
  country: 'all',
};

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
 * Client-side filtering over an already-fetched report. There is no server-side filtered search:
 * the worldwide pipeline produces a whole report per run, and narrowing it must never trigger a
 * new scan.
 */
export function filterResults(
  results: SearchResult[],
  filters: SearchFilters,
  now: Date = new Date(),
): SearchResult[] {
  return results.filter((result) => {
    if (filters.query.trim()) {
      const needle = filters.query.trim().toLowerCase();
      const inTitle = result.title.toLowerCase().includes(needle);
      const inCompany = result.company.toLowerCase().includes(needle);
      if (!inTitle && !inCompany) return false;
    }

    if (!matches(result.location, filters.location)) return false;

    if (filters.source !== 'all' && result.provider !== filters.source) return false;

    if (filters.sponsorOnly && result.raw.worldwideSponsorMatch === null) return false;

    if (filters.postedWithin !== 'any') {
      // A row with no known posting date cannot satisfy "posted in the last N days". It is dropped
      // rather than kept, so the narrowed list means exactly what it says; the filter bar states it.
      if (!result.postedAt) return false;
      const posted = new Date(result.postedAt);
      if (Number.isNaN(posted.valueOf())) return false;
      const maximumAgeMs = Number(filters.postedWithin) * MILLISECONDS_PER_DAY;
      if (now.getTime() - posted.getTime() > maximumAgeMs) return false;
    }

    if (filters.employment !== 'any' && result.employmentType !== filters.employment) return false;

    if (filters.country !== 'all') {
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
 * Highest profile score first, then most recently posted first among ties or scoreless rows, then
 * title. A row with no known posting date sorts after every row that has one, never assumed recent.
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
 * A somewhat arbitrary but stated threshold: nothing here re-checks whether a posting is still
 * live before the user applies to it, so a row past this age is flagged, not hidden.
 */
const STALE_POSTING_THRESHOLD_DAYS = 30;

export function isStalePosting(postedAt: string | null, now: Date = new Date()): boolean {
  if (!postedAt) return false;
  const posted = new Date(postedAt);
  if (Number.isNaN(posted.valueOf())) return false;
  return now.getTime() - posted.getTime() > STALE_POSTING_THRESHOLD_DAYS * MILLISECONDS_PER_DAY;
}
