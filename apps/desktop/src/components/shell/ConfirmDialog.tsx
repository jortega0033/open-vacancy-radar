import { useId, useState, type ReactNode } from 'react';
import { useEscapeToClose } from './useEscapeToClose';

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
 * This is a plain `div`-based daisyUI modal (`modal modal-open`) rather than a native `<dialog>`
 * + `showModal()`: jsdom does not implement `HTMLDialogElement.showModal`, which would leave the
 * dialog permanently closed (and invisible to Testing Library's role queries) under `vitest`. The
 * parent only mounts this while a delete is pending, so there is no internal open/closed state to
 * track here.
 */
export function ConfirmDialog({ title, message, confirmLabel = 'Delete',
  cancelLabel = 'Cancel',
  onConfirm,
  onCancel,
  requireText,
}: ConfirmDialogProps) {
  useEscapeToClose(onCancel);
  const [typed, setTyped] = useState('');
  const inputId = useId();
  const confirmed = requireText === undefined || typed === requireText;
  return (
    <div className="modal modal-open" role="presentation">
      <div className="modal-box" role="alertdialog" aria-modal="true" aria-labelledby="confirm-dialog-title">
        <h3 id="confirm-dialog-title" className="text-base font-semibold">
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
              aria-label={`Type ${requireText} to confirm`}
              className="input input-sm mt-1 w-full"
              value={typed}
              autoComplete="off"
              spellCheck={false}
              // eslint-disable-next-line jsx-a11y/no-autofocus -- the field is the first thing the dialog asks for
              autoFocus
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
          <button className="btn btn-sm" type="button" onClick={onCancel}>
            {cancelLabel}
          </button>
          <button className="btn btn-error btn-sm" type="button" disabled={!confirmed} onClick={onConfirm}>
            {confirmLabel}
          </button>
        </div>
      </div>
      <button type="button" className="modal-backdrop" aria-label="Close" onClick={onCancel} />
    </div>
  );
}
