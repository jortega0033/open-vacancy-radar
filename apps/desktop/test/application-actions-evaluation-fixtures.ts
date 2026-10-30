import type { DueInput, DueState, SubmissionClass, SuggestionReason } from '../electron/application-actions-core.js';

/**
 * Constructed, synthetic evaluation cases for #692 (local due actions and follow-up suggestions).
 *
 * Every expected label below is DECLARED HERE, by hand, from the written rules in the ticket and the
 * plan, before any code is run against it. The evaluation test then measures what the real lifecycle
 * entrypoints report against these labels. They are not human judgements about real applications, not
 * a sample of anyone's data, and say nothing about how useful follow-ups are to a person.
 *
 * The clock is fixed: AS_OF = Monday 2026-11-02 10:00:00 UTC.
 */
export const AS_OF = '2026-11-02T10:00:00.000Z';

export type RowMake =
  | { how: 'hand'; status: 'preparing' | 'applied' | 'recruiter_screen' | 'interview' | 'offer' | 'rejected' | 'withdrawn'; appliedAt: string | null; archived?: boolean }
  | { how: 'attempt'; checkpoint: 'queued' | 'tailoring' | 'ready' | 'needs_user' | 'failed' | 'skipped' | 'submission_unknown' | 'user_reported' | 'submitted'; status?: 'rejected' };

export interface ActionCase {
  id: string;
  due: DueInput;
  /** What the person did with it after creating it. */
  final: 'open' | 'completed' | 'dismissed';
  /** Declared label at AS_OF. */
  expected: Exclude<DueState, never>;
}

export interface RowCase {
  id: string;
  group: string;
  make: RowMake;
  suppressed?: boolean;
  actions?: ActionCase[];
  expected: { suggestion: boolean; reason: SuggestionReason; submissionClass: SubmissionClass };
}

const sent = (over: Partial<Extract<RowMake, { how: 'hand' }>> = {}): RowMake => ({ how: 'hand', status: 'applied', appliedAt: '2026-10-12T09:00:00.000Z', ...over });

/** One hand-tracked "applied" row per action case, so each action is judged on its own row. */
function actionRow(action: ActionCase): RowCase {
  const open = action.final === 'open';
  return {
    id: `action-${action.id}`,
    group: 'action_due_state',
    make: sent(),
    actions: [action],
    expected: open
      ? { suggestion: false, reason: 'has_open_action', submissionClass: 'user_stated' }
      : { suggestion: true, reason: 'eligible', submissionClass: 'user_stated' },
  };
}

export const ACTION_CASES: ActionCase[] = [
  // Whole-day dates are overdue only after that day has ended IN THEIR OWN ZONE.
  { id: 'date-yesterday-amsterdam', due: { kind: 'date', date: '2026-11-01', timeZone: 'Europe/Amsterdam' }, final: 'open', expected: 'overdue' },
  { id: 'date-today-amsterdam', due: { kind: 'date', date: '2026-11-02', timeZone: 'Europe/Amsterdam' }, final: 'open', expected: 'due_today' },
  { id: 'date-tomorrow-amsterdam', due: { kind: 'date', date: '2026-11-03', timeZone: 'Europe/Amsterdam' }, final: 'open', expected: 'upcoming' },
  { id: 'date-today-auckland', due: { kind: 'date', date: '2026-11-02', timeZone: 'Pacific/Auckland' }, final: 'open', expected: 'due_today' },
  { id: 'date-today-honolulu', due: { kind: 'date', date: '2026-11-02', timeZone: 'Pacific/Honolulu' }, final: 'open', expected: 'due_today' },
  { id: 'date-yesterday-honolulu-exact-boundary', due: { kind: 'date', date: '2026-11-01', timeZone: 'Pacific/Honolulu' }, final: 'open', expected: 'overdue' },
  { id: 'date-today-kiritimati-exact-boundary', due: { kind: 'date', date: '2026-11-02', timeZone: 'Pacific/Kiritimati' }, final: 'open', expected: 'overdue' },
  { id: 'date-yesterday-utc', due: { kind: 'date', date: '2026-11-01', timeZone: 'UTC' }, final: 'open', expected: 'overdue' },
  { id: 'date-today-utc', due: { kind: 'date', date: '2026-11-02', timeZone: 'UTC' }, final: 'open', expected: 'due_today' },
  // Timed actions are overdue at the minute.
  { id: 'time-one-minute-ago', due: { kind: 'datetime', local: '2026-11-02T10:59', timeZone: 'Europe/Amsterdam' }, final: 'open', expected: 'overdue' },
  { id: 'time-exactly-now', due: { kind: 'datetime', local: '2026-11-02T11:00', timeZone: 'Europe/Amsterdam' }, final: 'open', expected: 'overdue' },
  { id: 'time-one-minute-ahead', due: { kind: 'datetime', local: '2026-11-02T11:01', timeZone: 'Europe/Amsterdam' }, final: 'open', expected: 'due_today' },
  { id: 'time-next-week', due: { kind: 'datetime', local: '2026-11-09T09:00', timeZone: 'America/New_York' }, final: 'open', expected: 'upcoming' },
  // A repeated hour after daylight saving ended: the person chose the later one.
  { id: 'time-fold-later-last-week', due: { kind: 'datetime', local: '2026-10-25T02:30', timeZone: 'Europe/Amsterdam', ambiguity: 'later' }, final: 'open', expected: 'overdue' },
  // History is never reported as missed.
  { id: 'date-overdue-but-completed', due: { kind: 'date', date: '2026-10-20', timeZone: 'UTC' }, final: 'completed', expected: 'closed' },
  { id: 'date-overdue-but-dismissed', due: { kind: 'date', date: '2026-10-20', timeZone: 'UTC' }, final: 'dismissed', expected: 'closed' },
];

export const ROW_CASES: RowCase[] = [
  // Recorded as sent, still waiting: the only rows a follow-up prompt may appear on.
  { id: 'hand-applied', group: 'sent_quiet', make: sent(), expected: { suggestion: true, reason: 'eligible', submissionClass: 'user_stated' } },
  { id: 'hand-applied-no-date', group: 'sent_quiet', make: sent({ appliedAt: null }), expected: { suggestion: true, reason: 'eligible', submissionClass: 'user_stated' } },
  { id: 'receipt-backed', group: 'sent_quiet', make: { how: 'attempt', checkpoint: 'submitted' }, expected: { suggestion: true, reason: 'eligible', submissionClass: 'receipt_backed' } },
  { id: 'user-reported', group: 'sent_quiet', make: { how: 'attempt', checkpoint: 'user_reported' }, expected: { suggestion: true, reason: 'eligible', submissionClass: 'user_reported' } },
  // No cadence: sent a minute ago and sent two years ago are treated the same.
  { id: 'applied-two-years-ago', group: 'no_cadence', make: sent({ appliedAt: '2024-11-02T09:00:00.000Z' }), expected: { suggestion: true, reason: 'eligible', submissionClass: 'user_stated' } },
  { id: 'applied-one-minute-ago', group: 'no_cadence', make: sent({ appliedAt: '2026-11-02T09:59:00.000Z' }), expected: { suggestion: true, reason: 'eligible', submissionClass: 'user_stated' } },
  // Draft / preparing / handoff-only / unknown: never "unanswered submitted".
  { id: 'hand-preparing', group: 'not_submitted', make: { how: 'hand', status: 'preparing', appliedAt: null }, expected: { suggestion: false, reason: 'not_submitted', submissionClass: 'not_recorded' } },
  { id: 'attempt-queued', group: 'not_submitted', make: { how: 'attempt', checkpoint: 'queued' }, expected: { suggestion: false, reason: 'not_submitted', submissionClass: 'prepared' } },
  { id: 'attempt-tailoring', group: 'not_submitted', make: { how: 'attempt', checkpoint: 'tailoring' }, expected: { suggestion: false, reason: 'not_submitted', submissionClass: 'prepared' } },
  { id: 'attempt-ready-for-review', group: 'not_submitted', make: { how: 'attempt', checkpoint: 'ready' }, expected: { suggestion: false, reason: 'not_submitted', submissionClass: 'prepared' } },
  { id: 'attempt-needs-input', group: 'not_submitted', make: { how: 'attempt', checkpoint: 'needs_user' }, expected: { suggestion: false, reason: 'not_submitted', submissionClass: 'prepared' } },
  { id: 'attempt-failed', group: 'not_submitted', make: { how: 'attempt', checkpoint: 'failed' }, expected: { suggestion: false, reason: 'not_submitted', submissionClass: 'prepared' } },
  // Stands in for "the employer page was opened, nothing submitted" (#658 is not merged): a prepared attempt, status still Preparing.
  { id: 'handoff-only-simulated', group: 'handoff_only', make: { how: 'attempt', checkpoint: 'ready' }, expected: { suggestion: false, reason: 'not_submitted', submissionClass: 'prepared' } },
  { id: 'attempt-skipped-archived', group: 'not_submitted', make: { how: 'attempt', checkpoint: 'skipped' }, expected: { suggestion: false, reason: 'archived', submissionClass: 'prepared' } },
  { id: 'sent-but-unconfirmed', group: 'unknown', make: { how: 'attempt', checkpoint: 'submission_unknown' }, expected: { suggestion: false, reason: 'unknown_submission', submissionClass: 'unconfirmed' } },
  // A reply exists, or the outcome is final: silence is not in play.
  { id: 'recruiter-screen', group: 'in_conversation', make: sent({ status: 'recruiter_screen' }), expected: { suggestion: false, reason: 'in_conversation', submissionClass: 'user_stated' } },
  { id: 'interview', group: 'in_conversation', make: sent({ status: 'interview' }), expected: { suggestion: false, reason: 'in_conversation', submissionClass: 'user_stated' } },
  { id: 'offer', group: 'terminal', make: sent({ status: 'offer' }), expected: { suggestion: false, reason: 'terminal', submissionClass: 'user_stated' } },
  { id: 'rejected', group: 'terminal', make: sent({ status: 'rejected' }), expected: { suggestion: false, reason: 'terminal', submissionClass: 'user_stated' } },
  { id: 'withdrawn', group: 'terminal', make: sent({ status: 'withdrawn' }), expected: { suggestion: false, reason: 'terminal', submissionClass: 'user_stated' } },
  { id: 'receipt-backed-then-rejected', group: 'terminal', make: { how: 'attempt', checkpoint: 'submitted', status: 'rejected' }, expected: { suggestion: false, reason: 'terminal', submissionClass: 'receipt_backed' } },
  // The person's own switches.
  { id: 'archived', group: 'person_choice', make: sent({ archived: true }), expected: { suggestion: false, reason: 'archived', submissionClass: 'user_stated' } },
  { id: 'suggestions-switched-off', group: 'person_choice', make: sent(), suppressed: true, expected: { suggestion: false, reason: 'suppressed', submissionClass: 'user_stated' } },
  // A final outcome does not delete the person's own record: the step stays open and overdue.
  {
    id: 'rejected-with-own-overdue-step',
    group: 'terminal_keeps_records',
    make: sent({ status: 'rejected' }),
    actions: [{ id: 'thank-you-after-rejection', due: { kind: 'date', date: '2026-10-30', timeZone: 'UTC' }, final: 'open', expected: 'overdue' }],
    expected: { suggestion: false, reason: 'terminal', submissionClass: 'user_stated' },
  },
  ...ACTION_CASES.map(actionRow),
];
