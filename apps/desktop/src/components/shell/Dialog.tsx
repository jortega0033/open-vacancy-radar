import { useLayoutEffect, useRef, type MouseEvent, type ReactNode, type RefObject } from 'react';
import { useEscapeToClose } from './useEscapeToClose';

export interface DialogProps {
  /** Closes the dialog: Escape, a click on the dimmed backdrop, and anything the caller wires up. */
  onClose: () => void;
  /** The dialog's accessible name, as an id of the heading inside it. Give this or `aria-label`. */
  'aria-labelledby'?: string;
  'aria-label'?: string;
  'aria-describedby'?: string;
  /** `alertdialog` for a confirmation that interrupts to demand a decision. */
  role?: 'dialog' | 'alertdialog';
  /** `end` and `start` dock the panel to that edge as a drawer; `center` is a modal. */
  placement?: 'center' | 'start' | 'end';
  /** True while closing would be unsafe (a request is in flight). Escape and backdrop clicks are
   * then ignored; the caller disables its own close buttons. */
  closeDisabled?: boolean;
  /** Backdrop clicks close the dialog unless this is false (a form with unsaved input, say). */
  dismissOnBackdrop?: boolean;
  /** Where focus returns if the element that opened the dialog is gone by then (a deleted row).
   * Defaults to the page's `main` region, which always exists. */
  returnFocusFallback?: RefObject<HTMLElement | null>;
  /** Classes for the panel inside the dialog (`modal-box`, width, padding). */
  boxClassName?: string;
  children: ReactNode;
}

/** What a person would start typing into. Checked in this order; destructive buttons are never
 * picked here, so a dialog that wants a button focused first marks it `data-autofocus`. */
const FIELD_SELECTOR =
  'input:not([type="hidden"]):not([type="checkbox"]):not([type="radio"]):not([disabled]), textarea:not([disabled]), select:not([disabled])';

function focusInitial(dialog: HTMLElement, box: HTMLElement | null): void {
  const marked = dialog.querySelector<HTMLElement>('[data-autofocus]');
  const target = marked ?? dialog.querySelector<HTMLElement>(FIELD_SELECTOR) ?? box ?? dialog;
  target.focus({ preventScroll: true });
}

/**
 * The one dialog and drawer primitive (#454). It is a native `<dialog>` opened with `showModal()`,
 * which is what makes the rest true without hand-rolled code: the background is inert, Tab cannot
 * leave the dialog, the dialog sits in the top layer above everything, and stacked dialogs close
 * topmost first.
 *
 * On open, focus goes to the element marked `data-autofocus` (the least destructive control, such
 * as Cancel), else the first field, else the panel. On close it returns to the element that opened
 * the dialog; if that element is gone (its row was deleted) it goes to a stable fallback instead of
 * into nothing. Escape runs through `useEscapeToClose`, so nested dialogs close one at a time and
 * `hasOpenOverlay` still knows one is up; the native `cancel` is suppressed because React owns
 * whether the dialog is mounted.
 *
 * Mount it only while it should be showing, as every overlay here already does.
 */
export function Dialog({
  onClose,
  role = 'dialog',
  placement = 'center',
  closeDisabled = false,
  dismissOnBackdrop = true,
  returnFocusFallback,
  boxClassName,
  children,
  ...labelling
}: DialogProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  useEscapeToClose(onClose, closeDisabled);

  useLayoutEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    if (!dialog.open) dialog.showModal();
    focusInitial(dialog, boxRef.current);

    return () => {
      if (dialog.open) dialog.close();
      // After the commit finishes, not during it: the control that opened this dialog may be removed
      // by the very change that closed it (a deleted row), and it is still in the document until then.
      queueMicrotask(() => {
        const fallback = returnFocusFallback?.current ?? document.querySelector<HTMLElement>('main');
        if (opener?.isConnected && opener !== document.body) {
          opener.focus({ preventScroll: true });
        } else if (fallback?.isConnected) {
          if (!fallback.hasAttribute('tabindex')) fallback.tabIndex = -1;
          fallback.focus({ preventScroll: true });
        }
      });
    };
    // Opening and closing are the lifecycle of the mount; the fallback ref is read at close time.
  }, [returnFocusFallback]);

  function handleBackdropClick(event: MouseEvent<HTMLDialogElement>) {
    // A click on the dimmed area lands on the dialog element itself; one inside the panel does not.
    if (event.target !== event.currentTarget) return;
    if (dismissOnBackdrop && !closeDisabled) onClose();
  }

  return (
    // The click is a pointer convenience for the dimmed area; its keyboard equivalent is Escape,
    // handled for the whole stack by `useEscapeToClose`, so the element needs no key listener.
    // eslint-disable-next-line jsx-a11y/click-events-have-key-events, jsx-a11y/no-noninteractive-element-interactions
    <dialog
      ref={dialogRef}
      role={role}
      aria-modal="true"
      {...labelling}
      className={`modal ${placement === 'end' ? 'modal-end' : placement === 'start' ? 'modal-start' : ''}`}
      onCancel={(event) => event.preventDefault()}
      onClick={handleBackdropClick}
    >
      <div ref={boxRef} tabIndex={-1} className={`modal-box outline-none ${boxClassName ?? ''}`}>
        {children}
      </div>
    </dialog>
  );
}
