import type { DiscoveryVacancyAudit } from '@open-vacancy-radar/vacancy-engine';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_FILTERS,
  buildSearchResultIndex,
  descriptionExcerpt,
  filterSearchResultIndex,
  filterResults,
  salaryCounts,
  countryOptions,
  formatDiscoverySalary,
  isStalePosting,
  sortSearchResultIndex,
  sortResults,
  toPartialResults,
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
    raw: { worldwideSponsorMatch: null } as never,
    official: null,
    provisional: false,
    key: overrides.key,
    title: 'Frontend Engineer',
    company: 'Acme',
    location: overrides.location,
    url: 'https://example.com/job',
    provider: 'jobicy',
    employmentType: null,
    salary: null,
    postedAt: null,
    description: null,
    verification: { level: 'not_available', label: 'Not available for this vacancy', tone: null, note: '' },
    profileScore: null,
    strongPoints: [],
    gaps: [],
    reasons: [],
    lead: { title: 'Frontend Engineer', company: 'Acme', location: 'Not stated', url: 'https://example.com/job' },
  };
}

describe('toPartialResults (issue #252)', () => {
  it('converts a discovery row to a row with no official cross-reference and an honest "not available" verification', () => {
    const [result] = toPartialResults([discoveryVacancy({ key: 'streamed-1', title: 'Streamed Role' })]);

    expect(result).toMatchObject({ key: 'streamed-1', title: 'Streamed Role', official: null });
    expect(result!.verification).toEqual(WORLDWIDE_VERIFICATION);
  });

  it('never invents a profile score or sponsor match for a row that has not been enriched yet', () => {
    const [result] = toPartialResults([
      discoveryVacancy({ profileScore: null, worldwideSponsorMatch: null }),
    ]);

    expect(result!.profileScore).toBeNull();
    expect(result!.raw.worldwideSponsorMatch).toBeNull();
  });

  it('produces one row per input vacancy, in the given order, unlike toWorldwideResults it never needs a report to run against', () => {
    const results = toPartialResults([
      discoveryVacancy({ key: 'a', title: 'Role A' }),
      discoveryVacancy({ key: 'b', title: 'Role B' }),
    ]);

    expect(results.map((r) => r.key)).toEqual(['a', 'b']);
  });
});

describe('filterResults: country filter', () => {
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

  it('matches every country retained after same-vacancy deduplication', () => {
    const result = worldwideResult({ key: 'multi-country', location: 'Remote' });
    result.raw = discoveryVacancy({ location: 'Remote', locations: ['Remote', 'Netherlands', 'Germany'] });
    expect(filterResults([result], { ...DEFAULT_FILTERS, country: 'Netherlands' }).map((item) => item.key)).toEqual(['multi-country']);
    expect(filterResults([result], { ...DEFAULT_FILTERS, country: 'Germany' }).map((item) => item.key)).toEqual(['multi-country']);
  });

  it('matches an employment filter against every retained duplicate employment type', () => {
    const result = worldwideResult({ key: 'merged-employment', location: 'Worldwide' });
    result.employmentType = 'contract';
    result.raw = discoveryVacancy({ employmentType: 'contract', employmentTypes: ['contract', 'full_time'] });
    expect(filterResults([result], { ...DEFAULT_FILTERS, employment: 'full_time' }).map((item) => item.key)).toEqual(['merged-employment']);
  });
});

describe('filterResults: role search', () => {
  it('matches a searchable description when the title does not contain the typed role', () => {
    const result = worldwideResult({ key: 'description-role', location: 'Netherlands' });
    result.description = 'Build accessible TypeScript interfaces.';
    expect(filterResults([result], { ...DEFAULT_FILTERS, query: 'typescript' }).map((item) => item.key)).toEqual(['description-role']);
  });
});

describe('filterResults: sponsorOnly', () => {
  it('keeps only rows with a resolved worldwideSponsorMatch', () => {
    const matched = worldwideResult({ key: '1', location: 'Amsterdam, Netherlands' });
    matched.raw = discoveryVacancy({
      key: '1',
      worldwideSponsorMatch: { legalName: 'Acme Technologies B.V.', kvkNumber: '01234567' },
    });
    const unmatched = worldwideResult({ key: '2', location: 'Amsterdam, Netherlands' });

    const filtered = filterResults([matched, unmatched], { ...DEFAULT_FILTERS, sponsorOnly: true });
    expect(filtered.map((r) => r.key)).toEqual(['1']);
  });
});

describe('filterResults: salary floor', () => {
  it('keeps comparable rows at or above the floor and includes unknown rows by default', () => {
    const atFloor = worldwideResult({ key: 'at-floor', location: 'Amsterdam, Netherlands' });
    atFloor.raw = discoveryVacancy({ normalizedAnnualMinimum: 60_000, normalizedCurrency: 'EUR', salaryProvenance: 'reviewed_structured' });
    const below = worldwideResult({ key: 'below', location: 'Amsterdam, Netherlands' });
    below.raw = discoveryVacancy({ normalizedAnnualMinimum: 59_999, normalizedCurrency: 'EUR', salaryProvenance: 'reviewed_structured' });
    const unknown = worldwideResult({ key: 'unknown', location: 'Amsterdam, Netherlands' });
    unknown.raw = discoveryVacancy({ salaryPeriod: 'weekly' });
    const filters = { ...DEFAULT_FILTERS, salaryMinimum: '60000' };

    expect(filterResults([atFloor, below, unknown], filters).map((result) => result.key)).toEqual([
      'at-floor',
      'unknown',
    ]);
    expect(salaryCounts([atFloor, below, unknown], filters)).toEqual({ comparable: 2, unknown: 1 });
    expect(
      filterResults([atFloor, below, unknown], { ...filters, includeUnknownSalary: false }).map(
        (result) => result.key,
      ),
    ).toEqual(['at-floor']);
  });

  it('does not compare a raw USD value as EUR', () => {
    const usd = worldwideResult({ key: 'usd', location: 'Remote' });
    usd.raw = discoveryVacancy({ normalizedAnnualMinimum: 100_000, normalizedCurrency: 'USD', salaryProvenance: 'reviewed_structured' });
    expect(filterResults([usd], { ...DEFAULT_FILTERS, salaryMinimum: '60000' })).toEqual([usd]);
    expect(salaryCounts([usd], { ...DEFAULT_FILTERS, salaryMinimum: '60000' })).toEqual({
      comparable: 0,
      unknown: 1,
    });
  });
});

describe('large report filtering index', () => {
  it('keeps indexed filtering and sorting behavior identical to the legacy helpers', () => {
    const now = new Date('2026-09-01T00:00:00.000Z');
    const results = [
      {
        ...worldwideResult({ key: '1', location: 'Amsterdam, Netherlands' }),
        title: 'Frontend Engineer',
        company: 'Acme',
        provider: 'jobicy',
        employmentType: 'full_time',
        postedAt: '2026-08-31T00:00:00.000Z',
        profileScore: 70,
      },
      {
        ...worldwideResult({ key: '2', location: 'Austin, United States' }),
        title: 'Backend Engineer',
        company: 'Beta',
        provider: 'remotive',
        employmentType: 'contract',
        postedAt: '2026-07-01T00:00:00.000Z',
        profileScore: 90,
      },
      {
        ...worldwideResult({ key: '3', location: 'Rotterdam, Netherlands' }),
        title: 'Frontend Lead',
        company: 'Gamma',
        provider: 'jobicy',
        employmentType: 'full_time',
        postedAt: null,
        profileScore: 80,
      },
    ] satisfies SearchResult[];
    const filters = {
      ...DEFAULT_FILTERS,
      query: 'frontend',
      source: 'jobicy',
      country: 'Netherlands',
      employment: 'full_time',
      postedWithin: '30',
    } as const;

    const legacy = sortResults(filterResults(results, filters, now)).map((result) => result.key);
    const indexed = sortSearchResultIndex(filterSearchResultIndex(buildSearchResultIndex(results), filters, now)).map(
      (result) => result.key,
    );

    expect(indexed).toEqual(legacy);
  });

  it('filters and sorts a 20k-row saved report inside the documented interaction budget', () => {
    const now = new Date('2026-09-01T00:00:00.000Z');
    const results = Array.from({ length: 20_000 }, (_unused, index) => ({
      ...worldwideResult({
        key: `job-${index}`,
        location: index % 4 === 0 ? 'Amsterdam, Netherlands' : 'Austin, United States',
      }),
      title: index % 2 === 0 ? 'Frontend Engineer' : 'Backend Engineer',
      company: `Company ${index}`,
      provider: index % 3 === 0 ? 'jobicy' : 'remotive',
      employmentType: index % 5 === 0 ? 'contract' : 'full_time',
      postedAt: index % 7 === 0 ? '2026-08-31T00:00:00.000Z' : null,
      profileScore: index % 100,
    })) satisfies SearchResult[];
    const filters = { ...DEFAULT_FILTERS, query: 'frontend', country: 'Netherlands' };
    const start = performance.now();
    const index = buildSearchResultIndex(results);
    const filtered = filterSearchResultIndex(index, filters, now);
    const sorted = sortSearchResultIndex(filtered);
    const elapsedMs = performance.now() - start;

    expect(sorted).toHaveLength(5_000);
    expect(elapsedMs).toBeLessThan(1_500);
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
    company?: string;
    description?: string | null;
    provisional?: boolean;
  }): SearchResult {
    const title = overrides.title ?? overrides.key;
    const company = overrides.company ?? 'Acme';
    return {
      raw: discoveryVacancy({ key: overrides.key }),
      official: null,
      provisional: overrides.provisional ?? false,
      key: overrides.key,
      title,
      company,
      location: null,
      url: 'https://example.com/job',
      provider: 'jobicy',
      employmentType: null,
      salary: null,
      postedAt: overrides.postedAt ?? null,
      description: overrides.description ?? null,
      verification: { level: 'not_available', label: 'Not available for this vacancy', tone: null, note: '' },
      profileScore: overrides.profileScore ?? null,
      strongPoints: [],
      gaps: [],
      reasons: [],
      lead: { title, company, location: 'Not stated', url: 'https://example.com/job' },
    };
  }

  it('sorts rows with no profile score by most recently posted first', () => {
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

  it('ranks a higher profile score first, ahead of posting date', () => {
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

describe('sortResults/sortSearchResultIndex: query-match tier for scoreless rows (issue #395)', () => {
  function sortableResult(overrides: {
    key: string;
    profileScore?: number | null;
    postedAt?: string | null;
    title?: string;
    company?: string;
    description?: string | null;
    provisional?: boolean;
  }): SearchResult {
    const title = overrides.title ?? overrides.key;
    const company = overrides.company ?? 'Acme';
    return {
      raw: discoveryVacancy({ key: overrides.key }),
      official: null,
      provisional: overrides.provisional ?? false,
      key: overrides.key,
      title,
      company,
      location: null,
      url: 'https://example.com/job',
      provider: 'jobicy',
      employmentType: null,
      salary: null,
      postedAt: overrides.postedAt ?? null,
      description: overrides.description ?? null,
      verification: { level: 'not_available', label: 'Not available for this vacancy', tone: null, note: '' },
      profileScore: overrides.profileScore ?? null,
      strongPoints: [],
      gaps: [],
      reasons: [],
      lead: { title, company, location: 'Not stated', url: 'https://example.com/job' },
    };
  }

  it('ranks an exact title match above a partial title match', () => {
    const results = [
      sortableResult({ key: 'partial', title: 'Senior Frontend Engineer' }),
      sortableResult({ key: 'exact', title: 'Frontend Engineer' }),
    ];

    expect(sortResults(results, 'Frontend Engineer').map((r) => r.key)).toEqual(['exact', 'partial']);
  });

  it('ranks an exact company match at the same top tier as an exact title match', () => {
    const results = [
      sortableResult({ key: 'exact-title', title: 'Acme Corp', company: 'Someone Else' }),
      sortableResult({ key: 'exact-company', title: 'Unrelated Role', company: 'Acme Corp' }),
      sortableResult({ key: 'partial-title', title: 'Acme Corp Senior Role', company: 'Someone Else' }),
    ];

    const ordered = sortResults(results, 'Acme Corp').map((r) => r.key);
    // Both exact matches (tier 4) rank ahead of the partial title match (tier 3); which of the two
    // tier-4 rows comes first is not asserted since the ticket only guarantees the tier is the same.
    expect(ordered.slice(0, 2).sort()).toEqual(['exact-company', 'exact-title']);
    expect(ordered[2]).toBe('partial-title');
  });

  it('matches case-insensitively', () => {
    const results = [
      sortableResult({ key: 'lower', title: 'frontend engineer' }),
      sortableResult({ key: 'no-match', title: 'Backend Engineer' }),
    ];

    expect(sortResults(results, 'FRONTEND ENGINEER').map((r) => r.key)).toEqual(['lower', 'no-match']);
  });

  it('matches a multi-word query via substring against the title', () => {
    const results = [
      sortableResult({ key: 'no-match', title: 'Backend Developer' }),
      sortableResult({ key: 'match', title: 'Senior Frontend Developer, Remote' }),
    ];

    expect(sortResults(results, 'frontend developer').map((r) => r.key)).toEqual(['match', 'no-match']);
  });

  it('breaks a tie within the same tier by recency', () => {
    const results = [
      sortableResult({ key: 'older', title: 'Frontend Developer', postedAt: '2026-08-01T00:00:00.000Z' }),
      sortableResult({ key: 'newer', title: 'Frontend Developer', postedAt: '2026-08-20T00:00:00.000Z' }),
    ];

    expect(sortResults(results, 'frontend').map((r) => r.key)).toEqual(['newer', 'older']);
  });

  it('does not let a scored row automatically outrank an unscored one -- the postedAt fallback is unchanged', () => {
    const results = [
      sortableResult({ key: 'scored', profileScore: 40, postedAt: '2026-08-01T00:00:00.000Z', title: 'No match here' }),
      sortableResult({ key: 'scoreless', profileScore: null, postedAt: '2026-08-20T00:00:00.000Z', title: 'Frontend Engineer' }),
    ];

    // Mixed pair: the tier check never fires (it requires both rows scoreless), so this falls
    // straight through to today's postedAt fallback, exactly as before this change.
    expect(sortResults(results, 'frontend engineer').map((r) => r.key)).toEqual(['scoreless', 'scored']);
  });

  it('keeps profileScore authoritative for a both-scored pair, even when the lower score would win the query tier', () => {
    const results = [
      sortableResult({ key: 'high-score-no-match', profileScore: 90, title: 'Backend Developer' }),
      sortableResult({ key: 'low-score-exact-match', profileScore: 40, title: 'Frontend Engineer' }),
    ];

    expect(sortResults(results, 'Frontend Engineer').map((r) => r.key)).toEqual([
      'high-score-no-match',
      'low-score-exact-match',
    ]);
  });

  it('is byte-for-behavior identical to omitting the query, when the query is empty', () => {
    const results = [
      sortableResult({ key: 'a', title: 'Frontend Engineer', postedAt: '2026-08-01T00:00:00.000Z' }),
      sortableResult({ key: 'b', title: 'Backend Engineer', postedAt: '2026-08-20T00:00:00.000Z' }),
      sortableResult({ key: 'c', title: 'Frontend Engineer', postedAt: '2026-08-10T00:00:00.000Z' }),
    ];

    const withNoArgument = sortResults(results).map((r) => r.key);
    const withEmptyQuery = sortResults(results, '').map((r) => r.key);

    expect(withEmptyQuery).toEqual(withNoArgument);
    // Sanity check: a real query would have reordered this set (title-tier would put both
    // "Frontend Engineer" rows ahead of postedAt-only ordering), so this is a meaningful assertion.
    expect(sortResults(results, 'frontend engineer').map((r) => r.key)).not.toEqual(withNoArgument);
  });

  it('ranks a description-only match below a title/company match but above a no-match row', () => {
    const results = [
      sortableResult({ key: 'no-match', title: 'Unrelated', company: 'Nowhere', description: 'Nothing relevant.' }),
      sortableResult({ key: 'description-match', title: 'Unrelated Role', company: 'Nowhere', description: 'Requires TypeScript experience.' }),
      sortableResult({ key: 'title-match', title: 'TypeScript Engineer', company: 'Nowhere' }),
    ];

    expect(sortResults(results, 'typescript').map((r) => r.key)).toEqual([
      'title-match',
      'description-match',
      'no-match',
    ]);
  });

  it('ranks a live/provisional scoreless row by query-match tier the same as a non-provisional one', () => {
    const results = [
      sortableResult({ key: 'provisional-match', title: 'Frontend Engineer', provisional: true }),
      sortableResult({ key: 'provisional-no-match', title: 'Backend Engineer', provisional: true }),
    ];

    expect(sortResults(results, 'frontend').map((r) => r.key)).toEqual(['provisional-match', 'provisional-no-match']);
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

  it('falls back to WORLDWIDE_VERIFICATION, rather than crashing, when worldwideSponsorMatch is entirely absent', () => {
    // Regression test: a report persisted by an older engine version can predate this field, so a
    // vacancy hydrated from disk can carry `worldwideSponsorMatch: undefined` (the property simply
    // never set) rather than the `null` the current type promises. Reading `match.legalName` off
    // that `undefined` used to throw `TypeError: Cannot read properties of undefined (reading
    // 'legalName')`, which had no error boundary above it and took the whole Search page down to a
    // blank white screen on every launch that happened to hydrate such a report.
    const vacancy = discoveryVacancy();
    delete (vacancy as { worldwideSponsorMatch?: unknown }).worldwideSponsorMatch;

    expect(worldwideVerification(vacancy)).toBe(WORLDWIDE_VERIFICATION);
  });

  it('falls back to WORLDWIDE_VERIFICATION for a match object missing legalName or kvkNumber', () => {
    // Same schema-drift concern as above, one level down: a half-populated match object (rather
    // than an entirely absent one) must not crash either.
    expect(
      worldwideVerification(
        discoveryVacancy({ worldwideSponsorMatch: { legalName: '', kvkNumber: '01234567' } }),
      ),
    ).toBe(WORLDWIDE_VERIFICATION);
    expect(
      worldwideVerification(
        discoveryVacancy({ worldwideSponsorMatch: { legalName: 'Acme Technologies B.V.', kvkNumber: '' } }),
      ),
    ).toBe(WORLDWIDE_VERIFICATION);
  });
});

describe('formatDiscoverySalary', () => {
  it('returns null when the source carries no advertised minimum', () => {
    expect(formatDiscoverySalary(discoveryVacancy({ advertisedMinimum: null }))).toBeNull();
  });

  // UX audit finding: a single results list showed "USD 163,200/yearly", "GBP 25,000/weekly" and
  // "USD 120,000/year" side by side -- three spellings straight from whichever upstream source
  // produced them. Every synonym below must collapse onto the same canonical suffix.
  it.each([
    ['yearly', '/yr'],
    ['year', '/yr'],
    ['annual', '/yr'],
    ['Annually', '/yr'],
    ['yr', '/yr'],
    ['monthly', '/mo'],
    ['month', '/mo'],
    ['weekly', '/wk'],
    ['week', '/wk'],
    ['hourly', '/hr'],
    ['hour', '/hr'],
    ['daily', '/day'],
  ])('normalizes salaryPeriod %j to the canonical suffix %j', (salaryPeriod, suffix) => {
    const salary = formatDiscoverySalary(
      discoveryVacancy({ currency: 'USD', advertisedMinimum: 100_000, salaryPeriod }),
    );
    expect(salary).toBe(`from USD 100,000${suffix}`);
  });

  it('renders with no period suffix for a salaryPeriod it does not recognize, rather than leaking raw source text', () => {
    expect(
      formatDiscoverySalary(
        discoveryVacancy({ currency: 'USD', advertisedMinimum: 100_000, salaryPeriod: 'per project' }),
      ),
    ).toBe('from USD 100,000');
  });

  it('renders with no period suffix at all when salaryPeriod is null', () => {
    expect(
      formatDiscoverySalary(discoveryVacancy({ currency: 'EUR', advertisedMinimum: 50_000, salaryPeriod: null })),
    ).toBe('from EUR 50,000');
  });

  it('always prefixes "from" since advertisedMinimum is a minimum, never a fixed salary', () => {
    expect(
      formatDiscoverySalary(discoveryVacancy({ currency: 'GBP', advertisedMinimum: 25_000, salaryPeriod: 'annual' })),
    ).toBe('from GBP 25,000/yr');
  });

  it('omits the currency, without a stray double space, when the source carries none', () => {
    expect(
      formatDiscoverySalary(discoveryVacancy({ currency: null, advertisedMinimum: 45_000, salaryPeriod: 'annual' })),
    ).toBe('from 45,000/yr');
  });
});

describe('descriptionExcerpt', () => {
  it('returns null for a null description', () => {
    expect(descriptionExcerpt(null)).toBeNull();
  });

  it('returns null for a whitespace-only description', () => {
    expect(descriptionExcerpt('   \n\n  ')).toBeNull();
  });

  it('collapses preserved paragraph breaks to a single line for the card preview', () => {
    // `description` can carry real newlines at former block-tag boundaries (see
    // `packages/vacancy-engine/src/ats/shared.ts`'s `htmlToText`), which the detail pane renders
    // with `whitespace-pre-wrap`. The card excerpt is a different, single-line rendering context.
    expect(descriptionExcerpt('Multiple years of experience.\n\nTwo Microsoft certifications.')).toBe(
      'Multiple years of experience. Two Microsoft certifications.',
    );
  });

  it('trims leading and trailing whitespace', () => {
    expect(descriptionExcerpt('  Build accessible interfaces.  ')).toBe('Build accessible interfaces.');
  });
});
