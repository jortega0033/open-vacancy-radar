import type { SavedJobRecord } from '../../window.js';

export interface ConfirmDeleteDialogProps {
  job: SavedJobRecord;
  onConfirm: () => void;
  onCancel: () => void;
}

/**
 * Danger-styled confirm step for deleting a saved job, per the prototype
 * (`export-src.html` "Delete" row action).
 *
 * This is a plain `div`-based daisyUI modal (`modal modal-open`) rather than a native
 * `<dialog>` + `showModal()`: jsdom does not implement `HTMLDialogElement.showModal`, which would
 * leave the dialog permanently closed (and invisible to Testing Library's role queries) under
 * `vitest`. A `div[role="alertdialog"]` with `aria-modal` gets the same semantics without
 * depending on that browser API — only mounted while a delete is pending, same as before.
 */
export function ConfirmDeleteDialog({ job, onConfirm, onCancel }: ConfirmDeleteDialogProps) {
  return (
    <div className="modal modal-open" role="presentation">
      <div
        className="modal-box"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="confirm-delete-title"
      >
        <h3 id="confirm-delete-title" className="text-base font-semibold">
          Delete saved job?
        </h3>
        <p className="mt-2 text-sm text-base-content/70">
          This removes <span className="font-medium text-base-content">{job.role}</span> at{' '}
          <span className="font-medium text-base-content">{job.company}</span> from your saved jobs. You can undo
          this for a few seconds after deleting.
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
