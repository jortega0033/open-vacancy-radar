import { useCallback, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react';
import { CaretLeft, CaretRight } from '@phosphor-icons/react';

/** Arrow keys move by this many pixels; with Shift held, by `LARGE_STEP_PX`. */
const STEP_PX = 16;
const LARGE_STEP_PX = 64;
/** A press that moves less than this is a click, not a drag. */
const DRAG_THRESHOLD_PX = 3;

export function clampWidth(value: number, min: number, max: number): number {
  return Math.round(Math.min(Math.max(value, min), Math.max(min, max)));
}

/**
 * A pane width the person chose, remembered in `localStorage` under one versioned key. `null` means
 * "never chosen" (or reset), so the caller's own responsive default keeps applying. Every storage
 * failure is non-fatal: the width simply is not remembered. `persist: false` updates the width
 * without writing storage, for the in-between steps of a drag.
 */
export function useStoredWidth(key: string): [number | null, (width: number | null, persist?: boolean) => void] {
  const [width, setWidthState] = useState<number | null>(() => {
    try {
      const stored = Number(window.localStorage.getItem(key));
      return Number.isFinite(stored) && stored > 0 ? stored : null;
    } catch {
      return null;
    }
  });
  const setWidth = useCallback(
    (next: number | null, persist = true) => {
      setWidthState(next);
      if (!persist) return;
      try {
        if (next === null) window.localStorage.removeItem(key);
        else window.localStorage.setItem(key, String(Math.round(next)));
      } catch {
        // Not remembered; the width still applies for this session.
      }
    },
    [key],
  );
  return [width, setWidth];
}

export interface ResizeHandleProps {
  /** Accessible name, e.g. "Resize results list". */
  label: string;
  /** The id of the pane whose width this controls. */
  controls: string;
  /** Current width of the controlled pane (the one to the handle's left), in pixels. */
  value: number;
  min: number;
  max: number;
  /** `final` is false for the steps of a drag in progress and true once a change is settled (key,
   * button, or the end of a drag), so callers can persist only settled widths. */
  onChange(width: number, final: boolean): void;
  /** Double-click goes back to the default width. */
  onReset(): void;
  /** Names for the pointer-only step buttons, e.g. "Narrower results list". */
  narrowerLabel: string;
  widerLabel: string;
}

/**
 * A vertical divider between two panes that sets the left pane's width.
 *
 * Dragging is never the only way (WCAG 2.5.7): the separator is focusable and takes Arrow keys
 * (Shift for larger steps), Home and End; double-click resets it; and two step buttons resize it
 * with a single click or tap. They show on hover, while the divider has focus, and always on a
 * coarse (touch) pointer, where they and the divider's hit area are also enlarged. The divider
 * occupies no layout width of its own, so it can never push the panes into horizontal overflow.
 */
export function ResizeHandle({
  label,
  controls,
  value,
  min,
  max,
  onChange,
  onReset,
  narrowerLabel,
  widerLabel,
}: ResizeHandleProps) {
  const drag = useRef<{ pointerId: number; startX: number; startValue: number; last: number; moved: boolean } | null>(null);
  const [dragging, setDragging] = useState(false);
  const set = (next: number) => {
    const clamped = clampWidth(next, min, max);
    if (clamped !== value) onChange(clamped, true);
  };

  function handleKeyDown(event: KeyboardEvent<HTMLDivElement>): void {
    const step = event.shiftKey ? LARGE_STEP_PX : STEP_PX;
    let next: number | null = null;
    if (event.key === 'ArrowLeft') next = value - step;
    else if (event.key === 'ArrowRight') next = value + step;
    else if (event.key === 'Home') next = min;
    else if (event.key === 'End') next = max;
    if (next === null) return;
    event.preventDefault();
    set(next);
  }

  function handlePointerDown(event: PointerEvent<HTMLDivElement>): void {
    if (event.button !== 0) return;
    event.preventDefault();
    event.currentTarget.focus({ preventScroll: true });
    event.currentTarget.setPointerCapture?.(event.pointerId);
    drag.current = { pointerId: event.pointerId, startX: event.clientX, startValue: value, last: value, moved: false };
    setDragging(true);
  }

  /** Ends the drag however it ends: release, cancel, lost capture, or a move with no button held. */
  function finishDrag(target: HTMLDivElement, pointerId: number): void {
    const current = drag.current;
    if (!current || current.pointerId !== pointerId) return;
    drag.current = null;
    setDragging(false);
    if (target.hasPointerCapture?.(pointerId)) target.releasePointerCapture(pointerId);
    // The steps of the drag were not persisted; the width it settled on is.
    if (current.moved) onChange(current.last, true);
  }

  function handlePointerMove(event: PointerEvent<HTMLDivElement>): void {
    const current = drag.current;
    if (!current || current.pointerId !== event.pointerId) return;
    // The release happened somewhere this element never heard about.
    if (event.buttons === 0) {
      finishDrag(event.currentTarget, event.pointerId);
      return;
    }
    const delta = event.clientX - current.startX;
    if (!current.moved && Math.abs(delta) < DRAG_THRESHOLD_PX) return;
    current.moved = true;
    const next = clampWidth(current.startValue + delta, min, max);
    if (next === current.last) return;
    current.last = next;
    onChange(next, false);
  }

  const endDrag = (event: PointerEvent<HTMLDivElement>) => finishDrag(event.currentTarget, event.pointerId);

  return (
    <div className="group relative z-20 w-0 flex-none">
      {/* eslint-disable jsx-a11y/no-noninteractive-element-interactions, jsx-a11y/no-noninteractive-tabindex -- A focusable separator is the WAI-ARIA Window Splitter widget. */}
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label={label}
        aria-controls={controls}
        aria-valuenow={value}
        aria-valuemin={min}
        aria-valuemax={Math.max(min, max)}
        aria-valuetext={`${value} pixels wide`}
        tabIndex={0}
        title={`${label}. Drag, use the arrow keys, or double-click to reset.`}
        onKeyDown={handleKeyDown}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onLostPointerCapture={endDrag}
        onDoubleClick={onReset}
        className={`absolute inset-y-0 -left-1 w-2 cursor-col-resize touch-none select-none outline-none after:absolute after:inset-y-0 after:left-[3px] after:w-0.5 after:transition-colors hover:after:bg-primary/40 focus-visible:after:bg-primary pointer-coarse:-left-3 pointer-coarse:w-6 pointer-coarse:after:left-[11px] ${
          dragging ? 'after:bg-primary' : ''
        }`}
      />
      {/* eslint-enable jsx-a11y/no-noninteractive-element-interactions, jsx-a11y/no-noninteractive-tabindex */}
      <div
        data-resize-steps=""
        className="pointer-events-none absolute top-1/2 left-0 flex -translate-x-1/2 -translate-y-1/2 flex-col gap-0.5 rounded-box border border-base-300 bg-base-100 p-0.5 opacity-0 shadow-sm transition-opacity group-hover:pointer-events-auto group-hover:opacity-100 group-focus-within:pointer-events-auto group-focus-within:opacity-100 pointer-coarse:pointer-events-auto pointer-coarse:opacity-100"
      >
        <button
          type="button"
          tabIndex={-1}
          className="btn btn-ghost btn-square btn-xs size-6 pointer-coarse:size-11"
          aria-label={narrowerLabel}
          disabled={value <= min}
          onClick={() => set(value - LARGE_STEP_PX)}
        >
          <CaretLeft size={12} aria-hidden="true" />
        </button>
        <button
          type="button"
          tabIndex={-1}
          className="btn btn-ghost btn-square btn-xs size-6 pointer-coarse:size-11"
          aria-label={widerLabel}
          disabled={value >= max}
          onClick={() => set(value + LARGE_STEP_PX)}
        >
          <CaretRight size={12} aria-hidden="true" />
        </button>
      </div>
    </div>
  );
}
