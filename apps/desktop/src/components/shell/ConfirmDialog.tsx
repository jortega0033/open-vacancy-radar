import { useId, useState, type ReactNode } from 'react';
import { Dialog } from './Dialog';

export interface ConfirmDialogProps {
  title: string;
  message: ReactNode;
  confirmLabel?: string;
  /** Label of the button that backs out. Defaults to "Cancel". */
  cancelLabel?: string;
  onConfirm: () => void;
  onCancel: () => void;
  /**
   * When set, the confirm button stays disabled until this exact text is typed, and the dialog does
   * not put focus on a button that could be pressed by accident. For deletions with no way back:
   * a single click or key press can never confirm one.
   */
  requireText?: string;
}

/**
 * Shared destructive-confirmation modal, used by every page that deletes a record (saved jobs,
 * applications, CV library, letters). `alertdialog` is the correct ARIA role for a confirmation
 * that interrupts to demand an immediate decision, as opposed to the generic `dialog`.
 *
 * Built on `Dialog`, so focus moves in on open, cannot leave, and returns to the trigger on close.
 * Focus lands on Cancel, never on the destructive button; when a typed confirmation is required it
 * lands on that field instead. The parent only mounts this while a delete is pending.
 */
export function ConfirmDialog({
  title,
  message,
  confirmLabel = 'Delete',
  cancelLabel = 'Cancel',
  onConfirm,
  onCancel,
  requireText,
}: ConfirmDialogProps) {
  const [typed, setTyped] = useState('');
  const inputId = useId();
  const titleId = useId();
  const confirmed = requireText === undefined || typed === requireText;
  return (
    <Dialog role="alertdialog" aria-labelledby={titleId} onClose={onCancel}>
      <h3 id={titleId} className="text-base font-semibold">
        {title}
      </h3>
      <div className="mt-2 text-sm text-base-content/70">{message}</div>
      {requireText !== undefined && (
        <div className="mt-3">
          <label htmlFor={inputId} className="block text-sm">
            Type <strong>{requireText}</strong> to confirm
          </label>
          <input
            id={inputId}
            data-autofocus=""
            aria-label={`Type ${requireText} to confirm`}
            className="input input-sm mt-1 w-full"
            value={typed}
            autoComplete="off"
            spellCheck={false}
            onChange={(event) => setTyped(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault();
                if (confirmed) onConfirm();
              }
            }}
          />
        </div>
      )}
      <div className="modal-action">
        <button className="btn btn-sm" type="button" onClick={onCancel} {...(requireText === undefined ? { 'data-autofocus': '' } : {})}>
          {cancelLabel}
        </button>
        <button className="btn btn-error btn-sm" type="button" disabled={!confirmed} onClick={onConfirm}>
          {confirmLabel}
        </button>
      </div>
    </Dialog>
  );
}
