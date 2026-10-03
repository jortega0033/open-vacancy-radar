import { useEffect, useRef } from 'react';

/**
 * Which mounted overlay Escape should close, tracked as a stack so a dialog opened from within an
 * already-open drawer (e.g. a delete confirmation raised from CvDrawer) only closes itself on
 * Escape, leaving the drawer underneath open -- see open-vacancy-radar#386.
 */
interface OverlayEntry {
  /** Always the newest `onClose` the overlay passed, so the entry itself never has to be replaced. */
  onClose: () => void;
  disabled: boolean;
}
/** Every mounted overlay in the order it mounted. The order is the nesting: it must not change when
 * an overlay re-renders, or an outer dialog that re-renders (because an inner one just opened) would
 * jump above the inner one and take its Escape. */
const closeStack: OverlayEntry[] = [];
/** Every mounted overlay, including ones whose Escape handling is currently `disabled`. */
let mountedOverlays = 0;
let listenerAttached = false;

function handleGlobalKeyDown(event: KeyboardEvent) {
  if (event.key !== 'Escape') return;
  // The topmost overlay that is allowed to close; a disabled one lets Escape fall through to beneath.
  for (let index = closeStack.length - 1; index >= 0; index -= 1) {
    const entry = closeStack[index]!;
    if (entry.disabled) continue;
    event.stopPropagation();
    entry.onClose();
    return;
  }
}

/**
 * Whether any overlay that uses `useEscapeToClose` is mounted right now, read-only. Counts an
 * overlay whose close is `disabled` too (a review dialog mid-submit is still on screen), so
 * "is something else open" never reads false while a request is running. Used by the Support
 * prompt (#503) to wait for a quiet moment.
 */
export function hasOpenOverlay(): boolean {
  return mountedOverlays > 0;
}

/**
 * Registers `onClose` to fire when Escape is pressed while this overlay is the topmost one
 * mounted. No overlay component in this codebase implemented this on its own (open-vacancy-radar
 * #386), so every modal/drawer/popover wires through this one hook instead of each re-solving
 * keyboard dismissal, stacking, and cleanup independently.
 *
 * `disabled` lets a caller refuse to close while a close would be unsafe (e.g.
 * `ApplicationReviewSession` mid-submit) without conditionally calling the hook, which React
 * forbids: while disabled, this overlay simply isn't pushed onto the stack, so Escape falls
 * through to whatever is beneath it (or does nothing, if nothing is).
 */
export function useEscapeToClose(onClose: () => void, disabled = false): void {
  const entryRef = useRef<OverlayEntry>({ onClose, disabled });
  entryRef.current.onClose = onClose;
  entryRef.current.disabled = disabled;
  useEffect(() => {
    mountedOverlays += 1;
    const entry = entryRef.current;
    if (!listenerAttached) {
      window.addEventListener('keydown', handleGlobalKeyDown);
      listenerAttached = true;
    }
    closeStack.push(entry);
    return () => {
      mountedOverlays -= 1;
      const index = closeStack.lastIndexOf(entry);
      if (index !== -1) closeStack.splice(index, 1);
      if (closeStack.length === 0 && listenerAttached) {
        window.removeEventListener('keydown', handleGlobalKeyDown);
        listenerAttached = false;
      }
    };
  }, []);
}
