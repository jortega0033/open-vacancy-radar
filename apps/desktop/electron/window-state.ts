import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { Rectangle } from 'electron';
import { computeInitialWindowBounds } from './window-size.js';

export interface WindowState extends Rectangle {
  maximized?: boolean;
}

export const MIN_WINDOW_WIDTH = 760;
export const MIN_WINDOW_HEIGHT = 600;
/** Minimum overlap with a display work area (px, both axes) for saved bounds to count as visible. */
export const MIN_VISIBLE_OVERLAP = 120;

export const WINDOW_STATE_FILE = 'window-state.json';

export function windowStatePath(userDataDir: string): string {
  return join(userDataDir, WINDOW_STATE_FILE);
}

const isFiniteNumber = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/** Parses the saved JSON; returns null for anything missing, corrupt, or malformed. */
export function parseWindowState(raw: string | null | undefined): WindowState | null {
  if (!raw) return null;
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof data !== 'object' || data === null) return null;
  const { x, y, width, height, maximized } = data as Record<string, unknown>;
  if (!isFiniteNumber(x) || !isFiniteNumber(y) || !isFiniteNumber(width) || !isFiniteNumber(height)) {
    return null;
  }
  const state: WindowState = {
    x: Math.round(x),
    y: Math.round(y),
    width: Math.round(width),
    height: Math.round(height),
  };
  if (maximized === true) state.maximized = true;
  return state;
}

function overlap(a: Rectangle, b: Rectangle): { w: number; h: number } {
  const w = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
  const h = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
  return { w: Math.max(0, w), h: Math.max(0, h) };
}

/**
 * Returns the saved bounds when they are usable, otherwise null. Usable means: at least the
 * minimum window size, and visible on some connected display by at least MIN_VISIBLE_OVERLAP
 * pixels on both axes. Size larger than that display's work area is clamped to it.
 */
export function validateSavedBounds(saved: WindowState, workAreas: Rectangle[]): Rectangle | null {
  if (saved.width < MIN_WINDOW_WIDTH || saved.height < MIN_WINDOW_HEIGHT) return null;
  const rect: Rectangle = { x: saved.x, y: saved.y, width: saved.width, height: saved.height };
  let best: Rectangle | null = null;
  let bestArea = 0;
  for (const area of workAreas) {
    const o = overlap(rect, area);
    const needW = Math.min(MIN_VISIBLE_OVERLAP, area.width);
    const needH = Math.min(MIN_VISIBLE_OVERLAP, area.height);
    if (o.w < needW || o.h < needH) continue;
    if (o.w * o.h > bestArea) {
      bestArea = o.w * o.h;
      best = area;
    }
  }
  if (!best) return null;
  const width = Math.min(rect.width, best.width);
  const height = Math.min(rect.height, best.height);
  const x = Math.min(Math.max(rect.x, best.x), best.x + best.width - width);
  const y = Math.min(Math.max(rect.y, best.y), best.y + best.height - height);
  return { x, y, width, height };
}

/** Saved bounds when still valid for the connected displays, else the computed default. */
export function chooseInitialBounds(
  saved: WindowState | null,
  workAreas: Rectangle[],
  primaryWorkArea: Rectangle,
): WindowState {
  if (saved) {
    const valid = validateSavedBounds(saved, workAreas);
    if (valid) return saved.maximized ? { ...valid, maximized: true } : valid;
  }
  return computeInitialWindowBounds(primaryWorkArea);
}

export function loadWindowState(userDataDir: string): WindowState | null {
  try {
    return parseWindowState(readFileSync(windowStatePath(userDataDir), 'utf8'));
  } catch {
    return null;
  }
}

/** Atomic write (temp file then rename). Failures are swallowed: remembering is best effort. */
export function saveWindowState(userDataDir: string, state: WindowState): void {
  try {
    const target = windowStatePath(userDataDir);
    mkdirSync(dirname(target), { recursive: true });
    const tmp = `${target}.tmp`;
    writeFileSync(tmp, JSON.stringify(state), 'utf8');
    renameSync(tmp, target);
  } catch {
    // Remembering the window is best effort.
  }
}
