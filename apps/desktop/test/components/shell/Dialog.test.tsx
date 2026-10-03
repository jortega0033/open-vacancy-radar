import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { ConfirmDialog } from '../../../src/components/shell/ConfirmDialog.js';
import { Dialog } from '../../../src/components/shell/Dialog.js';
import { hasOpenOverlay } from '../../../src/components/shell/useEscapeToClose.js';

function Harness({ children, closeDisabled = false, onClosed }: { children?: React.ReactNode; closeDisabled?: boolean; onClosed?: () => void }) {
  const [open, setOpen] = useState(false);
  return (
    <main>
      <button type="button" onClick={() => setOpen(true)}>
        Open it
      </button>
      {open && (
        <Dialog
          aria-label="Example dialog"
          closeDisabled={closeDisabled}
          onClose={() => {
            setOpen(false);
            onClosed?.();
          }}
        >
          {children ?? (
            <>
              <input aria-label="First field" />
              <button type="button" data-autofocus="">
                Least destructive
              </button>
            </>
          )}
        </Dialog>
      )}
    </main>
  );
}

describe('Dialog (#454)', () => {
  it('is a modal dialog with a name, and puts focus inside it on open', () => {
    render(<Harness />);
    fireEvent.click(screen.getByRole('button', { name: 'Open it' }));

    const dialog = screen.getByRole('dialog', { name: 'Example dialog' });
    expect(dialog.tagName).toBe('DIALOG');
    expect(dialog).toHaveAttribute('open');
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    expect(dialog.contains(document.activeElement)).toBe(true);
  });

  it('focuses the element marked data-autofocus, else the first field, else the panel', () => {
    const { unmount } = render(<Harness />);
    fireEvent.click(screen.getByRole('button', { name: 'Open it' }));
    expect(screen.getByRole('button', { name: 'Least destructive' })).toHaveFocus();
    unmount();

    const second = render(
      <Harness>
        <input aria-label="Name" />
        <button type="button">Delete</button>
      </Harness>,
    );
    fireEvent.click(second.getByRole('button', { name: 'Open it' }));
    expect(second.getByRole('textbox', { name: 'Name' })).toHaveFocus();
    second.unmount();

    const third = render(
      <Harness>
        <button type="button">Delete</button>
      </Harness>,
    );
    fireEvent.click(third.getByRole('button', { name: 'Open it' }));
    // A destructive button is never picked automatically: focus goes to the panel itself.
    expect(third.getByRole('button', { name: 'Delete' })).not.toHaveFocus();
    expect(third.getByRole('dialog').contains(document.activeElement)).toBe(true);
  });

  it('returns focus to the control that opened it when it closes', async () => {
    render(<Harness />);
    const trigger = screen.getByRole('button', { name: 'Open it' });
    trigger.focus();
    fireEvent.click(trigger);
    expect(screen.getByRole('dialog')).toBeInTheDocument();

    fireEvent.keyDown(window, { key: 'Escape' });

    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(trigger).toHaveFocus();
  });

  it('falls back to the main region when the opener no longer exists, never into a removed row', async () => {
    function Row() {
      const [rows, setRows] = useState(['a']);
      const [open, setOpen] = useState(false);
      return (
        <main>
          {rows.map((row) => (
            <button key={row} type="button" onClick={() => setOpen(true)}>
              Row {row}
            </button>
          ))}
          {open && (
            <Dialog aria-label="Delete row?" onClose={() => setOpen(false)}>
              <button
                type="button"
                data-autofocus=""
                onClick={() => {
                  setRows([]);
                  setOpen(false);
                }}
              >
                Delete it
              </button>
            </Dialog>
          )}
        </main>
      );
    }
    render(<Row />);
    const rowButton = screen.getByRole('button', { name: 'Row a' });
    rowButton.focus();
    fireEvent.click(rowButton);
    fireEvent.click(await screen.findByRole('button', { name: 'Delete it' }));

    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(document.querySelector('main')).toHaveFocus();
  });

  it('closes on a click on the backdrop but not on a click inside the panel', () => {
    const onClosed = vi.fn();
    render(<Harness onClosed={onClosed} />);
    fireEvent.click(screen.getByRole('button', { name: 'Open it' }));
    const dialog = screen.getByRole('dialog');

    fireEvent.click(within(dialog).getByRole('textbox', { name: 'First field' }));
    expect(onClosed).not.toHaveBeenCalled();

    fireEvent.click(dialog);
    expect(onClosed).toHaveBeenCalledTimes(1);
  });

  it('ignores Escape and the backdrop while closing is disabled', () => {
    const onClosed = vi.fn();
    render(<Harness closeDisabled onClosed={onClosed} />);
    fireEvent.click(screen.getByRole('button', { name: 'Open it' }));

    fireEvent.keyDown(window, { key: 'Escape' });
    fireEvent.click(screen.getByRole('dialog'));
    expect(onClosed).not.toHaveBeenCalled();
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });

  it('does not let the native cancel close it behind React\'s back', () => {
    render(<Harness />);
    fireEvent.click(screen.getByRole('button', { name: 'Open it' }));
    const dialog = screen.getByRole('dialog');
    const cancel = new Event('cancel', { cancelable: true });
    dialog.dispatchEvent(cancel);
    expect(cancel.defaultPrevented).toBe(true);
    expect(dialog).toHaveAttribute('open');
  });

  it('closes nested dialogs one at a time, innermost first, restoring focus into the outer one', async () => {
    function Nested() {
      const [outer, setOuter] = useState(true);
      const [inner, setInner] = useState(false);
      return (
        <main>
          {outer && (
            <Dialog aria-label="Outer" onClose={() => setOuter(false)}>
              <button type="button" data-autofocus="" onClick={() => setInner(true)}>
                Open inner
              </button>
              {inner && (
                <Dialog aria-label="Inner" onClose={() => setInner(false)}>
                  <button type="button" data-autofocus="">
                    Inner cancel
                  </button>
                </Dialog>
              )}
            </Dialog>
          )}
        </main>
      );
    }
    render(<Nested />);
    const openInner = screen.getByRole('button', { name: 'Open inner' });
    openInner.focus();
    fireEvent.click(openInner);
    expect(await screen.findByRole('dialog', { name: 'Inner' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Inner cancel' })).toHaveFocus();

    fireEvent.keyDown(window, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Inner' })).not.toBeInTheDocument());
    expect(screen.getByRole('dialog', { name: 'Outer' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Open inner' })).toHaveFocus();

    fireEvent.keyDown(window, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });

  it('counts as an open overlay while mounted, and stops once closed', async () => {
    render(<Harness />);
    expect(hasOpenOverlay()).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: 'Open it' }));
    expect(hasOpenOverlay()).toBe(true);
    fireEvent.keyDown(window, { key: 'Escape' });
    await waitFor(() => expect(hasOpenOverlay()).toBe(false));
  });
});

describe('ConfirmDialog on Dialog (#454)', () => {
  it('announces as an alertdialog and starts on Cancel, never on the destructive button', () => {
    render(<ConfirmDialog title="Delete this CV?" message="It cannot be undone." onConfirm={vi.fn()} onCancel={vi.fn()} />);
    const dialog = screen.getByRole('alertdialog', { name: 'Delete this CV?' });
    expect(within(dialog).getByRole('button', { name: 'Cancel' })).toHaveFocus();
    expect(within(dialog).getByRole('button', { name: 'Delete' })).not.toHaveFocus();
  });

  it('starts on the typed-confirmation field when one is required', () => {
    render(
      <ConfirmDialog title="Delete my data?" message="No backup." confirmLabel="Delete my data" requireText="DELETE" onConfirm={vi.fn()} onCancel={vi.fn()} />,
    );
    expect(screen.getByRole('textbox', { name: /type delete to confirm/i })).toHaveFocus();
  });
});
