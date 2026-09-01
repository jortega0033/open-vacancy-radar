import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { SearchResultList } from '../../../src/components/search/SearchResultList.js';
import type { SearchResult } from '../../../src/components/search/results.js';

function worldwideResult(
  key: string,
  title: string,
  overrides: Partial<Extract<SearchResult, { market: 'worldwide' }>> = {},
): SearchResult {
  return {
    market: 'worldwide',
    raw: {
      key,
      provider: 'jobicy',
      company: 'Acme',
      title,
      url: 'https://example.invalid/job',
      location: 'Worldwide',
      employmentType: null,
      currency: null,
      salaryPeriod: null,
      advertisedMinimum: null,
      annualizedMinimumUsd: null,
      decision: 'official_review_candidate',
      reasons: [],
      contentHash: `hash-${key}`,
      description: null,
      postedAt: null,
      profileScore: null,
      worldwideSponsorMatch: null,
    },
    official: null,
    key,
    title,
    company: 'Acme',
    location: null,
    url: 'https://example.invalid/job',
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
    lead: { title, company: 'Acme', location: 'Not stated', url: 'https://example.invalid/job' },
    ...overrides,
  };
}

function netherlandsResult(
  overrides: Partial<Extract<SearchResult, { market: 'netherlands' }>> = {},
): SearchResult {
  return {
    market: 'netherlands',
    raw: {
      id: 'nl-1',
      title: 'Frontend Engineer',
      description: 'Build things.',
      company: 'Redwood',
      location: 'Amsterdam',
      remote: false,
      workplaceMode: 'hybrid',
      provider: 'greenhouse',
      url: 'https://example.invalid/nl-job',
      sponsorLegalNames: ['Redwood B.V.'],
      mappingConfidence: 'high',
      firstSeenAt: '2026-08-01T00:00:00.000Z',
      lastSeenAt: '2026-08-28T00:00:00.000Z',
      postedAt: '2026-08-20T00:00:00.000Z',
      verifiedInRun: true,
      sourceOutcomeStatus: 'succeeded',
    },
    key: 'nl-1',
    title: 'Frontend Engineer',
    company: 'Redwood',
    location: 'Amsterdam',
    url: 'https://example.invalid/nl-job',
    provider: 'greenhouse',
    arrangement: 'Hybrid',
    arrangementValue: 'hybrid',
    employmentType: null,
    salary: null,
    postedAt: '2026-08-20T00:00:00.000Z',
    description: 'Build things.',
    verification: {
      level: 'recognised_sponsor',
      label: 'Recognised sponsor',
      tone: 'success',
      note: 'Matched with high confidence.',
    },
    profileScore: 90,
    strongPoints: [],
    gaps: [],
    reasons: [],
    lead: { title: 'Frontend Engineer', company: 'Redwood', location: 'Amsterdam', url: 'https://example.invalid/nl-job' },
    ...overrides,
  };
}

describe('SearchResultList', () => {
  it('shows no verification badge for a worldwide row -- the pipeline has no per-row outcome to report', () => {
    render(
      <SearchResultList
        results={[worldwideResult('1', 'Frontend Engineer')]}
        totalCount={1}
        selectedKey={null}
        onSelect={vi.fn()}
        savedKeys={new Set()}
        summary="1 vacancy"
        page={0}
        pageCount={1}
        onPageChange={vi.fn()}
      />,
    );

    expect(screen.queryByText('Not available for this market')).not.toBeInTheDocument();
  });

  it('shows a verification badge for a Netherlands row, since that pipeline has a real per-row outcome', () => {
    render(
      <SearchResultList
        results={[netherlandsResult()]}
        totalCount={1}
        selectedKey={null}
        onSelect={vi.fn()}
        savedKeys={new Set()}
        summary="1 vacancy"
        page={0}
        pageCount={1}
        onPageChange={vi.fn()}
      />,
    );

    expect(screen.getByText('Recognised sponsor')).toBeInTheDocument();
  });

  it('flags a posting over 30 days old instead of showing its date as if it were fresh', () => {
    render(
      <SearchResultList
        results={[worldwideResult('1', 'Frontend Engineer', { postedAt: '2020-01-01T00:00:00.000Z' })]}
        totalCount={1}
        selectedKey={null}
        onSelect={vi.fn()}
        savedKeys={new Set()}
        summary="1 vacancy"
        page={0}
        pageCount={1}
        onPageChange={vi.fn()}
      />,
    );

    expect(screen.getByText(/over a month old/i)).toBeInTheDocument();
  });
  it('uses the no-results illustration without changing the loaded-report explanation', () => {
    render(
      <SearchResultList
        results={[]}
        totalCount={4}
        selectedKey={null}
        onSelect={vi.fn()}
        savedKeys={new Set()}
        summary="0 vacancies"
        page={0}
        pageCount={1}
        onPageChange={vi.fn()}
      />,
    );

    expect(screen.getByText(/no vacancy in the loaded report matches these filters/i)).toBeInTheDocument();
    const illustration = screen.getByTestId('empty-state-illustration');
    expect(illustration).toHaveAttribute('aria-hidden', 'true');
    expect(illustration.getAttribute('style')).toContain('no-results');
  });

  it('hides pagination controls when everything fits on one page', () => {
    render(
      <SearchResultList
        results={[worldwideResult('1', 'Frontend Engineer')]}
        totalCount={1}
        selectedKey={null}
        onSelect={vi.fn()}
        savedKeys={new Set()}
        summary="1 vacancy"
        page={0}
        pageCount={1}
        onPageChange={vi.fn()}
      />,
    );

    expect(screen.queryByRole('button', { name: 'Next' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Previous' })).not.toBeInTheDocument();
  });

  it('shows pagination controls across multiple pages, disabling Previous/Next at the ends', () => {
    const onPageChange = vi.fn();
    const { rerender } = render(
      <SearchResultList
        results={[worldwideResult('1', 'Frontend Engineer')]}
        totalCount={50}
        selectedKey={null}
        onSelect={vi.fn()}
        savedKeys={new Set()}
        summary="50 vacancies"
        page={0}
        pageCount={2}
        onPageChange={onPageChange}
      />,
    );

    expect(screen.getByText('Page 1 of 2')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Previous' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Next' })).toBeEnabled();

    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    expect(onPageChange).toHaveBeenCalledWith(1);

    rerender(
      <SearchResultList
        results={[worldwideResult('2', 'Backend Engineer')]}
        totalCount={50}
        selectedKey={null}
        onSelect={vi.fn()}
        savedKeys={new Set()}
        summary="50 vacancies"
        page={1}
        pageCount={2}
        onPageChange={onPageChange}
      />,
    );

    expect(screen.getByText('Page 2 of 2')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Next' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Previous' })).toBeEnabled();
  });
});
