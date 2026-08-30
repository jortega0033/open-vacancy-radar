import type { CvDocumentRecord } from '../../window.js';

export interface ConfirmDeleteCvDialogProps {
  cv: CvDocumentRecord;
  onConfirm: () => void;
  onCancel: () => void;
}

/**
 * Danger-styled confirm step for deleting a CV library entry, per the prototype's "Delete" row
 * action. Structurally the same `div`-based `alertdialog` as `saved/ConfirmDeleteDialog` (jsdom
 * doesn't implement `HTMLDialogElement.showModal`, so a plain `role="alertdialog"` div gets the
 * same semantics without depending on that browser API) — but the copy is deliberately blunter:
 * unlike a saved job or an application, a deleted CV is not offered an undo (see `CvLibraryPage`
 * for why), so the warning says "cannot be undone" instead of promising a few seconds to change
 * your mind.
 */
export function ConfirmDeleteCvDialog({ cv, onConfirm, onCancel }: ConfirmDeleteCvDialogProps) {
  return (
    <div className="modal modal-open" role="presentation">
      <div
        className="modal-box"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="confirm-delete-cv-title"
      >
        <h3 id="confirm-delete-cv-title" className="text-base font-semibold">
          Delete this CV?
        </h3>
        <p className="mt-2 text-sm text-base-content/70">
          This permanently removes <span className="font-medium text-base-content">{cv.name}</span> from your CV
          library, including any extracted text. This cannot be undone.
        </p>
        <div className="modal-action">
          <button className="btn btn-sm" type="button" onClick={onCancel}>
            Cancel
          </button>
          <button className="btn btn-error btn-sm" type="button" onClick={onConfirm}>
            Delete
          </button>
        </div>
      </div>
      <div className="modal-backdrop">
        <button type="button" aria-label="Cancel" onClick={onCancel}>
          close
        </button>
      </div>
    </div>
  );
}
