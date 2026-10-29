/**
 * Company evidence policy (#689): who an employer verifiably is, and which stored claims about
 * it may be written into a letter or an interview prompt.
 *
 * Pure on purpose -- no node, electron, database or network import -- because the SAME decision
 * has to be made in the main process (when a letter is assembled) and in the renderer (when the
 * interview prompt is built), and the two must never disagree about what counts as support.
 *
 * Three rules this module exists to enforce, stated once:
 *
 *  1. **Identity is verified or it is nothing.** A record is keyed by an ATS tenant the vacancy's
 *     own apply URL names, by the employer's own posting host, or by a domain the person confirmed.
 *     A company NAME alone (including a name match in a public register such as the IND list) is
 *     not an identity: two employers with similar names get two records and share nothing without
 *     a link the person reviewed.
 *  2. **Support is current, sourced, scoped and uncontested.** A claim is only ever authority for
 *     prose while it has a confirmed source, has not expired, has no open contradiction, and --
 *     for a role claim -- belongs to THIS role. Everything else stays a visible lead.
 *  3. **Renewal is explicit.** `expiresAt` is written when the evidence is observed. Nothing in
 *     here extends it; only a successful re-fetch of the source (the service) writes a new one.
 *  4. **A found passage must say the claim.** "Source confirmed" means the quoted passage was found
 *     on the page AND the claim is worded from that passage (`assessQuoteSupport`). It is a lexical
 *     floor, not semantic verification: a true paraphrase stays a lead until the person confirms it.
 */

import { parse as parseDomain } from 'tldts';
import { parseAtsTenant, type AtsTenant } from './workspace/application-identity.js';

export type { AtsTenant } from './workspace/application-identity.js';

export type CompanyEvidenceScope = 'company' | 'role';
export type CompanyEvidenceTopic =
  | 'general'
  | 'products'
  | 'size'
  | 'location'
  | 'remote_policy'
  | 'funding'
  | 'leadership'
  | 'sponsorship'
  | 'other';
export type CompanyEvidenceSourceKind = 'company_site' | 'ats_posting' | 'public_web' | 'ind_register';
export type CompanyEvidenceVerification = 'unverified' | 'source_confirmed' | 'user_confirmed';
export type CompanyEvidenceOrigin = 'user' | 'research';
export type CompanyEvidenceFactStatus = 'active' | 'superseded' | 'withdrawn';
export type CompanyEvidenceKeyKind = 'ats_tenant' | 'posting_host' | 'user_domain';
export type CompanyEvidenceRefreshOutcome = 'renewed' | 'failed' | 'source_changed' | 'cache_hit';

export const COMPANY_EVIDENCE_TOPICS: readonly CompanyEvidenceTopic[] = [
  'general',
  'products',
  'size',
  'location',
  'remote_policy',
  'funding',
  'leadership',
  'sponsorship',
  'other',
];

/** Topics where one employer has ONE true answer, so two different claims are a contradiction. */
export const SINGLE_VALUE_TOPICS: readonly CompanyEvidenceTopic[] = [
  'size',
  'location',
  'remote_policy',
  'funding',
  'sponsorship',
];

export const COMPANY_FACT_TTL_MS = 90 * 24 * 60 * 60 * 1000;
export const ROLE_FACT_TTL_MS = 14 * 24 * 60 * 60 * 1000;
export const MAX_CLAIM_CHARS = 280;
export const MAX_QUOTE_CHARS = 400;
export const MIN_QUOTE_CHARS = 20;
export const MAX_LETTER_COMPANY_FACTS = 2;
export const MAX_INTERVIEW_COMPANY_FACTS = 8;

export function ttlFor(scope: CompanyEvidenceScope): number {
  return scope === 'role' ? ROLE_FACT_TTL_MS : COMPANY_FACT_TTL_MS;
}

/* ------------------------------------------------------------------------ identity ----------- */

export interface CompanyIdentity {
  /** `ats:<provider>:<board>` | `host:<domain>` | `domain:<domain>`; null = not verified. */
  verifiedKey: string | null;
  keyKind: CompanyEvidenceKeyKind | null;
  /**
   * The employer's OWN registrable website (`northwind.example`), known only for a `posting_host` or
   * `user_domain` identity. Always null for an ATS tenant: a job board's host is never the employer's site.
   */
  host: string | null;
  /** For an `ats_tenant` identity: the job-board account the posting lives under. */
  tenant: AtsTenant | null;
  displayName: string;
  /** Normalised name, used ONLY to PROPOSE a link or a suggestion, never as identity. */
  nameKey: string;
}

export function nameKeyOf(company: string): string {
  return company
    .normalize('NFKD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, '-')
    .replace(/^-+|-+$/gu, '');
}

/** Job boards, aggregators and ATS providers: a page hosted here says nothing about who the employer is. */
const JOB_BOARD_DOMAINS = [
  'linkedin.com',
  'indeed.com',
  'glassdoor.com',
  'ziprecruiter.com',
  'monster.com',
  'jobgether.com',
  'himalayas.app',
  'remoteok.com',
  'weworkremotely.com',
  'wellfound.com',
  'angel.co',
  'jooble.org',
  'adzuna.com',
  'talent.com',
  'careerjet.com',
  'nationalevacaturebank.nl',
  'werkzoeken.nl',
  'jobbird.com',
  'google.com',
  'facebook.com',
  'ind.nl',
  // ATS providers: their tenants are identified by `parseAtsTenant`, never by the provider's domain.
  'greenhouse.io',
  'lever.co',
  'ashbyhq.com',
  'rippling.com',
  'smartrecruiters.com',
  'workable.com',
  'recruitee.com',
  'personio.com',
  'personio.de',
  'teamtailor.com',
  'myworkdayjobs.com',
  'workday.com',
];

/** Trailing legal-form words that may be dropped when comparing a name to a domain label. */
const LEGAL_FORMS = new Set([
  'bv', 'nv', 'vof', 'inc', 'incorporated', 'ltd', 'limited', 'llc', 'llp', 'gmbh', 'ag', 'se', 'sa', 'sas', 'srl', 'plc',
  'corp', 'corporation', 'co', 'company',
]);

export function cleanHost(value: string): string | null {
  const text = value.trim().toLowerCase();
  if (text === '') return null;
  let host = text;
  if (/^[a-z][a-z0-9+.-]*:\/\//u.test(text)) {
    try {
      const url = new URL(text);
      if (url.username || url.password) return null;
      host = url.hostname;
    } catch {
      return null;
    }
  } else if (/[/?#@:]/u.test(text)) {
    return null;
  }
  host = host.replace(/\.$/u, '');
  if (!/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,24}$/u.test(host)) return null;
  return host;
}

function isJobBoardHost(host: string): boolean {
  return JOB_BOARD_DOMAINS.some((blocked) => host === blocked || host.endsWith(`.${blocked}`));
}

export type EmployerDomainCheck =
  | { ok: true; domain: string; label: string }
  | { ok: false; reason: 'invalid_domain' | 'shared_or_public_domain' | 'job_board_domain' };

/**
 * The registrable domain an employer could own, using the Public Suffix List (tldts, including its
 * PRIVATE section). A public suffix (`co.uk`), an IP address and any host under a shared-hosting
 * suffix (`*.github.io`, `*.blogspot.com`, `*.herokuapp.com`, `*.vercel.app`...) are refused: on
 * those, anyone can publish, so a page there can never be "the employer's own site".
 */
export function employerDomainOf(value: string): EmployerDomainCheck {
  const host = cleanHost(value);
  if (!host) return { ok: false, reason: 'invalid_domain' };
  const parsed = parseDomain(host, { allowPrivateDomains: true });
  if (parsed.isIp || !parsed.domain || !parsed.domainWithoutSuffix || parsed.isPrivate) {
    return { ok: false, reason: 'shared_or_public_domain' };
  }
  if (isJobBoardHost(host) || isJobBoardHost(parsed.domain)) return { ok: false, reason: 'job_board_domain' };
  return { ok: true, domain: parsed.domain, label: parsed.domainWithoutSuffix };
}

/**
 * A posting host is the employer's own only when its registrable label IS the company name (all
 * separators removed, optionally without a trailing legal form). A prefix or a superstring
 * (`apex` vs `apexlegends`, `acme` vs `acme-recruiting`) is a near miss: it stays unverified and is
 * offered to the person as a suggestion to confirm, never assumed.
 */
export function domainLabelMatchesName(label: string, company: string): boolean {
  const compact = label.toLowerCase().replace(/[^a-z0-9]/gu, '');
  // "B.V." / "N.V." arrive as single letters: join runs of single letters back into one word.
  const words: string[] = [];
  let singleRun = false;
  for (const word of nameKeyOf(company).split('-')) {
    if (word === '') continue;
    if (word.length === 1 && singleRun) words[words.length - 1] += word;
    else words.push(word);
    singleRun = word.length === 1;
  }
  if (compact.length < 3 || words.length === 0) return false;
  const variants = new Set([words.join('')]);
  const trimmed = [...words];
  while (trimmed.length > 1 && LEGAL_FORMS.has(trimmed[trimmed.length - 1]!)) {
    trimmed.pop();
    variants.add(trimmed.join(''));
  }
  return variants.has(compact);
}

export interface DeriveIdentityInput {
  company: string;
  canonicalUrl: string;
  /** From `deriveApplicationIdentity`: `<provider>:<board>` for a recognised ATS URL. */
  employerKey: string;
}

function httpsUrl(value: string): URL | null {
  try {
    const url = new URL(value.trim());
    return url.protocol === 'https:' &&
      !url.username &&
      !url.password &&
      (url.port === '' || url.port === '443') &&
      !url.hostname.endsWith('.')
      ? url
      : null;
  } catch {
    return null;
  }
}

/**
 * The verified identity of the employer a vacancy names, or `verifiedKey: null` when the only
 * thing known is a name. Never throws, never reaches the network.
 */
export function deriveCompanyIdentity(input: DeriveIdentityInput): CompanyIdentity {
  const displayName = sanitizeLabel(input.company) || 'this company';
  const nameKey = nameKeyOf(input.company);
  const none: CompanyIdentity = { verifiedKey: null, keyKind: null, host: null, tenant: null, displayName, nameKey };
  const url = httpsUrl(input.canonicalUrl);
  if (!url) return none;
  // The tenant must be what the exact ATS URL rules say AND what the attempt's own key says.
  const tenant = parseAtsTenant(url.href);
  if (tenant) {
    return input.employerKey.trim().toLowerCase() === `${tenant.provider}:${tenant.board}`
      ? { verifiedKey: `ats:${tenant.provider}:${tenant.board}`, keyKind: 'ats_tenant', host: null, tenant, displayName, nameKey }
      : none;
  }
  const domain = employerDomainOf(url.hostname);
  if (domain.ok && domainLabelMatchesName(domain.label, input.company)) {
    return { verifiedKey: `host:${domain.domain}`, keyKind: 'posting_host', host: domain.domain, tenant: null, displayName, nameKey };
  }
  return none;
}

/**
 * A domain the person could be asked to confirm for a name-only or near-miss vacancy: the posting's
 * own registrable domain when it is a plausible employer site. A SUGGESTION, never an identity.
 */
export function suggestedEmployerDomain(canonicalUrl: string): string | null {
  const url = httpsUrl(canonicalUrl);
  if (!url || parseAtsTenant(url.href)) return null;
  const domain = employerDomainOf(url.hostname);
  return domain.ok ? domain.domain : null;
}

/** The identity a person confirmed by naming the employer's own domain (registrable domain only). */
export function identityFromConfirmedDomain(company: string, domain: string): CompanyIdentity | null {
  const check = employerDomainOf(domain);
  if (!check.ok) return null;
  return {
    verifiedKey: `domain:${check.domain}`,
    keyKind: 'user_domain',
    host: check.domain,
    tenant: null,
    displayName: sanitizeLabel(company) || 'this company',
    nameKey: nameKeyOf(company),
  };
}

export function roleKeyFor(input: { requisitionId: string | null; canonicalUrlKey: string; role: string }): string {
  if (input.requisitionId) return `req:${input.requisitionId.trim().toLowerCase()}`;
  if (input.canonicalUrlKey) return `url:${input.canonicalUrlKey}`;
  return `role:${nameKeyOf(input.role)}`;
}

/** One-line label, no control characters; never a sentence a letter could carry. */
export function sanitizeLabel(value: string, max = 120): string {
  let out = '';
  for (const character of value.normalize('NFKC')) {
    const code = character.codePointAt(0)!;
    out += code <= 0x1f || (code >= 0x7f && code <= 0x9f) || code === 0x2028 || code === 0x2029 ? ' ' : character;
  }
  return out.replace(/\s+/gu, ' ').trim().slice(0, max).trim();
}

export function sanitizeClaim(value: string): string {
  return sanitizeLabel(value, MAX_CLAIM_CHARS);
}

export function normalizeClaim(value: string): string {
  return value
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

/* ------------------------------------------------------------------------ sources ------------- */

export function isHttpsSource(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password && cleanHost(url.hostname) !== null;
  } catch {
    return false;
  }
}

/**
 * Is this source the employer's own (its exact ATS tenant, or a page on its own registrable domain)?
 * Exact rules only: a host that merely CONTAINS a provider's name, a board name in the path of an
 * unrelated host, credentials, a non-default port or a shared-hosting tenant never qualify.
 */
export function sourceMatchesIdentity(sourceUrl: string, identity: Pick<CompanyIdentity, 'verifiedKey' | 'host'>): boolean {
  const url = httpsUrl(sourceUrl);
  if (!url) return false;
  const key = identity.verifiedKey ?? '';
  if (key.startsWith('ats:')) {
    const [, provider = '', board = ''] = key.split(':');
    const tenant = parseAtsTenant(url.href);
    return tenant !== null && tenant.provider === provider && tenant.board === board.toLowerCase();
  }
  if (!identity.host || !(key.startsWith('host:') || key.startsWith('domain:'))) return false;
  const domain = employerDomainOf(url.hostname);
  return domain.ok && domain.domain === identity.host;
}

export function inferSourceKind(
  sourceUrl: string,
  identity: Pick<CompanyIdentity, 'verifiedKey' | 'host'>,
  declared?: CompanyEvidenceSourceKind,
): CompanyEvidenceSourceKind {
  if (declared === 'ind_register') return 'ind_register';
  let host: string;
  try {
    host = new URL(sourceUrl).hostname.toLowerCase().replace(/\.$/u, '');
  } catch {
    host = '';
  }
  if (host === 'ind.nl' || host.endsWith('.ind.nl')) return 'ind_register';
  if (sourceMatchesIdentity(sourceUrl, identity)) {
    return (identity.verifiedKey ?? '').startsWith('ats:') ? 'ats_posting' : 'company_site';
  }
  return 'public_web';
}

/* ------------------------------------------------------------- claim <-> quote support -------- */

/**
 * Why a quoted passage does not adequately support a claim. These are LEXICAL checks, stated as
 * such: they establish that the claim is worded from its passage (near-verbatim), not that the
 * passage is true or that the claim means the same in every reading.
 */
export type QuoteSupportFailure =
  | 'quote_missing'
  | 'claim_number_mismatch'
  | 'claim_negation_mismatch'
  | 'claim_entity_mismatch'
  | 'claim_not_in_quote';

export type QuoteSupport = { ok: true } | { ok: false; reason: QuoteSupportFailure };

const STOPWORDS = new Set([
  'a', 'an', 'the', 'and', 'or', 'of', 'to', 'in', 'on', 'at', 'for', 'by', 'with', 'from', 'as', 'is', 'are', 'was',
  'were', 'be', 'been', 'being', 'it', 'its', 'this', 'that', 'these', 'those', 'has', 'have', 'had', 'do', 'does',
  'did', 'about', 'into', 'over', 'per', 'than', 'then', 'also', 'which', 'who', 'whose', 'where', 'there', 'here',
  'all', 'both', 'each', 'so', 'such', 'very', 'just', 'today', 'currently', 'now',
  'de', 'het', 'een', 'en', 'van', 'op', 'te', 'voor', 'met', 'zijn', 'die', 'dat', 'deze', 'dit', 'bij',
  'naar', 'uit', 'als', 'ook', 'om', 'aan', 'tot', 'door', 'er', 'wordt', 'worden', 'heeft', 'hebben',
]);
const NEGATIONS = new Set([
  'not', 'no', 'never', 'none', 'nor', 'neither', 'without', 'cannot', 'nobody', 'nothing', 'nowhere',
  'niet', 'geen', 'nooit', 'zonder', 'noch', 'niets', 'niemand', 'nergens',
]);
/** Modality / time qualifiers: "will", "may", "formerly"... change what a sentence asserts. */
const QUALIFIERS = new Set([
  'will', 'would', 'may', 'might', 'could', 'should', 'can', 'plan', 'plans', 'planned', 'planning', 'aim', 'aims',
  'intend', 'intends', 'intended', 'expect', 'expects', 'expected', 'hope', 'hopes', 'soon', 'formerly', 'former',
  'previously', 'ceased', 'stopped', 'discontinued', 'until', 'except', 'unless', 'only',
  'zal', 'zullen', 'zou', 'zouden', 'kan', 'kunnen', 'mag', 'mogen', 'mogelijk', 'misschien', 'voorheen',
  'vroeger', 'gestopt', 'tenzij', 'behalve', 'binnenkort', 'gepland', 'alleen',
]);
const FIRST_PERSON = new Set(['we', 'our', 'us', 'ours', 'wij', 'ons', 'onze']);

interface Token {
  word: string;
  /** Comparison key: a normalised number, or a lightly stemmed word. */
  key: string;
  isNumber: boolean;
  capitalised: boolean;
}

function stem(word: string): string {
  if (word.length > 5 && word.endsWith('ies')) return `${word.slice(0, -3)}y`;
  if (word.length > 5 && word.endsWith('ing')) return word.slice(0, -3);
  if (word.length > 4 && word.endsWith('ed')) return word.slice(0, -2);
  if (word.length > 4 && word.endsWith('es')) return word.slice(0, -2);
  if (word.length > 3 && word.endsWith('s') && !word.endsWith('ss')) return word.slice(0, -1);
  return word;
}

function normaliseNumber(raw: string): string {
  if (/^\d{1,3}(?:[.,]\d{3})+$/u.test(raw)) return raw.replace(/[.,]/gu, '');
  return raw.replace(/,/gu, '.');
}

const TOKEN_PATTERN = /\d+(?:[.,]\d+)*|\p{L}[\p{L}\p{M}]*(?:'\p{L}+)?/gu;

/** Linear tokenizer over a bounded claim or quote. */
function tokens(text: string): Token[] {
  const normalised = text.slice(0, 4000).normalize('NFKC').replace(/[‘’ʼ]/gu, "'");
  const out: Token[] = [];
  for (const match of normalised.matchAll(TOKEN_PATTERN)) {
    const raw = match[0];
    if (/^\d/u.test(raw)) {
      const value = normaliseNumber(raw);
      out.push({ word: value, key: value, isNumber: true, capitalised: false });
      continue;
    }
    const lower = raw.toLowerCase();
    if (lower.endsWith("n't")) {
      out.push({ word: 'not', key: 'not', isNumber: false, capitalised: false });
      continue;
    }
    const word = lower.replace(/'.*$/u, '');
    out.push({ word, key: stem(word), isNumber: false, capitalised: raw[0] !== raw[0]!.toLowerCase() });
  }
  return out;
}

const isContent = (token: Token): boolean =>
  token.isNumber ||
  !(STOPWORDS.has(token.word) || NEGATIONS.has(token.word) || QUALIFIERS.has(token.word) || FIRST_PERSON.has(token.word));

/**
 * The deterministic, fail-closed support floor (#689): may this passage, found on the source page,
 * stand behind this exact claim? Conservative by design -- a claim must be worded from its passage:
 *
 *  - every number in the claim (14, 2009, 12,000 = 12.000) is a number in the passage (14 is not 140);
 *  - every content word of the claim occurs in the passage, IN THE SAME ORDER (light stemming only);
 *  - negation ("not", "no", "geen", "niet", "n't") and modality/time qualifiers ("will", "may",
 *    "formerly", "only"...) agree between the claim and the part of the passage it was matched to;
 *  - a capitalised name in the claim is in the passage. The employer's own name may be left out of
 *    the passage only when the passage speaks in the first person ("we", "our") and names no other
 *    organisation where the claim was matched.
 *
 * A paraphrase therefore stays a lead even when it is true: the person can confirm it themselves.
 * This proves wording overlap with a passage that was found on the page, never semantic truth.
 */
export function assessQuoteSupport(claim: string, quote: string, employerNames: readonly string[] = []): QuoteSupport {
  const fail = (reason: QuoteSupportFailure): QuoteSupport => ({ ok: false, reason });
  const passage = tokens(quote);
  if (quote.replace(/\s+/gu, ' ').trim().length < MIN_QUOTE_CHARS || passage.length === 0) return fail('quote_missing');
  const said = tokens(claim);
  const passageKeys = new Set(passage.map((token) => token.key));

  for (const token of said) if (token.isNumber && !passageKeys.has(token.key)) return fail('claim_number_mismatch');

  const nameKeys = new Set(
    employerNames.flatMap((name) => tokens(name).filter((token) => !token.isNumber).map((token) => token.key)),
  );
  const firstPerson = passage.some((token) => FIRST_PERSON.has(token.word));
  const content = said.filter(isContent);
  const required = content.filter((token) => !(firstPerson && nameKeys.has(token.key) && !passageKeys.has(token.key)));
  const nameLeftOut = required.length < content.length;
  if (required.length === 0) return fail('claim_not_in_quote');
  for (const token of required) if (token.capitalised && !passageKeys.has(token.key)) return fail('claim_entity_mismatch');

  const matched: number[] = [];
  let cursor = 0;
  for (const token of required) {
    let found = -1;
    for (let index = cursor; index < passage.length; index += 1) {
      if (passage[index]!.key === token.key) {
        found = index;
        break;
      }
    }
    if (found < 0) return fail('claim_not_in_quote');
    matched.push(found);
    cursor = found + 1;
  }
  const span = passage.slice(Math.max(0, matched[0]! - 4), matched[matched.length - 1]! + 1);
  const negated = (list: readonly Token[]) => list.some((token) => NEGATIONS.has(token.word));
  if (negated(said) !== negated(span)) return fail('claim_negation_mismatch');
  const qualifiers = (list: readonly Token[]) =>
    [...new Set(list.filter((token) => QUALIFIERS.has(token.word)).map((token) => token.word))].sort().join('|');
  if (qualifiers(said) !== qualifiers(span)) return fail('claim_negation_mismatch');
  if (nameLeftOut) {
    const claimKeys = new Set(said.map((token) => token.key));
    const foreign = span.some(
      (token) =>
        token.capitalised &&
        !FIRST_PERSON.has(token.word) &&
        !STOPWORDS.has(token.word) &&
        !claimKeys.has(token.key) &&
        !nameKeys.has(token.key),
    );
    if (foreign) return fail('claim_entity_mismatch');
  }
  return { ok: true };
}

/**
 * Sponsorship / visa / work-permit wording (English and Dutch). Decided from the claim AND its
 * quote, never from the topic label a model or a form supplied, so a mislabelled claim still has to
 * meet the sponsorship rule. Over-matching is deliberate: it can only make a claim harder to use.
 */
const SPONSORSHIP_WORDING =
  /\b(?:visas?|visum\w*|sponsor\w*|work[\s-]permits?|work[\s-]authori[sz]ation|right[\s-]to[\s-]work|kennismigrant\w*|highly[\s-]skilled[\s-]migrants?|blue[\s-]card|blauwe[\s-]kaart|werkvergunning\w*|tewerkstellingsvergunning\w*|verblijfsvergunning\w*|erkend[\s-]referent\w*|ind)\b/u;

export function mentionsSponsorship(...texts: readonly string[]): boolean {
  return SPONSORSHIP_WORDING.test(texts.join(' ').normalize('NFKC').toLowerCase().slice(0, 4000));
}

/** The topic a claim is actually about, as far as the sponsorship rule is concerned. */
export function effectiveTopic(topic: CompanyEvidenceTopic, claim: string, quote: string): CompanyEvidenceTopic {
  return mentionsSponsorship(claim, quote) ? 'sponsorship' : topic;
}

/* -------------------------------------------------------------------------- facts ------------ */

export interface CompanyEvidenceFactData {
  id: string;
  recordId: string;
  scope: CompanyEvidenceScope;
  /** '' for a company-scope fact. */
  roleKey: string;
  roleLabel: string;
  topic: CompanyEvidenceTopic;
  claim: string;
  sourceUrl: string;
  sourceKind: CompanyEvidenceSourceKind;
  /** The passage of the source the claim rests on. */
  quote: string;
  /** ISO. When the source was actually fetched; null when it never was (a user-supplied lead). */
  retrievedAt: string | null;
  /** ISO. When the source was observed to say this (fetch time, or the date the person gave). */
  observedAt: string;
  /** ISO. Written at observation time. Never moved except by a successful re-fetch. */
  expiresAt: string;
  verification: CompanyEvidenceVerification;
  origin: CompanyEvidenceOrigin;
  status: CompanyEvidenceFactStatus;
  lastRefreshAt: string | null;
  lastRefreshOutcome: CompanyEvidenceRefreshOutcome | null;
  lastRefreshReason: string | null;
  /**
   * User correction provenance. `originalQuote` is the passage the FIRST wording rested on: it is kept
   * for the record but no longer supports anything (the corrected claim needs its own passage).
   */
  correction: { originalClaim: string; correctedAt: string; originalQuote?: string } | null;
  /** Ids of facts this one is in an OPEN contradiction with. */
  contradictedBy: string[];
  /** The linked company this fact came from, when it arrived over a confirmed identity link. */
  viaLink: string | null;
}

export type CompanyEvidenceLeadReason =
  | 'withdrawn'
  | 'superseded'
  | 'expired'
  | 'unverified'
  | 'contradicted'
  | 'other_role'
  | 'identity_not_verified'
  | 'ind_name_match_only'
  | 'sponsorship_needs_role_source'
  | 'source_not_https'
  | QuoteSupportFailure;

export interface ClassificationContext {
  /** The role the prose is for; null when none is known (role facts then never support). */
  roleKey: string | null;
  identityVerified: boolean;
  identity: Pick<CompanyIdentity, 'verifiedKey' | 'host'>;
  /** The employer's names (display name, the vacancy's company field), for the quote floor's own-name rule. */
  employerNames?: readonly string[];
}

export interface ClassifiedFact extends CompanyEvidenceFactData {
  support: 'supported' | 'lead';
  reasons: CompanyEvidenceLeadReason[];
  /** The source is on the employer's own registrable domain / exact ATS tenant. */
  official: boolean;
}

/** The quote floor for one stored fact (the linked company's name counts as an own name for its facts). */
export function factQuoteSupport(fact: Pick<CompanyEvidenceFactData, 'claim' | 'quote' | 'viaLink'>, employerNames: readonly string[] = []): QuoteSupport {
  return assessQuoteSupport(fact.claim, fact.quote, fact.viaLink ? [...employerNames, fact.viaLink] : employerNames);
}

export function classifyFact(fact: CompanyEvidenceFactData, ctx: ClassificationContext, now: Date): ClassifiedFact {
  const reasons: CompanyEvidenceLeadReason[] = [];
  if (fact.status === 'withdrawn') reasons.push('withdrawn');
  if (fact.status === 'superseded') reasons.push('superseded');
  if (!ctx.identityVerified) reasons.push('identity_not_verified');
  if (fact.verification === 'unverified') reasons.push('unverified');
  // A person's explicit "I read the source" is their own attested observation; everything else that
  // claims support must pass the quote floor, re-checked here on every read and every prose use.
  if (fact.verification !== 'user_confirmed') {
    const floor = factQuoteSupport(fact, ctx.employerNames ?? []);
    if (!floor.ok) reasons.push(floor.reason);
  }
  if (Date.parse(fact.expiresAt) <= now.getTime() || Number.isNaN(Date.parse(fact.expiresAt))) reasons.push('expired');
  if (fact.contradictedBy.length > 0) reasons.push('contradicted');
  if (fact.scope === 'role' && (ctx.roleKey === null || fact.roleKey !== ctx.roleKey)) reasons.push('other_role');
  if (!isHttpsSource(fact.sourceUrl)) reasons.push('source_not_https');
  if (fact.sourceKind === 'ind_register') reasons.push('ind_name_match_only');
  const official = sourceMatchesIdentity(fact.sourceUrl, ctx.identity);
  // Decided from what the claim and its quote SAY, not from the topic label.
  const topic = effectiveTopic(fact.topic, fact.claim, fact.quote);
  if (topic === 'sponsorship' && !(fact.scope === 'role' && official && fact.viaLink === null && fact.sourceKind !== 'ind_register')) {
    reasons.push('sponsorship_needs_role_source');
  }
  return { ...fact, topic, support: reasons.length === 0 ? 'supported' : 'lead', reasons, official };
}

/** What a letter or an interview prompt is allowed to carry about a company claim. */
export interface CompanyEvidenceProseFact {
  id: string;
  claim: string;
  scope: CompanyEvidenceScope;
  topic: CompanyEvidenceTopic;
  sourceUrl: string;
  observedAt: string;
  retrievedAt: string | null;
  /** ISO. A consumer that holds this fact for a while must drop it once this has passed. */
  expiresAt: string;
  verification: Exclude<CompanyEvidenceVerification, 'unverified'>;
  viaLink: string | null;
}

/**
 * The ONLY path from the evidence store to prose. Re-classifies at the moment of use, so a fact
 * that expired between loading the view and building the prompt cannot slip through, and returns
 * a shape that has no field a lead could be smuggled in through.
 */
export function selectProseEvidence(
  facts: readonly ClassifiedFact[] | readonly CompanyEvidenceFactData[],
  ctx: ClassificationContext,
  now: Date,
  max: number,
): CompanyEvidenceProseFact[] {
  const out: CompanyEvidenceProseFact[] = [];
  const seen = new Set<string>();
  for (const fact of facts) {
    const classified = classifyFact(fact, ctx, now);
    if (classified.support !== 'supported' || classified.verification === 'unverified') continue;
    const claim = sanitizeClaim(classified.claim);
    const key = normalizeClaim(claim);
    if (claim === '' || seen.has(key)) continue;
    seen.add(key);
    out.push({
      id: classified.id,
      claim,
      scope: classified.scope,
      topic: classified.topic,
      sourceUrl: classified.sourceUrl,
      observedAt: classified.observedAt,
      retrievedAt: classified.retrievedAt,
      expiresAt: classified.expiresAt,
      verification: classified.verification,
      viaLink: classified.viaLink,
    });
    if (out.length >= max) break;
  }
  return out;
}

/* -------------------------------------------------------------------------- view ------------- */

export interface CompanyEvidenceLinkView {
  id: string;
  otherRecordId: string;
  otherName: string;
  otherHost: string | null;
  status: 'proposed' | 'confirmed' | 'rejected';
}

export interface CompanyEvidenceContradictionView {
  id: string;
  factAId: string;
  factBId: string;
  topic: CompanyEvidenceTopic;
}

export interface CompanyResearchDiagnostics {
  at: string;
  /** Stable code only; never remote free text. */
  status: 'completed' | 'cancelled' | 'failed' | 'timed_out' | 'budget_exceeded' | 'unavailable' | 'cache_hit';
  reason: string;
  /** The model's public search queries. By construction they never carried candidate data. */
  queries: string[];
  searches: number;
  fetches: number;
  candidates: number;
  confirmed: number;
}

/** What this attempt's prepared letter actually used, as snapshotted when it was assembled. */
export interface CompanyEvidenceUseView {
  claim: string;
  sourceUrl: string;
  scope: CompanyEvidenceScope;
  observedAt: string;
  verification: 'source_confirmed' | 'user_confirmed';
}

export interface CompanyEvidenceSuggestion {
  domain: string;
  basis: 'posting_domain' | 'same_name_elsewhere';
}

export interface CompanyEvidenceView {
  /** `no_identity`: only a name is known, nothing can be recorded as support until a domain is confirmed. */
  state: 'no_identity' | 'ready';
  identity: CompanyIdentity;
  recordId: string | null;
  entityRef: string;
  roleKey: string | null;
  roleLabel: string;
  facts: ClassifiedFact[];
  contradictions: CompanyEvidenceContradictionView[];
  links: CompanyEvidenceLinkView[];
  research: CompanyResearchDiagnostics | null;
  /** Only for an attempt target: the claims its letter carries, unaffected by later edits or deletion. */
  lettersUsed: CompanyEvidenceUseView[];
  /**
   * For a vacancy with no verified identity: domains the person may confirm (the posting's own
   * domain when plausible, and domains they already confirmed for another vacancy of the same
   * name). Suggestions only: nothing is shared until the person confirms one FOR THIS vacancy.
   */
  suggestions: CompanyEvidenceSuggestion[];
  supportedCount: number;
  leadCount: number;
  /** ISO of the view, so the renderer can re-check expiry against the same clock source. */
  generatedAt: string;
}

export const LEAD_REASON_TEXT: Record<CompanyEvidenceLeadReason, string> = {
  withdrawn: 'Withdrawn by you.',
  superseded: 'Replaced by another claim you chose.',
  expired: 'Out of date: check the source again before relying on it.',
  unverified: 'The source has not been confirmed to say this.',
  contradicted: 'Another source says something different. Choose which one is right.',
  other_role: 'About a different role, so it is not used for this one.',
  identity_not_verified: 'The company is not verified yet, so nothing counts as support.',
  ind_name_match_only: 'A register name match does not confirm who this employer is or that it sponsors this role.',
  sponsorship_needs_role_source: 'Sponsorship needs a source from the employer about this role.',
  source_not_https: 'The source is not a secure public web address.',
  quote_missing: 'No passage copied from the page is saved for this wording, so it cannot be checked. Add one, or confirm you read the source yourself.',
  claim_not_in_quote: 'The saved passage does not say this in these words. Only a claim worded from its passage is used automatically.',
  claim_number_mismatch: 'A number or date in the claim is not in the saved passage.',
  claim_negation_mismatch: 'The claim and the passage differ in wording such as "not", "no", "will" or "formerly", so they may not say the same thing.',
  claim_entity_mismatch: 'The claim names someone or something the passage does not, or the passage is about another organisation.',
};

/** Every lead reason, for fail-closed parsing across the preload boundary. */
export const COMPANY_EVIDENCE_LEAD_REASONS = Object.keys(LEAD_REASON_TEXT) as CompanyEvidenceLeadReason[];

/* ------------------------------------------------------------------------- bridge ---------- */

export type CompanyEvidenceResult =
  | { ok: true; view: CompanyEvidenceView; notice: string; stats?: ActionStats }
  | { ok: false; code: string; message: string };

export interface ActionStats {
  /** Network requests this action made (safe fetches). */
  requests: number;
  /** Web research sessions this action started. */
  sessions: number;
  /** Research sessions this action did not start because current company-scope evidence covered every topic. */
  avoidedSessions: number;
  /**
   * OBSERVED skips only: stored facts a refresh did not re-fetch because they were still current (each
   * would otherwise have been exactly one request). A research cache hit reports 0 here: how many pages
   * a session would have opened is unknown, so it is not guessed.
   */
  avoidedFetches: number;
  cacheHit: boolean;
  renewed: number;
  demoted: number;
  failed: number;
  candidates: number;
  confirmed: number;
}


export type CompanyEvidenceTargetInput = { attemptId: string } | { applicationId: string };

/** `window.companyEvidence` (#689). Every method resolves, never rejects, with a typed result. */
export interface CompanyEvidenceBridge {
  get(target: CompanyEvidenceTargetInput): Promise<CompanyEvidenceResult>;
  /** The facts an interview prompt may carry: supported only, re-checked in the main process. */
  prose(target: CompanyEvidenceTargetInput): Promise<{ ok: boolean; facts: CompanyEvidenceProseFact[] }>;
  confirmDomain(target: CompanyEvidenceTargetInput, input: { domain: string; entityRef?: string }): Promise<CompanyEvidenceResult>;
  addFact(
    target: CompanyEvidenceTargetInput,
    input: {
      claim: string;
      sourceUrl: string;
      quote: string;
      scope: CompanyEvidenceScope;
      topic: CompanyEvidenceTopic;
      sourceKind?: CompanyEvidenceSourceKind;
    },
  ): Promise<CompanyEvidenceResult>;
  confirmFact(target: CompanyEvidenceTargetInput, factId: string): Promise<CompanyEvidenceResult>;
  /** A new `quote` (a passage from the same page that says the corrected wording) lets the app check it again. */
  correctFact(target: CompanyEvidenceTargetInput, factId: string, claim: string, quote?: string): Promise<CompanyEvidenceResult>;
  withdrawFact(target: CompanyEvidenceTargetInput, factId: string): Promise<CompanyEvidenceResult>;
  resolveContradiction(target: CompanyEvidenceTargetInput, contradictionId: string, keepFactId: string): Promise<CompanyEvidenceResult>;
  decideLink(target: CompanyEvidenceTargetInput, linkId: string, decision: 'confirmed' | 'rejected'): Promise<CompanyEvidenceResult>;
  deleteRecord(target: CompanyEvidenceTargetInput): Promise<CompanyEvidenceResult>;
  /** Re-checks stored sources. Cancellable with `cancel`. */
  refresh(target: CompanyEvidenceTargetInput): Promise<CompanyEvidenceResult>;
  /** The explicit bounded web research. Cancellable with `cancel`. */
  research(target: CompanyEvidenceTargetInput, options?: { topics?: CompanyEvidenceTopic[]; includeRole?: boolean }): Promise<CompanyEvidenceResult>;
  cancel(target: CompanyEvidenceTargetInput): Promise<{ ok: boolean; cancelled: boolean }>;
}
