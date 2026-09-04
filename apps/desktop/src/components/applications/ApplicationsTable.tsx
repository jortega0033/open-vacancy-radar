import type { ApplicationRecord, ApplicationStatus } from '../../window.js';
import {
  APPLICATION_STATUS_LABEL,
  APPLICATION_STATUS_ORDER,
  APPLICATION_STATUS_SELECT_CLASS,
} from './application-status.js';

export interface ApplicationsTableProps {
  applications: readonly ApplicationRecord[];
  onStatusChange: (record: ApplicationRecord, status: ApplicationStatus) => void;
  onEdit: (record: ApplicationRecord) => void;
  onToggleArchive: (record: ApplicationRecord) => void;
  onDelete: (record: ApplicationRecord) => void;
}

function formatAppliedDate(iso: string | null): string {
  if (!iso) return '—';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
}

/**
 * Pipeline table. Columns: role, company, location, verification, status (inline `<select>`, no
 * drawer round-trip needed just to move a card), applied date, next step, contact, actions.
 */
export function ApplicationsTable({
  applications,
  onStatusChange,
  onEdit,
  onToggleArchive,
  onDelete,
}: ApplicationsTableProps) {
  return (
    <div className="overflow-x-auto">
      <table className="table">
        <thead>
          <tr>
            <th>Role</th>
            <th>Company</th>
            <th>Location</th>
            <th>Verification</th>
            <th>Status</th>
            <th>Applied</th>
            <th>Next step</th>
            <th>Contact</th>
            <th className="text-right">Actions</th>
          </tr>
        </thead>
        <tbody>
          {applications.map((application) => (
            <tr key={application.id} className={`ovr-row ${application.archived ? 'opacity-60' : ''}`}>
              <td className="font-semibold">{application.role}</td>
              <td>{application.company}</td>
              <td>{application.location || '—'}</td>
              <td>{application.verification || '—'}</td>
              <td>
                <select
                  aria-label="Application status"
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
              </td>
              <td className="whitespace-nowrap">{formatAppliedDate(application.appliedAt)}</td>
              <td>{application.nextStep || '—'}</td>
              <td>{application.contact || '—'}</td>
              <td className="text-right whitespace-nowrap">
                <button type="button" className="btn btn-ghost btn-xs" onClick={() => onEdit(application)}>
                  Edit
                </button>
                <button type="button" className="btn btn-ghost btn-xs" onClick={() => onToggleArchive(application)}>
                  {application.archived ? 'Restore' : 'Archive'}
                </button>
                <button
                  type="button"
                  className="btn btn-ghost btn-xs text-error"
                  onClick={() => onDelete(application)}
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
