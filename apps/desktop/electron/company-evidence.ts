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
 */

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
  /** `ats:<provider>:<board>` | `host:<host>` | `domain:<host>`; null = not verified. */
  verifiedKey: string | null;
  keyKind: CompanyEvidenceKeyKind | null;
  /** The employer host (posting host or confirmed domain) or the ATS host for a tenant, if any. */
  host: string | null;
  displayName: string;
  /** Normalised name, used ONLY to PROPOSE a link between look-alike records, never as identity. */
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

/** Job boards and aggregators: a posting hosted here says nothing about who the employer is. */
const AGGREGATOR_HOSTS = [
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
];

const GENERIC_SUBDOMAINS = new Set(['www', 'careers', 'career', 'jobs', 'job', 'apply', 'work', 'boards', 'join']);

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
  }
  host = host.replace(/\.$/u, '');
  if (!/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,24}$/u.test(host)) return null;
  return host;
}

/** `careers.northwind.example` -> `northwind.example`; keeps a country-code second level (`.co.uk`). */
export function baseHost(host: string): string {
  const parts = host.split('.');
  while (parts.length > 2 && GENERIC_SUBDOMAINS.has(parts[0]!)) parts.shift();
  return parts.join('.');
}

function isAggregatorHost(host: string): boolean {
  return AGGREGATOR_HOSTS.some((blocked) => host === blocked || host.endsWith(`.${blocked}`));
}

/** The registrable-ish label (`northwind` for `careers.northwind.example`). */
function brandLabel(host: string): string {
  const parts = baseHost(host).split('.');
  const secondLevel = new Set(['co', 'com', 'org', 'net', 'ac', 'gov']);
  const labelIndex = parts.length >= 3 && secondLevel.has(parts[parts.length - 2]!) ? parts.length - 3 : parts.length - 2;
  return parts[Math.max(0, labelIndex)] ?? '';
}

/** A first-party host only counts when its brand label is recognisably the company named. */
function hostPlausiblyBelongsTo(host: string, company: string): boolean {
  if (isAggregatorHost(host)) return false;
  const label = brandLabel(host).replace(/[^a-z0-9]/gu, '');
  const name = nameKeyOf(company).replace(/-/gu, '');
  if (label.length < 4 || name.length < 4) return false;
  return name === label || name.startsWith(label) || label.startsWith(name);
}

export interface DeriveIdentityInput {
  company: string;
  canonicalUrl: string;
  /** From `deriveApplicationIdentity`: `<provider>:<board>` for a recognised ATS URL. */
  employerKey: string;
}

/**
 * The verified identity of the employer a vacancy names, or `verifiedKey: null` when the only
 * thing known is a name. Never throws, never reaches the network.
 */
export function deriveCompanyIdentity(input: DeriveIdentityInput): CompanyIdentity {
  const displayName = sanitizeLabel(input.company) || 'this company';
  const nameKey = nameKeyOf(input.company);
  const tenant = /^([a-z0-9]+):([a-z0-9._-]+)$/u.exec(input.employerKey.trim());
  let host: string | null;
  let isHttps: boolean;
  try {
    const url = new URL(input.canonicalUrl.trim());
    isHttps = url.protocol === 'https:' && !url.username && !url.password;
    host = cleanHost(url.hostname);
  } catch {
    isHttps = false;
    host = null;
  }
  if (tenant && isHttps) {
    return {
      verifiedKey: `ats:${tenant[1]}:${tenant[2]}`,
      keyKind: 'ats_tenant',
      host,
      displayName,
      nameKey,
    };
  }
  if (host && isHttps && hostPlausiblyBelongsTo(host, input.company)) {
    const base = baseHost(host);
    return { verifiedKey: `host:${base}`, keyKind: 'posting_host', host: base, displayName, nameKey };
  }
  return { verifiedKey: null, keyKind: null, host: null, displayName, nameKey };
}

/** The identity a person confirmed by naming the employer's own domain. */
export function identityFromConfirmedDomain(company: string, domain: string): CompanyIdentity | null {
  const host = cleanHost(domain);
  if (!host || isAggregatorHost(host)) return null;
  const base = baseHost(host);
  return {
    verifiedKey: `domain:${base}`,
    keyKind: 'user_domain',
    host: base,
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

/** Does this source live on the employer's own host (or its ATS tenant)? */
export function sourceMatchesIdentity(sourceUrl: string, identity: Pick<CompanyIdentity, 'verifiedKey' | 'host'>): boolean {
  let url: URL;
  try {
    url = new URL(sourceUrl);
  } catch {
    return false;
  }
  const host = cleanHost(url.hostname);
  if (!host) return false;
  const key = identity.verifiedKey ?? '';
  if (key.startsWith('ats:')) {
    const [, provider = '', board = ''] = key.split(':');
    return (
      url.hostname.toLowerCase().includes(provider) &&
      (url.pathname.toLowerCase().split('/').includes(board.toLowerCase()) || host.startsWith(`${board.toLowerCase()}.`))
    );
  }
  if (!identity.host) return false;
  const base = baseHost(identity.host);
  return host === base || host.endsWith(`.${base}`);
}

export function inferSourceKind(
  sourceUrl: string,
  identity: Pick<CompanyIdentity, 'verifiedKey' | 'host'>,
  declared?: CompanyEvidenceSourceKind,
): CompanyEvidenceSourceKind {
  if (declared === 'ind_register') return 'ind_register';
  let host: string;
  try {
    host = new URL(sourceUrl).hostname.toLowerCase();
  } catch {
    host = '';
  }
  if (host === 'ind.nl' || host.endsWith('.ind.nl')) return 'ind_register';
  if (sourceMatchesIdentity(sourceUrl, identity)) {
    return (identity.verifiedKey ?? '').startsWith('ats:') ? 'ats_posting' : 'company_site';
  }
  return 'public_web';
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
  correction: { originalClaim: string; correctedAt: string } | null;
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
  | 'source_not_https';

export interface ClassificationContext {
  /** The role the prose is for; null when none is known (role facts then never support). */
  roleKey: string | null;
  identityVerified: boolean;
  identity: Pick<CompanyIdentity, 'verifiedKey' | 'host'>;
}

export interface ClassifiedFact extends CompanyEvidenceFactData {
  support: 'supported' | 'lead';
  reasons: CompanyEvidenceLeadReason[];
  /** The source is on the employer's own host / ATS tenant. */
  official: boolean;
}

export function classifyFact(fact: CompanyEvidenceFactData, ctx: ClassificationContext, now: Date): ClassifiedFact {
  const reasons: CompanyEvidenceLeadReason[] = [];
  if (fact.status === 'withdrawn') reasons.push('withdrawn');
  if (fact.status === 'superseded') reasons.push('superseded');
  if (!ctx.identityVerified) reasons.push('identity_not_verified');
  if (fact.verification === 'unverified') reasons.push('unverified');
  if (Date.parse(fact.expiresAt) <= now.getTime() || Number.isNaN(Date.parse(fact.expiresAt))) reasons.push('expired');
  if (fact.contradictedBy.length > 0) reasons.push('contradicted');
  if (fact.scope === 'role' && (ctx.roleKey === null || fact.roleKey !== ctx.roleKey)) reasons.push('other_role');
  if (!isHttpsSource(fact.sourceUrl)) reasons.push('source_not_https');
  if (fact.sourceKind === 'ind_register') reasons.push('ind_name_match_only');
  const official = sourceMatchesIdentity(fact.sourceUrl, ctx.identity);
  if (fact.topic === 'sponsorship' && !(fact.scope === 'role' && official && fact.sourceKind !== 'ind_register')) {
    reasons.push('sponsorship_needs_role_source');
  }
  return { ...fact, support: reasons.length === 0 ? 'supported' : 'lead', reasons, official };
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
};

/* ------------------------------------------------------------------------- bridge ---------- */

export type CompanyEvidenceResult =
  | { ok: true; view: CompanyEvidenceView; notice: string; stats?: ActionStats }
  | { ok: false; code: string; message: string };

export interface ActionStats {
  /** Network requests this action made (safe fetches). */
  requests: number;
  /** Web research sessions this action started. */
  sessions: number;
  /** Research sessions / source fetches a stored, current fact made unnecessary. */
  avoidedSessions: number;
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
  correctFact(target: CompanyEvidenceTargetInput, factId: string, claim: string): Promise<CompanyEvidenceResult>;
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
