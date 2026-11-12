import { useState } from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { ResizeHandle, clampWidth, useStoredWidth } from '../../../src/components/shell/ResizeHandle.js';

// jsdom has no PointerEvent, so fireEvent.pointer* would drop `button`, `clientX` and `pointerId`.
// A MouseEvent carries the first two; this adds the pointer id.
beforeAll(() => {
  class TestPointerEvent extends MouseEvent {
    readonly pointerId: number;
    constructor(type: string, init: PointerEventInit = {}) {
      super(type, init);
      this.pointerId = init.pointerId ?? 1;
    }
  }
  vi.stubGlobal('PointerEvent', TestPointerEvent);
});
afterAll(() => {
  vi.unstubAllGlobals();
});

function Harness({ initial = 400, min = 300, max = 600, onReset }: { initial?: number; min?: number; max?: number; onReset?: () => void }) {
  const [width, setWidth] = useState(initial);
  return (
    <>
      <div id="pane" data-testid="pane" style={{ width }} />
      <ResizeHandle
        label="Resize pane"
        controls="pane"
        value={width}
        min={min}
        max={max}
        onChange={setWidth}
        onReset={() => {
          setWidth(initial);
          onReset?.();
        }}
        narrowerLabel="Narrower pane"
        widerLabel="Wider pane"
      />
    </>
  );
}

describe('ResizeHandle', () => {
  it('is a focusable vertical separator with its current, minimum and maximum values', () => {
    render(<Harness />);
    const handle = screen.getByRole('separator', { name: 'Resize pane' });
    expect(handle).toHaveAttribute('tabindex', '0');
    expect(handle).toHaveAttribute('aria-orientation', 'vertical');
    expect(handle).toHaveAttribute('aria-controls', 'pane');
    expect(handle).toHaveAttribute('aria-valuenow', '400');
    expect(handle).toHaveAttribute('aria-valuemin', '300');
    expect(handle).toHaveAttribute('aria-valuemax', '600');
  });

  it('resizes with the arrow keys, larger steps with Shift, and jumps with Home and End', () => {
    render(<Harness />);
    const handle = screen.getByRole('separator', { name: 'Resize pane' });
    fireEvent.keyDown(handle, { key: 'ArrowRight' });
    expect(handle).toHaveAttribute('aria-valuenow', '416');
    fireEvent.keyDown(handle, { key: 'ArrowLeft', shiftKey: true });
    expect(handle).toHaveAttribute('aria-valuenow', '352');
    fireEvent.keyDown(handle, { key: 'Home' });
    expect(handle).toHaveAttribute('aria-valuenow', '300');
    fireEvent.keyDown(handle, { key: 'ArrowLeft' });
    expect(handle).toHaveAttribute('aria-valuenow', '300');
    fireEvent.keyDown(handle, { key: 'End' });
    expect(handle).toHaveAttribute('aria-valuenow', '600');
    expect(screen.getByTestId('pane')).toHaveStyle({ width: '600px' });
  });

  it('follows a pointer drag and clamps it to the bounds', () => {
    render(<Harness />);
    const handle = screen.getByRole('separator', { name: 'Resize pane' });
    fireEvent.pointerDown(handle, { pointerId: 1, button: 0, buttons: 1, clientX: 500 });
    fireEvent.pointerMove(handle, { pointerId: 1, buttons: 1, clientX: 550 });
    expect(handle).toHaveAttribute('aria-valuenow', '450');
    fireEvent.pointerMove(handle, { pointerId: 1, buttons: 1, clientX: 2000 });
    expect(handle).toHaveAttribute('aria-valuenow', '600');
    fireEvent.pointerUp(handle, { pointerId: 1, clientX: 2000 });
    // After release, further movement does nothing.
    fireEvent.pointerMove(handle, { pointerId: 1, buttons: 1, clientX: 100 });
    expect(handle).toHaveAttribute('aria-valuenow', '600');
  });

  it('cannot get stuck dragging when the release is missed or capture is lost', () => {
    render(<Harness />);
    const handle = screen.getByRole('separator', { name: 'Resize pane' });
    fireEvent.pointerDown(handle, { pointerId: 1, button: 0, buttons: 1, clientX: 500 });
    fireEvent.pointerMove(handle, { pointerId: 1, buttons: 1, clientX: 540 });
    // A move with no button held means the release went elsewhere: the drag is over.
    fireEvent.pointerMove(handle, { pointerId: 1, buttons: 0, clientX: 580 });
    fireEvent.pointerMove(handle, { pointerId: 1, buttons: 1, clientX: 400 });
    expect(handle).toHaveAttribute('aria-valuenow', '440');

    fireEvent.pointerDown(handle, { pointerId: 2, button: 0, buttons: 1, clientX: 500 });
    fireEvent(handle, new PointerEvent('lostpointercapture', { bubbles: true, pointerId: 2 }));
    fireEvent.pointerMove(handle, { pointerId: 2, buttons: 1, clientX: 600 });
    expect(handle).toHaveAttribute('aria-valuenow', '440');
  });

  it('writes the remembered width once a drag ends, not on every move', () => {
    window.localStorage.removeItem('test.drag.v1');
    function StoredHarness() {
      const [width, setWidth] = useStoredWidth('test.drag.v1');
      return (
        <ResizeHandle
          label="Resize pane"
          controls="pane"
          value={width ?? 400}
          min={300}
          max={600}
          onChange={setWidth}
          onReset={() => setWidth(null)}
          narrowerLabel="Narrower pane"
          widerLabel="Wider pane"
        />
      );
    }
    render(<StoredHarness />);
    const handle = screen.getByRole('separator', { name: 'Resize pane' });
    fireEvent.pointerDown(handle, { pointerId: 1, button: 0, buttons: 1, clientX: 500 });
    fireEvent.pointerMove(handle, { pointerId: 1, buttons: 1, clientX: 520 });
    fireEvent.pointerMove(handle, { pointerId: 1, buttons: 1, clientX: 560 });
    expect(handle).toHaveAttribute('aria-valuenow', '460');
    expect(window.localStorage.getItem('test.drag.v1')).toBeNull();
    fireEvent.pointerUp(handle, { pointerId: 1, clientX: 560 });
    expect(window.localStorage.getItem('test.drag.v1')).toBe('460');
    // Keyboard changes are settled at once.
    fireEvent.keyDown(handle, { key: 'ArrowRight' });
    expect(window.localStorage.getItem('test.drag.v1')).toBe('476');
  });

  it('treats a press that barely moves as a click, not a drag', () => {
    render(<Harness />);
    const handle = screen.getByRole('separator', { name: 'Resize pane' });
    fireEvent.pointerDown(handle, { pointerId: 1, button: 0, buttons: 1, clientX: 500 });
    fireEvent.pointerMove(handle, { pointerId: 1, buttons: 1, clientX: 502 });
    fireEvent.pointerUp(handle, { pointerId: 1, clientX: 502 });
    expect(handle).toHaveAttribute('aria-valuenow', '400');
  });

  it('resets on double-click', () => {
    const onReset = vi.fn();
    render(<Harness onReset={onReset} />);
    const handle = screen.getByRole('separator', { name: 'Resize pane' });
    fireEvent.keyDown(handle, { key: 'End' });
    fireEvent.doubleClick(handle);
    expect(onReset).toHaveBeenCalledTimes(1);
    expect(handle).toHaveAttribute('aria-valuenow', '400');
  });

  it('reveals the step buttons on hover, while the divider has focus, and always on touch, with touch-sized targets', () => {
    render(<Harness />);
    const handle = screen.getByRole('separator', { name: 'Resize pane' });
    const steps = handle.parentElement!.querySelector('[data-resize-steps]')!;
    const wrapper = handle.parentElement!;
    // jsdom does not evaluate CSS, so this checks the reveal contract the classes encode: the
    // container is a `group` holding both the separator and the buttons, so focusing the separator
    // (focus-within) or hovering reveals them, and a coarse pointer always shows them.
    expect(wrapper).toHaveClass('group');
    expect(wrapper).toContainElement(steps as HTMLElement);
    for (const reveal of ['group-hover', 'group-focus-within', 'pointer-coarse']) {
      expect(steps).toHaveClass(`${reveal}:opacity-100`, `${reveal}:pointer-events-auto`);
    }
    for (const name of ['Narrower pane', 'Wider pane']) {
      // Exposed to assistive technology (never aria-hidden) and 44px on a coarse pointer.
      const button = screen.getByRole('button', { name });
      expect(button).toHaveClass('pointer-coarse:size-11');
      expect(button.closest('[aria-hidden="true"]')).toBeNull();
    }
    // The divider's own hit area also widens to 24px on a coarse pointer.
    expect(handle).toHaveClass('pointer-coarse:w-6');
    handle.focus();
    expect(wrapper).toContainElement(document.activeElement as HTMLElement);
  });

  it('offers single-click step buttons as an alternative to dragging, disabled at the bounds', () => {
    render(<Harness initial={300} />);
    const handle = screen.getByRole('separator', { name: 'Resize pane' });
    expect(screen.getByRole('button', { name: 'Narrower pane' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Wider pane' }));
    expect(handle).toHaveAttribute('aria-valuenow', '364');
    expect(screen.getByRole('button', { name: 'Narrower pane' })).toBeEnabled();
  });
});

describe('clampWidth', () => {
  it('clamps and rounds, and never returns less than the minimum when the maximum is smaller', () => {
    expect(clampWidth(250.4, 300, 600)).toBe(300);
    expect(clampWidth(450.6, 300, 600)).toBe(451);
    expect(clampWidth(900, 300, 600)).toBe(600);
    expect(clampWidth(900, 300, 200)).toBe(300);
  });
});

describe('useStoredWidth', () => {
  beforeEach(() => window.localStorage.removeItem('test.width.v1'));

  function Stored() {
    const [width, setWidth] = useStoredWidth('test.width.v1');
    return (
      <>
        <output>{width === null ? 'default' : width}</output>
        <button type="button" onClick={() => setWidth(321.7)}>Set</button>
        <button type="button" onClick={() => setWidth(null)}>Reset</button>
      </>
    );
  }

  it('reads, writes and clears one versioned key, ignoring unusable stored values', () => {
    window.localStorage.setItem('test.width.v1', 'not a number');
    const { unmount } = render(<Stored />);
    expect(screen.getByRole('status')).toHaveTextContent('default');
    fireEvent.click(screen.getByRole('button', { name: 'Set' }));
    expect(window.localStorage.getItem('test.width.v1')).toBe('322');
    unmount();

    render(<Stored />);
    expect(screen.getByRole('status')).toHaveTextContent('322');
    fireEvent.click(screen.getByRole('button', { name: 'Reset' }));
    expect(window.localStorage.getItem('test.width.v1')).toBeNull();
    expect(screen.getByRole('status')).toHaveTextContent('default');
  });
});
