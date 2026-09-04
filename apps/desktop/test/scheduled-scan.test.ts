import { describe, expect, it } from 'vitest';
import { shouldRunScheduledScan } from '../electron/scheduled-scan.js';

const INTERVAL_MS = 4 * 60 * 60 * 1000; // 4 hours, matches the ticket's suggested v1 interval.

describe('shouldRunScheduledScan', () => {
  it('returns true when no scan has ever completed', () => {
    expect(shouldRunScheduledScan(undefined, new Date('2026-01-01T12:00:00.000Z'), INTERVAL_MS)).toBe(true);
  });

  it('returns false when the last scan finished recently', () => {
    const lastGeneratedAt = '2026-01-01T10:00:00.000Z';
    const now = new Date('2026-01-01T11:00:00.000Z'); // 1 hour later, interval not yet up.
    expect(shouldRunScheduledScan(lastGeneratedAt, now, INTERVAL_MS)).toBe(false);
  });

  it('returns true once the interval has fully elapsed', () => {
    const lastGeneratedAt = '2026-01-01T06:00:00.000Z';
    const now = new Date('2026-01-01T11:00:00.000Z'); // 5 hours later, past the 4-hour interval.
    expect(shouldRunScheduledScan(lastGeneratedAt, now, INTERVAL_MS)).toBe(true);
  });

  it('returns true exactly at the interval boundary (>=, not >)', () => {
    const lastGeneratedAt = '2026-01-01T06:00:00.000Z';
    const now = new Date('2026-01-01T10:00:00.000Z'); // exactly 4 hours later.
    expect(shouldRunScheduledScan(lastGeneratedAt, now, INTERVAL_MS)).toBe(true);
  });

  it('returns true for an unparseable timestamp rather than throwing', () => {
    expect(shouldRunScheduledScan('not-a-date', new Date('2026-01-01T12:00:00.000Z'), INTERVAL_MS)).toBe(true);
  });
});
