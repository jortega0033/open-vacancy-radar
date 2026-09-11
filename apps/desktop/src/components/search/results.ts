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
  // `!= null` (not `=== null`) on purpose: a report persisted by an older engine version can
  // predate this field entirely, so `worldwideSponsorMatch` may come back `undefined` from disk
  // rather than the `null` the current type promises -- a stale report is exactly what a real dev
  // launch can hydrate (apps/desktop/electron/resolve-vacancy-engine-paths.ts's dev-mode data root
  // is not scoped per launch). The stored JSON is trusted, untyped data at this boundary; treating
  // a malformed or half-populated match as "no match" (rather than crashing on `match.legalName`
  // of `undefined`) matches this module's own rule above: absence of verification renders as
  // absent, never as a negative result -- and never as a crash either.
  if (match == null || !match.legalName || !match.kvkNumber) return WORLDWIDE_VERIFICATION;

  return {
    level: 'possible_sponsor_match',
    label: 'Possible sponsor match (best effort)',
    tone: 'warning',
    note: `A best-effort Wikidata name search matched this employer to ${match.legalName} (KVK ${match.kvkNumber}) on the IND public register. This is a best-effort, name-keyed match, not a curated verification: confirm the legal entity yourself before relying on sponsorship.`,
  };
}

/** Canonical suffix shown for each of the pay-period buckets this app recognizes. */
const SALARY_PERIOD_LABELS = {
  hourly: '/hr',
  weekly: '/wk',
  monthly: '/mo',
  annual: '/yr',
  daily: '/day',
} as const;

type SalaryPeriodLabel = keyof typeof SALARY_PERIOD_LABELS;

/**
 * `DiscoveryVacancyAudit['salaryPeriod']` is a plain `string | null`, not a closed enum -- some
 * discovery adapters run raw upstream feed vocabulary through `parseSalaryText` first (giving one
 * of a handful of known words), but others (Himalayas, Jobicy, ...) pass the source's own
 * `salaryPeriod` field straight through unnormalized (see `discoverHimalayas`/`discoverJobicy` in
 * `packages/vacancy-engine/src/global-remote/discovery.ts`). A confirmed audit finding was a single
 * results list showing "USD 163,200/yearly", "GBP 25,000/weekly" and "USD 120,000/year" side by
 * side -- three spellings of two periods, read verbatim from whichever source happened to produce
 * them. This maps every synonym actually seen across this app's sources onto one of a small,
 * consistent set of suffixes. A value this doesn't recognize renders with no period suffix at all,
 * rather than leaking arbitrary source text into the UI.
 */
function normalizeSalaryPeriod(period: string | null): SalaryPeriodLabel | null {
  if (!period) return null;
  if (/\b(?:hour|hourly|hr)\b/iu.test(period)) return 'hourly';
  if (/\b(?:week|weekly|wk)\b/iu.test(period)) return 'weekly';
  if (/\b(?:month|monthly|mo)\b/iu.test(period)) return 'monthly';
  if (/\b(?:day|daily)\b/iu.test(period)) return 'daily';
  if (/\b(?:year|yearly|annual|annually|yr|p\.?a\.?)\b/iu.test(period)) return 'annual';
  return null;
}

/**
 * `advertisedMinimum` is exactly what its name says -- a minimum, not a fixed salary -- so this is
 * prefixed with "from" rather than rendered as if it were the whole story (a confirmed audit
 * finding: the UI never said "minimum" anywhere, so a candidate had no way to know the number on a
 * card was a floor rather than the actual offer).
 */
export function formatDiscoverySalary(vacancy: DiscoveryVacancyAudit): string | null {
  if (vacancy.advertisedMinimum == null) return null;
  const parts = ['from'];
  if (vacancy.currency) parts.push(vacancy.currency);
  parts.push(vacancy.advertisedMinimum.toLocaleString());
  const amount = parts.join(' ');
  const normalizedPeriod = normalizeSalaryPeriod(vacancy.salaryPeriod);
  return normalizedPeriod ? `${amount}${SALARY_PERIOD_LABELS[normalizedPeriod]}` : amount;
}

export function decisionLabel(decision: DiscoveryVacancyAudit['decision']): string {
  return decision.replace(/_/g, ' ');
}

/**
 * Single-line preview of `description` for the results-list card (issue: cards showed zero
 * role-content, so scanning 25 results meant opening each one individually to judge fit). The
 * stored `description` can now carry real paragraph breaks (`htmlToText` inserts a newline at every
 * block-tag boundary -- see `packages/vacancy-engine/src/global-remote/feed-discovery.ts`'s
 * `decodedText`), which the detail pane renders with `whitespace-pre-wrap`; collapsing them to
 * spaces here is purely a card-preview concern; it never mutates or re-derives the text the detail
 * pane shows. Returns null for a blank/whitespace-only description so the card never renders an
 * empty line.
 */
export function descriptionExcerpt(description: string | null): string | null {
  if (!description) return null;
  const collapsed = description.replace(/\s+/gu, ' ').trim();
  return collapsed.length > 0 ? collapsed : null;
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

/**
 * The `SearchResult` row for one discovery vacancy, given whatever official-source cross-reference
 * (if any) this run found for its exact URL. Shared by `toWorldwideResults` (a finished scan, real
 * `official` lookups) and `toPartialResults` (a still-running scan, `official` always null -- see
 * that function's own doc comment for why).
 */
function toSearchResult(vacancy: DiscoveryVacancyAudit, official: OfficialVacancyAudit | null): SearchResult {
  return {
    raw: vacancy,
    official,
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
  };
}

export function toWorldwideResults(report: GlobalRemoteReport): SearchResult[] {
  const officialByUrl = new Map<string, OfficialVacancyAudit>();
  for (const entry of report.officialAudit) officialByUrl.set(entry.url, entry);

  return report.discoveryAudit.map((vacancy) => toSearchResult(vacancy, officialByUrl.get(vacancy.url) ?? null));
}

/**
 * Streaming/provisional counterpart to `toWorldwideResults` (issue #252): converts the discovery
 * rows a scan has pushed so far, while it is still running and no final `GlobalRemoteReport` exists
 * yet. `official` is always null -- the official-source audit this run will eventually produce
 * doesn't exist yet either (`runOfficialGlobalRemoteSources` runs independently of, and is never
 * awaited by, the discovery progress events this converts), so every partial row's verification
 * reads the same honest "not available" state `worldwideVerification` already gives any row with no
 * sponsor match. `profileScore` is whatever the raw `DiscoveryVacancyAudit` carries, which is always
 * null here too: scoring and sponsor-matching only ever run once, after discovery has fully
 * finished (see `runGlobalRemoteScan`), so a partial row is never mislabelled with a real-looking
 * score it was not actually given.
 */
export function toPartialResults(vacancies: readonly DiscoveryVacancyAudit[]): SearchResult[] {
  return vacancies.map((vacancy) => toSearchResult(vacancy, null));
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
