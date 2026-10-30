import {
  actionSummaryLine,
  describeDue,
  dueStateOf,
  summarizeOpenActions,
  systemZone,
} from '../../../electron/application-actions-core.js';
import type { OverviewItem } from './follow-ups-overview.js';
import type { ApplicationRecord, ApplicationStatus } from '../../window.js';
import { NotSet } from '../shell/NotSet.js';
import { ATTEMPT_CHECKPOINT_BADGE_CLASS, ATTEMPT_CHECKPOINT_LABEL } from './attempt-status.js';
import {
  APPLICATION_STATUS_LABEL,
  APPLICATION_STATUS_ORDER,
  APPLICATION_STATUS_SELECT_CLASS,
  INTERVIEW_PREPARABLE_STATUSES,
} from './application-status.js';

export interface ApplicationsTableProps {
  applications: readonly ApplicationRecord[];
  onStatusChange: (record: ApplicationRecord, status: ApplicationStatus) => void;
  onEdit: (record: ApplicationRecord) => void;
  onToggleArchive: (record: ApplicationRecord) => void;
  onDelete: (record: ApplicationRecord) => void;
  /** Opens the "Prepare interview" drawer (issue #358). Optional: a caller that doesn't wire this
   * up simply doesn't get the row action, rather than every existing render site needing a new
   * required prop. */
  onPrepareInterview?: (record: ApplicationRecord) => void;
  /** Opens the linked attempt in the Review queue (#444). Without it the attempt state is shown but not linked. */
  onOpenAttempt?: (attemptId: string) => void;
  /** #692: the local follow-ups on each row (open actions and whether a prompt may be offered), and the
   * clock they are judged against. Shown beside the person's own Next step text, never in place of it. */
  followUps?: ReadonlyMap<string, OverviewItem>;
  nowMs?: number;
  onOpenFollowUps?: (record: ApplicationRecord) => void;
}

/** How a row linked to an attempt says it got where it is, with the source of a sent state kept visible. */
function attemptSourceNote(attempt: NonNullable<ApplicationRecord['attempt']>): string | null {
  if (attempt.checkpoint === 'submitted') return 'Receipt observed by this app';
  if (attempt.checkpoint === 'user_reported') return 'Reported by you';
  if (attempt.checkpoint === 'submission_unknown') return 'Not confirmed';
  return null;
}

function formatAppliedDate(iso: string | null): string | null {
  if (!iso) return null;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
}

/**
 * Pipeline table. Columns: role, company, location, sponsor check, status (inline `<select>`, no
 * drawer round-trip needed just to move a card), applied date, next step, contact, actions.
 */
export function ApplicationsTable({
  applications,
  onStatusChange,
  onEdit,
  onToggleArchive,
  onDelete,
  onPrepareInterview,
  onOpenAttempt,
  followUps,
  nowMs = Date.now(),
  onOpenFollowUps,
}: ApplicationsTableProps) {
  const viewerZone = systemZone();
  return (
    <div
      className="ovr-responsive-table overflow-x-auto"
      data-testid="applications-responsive-table"
    >
      <table className="table ovr-responsive-table__table">
        <thead>
          <tr>
            <th>Role</th>
            <th>Company</th>
            <th>Location</th>
            <th className="whitespace-normal">Sponsor check</th>
            <th>Status</th>
            <th>Applied</th>
            <th>Next step</th>
            <th>Contact</th>
            <th className="text-right">Actions</th>
          </tr>
        </thead>
        <tbody>
          {applications.map((application) => (
            <tr
              key={application.id}
              className={`ovr-row ${application.archived ? 'opacity-60' : ''}`}
            >
              <td className="ovr-responsive-table__cell font-semibold wrap-anywhere" data-label="Role">
                {application.role}
              </td>
              <td className="ovr-responsive-table__cell wrap-anywhere" data-label="Company">
                {application.company}
              </td>
              <td className="ovr-responsive-table__cell wrap-anywhere" data-label="Location">
                {application.location || <NotSet />}
              </td>
              <td className="ovr-responsive-table__cell wrap-anywhere" data-label="Sponsor check">
                {application.verification || <NotSet label="Not checked" />}
              </td>
              <td className="ovr-responsive-table__cell" data-label="Status">
                <select
                  aria-label={`Status for ${application.role} at ${application.company}`}
                  className={APPLICATION_STATUS_SELECT_CLASS[application.status]}
                  value={application.status}
                  onChange={(e) => onStatusChange(application, e.target.value as ApplicationStatus)}
                >
                  {APPLICATION_STATUS_ORDER.map((status) => (
                    <option key={status} value={status}>
                      {APPLICATION_STATUS_LABEL[status]}
                    </option>
                  ))}
                </select>
                {application.attempt && (
                  <div className="mt-1 flex flex-wrap items-center gap-1.5 text-xs">
                    <span className={`${ATTEMPT_CHECKPOINT_BADGE_CLASS[application.attempt.checkpoint]} badge-sm`}>
                      {ATTEMPT_CHECKPOINT_LABEL[application.attempt.checkpoint]}
                    </span>
                    {attemptSourceNote(application.attempt) && (
                      <span className="text-base-content/60">{attemptSourceNote(application.attempt)}</span>
                    )}
                    {onOpenAttempt && (
                      <button
                        type="button"
                        className="link"
                        onClick={() => onOpenAttempt(application.attempt!.attemptId)}
                        aria-label={`Open the review for ${application.role} at ${application.company}`}
                      >
                        Open review
                      </button>
                    )}
                  </div>
                )}
              </td>
              <td className="ovr-responsive-table__cell whitespace-nowrap" data-label="Applied">
                {formatAppliedDate(application.appliedAt) ?? <NotSet />}
              </td>
              <td className="ovr-responsive-table__cell wrap-anywhere" data-label="Next step">
                <div className="min-w-0">
                  {application.nextStep || <NotSet label="None" />}
                  {(() => {
                    const item = followUps?.get(application.id);
                    if (!item) return null;
                    const facts = item.openActions.map((action) => ({
                      id: action.id,
                      state: action.state,
                      dueKind: action.dueKind,
                      dueDate: action.dueDate,
                      dueLocal: action.dueLocal,
                      dueTimeZone: action.dueTimeZone,
                      dueAtMs: Date.parse(action.dueAt),
                    }));
                    const summary = summarizeOpenActions(facts, nowMs);
                    const line = actionSummaryLine(summary);
                    const next = item.openActions.find((action) => action.id === summary.next?.id);
                    if (!line || !next) {
                      return item.suggestion.eligible ? (
                        <p className="mt-1 text-xs text-base-content/70" data-testid="follow-up-summary">No follow-up planned.</p>
                      ) : null;
                    }
                    const state = dueStateOf(facts.find((fact) => fact.id === next.id)!, nowMs);
                    const due = describeDue({ ...facts.find((fact) => fact.id === next.id)!, dueUtcOffsetMinutes: next.dueUtcOffsetMinutes }, viewerZone);
                    return (
                      <p className="mt-1 text-xs" data-testid="follow-up-summary">
                        <span className={state === 'overdue' ? 'font-semibold text-error' : 'font-medium'}>Follow-ups: {line}.</span>{' '}
                        <span className="text-base-content/70">Next {state === 'overdue' ? 'was due' : 'due'} {due.primary}</span>
                      </p>
                    );
                  })()}
                  {onOpenFollowUps && (
                    <div className="mt-1">
                      <button
                        type="button"
                        className="btn btn-ghost btn-xs -ml-1.5 px-1.5"
                        onClick={() => onOpenFollowUps(application)}
                        aria-label={`Follow-ups for ${application.role} at ${application.company}`}
                      >
                        Follow-ups
                      </button>
                    </div>
                  )}
                </div>
              </td>
              <td className="ovr-responsive-table__cell wrap-anywhere" data-label="Contact">
                {application.contact || <NotSet label="None" />}
              </td>
              <td
                className="ovr-responsive-table__cell ovr-responsive-table__actions text-right"
                data-label="Actions"
              >
                {onPrepareInterview && INTERVIEW_PREPARABLE_STATUSES.has(application.status) && (
                  <button
                    type="button"
                    className="btn btn-ghost btn-sm px-1.5"
                    onClick={() => onPrepareInterview(application)}
                    aria-label={`Prepare interview for ${application.role} at ${application.company}`}
                  >
                    Prepare interview
                  </button>
                )}
                <button
                  type="button"
                  className="btn btn-ghost btn-sm px-1.5"
                  onClick={() => onEdit(application)}
                  aria-label={`Edit ${application.role} at ${application.company}`}
                >
                  Edit
                </button>
                <button
                  type="button"
                  className="btn btn-ghost btn-sm px-1.5"
                  onClick={() => onToggleArchive(application)}
                  aria-label={`${application.archived ? 'Restore' : 'Archive'} ${application.role} at ${application.company}`}
                >
                  {application.archived ? 'Restore' : 'Archive'}
                </button>
                <button
                  type="button"
                  className="btn btn-ghost btn-sm px-1.5 text-error"
                  onClick={() => onDelete(application)}
                  aria-label={`Delete ${application.role} at ${application.company}`}
                >
                  Delete
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
