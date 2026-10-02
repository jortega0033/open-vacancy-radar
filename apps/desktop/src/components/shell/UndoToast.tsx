import { useEffect, useState } from 'react';

export interface UndoToastProps {
  message: string;
  onUndo: () => void;
  onDismiss: () => void;
  /** ms before auto-dismiss. Defaults to the prototype's ~3.5s window. */
  durationMs?: number;
  /** Stacking class for the toast. The default sits above page content. A toast that has to stay
   * reachable over an open dialog passes a higher one. */
  layerClassName?: string;
}

/**
 * Shared "deleted, undo" affordance (`showToast(msg, undoFn)` in the prototype's
 * `export-src.html`): the delete already happened for real, but for a short window the user can
 * click "Undo" to re-create an equivalent row. Deliberately neutral/grayscale: a delete-undo
 * notice is a lifecycle notice, not a success/warning/error outcome, so per DESIGN-TOKENS.md it
 * does not get one of the three reserved hues. Auto-dismisses itself so a forgotten toast doesn't
 * linger forever; unmounting (e.g. because the page navigated away) also clears the timer. The timer
 * is held while the pointer or keyboard focus is on the toast and starts again once it leaves, so a
 * longer window is not lost to someone reading the message or reaching for Undo.
 */
export function UndoToast({ message, onUndo, onDismiss, durationMs = 3500, layerClassName = 'z-50' }: UndoToastProps) {
  const [held, setHeld] = useState(false);

  useEffect(() => {
    if (held) return;
    const timer = setTimeout(onDismiss, durationMs);
    return () => clearTimeout(timer);
  }, [onDismiss, durationMs, message, held]);

  return (
    <div className={`toast toast-end toast-bottom ${layerClassName}`}>
      <div
        className="alert flex items-center gap-3 shadow-lg"
        role="status"
        onMouseEnter={() => setHeld(true)}
        onMouseLeave={() => setHeld(false)}
        onFocus={() => setHeld(true)}
        onBlur={() => setHeld(false)}
      >
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
