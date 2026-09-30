import type { CvEvidenceFact, CvFactOwnership, CvRequirementMapping } from '../../window.js';

/**
 * One candidate response to a `needs_verification` requirement (#419, step 3): asked as three
 * separate questions -- what they personally did and in which role/project, how (the actual
 * mechanism and scope), and the result or why it mattered, if known -- never with a target keyword
 * supplied as a suggested answer, and never inferring a number from test counts, repository
 * activity, or a deployed URL; a metric is only ever what the candidate states here.
 *
 * `'not_my_work'`, `'unknown'` and `'skip'` all "stay gaps" (#419's own words): none of them
 * resolves a requirement to supported evidence. They differ only in what gets recorded --
 * `'not_my_work'` is itself a fact worth keeping (the candidate explicitly said they did not do
 * this, so the same question is never asked again as if unanswered), `'unknown'` records that the
 * candidate considered the question and could not answer it, and `'skip'` records nothing at all,
 * leaving the requirement exactly as it was for a later pass.
 */
export type ClarificationAnswer =
  | {
      kind: 'answered';
      parentId: string;
      parentType: 'experience' | 'project';
      activity: string;
      mechanism: string;
      result: string;
      metricValue?: string;
      metricUnit?: string;
      metricBasis?: string;
    }
  | { kind: 'not_my_work' }
  | { kind: 'unknown' }
  | { kind: 'skip' };

export interface ClarificationResult {
  requirement: CvRequirementMapping;
  /** The new fact to add to the overlay, or null when this answer creates none (`'unknown'` /
   * `'skip'`). */
  fact: CvEvidenceFact | null;
}

/** Ownership is never asked in this flow (#419's step 3 lists three questions, not four) -- it
 * stays the honest default until a later pass asks it explicitly, the same "never invent" rule
 * every other unset field in this app follows. */
const UNASKED_OWNERSHIP: CvFactOwnership = 'unknown';

export function applyClarificationAnswer(
  requirement: CvRequirementMapping,
  answer: ClarificationAnswer,
): ClarificationResult {
  if (answer.kind === 'skip') {
    // Recorded nowhere: this pass leaves the requirement exactly as it was, for someone to answer
    // later. Marking it reviewed here would hide it from "needs attention" for a question nobody
    // actually answered yet.
    return { requirement, fact: null };
  }

  if (answer.kind === 'unknown') {
    // Considered and could not be answered -- distinct from `'skip'` in that a person did look at
    // it, so it counts toward review completeness, but distinct from a real answer in that nothing
    // about the requirement's evidence changes.
    return { requirement: { ...requirement, reviewed: true }, fact: null };
  }

  const now = new Date().toISOString();

  if (answer.kind === 'not_my_work') {
    const fact: CvEvidenceFact = {
      factId: crypto.randomUUID(),
      parentId: requirement.anchorParentId,
      parentType: 'experience',
      client: '',
      activity: '',
      mechanism: '',
      result: '',
      ownership: UNASKED_OWNERSHIP,
      sourceKind: 'candidate_testimony',
      sourceReference: '',
      verification: 'candidate_confirmed_gap',
      metricValue: '',
      metricUnit: '',
      metricBasis: '',
      supersedes: '',
      createdAt: now,
    };
    return {
      requirement: { ...requirement, evidenceClass: 'unsupported', anchorParentId: '', reviewed: true },
      fact,
    };
  }

  // answer.kind === 'answered'
  const hasMetric = (answer.metricValue ?? '').trim().length > 0;
  const fact: CvEvidenceFact = {
    factId: crypto.randomUUID(),
    parentId: answer.parentId,
    parentType: answer.parentType,
    client: '',
    activity: answer.activity.trim(),
    mechanism: answer.mechanism.trim(),
    result: answer.result.trim(),
    ownership: UNASKED_OWNERSHIP,
    sourceKind: 'candidate_testimony',
    sourceReference: '',
    verification: 'self_reported',
    // A metric with no stated basis is never kept -- the same rule the overlay's own validation
    // enforces server-side; enforced again here so the row never round-trips one that would fail.
    metricValue: hasMetric ? (answer.metricValue ?? '').trim() : '',
    metricUnit: hasMetric ? (answer.metricUnit ?? '').trim() : '',
    metricBasis: hasMetric ? (answer.metricBasis ?? '').trim() : '',
    supersedes: '',
    createdAt: now,
  };
  return {
    requirement: {
      ...requirement,
      anchorParentId: answer.parentId,
      // A direct, self-reported answer to "what did you do" is direct evidence by definition --
      // the candidate is not describing adjacent work, they are answering the requirement itself.
      evidenceClass: 'direct',
      reviewed: true,
    },
    fact,
  };
}
