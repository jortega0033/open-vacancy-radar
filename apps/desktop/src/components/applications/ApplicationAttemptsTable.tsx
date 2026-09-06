import type { ApplicationAttemptRecord } from '../../window.js';
import { ATTEMPT_CHECKPOINT_BADGE_CLASS, ATTEMPT_CHECKPOINT_LABEL } from './attempt-status.js';

export interface ApplicationAttemptsTableProps {
  attempts: readonly ApplicationAttemptRecord[];
  onOpen: (attempt: ApplicationAttemptRecord) => void;
  /** Called for an attempt currently queued for automatic submission (issue #203's cancel/undo
   * window). Without a way to actually act on it, that window's safety guarantee -- a person has
   * real time to stop an unattended submit -- would exist in the backend but not be usable at all. */
  onCancelScheduledAutomaticSubmission: (attempt: ApplicationAttemptRecord) => void;
}

function formatUpdatedDate(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
}

function formatScheduledTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
}

/**
 * Read-only pipeline table for in-progress application attempts (issue #202) -- no inline status
 * change, no edit, no delete: `checkpoint` is only ever advanced by the main-process generation
 * pipeline, and an attempt's existence is not something the renderer creates or removes. Clicking a
 * row is the one action, opening `ApplicationAttemptDrawer` for the full detail.
 */
export function ApplicationAttemptsTable({ attempts, onOpen, onCancelScheduledAutomaticSubmission }: ApplicationAttemptsTableProps) {
  return (
    <div className="overflow-x-auto">
      <table className="table">
        <thead>
          <tr>
            <th>Role</th>
            <th>Company</th>
            <th>Status</th>
            <th>Updated</th>
          </tr>
        </thead>
        <tbody>
          {attempts.map((attempt) => {
            const scheduled = attempt.scheduledAutomaticSubmitAt;
            return (
              <tr
                key={attempt.id}
                className="ovr-row cursor-pointer"
                onClick={() => onOpen(attempt)}
                tabIndex={0}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') onOpen(attempt);
                }}
              >
                <td className="font-semibold">{attempt.role}</td>
                <td>{attempt.company}</td>
                <td>
                  {scheduled ? (
                    <div className="flex items-center gap-2">
                      <span className="badge badge-warning badge-soft">Submitting automatically at {formatScheduledTime(scheduled)}</span>
                      <button
                        type="button"
                        className="btn btn-outline btn-xs"
                        onClick={(e) => {
                          e.stopPropagation();
                          onCancelScheduledAutomaticSubmission(attempt);
                        }}
                      >
                        Cancel
                      </button>
                    </div>
                  ) : (
                    <span className={ATTEMPT_CHECKPOINT_BADGE_CLASS[attempt.checkpoint]}>
                      {ATTEMPT_CHECKPOINT_LABEL[attempt.checkpoint]}
                    </span>
                  )}
                </td>
                <td className="whitespace-nowrap text-base-content/60">{formatUpdatedDate(attempt.updatedAt)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
