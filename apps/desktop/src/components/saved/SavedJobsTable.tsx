import type { SavedJobRecord, SavedJobStatus } from '../../window.js';
import { SAVED_JOB_STATUSES, SAVED_JOB_STATUS_LABEL } from './saved-job-status.js';
import { NotSet } from '../shell/NotSet.js';

export interface SavedJobsTableProps {
  jobs: SavedJobRecord[];
  onEdit: (job: SavedJobRecord) => void;
  onDelete: (job: SavedJobRecord) => void;
  onStatusChange: (job: SavedJobRecord, status: SavedJobStatus) => void;
  /**
   * Starts the preparation pipeline for this job (#272): tailored documents, a filled form, and an
   * attempt waiting for review. Never a submission -- see `window.applicationPipeline`.
   */
  onPrepareApplication: (job: SavedJobRecord) => void;
  /** The job whose preparation request is currently in flight, if any. */
  preparingJobId: string | null;
}

function formatSavedAt(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleDateString();
}

/**
 * The Saved Jobs table, per the prototype's `savedCols`/`savedRows` (`export-src.html` lines
 * ~278-306), cut down to what a person scans: role, company, location, an inline status select,
 * the saved date and row actions. Salary, arrangement, sponsor check, match and notes live in the
 * edit drawer (#532).
 */
export function SavedJobsTable({
  jobs,
  onEdit,
  onDelete,
  onStatusChange,
  onPrepareApplication,
  preparingJobId,
}: SavedJobsTableProps) {
  return (
    <div className="saved-jobs-table-shell">
      <table className="table saved-jobs-table" aria-label="Saved jobs">
        <colgroup>
          <col className="saved-job-col-role" />
          <col className="saved-job-col-company" />
          <col className="saved-job-col-location" />
          <col className="saved-job-col-status" />
          <col className="saved-job-col-saved" />
          <col className="saved-job-col-actions" />
        </colgroup>
        <thead>
          <tr>
            <th scope="col">Role</th>
            <th scope="col">Company</th>
            <th scope="col">Location</th>
            <th scope="col">Status</th>
            <th scope="col">Saved</th>
            <th scope="col" className="text-right">
              Actions
            </th>
          </tr>
        </thead>
        <tbody>
          {jobs.map((job) => (
            <tr key={job.id} className="ovr-row hover:bg-base-200">
              <td data-label="Role" className="font-medium">
                {job.role}
              </td>
              <td data-label="Company" className="text-base-content/80">
                {job.company}
              </td>
              <td data-label="Location" className="text-base-content/70">
                {job.location || <NotSet />}
              </td>
              <td data-label="Status" className="saved-job-status-cell">
                <select
                  className="select select-sm"
                  aria-label={`Status for ${job.role} at ${job.company}`}
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
              <td data-label="Saved" className="text-base-content/60">
                {formatSavedAt(job.savedAt)}
              </td>
              <td data-label="Actions" className="saved-job-actions-cell text-right">
                <div className="saved-job-actions">
                  <button
                    className="btn btn-outline btn-sm px-1.5"
                    type="button"
                    disabled={preparingJobId !== null}
                    onClick={() => onPrepareApplication(job)}
                    aria-label={`Prepare application for ${job.role} at ${job.company}`}
                  >
                    {preparingJobId === job.id ? (
                      <span className="loading loading-spinner loading-xs" />
                    ) : (
                      'Prepare application'
                    )}
                  </button>
                  <button
                    className="btn btn-ghost btn-sm px-1.5"
                    type="button"
                    onClick={() => onEdit(job)}
                    aria-label={`Edit ${job.role} at ${job.company}`}
                  >
                    Edit
                  </button>
                  <button
                    className="btn btn-ghost btn-sm px-1.5 text-error"
                    type="button"
                    onClick={() => onDelete(job)}
                    aria-label={`Delete ${job.role} at ${job.company}`}
                  >
                    Delete
                  </button>
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
