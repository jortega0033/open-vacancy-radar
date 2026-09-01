import type { DiscoveryVacancyAudit } from '@open-vacancy-radar/vacancy-engine';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_FILTERS,
  filterResults,
  countryOptions,
  isStalePosting,
  sortResults,
  worldwideVerification,
  WORLDWIDE_VERIFICATION,
  type SearchResult,
} from '../../../src/components/search/results.js';
import { UNSPECIFIED_LOCATION } from '../../../src/components/search/countries.js';

function discoveryVacancy(overrides: Partial<DiscoveryVacancyAudit> = {}): DiscoveryVacancyAudit {
  return {
    key: 'ww-1',
    provider: 'jobicy',
    company: 'Acme',
    title: 'Frontend Engineer',
    url: 'https://example.com/job',
    location: 'Amsterdam, Netherlands',
    employmentType: null,
    currency: null,
    salaryPeriod: null,
    advertisedMinimum: null,
    annualizedMinimumUsd: null,
    decision: 'official_review_candidate',
    reasons: [],
    contentHash: 'hash-ww-1',
    description: null,
    postedAt: null,
    profileScore: null,
    worldwideSponsorMatch: null,
    ...overrides,
  };
}

function worldwideResult(overrides: { key: string; location: string | null }): SearchResult {
  return {
    market: 'worldwide' as const,
    raw: {} as never,
    official: null,
    title: 'Frontend Engineer',
    company: 'Acme',
    url: 'https://example.com/job',
    provider: 'jobicy',
    arrangement: null,
    arrangementValue: 'unknown',
    employmentType: null,
    salary: null,
    postedAt: null,
    description: null,
    verification: { level: 'not_available', label: 'Not available for this market', tone: null, note: '' },
    profileScore: null,
    strongPoints: [],
    gaps: [],
    reasons: [],
    lead: { title: 'Frontend Engineer', company: 'Acme', location: 'Not stated', url: 'https://example.com/job' },
    ...overrides,
  };
}

describe('filterResults: country filter (worldwide only)', () => {
  it('applies no filter when country is "all", the default', () => {
    const results = [
      worldwideResult({ key: '1', location: 'Amsterdam, Netherlands' }),
      worldwideResult({ key: '2', location: 'Remote' }),
    ];
    expect(filterResults(results, DEFAULT_FILTERS)).toHaveLength(2);
  });

  it('keeps only rows whose location normalizes to the selected country', () => {
    const results = [
      worldwideResult({ key: '1', location: 'Amsterdam, Netherlands' }),
      worldwideResult({ key: '2', location: 'Austin, United States' }),
      worldwideResult({ key: '3', location: 'Singapore' }),
    ];
    const filtered = filterResults(results, { ...DEFAULT_FILTERS, country: 'United States' });
    expect(filtered.map((r) => r.key)).toEqual(['2']);
  });

  it('groups every unmatched location under the Unspecified location bucket', () => {
    const results = [
      worldwideResult({ key: '1', location: 'Remote' }),
      worldwideResult({ key: '2', location: null }),
      worldwideResult({ key: '3', location: 'Netherlands' }),
    ];
    const filtered = filterResults(results, { ...DEFAULT_FILTERS, country: UNSPECIFIED_LOCATION });
    expect(filtered.map((r) => r.key).sort()).toEqual(['1', '2']);
  });

  it('is not applied to Netherlands-market rows, even if a country filter value is set', () => {
    const nlResult: SearchResult = {
      market: 'netherlands',
      raw: {} as never,
      key: 'nl-1',
      title: 'Frontend Engineer',
      company: 'Acme NL',
      location: 'Remote',
      url: 'https://example.com/nl-job',
      provider: 'greenhouse',
      arrangement: null,
      arrangementValue: 'unknown',
      employmentType: null,
      salary: null,
      postedAt: null,
      description: null,
      verification: { level: 'not_available', label: '', tone: null, note: '' },
      profileScore: null,
      strongPoints: [],
      gaps: [],
      reasons: [],
      lead: { title: 'Frontend Engineer', company: 'Acme NL', location: 'Remote', url: 'https://example.com/nl-job' },
    };
    // A "United States" filter value would exclude this row if the country predicate applied to
    // Netherlands rows; supportedFilters(netherlands).country is false, so it must pass through.
    expect(filterResults([nlResult], { ...DEFAULT_FILTERS, country: 'United States' })).toHaveLength(1);
  });
});

describe('countryOptions', () => {
  it('includes every country plus the unspecified-location fallback', () => {
    const options = countryOptions();
    expect(options).toContain('Netherlands');
    expect(options).toContain('United States');
    expect(options[options.length - 1]).toBe(UNSPECIFIED_LOCATION);
  });
});

describe('isStalePosting', () => {
  const now = new Date('2026-09-01T00:00:00.000Z');

  it('is false for an unknown posting date -- absence is never treated as staleness', () => {
    expect(isStalePosting(null, now)).toBe(false);
  });

  it('is false for a posting within the last 30 days', () => {
    expect(isStalePosting('2026-08-15T00:00:00.000Z', now)).toBe(false);
  });

  it('is true for a posting older than 30 days', () => {
    expect(isStalePosting('2026-07-01T00:00:00.000Z', now)).toBe(true);
  });

  it('is false for an unparseable date rather than throwing', () => {
    expect(isStalePosting('not-a-date', now)).toBe(false);
  });
});

describe('sortResults', () => {
  function sortableResult(overrides: {
    key: string;
    profileScore?: number | null;
    postedAt?: string | null;
    title?: string;
  }): SearchResult {
    return {
      market: 'worldwide' as const,
      raw: {} as never,
      official: null,
      key: overrides.key,
      title: overrides.title ?? overrides.key,
      company: 'Acme',
      location: null,
      url: 'https://example.com/job',
      provider: 'jobicy',
      arrangement: null,
      arrangementValue: 'unknown',
      employmentType: null,
      salary: null,
      postedAt: overrides.postedAt ?? null,
      description: null,
      verification: { level: 'not_available', label: 'Not available for this market', tone: null, note: '' },
      profileScore: overrides.profileScore ?? null,
      strongPoints: [],
      gaps: [],
      reasons: [],
      lead: { title: overrides.title ?? overrides.key, company: 'Acme', location: 'Not stated', url: 'https://example.com/job' },
    };
  }

  it('sorts worldwide rows (no profile score) by most recently posted first', () => {
    const results = [
      sortableResult({ key: 'old', postedAt: '2026-08-01T00:00:00.000Z' }),
      sortableResult({ key: 'new', postedAt: '2026-08-20T00:00:00.000Z' }),
      sortableResult({ key: 'mid', postedAt: '2026-08-10T00:00:00.000Z' }),
    ];

    expect(sortResults(results).map((r) => r.key)).toEqual(['new', 'mid', 'old']);
  });

  it('sorts a row with an unknown posting date after every row with a known one', () => {
    const results = [
      sortableResult({ key: 'unknown', postedAt: null }),
      sortableResult({ key: 'known', postedAt: '2026-08-01T00:00:00.000Z' }),
    ];

    expect(sortResults(results).map((r) => r.key)).toEqual(['known', 'unknown']);
  });

  it('falls back to title order when neither row has a posting date', () => {
    const results = [
      sortableResult({ key: 'b', title: 'Backend Engineer' }),
      sortableResult({ key: 'a', title: 'Analyst' }),
    ];

    expect(sortResults(results).map((r) => r.key)).toEqual(['a', 'b']);
  });

  it('ranks a higher profile score first (Netherlands), ahead of posting date', () => {
    const results = [
      sortableResult({ key: 'low-score-newer', profileScore: 40, postedAt: '2026-08-20T00:00:00.000Z' }),
      sortableResult({ key: 'high-score-older', profileScore: 90, postedAt: '2026-08-01T00:00:00.000Z' }),
    ];

    expect(sortResults(results).map((r) => r.key)).toEqual(['high-score-older', 'low-score-newer']);
  });

  it('breaks a tied profile score by posting date', () => {
    const results = [
      sortableResult({ key: 'older', profileScore: 80, postedAt: '2026-08-01T00:00:00.000Z' }),
      sortableResult({ key: 'newer', profileScore: 80, postedAt: '2026-08-20T00:00:00.000Z' }),
    ];

    expect(sortResults(results).map((r) => r.key)).toEqual(['newer', 'older']);
  });
});

describe('worldwideVerification', () => {
  it('falls back to exactly WORLDWIDE_VERIFICATION when the engine found no sponsor match', () => {
    expect(worldwideVerification(discoveryVacancy({ worldwideSponsorMatch: null }))).toBe(
      WORLDWIDE_VERIFICATION,
    );
  });

  it('falls back to WORLDWIDE_VERIFICATION for every non-Netherlands-located row too', () => {
    // The engine never even attempts the lookup for these, but this function does not re-derive
    // that -- it trusts `worldwideSponsorMatch` alone, which is null for exactly this reason.
    expect(
      worldwideVerification(discoveryVacancy({ location: 'Remote (United States)', worldwideSponsorMatch: null })),
    ).toBe(WORLDWIDE_VERIFICATION);
  });

  it('reports a match as possible_sponsor_match, never recognised_sponsor, with a warning tone', () => {
    const verification = worldwideVerification(
      discoveryVacancy({
        worldwideSponsorMatch: { legalName: 'Acme Technologies B.V.', kvkNumber: '01234567' },
      }),
    );

    expect(verification.level).toBe('possible_sponsor_match');
    expect(verification.tone).toBe('warning');
    expect(verification.note).toContain('Acme Technologies B.V.');
    expect(verification.note).toContain('01234567');
  });
});
