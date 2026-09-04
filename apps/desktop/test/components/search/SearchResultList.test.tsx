import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { DiscoveryVacancyAudit } from '@open-vacancy-radar/vacancy-engine';
import { SearchResultList } from '../../../src/components/search/SearchResultList.js';
import type { SearchResult } from '../../../src/components/search/results.js';

function discoveryVacancy(key: string, overrides: Partial<DiscoveryVacancyAudit> = {}): DiscoveryVacancyAudit {
  return {
    key,
    provider: 'jobicy',
    company: 'Acme',
    title: 'Frontend Engineer',
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
    ...overrides,
  };
}

function worldwideResult(key: string, title: string, overrides: Partial<SearchResult> = {}): SearchResult {
  return {
    raw: discoveryVacancy(key, { title, postedAt: overrides.postedAt }),
    official: null,
    key,
    title,
    company: 'Acme',
    location: null,
    url: 'https://example.invalid/job',
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
    lead: { title, company: 'Acme', location: 'Not stated', url: 'https://example.invalid/job' },
    ...overrides,
  };
}

describe('SearchResultList', () => {
  it('shows no verification badge for a row with no sponsor match', () => {
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

    expect(screen.queryByText('Not available for this vacancy')).not.toBeInTheDocument();
  });

  it('shows a possible-sponsor-match badge for a matched row', () => {
    const matched = worldwideResult('1', 'Frontend Engineer', {
      raw: discoveryVacancy('1', {
        worldwideSponsorMatch: { legalName: 'Acme B.V.', kvkNumber: '01234567' },
      }),
      verification: {
        level: 'possible_sponsor_match',
        label: 'Possible sponsor match (best effort)',
        tone: 'warning',
        note: 'A best-effort match.',
      },
    });

    render(
      <SearchResultList
        results={[matched]}
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

    expect(screen.getByText('Possible sponsor match (best effort)')).toBeInTheDocument();
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

  it('selects the row that was clicked', () => {
    const onSelect = vi.fn();
    const first = worldwideResult('1', 'Frontend Engineer');
    const second = worldwideResult('2', 'Backend Engineer');

    render(
      <SearchResultList
        results={[first, second]}
        totalCount={2}
        selectedKey={null}
        onSelect={onSelect}
        savedKeys={new Set()}
        summary="2 vacancies"
        page={0}
        pageCount={1}
        onPageChange={vi.fn()}
      />,
    );

    const rows = screen.getAllByRole('button');
    expect(rows).toHaveLength(2);

    fireEvent.click(rows[1]!);
    expect(onSelect).toHaveBeenCalledWith(second);
  });
});
