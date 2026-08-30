import { describe, expect, it } from 'vitest';
import { ALL_COUNTRIES, normalizeCountry, UNSPECIFIED_LOCATION } from '../../../src/components/search/countries.js';

describe('normalizeCountry', () => {
  it('matches a full country name present in the location text', () => {
    expect(normalizeCountry('Amsterdam, Netherlands')).toBe('Netherlands');
    expect(normalizeCountry('Remote (Singapore)')).toBe('Singapore');
  });

  it('matches common aliases and abbreviations', () => {
    expect(normalizeCountry('Remote - US')).toBe('United States');
    expect(normalizeCountry('San Francisco, USA')).toBe('United States');
    expect(normalizeCountry('UK only')).toBe('United Kingdom');
    expect(normalizeCountry('Remote, UAE')).toBe('United Arab Emirates');
  });

  it('does not false-positive a country name inside an unrelated word', () => {
    expect(normalizeCountry('Irelandville Studio')).toBeNull();
    expect(normalizeCountry('Chadwick Industries')).toBeNull();
  });

  it('returns null for text with no confidently matched country, rather than guessing', () => {
    expect(normalizeCountry('Remote')).toBeNull();
    expect(normalizeCountry('')).toBeNull();
    expect(normalizeCountry(null)).toBeNull();
    expect(normalizeCountry(undefined)).toBeNull();
  });

  it('is case-insensitive', () => {
    expect(normalizeCountry('CANADA')).toBe('Canada');
    expect(normalizeCountry('australia')).toBe('Australia');
  });

  it('prefers the longer, more specific match over a shorter unrelated one', () => {
    expect(normalizeCountry('United Arab Emirates')).toBe('United Arab Emirates');
  });
});

describe('ALL_COUNTRIES', () => {
  it('is a complete, non-empty, deduplicated list', () => {
    expect(ALL_COUNTRIES.length).toBeGreaterThan(150);
    expect(new Set(ALL_COUNTRIES).size).toBe(ALL_COUNTRIES.length);
  });

  it('does not include the unspecified-location sentinel as a real country', () => {
    expect(ALL_COUNTRIES).not.toContain(UNSPECIFIED_LOCATION);
  });
});
