import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { UndoToast } from '../../../src/components/shell/index.js';

describe('UndoToast', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('dismisses itself after the requested duration, not before', () => {
    const onDismiss = vi.fn();
    render(<UndoToast message="Skipped a role." onUndo={vi.fn()} onDismiss={onDismiss} durationMs={10_000} />);

    act(() => {
      vi.advanceTimersByTime(9_999);
    });
    expect(onDismiss).not.toHaveBeenCalled();
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it('holds the timer while the pointer is on the toast and restarts it on leave', () => {
    const onDismiss = vi.fn();
    render(<UndoToast message="Skipped a role." onUndo={vi.fn()} onDismiss={onDismiss} durationMs={5_000} />);
    const toast = screen.getByRole('status');

    fireEvent.mouseEnter(toast);
    act(() => {
      vi.advanceTimersByTime(60_000);
    });
    expect(onDismiss).not.toHaveBeenCalled();

    fireEvent.mouseLeave(toast);
    act(() => {
      vi.advanceTimersByTime(5_000);
    });
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it('runs undo and then dismisses, and takes a custom stacking class', () => {
    const onUndo = vi.fn();
    const onDismiss = vi.fn();
    const { container } = render(
      <UndoToast message="Skipped a role." onUndo={onUndo} onDismiss={onDismiss} layerClassName="z-[1000]" />,
    );
    expect(container.firstElementChild?.className).toContain('z-[1000]');
    fireEvent.click(screen.getByRole('button', { name: 'Undo' }));
    expect(onUndo).toHaveBeenCalledTimes(1);
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });
});
