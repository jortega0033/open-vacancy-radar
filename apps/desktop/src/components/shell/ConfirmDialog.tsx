import type { ReactNode } from 'react';

export interface ConfirmDialogProps {
  title: string;
  message: ReactNode;
  confirmLabel?: string;
  onConfirm: () => void;
  onCancel: () => void;
}

/**
 * Shared destructive-confirmation modal, used by every page that deletes a record (saved jobs,
 * applications, CV library, letters). `alertdialog` is the correct ARIA role for a confirmation
 * that interrupts to demand an immediate decision, as opposed to the generic `dialog`.
 *
 * This is a plain `div`-based daisyUI modal (`modal modal-open`) rather than a native `<dialog>`
 * + `showModal()`: jsdom does not implement `HTMLDialogElement.showModal`, which would leave the
 * dialog permanently closed (and invisible to Testing Library's role queries) under `vitest`. The
 * parent only mounts this while a delete is pending, so there is no internal open/closed state to
 * track here.
 */
export function ConfirmDialog({ title, message, confirmLabel = 'Delete', onConfirm, onCancel }: ConfirmDialogProps) {
  return (
    <div className="modal modal-open" role="presentation">
      <div className="modal-box" role="alertdialog" aria-modal="true" aria-labelledby="confirm-dialog-title">
        <h3 id="confirm-dialog-title" className="text-base font-semibold">
          {title}
        </h3>
        <p className="mt-2 text-sm text-base-content/70">{message}</p>
        <div className="modal-action">
          <button className="btn btn-sm" type="button" onClick={onCancel}>
            Cancel
          </button>
          <button className="btn btn-error btn-sm" type="button" onClick={onConfirm}>
            {confirmLabel}
          </button>
        </div>
      </div>
      <button type="button" className="modal-backdrop" aria-label="Close" onClick={onCancel} />
    </div>
  );
}
