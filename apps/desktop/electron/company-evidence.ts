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
 *     on the page AND the claim repeats one whole sentence of it, with nothing next to it (in the
 *     passage or on the page) limiting it (`assessQuoteSupport`). It is a lexical wording floor, not
 *     semantic or truth verification: a true paraphrase stays a lead until the person confirms it.
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

/**
 * Job boards, aggregators, ATS providers and shared publishing / hosting platforms that are not on
 * the Public Suffix List's private section: a page hosted here says nothing about who the employer
 * is, so none of them can become an employer's "own website", even when a person confirms it.
 */
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
  'bamboohr.com',
  'jobvite.com',
  'icims.com',
  'breezy.hr',
  'jazzhr.com',
  'applytojob.com',
  'recruiterbox.com',
  'homerun.co',
  'join.com',
  'pinpointhq.com',
  'zohorecruit.com',
  'freshteam.com',
  'manatal.com',
  'jobylon.com',
  'softgarden.io',
  'taleo.net',
  'successfactors.com',
  'successfactors.eu',
  'oraclecloud.com',
  'adp.com',
  'ultipro.com',
  'paylocity.com',
  'welcometothejungle.com',
  'otta.com',
  'builtin.com',
  'dice.com',
  'stepstone.de',
  'stepstone.nl',
  'xing.com',
  'indeed.nl',
  'glassdoor.nl',
  'monsterboard.nl',
  // Shared publishing / hosting: anyone can publish a page under these.
  'medium.com',
  'substack.com',
  'wordpress.com',
  'weebly.com',
  'wix.com',
  'squarespace.com',
  'webflow.io',
  'ghost.io',
  'gitbook.io',
  'notion.so',
  'notion.site',
  'github.com',
  'gitlab.io',
  'carrd.co',
  'tumblr.com',
  'blogger.com',
  'linktr.ee',
  'about.me',
  'framer.website',
  'strikingly.com',
  'sslip.io',
  'nip.io',
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
 * such: they establish that the claim repeats one whole statement of its passage, not that the
 * passage is true or that the claim means the same in every reading.
 */
export type QuoteSupportFailure =
  | 'quote_missing'
  | 'claim_too_vague'
  | 'claim_not_whole_sentence'
  | 'claim_number_mismatch'
  | 'claim_negation_mismatch'
  | 'claim_entity_mismatch'
  | 'claim_context_qualified'
  | 'claim_not_in_quote';

export type QuoteSupport = { ok: true } | { ok: false; reason: QuoteSupportFailure };

export interface QuoteSupportOptions {
  /**
   * A claim that does not name the employer as its subject ("Visa sponsorship is available for this
   * role") may be supported only when this is true: the caller sets it for a ROLE-scope claim whose
   * source is the employer's own posting/site (`sourceMatchesIdentity`). Never for company scope.
   */
  unnamedSubjectAllowed?: boolean;
  /**
   * The vacancy's role title. With `unnamedSubjectAllowed`, an unnamed claim must refer to this role:
   * "this role/position/..." (EN/NL), or this exact title ("The Platform Engineer builds...").
   */
  roleLabel?: string;
}

/** Ignored when comparing a claim with its sentence. Nothing else is. */
const ARTICLES = new Set(['a', 'an', 'the', 'de', 'het', 'een']);
const STOPWORDS = new Set([
  'a', 'an', 'the', 'and', 'or', 'of', 'to', 'in', 'on', 'at', 'for', 'by', 'with', 'from', 'as', 'is', 'are', 'was',
  'were', 'be', 'been', 'being', 'it', 'its', 'this', 'that', 'these', 'those', 'has', 'have', 'had', 'do', 'does',
  'did', 'about', 'into', 'over', 'per', 'than', 'then', 'also', 'which', 'who', 'whose', 'where', 'there', 'here',
  'all', 'both', 'each', 'so', 'such', 'very', 'just', 'today', 'currently', 'now',
  'de', 'het', 'een', 'en', 'van', 'op', 'te', 'voor', 'met', 'zijn', 'die', 'dat', 'deze', 'dit', 'bij',
  'naar', 'uit', 'ook', 'om', 'aan', 'tot', 'door', 'er', 'wordt', 'worden', 'heeft', 'hebben',
]);
/** What may come before the employer's name for it still to be the statement's subject. */
const SUBJECT_LEAD = new Set([...ARTICLES, 'in', 'on', 'at', 'as', 'of', 'since', 'sinds', 'vanaf', 'today', 'currently', 'now', 'nu', 'per']);
const NEGATIONS = new Set([
  'not', 'no', 'never', 'none', 'nor', 'neither', 'without', 'cannot', 'nobody', 'nothing', 'nowhere',
  'niet', 'geen', 'nooit', 'zonder', 'noch', 'niets', 'niemand', 'nergens',
]);
/**
 * Modality, time, scope, condition, contrast and attribution words: each can narrow, hedge or
 * reverse what a statement asserts. Over-matching is deliberate (it can only keep a claim a lead).
 */
const QUALIFIERS = new Set([
  'will', 'would', 'may', 'might', 'could', 'should', 'can', 'plan', 'plans', 'planned', 'planning', 'aim', 'aims',
  'intend', 'intends', 'intended', 'expect', 'expects', 'expected', 'hope', 'hopes', 'soon', 'formerly', 'former',
  'previously', 'ceased', 'stopped', 'discontinued', 'until', 'except', 'unless', 'only',
  'but', 'however', 'although', 'though', 'yet', 'whereas', 'excluding', 'excl', 'exclusively', 'solely', 'merely',
  'limited', 'some', 'certain', 'selected', 'specific', 'depending', 'depends', 'subject', 'provided', 'if', 'whether',
  'apart', 'besides', 'instead', 'rather', 'partly', 'partially', 'sometimes', 'occasionally', 'rarely', 'usually',
  'mostly', 'mainly', 'typically', 'generally', 'often', 'according', 'reportedly', 'allegedly', 'rumoured', 'rumored',
  'says', 'said', 'claims', 'claimed', 'reports', 'reported', 'estimated', 'applies', 'applicable', 'includes',
  'including', 'excludes', 'exclude', 'counts', 'counted', 'refers', 'figure', 'figures', 'outdated', 'incorrect', 'wrong',
  'excluded', 'exception', 'exceptions', 'restricted',
  'geldt', 'gelden', 'inclusief', 'exclusief', 'betreft', 'uitgesloten', 'uitzondering', 'uitzonderingen',
  'zal', 'zullen', 'zou', 'zouden', 'kan', 'kunnen', 'mag', 'mogen', 'mogelijk', 'misschien', 'voorheen',
  'vroeger', 'gestopt', 'tenzij', 'behalve', 'binnenkort', 'gepland', 'alleen',
  'maar', 'echter', 'hoewel', 'uitgezonderd', 'uitsluitend', 'slechts', 'sommige', 'bepaalde', 'enkele', 'beperkt',
  'afhankelijk', 'indien', 'mits', 'als', 'wanneer', 'soms', 'meestal', 'vaak', 'deels', 'gedeeltelijk', 'volgens',
  'verluidt', 'zelden',
]);
/** A following sentence that starts like this refers back to (or limits) the one before it. */
const OPENERS = new Set([
  'this', 'that', 'these', 'those', 'it', 'they', 'such', 'note', 'also', 'dit', 'dat', 'deze', 'die', 'het', 'zij', 'ze',
  'let', 'ook', 'wel',
]);
/**
 * An unnamed-subject role claim (#689 review 3) must be about THIS role: one of these determiners
 * directly before one of the role nouns ("this role", "the position", "deze functie", "de vacature").
 */
const ROLE_DETERMINERS = new Set(['this', 'these', 'that', 'the', 'deze', 'die', 'dit', 'de', 'het']);
const ROLE_NOUNS = new Set(['role', 'position', 'vacancy', 'job', 'opening', 'post', 'posting', 'rol', 'functie', 'vacature', 'baan', 'positie']);
/**
 * What an unnamed-subject role claim may open with: a function word, a role noun, sponsorship wording
 * or one of these role-condition words. Anything else ("Acme offers...", "Contoso biedt...") may be
 * an organisation's name, so the claim stays a lead. A finite list on purpose: fail closed.
 */
const ROLE_CLAIM_OPENERS = new Set([
  'for', 'in', 'within', 'with', 'at', 'as', 'from', 'voor', 'binnen', 'bij', 'met', 'als', 'vanaf', 'sinds',
  'visa', 'sponsorship', 'relocation', 'remote', 'hybrid', 'flexible', 'salary', 'pay', 'compensation', 'bonus',
  'benefits', 'benefit', 'equity', 'training', 'travel', 'work', 'working', 'home', 'office', 'onboarding', 'contract',
  'hours', 'holiday', 'holidays', 'leave', 'pension', 'support', 'help', 'applications', 'applicants', 'candidates',
  'visumsponsoring', 'sponsoring', 'relocatie', 'verhuizing', 'verhuiskosten', 'thuiswerken', 'hybride', 'flexibel',
  'salaris', 'loon', 'beloning', 'opleiding', 'reiskosten', 'werk', 'werken', 'uren', 'vakantie', 'verlof', 'pensioen',
  'ondersteuning', 'hulp', 'sollicitaties', 'kandidaten',
]);
const FIRST_PERSON = new Set(['we', 'our', 'us', 'ours', 'wij', 'ons', 'onze']);
/** First-person SUBJECT pronouns the employer's own name may stand for. */
const FIRST_PERSON_SUBJECT = new Set(['we', 'wij']);
/** A '.' after these (or after a single letter: "B.V.", "e.g.") does not end a sentence. */
const ABBREVIATIONS = new Set([
  'bv', 'nv', 'inc', 'ltd', 'llc', 'llp', 'co', 'corp', 'plc', 'gmbh', 'ag', 'sa', 'etc', 'approx', 'ca', 'no', 'nr',
  'st', 'dr', 'mr', 'mrs', 'ms', 'vs', 'jr', 'sr', 'dept', 'incl', 'excl', 'bijv', 'eg', 'ie',
]);
/** Copula / auxiliary forms compared as one word (person agreement only; tense stays distinct). */
const KEY_ALIAS: Record<string, string> = { are: 'is', am: 'is', zijn: 'is', ben: 'is', have: 'has', hebben: 'heeft', do: 'does' };

interface Token {
  word: string;
  /** Comparison key: a normalised number, or a word with only a plural / 3rd-person -s removed. */
  key: string;
  isNumber: boolean;
  capitalised: boolean;
}

interface Sentence {
  /** Every token of the ORIGINAL sentence: a ';' or ':' clause inside it does not end it. */
  tokens: Token[];
  /** Token offsets (> 0) where a ';' / ':' clause starts inside the sentence. */
  clauseStarts: number[];
  /** The sentence ended with ':' -- a lead-in such as "Acme Haulage says:" before a line break. */
  leadIn: boolean;
}

/** The ';' / ':' clauses of one sentence (the sentence itself when it has none). */
function clausesOf(sentence: Sentence): Sentence[] {
  if (sentence.clauseStarts.length === 0) return [sentence];
  const bounds = [0, ...sentence.clauseStarts, sentence.tokens.length];
  const out: Sentence[] = [];
  for (let index = 0; index + 1 < bounds.length; index += 1) {
    const tokens = sentence.tokens.slice(bounds[index], bounds[index + 1]);
    if (tokens.length > 0) out.push({ tokens, clauseStarts: [], leadIn: false });
  }
  return out;
}

function stem(word: string): string {
  const base = KEY_ALIAS[word] ?? word;
  if (base.length > 4 && base.endsWith('ies')) return `${base.slice(0, -3)}y`;
  if (base.length > 3 && base.endsWith('s') && !/(?:ss|us|is)$/u.test(base)) return base.slice(0, -1);
  return base;
}

function normaliseNumber(raw: string): string {
  if (/^\d{1,3}(?:[.,]\d{3})+$/u.test(raw)) return raw.replace(/[.,]/gu, '');
  return raw.replace(/,/gu, '.');
}

/** Words, numbers and sentence terminators. Alternation of simple classes: linear on bounded text. */
const TOKEN_PATTERN = /\d+(?:[.,]\d+)*|\p{L}[\p{L}\p{M}]*(?:'\p{L}+)?|[.!?;:…\n]+/gu;
const TERMINATOR_START = /^[.!?;:…\n]/u;
/** What may follow a terminator for it to end a sentence ("northwind.example" is not two sentences). */
const AFTER_TERMINATOR = /[\s"'()[\]«»“”]/u;

/**
 * Linear segmentation of a bounded claim, quote or page window into ORIGINAL sentences. A sentence
 * ends at `. ! ? …` followed by a space or the end, and at a line break (block boundaries of a
 * fetched page). A '.' after a single letter or a known abbreviation does not end it. A `;` or `:`
 * inside a line does NOT end it (#689 review 3): it starts a clause of the same sentence, so a claim
 * can never drop "; engineering teams are not included" or ": for senior hires in Germany".
 */
function sentences(text: string): Sentence[] {
  const normalised = text.slice(0, 4000).normalize('NFKC').replace(/[‘’ʼ]/gu, "'");
  const out: Sentence[] = [];
  let current: Token[] = [];
  let clauseStarts: number[] = [];
  const flush = (leadIn: boolean) => {
    if (current.length > 0) out.push({ tokens: current, clauseStarts: clauseStarts.filter((at) => at > 0 && at < current.length), leadIn });
    current = [];
    clauseStarts = [];
  };
  for (const match of normalised.matchAll(TOKEN_PATTERN)) {
    const raw = match[0];
    if (TERMINATOR_START.test(raw)) {
      const after = normalised[match.index + raw.length];
      const hard = raw.includes('\n');
      if (!hard && after !== undefined && !AFTER_TERMINATOR.test(after)) continue;
      if (!hard && !/[.!?…]/u.test(raw)) {
        // Only ';' / ':' inside a line: a clause of the same sentence, never a sentence of its own.
        if (clauseStarts[clauseStarts.length - 1] !== current.length) clauseStarts.push(current.length);
        continue;
      }
      const previous = current[current.length - 1];
      if (!hard && raw === '.' && previous && !previous.isNumber && (previous.word.length === 1 || ABBREVIATIONS.has(previous.word))) continue;
      flush(raw.includes(':'));
      continue;
    }
    if (/^\d/u.test(raw)) {
      const value = normaliseNumber(raw);
      current.push({ word: value, key: value, isNumber: true, capitalised: false });
      continue;
    }
    const lower = raw.toLowerCase();
    if (lower.endsWith("n't")) {
      current.push({ word: 'not', key: 'not', isNumber: false, capitalised: false });
      continue;
    }
    const word = lower.replace(/'.*$/u, '');
    current.push({ word, key: stem(word), isNumber: false, capitalised: raw[0] !== raw[0]!.toLowerCase() });
  }
  flush(false);
  return out;
}

const isMarker = (token: Token): boolean => NEGATIONS.has(token.word) || QUALIFIERS.has(token.word);
const isContent = (token: Token): boolean => token.isNumber || !(STOPWORDS.has(token.word) || isMarker(token) || FIRST_PERSON.has(token.word));
const comparable = (list: readonly Token[]): Token[] => list.filter((token) => !ARTICLES.has(token.word));
const sameKeys = (a: readonly Token[], b: readonly Token[]): boolean =>
  a.length === b.length && a.every((token, index) => token.key === b[index]!.key);

/**
 * The employer's names as key runs (articles left out): the whole name ("Emp1 Corp Group"), and the
 * name without a trailing legal form or initials ("Northwind Freight" for "Northwind Freight B.V.").
 */
function nameRunsOf(employerNames: readonly string[]): string[][] {
  const runs = new Map<string, string[]>();
  for (const name of employerNames) {
    const full = sentences(name)
      .flatMap((sentence) => sentence.tokens)
      .filter((token) => !ARTICLES.has(token.word));
    const trimmed = [...full];
    while (trimmed.length > 1 && (LEGAL_FORMS.has(trimmed[trimmed.length - 1]!.word) || trimmed[trimmed.length - 1]!.word.length === 1)) trimmed.pop();
    for (const run of [full, trimmed]) {
      const keys = run.map((token) => token.key);
      if (keys.length > 0 && run.some((token) => !token.isNumber)) runs.set(keys.join(' '), keys);
    }
  }
  return [...runs.values()];
}

/** The first (longest) employer-name run in `list`, as [start, end). */
function findName(list: readonly Token[], runs: readonly string[][]): [number, number] | null {
  for (let start = 0; start < list.length; start += 1) {
    let best = 0;
    for (const run of runs) {
      if (run.length > best && start + run.length <= list.length && run.every((key, offset) => list[start + offset]!.key === key)) best = run.length;
    }
    if (best > 0) return [start, start + best];
  }
  return null;
}

/** Capitalised words other than a sentence's first word: names of people, places, organisations. */
function namesIn(sentence: Sentence, known: ReadonlySet<string>): Token[] {
  return sentence.tokens.filter(
    (token, index) =>
      index > 0 && token.capitalised && !known.has(token.key) && !STOPWORDS.has(token.word) && !isMarker(token) && !FIRST_PERSON.has(token.word),
  );
}

/**
 * The deterministic, fail-closed support floor (#689): may this passage stand behind this exact
 * claim? A WORDING check only, and deliberately strict -- the claim must repeat ONE WHOLE statement
 * of the passage:
 *
 *  - the claim is one sentence and says something beyond the employer's name (>= 2 distinct content
 *    words besides the name, at least one of them an ordinary word);
 *  - it equals one whole sentence of the passage, word for word, ignoring only a/an/the (de/het/een),
 *    punctuation inside the sentence, letter case, a plural/3rd-person "-s", number formatting
 *    (12,000 = 12.000) and is/are, has/have. Nothing may be dropped: not a trailing "but not for this
 *    role", "except engineering", "only for senior hires", "maar niet voor deze rol", nor a date or a
 *    number. Nothing may be borrowed from another sentence, clause or organisation;
 *  - the employer is the statement's subject: its name opens the claim (after at most "In 2019," /
 *    "Since 2020," / "the"), or the sentence says "we"/"wij" where the claim has the name -- and then
 *    no other organisation is named in that sentence, its lead-in or a related sentence. A claim
 *    without the employer as subject is accepted only when the caller allows it (a role-scope claim
 *    on the employer's own posting);
 *  - a ';' / ':' clause is part of its sentence: a claim equal to one clause only is refused;
 *  - the sentence directly before and directly after it (whatever it opens with, sharing a word or
 *    not), every other sentence of the passage on the same subject (sharing a content word), and a
 *    lead-in ("Acme says:") contain no negation, restriction, condition or attribution marker ("not",
 *    "only", "except", "excluded", "unless", "some", "if", "according to", "maar", "alleen",
 *    "uitgesloten"...), and no same-subject sentence adds a number it leaves out;
 *  - an unnamed-subject role claim (own source only) refers to this role and names no other
 *    organisation (`unnamedRoleStatement`).
 *
 * A paraphrase therefore stays a lead even when it is true: the person can confirm it themselves.
 * This shows the claim repeats a statement found on the page, never that the statement is true.
 */
export function assessQuoteSupport(
  claim: string,
  quote: string,
  employerNames: readonly string[] = [],
  options: QuoteSupportOptions = {},
): QuoteSupport {
  const fail = (reason: QuoteSupportFailure): QuoteSupport => ({ ok: false, reason });
  const passage = sentences(quote);
  if (quote.replace(/\s+/gu, ' ').trim().length < MIN_QUOTE_CHARS || passage.length === 0) return fail('quote_missing');
  const claimSentences = sentences(claim);
  if (claimSentences.length === 0) return fail('claim_too_vague');
  if (claimSentences.length > 1) return fail('claim_not_whole_sentence');
  const said = comparable(claimSentences[0]!.tokens);
  // A claim speaks ABOUT the employer by name; "we"/"our" in a claim has no checkable subject.
  if (said.some((token) => FIRST_PERSON.has(token.word))) return fail('claim_entity_mismatch');
  const runs = nameRunsOf(employerNames);
  const nameKeys = new Set(runs.flat());

  const content = new Set(said.filter((token) => isContent(token) && !nameKeys.has(token.key)).map((token) => token.key));
  const predicate = said.some((token) => !token.isNumber && !token.capitalised && isContent(token) && !nameKeys.has(token.key));
  if (content.size < 2 || !predicate) return fail('claim_too_vague');

  const allTokens = passage.flatMap((sentence) => sentence.tokens);
  const passageKeys = new Set(allTokens.map((token) => token.key));
  for (const token of said) if (token.isNumber && !passageKeys.has(token.key)) return fail('claim_number_mismatch');
  const firstPersonPassage = allTokens.some((token) => FIRST_PERSON.has(token.word));
  for (const token of said) {
    if (token.capitalised && !token.isNumber && isContent(token) && !passageKeys.has(token.key)) {
      if (!(firstPersonPassage && nameKeys.has(token.key))) return fail('claim_entity_mismatch');
    }
  }

  const name = findName(said, runs);
  const namedSubject = name !== null && said.slice(0, name[0]).every((token) => token.isNumber || SUBJECT_LEAD.has(token.word));
  const claimKeys = new Set(said.map((token) => token.key));

  // ONE whole ORIGINAL sentence, exactly (or with "we" where the claim has the employer's name).
  const matches = (words: readonly Token[]): 'exact' | 'first_person' | null => {
    if (sameKeys(said, words)) return 'exact';
    if (namedSubject && name) {
      const [start, end] = name;
      const pronoun = words[start];
      if (
        pronoun &&
        FIRST_PERSON_SUBJECT.has(pronoun.word) &&
        words.length === said.length - (end - start) + 1 &&
        sameKeys(said.slice(0, start), words.slice(0, start)) &&
        sameKeys(said.slice(end), words.slice(start + 1))
      ) {
        return 'first_person';
      }
    }
    return null;
  };
  let matchIndex = -1;
  let firstPerson = false;
  for (const [index, sentence] of passage.entries()) {
    const found = matches(comparable(sentence.tokens));
    if (found) {
      matchIndex = index;
      firstPerson = found === 'first_person';
      break;
    }
  }
  const known = new Set([...claimKeys, ...nameKeys]);
  if (matchIndex < 0) {
    // The claim is ONE ';' / ':' clause of a longer sentence: it drops the rest of that sentence.
    for (const sentence of passage) {
      const clauses = clausesOf(sentence);
      if (clauses.length < 2) continue;
      const at = clauses.findIndex((clause) => matches(comparable(clause.tokens)) !== null);
      if (at < 0) continue;
      const rest = clauses.filter((_, index) => index !== at);
      return fail(rest.some((clause) => clause.tokens.some(isMarker)) ? 'claim_context_qualified' : 'claim_not_whole_sentence');
    }
    return diagnose(said, passage.flatMap(clausesOf), runs, nameKeys, firstPersonPassage);
  }

  if (!namedSubject) {
    if (!options.unnamedSubjectAllowed) return fail('claim_entity_mismatch');
    // Without the employer's name, the sentence must be about THIS role and name no other organisation:
    // the exact own source alone does not make "Acme Haulage offers visa sponsorship" a fact about it.
    if (!unnamedRoleStatement(claimSentences[0]!.tokens, said, nameKeys, options.roleLabel)) return fail('claim_entity_mismatch');
  }

  // The rest of the passage: the sentences right before and after it, related sentences, a lead-in.
  for (const [index, sentence] of passage.entries()) {
    if (index === matchIndex) continue;
    // The sentence directly before or after: ANY marker in it may limit the claim, whatever it opens
    // with and even when it shares no word ("Engineering roles are excluded from it today.").
    const adjacent = index === matchIndex - 1 || index === matchIndex + 1;
    // Same subject: shares a content word (not the employer's name) with the claim.
    const sameSubject = sentence.tokens.some((token) => isContent(token) && !nameKeys.has(token.key) && claimKeys.has(token.key));
    const leadIn = index === matchIndex - 1 && (sentence.leadIn || firstPerson);
    if (!sameSubject && !adjacent && !leadIn) continue;
    if (sentence.tokens.some(isMarker)) return fail('claim_context_qualified');
    // A different figure on the same subject may revise or scope the claim's ("14 depots. 9 of the depots...").
    if (sameSubject && sentence.tokens.some((token) => token.isNumber && !claimKeys.has(token.key))) return fail('claim_context_qualified');
    // "Acme Haulage says:" / "Acme Haulage is a carrier. We operate...": "we" may be someone else.
    if (leadIn && namesIn(sentence, known).length > 0 && (sentence.leadIn || findName(comparable(sentence.tokens), runs) === null)) {
      return fail('claim_entity_mismatch');
    }
  }
  return { ok: true };
}

/** Words before which a single capitalised word is read as a place ("based in Rotterdam"). */
const PLACE_PREPOSITIONS = new Set(['in', 'near', 'across', 'throughout', 'outside', 'te', 'nabij', 'buiten']);

/**
 * Whether a claim WITHOUT the employer as its subject is a statement about this role and nobody else
 * (#689 review 3, P2). It must refer to the role ("this role", "the Data Engineer position", "deze
 * functie", or the vacancy's own title), open with an ordinary word or that role reference, and name
 * no other organisation: every other capitalised word must be the employer's name, a role title
 * directly before a role noun or the title itself, or ONE word of a place after "in"/"te"/... An
 * unknown first word ("Acme offers...", "Contoso biedt...", a shortened alias of the employer) or
 * any other capitalised run ("Acme Haulage", "at Acme", "In Rotterdam, Acme") keeps it a lead.
 */
function unnamedRoleStatement(raw: readonly Token[], said: readonly Token[], nameKeys: ReadonlySet<string>, roleLabel?: string): boolean {
  const title = roleLabel ? comparable(sentences(roleLabel).flatMap((sentence) => sentence.tokens)).map((token) => token.key) : [];
  let titleAt = -1;
  if (title.length > 0) {
    for (let start = 0; start + title.length <= said.length && titleAt < 0; start += 1) {
      if (title.every((key, offset) => said[start + offset]!.key === key)) titleAt = start;
    }
  }
  const inTitle = (index: number) => titleAt >= 0 && index >= titleAt && index < titleAt + title.length;
  const named = (token: Token) =>
    token.capitalised && !token.isNumber && !nameKeys.has(token.key) && !STOPWORDS.has(token.word) && !FIRST_PERSON.has(token.word) && !isMarker(token) && !ROLE_NOUNS.has(token.key);

  // A role noun after a determiner, with an optional capitalised title between ("the Data Engineer role").
  const aboutRole =
    titleAt >= 0 ||
    raw.some((token, index) => {
      if (!ROLE_NOUNS.has(token.key)) return false;
      let before = index - 1;
      while (before >= 0 && raw[before]!.capitalised && !raw[before]!.isNumber && !ROLE_DETERMINERS.has(raw[before]!.word)) before -= 1;
      return before >= 0 && ROLE_DETERMINERS.has(raw[before]!.word);
    });
  if (!aboutRole) return false;

  /** End of the capitalised run starting at `index`, and whether a role noun directly follows it. */
  const runAt = (index: number): { end: number; title: boolean } => {
    let end = index;
    while (end < said.length && said[end]!.capitalised && !said[end]!.isNumber && !ROLE_NOUNS.has(said[end]!.key) && !nameKeys.has(said[end]!.key)) end += 1;
    return { end, title: end > index && end < said.length && ROLE_NOUNS.has(said[end]!.key) };
  };
  const opener = said[0];
  if (!opener || opener.isNumber) return false;
  const openerOrdinary =
    STOPWORDS.has(opener.word) ||
    SUBJECT_LEAD.has(opener.word) ||
    OPENERS.has(opener.word) ||
    ROLE_NOUNS.has(opener.key) ||
    ROLE_CLAIM_OPENERS.has(opener.word) ||
    mentionsSponsorship(opener.word);
  if (!openerOrdinary && !inTitle(0) && !runAt(0).title) return false;

  for (let index = openerOrdinary ? 1 : 0; index < said.length; index += 1) {
    if (inTitle(index) || !named(said[index]!)) continue;
    const run = runAt(index);
    if (run.title) {
      index = run.end;
      continue;
    }
    const before = said[index - 1];
    if (run.end - index === 1 && before && PLACE_PREPOSITIONS.has(before.word)) continue;
    return false;
  }
  return true;
}

/** Why no sentence matched: the most specific reason the closest sentence gives. */
function diagnose(
  said: readonly Token[],
  passage: readonly Sentence[],
  runs: readonly string[][],
  nameKeys: ReadonlySet<string>,
  firstPersonPassage: boolean,
): QuoteSupport {
  const fail = (reason: QuoteSupportFailure): QuoteSupport => ({ ok: false, reason });
  const wanted = new Set(
    said.filter((token) => isContent(token) && !(firstPersonPassage && nameKeys.has(token.key))).map((token) => token.key),
  );
  const claimKeys = new Set(said.map((token) => token.key));
  let best: Sentence | null = null;
  let bestCover = -1;
  for (const sentence of passage) {
    const keys = new Set(sentence.tokens.map((token) => token.key));
    const cover = [...wanted].filter((key) => keys.has(key)).length;
    if (cover > bestCover) {
      best = sentence;
      bestCover = cover;
    }
  }
  if (!best) return fail('claim_not_in_quote');
  const markers = (list: readonly Token[]) => [...new Set(list.filter(isMarker).map((token) => token.word))].sort().join('|');
  const covered = bestCover === wanted.size;
  if (covered && markers(said) !== markers(best.tokens)) return fail('claim_negation_mismatch');
  const known = new Set([...claimKeys, ...nameKeys]);
  const words = comparable(best.tokens);
  // The sentence starts with exactly the claim and goes on ("...employs 450 people" of "...across
  // Europe"): a shortened sentence, not another subject, so the reason says so (#689 review 3, P3).
  const shortened = covered && words.length > said.length && sameKeys(said, words.slice(0, said.length));
  const foreign = best.tokens.some(
    (token, index) =>
      token.capitalised && !token.isNumber && !known.has(token.key) && !STOPWORDS.has(token.word) && !isMarker(token) && !FIRST_PERSON.has(token.word) && (index > 0 || isContent(token)),
  );
  if (foreign && bestCover > 0 && !shortened) return fail('claim_entity_mismatch');
  // The sentence names the employer, but not as its subject ("Contoso acquired Northwind Freight").
  const named = findName(words, runs);
  if (covered && named && !words.slice(0, named[0]).every((token) => token.isNumber || SUBJECT_LEAD.has(token.word))) return fail('claim_entity_mismatch');
  if (covered && best.tokens.some((token) => token.isNumber && !claimKeys.has(token.key))) return fail('claim_number_mismatch');
  if (covered) return fail('claim_not_whole_sentence');
  const everywhere = new Set(passage.flatMap((sentence) => sentence.tokens.map((token) => token.key)));
  return [...wanted].every((key) => everywhere.has(key)) ? fail('claim_not_whole_sentence') : fail('claim_not_in_quote');
}

/**
 * Sponsorship / visa / work-permit / immigration wording (English and Dutch). Decided from the claim
 * AND its quote, never from the topic label a model or a form supplied, so a mislabelled claim still
 * has to meet the sponsorship rule. Over-matching is deliberate: it can only make a claim harder to use.
 */
const SPONSORSHIP_WORDING =
  /\b(?:visas?|visum\w*|sponsor\w*|work[\s-]permits?|work[\s-]authori[sz]ation|right[\s-]to[\s-]work|kennismigrant\w*|highly[\s-]skilled[\s-]migrants?|blue[\s-]card|blauwe[\s-]kaart|werkvergunning\w*|tewerkstellingsvergunning\w*|verblijfsvergunning\w*|verblijfsdocument\w*|residence[\s-]permits?|residency[\s-]permits?|(?:single|combined)[\s-]permits?|gvva|erkend[\s-]referent\w*|ind|immigra\w*|(?:non|niet)[\s-]?eu|third[\s-]countr\w*|derdelander\w*|expat\w*|30[\s-]?%[\s-]?(?:ruling|regeling|tax)|30[\s-]?(?:percent|procent)[\s-]?(?:ruling|regeling)|dertig[\s-]?procent\w*)\b/u;

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

/**
 * Whether a claim that does not name the employer as its subject may still be supported: only a
 * ROLE-scope claim (about this posting) whose source is the employer's own posting or site, never a
 * company-scope claim and never one that arrived over a link.
 */
export function unnamedSubjectAllowed(
  fact: Pick<CompanyEvidenceFactData, 'scope' | 'sourceUrl' | 'viaLink'>,
  identity: Pick<CompanyIdentity, 'verifiedKey' | 'host'> | null | undefined,
): boolean {
  return fact.scope === 'role' && fact.viaLink === null && !!identity && sourceMatchesIdentity(fact.sourceUrl, identity);
}

/** The quote floor for one stored fact (the linked company's name counts as an own name for its facts). */
export function factQuoteSupport(
  fact: Pick<CompanyEvidenceFactData, 'claim' | 'quote' | 'viaLink' | 'scope' | 'sourceUrl' | 'roleLabel'>,
  employerNames: readonly string[] = [],
  identity?: Pick<CompanyIdentity, 'verifiedKey' | 'host'> | null,
): QuoteSupport {
  return assessQuoteSupport(fact.claim, fact.quote, fact.viaLink ? [...employerNames, fact.viaLink] : employerNames, {
    unnamedSubjectAllowed: unnamedSubjectAllowed(fact, identity),
    roleLabel: fact.roleLabel,
  });
}

export function classifyFact(fact: CompanyEvidenceFactData, ctx: ClassificationContext, now: Date): ClassifiedFact {
  const reasons: CompanyEvidenceLeadReason[] = [];
  if (fact.status === 'withdrawn') reasons.push('withdrawn');
  if (fact.status === 'superseded') reasons.push('superseded');
  if (!ctx.identityVerified) reasons.push('identity_not_verified');
  if (fact.verification === 'unverified') reasons.push('unverified');
  // A person's explicit confirmation is their own attested observation; everything else that
  // claims support must pass the quote floor, re-checked here on every read and every prose use.
  if (fact.verification !== 'user_confirmed') {
    const floor = factQuoteSupport(fact, ctx.employerNames ?? [], ctx.identity);
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
  claim_not_in_quote: 'The saved passage does not say this in these words. Only a claim that repeats one whole sentence of its passage is used automatically.',
  claim_not_whole_sentence:
    'The claim leaves out part of the sentence it comes from (or joins words from different sentences), and the left-out words may limit it. Only a claim that repeats one whole sentence of its passage is used automatically.',
  claim_too_vague: 'The claim says too little beyond the company name to be checked against a passage.',
  claim_number_mismatch: 'A number or date in the claim is not in the saved passage, or the sentence it comes from has one the claim leaves out.',
  claim_negation_mismatch:
    'The claim and the passage differ in wording such as "not", "only", "except", "but", "some", "will" or "formerly", so they may not say the same thing.',
  claim_entity_mismatch:
    'The claim and its passage differ in who or what is named, or the sentence is not about this employer as its subject (for example it is about another organisation, or a sentence without the employer\'s name does not clearly refer to this role).',
  claim_context_qualified:
    'Wording right next to the passage limits or hedges it (such as "not", "only", "except", "excluded", "but", "if" or "according to"): in the rest of its sentence after a ";" or ":", in the sentence right before or after it, or in another sentence on the same subject. So it is not used automatically.',
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
