import { describe, expect, it } from 'vitest';
import { isWindowInBackground, type BackgroundCheckWindow } from '../electron/app-background-state.js';

function fakeWindow(overrides: Partial<BackgroundCheckWindow> = {}): BackgroundCheckWindow {
  return {
    isDestroyed: () => false,
    isVisible: () => true,
    isMinimized: () => false,
    isFocused: () => true,
    ...overrides,
  };
}

describe('isWindowInBackground (issue #366)', () => {
  it('is false when the window is visible, not minimized, and focused', () => {
    expect(isWindowInBackground(fakeWindow())).toBe(false);
  });

  it('is true when there is no window at all', () => {
    expect(isWindowInBackground(undefined)).toBe(true);
  });

  it('is true for a destroyed window', () => {
    expect(isWindowInBackground(fakeWindow({ isDestroyed: () => true }))).toBe(true);
  });

  it('is true when hidden (closed to tray)', () => {
    expect(isWindowInBackground(fakeWindow({ isVisible: () => false }))).toBe(true);
  });

  it('is true when minimized', () => {
    expect(isWindowInBackground(fakeWindow({ isMinimized: () => true }))).toBe(true);
  });

  it('is true when visible but not the focused window', () => {
    expect(isWindowInBackground(fakeWindow({ isFocused: () => false }))).toBe(true);
  });
});
