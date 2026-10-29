import { createHash } from 'node:crypto';
import { AtsResponseError, type AtsHttpClient, type AtsHttpResponse } from '../ats/http.js';
import { decodeEscapedMarkup, htmlToText } from '../ats/shared.js';
import { isCrawlerHttpError } from '../crawler/errors.js';
import { jobgetherOfferIdFromUrl, workableJobReferenceFromUrl } from '../global-remote/structured-discovery.js';

/**
 * One bounded, authoritative check of a single posting that is about to be prepared or resumed (#687).
 *
 * What this is NOT: a feed refresh, a crawler, or a new source permission. It makes ONE read-only
 * GET (Workable's account-less short link needs one extra redirect lookup, exactly as the existing
 * on-demand fetch does) to the SAME public job-board API origin the app's own adapter for that
 * provider already reads, through the shared SafeHttpClient policy (public-address check, origin
 * boundary, size cap, timeout). Anything it cannot recognise gets NO request and is reported as
 * "unable to verify", never as closed.
 *
 * The distinction the whole feature turns on, after the upstream rank lifecycle
 * (ai-job-search `rank.md`: positive closure vs. failed retrieval vs. stored deadlines, MIT):
 *   - `closed`  = the authoritative endpoint positively says this posting does not exist (404/410,
 *                 an explicit closure notice at the head of the payload).
 *   - `open`    = the authoritative endpoint returned the posting.
 *   - `unable`  = everything else. A timeout, a 401/403/login wall, a rate limit, a server error or
 *                 an unrecognised page is the ABSENCE of an answer and is never evidence of closure.
 */

/** A result younger than this is reused with its ORIGINAL observation time and costs no request. */
export const POSTING_FRESHNESS_WINDOW_MS = 24 * 60 * 60 * 1000;
/** An "unable to verify" is never fresh proof; it may be retried after this, or on an explicit check. */
export const POSTING_UNABLE_RETRY_AFTER_MS = 15 * 60 * 1000;
/** Hard cap on one verification, queueing and retries included. */
export const POSTING_VERIFY_TIMEOUT_MS = 20_000;
/** A stored comparison copy of a changed posting is capped; nothing longer is retained. */
export const POSTING_TEXT_MAX_CHARS = 120_000;

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
  | 'empty_content';

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

/** Case, markup, entities, whitespace and punctuation folded away: only the words and numbers remain. */
export function normalizePostingText(text: string): string {
  return text
    .normalize('NFKC')
    .toLowerCase()
    .replace(/<[^>]*>/gu, ' ')
    .replace(/&[a-z0-9#]+;/gu, ' ')
    .replace(/[^\p{L}\p{N}+#]+/gu, ' ')
    .trim();
}

export function postingContentHash(text: string): string {
  return createHash('sha256').update(normalizePostingText(text)).digest('hex');
}

const CLOSURE_NOTICE: readonly RegExp[] = [
  /\bno longer accepting applications\b/iu,
  /\b(?:this|the)\s+(?:job|position|posting|role|vacancy|requisition|opening)\s+(?:is|has been|was)\s+(?:no longer\s+(?:available|open)|closed|filled|expired|removed|withdrawn)\b/iu,
  /\b(?:applications?|hiring)\s+(?:for\s+this\s+\w+\s+)?(?:is|are|has|have)\s+(?:now\s+)?closed\b/iu,
];
/** A closure notice counts only at the head of the authoritative payload, never inside a long body. */
const CLOSURE_NOTICE_HEAD_CHARS = 240;

function closureNoticeAtHead(text: string): boolean {
  const head = text.slice(0, CLOSURE_NOTICE_HEAD_CHARS);
  return CLOSURE_NOTICE.some((pattern) => pattern.test(head));
}

const MONTHS = [
  'january', 'february', 'march', 'april', 'may', 'june',
  'july', 'august', 'september', 'october', 'november', 'december',
];
const DEADLINE_CUE =
  /(?:apply\s+(?:by|before|until)|application\s+deadline|closing\s+date|closes?\s+on|deadline|applications?\s+(?:close|closes|are\s+open\s+until|accepted\s+until)|submit\s+(?:your\s+)?application\s+(?:by|before))\s*(?:is|for\s+applications?\s+is)?\s*[:\-–]?\s*(?:on\s+)?([^\n.;()]{4,40})/iu;

function isoDate(year: number, month: number, day: number): string | null {
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null;
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function parseExplicitDate(value: string): string | null {
  const iso = /\b(\d{4})-(\d{2})-(\d{2})\b/u.exec(value);
  if (iso) return isoDate(Number(iso[1]), Number(iso[2]), Number(iso[3]));
  const dayFirst = /\b(\d{1,2})(?:st|nd|rd|th)?\s+(?:of\s+)?([a-z]{3,9})\.?,?\s+(\d{4})\b/iu.exec(value);
  const monthFirst = /\b([a-z]{3,9})\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})\b/iu.exec(value);
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

/**
 * A deadline the posting text itself states, with the sentence it came from. Returns null when none is
 * stated: a missing deadline is "no deadline stated", never a date derived from a posted or first-seen time.
 */
export function parseStatedDeadline(text: string): PostingDeadline | null {
  const match = DEADLINE_CUE.exec(text);
  if (!match) return null;
  const date = parseExplicitDate(match[1]!);
  if (date === null) return null;
  return {
    date,
    provenance: { source: 'posting_text', excerpt: match[0].replace(/\s+/gu, ' ').trim().slice(0, 160) },
  };
}

// ------------------------------------------------------------------------------ comparison

export interface PostingTextComparison {
  /** Same words and numbers after normalisation (formatting, markup and punctuation ignored). */
  same: boolean;
  /** A change that can alter what the application should say: invalidates prepared work. */
  material: boolean;
  added: string[];
  removed: string[];
}

const REQUIREMENT_CUE =
  /\b(?:must|require[sd]?|requirements?|mandatory|essential|minimum|at least|years?|experience|degree|bachelor|master|phd|certificat\w*|licen[cs]e\w*|fluent|fluency|language|visa|sponsor\w*|work permit|salary|compensation|pay|rate|location|remote|hybrid|on-?site|office|relocat\w*|skills?|proficien\w*|knowledge|qualif\w*|clearance|citizen\w*|contract|full-?time|part-?time|seniority|senior|junior|lead|responsib\w*)\b/iu;
const MATERIAL_SHARE = 0.2;
const MAX_REPORTED_LINES = 6;
const MAX_REPORTED_CHARS = 240;

function postingLines(text: string): Array<{ original: string; normalized: string }> {
  return text
    .split(/\n+|(?<=[.!?])\s+/u)
    .map((original) => original.trim())
    .map((original) => ({ original, normalized: normalizePostingText(original) }))
    .filter((line) => line.normalized.length >= 3);
}

function tokens(line: string): Set<string> {
  return new Set(line.split(' ').filter((token) => token.length > 0));
}

function sameDigits(left: Set<string>, right: Set<string>): boolean {
  const digits = (set: Set<string>) => [...set].filter((token) => /\d/u.test(token)).sort().join(',');
  return digits(left) === digits(right);
}

/** Character edit distance between two normalised lines (bounded length; larger lines never pair). */
function editDistance(left: string, right: string): number {
  if (left === right) return 0;
  if (Math.max(left.length, right.length) > 600) return Number.POSITIVE_INFINITY;
  let previous = Array.from({ length: right.length + 1 }, (_unused, index) => index);
  for (let i = 1; i <= left.length; i += 1) {
    const current = [i];
    for (let j = 1; j <= right.length; j += 1) {
      const cost = left[i - 1] === right[j - 1] ? 0 : 1;
      current[j] = Math.min(previous[j]! + 1, current[j - 1]! + 1, previous[j - 1]! + cost);
    }
    previous = current;
  }
  return previous[right.length]!;
}

/** At most this many character edits is a typo/spelling fix; "five" -> "eight" is a requirement change. */
const TYPO_MAX_EDITS = 2;

/**
 * Whether a re-read posting differs from the text the work was prepared against, and whether that
 * difference is one a person must see before documents are regenerated. Formatting, markup,
 * whitespace, capitalisation and punctuation never count; a one-word typo fix (a line within two character edits
 * with the same numbers) never counts; a changed line that mentions a requirement, location, pay,
 * language or similar, or a rewrite touching at least a fifth of the posting, does.
 */
export function comparePostingText(baseline: string, observed: string): PostingTextComparison {
  if (normalizePostingText(baseline) === normalizePostingText(observed)) {
    return { same: true, material: false, added: [], removed: [] };
  }
  const baselineLines = postingLines(baseline);
  const observedLines = postingLines(observed);
  const baselineSet = new Set(baselineLines.map((line) => line.normalized));
  const observedSet = new Set(observedLines.map((line) => line.normalized));
  let removed = baselineLines.filter((line) => !observedSet.has(line.normalized));
  let added = observedLines.filter((line) => !baselineSet.has(line.normalized));

  // Pair near-identical lines (typo/wording fixes with unchanged numbers) and set them aside.
  const pairedAdded = new Set<number>();
  removed = removed.filter((line) => {
    const lineTokens = tokens(line.normalized);
    const index = added.findIndex((candidate, position) => {
      if (pairedAdded.has(position)) return false;
      const candidateTokens = tokens(candidate.normalized);
      return editDistance(line.normalized, candidate.normalized) <= TYPO_MAX_EDITS && sameDigits(lineTokens, candidateTokens);
    });
    if (index === -1) return true;
    pairedAdded.add(index);
    return false;
  });
  added = added.filter((_line, position) => !pairedAdded.has(position));

  const changed = [...removed, ...added];
  const largest = Math.max(baselineLines.length, observedLines.length, 1);
  const material =
    changed.some((line) => REQUIREMENT_CUE.test(line.original)) || changed.length / largest >= MATERIAL_SHARE;
  const report = (lines: typeof removed) =>
    lines.slice(0, MAX_REPORTED_LINES).map((line) => line.original.slice(0, MAX_REPORTED_CHARS));
  return { same: false, material: changed.length > 0 && material, added: report(added), removed: report(removed) };
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

type ParsedPosting = { text: string | null; shapeOk: boolean };

function parsePosting(source: PostingSource, body: string): ParsedPosting {
  let root: unknown;
  try {
    root = JSON.parse(body) as unknown;
  } catch {
    return { text: null, shapeOk: false };
  }
  const object = record(root);
  if (object === null) return { text: null, shapeOk: false };
  const clean = (html: string | null): string | null => {
    if (html === null) return null;
    const text = htmlToText(decodeEscapedMarkup(html));
    return text.length > 0 ? text : null;
  };
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
const LOGIN_BODY = /type\s*=\s*["']?password|<form[^>]+(?:login|signin|sign-in)|\bsign in to continue\b|\blog in to continue\b/iu;

function looksLikeLoginWall(response: AtsHttpResponse, requested: string): boolean {
  try {
    const final = new URL(response.finalUrl);
    if (final.hostname.toLowerCase() !== new URL(requested).hostname.toLowerCase()) return true;
    if (LOGIN_PATH.test(final.pathname)) return true;
  } catch {
    return false;
  }
  return /^\s*</u.test(response.body) && LOGIN_BODY.test(response.body);
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

export interface ObservePostingOptions {
  now?: () => Date;
  /** Validators stored from the previous observation, sent by sources that bypass the HTTP cache. */
  validators?: PostingValidators | null | undefined;
}

function result(
  now: () => Date,
  probe: PostingProbe | null,
  classified: Classified,
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
    ...extra,
  };
}

async function resolveWorkableEndpoint(
  http: AtsHttpClient,
  shortcode: string,
): Promise<{ endpoint: string } | { closed: true }> {
  const response = await http.get(`https://apply.workable.com/j/${encodeURIComponent(shortcode)}`, {
    allowedOrigins: ['https://apply.workable.com'],
    cache: 'no-store',
    maxRetries: 0,
  });
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

/**
 * Observes one posting. Never throws: every failure becomes an `unable` observation with a stable
 * reason, so a caller cannot mistake an exception for a verdict.
 */
export async function observePosting(
  http: AtsHttpClient,
  url: string,
  options: ObservePostingOptions = {},
): Promise<PostingObservation> {
  const now = options.now ?? (() => new Date());
  const probe = resolvePostingProbe(url);
  if (probe === null) {
    return result(now, null, { outcome: 'unable', reason: 'no_authoritative_source', httpStatus: null });
  }
  try {
    let endpoint = probe.endpoint;
    if (endpoint === null) {
      const reference = workableJobReferenceFromUrl(url);
      if (reference === null) {
        return result(now, probe, { outcome: 'unable', reason: 'no_authoritative_source', httpStatus: null });
      }
      const resolved = await resolveWorkableEndpoint(http, reference.shortcode);
      if ('closed' in resolved) {
        return result(now, probe, { outcome: 'closed', reason: 'account_not_found', httpStatus: null });
      }
      endpoint = resolved.endpoint;
    }
    // The shared cache (greenhouse, lever) attaches stored validators itself. Sources that bypass the
    // cache keep their existing no-store policy and send the validators this app stored instead.
    const response = await http.get(endpoint, {
      allowedOrigins: [probe.allowedOrigin],
      headers: probe.cache === 'no-store' ? conditionalHeaders(options.validators) : { Accept: 'application/json' },
      cache: probe.cache,
      maxRetries: 0,
    });
    if (response.status === 304) {
      return result(now, probe, { outcome: 'open', reason: 'not_modified', httpStatus: 304 }, {
        notModified: true,
        validators: options.validators ?? null,
      });
    }
    const failure = classifyStatus(response.status);
    if (failure !== null) return result(now, probe, failure);
    if (looksLikeLoginWall(response, endpoint)) {
      return result(now, probe, { outcome: 'unable', reason: 'login_wall', httpStatus: response.status });
    }
    const parsed = parsePosting(probe.source, response.body);
    if (!parsed.shapeOk) {
      return result(now, probe, { outcome: 'unable', reason: 'unexpected_response', httpStatus: response.status });
    }
    if (parsed.text === null) {
      return result(now, probe, { outcome: 'unable', reason: 'empty_content', httpStatus: response.status });
    }
    const text = parsed.text.slice(0, POSTING_TEXT_MAX_CHARS);
    if (closureNoticeAtHead(text)) {
      return result(now, probe, { outcome: 'closed', reason: 'closure_notice', httpStatus: response.status });
    }
    return result(now, probe, { outcome: 'open', reason: response.revalidated ? 'not_modified' : 'verified_open', httpStatus: response.status }, {
      text,
      contentHash: postingContentHash(text),
      validators: validatorsOf(response.headers),
      notModified: response.revalidated === true,
      deadline: parseStatedDeadline(text),
    });
  } catch (error) {
    const classified = classifyError(error);
    if (classified.reason === 'not_modified') {
      return result(now, probe, classified, { notModified: true, validators: options.validators ?? null });
    }
    return result(now, probe, classified);
  }
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

export function createPostingVerifier(http: AtsHttpClient, options: PostingVerifierOptions = {}): PostingVerifier {
  const now = options.now ?? (() => new Date());
  const timeoutMs = options.timeoutMs ?? POSTING_VERIFY_TIMEOUT_MS;
  return {
    async verify(input) {
      const probe = resolvePostingProbe(input.url);
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<PostingObservation>((resolve) => {
        timer = setTimeout(
          () => resolve(result(now, probe, { outcome: 'unable', reason: 'timeout', httpStatus: null })),
          timeoutMs,
        );
      });
      try {
        return await Promise.race([observePosting(http, input.url, { now, validators: input.validators }), timeout]);
      } finally {
        if (timer !== undefined) clearTimeout(timer);
      }
    },
  };
}
