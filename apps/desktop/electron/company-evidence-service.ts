import type { AtsHttpClient } from '@open-vacancy-radar/vacancy-engine';
import {
  COMPANY_EVIDENCE_TOPICS,
  LEAD_REASON_TEXT,
  MAX_INTERVIEW_COMPANY_FACTS,
  MAX_LETTER_COMPANY_FACTS,
  MAX_QUOTE_CHARS,
  MIN_QUOTE_CHARS,
  assessQuoteSupport,
  classifyFact,
  deriveCompanyIdentity,
  effectiveTopic,
  employerDomainOf,
  identityFromConfirmedDomain,
  inferSourceKind,
  isHttpsSource,
  nameKeyOf,
  roleKeyFor,
  sanitizeClaim,
  sanitizeLabel,
  selectProseEvidence,
  suggestedEmployerDomain,
  type ClassificationContext,
  type ActionStats,
  type CompanyEvidenceProseFact,
  type CompanyEvidenceResult,
  type CompanyEvidenceScope,
  type CompanyEvidenceSourceKind,
  type CompanyEvidenceSuggestion,
  type CompanyEvidenceTopic,
  type CompanyEvidenceView,
  type CompanyIdentity,
  type CompanyResearchDiagnostics,
  type EmployerDomainCheck,
} from './company-evidence.js';
import {
  REFRESH_ENVELOPE_MS,
  RESEARCH_CONFIRM_PHASE_MS,
  SOURCE_CHECK_CONCURRENCY,
  SOURCE_FAILURE_TEXT,
  confirmSourceQuote,
  publicPostingReference,
  type CompanyResearchInput,
  type ResearchSessionOutcome,
  type SourceCheck,
} from './company-evidence-research.js';
import * as store from './workspace/company-evidence-store.js';
import * as workspace from './workspace/repository.js';
import { WorkspaceNotFoundError } from './workspace/repository.js';
import type { WorkspaceDb } from './workspace/client.js';
import type { ApplicationAttemptRecord } from './workspace/types.js';

/**
 * #689's service layer: resolves which employer and which role a preparation or interview is
 * about, runs the explicit evidence actions, and hands prose consumers the one approved fact list.
 *
 * Everything here is injectable (`db`, clock, safe HTTP client, research runner) so the IPC
 * handlers, the cover-letter path and the tests drive the real code against real SQLite with no
 * network. Nothing in this file reads a CV, a letter or an application note: its only inputs about
 * the candidate's side are the attempt's company, role and posting URL, which are public vacancy
 * fields.
 */

export const DEFAULT_RESEARCH_TOPICS: readonly CompanyEvidenceTopic[] = ['general', 'products', 'size', 'location', 'remote_policy'];
const MAX_REFRESH_FACTS = 8;

export type EvidenceTarget = { attemptId: string } | { applicationId: string };

export interface CompanyEvidenceDeps {
  db: WorkspaceDb;
  now: () => Date;
  /** Safe public fetch (origin-locked, no cache). Absent => confirmation by fetch is unavailable. */
  getHttp?: () => Promise<AtsHttpClient>;
  /** The explicit research session (web-only profile). Absent => research reports unavailable. */
  runResearch?: (input: CompanyResearchInput, signal: AbortSignal) => Promise<ResearchSessionOutcome>;
  log?: (message: string, meta?: Record<string, unknown>) => void;
  /** Overrides of the shared deadlines (tests); production uses the exported defaults. */
  deadlines?: { confirmPhaseMs?: number; refreshEnvelopeMs?: number };
}

function stats(partial: Partial<ActionStats> = {}): ActionStats {
  return {
    requests: 0,
    sessions: 0,
    avoidedSessions: 0,
    avoidedFetches: 0,
    cacheHit: false,
    renewed: 0,
    demoted: 0,
    failed: 0,
    candidates: 0,
    confirmed: 0,
    ...partial,
  };
}

const fail = (code: string, message: string): CompanyEvidenceResult => ({ ok: false, code, message });

/* ------------------------------------------------------------------------- context ------------ */

export interface ResolvedContext {
  identity: CompanyIdentity;
  /** The stored record, when one exists for the verified identity. */
  recordId: string | null;
  entityRef: string;
  roleKey: string | null;
  roleLabel: string;
  company: string;
  role: string;
  attemptId: string | null;
  /** The public posting URL the vacancy came from ('' when none). */
  canonicalUrl: string;
  /**
   * The concrete vacancy keys a domain confirmation for THIS target is bound to
   * (`application:<id>`, `posting:<canonical url key>`). Never a name.
   */
  bindingKeys: string[];
  /** Domains the person may confirm (only for a vacancy with no verified identity). */
  suggestions: CompanyEvidenceSuggestion[];
}

function latestAttemptFor(db: WorkspaceDb, applicationId: string): ApplicationAttemptRecord | null {
  return (
    workspace
      .listApplicationAttempts(db)
      .filter((attempt) => attempt.applicationId === applicationId)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0] ?? null
  );
}

function bindingKeysFor(applicationId: string | null, attempt: ApplicationAttemptRecord | null): string[] {
  const keys: string[] = [];
  if (applicationId) keys.push(`application:${applicationId}`);
  if (attempt?.canonicalUrlKey) keys.push(`posting:${attempt.canonicalUrlKey}`);
  return keys;
}

/** Resolves the verified employer and role an attempt or application refers to. Reads only. */
export function resolveContext(deps: CompanyEvidenceDeps, target: EvidenceTarget): ResolvedContext {
  const { db } = deps;
  let company: string;
  let role: string;
  let attempt: ApplicationAttemptRecord | null;
  let applicationId: string | null;
  let applicationAttemptsFallback = false;
  if ('attemptId' in target) {
    attempt = workspace.getApplicationAttempt(db, target.attemptId);
    company = attempt.company;
    role = attempt.role;
    applicationId = attempt.applicationId;
  } else {
    const application = workspace.listApplications(db, 'all').find((row) => row.id === target.applicationId);
    if (!application) throw new WorkspaceNotFoundError('application', target.applicationId);
    attempt = latestAttemptFor(db, application.id);
    company = application.company;
    role = application.role;
    applicationId = application.id;
    applicationAttemptsFallback = attempt === null;
  }

  let identity = deriveCompanyIdentity({
    company,
    canonicalUrl: attempt?.canonicalUrl ?? '',
    employerKey: attempt?.employerKey ?? nameKeyOf(company),
  });
  const bindingKeys = bindingKeysFor(applicationId, attempt);
  let recordId: string | null = null;
  let entityRef = '';
  const suggestions: CompanyEvidenceSuggestion[] = [];
  if (identity.verifiedKey) {
    const found = store.findRecord(deps.db, identity.verifiedKey);
    recordId = found?.id ?? null;
    entityRef = found?.entityRef ?? '';
  } else {
    // Only a domain the PERSON confirmed for THIS vacancy (application / posting) identifies it.
    const bound = store.findRecordsByConfirmedTargets(db, bindingKeys);
    const record = bound.length === 1 ? bound[0]! : null;
    if (record && record.host) {
      identity = {
        verifiedKey: record.verifiedKey,
        keyKind: record.keyKind,
        host: record.host,
        tenant: null,
        displayName: record.displayName,
        nameKey: identity.nameKey,
      };
      recordId = record.id;
      entityRef = record.entityRef;
    } else {
      const seen = new Set<string>();
      const add = (domain: string | null, basis: CompanyEvidenceSuggestion['basis']) => {
        if (domain && !seen.has(domain) && suggestions.length < 5) {
          seen.add(domain);
          suggestions.push({ domain, basis });
        }
      };
      add(suggestedEmployerDomain(attempt?.canonicalUrl ?? ''), 'posting_domain');
      for (const other of store.findConfirmedDomainsByName(db, identity.nameKey)) add(other.host, 'same_name_elsewhere');
    }
  }

  const roleKey = attempt
    ? roleKeyFor({ requisitionId: attempt.requisitionId, canonicalUrlKey: attempt.canonicalUrlKey, role: attempt.role })
    : applicationAttemptsFallback
      ? roleKeyFor({ requisitionId: null, canonicalUrlKey: '', role })
      : null;
  return {
    identity,
    recordId,
    entityRef,
    roleKey,
    roleLabel: sanitizeLabel(role, 120),
    company,
    role,
    attemptId: attempt?.id ?? null,
    canonicalUrl: attempt?.canonicalUrl ?? '',
    bindingKeys,
    suggestions,
  };
}

function employerNames(ctx: ResolvedContext): string[] {
  return [...new Set([ctx.identity.displayName, sanitizeLabel(ctx.company)].filter((name) => name !== ''))];
}

function classificationContext(ctx: ResolvedContext): ClassificationContext {
  return {
    roleKey: ctx.roleKey,
    identityVerified: ctx.identity.verifiedKey !== null,
    identity: ctx.identity,
    employerNames: employerNames(ctx),
  };
}

export function buildView(deps: CompanyEvidenceDeps, ctx: ResolvedContext, attemptId: string | null = null): CompanyEvidenceView {
  const now = deps.now();
  const facts =
    ctx.recordId && ctx.identity.verifiedKey
      ? store
          .listFactsForRecord(deps.db, ctx.recordId)
          .map((fact) => classifyFact(fact, classificationContext(ctx), now))
          // Another role's facts are shown (dimmed, with their reason) only to make scope visible.
          .sort((a, b) => Number(a.support === 'lead') - Number(b.support === 'lead') || b.observedAt.localeCompare(a.observedAt))
      : [];
  const record = ctx.recordId ? store.getRecord(deps.db, ctx.recordId) : null;
  return {
    state: ctx.identity.verifiedKey ? 'ready' : 'no_identity',
    identity: ctx.identity,
    recordId: ctx.recordId,
    entityRef: ctx.entityRef,
    roleKey: ctx.roleKey,
    roleLabel: ctx.roleLabel,
    facts,
    contradictions: ctx.recordId ? store.listOpenContradictions(deps.db, ctx.recordId) : [],
    links: ctx.recordId ? store.listLinks(deps.db, ctx.recordId) : [],
    research: record?.lastResearch ?? null,
    lettersUsed: attemptId
      ? store.listEvidenceUses(deps.db, attemptId).map((use) => ({
          claim: use.claim,
          sourceUrl: use.sourceUrl,
          scope: use.scope,
          observedAt: use.observedAt,
          verification: use.verification,
        }))
      : [],
    suggestions: ctx.suggestions,
    supportedCount: facts.filter((fact) => fact.support === 'supported').length,
    leadCount: facts.filter((fact) => fact.support === 'lead' && fact.reasons.every((reason) => reason !== 'other_role')).length,
    generatedAt: now.toISOString(),
  };
}

export function getView(deps: CompanyEvidenceDeps, target: EvidenceTarget): CompanyEvidenceView {
  return buildView(deps, resolveContext(deps, target), 'attemptId' in target ? target.attemptId : null);
}

/** The one list a letter or an interview prompt may be built from. Leads cannot appear in it. */
export function proseEvidence(
  deps: CompanyEvidenceDeps,
  target: EvidenceTarget,
  purpose: 'letter' | 'interview',
): CompanyEvidenceProseFact[] {
  const ctx = resolveContext(deps, target);
  if (!ctx.recordId || !ctx.identity.verifiedKey) return [];
  return selectProseEvidence(
    store.listFactsForRecord(deps.db, ctx.recordId),
    classificationContext(ctx),
    deps.now(),
    purpose === 'letter' ? MAX_LETTER_COMPANY_FACTS : MAX_INTERVIEW_COMPANY_FACTS,
  );
}

/* ------------------------------------------------------------------------ run registry -------- */

/** One research/refresh at a time per employer, each cancellable by the person (or a data reset). */
export class CompanyEvidenceRuns {
  readonly #runs = new Map<string, AbortController>();

  begin(key: string): AbortController | null {
    if (this.#runs.has(key)) return null;
    const controller = new AbortController();
    this.#runs.set(key, controller);
    return controller;
  }

  end(key: string, controller: AbortController): void {
    if (this.#runs.get(key) === controller) this.#runs.delete(key);
  }

  cancel(key: string): boolean {
    const controller = this.#runs.get(key);
    if (!controller) return false;
    controller.abort();
    return true;
  }

  cancelAll(): number {
    const count = this.#runs.size;
    for (const controller of this.#runs.values()) controller.abort();
    return count;
  }

  get active(): number {
    return this.#runs.size;
  }
}

function runKey(ctx: ResolvedContext): string {
  return ctx.identity.verifiedKey ?? `name:${ctx.identity.nameKey}`;
}

/* ------------------------------------------------------------------------- actions ------------ */

export interface AddFactInput {
  claim: string;
  sourceUrl: string;
  quote: string;
  scope: CompanyEvidenceScope;
  topic: CompanyEvidenceTopic;
  sourceKind?: CompanyEvidenceSourceKind;
  /** ISO date the person saw it; defaults to now. Never used to extend expiry beyond the TTL from this date. */
  observedAt?: string;
}

function requireVerified(ctx: ResolvedContext): CompanyEvidenceResult | null {
  return ctx.identity.verifiedKey
    ? null
    : fail('identity_not_verified', 'Confirm the company website first. A name alone cannot identify an employer.');
}

const RECORD_FULL = (): CompanyEvidenceResult =>
  fail('record_full', `This company already has ${store.MAX_FACTS_PER_RECORD} saved claims. Remove some before adding more.`);

const DOMAIN_REFUSAL: Record<Exclude<EmployerDomainCheck, { ok: true }>['reason'], string> = {
  invalid_domain: "Enter the employer's own website address, such as example.com.",
  shared_or_public_domain:
    'That address is a shared hosting service or a public suffix, where anyone can publish. Enter the employer\'s own domain.',
  job_board_domain: "That is a job board or recruiting system, not the employer's own website.",
};

export function confirmDomain(
  deps: CompanyEvidenceDeps,
  target: EvidenceTarget,
  input: { domain: string; entityRef?: string },
): CompanyEvidenceResult {
  const ctx = resolveContext(deps, target);
  if (ctx.identity.verifiedKey) {
    return fail('already_verified', 'This vacancy is already identified. Delete its company evidence to start again.');
  }
  const check = employerDomainOf(input.domain);
  if (!check.ok) return fail(check.reason, DOMAIN_REFUSAL[check.reason]);
  const identity = identityFromConfirmedDomain(ctx.company, check.domain);
  if (!identity) return fail('invalid_domain', DOMAIN_REFUSAL.invalid_domain);
  if (ctx.bindingKeys.length === 0) return fail('no_target', 'This vacancy has no posting or application to confirm the website for.');
  const entityRef = sanitizeLabel(input.entityRef ?? '', 80).toLowerCase();
  const now = deps.now();
  const { record } = store.ensureRecord(deps.db, identity, now, entityRef);
  // Bound to THIS vacancy (its application and its posting), never to every vacancy with the name.
  store.addConfirmedTargets(deps.db, record.id, ctx.bindingKeys, now);
  return {
    ok: true,
    view: getView(deps, target),
    notice: `Recorded ${identity.host} as ${identity.displayName}'s own website for this vacancy.${entityRef ? ` Entity reference: ${entityRef}.` : ''}`,
  };
}

/** Floor first, then (only if it can pass) one safe fetch; writes go through the store's guarded apply. */
async function checkAndConfirm(
  deps: CompanyEvidenceDeps,
  ctx: ResolvedContext,
  factId: string,
  sourceUrl: string,
  claim: string,
  quote: string,
  signal: AbortSignal | undefined,
): Promise<{ notice: string; requests: number }> {
  const floor = assessQuoteSupport(claim, quote, employerNames(ctx));
  if (!floor.ok) {
    store.recordRefreshAttempt(deps.db, factId, 'failed', floor.reason, deps.now());
    return { notice: `Saved as a lead. ${LEAD_REASON_TEXT[floor.reason]}`, requests: 0 };
  }
  if (!deps.getHttp) return { notice: 'Saved as a lead. Checking sources is not available right now.', requests: 0 };
  const check = await confirmSourceQuote(await deps.getHttp(), sourceUrl, quote, {
    ...(signal ? { signal } : {}),
    now: deps.now,
  });
  if (!check.ok) {
    store.recordRefreshAttempt(deps.db, factId, 'failed', check.reason, deps.now());
    return { notice: `Saved as a lead. ${SOURCE_FAILURE_TEXT[check.reason]}`, requests: 1 };
  }
  const applied = store.confirmFactFromFetch(
    deps.db,
    factId,
    { retrievedAt: check.checkedAt, contentHash: check.contentHash, claim, quote, employerNames: employerNames(ctx) },
    deps.now(),
  );
  return {
    notice:
      applied === 'applied'
        ? 'Quoted passage found on the page, and the claim is worded from it. It can be used.'
        : 'Saved as a lead. The claim changed while its source was being checked, so nothing was confirmed.',
    requests: 1,
  };
}

export async function addFact(
  deps: CompanyEvidenceDeps,
  target: EvidenceTarget,
  input: AddFactInput,
  signal?: AbortSignal,
): Promise<CompanyEvidenceResult> {
  const ctx = resolveContext(deps, target);
  const blocked = requireVerified(ctx);
  if (blocked) return blocked;
  const claim = sanitizeClaim(input.claim);
  if (claim.length < 8) return fail('claim_too_short', 'Write the claim as one clear sentence.');
  const sourceUrl = input.sourceUrl.trim();
  if (!isHttpsSource(sourceUrl)) return fail('source_not_https', 'Use the secure (https) web address of a public page.');
  if (input.scope === 'role' && ctx.roleKey === null) return fail('no_role', 'This claim needs a specific role to belong to.');
  const quote = sanitizeLabel(input.quote, MAX_QUOTE_CHARS);
  // The topic follows what the claim and its quote say: sponsorship wording is sponsorship.
  const topic = effectiveTopic(COMPANY_EVIDENCE_TOPICS.includes(input.topic) ? input.topic : 'general', claim, quote);
  const now = deps.now();
  const observed = input.observedAt && !Number.isNaN(Date.parse(input.observedAt)) ? new Date(input.observedAt) : now;
  const observedAt = observed.getTime() > now.getTime() ? now : observed;

  const { record, created } = store.ensureRecord(deps.db, ctx.identity, now, ctx.entityRef);
  const inserted = store.insertFact(
    deps.db,
    {
      recordId: record.id,
      scope: input.scope,
      roleKey: ctx.roleKey ?? '',
      roleLabel: ctx.roleLabel,
      topic,
      claim,
      sourceUrl,
      sourceKind: inferSourceKind(sourceUrl, ctx.identity, input.sourceKind),
      quote,
      verification: 'unverified',
      origin: 'user',
      retrievedAt: null,
      observedAt,
      contentHash: null,
    },
    now,
  );
  if (!inserted) return fail('record_gone', 'This company record no longer exists.');
  if ('refused' in inserted) {
    if (created) store.pruneEmptyRecord(deps.db, record.id);
    return RECORD_FULL();
  }

  let notice = 'Saved as a lead. Add a passage copied from the page, or confirm you read the source yourself.';
  let requests = 0;
  if (quote.length >= MIN_QUOTE_CHARS) {
    ({ notice, requests } = await checkAndConfirm(deps, ctx, inserted.id, sourceUrl, claim, quote, signal));
  }
  return { ok: true, view: getView(deps, target), notice, stats: stats({ requests }) };
}

function factInContext(deps: CompanyEvidenceDeps, ctx: ResolvedContext, factId: string) {
  const fact = ctx.recordId ? store.listFactsForRecord(deps.db, ctx.recordId).find((row) => row.id === factId) : undefined;
  return fact && fact.viaLink === null ? fact : undefined;
}

export function confirmFact(deps: CompanyEvidenceDeps, target: EvidenceTarget, factId: string): CompanyEvidenceResult {
  const ctx = resolveContext(deps, target);
  const blocked = requireVerified(ctx);
  if (blocked) return blocked;
  const fact = factInContext(deps, ctx, factId);
  if (!fact || fact.status !== 'active') return fail('fact_not_found', 'That claim is no longer on this company.');
  if (!isHttpsSource(fact.sourceUrl)) return fail('source_not_https', 'The source is not a secure public web address.');
  if (fact.sourceKind === 'ind_register') {
    return fail('ind_name_match_only', 'A register name match cannot be confirmed as this employer or as sponsorship for this role.');
  }
  store.confirmFactByUser(deps.db, factId, deps.now());
  return { ok: true, view: getView(deps, target), notice: 'Recorded that you read the source and it says this.' };
}

/**
 * A person's correction. The corrected wording is never carried by the OLD passage: the store
 * moves that passage into the correction record, and the claim is a lead until a NEW passage the
 * person supplies passes the floor and is found on the page (or they confirm they read it).
 */
export async function correctFact(
  deps: CompanyEvidenceDeps,
  target: EvidenceTarget,
  factId: string,
  claim: string,
  newQuote = '',
  signal?: AbortSignal,
): Promise<CompanyEvidenceResult> {
  const ctx = resolveContext(deps, target);
  const blocked = requireVerified(ctx);
  if (blocked) return blocked;
  const clean = sanitizeClaim(claim);
  if (clean.length < 8) return fail('claim_too_short', 'Write the claim as one clear sentence.');
  const quote = sanitizeLabel(newQuote, MAX_QUOTE_CHARS);
  if (quote !== '' && quote.length < MIN_QUOTE_CHARS) return fail('quote_too_short', SOURCE_FAILURE_TEXT.quote_too_short);
  const fact = factInContext(deps, ctx, factId);
  if (!fact || fact.status !== 'active') return fail('fact_not_found', 'That claim is no longer on this company.');
  store.correctFact(deps.db, factId, clean, deps.now(), quote);
  let notice = 'Claim corrected. The original wording and passage are kept, and it is a lead until a passage that says the new wording is checked.';
  let requests = 0;
  if (quote !== '') ({ notice, requests } = await checkAndConfirm(deps, ctx, factId, fact.sourceUrl, clean, quote, signal));
  return { ok: true, view: getView(deps, target), notice: quote === '' ? notice : `Claim corrected. ${notice}`, stats: stats({ requests }) };
}

export function withdrawFact(deps: CompanyEvidenceDeps, target: EvidenceTarget, factId: string): CompanyEvidenceResult {
  const ctx = resolveContext(deps, target);
  if (!factInContext(deps, ctx, factId)) return fail('fact_not_found', 'That claim is no longer on this company.');
  store.withdrawFact(deps.db, factId, deps.now());
  if (ctx.recordId) store.pruneEmptyRecord(deps.db, ctx.recordId);
  return { ok: true, view: getView(deps, target), notice: 'Claim removed. Letters already prepared are not changed.' };
}

export function resolveContradiction(
  deps: CompanyEvidenceDeps,
  target: EvidenceTarget,
  contradictionId: string,
  keepFactId: string,
): CompanyEvidenceResult {
  const ctx = resolveContext(deps, target);
  const open = ctx.recordId ? store.listOpenContradictions(deps.db, ctx.recordId) : [];
  if (!open.some((row) => row.id === contradictionId)) return fail('contradiction_not_found', 'That disagreement is already resolved.');
  if (!store.resolveContradiction(deps.db, contradictionId, keepFactId, deps.now())) {
    return fail('invalid_choice', 'Choose one of the two claims.');
  }
  return { ok: true, view: getView(deps, target), notice: 'Kept your choice. The other claim stays on record as replaced.' };
}

export function decideLink(
  deps: CompanyEvidenceDeps,
  target: EvidenceTarget,
  linkId: string,
  decision: 'confirmed' | 'rejected',
): CompanyEvidenceResult {
  const ctx = resolveContext(deps, target);
  const link = ctx.recordId ? store.listLinks(deps.db, ctx.recordId).find((row) => row.id === linkId) : undefined;
  if (!link) return fail('link_not_found', 'That suggestion no longer applies.');
  store.decideLink(deps.db, linkId, decision, deps.now());
  return {
    ok: true,
    view: getView(deps, target),
    notice:
      decision === 'confirmed'
        ? `Company-level claims from ${link.otherName} are now shared. Role claims never are. Where the two disagree, neither is used until you choose.`
        : 'Kept separate. Nothing is shared, and any choice that depended on the link was undone.',
  };
}

export function deleteRecordFor(deps: CompanyEvidenceDeps, target: EvidenceTarget, runs?: CompanyEvidenceRuns): CompanyEvidenceResult {
  const ctx = resolveContext(deps, target);
  if (!ctx.recordId) return fail('record_not_found', 'There is nothing saved for this company.');
  runs?.cancel(runKey(ctx));
  store.deleteRecord(deps.db, ctx.recordId);
  return {
    ok: true,
    view: getView(deps, target),
    notice: 'Company evidence deleted. Documents already prepared keep what they said.',
  };
}

/* ------------------------------------------------------------------------ refresh ------------ */

function currentlySupported(deps: CompanyEvidenceDeps, ctx: ResolvedContext, factId: string): boolean {
  if (!ctx.recordId) return false;
  const fact = store.listFactsForRecord(deps.db, ctx.recordId).find((row) => row.id === factId);
  return !!fact && classifyFact(fact, classificationContext(ctx), deps.now()).support === 'supported';
}

const checkable = (fact: { quote: string; sourceUrl: string }): boolean => fact.quote.length >= MIN_QUOTE_CHARS && isHttpsSource(fact.sourceUrl);

/**
 * Re-checks the stored sources of this company's non-current claims. A current, supported claim is a
 * CACHE HIT: no request, its original retrieval time stays. Only a source that still contains the
 * quoted passage -- for a claim that is worded from that passage -- renews a claim; a failure, a
 * timeout or a cancel leaves `retrievedAt`/`expiresAt` exactly as they were, a source that no longer
 * says it demotes the claim to a lead, and a claim that fails the quote floor (a corrected claim
 * whose old passage was set aside, a paraphrase) is not fetched at all. The whole pass shares one
 * `REFRESH_ENVELOPE_MS` deadline.
 */
export async function refreshEvidence(
  deps: CompanyEvidenceDeps,
  target: EvidenceTarget,
  runs: CompanyEvidenceRuns,
): Promise<CompanyEvidenceResult> {
  const ctx = resolveContext(deps, target);
  const blocked = requireVerified(ctx);
  if (blocked) return blocked;
  if (!ctx.recordId) return fail('record_not_found', 'There is nothing saved for this company yet.');
  if (!deps.getHttp) return fail('unavailable', 'Checking sources is not available right now.');
  const key = runKey(ctx);
  const controller = runs.begin(key);
  if (!controller) return fail('busy', 'This company is already being checked.');
  const result = stats();
  let notCheckable = 0;
  const envelope = AbortSignal.timeout(deps.deadlines?.refreshEnvelopeMs ?? REFRESH_ENVELOPE_MS);
  const signal = AbortSignal.any([controller.signal, envelope]);
  try {
    const own = store
      .listFactsForRecord(deps.db, ctx.recordId)
      .filter((fact) => fact.viaLink === null && fact.status === 'active')
      .filter((fact) => fact.scope === 'company' || fact.roleKey === ctx.roleKey);
    const http = await deps.getHttp();
    let checked = 0;
    for (const fact of own) {
      if (signal.aborted) break;
      if (currentlySupported(deps, ctx, fact.id)) {
        result.cacheHit = true;
        // Observed: this fact would otherwise have been fetched (it has a checkable passage).
        if (checkable(fact)) result.avoidedFetches += 1;
        continue;
      }
      if (checked >= MAX_REFRESH_FACTS) break;
      if (!checkable(fact)) {
        notCheckable += 1;
        continue;
      }
      if (fact.verification !== 'user_confirmed' && !assessQuoteSupport(fact.claim, fact.quote, employerNames(ctx)).ok) {
        notCheckable += 1;
        continue;
      }
      checked += 1;
      result.requests += 1;
      const check = await confirmSourceQuote(http, fact.sourceUrl, fact.quote, { signal, now: deps.now });
      if (check.ok) {
        const applied = store.renewFact(
          deps.db,
          fact.id,
          { retrievedAt: check.checkedAt, contentHash: check.contentHash, claim: fact.claim, quote: fact.quote, employerNames: employerNames(ctx) },
          deps.now(),
        );
        if (applied === 'applied') result.renewed += 1;
      } else if (check.reason === 'cancelled') {
        if (!controller.signal.aborted && envelope.aborted) {
          store.recordRefreshAttempt(deps.db, fact.id, 'failed', 'timeout', deps.now());
          result.failed += 1;
        }
        break;
      } else if (check.reason === 'quote_not_found') {
        store.recordRefreshAttempt(deps.db, fact.id, 'source_changed', check.reason, deps.now());
        result.demoted += 1;
      } else {
        store.recordRefreshAttempt(deps.db, fact.id, 'failed', check.reason, deps.now());
        result.failed += 1;
      }
    }
  } finally {
    runs.end(key, controller);
  }
  const extra = notCheckable > 0 ? ` ${notCheckable} need a passage that says their wording before they can be checked.` : '';
  const notice = controller.signal.aborted
    ? 'Stopped. Nothing was renewed and your drafts are unchanged.'
    : result.requests === 0
      ? result.cacheHit
        ? `Everything checkable is still current, so no source was fetched.${extra}`
        : `No saved claim has a passage to check.${extra}`
      : `Checked ${result.requests} source${result.requests === 1 ? '' : 's'}: ${result.renewed} renewed, ${result.demoted} no longer match, ${result.failed} could not be reached.${extra}${envelope.aborted ? ' The time limit was reached.' : ''}`;
  return viewResult(deps, target, notice, result);
}

/* ------------------------------------------------------------------------ research ------------ */

async function boundedMap<T, R>(items: readonly T[], limit: number, task: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next;
      next += 1;
      out[index] = await task(items[index]!);
    }
  });
  await Promise.all(workers);
  return out;
}

/**
 * The explicit, bounded, cancellable research action. When every requested topic already has
 * current supported COMPANY-scope evidence (a role fact never satisfies a company topic), no session
 * starts (a cache hit). Otherwise one `web-only` session runs; every researched claim is stored as an
 * unverified lead, and only a claim that passes the quote floor is checked against its page by the
 * app's own fetch (up to `SOURCE_CHECK_CONCURRENCY` at a time under one `RESEARCH_CONFIRM_PHASE_MS`
 * deadline).
 *
 * Failure, cancel, timeout and budget overruns store diagnostics (codes and counts) and leave
 * every existing fact, and every draft, exactly as it was.
 */
export async function researchCompany(
  deps: CompanyEvidenceDeps,
  target: EvidenceTarget,
  options: { topics?: readonly CompanyEvidenceTopic[]; includeRole?: boolean },
  runs: CompanyEvidenceRuns,
): Promise<CompanyEvidenceResult> {
  const ctx = resolveContext(deps, target);
  const blocked = requireVerified(ctx);
  if (blocked) return blocked;
  if (!deps.runResearch) return fail('unavailable', 'Web research is not available right now. You can still add sources yourself.');
  const topics = (options.topics?.length ? options.topics : DEFAULT_RESEARCH_TOPICS).filter((topic) => COMPANY_EVIDENCE_TOPICS.includes(topic));
  const now = deps.now();

  // Cache hit: only current, supported COMPANY-scope facts count for a company topic.
  if (ctx.recordId) {
    const supportedTopics = new Set(
      store
        .listFactsForRecord(deps.db, ctx.recordId)
        .map((fact) => classifyFact(fact, classificationContext(ctx), now))
        .filter((fact) => fact.support === 'supported' && fact.scope === 'company')
        .map((fact) => fact.topic),
    );
    if (topics.every((topic) => supportedTopics.has(topic))) {
      return {
        ok: true,
        view: getView(deps, target),
        notice: 'Already current. Showing what was saved, with its original check time.',
        stats: stats({ cacheHit: true, avoidedSessions: 1 }),
      };
    }
  }

  const key = runKey(ctx);
  const controller = runs.begin(key);
  if (!controller) return fail('busy', 'This company is already being researched.');
  const result = stats({ sessions: 1 });
  let createdRecordId: string | null = null;
  try {
    const { record, created } = store.ensureRecord(deps.db, ctx.identity, now, ctx.entityRef);
    if (created) createdRecordId = record.id;
    const tenant = ctx.identity.tenant;
    const input: CompanyResearchInput = {
      companyName: record.displayName,
      website: ctx.identity.host ?? '',
      jobBoard: tenant ? { provider: tenant.provider, board: tenant.board, postingUrl: publicPostingReference(ctx.canonicalUrl) } : null,
      roleTitle: options.includeRole === false ? '' : ctx.roleLabel,
      topics,
    };
    // A runner that throws is a failed run: stable code, nothing stored, no unhandled rejection.
    const outcome: ResearchSessionOutcome = await deps.runResearch(input, controller.signal).catch(
      (): ResearchSessionOutcome => ({ status: 'failed', reason: 'research_runner_failed', candidates: [], queries: [], searches: 0, fetches: 0 }),
    );

    let confirmedCount = 0;
    let candidateCount = 0;
    let finalStatus: CompanyResearchDiagnostics['status'] = outcome.status;
    let finalReason = outcome.reason;
    if (outcome.status === 'completed') {
      const http = deps.getHttp ? await deps.getHttp() : undefined;
      const names = employerNames(ctx);
      const usable = outcome.candidates
        .filter((candidate) => !(candidate.scope === 'role' && (options.includeRole === false || ctx.roleKey === null)))
        .map((candidate) => ({
          candidate: { ...candidate, topic: effectiveTopic(candidate.topic, candidate.claim, candidate.quote) },
          floor: assessQuoteSupport(candidate.claim, candidate.quote, names),
        }));
      const phase = AbortSignal.timeout(deps.deadlines?.confirmPhaseMs ?? RESEARCH_CONFIRM_PHASE_MS);
      const signal = AbortSignal.any([controller.signal, phase]);
      const checks = await boundedMap(usable, SOURCE_CHECK_CONCURRENCY, async (item): Promise<SourceCheck | null> => {
        // A claim the passage cannot support is never fetched for: it stays a lead with its reason.
        if (!http || !item.floor.ok) return null;
        // The shared deadline passed before this page was reached: recorded as a timeout, not fetched.
        if (signal.aborted) return controller.signal.aborted ? null : { ok: false, reason: 'timeout' };
        result.requests += 1;
        const check = await confirmSourceQuote(http, item.candidate.sourceUrl, item.candidate.quote, { signal, now: deps.now });
        return !check.ok && check.reason === 'cancelled' && !controller.signal.aborted ? { ok: false, reason: 'timeout' } : check;
      });
      if (controller.signal.aborted) {
        // Cancelled while confirming: store nothing from this run.
        finalStatus = 'cancelled';
        finalReason = 'cancelled_by_user';
      } else {
        for (let index = 0; index < usable.length; index += 1) {
          const { candidate, floor } = usable[index]!;
          const confirm = checks[index] ?? null;
          const inserted = store.insertFact(
            deps.db,
            {
              recordId: record.id,
              scope: candidate.scope,
              roleKey: ctx.roleKey ?? '',
              roleLabel: ctx.roleLabel,
              topic: candidate.topic,
              claim: candidate.claim,
              sourceUrl: candidate.sourceUrl,
              sourceKind: inferSourceKind(candidate.sourceUrl, ctx.identity),
              quote: candidate.quote,
              verification: 'unverified',
              origin: 'research',
              retrievedAt: null,
              observedAt: deps.now(),
              contentHash: null,
              refreshReason: floor.ok ? null : floor.reason,
            },
            deps.now(),
          );
          if (!inserted) {
            finalStatus = 'cancelled';
            finalReason = 'record_removed';
            break;
          }
          if ('refused' in inserted) {
            finalReason = 'record_full';
            break;
          }
          candidateCount += 1;
          if (confirm?.ok) {
            const applied = store.confirmFactFromFetch(
              deps.db,
              inserted.id,
              { retrievedAt: confirm.checkedAt, contentHash: confirm.contentHash, claim: candidate.claim, quote: candidate.quote, employerNames: names },
              deps.now(),
            );
            if (applied === 'applied') confirmedCount += 1;
          } else if (confirm && !confirm.ok) {
            store.recordRefreshAttempt(deps.db, inserted.id, 'failed', confirm.reason, deps.now());
          }
        }
      }
    }
    result.candidates = candidateCount;
    result.confirmed = confirmedCount;
    const diagnostics: CompanyResearchDiagnostics = {
      at: deps.now().toISOString(),
      status: finalStatus,
      reason: finalReason,
      queries: outcome.queries,
      searches: outcome.searches,
      fetches: outcome.fetches + result.requests,
      candidates: candidateCount,
      confirmed: confirmedCount,
    };
    // A cancelled run leaves the previous diagnostics alone: it changed nothing.
    if (finalStatus !== 'cancelled') store.recordResearchDiagnostics(deps.db, record.id, diagnostics, deps.now());
    deps.log?.('company evidence research finished', { status: finalStatus, reason: finalReason, candidates: candidateCount, confirmed: confirmedCount });
    if (createdRecordId) store.pruneEmptyRecord(deps.db, createdRecordId);
    const full = finalReason === 'record_full' ? ` This company reached the limit of ${store.MAX_FACTS_PER_RECORD} saved claims, so the rest were not added.` : '';
    const notice =
      finalStatus === 'completed'
        ? `Research finished: ${candidateCount} possible claim${candidateCount === 1 ? '' : 's'}, ${confirmedCount} with their quoted passage found on the page. The rest are leads.${full}`
        : finalStatus === 'cancelled'
          ? 'Stopped. Nothing was added and your drafts are unchanged.'
          : finalStatus === 'unavailable'
            ? 'Web research is not available (Claude Code must be installed and signed in). You can still add sources yourself.'
            : 'Research did not finish. Nothing was added and your drafts are unchanged.';
    return viewResult(deps, target, notice, result);
  } finally {
    runs.end(key, controller);
  }
}

/** A long action can outlive its target (a data reset removes the attempt): then there is nothing to show. */
function viewResult(deps: CompanyEvidenceDeps, target: EvidenceTarget, notice: string, result: ActionStats): CompanyEvidenceResult {
  try {
    return { ok: true, view: getView(deps, target), notice, stats: result };
  } catch (error) {
    if (error instanceof WorkspaceNotFoundError) return fail('not_found', 'That application is no longer in your list.');
    throw error;
  }
}

export function cancelResearch(deps: CompanyEvidenceDeps, target: EvidenceTarget, runs: CompanyEvidenceRuns): boolean {
  return runs.cancel(runKey(resolveContext(deps, target)));
}
