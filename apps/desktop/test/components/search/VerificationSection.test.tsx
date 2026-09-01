import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { VerificationSection } from '../../../src/components/search/VerificationSection.js';
import type { SearchResult } from '../../../src/components/search/results.js';

function worldwideResult(overrides: Partial<Extract<SearchResult, { market: 'worldwide' }>> = {}): SearchResult {
  return {
    market: 'worldwide',
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
    key: 'ww-1',
    title: 'Remote Frontend Engineer',
    company: 'Acme Corp',
    location: 'Worldwide',
    url: 'https://example.invalid/jobs/ww-1',
    provider: 'remotive',
    arrangement: null,
    arrangementValue: 'unknown',
    employmentType: 'full_time',
    salary: null,
    postedAt: null,
    description: null,
    verification: {
      level: 'not_available',
      label: 'Not available for this market',
      tone: null,
      note: 'The worldwide/remote pipeline discovers vacancies from public job feeds and does not check employers against any register. Nothing was verified about this employer: that is an absent check, not a negative result.',
    },
    profileScore: null,
    strongPoints: [],
    gaps: [],
    reasons: [],
    lead: { title: 'Remote Frontend Engineer', company: 'Acme Corp', location: 'Worldwide', url: 'https://example.invalid/jobs/ww-1' },
    ...overrides,
  };
}

describe('VerificationSection', () => {
  it('does not repeat the "not available" note here -- it is already shown once in the summary card above', () => {
    render(<VerificationSection result={worldwideResult()} sponsorSource={null} runId="run-1" />);

    expect(screen.queryByText(/Nothing was verified about this employer/i)).not.toBeInTheDocument();
    expect(screen.getByText('Employer verification is not available for Worldwide / Remote.')).toBeInTheDocument();
  });

  it('points to the summary card for a sponsor match, without repeating its label or note here', () => {
    const result = worldwideResult({
      verification: {
        level: 'possible_sponsor_match',
        label: 'Possible sponsor match (best effort)',
        tone: 'warning',
        note: 'A best-effort Wikidata name search matched this employer to Acme Nederland B.V. (KVK 12345678) on the IND public register.',
      },
    });

    render(<VerificationSection result={result} sponsorSource={null} runId="run-1" />);

    expect(screen.getByText(/best-effort sponsor match was found/i)).toBeInTheDocument();
    // The summary card (VacancyDetail.tsx, not rendered here) already shows the label and note
    // unconditionally -- this section must not repeat either.
    expect(screen.queryByText('Possible sponsor match (best effort)')).not.toBeInTheDocument();
    expect(screen.queryByText(/Acme Nederland B.V. \(KVK 12345678\)/)).not.toBeInTheDocument();
  });
});
