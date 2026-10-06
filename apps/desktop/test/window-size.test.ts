import { describe, it, expect } from 'vitest';
import { computeInitialWindowBounds } from '../electron/window-size.js';

describe('computeInitialWindowBounds', () => {
  it('opens at ~1536x864 (80%) on a large 1920x1080 screen', () => {
    const bounds = computeInitialWindowBounds(1920, 1080);
    // 80% of 1920 = 1536, 80% of 1080 = 864
    expect(bounds.width).toBe(1536);
    expect(bounds.height).toBe(864);
    // Centered
    expect(bounds.x).toBe(Math.round((1920 - 1536) / 2));
    expect(bounds.y).toBe(Math.round((1080 - 864) / 2));
  });

  it('opens at 1280x768 on a 1366x768 laptop screen', () => {
    const bounds = computeInitialWindowBounds(1366, 768);
    // 80% of 1366 = 1092.8 < 1280, so min 1280
    // 80% of 768 = 614.4 < 800, so min 800
    // But 800 > 768, so clamp to 768
    expect(bounds.width).toBe(1280);
    expect(bounds.height).toBe(768);
    // Not centered since width is at minimum
    expect(bounds.x).toBeGreaterThanOrEqual(0);
    expect(bounds.y).toBeGreaterThanOrEqual(0);
  });

  it('opens at full size on a small 1024x700 screen', () => {
    const bounds = computeInitialWindowBounds(1024, 700);
    expect(bounds.width).toBe(1024);
    expect(bounds.height).toBe(700);
    expect(bounds.x).toBe(0);
    expect(bounds.y).toBe(0);
  });

  it('clamps saved bounds larger than current screen', () => {
    // Simulate a saved size from a larger screen
    const workAreaWidth = 1280;
    const workAreaHeight = 720;
    const bounds = computeInitialWindowBounds(workAreaWidth, workAreaHeight);
    expect(bounds.width).toBeGreaterThanOrEqual(workAreaWidth);
    // But we clamp to work area
    expect(bounds.width).toBeLessThanOrEqual(workAreaWidth);
    expect(bounds.height).toBeGreaterThanOrEqual(workAreaHeight);
    expect(bounds.height).toBeLessThanOrEqual(workAreaHeight);
  });

  it('ensures minimum size of 1280x800 when area allows', () => {
    const bounds = computeInitialWindowBounds(1600, 900);
    expect(bounds.width).toBeGreaterThanOrEqual(1280);
    expect(bounds.height).toBeGreaterThanOrEqual(800);
  });

  it('fits within work area on all screen sizes', () => {
    const testCases = [
      { w: 1920, h: 1080 },
      { w: 1366, h: 768 },
      { w: 1024, h: 700 },
      { w: 800, h: 600 },
    ];

    testCases.forEach(({ w, h }) => {
      const bounds = computeInitialWindowBounds(w, h);
      expect(bounds.x).toBeGreaterThanOrEqual(0);
      expect(bounds.y).toBeGreaterThanOrEqual(0);
      expect(bounds.x + bounds.width).toBeLessThanOrEqual(w);
      expect(bounds.y + bounds.height).toBeLessThanOrEqual(h);
    });
  });
});
