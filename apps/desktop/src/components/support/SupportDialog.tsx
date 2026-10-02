import { useEffect, useRef } from 'react';
import { COFFEE_URL, REPOSITORY_URL } from '../../support-links.js';
import { useEscapeToClose } from '../shell/useEscapeToClose.js';

export interface SupportDialogProps {
  /** Star or Coffee was chosen: the ask is answered for good. */
  onAnswered: () => void;
  /** "Not now", Escape or a backdrop click. */
  onNotNow: () => void;
}

/**
 * The one-time "Support Open Vacancy Radar" ask (#503). Follows the ConfirmDialog conventions (a
 * plain daisyUI modal, Escape through `useEscapeToClose`, a backdrop button) but is a `dialog`, not
 * an `alertdialog`: nothing here is destructive and nothing is demanded.
 *
 * The two choices are plain `<a target="_blank" rel="noopener noreferrer">` anchors, so Electron
 * routes the click through the existing window-open handler. The click handler only records the
 * answer; it never prevents the navigation.
 *
 * Focus moves to "Not now" on open, the quiet default, and returns to where it was on close.
 */
export function SupportDialog({ onAnswered, onNotNow }: SupportDialogProps) {
  useEscapeToClose(onNotNow);
  const notNowRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    notNowRef.current?.focus();
    return () => {
      if (previous?.isConnected) previous.focus();
    };
  }, []);

  return (
    <div className="modal modal-open" role="presentation">
      <div
        className="modal-box"
        role="dialog"
        aria-modal="true"
        aria-labelledby="support-dialog-title"
        aria-describedby="support-dialog-body"
      >
        <h3 id="support-dialog-title" className="text-base font-semibold">
          Support Open Vacancy Radar
        </h3>
        <p id="support-dialog-body" className="mt-2 text-sm text-base-content/70">
          OVR is free, open source and made by one person. If it helped you apply, a star on GitHub or a coffee
          helps keep it going.
        </p>
        <div className="modal-action">
          <button ref={notNowRef} className="btn btn-sm" type="button" onClick={onNotNow}>
            Not now
          </button>
          <a
            className="btn btn-outline btn-sm"
            href={COFFEE_URL}
            target="_blank"
            rel="noopener noreferrer"
            onClick={onAnswered}
          >
            Buy me a coffee
          </a>
          <a
            className="btn btn-primary btn-sm"
            href={REPOSITORY_URL}
            target="_blank"
            rel="noopener noreferrer"
            onClick={onAnswered}
          >
            Star on GitHub
          </a>
        </div>
      </div>
      <button type="button" className="modal-backdrop" aria-label="Close" onClick={onNotNow} />
    </div>
  );
}
