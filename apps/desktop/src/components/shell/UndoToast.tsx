import { useEffect, useRef, useState } from 'react';

export interface UndoToastProps {
  message: string;
  onUndo: () => void;
  onDismiss: () => void;
  /** ms before auto-dismiss. Defaults to 8 seconds. */
  durationMs?: number;
}

/** Long enough to read the notice and reach the Undo button, including with a keyboard. */
const DEFAULT_UNDO_MS = 8000;

/**
 * Shared "deleted, undo" affordance (`showToast(msg, undoFn)` in the prototype's
 * `export-src.html`): the delete already happened for real, but for a short window the user can
 * click "Undo" to re-create an equivalent row. Deliberately neutral/grayscale: a delete-undo
 * notice is a lifecycle notice, not a success/warning/error outcome, so per DESIGN-TOKENS.md it
 * does not get one of the three reserved hues. Auto-dismisses itself so a forgotten toast doesn't
 * linger forever; unmounting (e.g. because the page navigated away) also clears the timer.
 *
 * The countdown pauses while the pointer is over the toast or focus is inside it, and resumes with
 * whatever time was left rather than starting over.
 */
export function UndoToast({ message, onUndo, onDismiss, durationMs = DEFAULT_UNDO_MS }: UndoToastProps) {
  const [paused, setPaused] = useState(false);
  const remainingRef = useRef(durationMs);

  // A new message is a new toast, so it gets a full window again.
  useEffect(() => {
    remainingRef.current = durationMs;
  }, [message, durationMs]);

  useEffect(() => {
    if (paused) return;
    const startedAt = Date.now();
    const timer = setTimeout(onDismiss, remainingRef.current);
    return () => {
      clearTimeout(timer);
      remainingRef.current = Math.max(0, remainingRef.current - (Date.now() - startedAt));
    };
  }, [onDismiss, paused, message, durationMs]);

  return (
    <div className="toast toast-end toast-bottom z-50">
      <div
        className="alert flex items-center gap-3 shadow-lg"
        role="status"
        onMouseEnter={() => setPaused(true)}
        onMouseLeave={() => setPaused(false)}
        onFocus={() => setPaused(true)}
        onBlur={(event) => {
          if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setPaused(false);
        }}
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
