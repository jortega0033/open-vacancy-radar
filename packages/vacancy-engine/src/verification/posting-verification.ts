import { createHash } from 'node:crypto';
import { AtsResponseError, type AtsHttpClient, type AtsHttpRequestOptions, type AtsHttpResponse } from '../ats/http.js';
import { decodeEscapedMarkup, htmlToText } from '../ats/shared.js';
import { isCrawlerHttpError } from '../crawler/errors.js';
import { jobgetherOfferIdFromUrl, workableJobReferenceFromUrl } from '../global-remote/structured-discovery.js';

/**
 * One bounded, authoritative check of a single posting that is about to be prepared or resumed (#687).
 *
 * What this is NOT: a feed refresh, a crawler, or a new source permission. It reads the SAME public
 * job-board API origin the app's own adapter for that provider already reads, through the shared
 * SafeHttpClient policy (public-address check, origin boundary, size cap), with no retries. Anything
 * it cannot recognise gets NO request and is reported as "unable to verify", never as closed.
 *
 * The request envelope is finite and enforced, not just described (see `POSTING_REQUEST_ENVELOPE`):
 * one logical GET to the single-posting route (two for an account-less Workable short link, whose
 * account is looked up first), a small per-request redirect cap, `maxRetries: 0`, and ONE deadline
 * over the whole check that aborts the real request -- DNS, a scheduler slot it is still queued for,
 * and the in-flight fetch -- rather than only abandoning a promise.
 *
 * The CPU spent on the remote text is bounded separately and by construction: every regular
 * expression applied to remote text is linear (no adjacent overlapping quantifiers, bounded classes),
 * the text is capped at `POSTING_TEXT_MAX_CHARS`, and the line comparison has a fixed work budget
 * (`comparePostingText`). A deadline can stop network work; it cannot stop synchronous CPU work, so
 * that is never what bounds it.
 *
 * The distinction the whole feature turns on, after the upstream rank lifecycle
 * (ai-job-search `rank.md`: positive closure vs. failed retrieval vs. stored deadlines, MIT):
 *   - `closed`  = the authoritative endpoint positively says this posting does not exist (404/410,
 *                 Workable's `/oops`), or its whole payload is nothing but an unqualified closure notice.
 *   - `open`    = the authoritative endpoint returned the posting.
 *   - `unable`  = everything else. A timeout, a 401/403/login wall, a rate limit, a server error or
 *                 an unrecognised page is the ABSENCE of an answer and is never evidence of closure.
 */

/** A result younger than this is reused with its ORIGINAL observation time and costs no request. */
export const POSTING_FRESHNESS_WINDOW_MS = 24 * 60 * 60 * 1000;
/** An "unable to verify" is never fresh proof; it may be retried after this, or on an explicit check. */
export const POSTING_UNABLE_RETRY_AFTER_MS = 15 * 60 * 1000;
/**
 * Deadline over one whole check (every hop, DNS and scheduler wait included). Reaching it aborts the
 * underlying request through its AbortSignal; it is not a cap on CPU work (that is bounded by design).
 */
export const POSTING_VERIFY_TIMEOUT_MS = 20_000;
/** A stored comparison copy of a changed posting is capped; nothing longer is read or retained. */
export const POSTING_TEXT_MAX_CHARS = 120_000;

/**
 * The finite request envelope of one check, as enforced by the options passed to the HTTP client.
 * `physical` counts real network fetches (each redirect hop is one); `logical` counts client calls.
 */
export const POSTING_REQUEST_ENVELOPE = {
  maxRetries: 0,
  /** Redirect hops allowed on the single-posting route itself (same origin only). */
  detailMaxRedirects: 1,
  /** Redirect hops allowed while an account-less Workable short link is resolved (same origin only). */
  lookupMaxRedirects: 2,
  /** Every source except an account-less Workable short link. */
  standard: { logical: 1, physical: 2 },
  /** Account-less Workable short link: lookup (1 + 2 hops) then the detail route (1 + 1 hop). */
  workableShortLink: { logical: 2, physical: 5 },
  deadlineMs: POSTING_VERIFY_TIMEOUT_MS,
} as const;

export type PostingSource = 'greenhouse' | 'lever' | 'workable' | 'jobgether';
export type PostingObservationOutcome = 'open' | 'closed' | 'unable';

export type PostingObservationReason =
  | 'verified_open'
  | 'not_modified'
  | 'not_found'
  | 'gone'
  | 'closure_notice'
  | 'account_not_found'
  | 'no_authoritative_source'
  | 'timeout'
  | 'denied'
  | 'rate_limited'
  | 'server_error'
  | 'network_error'
  | 'login_wall'
  | 'redirected_elsewhere'
  | 'unexpected_response'
  | 'empty_content'
  /** The payload exceeds the parsing budget (`POSTING_MARKUP_BUDGET`); it was not parsed. Never closure. */
  | 'content_too_large'
  /** The check itself could not run (for example its HTTP client could not be set up). Never closure. */
  | 'check_failed';

export interface PostingValidators {
  etag?: string | undefined;
  lastModified?: string | undefined;
}

export interface PostingDeadline {
  /** `YYYY-MM-DD`, exactly as the posting states it. */
  date: string;
  provenance: { source: 'posting_text'; excerpt: string };
}

export interface PostingObservation {
  /** ISO-8601 time this observation was made (the time of the request, not of any later reuse). */
  observedAt: string;
  source: PostingSource | 'none';
  /** Host and route shape only (no ids, no query): safe to show and to log. */
  sourceRef: string;
  outcome: PostingObservationOutcome;
  reason: PostingObservationReason;
  httpStatus: number | null;
  /** The posting text as the authority returned it; null unless `outcome === 'open'` and not a bare 304. */
  text: string | null;
  /** sha256 of the NORMALISED text (see `normalizePostingText`); null without text. */
  contentHash: string | null;
  validators: PostingValidators | null;
  /** The origin confirmed the stored validators are still current; `text` may be null (no-store sources). */
  notModified: boolean;
  /** A deadline the posting explicitly states. Null = none stated; it is never inferred. */
  deadline: PostingDeadline | null;
  /** HTTP client calls this check made (logical requests; redirect hops are not counted here). */
  logicalRequests: number;
}

export interface PostingProbe {
  source: PostingSource;
  sourceRef: string;
  /** Account-less Workable links need one lookup before the detail route is known. */
  endpoint: string | null;
  allowedOrigin: string;
  cache: 'default' | 'no-store';
}

const GREENHOUSE_HOSTS = new Set(['boards.greenhouse.io', 'job-boards.greenhouse.io']);
const LEVER_HOSTS = new Map([
  ['jobs.lever.co', 'https://api.lever.co'],
  ['jobs.eu.lever.co', 'https://api.eu.lever.co'],
]);
const SAFE_TOKEN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;

function parseHttps(url: string): URL | null {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:' && parsed.username === '' && parsed.password === '' ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Recognises a posting URL whose provider has an official, read-only single-posting route on an
 * origin this app already reads. Pure: no I/O, so "no probe" provably means "no request".
 */
export function resolvePostingProbe(url: string): PostingProbe | null {
  const offerId = jobgetherOfferIdFromUrl(url);
  if (offerId !== null && parseHttps(url)?.hostname.toLowerCase() === 'jobgether.com') {
    return {
      source: 'jobgether',
      sourceRef: 'jobgether.com/astroapi/offer/{id}',
      endpoint: `https://jobgether.com/astroapi/offer/${encodeURIComponent(offerId)}.json`,
      allowedOrigin: 'https://jobgether.com',
      cache: 'no-store',
    };
  }
  const workable = workableJobReferenceFromUrl(url);
  if (workable !== null) {
    return {
      source: 'workable',
      sourceRef: 'apply.workable.com/api/v2/accounts/{account}/jobs/{id}',
      endpoint:
        workable.account === null
          ? null
          : `https://apply.workable.com/api/v2/accounts/${encodeURIComponent(workable.account)}/jobs/${encodeURIComponent(workable.shortcode)}`,
      allowedOrigin: 'https://apply.workable.com',
      cache: 'no-store',
    };
  }
  const parsed = parseHttps(url);
  if (parsed === null) return null;
  const host = parsed.hostname.toLowerCase();
  const segments = parsed.pathname.split('/').filter((segment) => segment.length > 0);
  if (GREENHOUSE_HOSTS.has(host) && segments.length >= 3 && segments[1] === 'jobs') {
    const [board = '', , id = ''] = segments;
    if (SAFE_TOKEN.test(board) && /^\d{1,20}$/u.test(id)) {
      return {
        source: 'greenhouse',
        sourceRef: 'boards-api.greenhouse.io/v1/boards/{board}/jobs/{id}',
        endpoint: `https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(board)}/jobs/${encodeURIComponent(id)}`,
        allowedOrigin: 'https://boards-api.greenhouse.io',
        cache: 'default',
      };
    }
  }
  const leverOrigin = LEVER_HOSTS.get(host);
  if (leverOrigin !== undefined && segments.length >= 2) {
    const [site = '', id = ''] = segments;
    if (SAFE_TOKEN.test(site) && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(id)) {
      return {
        source: 'lever',
        sourceRef: `${new URL(leverOrigin).host}/v0/postings/{site}/{id}`,
        endpoint: `${leverOrigin}/v0/postings/${encodeURIComponent(site)}/${encodeURIComponent(id)}`,
        allowedOrigin: leverOrigin,
        cache: 'default',
      };
    }
  }
  return null;
}

// ------------------------------------------------------------------------------ text handling
//
// Every expression below runs on remote text, so each one is linear in its input: single character
// classes with one quantifier, literal alternatives, or bounded `{m,n}` runs. Nothing has two
// quantified runs that can match the same characters next to each other.

/** Case, markup, entities, whitespace and punctuation folded away: only the words and numbers remain. */
export function normalizePostingText(text: string): string {
  return text
    .slice(0, POSTING_TEXT_MAX_CHARS)
    .normalize('NFKC')
    .toLowerCase()
    .replace(/<[^<>]{0,512}>/gu, ' ')
    .replace(/&[a-z0-9#]{1,12};/gu, ' ')
    .replace(/[^\p{L}\p{N}+#]+/gu, ' ')
    .trim();
}

export function postingContentHash(text: string): string {
  return createHash('sha256').update(normalizePostingText(text)).digest('hex');
}

/**
 * Prose is only trusted as a closure when the authority's payload is essentially nothing but an
 * unqualified closure notice: its first line IS one of these sentences (anchored, whole line), the
 * whole normalised text is short, and nothing in it qualifies or reopens the role. Wording such as
 * "closed to applicants without EU work authorisation", "closed in the US but open in Canada",
 * "closed to external candidates" or "filled internally in the past; we are hiring again" is an open
 * posting. The authoritative signals (404/410, Workable `/oops`) need no prose at all.
 */
const CLOSURE_SENTENCES: readonly RegExp[] = [
  /^(?:we are |we re )?no longer accepting applications(?: for this (?:job|position|role|posting|vacancy))?$/u,
  /^(?:this|the) (?:job|position|posting|role|vacancy|requisition|opening|job posting|job opening) (?:is|has been|was) (?:no longer (?:available|open|active)|closed|filled|expired|removed|withdrawn)(?: and is no longer (?:available|open|active))?$/u,
  /^(?:applications|hiring) (?:for this (?:job|position|role|posting|vacancy) )?(?:is|are|has|have) (?:now )?closed$/u,
  /^(?:this )?(?:job|position|posting) (?:not found|no longer exists|has expired)$/u,
];
const CLOSURE_PAYLOAD_MAX_NORMALIZED_CHARS = 300;
const REOPENING =
  /\b(?:hiring again|re ?opened|reopening|still open|still accepting|remains open|apply now|apply here|apply if|open to|open in|open for|other (?:roles|positions|openings|jobs)|until|except|unless|only for|internal(?:ly)?|external)\b/u;

function closureNoticeOnly(text: string): boolean {
  const all = normalizePostingText(text);
  if (all.length === 0 || all.length > CLOSURE_PAYLOAD_MAX_NORMALIZED_CHARS) return false;
  const firstLine = text
    .slice(0, 2_000)
    .split('\n')
    .map((line) => normalizePostingText(line))
    .find((line) => line.length > 0);
  if (firstLine === undefined || firstLine.length > 160) return false;
  if (!CLOSURE_SENTENCES.some((pattern) => pattern.test(firstLine))) return false;
  return !REOPENING.test(all);
}

const MONTHS = [
  'january', 'february', 'march', 'april', 'may', 'june',
  'july', 'august', 'september', 'october', 'november', 'december',
];
/** Literal cue phrases on whitespace-collapsed text: no quantifier at all, so matching is linear. */
const DEADLINE_CUE =
  /\b(?:apply by|apply before|apply until|application deadline|closing date|closes on|close on|deadline|applications close|applications closes|application closes|applications are open until|applications accepted until|applications are accepted until|submit your application by|submit your application before|submit application by|submit application before)\b/giu;
/** At most this many cue phrases are inspected per posting. */
const MAX_DEADLINE_CUES = 8;
const DEADLINE_VALUE_WINDOW = 80;

function isoDate(year: number, month: number, day: number): string | null {
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null;
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function parseExplicitDate(value: string): string | null {
  const iso = /\b(\d{4})-(\d{2})-(\d{2})\b/u.exec(value);
  if (iso) return isoDate(Number(iso[1]), Number(iso[2]), Number(iso[3]));
  const dayFirst = /\b(\d{1,2})(?:st|nd|rd|th)? {1,3}(?:of {1,3})?([a-z]{3,9})\.?,? {1,3}(\d{4})\b/iu.exec(value);
  const monthFirst = /\b([a-z]{3,9})\.? {1,3}(\d{1,2})(?:st|nd|rd|th)?,? {1,3}(\d{4})\b/iu.exec(value);
  const monthIndex = (name: string): number => {
    const lower = name.toLowerCase();
    return MONTHS.findIndex((month) => month === lower || (lower.length >= 3 && month.startsWith(lower))) + 1;
  };
  if (dayFirst) {
    const month = monthIndex(dayFirst[2]!);
    return month === 0 ? null : isoDate(Number(dayFirst[3]), month, Number(dayFirst[1]));
  }
  if (monthFirst) {
    const month = monthIndex(monthFirst[1]!);
    return month === 0 ? null : isoDate(Number(monthFirst[3]), month, Number(monthFirst[2]));
  }
  // Numeric day/month orders such as 03/04/2026 are ambiguous and are deliberately left unknown.
  return null;
}

/** The value a cue introduces, read from a fixed window after it with anchored, bounded steps. */
function deadlineValue(window: string): string | null {
  let value = window;
  value = value.replace(/^ ?(?:is|for applications is|for application is)\b/iu, '');
  value = value.replace(/^ ?[:\-–]/u, '');
  value = value.replace(/^ ?on\b/iu, '');
  value = value.trimStart();
  const stop = value.search(/[;()]|\. /u);
  value = (stop === -1 ? value : value.slice(0, stop)).slice(0, 40).trim();
  return value.length >= 4 ? value : null;
}

/**
 * A deadline the posting text itself states, with the sentence it came from. Returns null when none is
 * stated: a missing deadline is "no deadline stated", never a date derived from a posted or first-seen time.
 * Linear in the text: one whitespace collapse, one literal-phrase scan, then fixed-size windows.
 */
export function parseStatedDeadline(text: string): PostingDeadline | null {
  const flat = text.slice(0, POSTING_TEXT_MAX_CHARS).replace(/\s+/gu, ' ');
  let inspected = 0;
  for (const match of flat.matchAll(DEADLINE_CUE)) {
    inspected += 1;
    if (inspected > MAX_DEADLINE_CUES) break;
    const end = (match.index ?? 0) + match[0].length;
    const value = deadlineValue(flat.slice(end, end + DEADLINE_VALUE_WINDOW));
    if (value === null) continue;
    const date = parseExplicitDate(value);
    if (date === null) continue;
    return {
      date,
      provenance: { source: 'posting_text', excerpt: `${match[0]} ${value}`.trim().slice(0, 160) },
    };
  }
  return null;
}

// ------------------------------------------------------------------------------ comparison

export type PostingChangeKind = 'same' | 'minor' | 'text' | 'requirements';

export interface PostingTextComparison {
  /** Same words and numbers after normalisation (formatting, markup and punctuation ignored). */
  same: boolean;
  /** A change the person must see before work prepared from the earlier text is used. */
  material: boolean;
  /** A changed line carries a requirement signal (experience, language, location, pay, authorisation...). */
  requirementChange: boolean;
  /**
   * `requirements`: requirement-bearing lines changed. `text`: a large share of the posting changed but
   * no requirement signal was found (shown as "text changed", never as "requirements changed").
   * `minor`: wording that changes nothing for the application. `same`: identical after normalisation.
   */
  kind: PostingChangeKind;
  /** The fixed comparison budget was reached; unpaired lines were counted as changed (conservative). */
  bounded: boolean;
  added: string[];
  removed: string[];
}

const MATERIAL_SHARE = 0.2;
const MAX_REPORTED_LINES = 6;
const MAX_REPORTED_CHARS = 240;
/** At most this many character edits is a typo/spelling fix; "five" -> "eight" is a requirement change. */
const TYPO_MAX_EDITS = 2;
/** More changed lines than this on either side: no typo pairing at all (the rewrite speaks for itself). */
const PAIRING_MAX_LINES = 400;
/** Total dynamic-programming cells all typo pairing may compute for one comparison. */
const PAIRING_MAX_CELLS = 1_500_000;

const NUMBER_WORDS = new Set([
  'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten',
  'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'twenty',
]);
const YEAR_WORDS = new Set(['year', 'years', 'yr', 'yrs']);
/** "Founded 12 years ago", "a 30-year-old company", "10 years of history" are not experience. */
const NOT_EXPERIENCE_AFTER_YEARS = new Set(['ago', 'old', 'young', 'running', 'history', 'anniversary', 'existence', 'growth', 'together', 'strong']);
const EXPERIENCE_FOLLOWERS = new Set([
  'with', 'in', 'of', 'using', 'building', 'working', 'as', 'at', 'designing', 'developing', 'leading', 'managing',
  'delivering', 'running', 'writing', 'operating', 'shipping',
]);
/** Always requirement-bearing, wherever they appear. */
const STRONG_WORDS = new Set([
  // explicit requirements
  'must', 'required', 'require', 'requires', 'requirement', 'requirements', 'mandatory', 'essential', 'minimum',
  'prerequisite', 'prerequisites', 'qualification', 'qualifications',
  // work authorisation
  'visa', 'visas', 'sponsorship', 'citizenship', 'clearance',
  // language
  'fluent', 'fluency', 'fluently', 'bilingual', 'a1', 'a2', 'b1', 'b2', 'c1', 'c2',
  // where / how the work happens
  'remote', 'remotely', 'hybrid', 'onsite', 'relocate', 'relocation', 'relocating', 'timezone', 'timezones',
  // pay
  'salary', 'salaries', 'compensation', 'wage', 'wages', 'remuneration', 'equity',
  'eur', 'usd', 'gbp', 'chf', 'sek', 'nok', 'dkk', 'pln', 'czk', 'huf', 'php', 'inr', 'cad', 'aud',
  // contract
  'freelance', 'freelancer', 'contractor', 'contract', 'permanent', 'temporary', 'internship', 'apprenticeship',
  // education / certification
  'degree', 'degrees', 'bachelor', 'bachelors', 'msc', 'bsc', 'phd', 'doctorate', 'diploma', 'certification',
  'certifications', 'certificate', 'license', 'licence', 'licensed',
]);
const STRONG_PHRASES = [
  'right to work', 'work permit', 'work authorisation', 'work authorization', 'authorised to work', 'authorized to work',
  'eligible to work', 'native speaker', 'on site', 'time zone', 'based in', 'located in', 'full time', 'part time',
  'fixed term', 'pay range', 'pay band', 'pay scale', 'per hour', 'per annum', 'per year', 'per month', 'hourly rate',
  'day rate', 'daily rate', 'in the office', 'at the office', 'from the office',
];
/** Requirement-bearing only outside a section that is plainly about the company, perks or duties. */
const CONTEXT_WORDS = new Set([
  'skills', 'skill', 'proficient', 'proficiency', 'expertise', 'familiarity',
  'sponsor', 'sponsored', 'citizen', 'citizens', 'location', 'locations', 'commute', 'stipend', 'certified', 'accredited',
  'english', 'dutch', 'german', 'french', 'spanish', 'italian', 'portuguese', 'polish', 'swedish', 'danish',
  'norwegian', 'finnish', 'czech', 'slovak', 'hungarian', 'romanian', 'greek', 'turkish', 'russian', 'ukrainian',
  'arabic', 'hebrew', 'hindi', 'mandarin', 'chinese', 'cantonese', 'japanese', 'korean', 'vietnamese', 'thai',
  'indonesian', 'malay', 'tagalog', 'filipino', 'flemish',
]);
const CONTEXT_PHRASES = ['knowledge of', 'familiar with', 'hands on'];
const CURRENCY_AMOUNT = /[€$£¥] ?\d|\d ?(?:€|k€)/u;
const DAY_WORDS = new Set(['day', 'days']);

const REQUIREMENT_HEADINGS = [
  'requirements', 'requirement', 'qualifications', 'qualification', 'must have', 'must haves', 'nice to have',
  'nice to haves', 'what you bring', 'what you will bring', 'what you ll bring', 'who you are', 'about you', 'you have',
  'you bring', 'looking for', 'what you need', 'what you ll need', 'what you will need', 'your background',
  'your profile', 'profile', 'skills', 'experience', 'what we expect', 'we expect',
];
const OTHER_HEADINGS = [
  'about us', 'about the company', 'who we are', 'benefits', 'perks', 'what we offer', 'we offer', 'our offer',
  'why join us', 'why us', 'responsibilities', 'what you ll do', 'what you will do', 'the role', 'about the role',
  'your role', 'our culture', 'culture', 'how to apply', 'equal opportunity', 'diversity', 'our mission', 'our story',
];

type Section = 'requirements' | 'other' | 'unknown';

interface AnalysedLine {
  original: string;
  normalized: string;
  digits: string;
  requirement: boolean;
}

function padded(normalized: string): string {
  return ` ${normalized} `;
}

function hasPhrase(paddedLine: string, phrases: readonly string[]): boolean {
  return phrases.some((phrase) => paddedLine.includes(` ${phrase} `));
}

function isNumberToken(token: string): boolean {
  return /^\d{1,2}\+?$/u.test(token) || NUMBER_WORDS.has(token);
}

/** Token scan for requirement signals: linear, no regular expression over the whole line. */
function requirementSignal(original: string, normalized: string, tokens: readonly string[], section: Section): boolean {
  const line = padded(normalized);
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]!;
    if (STRONG_WORDS.has(token)) return true;
    // "5+ years of TypeScript", "Five years experience" -- but not "founded 12 years ago".
    if (isNumberToken(token)) {
      let next = index + 1;
      if (tokens[next] === '+') next += 1;
      if (YEAR_WORDS.has(tokens[next] ?? '') && !NOT_EXPERIENCE_AFTER_YEARS.has(tokens[next + 1] ?? '')) return true;
      // "3 days a week in the office"
      if (DAY_WORDS.has(tokens[next] ?? '') && (tokens[next + 1] === 'per' || tokens[next + 1] === 'a')) return true;
    }
    if (
      section !== 'other' &&
      (token === 'experience' || token === 'experienced') &&
      EXPERIENCE_FOLLOWERS.has(tokens[index + 1] ?? '')
    ) {
      return true;
    }
    if (section !== 'other' && CONTEXT_WORDS.has(token)) return true;
  }
  if (hasPhrase(line, STRONG_PHRASES)) return true;
  if (section !== 'other' && hasPhrase(line, CONTEXT_PHRASES)) return true;
  if (section === 'requirements') return true;
  return section !== 'other' && CURRENCY_AMOUNT.test(original);
}

function headingSection(original: string, normalized: string, tokens: readonly string[]): Section | null {
  if (tokens.length === 0 || tokens.length > 7) return null;
  const explicitHeading = original.trimEnd().endsWith(':');
  const line = padded(normalized);
  const exact = (phrases: readonly string[]) => phrases.includes(normalized);
  if (explicitHeading ? hasPhrase(line, REQUIREMENT_HEADINGS) : exact(REQUIREMENT_HEADINGS)) return 'requirements';
  if (explicitHeading ? hasPhrase(line, OTHER_HEADINGS) : exact(OTHER_HEADINGS)) return 'other';
  return null;
}

function analyseLines(text: string): AnalysedLine[] {
  const lines: AnalysedLine[] = [];
  let section: Section = 'unknown';
  for (const raw of text.slice(0, POSTING_TEXT_MAX_CHARS).split(/\n+|(?<=[.!?])\s+/u)) {
    const original = raw.trim();
    const normalized = normalizePostingText(original);
    if (normalized.length < 3) continue;
    const tokens = normalized.split(' ');
    const heading = headingSection(original, normalized, tokens);
    if (heading !== null) {
      section = heading;
      // A heading line itself is structure, not a requirement; it still counts as a changed line.
      lines.push({ original, normalized, digits: '', requirement: false });
      continue;
    }
    lines.push({
      original,
      normalized,
      digits: tokens.filter((token) => /\d/u.test(token) || NUMBER_WORDS.has(token)).sort().join(','),
      requirement: requirementSignal(original, normalized, tokens, section),
    });
  }
  return lines;
}

/** Mutable work budget shared by every pairing attempt of one comparison. */
interface PairingBudget {
  cells: number;
  exhausted: boolean;
}

/**
 * Whether two lines are within `TYPO_MAX_EDITS` character edits. Common prefix and suffix are stripped
 * first, then a banded Levenshtein (width 2k+1) stops as soon as a whole band row exceeds k. Every cell
 * computed is charged to the shared budget; an exhausted budget answers "not a typo" (conservative).
 */
function withinTypoDistance(left: string, right: string, budget: PairingBudget): boolean {
  const k = TYPO_MAX_EDITS;
  let start = 0;
  while (start < left.length && start < right.length && left[start] === right[start]) start += 1;
  let leftEnd = left.length;
  let rightEnd = right.length;
  while (leftEnd > start && rightEnd > start && left[leftEnd - 1] === right[rightEnd - 1]) {
    leftEnd -= 1;
    rightEnd -= 1;
  }
  const a = left.slice(start, leftEnd);
  const b = right.slice(start, rightEnd);
  if (Math.abs(a.length - b.length) > k) return false;
  if (a.length === 0 || b.length === 0) return Math.max(a.length, b.length) <= k;
  const width = 2 * k + 1;
  if (budget.cells + a.length * width > PAIRING_MAX_CELLS) {
    budget.exhausted = true;
    return false;
  }
  const big = k + 1;
  // Two reused rows; only the band (and one sentinel on each side) is ever written or read, so a
  // pair costs O(band x rows), never O(length^2) and never a fresh allocation.
  if (scratchPrevious.length < b.length + 2) {
    scratchPrevious = new Int32Array(b.length + 2);
    scratchCurrent = new Int32Array(b.length + 2);
  }
  let previous = scratchPrevious;
  let current = scratchCurrent;
  for (let j = 0; j <= Math.min(b.length, k); j += 1) previous[j] = j;
  if (k + 1 <= b.length) previous[k + 1] = big;
  for (let i = 1; i <= a.length; i += 1) {
    const from = Math.max(1, i - k);
    const to = Math.min(b.length, i + k);
    current[from - 1] = from - 1 === 0 && i <= k ? i : big;
    let rowMin = current[from - 1]!;
    for (let j = from; j <= to; j += 1) {
      const cost = a.charCodeAt(i - 1) === b.charCodeAt(j - 1) ? 0 : 1;
      const value = Math.min(previous[j]! + 1, current[j - 1]! + 1, previous[j - 1]! + cost, big);
      current[j] = value;
      if (value < rowMin) rowMin = value;
    }
    if (to + 1 <= b.length) current[to + 1] = big;
    budget.cells += to - from + 2;
    if (rowMin > k) return false;
    const swap = previous;
    previous = current;
    current = swap;
  }
  return previous[b.length]! <= k;
}

let scratchPrevious = new Int32Array(256);
let scratchCurrent = new Int32Array(256);

/**
 * Whether a re-read posting differs from the text the work was prepared against, and whether that
 * difference is one a person must see before documents prepared from the earlier text are used.
 *
 * - Formatting, markup, whitespace, capitalisation, punctuation and line order never count.
 * - A typo fix (a line within two character edits with the same numbers) never counts.
 * - A changed line with a requirement signal (years of experience, "required", work authorisation,
 *   language, work mode/location, pay, contract type, degree/certification, skills in a requirements
 *   context, or any line under a requirements heading) is a requirement change.
 * - A rewrite touching at least a fifth of the lines with no requirement signal is reported as a text
 *   change: material (the person decides), but never described as changed requirements.
 * - Company blurb, "founded 12 years ago", office and perk wording alone are not material.
 *
 * Cost is bounded: everything is linear in the (capped) text except typo pairing, which only compares
 * lines with equal number signatures and lengths within two characters and stops at a fixed cell budget.
 */
export function comparePostingText(baseline: string, observed: string): PostingTextComparison {
  if (normalizePostingText(baseline) === normalizePostingText(observed)) {
    return { same: true, material: false, requirementChange: false, kind: 'same', bounded: false, added: [], removed: [] };
  }
  const baselineLines = analyseLines(baseline);
  const observedLines = analyseLines(observed);
  const baselineSet = new Set(baselineLines.map((line) => line.normalized));
  const observedSet = new Set(observedLines.map((line) => line.normalized));
  let removed = baselineLines.filter((line) => !observedSet.has(line.normalized));
  let added = observedLines.filter((line) => !baselineSet.has(line.normalized));

  const budget: PairingBudget = { cells: 0, exhausted: false };
  if (removed.length > PAIRING_MAX_LINES || added.length > PAIRING_MAX_LINES) {
    budget.exhausted = true;
  } else if (removed.length > 0 && added.length > 0) {
    // Candidates indexed by number signature, then by length: a pair more than two characters apart
    // in length, or with different numbers, is never even considered.
    const index = new Map<string, Map<number, number[]>>();
    added.forEach((line, position) => {
      const byLength = index.get(line.digits) ?? new Map<number, number[]>();
      const bucket = byLength.get(line.normalized.length) ?? [];
      bucket.push(position);
      byLength.set(line.normalized.length, bucket);
      index.set(line.digits, byLength);
    });
    const pairedAdded = new Set<number>();
    const pairedRemoved = new Set<number>();
    removed.forEach((line, removedPosition) => {
      if (budget.exhausted) return;
      const byLength = index.get(line.digits);
      if (byLength === undefined) return;
      for (let delta = -TYPO_MAX_EDITS; delta <= TYPO_MAX_EDITS; delta += 1) {
        for (const candidate of byLength.get(line.normalized.length + delta) ?? []) {
          if (pairedAdded.has(candidate)) continue;
          if (withinTypoDistance(line.normalized, added[candidate]!.normalized, budget)) {
            pairedAdded.add(candidate);
            pairedRemoved.add(removedPosition);
            return;
          }
          if (budget.exhausted) return;
        }
      }
    });
    removed = removed.filter((_line, position) => !pairedRemoved.has(position));
    added = added.filter((_line, position) => !pairedAdded.has(position));
  }

  const changed = [...removed, ...added];
  const largest = Math.max(baselineLines.length, observedLines.length, 1);
  const requirementChange = changed.some((line) => line.requirement);
  const textChange = changed.length / largest >= MATERIAL_SHARE;
  const material = changed.length > 0 && (requirementChange || textChange);
  const kind: PostingChangeKind = requirementChange ? 'requirements' : material ? 'text' : 'minor';
  // Requirement-bearing lines first, so the few lines shown are the ones that matter.
  const report = (lines: AnalysedLine[]) =>
    [...lines.filter((line) => line.requirement), ...lines.filter((line) => !line.requirement)]
      .slice(0, MAX_REPORTED_LINES)
      .map((line) => line.original.slice(0, MAX_REPORTED_CHARS));
  return {
    same: false,
    material,
    requirementChange: material && requirementChange,
    kind,
    bounded: budget.exhausted,
    added: report(added),
    removed: report(removed),
  };
}

// ------------------------------------------------------------------------------ observation

function headerValue(headers: Readonly<Record<string, string>>, name: string): string | undefined {
  const wanted = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === wanted) return value;
  }
  return undefined;
}

function validatorsOf(headers: Readonly<Record<string, string>>): PostingValidators | null {
  const etag = headerValue(headers, 'etag');
  const lastModified = headerValue(headers, 'last-modified');
  return etag === undefined && lastModified === undefined ? null : { etag, lastModified };
}

function conditionalHeaders(validators: PostingValidators | null | undefined): Record<string, string> {
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (validators?.etag) headers['If-None-Match'] = validators.etag;
  if (validators?.lastModified) headers['If-Modified-Since'] = validators.lastModified;
  return headers;
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function str(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value : null;
}

type ParsedPosting = { text: string | null; shapeOk: boolean; tooLarge?: boolean };

/**
 * The HTML parser shared with the adapters (so list and single-posting text stay identical) costs
 * time per element. A payload is only parsed while it stays inside this budget, counted with a linear
 * scan BEFORE parsing; a bigger one is "could not check (too large)", never a guessed answer.
 */
export const POSTING_MARKUP_BUDGET = { maxChars: 400_000, maxTags: 4_000 } as const;

class MarkupBudget {
  #chars = 0;
  #tags = 0;
  exceeded = false;

  /** Charges one field; false (and `exceeded`) once the whole payload is over budget. */
  charge(markup: string): boolean {
    this.#chars += markup.length;
    let index = markup.indexOf('<');
    while (index !== -1 && this.#tags <= POSTING_MARKUP_BUDGET.maxTags) {
      this.#tags += 1;
      index = markup.indexOf('<', index + 1);
    }
    index = markup.indexOf('&lt;');
    while (index !== -1 && this.#tags <= POSTING_MARKUP_BUDGET.maxTags) {
      this.#tags += 1;
      index = markup.indexOf('&lt;', index + 4);
    }
    if (this.#chars > POSTING_MARKUP_BUDGET.maxChars || this.#tags > POSTING_MARKUP_BUDGET.maxTags) this.exceeded = true;
    return !this.exceeded;
  }
}

function parsePosting(source: PostingSource, body: string): ParsedPosting {
  let root: unknown;
  try {
    root = JSON.parse(body) as unknown;
  } catch {
    return { text: null, shapeOk: false };
  }
  const object = record(root);
  if (object === null) return { text: null, shapeOk: false };
  const budget = new MarkupBudget();
  const clean = (html: string | null): string | null => {
    if (html === null || !budget.charge(html)) return null;
    const text = htmlToText(decodeEscapedMarkup(html));
    return text.length > 0 ? text : null;
  };
  const parsed = parseFields(source, object, clean);
  return budget.exceeded ? { text: null, shapeOk: true, tooLarge: true } : parsed;
}

function parseFields(
  source: PostingSource,
  object: Record<string, unknown>,
  clean: (html: string | null) => string | null,
): ParsedPosting {
  switch (source) {
    case 'greenhouse': {
      return { text: clean(str(object.content)), shapeOk: true };
    }
    case 'lever': {
      const lists = Array.isArray(object.lists)
        ? object.lists.flatMap((entry) => {
            const item = record(entry);
            const content = item ? clean(str(item.content)) : null;
            const heading = item ? str(item.text) : null;
            return content === null ? [] : [heading === null ? content : `${heading}\n${content}`];
          })
        : [];
      const head = str(object.descriptionPlain) ?? clean(str(object.description));
      const tail = str(object.additionalPlain) ?? clean(str(object.additional));
      const joined = [head, ...lists, tail].filter((part): part is string => part !== null).join('\n');
      return { text: joined.length > 0 ? joined : null, shapeOk: true };
    }
    case 'workable': {
      const joined = ['description', 'requirements', 'benefits']
        .map((field) => clean(str(object[field])))
        .filter((part): part is string => part !== null)
        .join('\n\n');
      return { text: joined.length > 0 ? joined : null, shapeOk: true };
    }
    case 'jobgether': {
      const offer = record(object.offer);
      return { text: offer ? clean(str(offer.description)) : null, shapeOk: offer !== null };
    }
  }
}

const LOGIN_PATH = /(?:^|[/_.-])(?:log[-_]?in|sign[-_]?in|sso|saml|oauth|auth(?:enticate)?|session|account\/login)(?:[/_.-]|$)/iu;
const LOGIN_BODY = /type ?= ?["']?password|<form[^<>]{0,400}(?:login|signin|sign-in)|\bsign in to continue\b|\blog in to continue\b/iu;
/** Only the head of a body is inspected for a sign-in form. */
const LOGIN_BODY_SCAN_CHARS = 65_536;

function looksLikeLoginWall(response: AtsHttpResponse, requested: string): boolean {
  try {
    const final = new URL(response.finalUrl);
    if (final.hostname.toLowerCase() !== new URL(requested).hostname.toLowerCase()) return true;
    if (LOGIN_PATH.test(final.pathname)) return true;
  } catch {
    return false;
  }
  const head = response.body.slice(0, LOGIN_BODY_SCAN_CHARS);
  return /^\s{0,64}</u.test(head) && LOGIN_BODY.test(head);
}

type Classified = { outcome: PostingObservationOutcome; reason: PostingObservationReason; httpStatus: number | null };

function classifyStatus(status: number): Classified | null {
  if (status === 404) return { outcome: 'closed', reason: 'not_found', httpStatus: status };
  if (status === 410) return { outcome: 'closed', reason: 'gone', httpStatus: status };
  if ([401, 403, 406, 407, 451].includes(status)) return { outcome: 'unable', reason: 'denied', httpStatus: status };
  if (status === 429) return { outcome: 'unable', reason: 'rate_limited', httpStatus: status };
  if (status >= 500) return { outcome: 'unable', reason: 'server_error', httpStatus: status };
  if (status >= 200 && status < 300) return null;
  return { outcome: 'unable', reason: 'unexpected_response', httpStatus: status };
}

function classifyError(error: unknown): Classified {
  if (error instanceof PostingCheckDeadline) return { outcome: 'unable', reason: 'timeout', httpStatus: null };
  if (isCrawlerHttpError(error)) {
    if (error.code === 'unexpected_not_modified') {
      return { outcome: 'open', reason: 'not_modified', httpStatus: 304 };
    }
    if (error.category === 'timeout') return { outcome: 'unable', reason: 'timeout', httpStatus: null };
    if (error.category === 'blocked') return { outcome: 'unable', reason: 'denied', httpStatus: error.status ?? 403 };
    if (error.category === 'rate_limited') return { outcome: 'unable', reason: 'rate_limited', httpStatus: 429 };
    if (error.code === 'disallowed_redirect_origin') {
      return { outcome: 'unable', reason: 'redirected_elsewhere', httpStatus: null };
    }
    // Too many (same-origin) redirect hops for this check's envelope: an answer we did not get.
    if (error.code === 'redirect_limit') {
      return { outcome: 'unable', reason: 'unexpected_response', httpStatus: error.status ?? null };
    }
    if (error.category === 'http_error' && error.status !== undefined) {
      return classifyStatus(error.status) ?? { outcome: 'unable', reason: 'unexpected_response', httpStatus: error.status };
    }
    return { outcome: 'unable', reason: 'network_error', httpStatus: error.status ?? null };
  }
  if (error instanceof AtsResponseError && error.status !== null) {
    return classifyStatus(error.status) ?? { outcome: 'unable', reason: 'unexpected_response', httpStatus: error.status };
  }
  const name = error instanceof Error ? error.name : '';
  const message = error instanceof Error ? error.message : '';
  if (name === 'TimeoutError' || /timed? ?out/iu.test(message)) {
    return { outcome: 'unable', reason: 'timeout', httpStatus: null };
  }
  return { outcome: 'unable', reason: 'network_error', httpStatus: null };
}

/** The abort reason of a check whose deadline passed; classified as `timeout`. */
export class PostingCheckDeadline extends Error {
  public constructor(timeoutMs: number) {
    super(`posting check deadline of ${timeoutMs} ms reached`);
    this.name = 'PostingCheckDeadline';
  }
}

export interface ObservePostingOptions {
  now?: () => Date;
  /** Validators stored from the previous observation, sent by sources that bypass the HTTP cache. */
  validators?: PostingValidators | null | undefined;
  /** Aborts every request of this check (DNS, queue wait, fetch). An aborted check is `unable`. */
  signal?: AbortSignal | undefined;
}

interface RequestCounter {
  logical: number;
}

function result(
  now: () => Date,
  probe: PostingProbe | null,
  classified: Classified,
  counter: RequestCounter,
  extra: Partial<PostingObservation> = {},
): PostingObservation {
  return {
    observedAt: now().toISOString(),
    source: probe?.source ?? 'none',
    sourceRef: probe?.sourceRef ?? 'none',
    outcome: classified.outcome,
    reason: classified.reason,
    httpStatus: classified.httpStatus,
    text: null,
    contentHash: null,
    validators: null,
    notModified: false,
    deadline: null,
    logicalRequests: counter.logical,
    ...extra,
  };
}

function requestOptions(
  base: AtsHttpRequestOptions,
  signal: AbortSignal | undefined,
): AtsHttpRequestOptions {
  return signal === undefined ? base : { ...base, signal };
}

async function resolveWorkableEndpoint(
  http: AtsHttpClient,
  shortcode: string,
  counter: RequestCounter,
  signal: AbortSignal | undefined,
): Promise<{ endpoint: string } | { closed: true }> {
  counter.logical += 1;
  const response = await http.get(
    `https://apply.workable.com/j/${encodeURIComponent(shortcode)}`,
    requestOptions(
      {
        allowedOrigins: ['https://apply.workable.com'],
        cache: 'no-store',
        maxRetries: POSTING_REQUEST_ENVELOPE.maxRetries,
        maxRedirects: POSTING_REQUEST_ENVELOPE.lookupMaxRedirects,
      },
      signal,
    ),
  );
  const failure = classifyStatus(response.status);
  if (failure !== null && failure.outcome === 'closed') return { closed: true };
  if (failure !== null) throw new AtsResponseError('workable', `HTTP ${response.status}`, response.status);
  const account = workableJobReferenceFromUrl(response.finalUrl)?.account ?? null;
  // Workable redirects a shortcode with no live job to `/oops`; that destination is its explicit "no such job".
  if (account === null) {
    if (/^\/oops(?:\/|$)/u.test(new URL(response.finalUrl).pathname)) return { closed: true };
    throw new AtsResponseError('workable', 'account could not be resolved', response.status);
  }
  return {
    endpoint: `https://apply.workable.com/api/v2/accounts/${encodeURIComponent(account)}/jobs/${encodeURIComponent(shortcode)}`,
  };
}

async function observeWith(
  http: AtsHttpClient,
  url: string,
  options: ObservePostingOptions,
  counter: RequestCounter,
): Promise<PostingObservation> {
  const now = options.now ?? (() => new Date());
  const probe = resolvePostingProbe(url);
  if (probe === null) {
    return result(now, null, { outcome: 'unable', reason: 'no_authoritative_source', httpStatus: null }, counter);
  }
  try {
    let endpoint = probe.endpoint;
    if (endpoint === null) {
      const reference = workableJobReferenceFromUrl(url);
      if (reference === null) {
        return result(now, probe, { outcome: 'unable', reason: 'no_authoritative_source', httpStatus: null }, counter);
      }
      const resolved = await resolveWorkableEndpoint(http, reference.shortcode, counter, options.signal);
      if ('closed' in resolved) {
        return result(now, probe, { outcome: 'closed', reason: 'account_not_found', httpStatus: null }, counter);
      }
      endpoint = resolved.endpoint;
    }
    // The shared cache (greenhouse, lever) attaches stored validators itself. Sources that bypass the
    // cache keep their existing no-store policy and send the validators this app stored instead.
    counter.logical += 1;
    const response = await http.get(
      endpoint,
      requestOptions(
        {
          allowedOrigins: [probe.allowedOrigin],
          headers: probe.cache === 'no-store' ? conditionalHeaders(options.validators) : { Accept: 'application/json' },
          cache: probe.cache,
          maxRetries: POSTING_REQUEST_ENVELOPE.maxRetries,
          maxRedirects: POSTING_REQUEST_ENVELOPE.detailMaxRedirects,
        },
        options.signal,
      ),
    );
    if (response.status === 304) {
      return result(now, probe, { outcome: 'open', reason: 'not_modified', httpStatus: 304 }, counter, {
        notModified: true,
        validators: options.validators ?? null,
      });
    }
    const failure = classifyStatus(response.status);
    if (failure !== null) return result(now, probe, failure, counter);
    if (looksLikeLoginWall(response, endpoint)) {
      return result(now, probe, { outcome: 'unable', reason: 'login_wall', httpStatus: response.status }, counter);
    }
    const parsed = parsePosting(probe.source, response.body);
    if (!parsed.shapeOk) {
      return result(now, probe, { outcome: 'unable', reason: 'unexpected_response', httpStatus: response.status }, counter);
    }
    if (parsed.tooLarge === true) {
      return result(now, probe, { outcome: 'unable', reason: 'content_too_large', httpStatus: response.status }, counter);
    }
    if (parsed.text === null) {
      return result(now, probe, { outcome: 'unable', reason: 'empty_content', httpStatus: response.status }, counter);
    }
    const text = parsed.text.slice(0, POSTING_TEXT_MAX_CHARS);
    if (closureNoticeOnly(text)) {
      return result(now, probe, { outcome: 'closed', reason: 'closure_notice', httpStatus: response.status }, counter);
    }
    return result(
      now,
      probe,
      { outcome: 'open', reason: response.revalidated ? 'not_modified' : 'verified_open', httpStatus: response.status },
      counter,
      {
        text,
        contentHash: postingContentHash(text),
        validators: validatorsOf(response.headers),
        notModified: response.revalidated === true,
        deadline: parseStatedDeadline(text),
      },
    );
  } catch (error) {
    // The deadline (or a caller) aborted the request: whatever error surfaced, this is "no answer".
    const classified =
      options.signal?.aborted === true
        ? classifyError(options.signal.reason instanceof PostingCheckDeadline ? options.signal.reason : new PostingCheckDeadline(0))
        : classifyError(error);
    if (classified.reason === 'not_modified') {
      return result(now, probe, classified, counter, { notModified: true, validators: options.validators ?? null });
    }
    return result(now, probe, classified, counter);
  }
}

/**
 * Observes one posting. Never throws: every failure becomes an `unable` observation with a stable
 * reason, so a caller cannot mistake an exception for a verdict.
 */
export async function observePosting(
  http: AtsHttpClient,
  url: string,
  options: ObservePostingOptions = {},
): Promise<PostingObservation> {
  return observeWith(http, url, options, { logical: 0 });
}

// ------------------------------------------------------------------------------ verifier

export interface PostingVerifyInput {
  url: string;
  validators?: PostingValidators | null | undefined;
}

/** The injectable seam the desktop pipeline depends on; tests supply an `AtsHttpClient` fixture. */
export interface PostingVerifier {
  verify(input: PostingVerifyInput): Promise<PostingObservation>;
}

export interface PostingVerifierOptions {
  now?: () => Date;
  timeoutMs?: number;
}

/**
 * The production verifier. Its deadline ABORTS the check's requests through their AbortSignal (the
 * shared SafeHttpClient then stops DNS, frees a queued scheduler slot without fetching, and aborts
 * the fetch). The result is also resolved at the deadline, so an HTTP seam that ignores signals still
 * cannot hold a caller past it.
 */
export function createPostingVerifier(http: AtsHttpClient, options: PostingVerifierOptions = {}): PostingVerifier {
  const now = options.now ?? (() => new Date());
  const timeoutMs = options.timeoutMs ?? POSTING_VERIFY_TIMEOUT_MS;
  return {
    async verify(input) {
      const probe = resolvePostingProbe(input.url);
      const counter: RequestCounter = { logical: 0 };
      const controller = new AbortController();
      let timer: ReturnType<typeof setTimeout> | undefined;
      const deadline = new Promise<PostingObservation>((resolve) => {
        timer = setTimeout(() => {
          controller.abort(new PostingCheckDeadline(timeoutMs));
          resolve(result(now, probe, { outcome: 'unable', reason: 'timeout', httpStatus: null }, counter));
        }, timeoutMs);
      });
      try {
        return await Promise.race([
          observeWith(http, input.url, { now, validators: input.validators, signal: controller.signal }, counter),
          deadline,
        ]);
      } finally {
        if (timer !== undefined) clearTimeout(timer);
      }
    },
  };
}
