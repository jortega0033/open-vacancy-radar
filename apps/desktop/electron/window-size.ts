import type { Rectangle } from 'electron';

/**
 * Computes the initial window bounds for first launch or when no saved bounds exist.
 *
 * On first launch, opens at about 80% of the work area to show the labeled sidebar (which requires
 * at least 1100px width). On smaller screens, uses the entire work area. Later launches restore
 * the saved size (handled at the call site).
 *
 * @param workAreaWidth Work area width in pixels
 * @param workAreaHeight Work area height in pixels
 * @returns Window bounds { x, y, width, height }
 */
export function computeInitialWindowBounds(workAreaWidth: number, workAreaHeight: number): Rectangle {
  const targetWidth = Math.max(1280, Math.round(workAreaWidth * 0.8));
  const targetHeight = Math.max(800, Math.round(workAreaHeight * 0.8));

  // Clamp to work area
  const width = Math.min(targetWidth, workAreaWidth);
  const height = Math.min(targetHeight, workAreaHeight);

  // Center in work area
  const x = Math.round((workAreaWidth - width) / 2);
  const y = Math.round((workAreaHeight - height) / 2);

  return { x, y, width, height };
}
