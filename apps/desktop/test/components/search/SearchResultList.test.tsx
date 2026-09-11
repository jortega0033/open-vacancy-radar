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
  // UX audit finding: `decisionLabel(result.raw.decision)` used to render as a badge chip styled
  // identically to the salary/employment-type chips. In every populated screenshot reviewed,
  // `role_mismatch` read as "role mismatch" on essentially every card, which looks exactly like
  // "this job doesn't match you" on 100% of listings -- misleading, since it is a pipeline
  // classification, not a per-candidate match rejection. It still has an accurate home in the
  // detail pane's Overview section ("Discovery decision"), unchanged -- only the card chip is gone.
  it('never renders the raw discovery-decision chip on the card, for any decision value', () => {
    render(
      <SearchResultList
        results={[
          worldwideResult('1', 'Frontend Engineer', { raw: discoveryVacancy('1', { decision: 'role_mismatch' }) }),
        ]}
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

    expect(screen.queryByText(/role mismatch/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/official review candidate/i)).not.toBeInTheDocument();
  });

  // UX audit finding: cards showed title/company/location/chips/date but zero role-content, so
  // scanning a list of results meant opening each one individually to judge fit.
  it('shows a clamped description excerpt between the company/location line and the chip row', () => {
    render(
      <SearchResultList
        results={[
          worldwideResult('1', 'Frontend Engineer', {
            description: 'Build accessible, performant interfaces for a distributed team.',
          }),
        ]}
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

    const excerpt = screen.getByText('Build accessible, performant interfaces for a distributed team.');
    expect(excerpt).toHaveClass('line-clamp-2');
  });

  it('renders no description line at all when the source carries no description text', () => {
    const { container } = render(
      <SearchResultList
        results={[worldwideResult('1', 'Frontend Engineer', { description: null })]}
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

    expect(container.querySelector('.line-clamp-2')).not.toBeInTheDocument();
  });

  // UX audit finding: the card showed the raw snake_case `DiscoveryProvider` id (e.g.
  // "devitjobs_uk") instead of a human label.
  it('shows a human-readable provider label instead of the raw snake_case provider id', () => {
    render(
      <SearchResultList
        results={[
          worldwideResult('1', 'Frontend Engineer', {
            provider: 'devitjobs_uk',
            raw: discoveryVacancy('1', { provider: 'devitjobs_uk' }),
          }),
        ]}
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

    expect(screen.getByText('DevITjobs UK')).toBeInTheDocument();
    expect(screen.queryByText('devitjobs_uk')).not.toBeInTheDocument();
  });

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

  it('leaves room for the detail pane below it when the two panes are stacked (under lg)', () => {
    // Regression guard. `SearchPage` lays this pane and `VacancyDetail` out as `flex-col lg:flex-row`,
    // and the app's own default window is 1000px wide -- narrower than `lg`'s 1024px -- so the
    // stacked column is the layout a user gets out of the box. `VacancyDetail` is `flex-1`
    // (`flex: 1 1 0%`, a zero flex basis). While this pane was `flex: 0 1 auto`, basing itself on its
    // own page-of-25-rows-tall content, the column had no free space left to distribute and the
    // detail pane stayed at its zero basis: it rendered at zero height, below the bottom of a
    // `<main>` that does not scroll, so "Save job", "Generate Letter" and the verification cards were
    // all invisible and unclickable at the default window size.
    //
    // jsdom runs no layout engine, so the flex classes themselves are the testable contract here:
    // `flex-1` below `lg` (an even split with the detail pane, each scrolling internally) and
    // `lg:flex-none` from `lg` up (so the side-by-side layout's own `lg:w-2/5` sizing still applies).
    const { container } = render(
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

    const pane = container.firstElementChild!;
    expect(pane).toHaveClass('flex-1');
    expect(pane).toHaveClass('lg:flex-none');
    // The side-by-side sizing must stay exactly as it was; this fix is scoped to the stacked case.
    expect(pane).toHaveClass('lg:w-2/5');
  });
});
