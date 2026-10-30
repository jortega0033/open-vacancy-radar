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

/** A recorded requirement from "Compare with my CV" (an overlay). Text is the JD's wording; `evidenceClass` is the recorded mapping. */
export interface RequirementRecord {
  requirementId: string;
  text: string;
  classification: 'required' | 'preferred' | 'unclear';
  evidenceClass: 'direct' | 'transferable' | 'unsupported' | 'needs_verification' | 'candidate_confirmed_gap';
  reviewed: boolean;
  excluded: boolean;
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
  /** All the places this requisition was seen: the evidence that copies were collapsed. */
  copies: number;
  contributions: SourceContribution[];
  /** The person selected it (saved it or tracks an application). Date of the first selection; null when not recorded. */
  selectedAt: string | null;
  /** The evaluator's opinion of fit. Context only; never an input to a requirement, a gap or a suggestion. */
  score: ScoreOpinion;
  /** Applications rows for this requisition, newest-sent last. More than one = reapplication(s). */
  applications: ApplicationObservation[];
  assessment: { state: AssessmentState; requirements: RequirementRecord[]; coverage: 'complete' | 'partial' | 'not_run' };
  eligibility: EligibilityRecord[];
  versions: VersionStamp;
  /** Per field: where it came from. The adapter fills it; the fixtures for the projected lane declare it. */
  availability: Record<string, Availability>;
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
  /** More than this share of source rows being extra copies of an already-seen requisition = duplicates dominate. */
  maxCopyShare: 0.5,
  /** A requirement must recur in at least this many distinct assessed requisitions to be suggested. */
  minRecurrence: 3,
  /** At least this many requisitions must have a current, compatible, reviewed assessment before the requirement view is offered. */
  minAssessed: 8,
  /** More than this share of selected requisitions without a current assessment = unassessed dominate. */
  maxUnassessedShare: 0.5,
  /** More than this share of assessed requisitions outside the dominant version class = incompatible versions dominate. */
  maxIncompatibleShare: 0.34,
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
