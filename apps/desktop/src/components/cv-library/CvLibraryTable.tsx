import type { CvDocumentRecord } from '../../window.js';
import { CV_KIND_LABEL, cvParseStatus, formatCvDate, type ParseStatusTone } from './cv-profile.js';

export interface CvLibraryTableProps {
  documents: readonly CvDocumentRecord[];
  onEdit: (doc: CvDocumentRecord) => void;
  onSetDefault: (doc: CvDocumentRecord) => void;
  onDelete: (doc: CvDocumentRecord) => void;
}

const PARSE_STATUS_CLASS: Record<ParseStatusTone, string> = {
  success: 'text-success',
  warning: 'text-warning',
  neutral: 'text-base-content/60',
};

/**
 * The CV library table, per the prototype's `cvCols`/`cvRows` (`export-src.html` lines ~381-403):
 * name, kind, target role, updated date, parse status, a default marker/action, and row actions.
 * The name doubles as a "click to edit" affordance (per the prototype's `onRow`), in addition to
 * the explicit Edit action, matching the click-to-edit-reopens-the-drawer requirement without
 * removing the row-action convention `SavedJobsTable`/`ApplicationsTable` already use.
 */
export function CvLibraryTable({ documents, onEdit, onSetDefault, onDelete }: CvLibraryTableProps) {
  return (
    <div className="overflow-x-auto">
      <table className="table">
        <thead>
          <tr>
            <th>Name</th>
            <th>Kind</th>
            <th>Target role</th>
            <th>Uploaded</th>
            <th>Updated</th>
            <th>Parse status</th>
            <th>Default</th>
            <th className="text-right">Actions</th>
          </tr>
        </thead>
        <tbody>
          {documents.map((doc) => {
            const parseStatus = cvParseStatus(doc);
            return (
              <tr key={doc.id} className="ovr-row hover:bg-base-200">
                <td className="font-medium">
                  <button
                    type="button"
                    className="text-left hover:underline"
                    onClick={() => onEdit(doc)}
                    title="Edit parsed profile"
                  >
                    {doc.name}
                  </button>
                </td>
                <td>
                  <span className="badge badge-outline whitespace-nowrap">{CV_KIND_LABEL[doc.kind]}</span>
                </td>
                <td className="text-base-content/80">{doc.targetRole || '—'}</td>
                <td className="whitespace-nowrap text-base-content/60">{formatCvDate(doc.uploadedAt)}</td>
                <td className="whitespace-nowrap text-base-content/60">{formatCvDate(doc.updatedAt)}</td>
                <td className={`whitespace-nowrap text-sm ${PARSE_STATUS_CLASS[parseStatus.tone]}`}>
                  {parseStatus.label}
                </td>
                <td>
                  {doc.isDefault ? (
                    <span className="badge badge-primary whitespace-nowrap">Default</span>
                  ) : (
                    <button
                      className="btn btn-ghost btn-xs"
                      type="button"
                      onClick={() => onSetDefault(doc)}
                      title="Set as default CV"
                    >
                      Set as default
                    </button>
                  )}
                </td>
                <td className="text-right whitespace-nowrap">
                  <button className="btn btn-ghost btn-xs" type="button" onClick={() => onEdit(doc)}>
                    Edit
                  </button>
                  <button
                    className="btn btn-ghost btn-xs text-error"
                    type="button"
                    onClick={() => onDelete(doc)}
                  >
                    Delete
                  </button>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
