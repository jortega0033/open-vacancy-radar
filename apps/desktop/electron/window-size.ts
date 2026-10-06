import type { Rectangle } from 'electron';

/**
 * Computes the default window bounds, used on first launch and whenever saved bounds are missing
 * or no longer fit a connected display.
 *
 * Targets about 80% of the work area, at least 1280x800 when the work area allows (the labeled
 * sidebar needs about 1100px), never larger than the work area, and centered inside it. The work
 * area may start away from (0,0) (taskbar on the left or top, a primary display not at the origin),
 * so the result is offset by `workArea.x` and `workArea.y`.
 *
 * @param workArea The display's work area (`screen.getPrimaryDisplay().workArea`)
 * @returns Window bounds { x, y, width, height } in screen coordinates
 */
export function computeInitialWindowBounds(workArea: Rectangle): Rectangle {
  const targetWidth = Math.max(1280, Math.round(workArea.width * 0.8));
  const targetHeight = Math.max(800, Math.round(workArea.height * 0.8));

  const width = Math.min(targetWidth, workArea.width);
  const height = Math.min(targetHeight, workArea.height);

  const x = workArea.x + Math.round((workArea.width - width) / 2);
  const y = workArea.y + Math.round((workArea.height - height) / 2);

  return { x, y, width, height };
}
