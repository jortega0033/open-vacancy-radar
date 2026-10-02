import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { VerificationSection } from '../../../src/components/search/VerificationSection.js';
import type { SearchResult } from '../../../src/components/search/results.js';

function worldwideResult(overrides: Partial<SearchResult> = {}): SearchResult {
  return {
    raw: {
      key: 'ww-1',
      provider: 'remotive',
      company: 'Acme Corp',
      title: 'Remote Frontend Engineer',
      url: 'https://example.invalid/jobs/ww-1',
      location: 'Worldwide',
      employmentType: 'full_time',
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
    },
    official: null,
    provisional: false,
    key: 'ww-1',
    title: 'Remote Frontend Engineer',
    company: 'Acme Corp',
    location: 'Worldwide',
    url: 'https://example.invalid/jobs/ww-1',
    provider: 'remotive',
    employmentType: 'full_time',
    salary: null,
    postedAt: null,
    description: null,
    verification: {
      level: 'not_available',
      label: 'Not available for this vacancy',
      tone: null,
      note: 'No sponsor register match was found (or attempted, for a non-Netherlands location) for this employer. Nothing was verified: that is an absent check, not a negative result.',
    },
    profileScore: null,
    strongPoints: [],
    gaps: [],
    reasons: [],
    lead: { title: 'Remote Frontend Engineer', company: 'Acme Corp', location: 'Worldwide', url: 'https://example.invalid/jobs/ww-1' },
    ...overrides,
  } as SearchResult;
}

describe('VerificationSection', () => {
  it('does not explain employer verification at all -- the detail pane states it once, above', () => {
    render(<VerificationSection result={worldwideResult()} />);

    expect(screen.queryByText(/Nothing was verified: that is an absent check/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/employer verification is not available/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/not available for this vacancy/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/you can still compare this vacancy/i)).not.toBeInTheDocument();
    // What it does own: the vacancy-level official source check.
    expect(screen.getByRole('heading', { name: 'Sources' })).toBeInTheDocument();
    expect(screen.getByText('Official vacancy check')).toBeInTheDocument();
  });

  it('stays silent about a sponsor match too, leaving the label and note to the summary card', () => {
    const result = worldwideResult({
      verification: {
        level: 'possible_sponsor_match',
        label: 'Possible sponsor match (best effort)',
        tone: 'warning',
        note: 'A best-effort Wikidata name search matched this employer to Acme Nederland B.V. (KVK 12345678) on the IND public register.',
      },
    });

    render(<VerificationSection result={result} />);

    expect(screen.queryByText(/best-effort sponsor match was found/i)).not.toBeInTheDocument();
    expect(screen.queryByText('Possible sponsor match (best effort)')).not.toBeInTheDocument();
    expect(screen.queryByText(/Acme Nederland B.V. \(KVK 12345678\)/)).not.toBeInTheDocument();
  });
});
