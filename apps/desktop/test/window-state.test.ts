import { describe, it, expect } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  chooseInitialBounds,
  loadWindowState,
  parseWindowState,
  saveWindowState,
  validateSavedBounds,
  windowStatePath,
} from '../electron/window-state.js';

const area = (width: number, height: number, x = 0, y = 0) => ({ x, y, width, height });
const FHD = area(1920, 1040);

describe('parseWindowState', () => {
  it('parses valid JSON and keeps maximized only when true', () => {
    expect(parseWindowState('{"x":10,"y":20,"width":1300,"height":900,"maximized":true}')).toEqual({
      x: 10, y: 20, width: 1300, height: 900, maximized: true,
    });
    expect(parseWindowState('{"x":1,"y":2,"width":1300,"height":900,"maximized":"yes"}')).toEqual({
      x: 1, y: 2, width: 1300, height: 900,
    });
  });

  it('returns null for corrupt, missing, or malformed content', () => {
    expect(parseWindowState('{not json')).toBeNull();
    expect(parseWindowState('')).toBeNull();
    expect(parseWindowState(null)).toBeNull();
    expect(parseWindowState('42')).toBeNull();
    expect(parseWindowState('null')).toBeNull();
    expect(parseWindowState('{"x":1,"y":2,"width":"wide","height":900}')).toBeNull();
    expect(parseWindowState('{"x":1,"y":2,"width":1300}')).toBeNull();
  });
});

describe('validateSavedBounds', () => {
  it('keeps bounds fully on a 1920x1080 display', () => {
    const saved = { x: 100, y: 80, width: 1400, height: 900 };
    expect(validateSavedBounds(saved, [FHD])).toEqual(saved);
  });

  it('clamps a window larger than a 1366x768 laptop work area', () => {
    const b = validateSavedBounds({ x: 0, y: 0, width: 1600, height: 900 }, [area(1366, 728)]);
    expect(b).toEqual({ x: 0, y: 0, width: 1366, height: 728 });
  });

  it('clamps a saved size to a 1024x700 screen', () => {
    const b = validateSavedBounds({ x: 0, y: 0, width: 1100, height: 800 }, [area(1024, 700)]);
    expect(b).toEqual({ x: 0, y: 0, width: 1024, height: 700 });
  });

  it('works with a non-zero work area origin and pulls a slightly outside window inside', () => {
    const wa = area(1872, 1050, 48, 30);
    const b = validateSavedBounds({ x: 0, y: 0, width: 1200, height: 800 }, [wa]);
    expect(b).toEqual({ x: 48, y: 30, width: 1200, height: 800 });
  });

  it('rejects a window left off-screen after a monitor was removed', () => {
    const saved = { x: 2200, y: 100, width: 1300, height: 900 };
    expect(validateSavedBounds(saved, [FHD])).toBeNull();
  });

  it('rejects a window that only barely touches a display', () => {
    expect(validateSavedBounds({ x: 1900, y: 100, width: 1300, height: 900 }, [FHD])).toBeNull();
  });

  it('rejects a saved size smaller than the 760x600 minimum', () => {
    expect(validateSavedBounds({ x: 10, y: 10, width: 700, height: 900 }, [FHD])).toBeNull();
    expect(validateSavedBounds({ x: 10, y: 10, width: 900, height: 500 }, [FHD])).toBeNull();
  });
});

describe('chooseInitialBounds', () => {
  it('falls back to the computed default with no saved state', () => {
    expect(chooseInitialBounds(null, [FHD], FHD)).toEqual({ x: 192, y: 104, width: 1536, height: 832 });
  });

  it('falls back to the default when the saved window is off-screen', () => {
    const b = chooseInitialBounds({ x: 5000, y: 0, width: 1300, height: 900 }, [FHD], FHD);
    expect(b).toEqual({ x: 192, y: 104, width: 1536, height: 832 });
  });

  it('restores valid saved bounds and the maximized flag', () => {
    const saved = { x: 50, y: 60, width: 1300, height: 900, maximized: true };
    expect(chooseInitialBounds(saved, [FHD], FHD)).toEqual(saved);
  });
});

describe('load and save', () => {
  it('round-trips through the userData directory without leaving a temp file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ovr-ws-'));
    saveWindowState(dir, { x: 1, y: 2, width: 1300, height: 900, maximized: true });
    expect(loadWindowState(dir)).toEqual({ x: 1, y: 2, width: 1300, height: 900, maximized: true });
    expect(existsSync(`${windowStatePath(dir)}.tmp`)).toBe(false);
  });

  it('returns null for a missing or corrupt file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ovr-ws-'));
    expect(loadWindowState(dir)).toBeNull();
    writeFileSync(windowStatePath(dir), '{oops', 'utf8');
    expect(loadWindowState(dir)).toBeNull();
    expect(readFileSync(windowStatePath(dir), 'utf8')).toBe('{oops');
  });
});
