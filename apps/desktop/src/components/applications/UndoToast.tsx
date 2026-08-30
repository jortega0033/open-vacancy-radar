export interface UndoToastProps {
  message: string;
  /** Omitted when the action this toast reports on has nothing to undo. */
  onUndo?: () => void;
}

/**
 * Bottom-right toast (daisyUI `toast` + `alert`). Deliberately neutral/grayscale — "application
 * deleted" is a lifecycle notice, not a success/warning/error outcome, so per DESIGN-TOKENS.md it
 * does not get one of the three reserved hues.
 */
export function UndoToast({ message, onUndo }: UndoToastProps) {
  return (
    <div className="toast toast-end toast-bottom z-50">
      <div className="alert flex items-center gap-3 bg-neutral text-neutral-content" role="status">
        <span className="text-sm">{message}</span>
        {onUndo && (
          <button type="button" className="text-sm font-semibold underline" onClick={onUndo}>
            Undo
          </button>
        )}
      </div>
    </div>
  );
}
