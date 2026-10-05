import type {
  DiscoveryVacancyAudit,
  OfficialVacancyAudit,
  GlobalRemoteReport,
  ProfileMatchBreakdown,
} from '@open-vacancy-radar/vacancy-engine';
import {
  assessSalary,
  parseMinimumAnnualSalary,
  type SalaryFilterCriteria,
} from '@open-vacancy-radar/vacancy-engine/salary';
import {
  detectWorkArrangement,
  isOnsiteOrHybrid,
  type WorkArrangementDetection,
} from '@open-vacancy-radar/vacancy-engine/work-arrangement';
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
    'No sponsor register match was found (or attempted, for a non-Netherlands location) for this employer. Nothing was verified. No check ran, so this says nothing against the employer.',
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
  /**
   * The structured evidence behind `profileScore` (issue #367): technical/role/seniority fit, role
   * classification, matching profile signals, and gaps/caps, exactly as the scorer computed them --
   * never re-derived or re-scored in the renderer. `null` when `profileScore` is itself null.
   * `undefined`, distinct from `null`, for a report persisted before this field existed even though
   * it carries a real `profileScore`; `VacancyDetail` renders that case as an honest "breakdown
   * unavailable" state rather than fabricating one from the number.
   */
  profileMatch?: ProfileMatchBreakdown | null;
  /**
   * Best-effort on-site/hybrid/remote hint read from the title, location and description text
   * (issue #565a). Not set on mapping: read it through `workArrangementOf`, which works it out on
   * first use, so a large report is not scanned up front. Set only to override that (tests).
   */
  workArrangement?: WorkArrangementDetection;
  /** Deterministic engine findings, where the pipeline produces them. */
  strongPoints: string[];
  gaps: string[];
  reasons: string[];
  /** The subset of fields the CV assistant needs to write a prompt. */
  lead: VacancyLead;
  /**
   * True for a row from an in-progress scan's live/progressive feed (`toPartialResults`), not yet
   * in a final `GlobalRemoteReport`: unscored, with no official-source cross-reference, and not
   * safe to hand to application preparation (issue #363/#364). False for every row `toWorldwideResults`
   * produces, whether or not this run's report is itself capped/incomplete.
   */
  provisional: boolean;
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
    note: `A best-effort Wikidata name search matched this employer to ${match.legalName} (KVK ${match.kvkNumber}) on the IND public register. This is a best-effort match on the name alone and has not been curated. Confirm the legal entity yourself before relying on sponsorship.`,
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

const SECTION_HEADING_SOURCE = String.raw`(?:the role|about the (?:role|job|position)|job (?:description|summary)|position summary|role overview|what you(?:'|\u2019)ll (?:do|be doing)|what you will do|responsibilities|key responsibilities|your role|requirements|qualifications|what we(?:'|\u2019)re looking for|de functie|functieomschrijving|wat ga je doen|deine aufgaben|ihre aufgaben)`;
const INTRO_PHRASE_SOURCE = String.raw`(?:who we are|about us|about the (?:company|team)|company overview|over ons|wie wij zijn|\u00fcber uns|wer wir sind|qui sommes-nous|qui\u00e9nes somos|chi siamo)`;
const SECTION_HEADING_LINE = new RegExp(`^${SECTION_HEADING_SOURCE}$`, 'iu');
/** An employer-introduction heading that is a whole line: the fixed phrases, or "About <Name>". */
const INTRO_HEADING_LINE = new RegExp(
  String.raw`^(?:${INTRO_PHRASE_SOURCE}|about (?!the (?:role|job|position)\b|you\b|this\b)[\p{L}\p{N}&.'-]+(?: [\p{L}\p{N}&.'-]+){0,3})$`,
  'iu',
);
/** The fixed introduction phrases, also recognised as a prefix of running text. */
const INTRO_PHRASE_PREFIX = new RegExp(String.raw`^${INTRO_PHRASE_SOURCE}\b[\s:\u2013\u2014-]*`, 'iu');
/** A section heading that ends an introduction block, at the start of text or of a sentence or line. */
const SECTION_HEADING_INLINE = new RegExp(
  String.raw`(?:^|[\n.!?]\s*)${SECTION_HEADING_SOURCE}\s*(?::|\n|-)\s*`,
  'iu',
);
const CONTENT_KEY = /^(?:responsibilities|requirements|qualifications|summary|description|overview|role|about the role)$/iu;
const LABEL_TOKEN = /(?:^|\s)\p{Lu}[\p{L}/&'() -]{1,40}:\s/gu;

function stripTrailingColon(line: string): string {
  return line.replace(/\s*:\s*$/u, '');
}

/** `Key: short value`, as ATS-exported requisition metadata reads. A key such as "Responsibilities" is content. */
function isMetadataLine(line: string): boolean {
  const match = /^([^:\n]{2,50}):\s*(.*)$/u.exec(line);
  if (!match) return false;
  const key = match[1] ?? '';
  const value = match[2] ?? '';
  if (key.trim().split(/\s+/u).length > 6 || CONTENT_KEY.test(key.trim())) return false;
  return value.length <= 60 && !/[.!?]$/u.test(value);
}

/** What follows an employer-introduction heading, minus the introduction block itself. */
function skipIntroBlock(afterHeading: string): string {
  const heading = SECTION_HEADING_INLINE.exec(afterHeading);
  if (heading) return afterHeading.slice(heading.index + heading[0].length);
  // No later section heading to resume from: drop the introduction's first paragraph only.
  const newline = afterHeading.indexOf('\n');
  return newline === -1 ? '' : afterHeading.slice(newline + 1);
}

/**
 * Removes the leading boilerplate a vacancy description opens with, for the results-row preview
 * only: bare section headings, `Key: value` requisition metadata, and employer-introduction
 * blocks ("Who we are", "About <Company>"). Stops at the first line that is genuine content.
 */
function stripLeadingBoilerplate(description: string): string {
  let text = description.replace(/\r\n?/gu, '\n').trim();
  for (let guard = 0; guard < 40 && text.length > 0; guard += 1) {
    const newline = text.indexOf('\n');
    const line = (newline === -1 ? text : text.slice(0, newline)).trim();
    const afterLine = newline === -1 ? '' : text.slice(newline + 1).trimStart();

    if (line === '' || SECTION_HEADING_LINE.test(stripTrailingColon(line))) {
      text = afterLine;
    } else if (INTRO_HEADING_LINE.test(stripTrailingColon(line))) {
      text = skipIntroBlock(afterLine).trimStart();
    } else if (INTRO_PHRASE_PREFIX.test(line)) {
      text = skipIntroBlock(text.replace(INTRO_PHRASE_PREFIX, '')).trimStart();
    } else if (isMetadataLine(line)) {
      text = afterLine;
    } else if ((line.match(LABEL_TOKEN) ?? []).length >= 2) {
      // A flattened metadata run ("Type of Requisition: X Clearance Level: Y ..."): drop up to the
      // end of its first sentence, or all of it when no sentence ends.
      const end = /[.!?]\s/u.exec(text);
      text = end ? text.slice(end.index + end[0].length) : '';
    } else {
      break;
    }
  }
  return text;
}

/**
 * Single-line preview of `description` for the results-list card (issue: cards showed zero
 * role-content, so scanning 25 results meant opening each one individually to judge fit). The
 * stored `description` can now carry real paragraph breaks (`htmlToText` inserts a newline at every
 * block-tag boundary -- see `packages/vacancy-engine/src/global-remote/feed-discovery.ts`'s
 * `decodedText`), which the detail pane renders with `whitespace-pre-wrap`; collapsing them to
 * spaces here is purely a card-preview concern; it never mutates or re-derives the text the detail
 * pane shows. Leading boilerplate (`stripLeadingBoilerplate`, issue #463) is skipped, and what is
 * left must still read as a sentence (three words or more). Otherwise this returns null, so the
 * card never renders an empty line or a made-up summary.
 */
export function descriptionExcerpt(description: string | null): string | null {
  if (!description) return null;
  const collapsed = stripLeadingBoilerplate(description).replace(/\s+/gu, ' ').trim();
  return collapsed.split(' ').length >= 3 ? collapsed : null;
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
function toSearchResult(
  vacancy: DiscoveryVacancyAudit,
  official: OfficialVacancyAudit | null,
  provisional: boolean,
): SearchResult {
  return {
    raw: vacancy,
    official,
    provisional,
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
    // Passed through exactly as the raw row carries it -- undefined stays undefined (older report,
    // no such field) rather than being collapsed into null (scored, no breakdown) or vice versa.
    profileMatch: vacancy.profileMatch,
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
      // The real posting text the discovery result carries, null when the source had none. Passed
      // through as found so the CV workspace can show a missing or partial JD plainly instead of
      // working from a title alone. The discovery audit carries no separate requirement lines.
      description: vacancy.description,
      jdOrigin: 'found',
    },
  };
}

export function toWorldwideResults(report: GlobalRemoteReport): SearchResult[] {
  const officialByUrl = new Map<string, OfficialVacancyAudit>();
  for (const entry of report.officialAudit) officialByUrl.set(entry.url, entry);

  return report.discoveryAudit.map((vacancy) => toSearchResult(vacancy, officialByUrl.get(vacancy.url) ?? null, false));
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
  return vacancies.map((vacancy) => toSearchResult(vacancy, null, true));
}

export type PostedWithin = 'any' | '1' | '7' | '30';

const workArrangementCache = new WeakMap<SearchResult, WorkArrangementDetection>();

/**
 * The on-site/hybrid/remote hint for one result (#565a), worked out on first use and cached. Lazy
 * because scanning every description of a 20,000-row report up front takes seconds; only the rows
 * on screen, and every row once the hide filter is turned on, are ever scanned. Works for reports
 * saved before the hint existed.
 */
export function workArrangementOf(result: SearchResult): WorkArrangementDetection {
  if (result.workArrangement) return result.workArrangement;
  let detection = workArrangementCache.get(result);
  if (!detection) {
    detection = detectWorkArrangement({ title: result.title, location: result.location, description: result.description });
    workArrangementCache.set(result, detection);
  }
  return detection;
}

export interface SearchFilters {
  /** Role or keyword, matched against title and company. */
  query: string;
  /** City or region, matched against the row's location. */
  location: string;
  /** Keep only rows with a possible IND sponsor match (best-effort; see `worldwideVerification`). */
  sponsorOnly: boolean;
  /** Drop rows whose wording suggests on-site or hybrid work. Off by default; unknown stays. */
  hideOnsiteHybrid: boolean;
  /** Most sources still record no posting date at all -- a row with an unknown date is dropped
   * rather than kept when this filter is active, never assumed recent. */
  postedWithin: PostedWithin;
  /** The discovery source / feed id. */
  source: string;
  employment: string;
  /** Which country a vacancy's own `location` text normalizes to (see `countries.ts`). `'all'`
   * applies no filter. */
  country: string;
  /** Draft input, parsed only when a scan is submitted. */
  salaryMinimum: string;
  salaryCurrency: string;
  includeUnknownSalary: boolean;
}

export const DEFAULT_FILTERS: SearchFilters = {
  query: '',
  location: '',
  sponsorOnly: false,
  hideOnsiteHybrid: false,
  postedWithin: 'any',
  source: 'all',
  employment: 'any',
  country: 'all',
  salaryMinimum: '',
  salaryCurrency: 'EUR',
  includeUnknownSalary: true,
};

/** The backend `browse_all` request carries none of the scan-bound criteria (`query`, `country`,
 * `employment`, salary), so leaving them set in the client-side view would re-apply scoping that
 * was never honored server-side. `location`, `postedWithin`, and `source` are local refinements
 * independent of scan mode and pass through unchanged. `sponsorOnly` clears alongside `country`
 * resetting to `'all'` since it's only meaningful (and only shown) for the Netherlands. */
export function browseAllViewFilters(filters: SearchFilters): SearchFilters {
  const { query, country, employment, salaryMinimum, salaryCurrency, includeUnknownSalary, sponsorOnly } =
    DEFAULT_FILTERS;
  return { ...filters, query, country, employment, salaryMinimum, salaryCurrency, includeUnknownSalary, sponsorOnly };
}

/** What a saved report itself records about the search that produced it. */
export interface ReportSearchContext {
  /** `unknown` is a legacy report that recorded neither a scan mode nor focused criteria. */
  mode: 'focused' | 'browse_all' | 'unknown';
  role: string | null;
  country: string | null;
}

/**
 * Read the report's own search criteria. The per-source `focusedScan.requested` record holds the
 * role and country the scan was actually asked for. Nothing is guessed: a field the report does not
 * record stays `null`.
 */
export function reportSearchContext(report: GlobalRemoteReport): ReportSearchContext {
  const requested = report.discoverySources
    .map((source) => source.focusedScan?.requested)
    .filter((entry): entry is NonNullable<typeof entry> => entry !== undefined);
  if (report.scanBounds?.mode === 'browse_all') return { mode: 'browse_all', role: null, country: null };
  const role = requested.find((entry) => entry.role?.trim())?.role?.trim() ?? null;
  const country = requested.find((entry) => entry.country?.trim())?.country?.trim() ?? null;
  if (report.scanBounds?.mode === 'focused' || requested.length > 0) return { mode: 'focused', role, country };
  return { mode: 'unknown', role: null, country: null };
}

/** Local "2 Oct, 00:23" style stamp for when a report was generated. */
export function formatReportTimestamp(generatedAt: string): string {
  const date = new Date(generatedAt);
  if (Number.isNaN(date.getTime())) return '';
  const day = date.toLocaleDateString([], { day: 'numeric', month: 'short' });
  const time = date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  return `${day}, ${time}`;
}

/** The primary results line: what is shown, which saved search produced it, and when. */
export function describeReportSummary(report: GlobalRemoteReport, visibleCount: number): string {
  const context = reportSearchContext(report);
  const noun = visibleCount === 1 ? 'vacancy' : 'vacancies';
  let text = `${visibleCount} ${noun}`;
  if (context.mode === 'browse_all') text += ' · browse all';
  else {
    if (context.role) text += ` for ${context.role}`;
    if (context.country) text += ` in ${context.country}`;
  }
  const stamp = formatReportTimestamp(report.generatedAt);
  return stamp ? `${text} · searched ${stamp}` : text;
}

export function salaryCriteriaFromFilters(filters: SearchFilters): SalaryFilterCriteria | null {
  const minimumAnnual = parseMinimumAnnualSalary(filters.salaryMinimum ?? '');
  if (minimumAnnual === null) return null;
  return {
    minimumAnnual,
    currency: filters.salaryCurrency ?? 'EUR',
    includeUnknown: filters.includeUnknownSalary ?? true,
  };
}

export function salaryCounts(
  results: readonly SearchResult[],
  filters: SearchFilters,
): { comparable: number; unknown: number } {
  const criteria = salaryCriteriaFromFilters(filters);
  if (criteria === null) return { comparable: 0, unknown: 0 };
  let comparable = 0;
  let unknown = 0;
  for (const result of results) {
    const assessment = assessSalary(result.raw, criteria);
    if (assessment.kind === 'comparable' || assessment.kind === 'below_floor') comparable += 1;
    else if (assessment.kind === 'unknown') unknown += 1;
  }
  return { comparable, unknown };
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
    .flatMap((result) => result.raw.employmentTypes ?? (result.employmentType ? [result.employmentType] : []))
    .filter((value): value is string => !!value && value.trim().length > 0);
  return [...new Set(values)].sort((a, b) => a.localeCompare(b));
}

const MILLISECONDS_PER_DAY = 86_400_000;

export interface SearchResultIndexEntry {
  result: SearchResult;
  titleLower: string;
  companyLower: string;
  locationLower: string;
  descriptionLower: string;
  countries: string[];
  employmentTypes: string[];
  postedAtMs: number | null;
}

export function buildSearchResultIndex(results: SearchResult[]): SearchResultIndexEntry[] {
  return results.map((result) => ({
    result,
    titleLower: result.title.toLowerCase(),
    companyLower: result.company.toLowerCase(),
    locationLower: (result.location ?? '').toLowerCase(),
    descriptionLower: (result.description ?? '').toLowerCase(),
    countries: (result.raw.locations ?? [result.location ?? '']).map((location) => normalizeCountry(location)).filter((country): country is string => country !== null),
    employmentTypes: result.raw.employmentTypes ?? (result.employmentType ? [result.employmentType] : []),
    postedAtMs: postedAtTimestamp(result.postedAt),
  }));
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
  return filterSearchResultIndex(buildSearchResultIndex(results), filters, now).map((entry) => entry.result);
}

export function filterSearchResultIndex(
  index: SearchResultIndexEntry[],
  filters: SearchFilters,
  now: Date = new Date(),
): SearchResultIndexEntry[] {
  const query = filters.query.trim().toLowerCase();
  const location = filters.location.trim().toLowerCase();
  const maximumAgeMs = filters.postedWithin === 'any' ? null : Number(filters.postedWithin) * MILLISECONDS_PER_DAY;
  const nowMs = now.getTime();
  const salary = salaryCriteriaFromFilters(filters);

  return index.filter((entry) => {
    if (query && queryMatchTier(entry, query) === 0) return false;

    if (location && !entry.locationLower.includes(location)) return false;

    if (filters.source !== 'all' && entry.result.provider !== filters.source) return false;

    if (filters.sponsorOnly && entry.result.raw.worldwideSponsorMatch === null) return false;

    if (filters.hideOnsiteHybrid && isOnsiteOrHybrid(workArrangementOf(entry.result).arrangement)) return false;

    if (maximumAgeMs !== null) {
      // A row with no known posting date cannot satisfy "posted in the last N days". It is dropped
      // rather than kept, so the narrowed list means exactly what it says; the filter bar states it.
      if (entry.postedAtMs === null) return false;
      if (nowMs - entry.postedAtMs > maximumAgeMs) return false;
    }

    if (filters.employment !== 'any' && !entry.employmentTypes.includes(filters.employment)) return false;

    if (filters.country !== 'all') {
      if (filters.country === UNSPECIFIED_LOCATION ? entry.countries.length !== 0 : !entry.countries.includes(filters.country)) return false;
    }

    if (salary !== null) {
      const assessment = assessSalary(entry.result.raw, salary);
      if (assessment.kind === 'below_floor') return false;
      if (assessment.kind === 'unknown' && !salary.includeUnknown) return false;
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
 * How strongly `entry` matches `normalizedQuery` (issue #395): also what `filterSearchResultIndex`
 * above uses to decide whether a row passes the query filter at all (tier `0` means no match), so a
 * row's rank can never disagree with whether that same row was included in the first place. Title
 * and company are checked ahead of description, and an exact match ahead of a substring one, on the
 * theory that a query landing on the role or employer itself is a much stronger relevance signal
 * than one that only happens to appear somewhere in free-text copy.
 */
function queryMatchTier(entry: SearchResultIndexEntry, normalizedQuery: string): number {
  if (entry.titleLower === normalizedQuery || entry.companyLower === normalizedQuery) return 4;
  if (entry.titleLower.includes(normalizedQuery)) return 3;
  if (entry.companyLower.includes(normalizedQuery)) return 2;
  if (entry.descriptionLower.includes(normalizedQuery)) return 1;
  return 0;
}

/**
 * Scored rows always come before unscored rows (issue #464). Mixing the two through a posting-date
 * fallback made the order non-transitive: a scored and an unscored row compared by date, while two
 * scored rows compared by score, so a recent unscored row could land above 98-score rows. Within
 * the scored group: highest profile score first. Within the unscored group -- the Search Profile
 * has no target roles or strongest skills configured, or the rows are still streaming in -- and
 * only when a `query` was actually submitted, a query-match tier (`queryMatchTier`) orders rows by
 * how well they match what was searched for (issue #395). Remaining ties: most recently posted
 * first, a row with no known posting date after every row that has one (never assumed recent),
 * then title, then key so the order is total and stable.
 */
export function sortResults(results: SearchResult[], query = ''): SearchResult[] {
  return sortSearchResultIndex(buildSearchResultIndex(results), query);
}

export function sortSearchResultIndex(index: SearchResultIndexEntry[], query = ''): SearchResult[] {
  const normalizedQuery = query.trim().toLowerCase();
  return [...index].sort((left, right) => {
    const leftResult = left.result;
    const rightResult = right.result;
    const leftScore = leftResult.profileScore;
    const rightScore = rightResult.profileScore;
    if ((leftScore == null) !== (rightScore == null)) return leftScore == null ? 1 : -1;
    if (leftScore != null && rightScore != null && leftScore !== rightScore) return rightScore - leftScore;
    if (leftScore == null && rightScore == null && normalizedQuery) {
      const tierDiff = queryMatchTier(right, normalizedQuery) - queryMatchTier(left, normalizedQuery);
      if (tierDiff !== 0) return tierDiff;
    }
    const leftPosted = left.postedAtMs;
    const rightPosted = right.postedAtMs;
    if (leftPosted !== null && rightPosted !== null && leftPosted !== rightPosted) {
      return rightPosted - leftPosted;
    }
    if ((leftPosted === null) !== (rightPosted === null)) {
      return leftPosted === null ? 1 : -1;
    }
    return leftResult.title.localeCompare(rightResult.title) || leftResult.key.localeCompare(rightResult.key);
  }).map((entry) => entry.result);
}

/**
 * Keys that more than one row in `results` carries. `SearchResult.key` is the identity for React
 * rendering, selection and `savedJobs.vacancyKey`, so a repeated key means two rows fight over one
 * slot (issue #464). Rows that merely share a title and company are distinct vacancies and never
 * count here.
 */
export function duplicateResultKeys(results: readonly SearchResult[]): string[] {
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const result of results) {
    if (seen.has(result.key)) duplicates.add(result.key);
    seen.add(result.key);
  }
  return [...duplicates];
}

/** Keeps the first row for each `key` and drops later repeats of the same key only. */
export function dedupeResultsByKey(results: SearchResult[]): SearchResult[] {
  if (duplicateResultKeys(results).length === 0) return results;
  const seen = new Set<string>();
  return results.filter((result) => {
    if (seen.has(result.key)) return false;
    seen.add(result.key);
    return true;
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

/** The score always carries its scale: a bare number reads as a CV match or a percentage. */
export function profileFitText(score: number): string {
  return `Profile fit ${score}/100`;
}

/** The same label as `profileFitText`, spelled out for screen readers. */
export function profileFitSpoken(score: number): string {
  return `Profile fit ${score} out of 100`;
}

/** At most three matching signals and two gaps, exactly as the scorer returned them (issue #452). */
export function fitHighlights(match: ProfileMatchBreakdown | null | undefined): {
  signals: string[];
  gaps: string[];
} {
  return { signals: match?.matchingSkills.slice(0, 3) ?? [], gaps: match?.gaps.slice(0, 2) ?? [] };
}
