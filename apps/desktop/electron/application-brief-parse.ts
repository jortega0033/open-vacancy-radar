import {
  ELIGIBILITY_KEYS,
  type ApplicationBriefView,
  type AssessmentSection,
  type AssessmentSummary,
  type AssessmentState,
  type BriefAttemptEvidence,
  type BriefCompanyFactSummary,
  type BriefCompanySection,
  type BriefNotice,
  type BriefPin,
  type BriefPostingSection,
  type BriefPostingStatus,
  type BriefReadiness,
  type BriefRequirementItem,
  type BriefResult,
  type BriefSourceRef,
  type CommitAssessmentResult,
  type EligibilityClass,
  type EligibilityItem,
  type EligibilityKey,
  type EligibilitySection,
  type FrozenBrief,
  type PrepareAssessmentResult,
  type PreferenceGroupName,
  type RelevanceSection,
  type AssessmentRefusalCode,
} from './application-brief.js';

/**
 * Fail-closed parsing of what crosses the preload boundary for `window.applicationBrief` (#688). The
 * renderer only ever sees objects REBUILT from known fields with known enum values: an unrecognised
 * status, a missing section or a malformed item collapses to a plain refusal (the whole view) or is
 * dropped (a list entry), never passed through. Pure on purpose: the sandboxed preload may not touch a
 * Node built-in.
 */

type Rec = Record<string, unknown>;

function rec(value: unknown): Rec | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Rec) : null;
}
const str = (source: Rec, key: string, max = 4000): string | null =>
  typeof source[key] === 'string' ? (source[key] as string).slice(0, max) : null;
const strOrNull = (source: Rec, key: string, max = 4000): string | null => str(source, key, max);
const num = (source: Rec, key: string): number | null =>
  typeof source[key] === 'number' && Number.isFinite(source[key]) ? (source[key] as number) : null;
const bool = (source: Rec, key: string): boolean | null => (typeof source[key] === 'boolean' ? (source[key] as boolean) : null);
function oneOf<T extends string>(value: unknown, allowed: readonly T[]): T | null {
  return typeof value === 'string' && (allowed as readonly string[]).includes(value) ? (value as T) : null;
}
function list<T>(value: unknown, max: number, parse: (item: unknown) => T | null): T[] {
  if (!Array.isArray(value)) return [];
  const out: T[] = [];
  for (const item of value.slice(0, max)) {
    const parsed = parse(item);
    if (parsed !== null) out.push(parsed);
  }
  return out;
}
const strings = (value: unknown, max: number): string[] =>
  list(value, max, (item) => (typeof item === 'string' ? item.slice(0, 600) : null));

const ASSESSMENT_STATES: readonly AssessmentState[] = ['missing', 'current', 'partial', 'stale', 'unavailable'];
const POSTING_STATUSES: readonly BriefPostingStatus[] = [
  'not_checked',
  'confirmed_open',
  'confirmed_closed',
  'materially_changed',
  'unable_to_verify',
  'not_applicable',
];
const ELIGIBILITY_CLASSES: readonly EligibilityClass[] = ['consistent', 'known_mismatch', 'uncertain', 'informational'];
const GROUPS: readonly PreferenceGroupName[] = ['roles', 'skills', 'location', 'languages', 'relocation', 'salary'];
const EVIDENCE_CLASSES = ['direct', 'transferable', 'unsupported', 'needs_verification', 'candidate_confirmed_gap'] as const;
const REQUIREMENT_CLASSES = ['required', 'preferred', 'unclear'] as const;
const OVERLAY_STATES = ['needs_input', 'conflict', 'draft', 'candidate_approved', 'qa_failed', 'artifact_approved'] as const;
const COVERAGE = ['not_run', 'partial', 'complete'] as const;
const NOTICE_SECTIONS = ['relevance', 'eligibility', 'assessment', 'posting', 'preferences'] as const;

function parseRequirementItem(value: unknown): BriefRequirementItem | null {
  const source = rec(value);
  if (!source) return null;
  const requirementId = str(source, 'requirementId', 200);
  const text = str(source, 'text', 2000);
  const evidenceClass = oneOf(source.evidenceClass, EVIDENCE_CLASSES);
  const classification = oneOf(source.classification, REQUIREMENT_CLASSES);
  if (requirementId === null || text === null || !evidenceClass || !classification) return null;
  return {
    requirementId,
    text,
    jdAnchor: str(source, 'jdAnchor', 600) ?? '',
    classification,
    evidenceClass,
    reviewed: source.reviewed === true,
    evidenceLabel: strOrNull(source, 'evidenceLabel', 300),
  };
}

function parseSummary(value: unknown): AssessmentSummary | null {
  const source = rec(value);
  if (!source) return null;
  const counts = rec(source.counts);
  const coverage = oneOf(source.coverage, COVERAGE);
  const overlayState = oneOf(source.overlayState, OVERLAY_STATES);
  if (!counts || !coverage || !overlayState) return null;
  const count = (key: string): number => num(counts, key) ?? 0;
  return {
    strengths: list(source.strengths, 10, parseRequirementItem),
    gaps: list(source.gaps, 10, parseRequirementItem),
    openQuestions: list(source.openQuestions, 10, parseRequirementItem),
    counts: {
      requirements: count('requirements'),
      direct: count('direct'),
      transferable: count('transferable'),
      unsupported: count('unsupported'),
      needsVerification: count('needsVerification'),
      confirmedGap: count('confirmedGap'),
      unreviewed: count('unreviewed'),
    },
    coverage,
    overlayState,
  };
}

function parseAssessment(value: unknown): AssessmentSection | null {
  const source = rec(value);
  const state = source ? oneOf(source.state, ASSESSMENT_STATES) : null;
  if (!source || !state) return null;
  return {
    state,
    reason: strOrNull(source, 'reason', 600),
    summary: parseSummary(source.summary),
    derivedAt: strOrNull(source, 'derivedAt', 40),
  };
}

function parseRelevance(value: unknown): RelevanceSection | null {
  const source = rec(value);
  const status = source ? oneOf(source.status, ['current', 'stale', 'not_scored'] as const) : null;
  if (!source || !status) return null;
  const fits = rec(source.fits);
  return {
    status,
    reason: strOrNull(source, 'reason', 600),
    score: num(source, 'score'),
    provenance: strOrNull(source, 'provenance', 200),
    fits: fits
      ? { technical: num(fits, 'technical') ?? 0, role: num(fits, 'role') ?? 0, seniority: num(fits, 'seniority') ?? 0 }
      : null,
    signals: strings(source.signals, 10),
    caveats: strings(source.caveats, 10),
    unmetMandatoryLanguages: strings(source.unmetMandatoryLanguages, 10),
  };
}

function parseEligibilityItem(value: unknown): EligibilityItem | null {
  const source = rec(value);
  if (!source) return null;
  const key = oneOf(source.key, ELIGIBILITY_KEYS as readonly EligibilityKey[]);
  const answer = oneOf(source.answer, ['yes', 'no', 'unknown'] as const);
  const classification = oneOf(source.classification, ELIGIBILITY_CLASSES);
  const label = str(source, 'label', 200);
  const summary = str(source, 'summary', 200);
  if (!key || !answer || !classification || label === null || summary === null) return null;
  return {
    key,
    label,
    answer,
    classification,
    summary,
    source: str(source, 'source', 80) ?? '',
    scope: str(source, 'scope', 80) ?? '',
    observedAt: strOrNull(source, 'observedAt', 40),
    freshness: str(source, 'freshness', 40) ?? '',
    detail: str(source, 'detail', 700) ?? '',
    fromPreferences: source.fromPreferences === true,
  };
}

function parseEligibility(value: unknown): EligibilitySection | null {
  const source = rec(value);
  const status = source ? oneOf(source.status, ['current', 'stale', 'not_assessed'] as const) : null;
  const counts = source ? rec(source.counts) : null;
  if (!source || !status || !counts) return null;
  const count = (key: string): number => num(counts, key) ?? 0;
  return {
    status,
    reason: strOrNull(source, 'reason', 600),
    items: list(source.items, 8, parseEligibilityItem),
    counts: {
      knownMismatch: count('knownMismatch'),
      uncertain: count('uncertain'),
      consistent: count('consistent'),
      informational: count('informational'),
    },
    correctable: list(source.correctable, 6, (item) => oneOf(item, GROUPS)),
  };
}

function parseReadiness(value: unknown): BriefReadiness | null {
  const source = rec(value);
  const cv = source ? oneOf(source.cv, ['ready', 'cv_not_reviewed', 'no_cv'] as const) : null;
  const assessment = source ? oneOf(source.assessment, ASSESSMENT_STATES) : null;
  if (!source || !cv || !assessment) return null;
  return {
    cv,
    cvName: strOrNull(source, 'cvName', 200),
    assessment,
    unreviewedRequirements: num(source, 'unreviewedRequirements') ?? 0,
    overlayState: oneOf(source.overlayState, OVERLAY_STATES),
    notes: strings(source.notes, 6),
  };
}

function parsePosting(value: unknown): BriefPostingSection | null {
  const source = rec(value);
  const status = source ? oneOf(source.status, POSTING_STATUSES) : null;
  if (!source || !status) return null;
  const deadline = rec(source.deadline);
  const date = deadline ? str(deadline, 'date', 40) : null;
  return {
    status,
    checkedAt: strOrNull(source, 'checkedAt', 40),
    source: strOrNull(source, 'source', 80),
    sourceRef: strOrNull(source, 'sourceRef', 600),
    deadline: deadline && date !== null ? { date, excerpt: str(deadline, 'excerpt', 600) ?? '' } : null,
    noDeadlineStated: source.noDeadlineStated === true,
    stale: source.stale !== false,
    note: str(source, 'note', 400) ?? '',
  };
}

function parseCompanyFact(value: unknown): BriefCompanyFactSummary | null {
  const source = rec(value);
  if (!source) return null;
  const claim = str(source, 'claim', 600);
  const sourceUrl = str(source, 'sourceUrl', 2048);
  const scope = oneOf(source.scope, ['company', 'role'] as const);
  const state = oneOf(source.state, ['current', 'expired', 'lead'] as const);
  const expiresAt = str(source, 'expiresAt', 40);
  if (claim === null || sourceUrl === null || !scope || !state || expiresAt === null) return null;
  return { claim, sourceUrl, scope, state, expiresAt, retrievedAt: strOrNull(source, 'retrievedAt', 40) };
}

function parseCompany(value: unknown): BriefCompanySection | null {
  const source = rec(value);
  const counts = source ? rec(source.counts) : null;
  if (!source || !counts) return null;
  return {
    available: source.available === true,
    note: str(source, 'note', 400) ?? '',
    facts: list(source.facts, 6, parseCompanyFact),
    counts: { current: num(counts, 'current') ?? 0, expired: num(counts, 'expired') ?? 0, leads: num(counts, 'leads') ?? 0 },
  };
}

function parseAttempt(value: unknown): BriefAttemptEvidence | null {
  const source = rec(value);
  if (!source) return null;
  const attemptId = str(source, 'attemptId', 200);
  const checkpoint = str(source, 'checkpoint', 60);
  const label = str(source, 'label', 200);
  const createdAt = str(source, 'createdAt', 40);
  if (attemptId === null || checkpoint === null || label === null || createdAt === null) return null;
  return { attemptId, checkpoint, label, createdAt, submittedAt: strOrNull(source, 'submittedAt', 40), receipts: num(source, 'receipts') ?? 0 };
}

function parseSource(value: unknown): BriefSourceRef | null {
  const source = rec(value);
  if (!source) return null;
  const aliasKey = str(source, 'aliasKey', 400);
  const kind = str(source, 'kind', 40);
  if (aliasKey === null || kind === null) return null;
  return {
    aliasKey,
    kind,
    label: str(source, 'label', 200) ?? '',
    provider: strOrNull(source, 'provider', 80),
    url: strOrNull(source, 'url', 2048),
    firstSeenAt: str(source, 'firstSeenAt', 40) ?? '',
    lastSeenAt: str(source, 'lastSeenAt', 40) ?? '',
  };
}

function parseNotice(value: unknown): BriefNotice | null {
  const source = rec(value);
  if (!source) return null;
  const at = str(source, 'at', 40);
  const section = oneOf(source.section, NOTICE_SECTIONS);
  const text = str(source, 'text', 600);
  return at !== null && section && text !== null ? { at, section, text } : null;
}

function parseFrozen(value: unknown): FrozenBrief | null {
  const source = rec(value);
  if (!source) return null;
  const relevance = rec(source.relevance);
  const eligibility = rec(source.eligibility);
  const assessment = rec(source.assessment);
  const posting = rec(source.posting);
  const assessmentState = assessment ? oneOf(assessment.state, ASSESSMENT_STATES) : null;
  const postingStatus = posting ? oneOf(posting.status, POSTING_STATUSES) : null;
  const relevanceStatus = relevance ? oneOf(relevance.status, ['current', 'stale', 'not_scored'] as const) : null;
  if (!relevance || !eligibility || !assessment || !posting || !assessmentState || !postingStatus || !relevanceStatus) return null;
  return {
    workflowVersion: str(source, 'workflowVersion', 80) ?? '',
    role: str(source, 'role', 300) ?? '',
    company: str(source, 'company', 300) ?? '',
    relevance: { status: relevanceStatus, score: num(relevance, 'score'), provenance: strOrNull(relevance, 'provenance', 200) },
    eligibility: { knownMismatch: strings(eligibility.knownMismatch, 8), uncertain: strings(eligibility.uncertain, 8) },
    assessment: {
      state: assessmentState,
      strengths: strings(assessment.strengths, 10),
      gaps: strings(assessment.gaps, 10),
      openQuestions: strings(assessment.openQuestions, 10),
    },
    posting: { status: postingStatus, checkedAt: strOrNull(posting, 'checkedAt', 40), deadline: strOrNull(posting, 'deadline', 40) },
    sources: list(source.sources, 20, (item) => {
      const entry = rec(item);
      const label = entry ? str(entry, 'label', 200) : null;
      return entry && label !== null ? { label, url: strOrNull(entry, 'url', 2048) } : null;
    }),
  };
}

function parsePin(value: unknown): BriefPin | null {
  const source = rec(value);
  if (!source) return null;
  const attemptId = str(source, 'attemptId', 200);
  const pinnedAt = str(source, 'pinnedAt', 40);
  const snapshot = parseFrozen(source.snapshot);
  return attemptId !== null && pinnedAt !== null && snapshot ? { attemptId, pinnedAt, snapshot } : null;
}

export function parseBriefView(value: unknown): ApplicationBriefView | null {
  const source = rec(value);
  if (!source) return null;
  const briefId = str(source, 'briefId', 200);
  const identity = rec(source.identity);
  const posting = rec(source.posting);
  const relevance = parseRelevance(source.relevance);
  const eligibility = parseEligibility(source.eligibility);
  const assessment = parseAssessment(source.assessment);
  const readiness = parseReadiness(source.readiness);
  const postingCheck = parsePosting(source.postingCheck);
  const companyEvidence = parseCompany(source.companyEvidence);
  const submission = rec(source.submission);
  const actions = rec(source.actions);
  if (
    briefId === null ||
    !identity ||
    !posting ||
    !relevance ||
    !eligibility ||
    !assessment ||
    !readiness ||
    !postingCheck ||
    !companyEvidence ||
    !submission ||
    !actions
  ) {
    return null;
  }
  return {
    briefId,
    workflowVersion: str(source, 'workflowVersion', 80) ?? '',
    generatedAt: str(source, 'generatedAt', 40) ?? '',
    identity: { kind: str(identity, 'kind', 40) ?? '', key: str(identity, 'key', 600) ?? '' },
    role: str(source, 'role', 300) ?? '',
    company: str(source, 'company', 300) ?? '',
    location: str(source, 'location', 300) ?? '',
    sources: list(source.sources, 20, parseSource),
    posting: {
      hasText: posting.hasText === true,
      complete: posting.complete !== false,
      changedAt: strOrNull(posting, 'changedAt', 40),
      capturedAt: strOrNull(posting, 'capturedAt', 40),
    },
    relevance,
    eligibility,
    assessment,
    readiness,
    postingCheck,
    companyEvidence,
    submission: { attempts: list(submission.attempts, 20, parseAttempt) },
    notices: list(source.notices, 10, parseNotice),
    pin: parsePin(source.pin),
    actions: {
      canAssess: bool(actions, 'canAssess') === true,
      assessBlockedReason: strOrNull(actions, 'assessBlockedReason', 400),
    },
  };
}

const FAILED = { ok: false, code: 'failed', message: 'Something went wrong. Nothing was changed.' } as const;

export function parseBriefResult(value: unknown): BriefResult {
  const source = rec(value);
  if (!source) return FAILED;
  if (source.ok === true) {
    const view = parseBriefView(source.view);
    return view ? { ok: true, view } : FAILED;
  }
  const code = oneOf(source.code, ['not_found', 'invalid_request', 'failed'] as const) ?? 'failed';
  return { ok: false, code, message: str(source, 'message', 400) ?? FAILED.message };
}

const REFUSALS: readonly AssessmentRefusalCode[] = [
  'not_found',
  'no_cv',
  'cv_not_reviewed',
  'no_posting_text',
  'already_current',
  'jd_differs',
];

export function parsePrepareAssessment(value: unknown): PrepareAssessmentResult {
  const source = rec(value);
  if (!source) return { ok: false, code: 'not_found', message: 'That saved job is no longer in your list.' };
  if (source.ok !== true) {
    return {
      ok: false,
      code: oneOf(source.code, REFUSALS) ?? 'not_found',
      message: str(source, 'message', 400) ?? 'This job cannot be assessed right now.',
    };
  }
  const plan = rec(source.plan);
  const lead = plan ? rec(plan.lead) : null;
  const fence = plan ? rec(plan.fence) : null;
  const fail = (): PrepareAssessmentResult => ({ ok: false, code: 'not_found', message: 'This job cannot be assessed right now.' });
  if (!plan || !lead || !fence) return fail();
  const savedJobId = str(plan, 'savedJobId', 200);
  const briefId = str(plan, 'briefId', 200);
  const cvId = str(plan, 'cvId', 200);
  const key = str(lead, 'key', 4096);
  const title = str(lead, 'title', 600);
  const company = str(lead, 'company', 600);
  const description = str(lead, 'description', 200_000);
  const fenceBrief = str(fence, 'briefId', 200);
  const jdHash = str(fence, 'jdHash', 100);
  const fenceCv = str(fence, 'cvId', 200);
  const cvHash = str(fence, 'cvHash', 100);
  const factsVersion = num(fence, 'factsVersion');
  if (
    savedJobId === null || briefId === null || cvId === null || key === null || title === null || company === null ||
    description === null || fenceBrief === null || jdHash === null || fenceCv === null || cvHash === null || factsVersion === null
  ) {
    return fail();
  }
  return {
    ok: true,
    plan: {
      savedJobId,
      briefId,
      cvId,
      lead: { key, title, company, location: str(lead, 'location', 600) ?? '', url: str(lead, 'url', 4096) ?? '', description },
      fence: {
        briefId: fenceBrief,
        factsVersion,
        jdHash,
        cvId: fenceCv,
        cvHash,
        overlayId: strOrNull(fence, 'overlayId', 200),
        overlayCaseRevision: strOrNull(fence, 'overlayCaseRevision', 100),
      },
      // The main process hands the stored list back; the page treats it as opaque and returns the merged list.
      existing: Array.isArray(plan.existing) ? (plan.existing as never[]) : [],
    },
  };
}

export function parseCommitAssessment(value: unknown): CommitAssessmentResult {
  const source = rec(value);
  if (source?.ok === true) {
    const view = parseBriefView(source.view);
    if (view) return { ok: true, view };
  }
  const code = source ? oneOf(source.code, ['stale', 'not_found', 'invalid'] as const) : null;
  return { ok: false, code: code ?? 'invalid', message: (source ? str(source, 'message', 400) : null) ?? 'Nothing was saved.' };
}

export function parseOkResult(value: unknown): { ok: true } | { ok: false; message: string } {
  const source = rec(value);
  if (source?.ok === true) return { ok: true };
  return { ok: false, message: (source ? str(source, 'message', 400) : null) ?? 'That change was not saved.' };
}
