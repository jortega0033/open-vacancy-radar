/**
 * #693 RESEARCH PROTOTYPE -- NOT PRODUCTION CODE. Nothing under `electron/` or `src/` imports this
 * directory (`non-production.test.ts` enforces that), it adds no table, event, IPC channel or UI, and it
 * is not a shipped feedback loop. It exists so the design in `docs/outcome-gap-research.md` can be
 * executed, tested and regenerated against the real current contracts.
 *
 * This file is the versioned data contract: the vocabulary, the semantics of missing data and the
 * author-declared review gates. A field in `Projected*` types DOES NOT EXIST in production today; it is
 * what follow-up issues A and B would have to record. Anything the real adapter can read today is typed
 * without the `Projected` prefix and carries an `availability` tag saying where it came from.
 */

import type { SubmissionClass } from '../../electron/application-actions-core.js';
import type { ApplicationStatus } from '../../electron/workspace/types.js';

/** Bumped on any change a stored or compared value could depend on. Major 0 = research, no compatibility promise. */
export const CONTRACT_VERSION = '0.1.0-research';
export const CONTRACT_MAJOR = 0;
/** The one assessment rule version the prototype understands (see `BRIEF_WORKFLOW_VERSION` in application-brief.ts). */
export const COMPATIBLE_ASSESSMENT_WORKFLOW = 'application-brief-v1';

/** Where a value came from. Never merged: a receipt is not a person's statement is not a derivation. */
export type EvidenceType =
  | 'receipt_observed' // this app observed the employer's confirmation
  | 'user_reported' // the person told the app they applied
  | 'user_stated' // the person set the status themselves
  | 'app_recorded' // a table row this app wrote (saved job, brief, attempt)
  | 'derived_at_read' // computed now from stored fields by a pure function; nothing was stored
  | 'not_recorded'; // nothing in the workspace says

/** Is the field recorded in the production workspace today, derived from it, or only projected by this design? */
export type Availability = 'recorded' | 'derived_at_read' | 'not_recorded' | 'projected_by_contract';

/** Canonical requisition key v1. See `requisition.ts`. */
export type KeyTier = 'requisition' | 'canonical_url' | 'semantic' | 'none';
export type KeyStrength = 'strong' | 'medium' | 'weak' | 'none';
export interface RequisitionKey {
  /** `rk1:req:<engine key>` | `rk1:url:<canonical url>` | `rk1:sem:<company :: title :: location>`; `none` when nothing identifies the job. */
  key: string;
  tier: KeyTier;
  strength: KeyStrength;
  /** `brief_identity` = read from `application_briefs.identity_key`; `derived_at_read` = computed from stored URL/text now. */
  origin: 'brief_identity' | 'derived_at_read' | 'none';
}

/** One query as recorded by #686 `LeadQueryProvenance` (copied by value, never a reference into the plan). */
export interface QueryRef {
  variantId: string;
  query: string;
  language: string | null;
  via: 'fetched_upstream' | 'matched_locally';
  field?: 'title' | 'description';
}

/** One source copy of a requisition. `queryRefs: 'not_recorded'` is the production reality for a saved job today. */
export interface SourceContribution {
  provider: string | null;
  url: string | null;
  queryRefs: QueryRef[] | 'not_recorded';
  /** #686 plan revision the queries belonged to; null when not recorded. */
  planRevision: number | null;
}

/** What the deterministic scorer said. An evaluator OPINION about fit: never a requirement, a gap or an outcome. */
export type ScoreState = 'scored' | 'unscored' | 'stale';
export interface ScoreOpinion {
  state: ScoreState;
  /** Null exactly when `state === 'unscored'`. Unscored is missing, never zero. */
  value: number | null;
  /** The scorer's `primaryFit` label; null when unscored. The prototype never derives a role family from a title. */
  roleFamily: string | null;
}

export const SENT_CLASSES: ReadonlySet<SubmissionClass> = new Set(['receipt_backed', 'user_reported', 'user_stated']);

/** The recorded outcome of one SENT application. `no_recorded_outcome` is NOT rejection, ineligibility or failed delivery. */
export type RecordedOutcome =
  | 'no_recorded_outcome'
  | 'reply_recorded' // recruiter_screen | interview
  | 'offer_recorded'
  | 'rejected_recorded' // the person set "rejected"; there is no source, reason or date for it
  | 'withdrawn_recorded';

export function outcomeOfStatus(status: ApplicationStatus | null): RecordedOutcome {
  switch (status) {
    case 'recruiter_screen':
    case 'interview':
      return 'reply_recorded';
    case 'offer':
      return 'offer_recorded';
    case 'rejected':
      return 'rejected_recorded';
    case 'withdrawn':
      return 'withdrawn_recorded';
    default:
      return 'no_recorded_outcome';
  }
}

/** Projected (follow-up A): a dated, sourced status change. Does NOT exist in production; `applications.status` is one mutable value. */
export interface ProjectedStatusEvent {
  status: ApplicationStatus;
  source: 'user_set' | 'app_observed';
  /** The date the person says it happened; null when they gave none. Never filled from the recording time. */
  occurredOn: string | null;
  recordedAt: string;
}

/** The versions an observation was made under. Every field may be null = unknown (never defaulted). */
export interface VersionStamp {
  contract: string;
  /** Engine/profile version of the scan that scored the job (`BriefSourceFacts` / report `profileVersion`). */
  profileVersion: string | null;
  /** Preference-group snapshot the score was made under; null when the scan predates the saved profile. */
  scoredPreferences: Record<string, string> | null;
  jdHash: string | null;
  cvHash: string | null;
  assessmentWorkflow: string | null;
  planRevision: number | null;
}

export type AssessmentState = 'none' | 'current' | 'partial' | 'stale' | 'unavailable';

export type RequirementClassification = 'required' | 'preferred' | 'unclear';
export type RequirementEvidenceClass = 'direct' | 'transferable' | 'unsupported' | 'needs_verification' | 'candidate_confirmed_gap';

/**
 * Who produced the evidence class, derived from what the overlay stores (it does not store WHO chose the final class):
 *  person_statement                `candidate_confirmed_gap`: only the person can set it; no extraction or proposal path accepts it.
 *  model_proposed_person_reviewed  direct / transferable / unsupported / needs_verification, proposed by the mapping model, and the person marked it reviewed
 *                                  (the record does not say whether the person changed the class).
 *  model_proposed_unreviewed       the same classes, not yet looked at.
 */
export type EvidenceOrigin = 'person_statement' | 'model_proposed_person_reviewed' | 'model_proposed_unreviewed';

export function evidenceOriginOf(requirement: Pick<RequirementRecord, 'evidenceClass' | 'reviewed'>): EvidenceOrigin {
  if (requirement.evidenceClass === 'candidate_confirmed_gap') return 'person_statement';
  return requirement.reviewed ? 'model_proposed_person_reviewed' : 'model_proposed_unreviewed';
}

/** A recorded requirement from "Compare with my CV" (an overlay). Text is the JD's wording; `evidenceClass` is the recorded mapping. */
export interface RequirementRecord {
  requirementId: string;
  text: string;
  /** `required` / `preferred` / `unclear` as the posting words it. A JD-side fact; never merged and never an input to the fit score. */
  classification: RequirementClassification;
  evidenceClass: RequirementEvidenceClass;
  reviewed: boolean;
  excluded: boolean;
  /** The verbatim quote from the JD this requirement was read from (`CvRequirementMapping.jdAnchor`), so a reviewer can find it in the posting. */
  jdAnchor: string;
  /** The JD revision the quote was verified against (`CvRequirementMapping.jdRevisionId`); '' when the overlay has none. */
  jdRevisionId: string;
  /** Half-open character span of `jdAnchor` inside that revision, or null when the overlay could not locate it (stored as -1). */
  quoteSpan: { start: number; end: number } | null;
  /** True when the PERSON added the requirement rather than the extraction finding it (`CvRequirementMapping.candidateAdded`). */
  candidateAdded: boolean;
}

/** A recorded eligibility answer (the brief's six questions); only these produce a preference/eligibility mismatch. */
export interface EligibilityRecord {
  key: string;
  answer: 'yes' | 'no' | 'unknown';
  classification: 'consistent' | 'known_mismatch' | 'uncertain' | 'informational';
  source: string;
}

export interface JobObservation {
  /** Stable id for the observation (fixture id in tests; never a database id in an output file). */
  id: string;
  requisition: RequisitionKey;
  /**
   * Saved-job rows (copies the person saved) merged into this requisition. One of TWO copy measures, kept apart:
   * the other is `contributions` (source copies the brief's aliases merged BEFORE the job was saved). A saved copy and
   * a contribution may be the same copy seen twice, so they are never added; `copiesSeenOf` takes the larger.
   */
  savedRows: number;
  contributions: SourceContribution[];
  /** The person selected it (saved it or tracks an application). Date of the first selection; null when not recorded. */
  selectedAt: string | null;
  /** The evaluator's opinion of fit. Context only; never an input to a requirement, a gap or a suggestion. */
  score: ScoreOpinion;
  /**
   * What the job is called, and what the scorer said about it. Both are stored by production (the saved job's role;
   * `BriefSourceFacts.match.matchingSkills` / `gaps`) and are read here for ONE reason: so a test can plant the word
   * "Kubernetes" in them and prove nothing is computed from them. They are NEVER an input to a requirement row, a lane,
   * a recurrence count, a gap or a suggestion. The scorer's `gaps` compare the job to the person's stated preferences
   * (seniority, language, salary, "no explicit skill match"); they are not skill gaps.
   */
  hints?: { title: string | null; scorerMatchingSkills: string[]; scorerGaps: string[] };
  /** Applications rows for this requisition, newest-sent last. More than one = reapplication(s). */
  applications: ApplicationObservation[];
  assessment: { state: AssessmentState; requirements: RequirementRecord[]; coverage: 'complete' | 'partial' | 'not_run' };
  eligibility: EligibilityRecord[];
  versions: VersionStamp;
  /** Per field: where it came from. The adapter fills it; the fixtures for the projected lane declare it. */
  availability: Record<string, Availability>;
}

/** The honest number of distinct copies of a requisition that were seen: the larger of the two overlapping measures (never their sum). */
export function copiesSeenOf(observation: Pick<JobObservation, 'savedRows' | 'contributions'>): number {
  return Math.max(1, observation.savedRows, observation.contributions.length);
}

export interface ApplicationObservation {
  applicationId: string;
  submission: SubmissionClass;
  evidence: EvidenceType;
  /** ISO. Null = sent but the date was not recorded (it then cannot be placed in a cohort). */
  sentAt: string | null;
  status: ApplicationStatus | null;
  /** Always `current_value_only` in production. `events` exists only in the projected lane. */
  statusHistory: 'current_value_only' | { events: ProjectedStatusEvent[] };
  /** Number of recorded interview rounds the person marked held; a reply signal that does not depend on `status`. */
  heldRounds: number;
  /** The application replaces an earlier one for the same requisition (reapplication). */
  reapplicationOf: string | null;
}

/** Author-declared review gates. NOT statistically derived and NOT validated against real data; they decide only whether a view is worth showing a person for review. */
export const GATES = {
  /** A cell with fewer distinct requisitions than this is labelled small-sample. */
  minRequisitionsPerCell: 5,
  /** Fewer distinct requisitions that were SENT AND mature than this and no outcome view is offered. */
  minMatureSent: 20,
  /** More than this share of mature sent applications with no recorded outcome = outcomes unknown dominate. */
  maxUnknownOutcomeShare: 0.5,
  /** More than this share of requisitions keyed only by the weak semantic tier (or not at all) = identity too weak. */
  maxWeakKeyShare: 0.25,
  /** More than this share of the copies seen (`copiesSeenOf`: the larger of saved rows and alias-merged source contributions) being extra copies of an already-seen requisition = duplicates dominate. */
  maxCopyShare: 0.5,
  /** A requirement must recur in at least this many distinct assessed requisitions to be suggested. */
  minRecurrence: 3,
  /** At least this many requisitions must have a current, compatible, reviewed assessment before the requirement view is offered. */
  minAssessed: 8,
  /** More than this share of selected requisitions without a current assessment = unassessed dominate. */
  maxUnassessedShare: 0.5,
  /** More than this share of assessed requisitions outside the dominant version class = incompatible versions dominate. */
  maxIncompatibleShare: 0.34,
  /** A search variant is only reviewed when at least this many distinct leads were shown for it (needs the projected exposure digest). */
  minExposed: 20,
  /** ... and the person selected no more than this share of what was shown for it. A fact about the person's own selection, not about hiring. */
  maxSelectedShareForVariantReview: 0.1,
  /** Days after sending before an application counts as "mature" for the no-recorded-outcome count. A view parameter with NO empirical basis. */
  defaultMaturityDays: 28,
} as const;

export type NoGoReason =
  | 'too_few_mature_sent'
  | 'unknown_outcomes_dominate'
  | 'weak_identity_dominates'
  | 'duplicate_copies_dominate'
  | 'no_exposure_denominator'
  | 'no_query_attribution'
  | 'no_status_timestamps'
  | 'too_few_assessed'
  | 'unassessed_dominate'
  | 'version_incompatible_dominates'
  | 'no_recurring_requirement'
  | 'nothing_to_compare';

export interface Verdict {
  verdict: 'go_review' | 'no_go';
  reasons: NoGoReason[];
}

/** Deep-clone helper for tests that must prove a pure function mutated nothing. */
export function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  }
  return value;
}
