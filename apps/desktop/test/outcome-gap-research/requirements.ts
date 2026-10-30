import {
  COMPATIBLE_ASSESSMENT_WORKFLOW,
  GATES,
  evidenceOriginOf,
  type EvidenceOrigin,
  type JobObservation,
  type NoGoReason,
  type RecordedOutcome,
  type RequirementClassification,
  type RequirementRecord,
  type Verdict,
} from './contract.js';
import { outcomeOfApplication, sentApplicationsOf } from './funnel.js';

/**
 * View 2: recurring requirements across the jobs the person selected.
 *
 * Four lanes that are NEVER merged, because they mean different things:
 *   recorded_missing_experience   evidenceClass `candidate_confirmed_gap` -- only the person can say this; the
 *                                 schema forbids any model or extraction path from producing it.
 *   cv_evidence_not_recorded      `unsupported` / `needs_verification` -- "no CV claim is permitted on current
 *                                 evidence". The schema says outright this is NOT a statement about ability.
 *   supported_by_cv               `direct` / `transferable` -- context for how often a requirement recurs.
 *   unreviewed                    the person has not looked at the mapping yet (and it is not their own gap statement).
 *  and, from the eligibility answers (not from requirement text):
 *   preference_or_eligibility_mismatch   a recorded `known_mismatch` (work country, mandatory language, visa).
 *
 * Preferred vs mandatory is kept explicit. Every supporting job carries the posting's own `classification`
 * (required / preferred / unclear) and every row and suggestion splits its count by it (`byClassification`).
 * DECISION: the recurrence threshold counts ALL assessed appearances in a lane whatever their class, because
 * "this keeps appearing in the jobs you chose and your CV does not show it" is a frequency fact that holds for a
 * nice-to-have too; but the wording is class-aware (suggestions.ts) and a row whose appearances are all preferred
 * can never receive mandatory-style wording. The class is the posting's wording as read by the extraction (a JD-side
 * fact the person may edit); it is independent of the evaluator's fit score and of outcomes.
 *
 * What it will NOT do: infer a requirement or a gap from a title, a score, a rejection, a non-response or the
 * absence of an assessment. A job without a current, compatible assessment is reported as "not assessed"
 * (unknown), never as "no requirements" and never as a zero. The evaluator's fit score appears only as a context
 * column on a supporting job; changing every score changes nothing computed here (tested).
 */

export type RequirementLane = 'recorded_missing_experience' | 'cv_evidence_not_recorded' | 'supported_by_cv' | 'unreviewed';

export const OUTCOME_CONTEXT_CAVEAT =
  'Outcomes are shown only as context for these jobs. A rejection, an interview or silence is not evidence that this requirement was the reason, and nothing here estimates a chance of being hired.';

/** A person-confirmed merge of requirement wordings ("K8s" = "Kubernetes"). The only way two texts become one row. */
export interface PersonAliasGroup {
  label: string;
  members: string[];
}

export interface SupportingJob {
  jobId: string;
  requisitionKey: string;
  lane: RequirementLane;
  evidenceClass: RequirementRecord['evidenceClass'];
  /** Who produced the evidence class (see `EvidenceOrigin`). */
  evidenceOrigin: EvidenceOrigin;
  classification: RequirementClassification;
  /** The JD wording this was read from, and where, so a reviewer can find it in the posting. */
  jdAnchor: string;
  jdRevisionId: string;
  quoteSpan: { start: number; end: number } | null;
  /** The person added this requirement (true) rather than the extraction finding it (false). */
  candidateAdded: boolean;
  /** Context only. Null = unscored (missing), never zero. */
  evaluatorScore: number | null;
  outcome: RecordedOutcome | 'not_sent';
}

export interface RequirementRow {
  key: string;
  label: string;
  /** Distinct assessed requisitions that list it, any lane. */
  jobsPresent: number;
  byLane: Record<RequirementLane, number>;
  /** Distinct assessed requisitions by the posting's own class for the entry kept for that job. Sums to `jobsPresent`; never merged into one "required" count. */
  byClassification: Record<RequirementClassification, number>;
  supportingJobs: SupportingJob[];
  /** Raw denominators the row is a fraction of. */
  denominators: { assessedUsable: number; selected: number };
  smallSample: boolean;
}

export interface EligibilityMismatchRow {
  key: string;
  jobsKnownMismatch: number;
  jobsAnswered: number;
  jobsUnknown: number;
  denominators: { selected: number };
  supportingJobs: { jobId: string; requisitionKey: string; source: string; outcome: RecordedOutcome | 'not_sent' }[];
  smallSample: boolean;
}

export interface RequirementsView {
  contract: 'requirements/0.1.0-research';
  selected: number;
  assessment: {
    current: number;
    usable: number;
    partial: number;
    stale: number;
    unavailable: number;
    none: number;
    excludedIncompatible: number;
    versionClasses: { versionClass: string; jobs: number; dominant: boolean }[];
  };
  evaluatorOpinion: { scored: number; unscored: number; note: string };
  requirements: RequirementRow[];
  eligibility: EligibilityMismatchRow[];
  verdict: Verdict;
  outcomeCaveat: string;
  notes: string[];
}

export function normalizeRequirementText(text: string): string {
  return text
    .normalize('NFKD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9+#.]+/gu, ' ')
    .replace(/^[.\s]+|[.\s]+$/gu, '');
}

export function laneOf(requirement: RequirementRecord): RequirementLane {
  if (requirement.evidenceClass === 'candidate_confirmed_gap') return 'recorded_missing_experience';
  if (!requirement.reviewed) return 'unreviewed';
  if (requirement.evidenceClass === 'unsupported' || requirement.evidenceClass === 'needs_verification') return 'cv_evidence_not_recorded';
  return 'supported_by_cv';
}

const LANE_PRIORITY: RequirementLane[] = ['recorded_missing_experience', 'cv_evidence_not_recorded', 'unreviewed', 'supported_by_cv'];

function emptyLanes(): Record<RequirementLane, number> {
  return { recorded_missing_experience: 0, cv_evidence_not_recorded: 0, supported_by_cv: 0, unreviewed: 0 };
}

export function emptyClassifications(): Record<RequirementClassification, number> {
  return { required: 0, preferred: 0, unclear: 0 };
}

/** Within one lane a job that lists a requirement twice keeps the stronger posting class: required over preferred over unclear. */
const CLASSIFICATION_PRIORITY: RequirementClassification[] = ['required', 'preferred', 'unclear'];

export function outcomeContextOf(job: JobObservation): RecordedOutcome | 'not_sent' {
  const sent = sentApplicationsOf(job);
  return sent.length === 0 ? 'not_sent' : outcomeOfApplication(sent[sent.length - 1]!);
}

export interface RequirementsOptions {
  aliasGroups?: PersonAliasGroup[];
}

export function buildRequirements(observations: readonly JobObservation[], options: RequirementsOptions = {}): RequirementsView {
  const selected = observations.length;
  const count = (state: JobObservation['assessment']['state']) => observations.filter((job) => job.assessment.state === state).length;
  const current = observations.filter((job) => job.assessment.state === 'current');

  // Version classes: an evidence class is only comparable with another made under the same rules AND the same CV.
  const classOf = (job: JobObservation) => `${job.versions.assessmentWorkflow ?? 'unknown'}|${job.versions.cvHash ?? 'unknown'}`;
  const classes = new Map<string, JobObservation[]>();
  for (const job of current) {
    const list = classes.get(classOf(job)) ?? [];
    list.push(job);
    classes.set(classOf(job), list);
  }
  const ranked = [...classes.entries()].sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]));
  const dominantKey = ranked[0]?.[0] ?? null;
  const dominantUsable = dominantKey !== null && dominantKey.startsWith(`${COMPATIBLE_ASSESSMENT_WORKFLOW}|`) && !dominantKey.endsWith('|unknown');
  const usable = dominantUsable ? ranked[0]![1] : [];
  const excludedIncompatible = current.length - usable.length;

  // Person-confirmed aliases only; there is no fuzzy matching and no built-in skill vocabulary.
  const aliasOf = new Map<string, { key: string; label: string }>();
  for (const group of options.aliasGroups ?? []) {
    const key = normalizeRequirementText(group.label);
    for (const member of [group.label, ...group.members]) aliasOf.set(normalizeRequirementText(member), { key, label: group.label });
  }

  const rows = new Map<string, RequirementRow>();
  for (const job of usable) {
    const perJob = new Map<string, { label: string; requirement: RequirementRecord; lane: RequirementLane }>();
    for (const requirement of job.assessment.requirements) {
      if (requirement.excluded) continue;
      const normalized = normalizeRequirementText(requirement.text);
      if (normalized === '') continue;
      const aliased = aliasOf.get(normalized);
      const key = aliased?.key ?? normalized;
      const lane = laneOf(requirement);
      const existing = perJob.get(key);
      // A job lists a requirement once: keep the lane that carries the most information about it.
      const better =
        !existing ||
        LANE_PRIORITY.indexOf(lane) < LANE_PRIORITY.indexOf(existing.lane) ||
        (lane === existing.lane && CLASSIFICATION_PRIORITY.indexOf(requirement.classification) < CLASSIFICATION_PRIORITY.indexOf(existing.requirement.classification));
      if (better) perJob.set(key, { label: aliased?.label ?? requirement.text.trim(), requirement, lane });
    }
    const outcome = outcomeContextOf(job);
    for (const [key, entry] of perJob) {
      let row = rows.get(key);
      if (!row) {
        row = { key, label: entry.label, jobsPresent: 0, byLane: emptyLanes(), byClassification: emptyClassifications(), supportingJobs: [], denominators: { assessedUsable: usable.length, selected }, smallSample: true };
        rows.set(key, row);
      }
      row.jobsPresent += 1;
      row.byLane[entry.lane] += 1;
      row.byClassification[entry.requirement.classification] += 1;
      row.supportingJobs.push({
        jobId: job.id,
        requisitionKey: job.requisition.key,
        lane: entry.lane,
        evidenceClass: entry.requirement.evidenceClass,
        evidenceOrigin: evidenceOriginOf(entry.requirement),
        classification: entry.requirement.classification,
        jdAnchor: entry.requirement.jdAnchor,
        jdRevisionId: entry.requirement.jdRevisionId,
        quoteSpan: entry.requirement.quoteSpan,
        candidateAdded: entry.requirement.candidateAdded,
        evaluatorScore: job.score.value,
        outcome,
      });
    }
  }
  const requirementRows = [...rows.values()]
    .map((row) => ({ ...row, smallSample: row.jobsPresent < GATES.minRecurrence, supportingJobs: row.supportingJobs.sort((a, b) => a.jobId.localeCompare(b.jobId)) }))
    .sort((a, b) => b.jobsPresent - a.jobsPresent || a.key.localeCompare(b.key));

  // Eligibility: read from the scan's answers, over every selected job (not only assessed ones).
  const eligibilityRows = new Map<string, EligibilityMismatchRow>();
  const eligibilityKeys = new Set(observations.flatMap((job) => job.eligibility.map((record) => record.key)));
  for (const eligibilityKey of [...eligibilityKeys].sort()) {
    const row: EligibilityMismatchRow = { key: eligibilityKey, jobsKnownMismatch: 0, jobsAnswered: 0, jobsUnknown: 0, denominators: { selected }, supportingJobs: [], smallSample: true };
    for (const job of observations) {
      const record = job.eligibility.find((entry) => entry.key === eligibilityKey);
      if (!record) continue;
      if (record.answer === 'unknown') row.jobsUnknown += 1;
      else row.jobsAnswered += 1;
      if (record.classification === 'known_mismatch') {
        row.jobsKnownMismatch += 1;
        row.supportingJobs.push({ jobId: job.id, requisitionKey: job.requisition.key, source: record.source, outcome: outcomeContextOf(job) });
      }
    }
    row.smallSample = row.jobsKnownMismatch < GATES.minRecurrence;
    row.supportingJobs.sort((a, b) => a.jobId.localeCompare(b.jobId));
    if (row.jobsKnownMismatch > 0) eligibilityRows.set(eligibilityKey, row);
  }

  const reasons: NoGoReason[] = [];
  if (usable.length < GATES.minAssessed) reasons.push('too_few_assessed');
  if (selected > 0 && (selected - current.length) / selected > GATES.maxUnassessedShare) reasons.push('unassessed_dominate');
  if (current.length > 0 && excludedIncompatible / current.length > GATES.maxIncompatibleShare) reasons.push('version_incompatible_dominates');
  const flagged = requirementRows.some((row) => row.byLane.cv_evidence_not_recorded >= GATES.minRecurrence || row.byLane.recorded_missing_experience >= GATES.minRecurrence);
  const eligibilityRecurs = [...eligibilityRows.values()].some((row) => row.jobsKnownMismatch >= GATES.minRecurrence);
  if (!flagged && !eligibilityRecurs) reasons.push('no_recurring_requirement');

  return {
    contract: 'requirements/0.1.0-research',
    selected,
    assessment: {
      current: current.length,
      usable: usable.length,
      partial: count('partial'),
      stale: count('stale'),
      unavailable: count('unavailable'),
      none: count('none'),
      excludedIncompatible,
      versionClasses: ranked.map(([versionClass, jobs]) => ({ versionClass, jobs: jobs.length, dominant: versionClass === dominantKey })),
    },
    evaluatorOpinion: {
      scored: observations.filter((job) => job.score.state !== 'unscored').length,
      unscored: observations.filter((job) => job.score.state === 'unscored').length,
      note: 'An evaluator opinion about fit. It is not a requirement, a gap or an outcome, and it is not used to compute any row here.',
    },
    requirements: requirementRows,
    eligibility: [...eligibilityRows.values()].sort((a, b) => b.jobsKnownMismatch - a.jobsKnownMismatch || a.key.localeCompare(b.key)),
    verdict: { verdict: reasons.length === 0 ? 'go_review' : 'no_go', reasons: [...new Set(reasons)] },
    outcomeCaveat: OUTCOME_CONTEXT_CAVEAT,
    notes: [
      'Jobs without a current, version-compatible assessment are counted as not assessed (unknown), never as having no requirements.',
      'Requirement wording is the posting’s own text. Two wordings become one row only through a person-confirmed alias; nothing is merged by similarity, so recurrence can be under-counted.',
      'A requirement the CV cannot evidence is not a missing skill: it may be real experience the CV does not show.',
      'The recurrence threshold counts every assessed appearance whatever its class (required, preferred or unclear); each row and suggestion states the split, and a row that is only preferred or unclear never gets mandatory wording.',
    ],
  };
}
