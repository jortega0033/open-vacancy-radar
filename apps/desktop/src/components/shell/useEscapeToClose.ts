import { useEffect } from 'react';

/**
 * Which mounted overlay Escape should close, tracked as a stack so a dialog opened from within an
 * already-open drawer (e.g. a delete confirmation raised from CvDrawer) only closes itself on
 * Escape, leaving the drawer underneath open -- see open-vacancy-radar#386.
 */
const closeStack: Array<() => void> = [];
let listenerAttached = false;

function handleGlobalKeyDown(event: KeyboardEvent) {
  if (event.key !== 'Escape') return;
  const topmost = closeStack[closeStack.length - 1];
  if (!topmost) return;
  event.stopPropagation();
  topmost();
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
  useEffect(() => {
    if (disabled) return;
    if (!listenerAttached) {
      window.addEventListener('keydown', handleGlobalKeyDown);
      listenerAttached = true;
    }
    closeStack.push(onClose);
    return () => {
      const index = closeStack.lastIndexOf(onClose);
      if (index !== -1) closeStack.splice(index, 1);
      if (closeStack.length === 0 && listenerAttached) {
        window.removeEventListener('keydown', handleGlobalKeyDown);
        listenerAttached = false;
      }
    };
  }, [onClose, disabled]);
}
