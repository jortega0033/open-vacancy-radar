import type {
  CvEvidenceOverlayState,
  CvRequirementCoverageStatus,
  CvRequirementMapping,
} from './workspace/cv-evidence-schema.js';

/**
 * The application brief (#688): one compact, persisted decision record per CANONICAL job, shared by
 * every source copy of it and carried from the shortlist (Saved jobs) into preparation.
 *
 * This module is the pure policy: no node, electron, database or network import, so main, the
 * renderer and the tests all reason about the same rules. It does three things:
 *
 *  1. names the versions a stored section was derived under and compares them with the current ones
 *     (`evaluate*`), producing a plain-English reason whenever a section is out of date;
 *  2. keeps the four things a person must not blur apart distinct: deterministic relevance (the
 *     engine's own score, never a new one), candidate readiness, submission evidence, and an
 *     explicit assessment that may simply not exist yet;
 *  3. composes everything into one `ApplicationBriefView` the IPC returns and the panel renders.
 *
 * Rules that hold everywhere below (and have tests):
 *  - A missing assessment is `missing`, never a zero or a low fit. An unknown eligibility answer is
 *    `uncertain`, never a mismatch. A mismatch exists only where a source said `no`.
 *  - No number in a brief is produced here. The only score is the engine's `profileScore`, shown with
 *    the scan it came from; there is no hiring probability anywhere.
 *  - Correcting a preference changes the preference. It marks the sections that depended on it out
 *    of date; it never edits an employer fact, an assessment or anything the person already sent.
 */

export const BRIEF_WORKFLOW_VERSION = 'application-brief-v1';

/** Single source of truth for the explicit "Assess selected jobs" action (shown to the person too). */
export const BATCH_LIMITS = {
  /** Most jobs one explicit action may assess. */
  maxJobs: 5,
  /** Jobs assessed at the same time. */
  concurrency: 1,
  /** Model requests per job: the first requirement pass plus at most one continuation. */
  passesPerJob: 2,
  /** One request is abandoned after this long (the same ceiling the Search assistant uses). */
  requestTimeoutMs: 240_000,
  /** The whole action stops starting new jobs after this long. */
  totalTimeoutMs: 900_000,
} as const;

/** The largest job description kept in a brief; longer text is cut and marked incomplete. */
export const BRIEF_JD_MAX_CHARS = 80_000;
/** How many invalidation notes a brief keeps. */
export const BRIEF_MAX_NOTICES = 10;
/** Cap on how many requirement rows each list in the brief shows. */
export const BRIEF_LIST_CAP = 5;

// -------------------------------------------------------------------------------- preferences

export type PreferenceGroupName = 'roles' | 'skills' | 'location' | 'languages' | 'relocation' | 'salary';

/** Stable, order-insensitive string per group of preferences that can change a relevance verdict. */
export type PreferenceGroups = Record<PreferenceGroupName, string>;

/** The slice of the candidate profile this module reads (structurally compatible with the engine's). */
export interface PreferenceProfile {
  location: string;
  experienceYears: number;
  strongestSkills: readonly string[];
  additionalSkills: readonly string[];
  targetRoles: readonly string[];
  consideredRoles: readonly string[];
  excludedRoleFamilies: readonly string[];
  constraints: {
    professionalLanguage: string;
    dutchRequired: boolean;
    primaryCountry: string;
    allowRemoteEuSupportingNetherlands: boolean;
    minimumMonthlyBaseEur: number;
    relocationWilling?: boolean | undefined;
  };
}

const GROUP_LABEL: Record<PreferenceGroupName, string> = {
  roles: 'your target roles',
  skills: 'your skills',
  location: 'your location or work country',
  languages: 'your working languages',
  relocation: 'your relocation preference',
  salary: 'your salary floor',
};

function sortedList(values: readonly string[]): string {
  return values
    .map((value) => value.trim().toLowerCase().replace(/\s+/gu, ' '))
    .filter((value) => value.length > 0)
    .sort()
    .join('|');
}

/**
 * The preferences that change a relevance or eligibility answer, grouped so a change can be
 * explained. Name, current role, field sources and `profileVersion` are deliberately absent: editing
 * them changes nothing the score read.
 */
export function preferenceGroups(profile: PreferenceProfile): PreferenceGroups {
  return {
    roles: [sortedList(profile.targetRoles), sortedList(profile.consideredRoles), sortedList(profile.excludedRoleFamilies)].join('#'),
    skills: [sortedList(profile.strongestSkills), sortedList(profile.additionalSkills), String(profile.experienceYears)].join('#'),
    location: [
      profile.location.trim().toLowerCase(),
      profile.constraints.primaryCountry.trim().toLowerCase(),
      String(profile.constraints.allowRemoteEuSupportingNetherlands),
      String(profile.constraints.dutchRequired),
    ].join('#'),
    languages: sortedList(profile.constraints.professionalLanguage.split(/[,/;&]|\band\b/iu)),
    relocation:
      profile.constraints.relocationWilling === undefined ? 'unanswered' : String(profile.constraints.relocationWilling),
    salary: String(profile.constraints.minimumMonthlyBaseEur),
  };
}

export function changedPreferenceGroups(
  before: PreferenceGroups | null,
  after: PreferenceGroups,
): PreferenceGroupName[] {
  if (before === null) return [];
  return (Object.keys(after) as PreferenceGroupName[]).filter((name) => before[name] !== after[name]);
}

function listGroups(groups: readonly PreferenceGroupName[]): string {
  const labels = groups.map((group) => GROUP_LABEL[group]);
  if (labels.length <= 1) return labels[0] ?? 'your preferences';
  return `${labels.slice(0, -1).join(', ')} and ${labels[labels.length - 1]}`;
}

// -------------------------------------------------------------------------------- eligibility

export type EligibilityKey =
  | 'candidateWorkCountry'
  | 'mandatoryLanguage'
  | 'visaSponsorship'
  | 'employerOfRecord'
  | 'candidateRelocationWillingness'
  | 'employerRelocationSupport';

export const ELIGIBILITY_KEYS: readonly EligibilityKey[] = [
  'candidateWorkCountry',
  'mandatoryLanguage',
  'visaSponsorship',
  'employerOfRecord',
  'candidateRelocationWillingness',
  'employerRelocationSupport',
];

export const ELIGIBILITY_LABEL: Record<EligibilityKey, string> = {
  candidateWorkCountry: 'Can you work for this job from where you are?',
  mandatoryLanguage: 'Do you meet the required languages?',
  visaSponsorship: 'Does the employer sponsor a work visa?',
  employerOfRecord: 'Will the employer hire through an Employer of Record?',
  candidateRelocationWillingness: 'Are you willing to relocate? (your preference)',
  employerRelocationSupport: 'Does the employer offer relocation support?',
};

/** Which preference groups an eligibility answer was derived from (empty = employer-side fact only). */
const ELIGIBILITY_PREFERENCE_GROUPS: Record<EligibilityKey, readonly PreferenceGroupName[]> = {
  candidateWorkCountry: ['location'],
  mandatoryLanguage: ['languages'],
  visaSponsorship: [],
  employerOfRecord: [],
  candidateRelocationWillingness: ['relocation'],
  employerRelocationSupport: [],
};

export interface BriefEligibilityAnswer {
  answer: 'yes' | 'no' | 'unknown';
  source: string;
  scope: string;
  observedAt: string | null;
  freshness: string;
  detail: string;
}

export type BriefEligibility = Partial<Record<EligibilityKey, BriefEligibilityAnswer>>;

/** The structural subset of the engine's `WorkEligibilityEvidence` a brief stores. */
export function pickEligibility(evidence: unknown): BriefEligibility | null {
  if (evidence === null || typeof evidence !== 'object') return null;
  const record = evidence as Record<string, unknown>;
  const picked: BriefEligibility = {};
  for (const key of ELIGIBILITY_KEYS) {
    const value = record[key];
    if (value === null || typeof value !== 'object') continue;
    const answer = (value as Record<string, unknown>).answer;
    if (answer !== 'yes' && answer !== 'no' && answer !== 'unknown') continue;
    const text = (field: string): string => {
      const raw = (value as Record<string, unknown>)[field];
      return typeof raw === 'string' ? raw : '';
    };
    const observedAt = (value as Record<string, unknown>).observedAt;
    picked[key] = {
      answer,
      source: text('source'),
      scope: text('scope'),
      observedAt: typeof observedAt === 'string' ? observedAt : null,
      freshness: text('freshness'),
      detail: text('detail').slice(0, 600),
    };
  }
  return Object.keys(picked).length > 0 ? picked : null;
}

export type EligibilityClass = 'consistent' | 'known_mismatch' | 'uncertain' | 'informational';

export interface EligibilityItem {
  key: EligibilityKey;
  label: string;
  answer: 'yes' | 'no' | 'unknown';
  /** consistent = the source says yes; known_mismatch = the source says no and it matters;
   * uncertain = nobody has said; informational = a stated "no" that only matters if you need it. */
  classification: EligibilityClass;
  summary: string;
  source: string;
  scope: string;
  observedAt: string | null;
  freshness: string;
  detail: string;
  /** True when the answer was derived from the person's own preferences (so it can be corrected). */
  fromPreferences: boolean;
}

const CLASS_SUMMARY: Record<EligibilityClass, string> = {
  consistent: 'Looks fine',
  known_mismatch: 'Known mismatch',
  uncertain: 'Not known',
  informational: 'Stated, only matters if you need it',
};

/**
 * `no` is a known mismatch only where it blocks the person: not being able to work from where they
 * are, a mandatory language they lack, or a refused visa when they cannot work from where they are.
 * Everything else that says `no` is a plain statement. `unknown` is never turned into either answer.
 */
export function classifyEligibility(evidence: BriefEligibility): EligibilityItem[] {
  const items: EligibilityItem[] = [];
  const cannotWorkFromHere = evidence.candidateWorkCountry?.answer === 'no';
  for (const key of ELIGIBILITY_KEYS) {
    const answer = evidence[key];
    if (!answer) continue;
    let classification: EligibilityClass;
    if (answer.answer === 'unknown') classification = 'uncertain';
    else if (answer.answer === 'yes') classification = 'consistent';
    else if (key === 'candidateWorkCountry' || key === 'mandatoryLanguage') classification = 'known_mismatch';
    else if (key === 'visaSponsorship' && cannotWorkFromHere) classification = 'known_mismatch';
    else classification = 'informational';
    items.push({
      key,
      label: ELIGIBILITY_LABEL[key],
      answer: answer.answer,
      classification,
      summary: CLASS_SUMMARY[classification],
      source: answer.source,
      scope: answer.scope,
      observedAt: answer.observedAt,
      freshness: answer.freshness,
      detail: answer.detail,
      fromPreferences: ELIGIBILITY_PREFERENCE_GROUPS[key].length > 0,
    });
  }
  return items;
}

// ---------------------------------------------------------------------------------- source facts

/** What the engine's scan said about this job. Employer-side data; preferences never rewrite it. */
export interface BriefSourceFacts {
  /** When this snapshot was taken from the scan (ISO). */
  capturedAt: string;
  runId: string | null;
  /** The scan's own timestamp (ISO). */
  generatedAt: string | null;
  profileScore: number | null;
  match: {
    technicalFit: number;
    roleFit: number;
    seniorityFit: number;
    primaryFit: string;
    matchingSkills: string[];
    gaps: string[];
    unmetMandatoryLanguages: string[];
  } | null;
  eligibility: BriefEligibility | null;
  salary: string | null;
  postedAt: string | null;
  applyUrlStatus: 'verified' | 'unresolved' | 'blocked' | null;
  /**
   * The preferences in force when the scan facts were taken, or null when the scan was made under a
   * profile version that no longer matched the saved one at capture (so what it read is unknown).
   */
  scoredPreferences: PreferenceGroups | null;
  /** True when `scoredPreferences` is null for that reason (rather than because nothing was scored). */
  scoredBeforeProfileSave: boolean;
}

export function emptyFacts(now: Date): BriefSourceFacts {
  return {
    capturedAt: now.toISOString(),
    runId: null,
    generatedAt: null,
    profileScore: null,
    match: null,
    eligibility: null,
    salary: null,
    postedAt: null,
    applyUrlStatus: null,
    scoredPreferences: null,
    scoredBeforeProfileSave: false,
  };
}

// ----------------------------------------------------------------------------------- assessment

export type EvidenceClassName = CvRequirementMapping['evidenceClass'];

export interface BriefRequirementItem {
  requirementId: string;
  text: string;
  /** Where in the posting this requirement was quoted from. */
  jdAnchor: string;
  classification: CvRequirementMapping['classification'];
  evidenceClass: EvidenceClassName;
  reviewed: boolean;
  /** The CV entry or fact the evidence points at, or null when none is linked. */
  evidenceLabel: string | null;
}

export interface AssessmentSummary {
  strengths: BriefRequirementItem[];
  gaps: BriefRequirementItem[];
  openQuestions: BriefRequirementItem[];
  counts: {
    requirements: number;
    direct: number;
    transferable: number;
    unsupported: number;
    needsVerification: number;
    confirmedGap: number;
    unreviewed: number;
  };
  coverage: CvRequirementCoverageStatus;
  overlayState: CvEvidenceOverlayState;
}

export interface OverlayLike {
  requirements: readonly CvRequirementMapping[];
  requirementCoverage: { status: CvRequirementCoverageStatus };
  state: CvEvidenceOverlayState;
}

/**
 * Turns a persisted requirement mapping into the three lists a decision needs. A strength must point
 * at something in the reviewed CV (an entry or a fact): a "direct" mapping that points at nothing is an
 * open question, not a strength. A material gap is a required (or unclear) requirement with no support
 * or one the person confirmed as a gap. `needs_verification` is neither: it is a question.
 */
export function summariseAssessment(
  overlay: OverlayLike,
  labelFor: (requirement: CvRequirementMapping) => string | null,
): AssessmentSummary {
  const strengths: BriefRequirementItem[] = [];
  const gaps: BriefRequirementItem[] = [];
  const openQuestions: BriefRequirementItem[] = [];
  const counts = {
    requirements: 0,
    direct: 0,
    transferable: 0,
    unsupported: 0,
    needsVerification: 0,
    confirmedGap: 0,
    unreviewed: 0,
  };
  for (const requirement of overlay.requirements) {
    if (requirement.excluded) continue;
    counts.requirements += 1;
    if (!requirement.reviewed) counts.unreviewed += 1;
    const item: BriefRequirementItem = {
      requirementId: requirement.requirementId,
      text: requirement.text,
      jdAnchor: requirement.jdAnchor,
      classification: requirement.classification,
      evidenceClass: requirement.evidenceClass,
      reviewed: requirement.reviewed,
      evidenceLabel: labelFor(requirement),
    };
    const linked =
      requirement.anchorParentId !== '' || requirement.sourceIds.length > 0 || requirement.factIds.length > 0;
    switch (requirement.evidenceClass) {
      case 'direct':
        counts.direct += 1;
        (linked ? strengths : openQuestions).push(item);
        break;
      case 'transferable':
        counts.transferable += 1;
        (linked ? strengths : openQuestions).push(item);
        break;
      case 'unsupported':
        counts.unsupported += 1;
        (requirement.classification === 'preferred' ? openQuestions : gaps).push(item);
        break;
      case 'candidate_confirmed_gap':
        counts.confirmedGap += 1;
        gaps.push(item);
        break;
      case 'needs_verification':
        counts.needsVerification += 1;
        openQuestions.push(item);
        break;
    }
  }
  const byPriority = (a: BriefRequirementItem, b: BriefRequirementItem): number =>
    Number(b.classification === 'required') - Number(a.classification === 'required');
  return {
    strengths: strengths.sort(byPriority).slice(0, BRIEF_LIST_CAP),
    gaps: gaps.sort(byPriority).slice(0, BRIEF_LIST_CAP),
    openQuestions: openQuestions.sort(byPriority).slice(0, BRIEF_LIST_CAP),
    counts,
    coverage: overlay.requirementCoverage.status,
    overlayState: overlay.state,
  };
}

/** The inputs an assessment summary was derived under. A change to either hash makes it stale. */
export interface AssessmentInputs {
  cvId: string;
  cvHash: string;
  jdHash: string;
  overlayId: string;
  derivedAt: string;
}

export interface StoredAssessment {
  summary: AssessmentSummary;
  inputs: AssessmentInputs;
}

/** How the overlay found for this job compares with the brief's current inputs. */
export type OverlayMatch = 'none' | 'matches' | 'jd_differs' | 'cv_differs' | 'both_differ';

export function matchOverlay(
  overlay: { jdSnapshotHash: string; sourceCvContentHash: string } | null,
  current: { jdHash: string | null; cvHash: string | null },
): OverlayMatch {
  if (overlay === null) return 'none';
  const jd = current.jdHash !== null && overlay.jdSnapshotHash === current.jdHash;
  const cv = current.cvHash !== null && overlay.sourceCvContentHash === current.cvHash;
  if (jd && cv) return 'matches';
  if (!jd && !cv) return 'both_differ';
  return jd ? 'cv_differs' : 'jd_differs';
}

export type AssessmentState = 'missing' | 'current' | 'partial' | 'stale' | 'unavailable';

export interface AssessmentSection {
  state: AssessmentState;
  /** Why it is stale, partial or unavailable; null when current or simply not run yet. */
  reason: string | null;
  /** Always present when there is something to show; for `stale` it is the EARLIER assessment. */
  summary: AssessmentSummary | null;
  derivedAt: string | null;
}

function dateLabel(iso: string | null): string {
  return iso === null ? 'an earlier date' : iso.slice(0, 10);
}

export function evaluateAssessment(input: {
  stored: StoredAssessment | null;
  fresh: AssessmentSummary | null;
  match: OverlayMatch;
  hasJd: boolean;
  jdChangedAt: string | null;
  cvAvailable: boolean;
  cvReviewed: boolean;
  cvChangedSinceAssessment: boolean;
  now: Date;
}): AssessmentSection {
  const { stored, fresh, match } = input;
  if (match === 'matches' && fresh !== null) {
    if (fresh.coverage !== 'complete') {
      return {
        state: 'partial',
        reason: 'Only part of the posting’s requirements have been read so far, so gaps may be missing.',
        summary: fresh,
        derivedAt: input.now.toISOString(),
      };
    }
    return { state: 'current', reason: null, summary: fresh, derivedAt: input.now.toISOString() };
  }
  // Something earlier exists (found now but out of date, or kept from before).
  const earlier = fresh ?? stored?.summary ?? null;
  if (match === 'jd_differs' || match === 'both_differ') {
    return {
      state: 'stale',
      reason: input.jdChangedAt
        ? `The job description changed on ${dateLabel(input.jdChangedAt)}, so the earlier assessment no longer describes this posting.`
        : 'The earlier assessment read a different job description than the one stored for this job.',
      summary: earlier,
      derivedAt: stored?.inputs.derivedAt ?? null,
    };
  }
  if (match === 'cv_differs') {
    return {
      state: 'stale',
      reason: 'Your reviewed CV changed after this assessment, so its strengths and gaps may no longer be right.',
      summary: earlier,
      derivedAt: stored?.inputs.derivedAt ?? null,
    };
  }
  if (stored !== null) {
    return {
      state: 'stale',
      reason: input.cvChangedSinceAssessment
        ? 'You are now using a different CV than the one this job was assessed against.'
        : 'The assessment this summary came from is no longer in your library.',
      summary: stored.summary,
      derivedAt: stored.inputs.derivedAt,
    };
  }
  if (!input.hasJd) {
    return {
      state: 'unavailable',
      reason: 'No job description was captured for this job, so it cannot be assessed against your CV.',
      summary: null,
      derivedAt: null,
    };
  }
  if (!input.cvAvailable) {
    return { state: 'unavailable', reason: 'Add a CV first to assess this job.', summary: null, derivedAt: null };
  }
  if (!input.cvReviewed) {
    return {
      state: 'unavailable',
      reason: 'Review your CV’s source details first so the assessment can point at real evidence.',
      summary: null,
      derivedAt: null,
    };
  }
  return { state: 'missing', reason: null, summary: null, derivedAt: null };
}

// --------------------------------------------------------------------------------- relevance

export type RelevanceStatus = 'current' | 'stale' | 'not_scored';

export interface RelevanceSection {
  status: RelevanceStatus;
  reason: string | null;
  score: number | null;
  /** Where the score came from, e.g. "Search scan 2026-10-29". Never implies a CV comparison. */
  provenance: string | null;
  fits: { technical: number; role: number; seniority: number } | null;
  signals: string[];
  caveats: string[];
  unmetMandatoryLanguages: string[];
}

export function evaluateRelevance(
  facts: BriefSourceFacts | null,
  currentPreferences: PreferenceGroups | null,
): RelevanceSection {
  if (facts === null || facts.profileScore === null) {
    return {
      status: 'not_scored',
      reason:
        facts === null
          ? 'No scan result is stored for this job yet.'
          : 'This job was not scored. Fill in what you are looking for in Settings, then search again.',
      score: null,
      provenance: facts?.generatedAt ? `Search scan ${facts.generatedAt.slice(0, 10)}` : null,
      fits: null,
      signals: [],
      caveats: [],
      unmetMandatoryLanguages: [],
    };
  }
  let status: RelevanceStatus = 'current';
  let reason: string | null = null;
  if (facts.scoredBeforeProfileSave) {
    status = 'stale';
    reason =
      'You saved your search profile after this scan, so the score may not reflect it. Search again to refresh it.';
  } else if (currentPreferences !== null) {
    const changed = changedPreferenceGroups(facts.scoredPreferences, currentPreferences);
    if (changed.length > 0) {
      status = 'stale';
      reason = `You changed ${listGroups(changed)} after this score was calculated. Search again to refresh it.`;
    }
  }
  return {
    status,
    reason,
    score: facts.profileScore,
    provenance: facts.generatedAt ? `Search scan ${facts.generatedAt.slice(0, 10)}` : 'Search scan',
    fits: facts.match
      ? { technical: facts.match.technicalFit, role: facts.match.roleFit, seniority: facts.match.seniorityFit }
      : null,
    signals: (facts.match?.matchingSkills ?? []).slice(0, BRIEF_LIST_CAP),
    caveats: (facts.match?.gaps ?? []).slice(0, BRIEF_LIST_CAP),
    unmetMandatoryLanguages: facts.match?.unmetMandatoryLanguages ?? [],
  };
}

export interface EligibilitySection {
  /** Whether the stored answers describe the person as they are now. */
  status: 'current' | 'stale' | 'not_assessed';
  reason: string | null;
  items: EligibilityItem[];
  /** Counts so a glance tells the three states apart. */
  counts: { knownMismatch: number; uncertain: number; consistent: number; informational: number };
  /** Preference groups an uncertain answer depends on, so the person can correct them. */
  correctable: PreferenceGroupName[];
}

export function evaluateEligibility(
  facts: BriefSourceFacts | null,
  currentPreferences: PreferenceGroups | null,
): EligibilitySection {
  const counts = { knownMismatch: 0, uncertain: 0, consistent: 0, informational: 0 };
  if (facts === null || facts.eligibility === null) {
    return {
      status: 'not_assessed',
      reason: 'No work-eligibility answers are stored for this job.',
      items: [],
      counts,
      correctable: [],
    };
  }
  const items = classifyEligibility(facts.eligibility);
  for (const item of items) {
    if (item.classification === 'known_mismatch') counts.knownMismatch += 1;
    else counts[item.classification] += 1;
  }
  let status: EligibilitySection['status'] = 'current';
  let reason: string | null = null;
  const dependent = new Set<PreferenceGroupName>();
  for (const item of items) {
    if (item.fromPreferences) for (const group of ELIGIBILITY_PREFERENCE_GROUPS[item.key]) dependent.add(group);
  }
  if (facts.scoredBeforeProfileSave) {
    status = 'stale';
    reason = 'You saved your search profile after this scan, so the answers about you may not reflect it.';
  } else if (currentPreferences !== null) {
    const changed = changedPreferenceGroups(facts.scoredPreferences, currentPreferences).filter((group) =>
      dependent.has(group),
    );
    if (changed.length > 0) {
      status = 'stale';
      reason = `You changed ${listGroups(changed)} after these answers were worked out. The employer’s own statements below are unchanged.`;
    }
  }
  const correctable = items
    .filter((item) => item.fromPreferences && item.classification === 'uncertain')
    .flatMap((item) => ELIGIBILITY_PREFERENCE_GROUPS[item.key]);
  return { status, reason, items, counts, correctable: [...new Set(correctable)] };
}

// ----------------------------------------------------------------------------- other sections

export interface BriefReadiness {
  cv: 'ready' | 'cv_not_reviewed' | 'no_cv';
  cvName: string | null;
  assessment: AssessmentState;
  unreviewedRequirements: number;
  overlayState: CvEvidenceOverlayState | null;
  /** Plain statements about the person's own preparation; never about how good the job is. */
  notes: string[];
}

export function evaluateReadiness(input: {
  cvName: string | null;
  cvReviewed: boolean;
  assessment: AssessmentSection;
}): BriefReadiness {
  const cv: BriefReadiness['cv'] = input.cvName === null ? 'no_cv' : input.cvReviewed ? 'ready' : 'cv_not_reviewed';
  const notes: string[] = [];
  if (cv === 'no_cv') notes.push('Add a CV before preparing an application.');
  if (cv === 'cv_not_reviewed') notes.push('Review your CV’s source details so a tailored CV can use real evidence.');
  const summary = input.assessment.summary;
  if (input.assessment.state === 'current' || input.assessment.state === 'partial') {
    if (summary && summary.counts.unreviewed > 0) {
      notes.push(`${summary.counts.unreviewed} requirement${summary.counts.unreviewed === 1 ? '' : 's'} still need your review.`);
    }
  }
  return {
    cv,
    cvName: input.cvName,
    assessment: input.assessment.state,
    unreviewedRequirements: summary?.counts.unreviewed ?? 0,
    overlayState: summary?.overlayState ?? null,
    notes,
  };
}

export interface BriefAttemptEvidence {
  attemptId: string;
  checkpoint: string;
  /** Plain wording that follows the evidence (a sent application is only "sent" when observed). */
  label: string;
  createdAt: string;
  submittedAt: string | null;
  receipts: number;
}

export type BriefPostingStatus =
  | 'not_checked'
  | 'confirmed_open'
  | 'confirmed_closed'
  | 'materially_changed'
  | 'unable_to_verify'
  | 'not_applicable';

export interface BriefPostingSection {
  status: BriefPostingStatus;
  checkedAt: string | null;
  source: string | null;
  sourceRef: string | null;
  deadline: { date: string; excerpt: string } | null;
  noDeadlineStated: boolean;
  stale: boolean;
  note: string;
}

export interface BriefCompanyFactSummary {
  claim: string;
  sourceUrl: string;
  scope: 'company' | 'role';
  retrievedAt: string | null;
  expiresAt: string;
  state: 'current' | 'expired' | 'lead';
}

export interface BriefCompanySection {
  available: boolean;
  note: string;
  facts: BriefCompanyFactSummary[];
  counts: { current: number; expired: number; leads: number };
}

export interface BriefSourceRef {
  aliasKey: string;
  kind: string;
  label: string;
  provider: string | null;
  url: string | null;
  firstSeenAt: string;
  lastSeenAt: string;
}

export interface BriefNotice {
  at: string;
  section: 'relevance' | 'eligibility' | 'assessment' | 'posting' | 'preferences';
  text: string;
}

export interface BriefPin {
  attemptId: string;
  pinnedAt: string;
  /** The brief exactly as it read when preparation started. Never updated. */
  snapshot: FrozenBrief;
}

/** The part of a view kept in a pin: enough to answer "what did I know when I started preparing". */
export interface FrozenBrief {
  workflowVersion: string;
  role: string;
  company: string;
  relevance: Pick<RelevanceSection, 'status' | 'score' | 'provenance'>;
  eligibility: { knownMismatch: string[]; uncertain: string[] };
  assessment: { state: AssessmentState; strengths: string[]; gaps: string[]; openQuestions: string[] };
  posting: { status: BriefPostingStatus; checkedAt: string | null; deadline: string | null };
  sources: { label: string; url: string | null }[];
}

export interface ApplicationBriefView {
  briefId: string;
  workflowVersion: string;
  generatedAt: string;
  identity: { kind: string; key: string };
  role: string;
  company: string;
  location: string;
  /** Every original source reference this brief covers. */
  sources: BriefSourceRef[];
  posting: { hasText: boolean; complete: boolean; changedAt: string | null; capturedAt: string | null };
  relevance: RelevanceSection;
  eligibility: EligibilitySection;
  assessment: AssessmentSection;
  readiness: BriefReadiness;
  postingCheck: BriefPostingSection;
  companyEvidence: BriefCompanySection;
  /** Submission evidence: what this app actually observed. Separate from everything above. */
  submission: { attempts: BriefAttemptEvidence[] };
  notices: BriefNotice[];
  pin: BriefPin | null;
  /** What the person can do from here. Nothing starts without a click. */
  actions: { canAssess: boolean; assessBlockedReason: string | null };
}

/** Everything the service assembles from the store and the live services. */
export interface BriefInputs {
  now: Date;
  briefId: string;
  identity: { kind: string; key: string };
  role: string;
  company: string;
  location: string;
  facts: BriefSourceFacts | null;
  jd: { hasText: boolean; hash: string | null; complete: boolean; changedAt: string | null; capturedAt: string | null };
  currentPreferences: PreferenceGroups | null;
  assessment: AssessmentSection;
  cv: { name: string | null; reviewed: boolean };
  sources: BriefSourceRef[];
  attempts: BriefAttemptEvidence[];
  postingCheck: BriefPostingSection;
  companyEvidence: BriefCompanySection;
  notices: BriefNotice[];
  pin: BriefPin | null;
}

export function composeBriefView(input: BriefInputs): ApplicationBriefView {
  const relevance = evaluateRelevance(input.facts, input.currentPreferences);
  const eligibility = evaluateEligibility(input.facts, input.currentPreferences);
  const readiness = evaluateReadiness({
    cvName: input.cv.name,
    cvReviewed: input.cv.reviewed,
    assessment: input.assessment,
  });
  const blocked =
    input.assessment.state === 'unavailable'
      ? input.assessment.reason
      : input.assessment.state === 'current'
        ? 'This job already has an up-to-date assessment.'
        : null;
  return {
    briefId: input.briefId,
    workflowVersion: BRIEF_WORKFLOW_VERSION,
    generatedAt: input.now.toISOString(),
    identity: input.identity,
    role: input.role,
    company: input.company,
    location: input.location,
    sources: input.sources,
    posting: {
      hasText: input.jd.hasText,
      complete: input.jd.complete,
      changedAt: input.jd.changedAt,
      capturedAt: input.jd.capturedAt,
    },
    relevance,
    eligibility,
    assessment: input.assessment,
    readiness,
    postingCheck: input.postingCheck,
    companyEvidence: input.companyEvidence,
    submission: { attempts: input.attempts },
    notices: input.notices,
    pin: input.pin,
    actions: { canAssess: blocked === null, assessBlockedReason: blocked },
  };
}

export function freezeBrief(view: ApplicationBriefView): FrozenBrief {
  return {
    workflowVersion: view.workflowVersion,
    role: view.role,
    company: view.company,
    relevance: { status: view.relevance.status, score: view.relevance.score, provenance: view.relevance.provenance },
    eligibility: {
      knownMismatch: view.eligibility.items.filter((i) => i.classification === 'known_mismatch').map((i) => i.label),
      uncertain: view.eligibility.items.filter((i) => i.classification === 'uncertain').map((i) => i.label),
    },
    assessment: {
      state: view.assessment.state,
      strengths: (view.assessment.summary?.strengths ?? []).map((item) => item.text),
      gaps: (view.assessment.summary?.gaps ?? []).map((item) => item.text),
      openQuestions: (view.assessment.summary?.openQuestions ?? []).map((item) => item.text),
    },
    posting: {
      status: view.postingCheck.status,
      checkedAt: view.postingCheck.checkedAt,
      deadline: view.postingCheck.deadline?.date ?? null,
    },
    sources: view.sources.map((source) => ({ label: source.label, url: source.url })),
  };
}

/** One honest summary line for a finished or interrupted "Assess selected jobs" action. */
export interface BatchTally {
  total: number;
  assessed: number;
  unassessed: number;
  failed: number;
  cancelled: number;
  discarded: number;
}

export function describeBatchOutcome(tally: BatchTally, cancelled: boolean): string {
  const parts: string[] = [`${tally.assessed} of ${tally.total} assessed`];
  if (tally.failed > 0) parts.push(`${tally.failed} failed`);
  if (tally.unassessed > 0) parts.push(`${tally.unassessed} could not be assessed`);
  if (tally.discarded > 0) parts.push(`${tally.discarded} result${tally.discarded === 1 ? '' : 's'} discarded because the inputs changed`);
  if (tally.cancelled > 0) parts.push(`${tally.cancelled} not started`);
  const complete = tally.assessed === tally.total;
  return `${complete ? 'Finished' : cancelled ? 'Stopped' : 'Finished with gaps'}: ${parts.join(', ')}.`;
}

// ------------------------------------------------------------------- bridge contract

export interface PreferenceCorrection {
  relocationWilling?: boolean;
  primaryCountry?: string;
  professionalLanguage?: string;
}

export interface AssessmentFence {
  briefId: string;
  factsVersion: number;
  jdHash: string;
  cvId: string;
  cvHash: string;
  overlayId: string | null;
  overlayCaseRevision: string | null;
}

export interface AssessmentPlan {
  savedJobId: string;
  briefId: string;
  cvId: string;
  lead: { key: string; title: string; company: string; location: string; url: string; description: string };
  fence: AssessmentFence;
  /** The requirements already saved for this posting, so a new pass continues rather than repeats. */
  existing: CvRequirementMapping[];
}

export type AssessmentRefusalCode =
  | 'not_found'
  | 'no_cv'
  | 'cv_not_reviewed'
  | 'no_posting_text'
  | 'already_current'
  | 'jd_differs';

export type PrepareAssessmentResult =
  | { ok: true; plan: AssessmentPlan }
  | { ok: false; code: AssessmentRefusalCode; message: string };

export interface CommitAssessmentInput {
  savedJobId: string;
  fence: AssessmentFence;
  requirements: unknown;
  requirementCoverage: { status: 'partial' | 'complete'; batches: number };
}

export type CommitAssessmentResult =
  | { ok: true; view: ApplicationBriefView }
  | { ok: false; code: 'stale' | 'not_found' | 'invalid'; message: string };


export type BriefTargetInput = { savedJobId: string } | { attemptId: string };

export type BriefResult =
  | { ok: true; view: ApplicationBriefView }
  | { ok: false; code: 'not_found' | 'invalid_request' | 'failed'; message: string };

/** The `window.applicationBrief` capability (#688). Every call is local: none reaches a model or the network. */
export interface ApplicationBriefBridge {
  /** Reads (and, from a scan row or attempt, refreshes) the stored brief. Never starts anything. */
  get(target: BriefTargetInput): Promise<BriefResult>;
  /** Decides whether a saved job can be assessed and fixes the inputs a result must still match. */
  prepareAssessment(savedJobId: string): Promise<PrepareAssessmentResult>;
  /** Saves an assessment the page produced, refusing it if its inputs changed meanwhile. */
  commitAssessment(input: CommitAssessmentInput): Promise<CommitAssessmentResult>;
  /** Changes the person's own preference only; employer facts and attempts are never touched. */
  correctPreference(correction: PreferenceCorrection): Promise<{ ok: true } | { ok: false; message: string }>;
}
