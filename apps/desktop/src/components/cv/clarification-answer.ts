import type { CvEvidenceFact, CvFactOwnership, CvRequirementMapping, CvSourceDocument } from '../../window.js';

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
      /** When in the role or project this happened, in the candidate's words. Optional. */
      timePhase?: string;
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

/**
 * Why a stated basis cannot ground a number, or `null` when it can (#419 step 6: "require an
 * explicit basis for any number; do not infer business impact from code/test counts or a deployed
 * URL"). A number is only ever what the candidate says it is and where it came from. A basis that
 * says the number was worked out from test counts, commit or line counts, or a deployed address is
 * the inference this rule forbids, so it is refused rather than stored.
 */
export function metricBasisProblem(basis: string): string | null {
  const text = basis.trim();
  if (text.length === 0) return 'A number needs a stated source before it can be saved.';
  if (/\b(inferred|assumed|derived from|counted from|test count|number of tests|tests? passing|commit count|commits?|lines of code|loc|deployed|live site|url|website is live)\b/iu.test(text)) {
    return 'A business result cannot be worked out from code, test counts or a deployed address. Give where you got the figure, or leave the number out.';
  }
  return null;
}

export function applyClarificationAnswer(
  requirement: CvRequirementMapping,
  answer: ClarificationAnswer,
  /** Only consulted for `'not_my_work'`, to resolve whether `requirement.anchorParentId` (which
   * can legitimately be set even on a `needs_verification` row -- a model may anchor a requirement
   * it is not confident enough to call direct evidence) names an experience entry or a project.
   * `null` is safe: an id that resolves to nothing just means the recorded fact carries no parent
   * scope, the same as a requirement that was never anchored at all. */
  source?: CvSourceDocument | null,
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
    // `requirement.anchorParentId` is empty on the common path (the model leaves it empty exactly
    // when it is not confident enough to anchor), but not guaranteed to be -- resolve it against
    // the real source rather than assuming either an experience entry or "always empty".
    const anchoredExperience = source?.experience.find((entry) => entry.id === requirement.anchorParentId);
    const anchoredProject = source?.projects.find((entry) => entry.id === requirement.anchorParentId);
    const resolvedParentId = anchoredExperience || anchoredProject ? requirement.anchorParentId : '';
    const fact: CvEvidenceFact = {
      factId: crypto.randomUUID(),
      parentId: resolvedParentId,
      // Meaningless when `resolvedParentId` is empty; `'experience'` is just this field's declared
      // default in that case, the same way `CvFactOwnership`'s `'unknown'` is a real value rather
      // than an absence.
      parentType: anchoredProject ? 'project' : 'experience',
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
      // The candidate's own statement that they did not do this. It claims nothing, so there is
      // nothing for them to review field by field.
      approval: 'approved',
      timePhase: '',
    };
    return {
      requirement: {
        ...requirement,
        evidenceClass: 'candidate_confirmed_gap',
        anchorParentId: '',
        sourceIds: [],
        factIds: [],
        reviewed: true,
      },
      fact,
    };
  }

  // answer.kind === 'answered'
  const hasMetric = (answer.metricValue ?? '').trim().length > 0;
  if (hasMetric) {
    const problem = metricBasisProblem(answer.metricBasis ?? '');
    if (problem) throw new Error(problem);
  }
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
    // The candidate answered the question, which is not yet approving the distilled fact. That
    // happens in the fact review, where every field is shown.
    approval: 'proposed',
    timePhase: (answer.timePhase ?? '').trim(),
  };
  return {
    requirement: {
      ...requirement,
      anchorParentId: answer.parentId,
      factIds: [...requirement.factIds, fact.factId],
      // A direct, self-reported answer to "what did you do" is direct evidence by definition --
      // the candidate is not describing adjacent work, they are answering the requirement itself.
      evidenceClass: 'direct',
      reviewed: true,
    },
    fact,
  };
}
