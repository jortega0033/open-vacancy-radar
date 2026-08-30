import type { SavedJobRecord, SavedJobStatus } from '../../window.js';
import { SAVED_JOB_STATUSES, SAVED_JOB_STATUS_LABEL } from './saved-job-status.js';

export interface SavedJobsTableProps {
  jobs: SavedJobRecord[];
  onEdit: (job: SavedJobRecord) => void;
  onDelete: (job: SavedJobRecord) => void;
  onStatusChange: (job: SavedJobRecord, status: SavedJobStatus) => void;
}

function formatSavedAt(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleDateString();
}

/**
 * The Saved Jobs table, per the prototype's `savedCols`/`savedRows` (`export-src.html` lines
 * ~278-306): role, company, location, verification, match, salary, saved date, an inline status
 * select, and row actions. Free-text fields (`salary`, `arrangement`, `verification`) render an
 * em dash when unset rather than an empty cell, so a reviewer can tell "not filled in" apart from
 * a rendering glitch.
 */
export function SavedJobsTable({ jobs, onEdit, onDelete, onStatusChange }: SavedJobsTableProps) {
  return (
    <div className="overflow-x-auto">
      <table className="table">
        <thead>
          <tr>
            <th>Role</th>
            <th>Company</th>
            <th>Location</th>
            <th>Salary</th>
            <th>Arrangement</th>
            <th>Verification</th>
            <th>Match</th>
            <th>Saved</th>
            <th>Notes</th>
            <th>Status</th>
            <th className="text-right">Actions</th>
          </tr>
        </thead>
        <tbody>
          {jobs.map((job) => (
            <tr key={job.id} className="ovr-row hover:bg-base-200">
              <td className="font-medium">{job.role}</td>
              <td className="text-base-content/80">{job.company}</td>
              <td className="whitespace-nowrap text-base-content/70">{job.location || '—'}</td>
              <td className="whitespace-nowrap text-base-content/70">{job.salary ?? '—'}</td>
              <td className="whitespace-nowrap text-base-content/70">{job.arrangement ?? '—'}</td>
              <td>
                {job.verification ? (
                  <span className="badge badge-outline whitespace-nowrap">{job.verification}</span>
                ) : (
                  <span className="text-base-content/50">Not verified</span>
                )}
              </td>
              <td className="font-mono">{job.matchPercent != null ? `${job.matchPercent}%` : '—'}</td>
              <td className="whitespace-nowrap text-base-content/60">{formatSavedAt(job.savedAt)}</td>
              <td>
                {job.notes.trim() !== '' ? (
                  <span className="badge badge-ghost badge-sm" title={job.notes}>
                    Notes
                  </span>
                ) : (
                  <span className="text-base-content/40">—</span>
                )}
              </td>
              <td>
                <select
                  className="select select-sm"
                  aria-label={`Status for ${job.role}`}
                  value={job.status}
                  onChange={(e) => onStatusChange(job, e.target.value as SavedJobStatus)}
                >
                  {SAVED_JOB_STATUSES.map((status) => (
                    <option key={status} value={status}>
                      {SAVED_JOB_STATUS_LABEL[status]}
                    </option>
                  ))}
                </select>
              </td>
              <td className="text-right whitespace-nowrap">
                <button className="btn btn-ghost btn-xs" type="button" onClick={() => onEdit(job)}>
                  Edit
                </button>
                <button
                  className="btn btn-ghost btn-xs text-error"
                  type="button"
                  onClick={() => onDelete(job)}
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
