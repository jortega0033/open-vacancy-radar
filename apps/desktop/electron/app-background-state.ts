/**
 * The subset of `BrowserWindow` the background/foreground check (issue #366) actually reads.
 * Typed narrowly, rather than as `BrowserWindow` itself, so the policy is testable with a plain
 * mock object instead of a real Electron window.
 */
export interface BackgroundCheckWindow {
  isDestroyed(): boolean;
  isVisible(): boolean;
  isMinimized(): boolean;
  isFocused(): boolean;
}

/**
 * Whether the user is not actively looking at the app right now: no window at all, the window is
 * hidden (closed to tray), minimized, or simply not the focused window. Scan notifications should
 * only fire in this state -- a user already watching the Search page as their own scan finishes
 * does not need an OS notification to tell them so.
 */
export function isWindowInBackground(win: BackgroundCheckWindow | undefined): boolean {
  if (!win || win.isDestroyed()) return true;
  return !win.isVisible() || win.isMinimized() || !win.isFocused();
}
