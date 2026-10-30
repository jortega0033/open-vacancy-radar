import type { SubmissionClass } from '../../electron/application-actions-core.js';
import type { ApplicationStatus } from '../../electron/workspace/types.js';
import {
  CONTRACT_VERSION,
  COMPATIBLE_ASSESSMENT_WORKFLOW,
  type ApplicationObservation,
  type AssessmentState,
  type Availability,
  type EligibilityRecord,
  type EvidenceType,
  type JobObservation,
  type QueryRef,
  type RequirementRecord,
  type RequisitionKey,
  type ScoreOpinion,
  type SourceContribution,
} from './contract.js';

/**
 * Small builders for SYNTHETIC observations (no database). They exist so the pure functions can be tested
 * on exact, hand-countable inputs. Production-shaped inputs come from `real-world.ts` + `observations.ts`.
 * Anything built here with `queryRefs` as an array, or with `statusHistory.events`, is the PROJECTED lane:
 * data that follow-up issues A/B would have to record, not data production has today.
 */

export const key = (tier: RequisitionKey['tier'], value: string): RequisitionKey => ({
  key: tier === 'none' ? '' : `rk1:${tier === 'requisition' ? 'req' : tier === 'canonical_url' ? 'url' : 'sem'}:${value}`,
  tier,
  strength: tier === 'requisition' ? 'strong' : tier === 'canonical_url' ? 'medium' : tier === 'semantic' ? 'weak' : 'none',
  origin: tier === 'none' ? 'none' : 'brief_identity',
});

export const EVIDENCE_OF: Record<SubmissionClass, EvidenceType> = {
  receipt_backed: 'receipt_observed',
  user_reported: 'user_reported',
  user_stated: 'user_stated',
  unconfirmed: 'app_recorded',
  prepared: 'app_recorded',
  not_recorded: 'not_recorded',
};

export function app(
  id: string,
  submission: SubmissionClass,
  over: { sentAt?: string | null; status?: ApplicationStatus | null; heldRounds?: number; reapplicationOf?: string | null; events?: ApplicationObservation['statusHistory'] } = {},
): ApplicationObservation {
  return {
    applicationId: id,
    submission,
    evidence: EVIDENCE_OF[submission],
    sentAt: over.sentAt === undefined ? null : over.sentAt,
    status: over.status === undefined ? 'applied' : over.status,
    statusHistory: over.events ?? 'current_value_only',
    heldRounds: over.heldRounds ?? 0,
    reapplicationOf: over.reapplicationOf ?? null,
  };
}

export const contribution = (provider: string | null, queryRefs: SourceContribution['queryRefs'] = 'not_recorded', url: string | null = null): SourceContribution => ({
  provider,
  url,
  queryRefs,
  planRevision: queryRefs === 'not_recorded' ? null : 3,
});

export const variant = (variantId: string, via: QueryRef['via'] = 'fetched_upstream'): QueryRef => ({ variantId, query: variantId, language: null, via });

export const score = (value: number | null, roleFamily: string | null = null): ScoreOpinion =>
  value === null ? { state: 'unscored', value: null, roleFamily: null } : { state: 'scored', value, roleFamily };

export function job(
  id: string,
  over: {
    requisition?: RequisitionKey;
    savedRows?: number;
    title?: string | null;
    scorerMatchingSkills?: string[];
    scorerGaps?: string[];
    contributions?: SourceContribution[];
    score?: ScoreOpinion;
    applications?: ApplicationObservation[];
    assessment?: { state: AssessmentState; requirements?: RequirementRecord[]; coverage?: 'complete' | 'partial' | 'not_run' };
    eligibility?: EligibilityRecord[];
    versions?: Partial<JobObservation['versions']>;
    selectedAt?: string | null;
    availability?: Record<string, Availability>;
  } = {},
): JobObservation {
  return {
    id,
    requisition: over.requisition ?? key('requisition', `ats:${id}`),
    savedRows: over.savedRows ?? 1,
    contributions: over.contributions ?? [contribution('ats_roster_greenhouse')],
    selectedAt: over.selectedAt === undefined ? '2026-08-01T00:00:00.000Z' : over.selectedAt,
    score: over.score ?? score(75, 'Platform Engineer'),
    hints: { title: over.title === undefined ? 'Platform Engineer' : over.title, scorerMatchingSkills: over.scorerMatchingSkills ?? [], scorerGaps: over.scorerGaps ?? [] },
    applications: over.applications ?? [],
    assessment: { state: over.assessment?.state ?? 'none', requirements: over.assessment?.requirements ?? [], coverage: over.assessment?.coverage ?? (over.assessment?.state && over.assessment.state !== 'none' ? 'complete' : 'not_run') },
    eligibility: over.eligibility ?? [],
    versions: { contract: CONTRACT_VERSION, profileVersion: 'p1', scoredPreferences: null, jdHash: 'jd1', cvHash: 'cv1', assessmentWorkflow: COMPATIBLE_ASSESSMENT_WORKFLOW, planRevision: null, ...over.versions },
    availability: over.availability ?? {},
  };
}

export const req = (id: string, text: string, evidenceClass: RequirementRecord['evidenceClass'], over: Partial<RequirementRecord> = {}): RequirementRecord => {
  const jdAnchor = over.jdAnchor ?? `${text} is listed in the posting.`;
  return {
    requirementId: id,
    text,
    classification: 'required',
    evidenceClass,
    reviewed: true,
    excluded: false,
    jdAnchor,
    jdRevisionId: 'jdrev-1',
    quoteSpan: { start: 40, end: 40 + jdAnchor.length },
    candidateAdded: false,
    ...over,
  };
};
