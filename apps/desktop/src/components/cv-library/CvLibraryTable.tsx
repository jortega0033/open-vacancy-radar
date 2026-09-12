import type { CvDocumentRecord, CvExportFormat } from '../../window.js';
import { CV_KIND_LABEL, cvParseStatus, formatCvDate, type ParseStatusTone } from './cv-profile.js';

export interface CvLibraryTableProps {
  documents: readonly CvDocumentRecord[];
  onEdit: (doc: CvDocumentRecord) => void;
  onSetDefault: (doc: CvDocumentRecord) => void;
  onDelete: (doc: CvDocumentRecord) => void;
  /** #156. */
  onExport: (doc: CvDocumentRecord, format: CvExportFormat) => void;
  /** The CV currently being exported, if any: disables that row's Export control and shows a
   * spinner in its place, the same "one export in flight at a time, per row" affordance
   * `LetterGenerator`'s own export dropdown uses. */
  exportingId: string | null;
  /** The CV whose export just finished successfully, if any -- cleared by the page after a short
   * delay, the same transient-feedback pattern `TailorCv`'s "Copied" uses. */
  exportedId: string | null;
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
export function CvLibraryTable({
  documents,
  onEdit,
  onSetDefault,
  onDelete,
  onExport,
  exportingId,
  exportedId,
}: CvLibraryTableProps) {
  return (
    <div className="ovr-responsive-table overflow-x-auto" data-testid="cv-responsive-table">
      <table className="table ovr-responsive-table__table">
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
                <td className="ovr-responsive-table__cell font-medium" data-label="Name">
                  <button
                    type="button"
                    className="text-left hover:underline"
                    onClick={() => onEdit(doc)}
                    title="Edit parsed profile"
                  >
                    {doc.name}
                  </button>
                </td>
                <td className="ovr-responsive-table__cell" data-label="Kind">
                  <span className="badge badge-outline whitespace-nowrap">
                    {CV_KIND_LABEL[doc.kind]}
                  </span>
                </td>
                <td
                  className="ovr-responsive-table__cell text-base-content/80"
                  data-label="Target role"
                >
                  {doc.targetRole || '—'}
                </td>
                <td
                  className="ovr-responsive-table__cell whitespace-nowrap text-base-content/60"
                  data-label="Uploaded"
                >
                  {formatCvDate(doc.uploadedAt)}
                </td>
                <td
                  className="ovr-responsive-table__cell whitespace-nowrap text-base-content/60"
                  data-label="Updated"
                >
                  {formatCvDate(doc.updatedAt)}
                </td>
                <td
                  className={`ovr-responsive-table__cell whitespace-nowrap text-sm ${PARSE_STATUS_CLASS[parseStatus.tone]}`}
                  data-label="Parse status"
                >
                  {parseStatus.label}
                </td>
                <td className="ovr-responsive-table__cell" data-label="Default">
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
                <td
                  className="ovr-responsive-table__cell ovr-responsive-table__actions text-right whitespace-nowrap"
                  data-label="Actions"
                >
                  {exportedId === doc.id && (
                    <span className="mr-2 text-xs text-success" role="status">
                      Exported
                    </span>
                  )}
                  <div className="dropdown dropdown-end inline-block">
                    <button
                      tabIndex={0}
                      className="btn btn-ghost btn-xs"
                      type="button"
                      disabled={exportingId === doc.id}
                    >
                      {exportingId === doc.id && (
                        <span className="loading loading-spinner loading-xs" aria-hidden="true" />
                      )}
                      Export
                    </button>
                    <ul
                      tabIndex={0}
                      className="dropdown-content menu bg-base-100 rounded-box z-10 w-40 border border-base-300 p-2 shadow"
                    >
                      <li>
                        {/* `blur()` on click: a daisyUI CSS-`:focus-within` dropdown otherwise stays
                            open indefinitely once a descendant (this button) holds focus, since
                            focus never leaves the wrapping `.dropdown` div on its own. Without this,
                            a second Export click on the same row is silently swallowed by the
                            still-open dropdown intercepting the click. */}
                        <button
                          type="button"
                          onClick={(e) => {
                            e.currentTarget.blur();
                            onExport(doc, 'pdf');
                          }}
                        >
                          PDF (.pdf)
                        </button>
                      </li>
                      <li>
                        <button
                          type="button"
                          onClick={(e) => {
                            e.currentTarget.blur();
                            onExport(doc, 'docx');
                          }}
                        >
                          Word (.docx)
                        </button>
                      </li>
                    </ul>
                  </div>
                  <button
                    className="btn btn-ghost btn-xs"
                    type="button"
                    onClick={() => onEdit(doc)}
                  >
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
