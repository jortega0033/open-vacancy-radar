import type { ApplicationAttemptRecord } from '../../window.js';
import { ATTEMPT_CHECKPOINT_BADGE_CLASS, ATTEMPT_CHECKPOINT_LABEL } from './attempt-status.js';

export interface ApplicationAttemptsTableProps {
  attempts: readonly ApplicationAttemptRecord[];
  onOpen: (attempt: ApplicationAttemptRecord) => void;
}

function formatUpdatedDate(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
}

/**
 * Read-only pipeline table for in-progress application attempts (issue #202) -- no inline status
 * change, no edit, no delete: `checkpoint` is only ever advanced by the main-process generation
 * pipeline, and an attempt's existence is not something the renderer creates or removes. Clicking a
 * row is the one action, opening `ApplicationAttemptDrawer` for the full detail.
 */
export function ApplicationAttemptsTable({ attempts, onOpen }: ApplicationAttemptsTableProps) {
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
          {attempts.map((attempt) => (
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
                <span className={ATTEMPT_CHECKPOINT_BADGE_CLASS[attempt.checkpoint]}>
                  {ATTEMPT_CHECKPOINT_LABEL[attempt.checkpoint]}
                </span>
              </td>
              <td className="whitespace-nowrap text-base-content/60">{formatUpdatedDate(attempt.updatedAt)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
