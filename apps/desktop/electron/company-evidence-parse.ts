import {
  COMPANY_EVIDENCE_TOPICS,
  type ActionStats,
  type ClassifiedFact,
  type CompanyEvidenceContradictionView,
  type CompanyEvidenceLeadReason,
  type CompanyEvidenceLinkView,
  type CompanyEvidenceProseFact,
  type CompanyEvidenceResult,
  type CompanyEvidenceTopic,
  type CompanyEvidenceUseView,
  type CompanyEvidenceView,
  type CompanyIdentity,
  type CompanyResearchDiagnostics,
} from './company-evidence.js';

/**
 * Fail-closed parsing of what crosses the preload boundary (#689). The renderer only ever sees
 * objects REBUILT from known fields with known enum values: an unrecognised status, a missing
 * field or a malformed fact is dropped (a fact) or collapses to a plain refusal (the whole view),
 * never passed through. Pure on purpose: the sandboxed preload may not touch a Node built-in.
 */

type Rec = Record<string, unknown>;

function rec(value: unknown): Rec | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Rec) : null;
}
const str = (source: Rec, key: string, max = 4000): string | null =>
  typeof source[key] === 'string' ? (source[key] as string).slice(0, max) : null;
const num = (source: Rec, key: string): number =>
  typeof source[key] === 'number' && Number.isFinite(source[key]) ? (source[key] as number) : 0;
function oneOf<T extends string>(value: unknown, allowed: readonly T[]): T | null {
  return typeof value === 'string' && (allowed as readonly string[]).includes(value) ? (value as T) : null;
}

const REASONS: readonly CompanyEvidenceLeadReason[] = [
  'withdrawn',
  'superseded',
  'expired',
  'unverified',
  'contradicted',
  'other_role',
  'identity_not_verified',
  'ind_name_match_only',
  'sponsorship_needs_role_source',
  'source_not_https',
];

function parseIdentity(value: unknown): CompanyIdentity | null {
  const source = rec(value);
  if (!source) return null;
  const displayName = str(source, 'displayName', 200);
  if (displayName === null) return null;
  const keyKind = oneOf(source.keyKind, ['ats_tenant', 'posting_host', 'user_domain'] as const);
  const verifiedKey = str(source, 'verifiedKey', 300);
  return {
    verifiedKey: keyKind && verifiedKey ? verifiedKey : null,
    keyKind: keyKind && verifiedKey ? keyKind : null,
    host: str(source, 'host', 253),
    displayName,
    nameKey: str(source, 'nameKey', 200) ?? '',
  };
}

function parseFact(value: unknown): ClassifiedFact | null {
  const source = rec(value);
  if (!source) return null;
  const id = str(source, 'id', 200);
  const recordId = str(source, 'recordId', 200);
  const claim = str(source, 'claim', 600);
  const sourceUrl = str(source, 'sourceUrl', 2048);
  const observedAt = str(source, 'observedAt', 40);
  const expiresAt = str(source, 'expiresAt', 40);
  const scope = oneOf(source.scope, ['company', 'role'] as const);
  const topic = oneOf<CompanyEvidenceTopic>(source.topic, COMPANY_EVIDENCE_TOPICS);
  const sourceKind = oneOf(source.sourceKind, ['company_site', 'ats_posting', 'public_web', 'ind_register'] as const);
  const verification = oneOf(source.verification, ['unverified', 'source_confirmed', 'user_confirmed'] as const);
  const origin = oneOf(source.origin, ['user', 'research'] as const);
  const status = oneOf(source.status, ['active', 'superseded', 'withdrawn'] as const);
  const support = oneOf(source.support, ['supported', 'lead'] as const);
  if (!id || !recordId || !claim || !sourceUrl || !observedAt || !expiresAt || !scope || !topic || !sourceKind || !verification || !origin || !status || !support) {
    return null;
  }
  const correction = rec(source.correction);
  const original = correction ? str(correction, 'originalClaim', 600) : null;
  const correctedAt = correction ? str(correction, 'correctedAt', 40) : null;
  return {
    id,
    recordId,
    scope,
    roleKey: str(source, 'roleKey', 300) ?? '',
    roleLabel: str(source, 'roleLabel', 200) ?? '',
    topic,
    claim,
    sourceUrl,
    sourceKind,
    quote: str(source, 'quote', 600) ?? '',
    retrievedAt: str(source, 'retrievedAt', 40),
    observedAt,
    expiresAt,
    verification,
    origin,
    status,
    lastRefreshAt: str(source, 'lastRefreshAt', 40),
    lastRefreshOutcome: oneOf(source.lastRefreshOutcome, ['renewed', 'failed', 'source_changed', 'cache_hit'] as const),
    lastRefreshReason: str(source, 'lastRefreshReason', 80),
    correction: original && correctedAt ? { originalClaim: original, correctedAt } : null,
    contradictedBy: Array.isArray(source.contradictedBy) ? source.contradictedBy.filter((v): v is string => typeof v === 'string').slice(0, 20) : [],
    viaLink: str(source, 'viaLink', 200),
    support,
    reasons: Array.isArray(source.reasons)
      ? source.reasons.map((reason) => oneOf(reason, REASONS)).filter((reason): reason is CompanyEvidenceLeadReason => reason !== null)
      : [],
    official: source.official === true,
  };
}

function parseResearch(value: unknown): CompanyResearchDiagnostics | null {
  const source = rec(value);
  if (!source) return null;
  const status = oneOf(source.status, ['completed', 'cancelled', 'failed', 'timed_out', 'budget_exceeded', 'unavailable', 'cache_hit'] as const);
  const at = str(source, 'at', 40);
  if (!status || !at) return null;
  return {
    at,
    status,
    reason: str(source, 'reason', 80) ?? '',
    queries: Array.isArray(source.queries) ? source.queries.filter((q): q is string => typeof q === 'string').slice(0, 20).map((q) => q.slice(0, 200)) : [],
    searches: num(source, 'searches'),
    fetches: num(source, 'fetches'),
    candidates: num(source, 'candidates'),
    confirmed: num(source, 'confirmed'),
  };
}

function parseUses(value: unknown): CompanyEvidenceUseView[] {
  const uses: CompanyEvidenceUseView[] = [];
  for (const raw of Array.isArray(value) ? value.slice(0, 20) : []) {
    const item = rec(raw);
    const claim = item ? str(item, 'claim', 600) : null;
    const sourceUrl = item ? str(item, 'sourceUrl', 2048) : null;
    const observedAt = item ? str(item, 'observedAt', 40) : null;
    const scope = item ? oneOf(item.scope, ['company', 'role'] as const) : null;
    const verification = item ? oneOf(item.verification, ['source_confirmed', 'user_confirmed'] as const) : null;
    if (claim && sourceUrl && observedAt && scope && verification) uses.push({ claim, sourceUrl, scope, observedAt, verification });
  }
  return uses;
}

export function parseCompanyEvidenceView(value: unknown): CompanyEvidenceView | null {
  const source = rec(value);
  const identity = source ? parseIdentity(source.identity) : null;
  if (!source || !identity) return null;
  const facts = Array.isArray(source.facts)
    ? source.facts.map(parseFact).filter((fact): fact is ClassifiedFact => fact !== null).slice(0, 200)
    : [];
  const contradictions: CompanyEvidenceContradictionView[] = [];
  for (const raw of Array.isArray(source.contradictions) ? source.contradictions : []) {
    const item = rec(raw);
    const id = item ? str(item, 'id', 200) : null;
    const factAId = item ? str(item, 'factAId', 200) : null;
    const factBId = item ? str(item, 'factBId', 200) : null;
    const topic = item ? oneOf<CompanyEvidenceTopic>(item.topic, COMPANY_EVIDENCE_TOPICS) : null;
    if (id && factAId && factBId && topic) contradictions.push({ id, factAId, factBId, topic });
  }
  const links: CompanyEvidenceLinkView[] = [];
  for (const raw of Array.isArray(source.links) ? source.links : []) {
    const item = rec(raw);
    const id = item ? str(item, 'id', 200) : null;
    const otherRecordId = item ? str(item, 'otherRecordId', 200) : null;
    const otherName = item ? str(item, 'otherName', 200) : null;
    const status = item ? oneOf(item.status, ['proposed', 'confirmed', 'rejected'] as const) : null;
    if (item && id && otherRecordId && otherName && status) {
      links.push({ id, otherRecordId, otherName, otherHost: str(item, 'otherHost', 253), status });
    }
  }
  return {
    state: identity.verifiedKey ? 'ready' : 'no_identity',
    identity,
    recordId: str(source, 'recordId', 200),
    entityRef: str(source, 'entityRef', 80) ?? '',
    roleKey: str(source, 'roleKey', 300),
    roleLabel: str(source, 'roleLabel', 200) ?? '',
    facts,
    contradictions,
    links,
    research: parseResearch(source.research),
    lettersUsed: parseUses(source.lettersUsed),
    supportedCount: facts.filter((fact) => fact.support === 'supported').length,
    leadCount: facts.filter((fact) => fact.support === 'lead' && !fact.reasons.includes('other_role')).length,
    generatedAt: str(source, 'generatedAt', 40) ?? new Date(0).toISOString(),
  };
}

function parseStats(value: unknown): ActionStats | undefined {
  const source = rec(value);
  if (!source) return undefined;
  return {
    requests: num(source, 'requests'),
    sessions: num(source, 'sessions'),
    avoidedSessions: num(source, 'avoidedSessions'),
    avoidedFetches: num(source, 'avoidedFetches'),
    cacheHit: source.cacheHit === true,
    renewed: num(source, 'renewed'),
    demoted: num(source, 'demoted'),
    failed: num(source, 'failed'),
    candidates: num(source, 'candidates'),
    confirmed: num(source, 'confirmed'),
  };
}

const REFUSED: CompanyEvidenceResult = { ok: false, code: 'invalid_response', message: 'The app could not read the answer. Nothing was changed.' };

export function parseCompanyEvidenceResult(value: unknown): CompanyEvidenceResult {
  const source = rec(value);
  if (!source) return REFUSED;
  if (source.ok === true) {
    const view = parseCompanyEvidenceView(source.view);
    if (!view) return REFUSED;
    const stats = parseStats(source.stats);
    return { ok: true, view, notice: str(source, 'notice', 400) ?? '', ...(stats ? { stats } : {}) };
  }
  if (source.ok === false) {
    return { ok: false, code: str(source, 'code', 60) ?? 'failed', message: str(source, 'message', 300) ?? 'Something went wrong.' };
  }
  return REFUSED;
}

export function parseCompanyEvidenceProse(value: unknown): { ok: boolean; facts: CompanyEvidenceProseFact[] } {
  const source = rec(value);
  if (!source || source.ok !== true || !Array.isArray(source.facts)) return { ok: false, facts: [] };
  const facts: CompanyEvidenceProseFact[] = [];
  for (const raw of source.facts.slice(0, 20)) {
    const item = rec(raw);
    if (!item) continue;
    const id = str(item, 'id', 200);
    const claim = str(item, 'claim', 600);
    const sourceUrl = str(item, 'sourceUrl', 2048);
    const observedAt = str(item, 'observedAt', 40);
    const expiresAt = str(item, 'expiresAt', 40);
    const scope = oneOf(item.scope, ['company', 'role'] as const);
    const topic = oneOf<CompanyEvidenceTopic>(item.topic, COMPANY_EVIDENCE_TOPICS);
    const verification = oneOf(item.verification, ['source_confirmed', 'user_confirmed'] as const);
    if (!id || !claim || !sourceUrl || !observedAt || !expiresAt || !scope || !topic || !verification) continue;
    facts.push({
      id,
      claim,
      scope,
      topic,
      sourceUrl,
      observedAt,
      retrievedAt: str(item, 'retrievedAt', 40),
      expiresAt,
      verification,
      viaLink: str(item, 'viaLink', 200),
    });
  }
  return { ok: true, facts };
}

export function parseCancelResult(value: unknown): { ok: boolean; cancelled: boolean } {
  const source = rec(value);
  return { ok: source?.ok === true, cancelled: source?.cancelled === true };
}
