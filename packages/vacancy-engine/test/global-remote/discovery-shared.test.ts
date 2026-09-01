import { describe, expect, it } from 'vitest';
import { isoPostedAt, isoPostedAtFromUnixSeconds } from '../../src/global-remote/discovery-shared.js';

describe('isoPostedAt', () => {
  it('returns null for a null input', () => {
    expect(isoPostedAt(null)).toBeNull();
  });

  it('passes through an already-UTC ISO string with milliseconds', () => {
    expect(isoPostedAt('2026-08-18T15:18:59.077Z')).toBe('2026-08-18T15:18:59.077Z');
  });

  it('passes through an ISO string with an explicit offset', () => {
    expect(isoPostedAt('2026-08-31T06:50:02+00:00')).toBe('2026-08-31T06:50:02.000Z');
  });

  it('parses an RFC 822 date (RSS pubDate) directly', () => {
    expect(isoPostedAt('Thu, 27 Aug 2026 14:36:09 GMT')).toBe('2026-08-27T14:36:09.000Z');
  });

  it('treats a date-only string as UTC midnight', () => {
    expect(isoPostedAt('2026-08-31')).toBe('2026-08-31T00:00:00.000Z');
  });

  it('pins an offset-less date-time string to UTC instead of the local machine timezone', () => {
    expect(isoPostedAt('2026-08-31T06:44:39')).toBe('2026-08-31T06:44:39.000Z');
  });

  it('returns null for an unparseable string rather than throwing', () => {
    expect(isoPostedAt('not-a-date')).toBeNull();
  });
});

describe('isoPostedAtFromUnixSeconds', () => {
  it('returns null for a null input', () => {
    expect(isoPostedAtFromUnixSeconds(null)).toBeNull();
  });

  it('converts unix seconds to an ISO string', () => {
    expect(isoPostedAtFromUnixSeconds(1788241217)).toBe('2026-09-01T05:40:17.000Z');
  });
});
