import { createHash } from 'node:crypto';
import { ELIGIBILITY_LABEL, type EligibilityKey } from '../../electron/application-brief.js';
import { GATES, type NoGoReason, type RecordedOutcome } from './contract.js';
import type { FunnelView } from './funnel.js';
import { OUTCOME_CONTEXT_CAVEAT, type RequirementsView } from './requirements.js';

/**
 * Reviewable suggestions. A suggestion is a pure value derived from the two views; it has no handle on the
 * profile, the preferences, the search plan or any weight, and no function in this module accepts or returns
 * one. `effect` is always `'none'` and the only action offered is `'dismiss'`. What a person does about a
 * suggestion happens elsewhere, in the CV, profile or search screens they already have, by their own edit.
 *
 * Every suggestion carries its raw evidence: which jobs, which denominator, which window, which version
 * class, how small the sample is, and (for requirements) the outcomes of those jobs as labelled context.
 * Wording is deliberately non-causal.
 */

export type SuggestionKind = 'add_cv_evidence' | 'consider_learning_priority' | 'review_preference_conflict' | 'review_search_variant';

export interface SupportItem {
  jobId: string;
  requisitionKey: string;
  detail: string;
}

export interface Suggestion {
  id: string;
  kind: SuggestionKind;
  subject: string;
  statement: string;
  support: {
    items: SupportItem[];
    count: number;
    denominators: { label: string; value: number }[];
    window: { firstSelectedAt: string | null; lastSelectedAt: string | null; asOf: string };
    versionClass: string | null;
  };
  uncertainty: { smallSample: boolean; limits: string[] };
  outcomeContext: { byOutcome: Record<string, number>; caveat: string } | null;
  effect: 'none';
  actions: ['dismiss'];
}

export interface SuggestionSet {
  suggestions: Suggestion[];
  /** Why a family of suggestions was NOT produced. Withholding is a result, not an error. */
  withheld: { requirements: NoGoReason[] | null; searchVariants: NoGoReason[] | null };
}

const idOf = (kind: SuggestionKind, subject: string): string => createHash('sha256').update(`${kind}\u0000${subject}`).digest('hex').slice(0, 16);

const LIMITS_COMMON = [
  'Thresholds are author-declared review gates, not statistically derived.',
  'This is how often something appears in the jobs you chose; it does not say why any employer decided anything.',
];

function outcomeCounts(outcomes: (RecordedOutcome | 'not_sent')[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const outcome of outcomes) counts[outcome] = (counts[outcome] ?? 0) + 1;
  return Object.fromEntries(Object.entries(counts).sort(([a], [b]) => a.localeCompare(b)));
}

export function buildSuggestions(input: {
  asOf: string;
  requirements: RequirementsView;
  /** The query-variant funnel; only used when it carries a (projected) exposure count. */
  variantFunnel?: FunnelView | null;
  /** First/last selection dates by job id, for the support window. */
  selectedAtByJob: Record<string, string | null>;
}): SuggestionSet {
  const { requirements, asOf } = input;
  const suggestions: Suggestion[] = [];
  const windowOf = (jobIds: string[]) => {
    const dates = jobIds.map((id) => input.selectedAtByJob[id]).filter((value): value is string => typeof value === 'string' && value !== '').sort();
    return { firstSelectedAt: dates[0] ?? null, lastSelectedAt: dates[dates.length - 1] ?? null, asOf };
  };
  const dominant = requirements.assessment.versionClasses.find((entry) => entry.dominant)?.versionClass ?? null;
  const reqWithheld = requirements.verdict.verdict === 'no_go' ? requirements.verdict.reasons : null;

  if (!reqWithheld) {
    for (const row of requirements.requirements) {
      for (const [lane, kind] of [['cv_evidence_not_recorded', 'add_cv_evidence'], ['recorded_missing_experience', 'consider_learning_priority']] as const) {
        const count = row.byLane[lane];
        if (count < GATES.minRecurrence) continue;
        const jobs = row.supportingJobs.filter((job) => job.lane === lane);
        const statement =
          kind === 'add_cv_evidence'
            ? `“${row.label}” appears in ${count} of the ${row.denominators.assessedUsable} assessed jobs you chose, and your CV has no recorded evidence for it in those. If you have this experience, you may want to add it to your CV yourself; if you do not, that is for you to decide.`
            : `“${row.label}” appears in ${count} of the ${row.denominators.assessedUsable} assessed jobs you chose, and you recorded that you lack this experience in each. Whether it is worth learning is your decision.`;
        suggestions.push({
          id: idOf(kind, row.key),
          kind,
          subject: row.label,
          statement,
          support: {
            items: jobs.map((job) => ({ jobId: job.jobId, requisitionKey: job.requisitionKey, detail: `${job.classification} requirement, recorded as ${job.evidenceClass}` })),
            count,
            denominators: [
              { label: 'assessed jobs with a current, compatible assessment', value: row.denominators.assessedUsable },
              { label: 'jobs you selected', value: row.denominators.selected },
            ],
            window: windowOf(jobs.map((job) => job.jobId)),
            versionClass: dominant,
          },
          uncertainty: { smallSample: count < GATES.minRecurrence * 2, limits: [...LIMITS_COMMON, 'Requirements are matched by exact wording unless you confirmed an alias, so this may under-count.'] },
          outcomeContext: { byOutcome: outcomeCounts(jobs.map((job) => job.outcome)), caveat: OUTCOME_CONTEXT_CAVEAT },
          effect: 'none',
          actions: ['dismiss'],
        });
      }
    }
    for (const row of requirements.eligibility) {
      if (row.jobsKnownMismatch < GATES.minRecurrence) continue;
      suggestions.push({
        id: idOf('review_preference_conflict', row.key),
        kind: 'review_preference_conflict',
        subject: row.key,
        statement: `${row.jobsKnownMismatch} of the ${row.denominators.selected} jobs you chose have a recorded “no” to “${ELIGIBILITY_LABEL[row.key as EligibilityKey] ?? row.key}” (${row.jobsAnswered} postings answered; ${row.jobsUnknown} did not say). You may want to review that preference or the search that finds these jobs; nothing has been changed.`,
        support: {
          items: row.supportingJobs.map((job) => ({ jobId: job.jobId, requisitionKey: job.requisitionKey, detail: `known mismatch (source: ${job.source})` })),
          count: row.jobsKnownMismatch,
          denominators: [{ label: 'jobs you selected', value: row.denominators.selected }, { label: 'jobs where the posting answered', value: row.jobsAnswered }],
          window: windowOf(row.supportingJobs.map((job) => job.jobId)),
          versionClass: null,
        },
        uncertainty: { smallSample: row.jobsKnownMismatch < GATES.minRecurrence * 2, limits: LIMITS_COMMON },
        outcomeContext: null,
        effect: 'none',
        actions: ['dismiss'],
      });
    }
  }

  const funnel = input.variantFunnel ?? null;
  let variantWithheld: NoGoReason[] | null = null;
  if (funnel) {
    if (funnel.metrics.leadToSelected.verdict === 'no_go') variantWithheld = funnel.metrics.leadToSelected.reasons;
    else {
      for (const cell of funnel.cells) {
        const exposed = cell.selectedOfExposed;
        if (!exposed || exposed.exposed < GATES.minExposed) continue;
        if (exposed.selected / exposed.exposed > GATES.maxSelectedShareForVariantReview) continue;
        suggestions.push({
          id: idOf('review_search_variant', cell.label),
          kind: 'review_search_variant',
          subject: cell.label,
          statement: `You selected ${exposed.selected} of the ${exposed.exposed} distinct leads shown for “${cell.label}”. If that search no longer fits what you want, you may want to review it; whether to keep it is up to you.`,
          support: {
            items: [],
            count: exposed.selected,
            denominators: [{ label: 'distinct leads shown for this variant (projected digest, not recorded today)', value: exposed.exposed }],
            window: { firstSelectedAt: null, lastSelectedAt: null, asOf },
            versionClass: null,
          },
          uncertainty: { smallSample: exposed.exposed < GATES.minExposed * 2, limits: [...LIMITS_COMMON, 'Shown leads overlap across variants; this is one variant’s share, not a ranking.'] },
          outcomeContext: null,
          effect: 'none',
          actions: ['dismiss'],
        });
      }
    }
  } else variantWithheld = ['no_exposure_denominator'];

  suggestions.sort((a, b) => a.kind.localeCompare(b.kind) || b.support.count - a.support.count || a.subject.localeCompare(b.subject));
  return { suggestions, withheld: { requirements: reqWithheld, searchVariants: variantWithheld } };
}

// ------------------------------------------------------------------------------------------ dismissal

/** The only state a person's decisions create. Keyed by suggestion id; a plain value, replaced not mutated. */
export interface ReviewState {
  dismissed: Record<string, { at: string; supportAtDismissal: number }>;
}
export const EMPTY_REVIEW_STATE: ReviewState = Object.freeze({ dismissed: Object.freeze({}) }) as ReviewState;

export function dismiss(state: ReviewState, suggestion: Pick<Suggestion, 'id' | 'support'>, at: string): ReviewState {
  return { dismissed: { ...state.dismissed, [suggestion.id]: { at, supportAtDismissal: suggestion.support.count } } };
}

export function restore(state: ReviewState, id: string): ReviewState {
  const { [id]: _removed, ...rest } = state.dismissed;
  return { dismissed: rest };
}

export function partition(set: SuggestionSet, state: ReviewState): { visible: Suggestion[]; dismissed: { suggestion: Suggestion; newSupportSince: number }[] } {
  const visible: Suggestion[] = [];
  const dismissed: { suggestion: Suggestion; newSupportSince: number }[] = [];
  for (const suggestion of set.suggestions) {
    const decision = state.dismissed[suggestion.id];
    if (!decision) visible.push(suggestion);
    else dismissed.push({ suggestion, newSupportSince: Math.max(0, suggestion.support.count - decision.supportAtDismissal) });
  }
  return { visible, dismissed };
}
