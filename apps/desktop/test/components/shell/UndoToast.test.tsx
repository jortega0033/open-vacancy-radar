import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { UndoToast } from '../../../src/components/shell/index.js';

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('UndoToast', () => {
  it('stays up for about 8 seconds by default, then dismisses itself', () => {
    const onDismiss = vi.fn();
    render(<UndoToast message='Deleted "Synthetic role".' onUndo={vi.fn()} onDismiss={onDismiss} />);

    act(() => {
      vi.advanceTimersByTime(7_900);
    });
    expect(onDismiss).not.toHaveBeenCalled();

    act(() => {
      vi.advanceTimersByTime(200);
    });
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it('pauses while hovered and resumes with the time that was left', () => {
    const onDismiss = vi.fn();
    render(<UndoToast message="Deleted." onUndo={vi.fn()} onDismiss={onDismiss} durationMs={8_000} />);
    const toast = screen.getByRole('status');

    act(() => {
      vi.advanceTimersByTime(5_000);
    });
    fireEvent.mouseEnter(toast);
    act(() => {
      vi.advanceTimersByTime(60_000);
    });
    expect(onDismiss).not.toHaveBeenCalled();

    fireEvent.mouseLeave(toast);
    act(() => {
      vi.advanceTimersByTime(2_900);
    });
    expect(onDismiss).not.toHaveBeenCalled();
    act(() => {
      vi.advanceTimersByTime(200);
    });
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it('pauses while focus is inside and resumes once it leaves', () => {
    const onDismiss = vi.fn();
    render(<UndoToast message="Deleted." onUndo={vi.fn()} onDismiss={onDismiss} durationMs={8_000} />);
    const undo = screen.getByRole('button', { name: /^undo$/i });

    fireEvent.focus(undo);
    act(() => {
      vi.advanceTimersByTime(60_000);
    });
    expect(onDismiss).not.toHaveBeenCalled();

    fireEvent.blur(undo);
    act(() => {
      vi.advanceTimersByTime(8_100);
    });
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it('runs Undo and then dismisses', () => {
    const onUndo = vi.fn();
    const onDismiss = vi.fn();
    render(<UndoToast message="Deleted." onUndo={onUndo} onDismiss={onDismiss} />);

    fireEvent.click(screen.getByRole('button', { name: /^undo$/i }));

    expect(onUndo).toHaveBeenCalledTimes(1);
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });
});
