import { useEffect } from 'react';

export interface UndoToastProps {
  message: string;
  onUndo: () => void;
  onDismiss: () => void;
  /** ms before auto-dismiss. Defaults to the prototype's ~3.5s window. */
  durationMs?: number;
}

/**
 * Shared "deleted, then undo" action (`showToast(msg, undoFn)` in the prototype's
 * `export-src.html`): the delete has completed, but for a short window the user can
 * click "Undo" to re-create an equivalent row. Deliberately neutral and grayscale. A delete-undo
 * notice is a lifecycle notice, not a success/warning/error outcome, so per DESIGN-TOKENS.md it
 * does not get one of the three reserved hues. Auto-dismisses itself so a forgotten toast doesn't
 * linger forever; unmounting (e.g. because the page navigated away) also clears the timer.
 */
export function UndoToast({ message, onUndo, onDismiss, durationMs = 3500 }: UndoToastProps) {
  useEffect(() => {
    const timer = setTimeout(onDismiss, durationMs);
    return () => clearTimeout(timer);
  }, [onDismiss, durationMs, message]);

  return (
    <div className="toast toast-end toast-bottom z-50">
      <div className="alert flex items-center gap-3 shadow-lg" role="status">
        <span className="text-sm">{message}</span>
        <button
          className="btn btn-ghost btn-xs"
          type="button"
          onClick={() => {
            onUndo();
            onDismiss();
          }}
        >
          Undo
        </button>
      </div>
    </div>
  );
}
