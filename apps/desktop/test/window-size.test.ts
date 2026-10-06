import { describe, it, expect } from 'vitest';
import { computeInitialWindowBounds } from '../electron/window-size.js';

const area = (width: number, height: number, x = 0, y = 0) => ({ x, y, width, height });

describe('computeInitialWindowBounds', () => {
  it('opens at 80% and centered on a 1920x1080 screen', () => {
    expect(computeInitialWindowBounds(area(1920, 1080))).toEqual({ x: 192, y: 108, width: 1536, height: 864 });
  });

  it('opens at 1280x768 on a 1366x768 laptop (height clamped to the work area)', () => {
    const b = computeInitialWindowBounds(area(1366, 768));
    expect(b).toEqual({ x: 43, y: 0, width: 1280, height: 768 });
  });

  it('uses the whole work area on a small 1024x700 screen', () => {
    expect(computeInitialWindowBounds(area(1024, 700))).toEqual({ x: 0, y: 0, width: 1024, height: 700 });
  });

  it('centers inside a work area with a non-zero origin', () => {
    // Taskbar on the left (48px) and top (30px).
    const b = computeInitialWindowBounds(area(1872, 1050, 48, 30));
    expect(b.width).toBe(1498);
    expect(b.height).toBe(840);
    expect(b.x).toBe(48 + Math.round((1872 - 1498) / 2));
    expect(b.y).toBe(30 + Math.round((1050 - 840) / 2));
  });

  it('supports a primary display at a negative origin', () => {
    const b = computeInitialWindowBounds(area(1920, 1040, -1920, 0));
    expect(b.x).toBeGreaterThanOrEqual(-1920);
    expect(b.x + b.width).toBeLessThanOrEqual(0);
  });

  it('is at least 1280x800 when the work area allows, never above the work area', () => {
    const b = computeInitialWindowBounds(area(1600, 900));
    expect(b.width).toBeGreaterThanOrEqual(1280);
    expect(b.height).toBeGreaterThanOrEqual(800);
    for (const [w, h, x, y] of [[1920, 1080, 0, 0], [1366, 768, 0, 0], [1024, 700, 0, 0], [800, 600, 100, 50]] as [number, number, number, number][]) {
      const r = computeInitialWindowBounds(area(w, h, x, y));
      expect(r.x).toBeGreaterThanOrEqual(x);
      expect(r.y).toBeGreaterThanOrEqual(y);
      expect(r.x + r.width).toBeLessThanOrEqual(x + w);
      expect(r.y + r.height).toBeLessThanOrEqual(y + h);
    }
  });
});
