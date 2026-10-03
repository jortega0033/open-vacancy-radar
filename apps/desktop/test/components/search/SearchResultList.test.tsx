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
    provisional: false,
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

  // Issue #484: a background step alone was 1.04:1, so the selected row also carries the marker utility.
  it('marks only the selected row with the ovr-row-selected indicator', () => {
    render(
      <SearchResultList
        results={[worldwideResult('1', 'First Role'), worldwideResult('2', 'Second Role')]}
        totalCount={2}
        selectedKey="2"
        onSelect={vi.fn()}
        savedKeys={new Set()}
        summary="2 vacancies"
        page={0}
        pageCount={1}
        onPageChange={vi.fn()}
      />,
    );

    const selected = screen.getByText('Second Role').closest('button');
    const other = screen.getByText('First Role').closest('button');
    expect(selected).toHaveClass('ovr-row-selected');
    expect(selected).toHaveAttribute('aria-current', 'true');
    expect(other).not.toHaveClass('ovr-row-selected');
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

  it('marks a provisional (live-scan) row as not yet scored, and never for a final row (issue #364)', () => {
    const provisionalRow = worldwideResult('1', 'Frontend Engineer', { provisional: true });
    const finalRow = worldwideResult('2', 'Backend Engineer', { provisional: false });

    render(
      <SearchResultList
        results={[provisionalRow, finalRow]}
        totalCount={2}
        selectedKey={null}
        onSelect={vi.fn()}
        savedKeys={new Set()}
        summary="2 vacancies"
        scanActive
        page={0}
        pageCount={1}
        onPageChange={vi.fn()}
      />,
    );

    expect(screen.getAllByText(/live · not yet scored/i)).toHaveLength(1);
  });

  it('never shows the live badge when no scan is running, even for a provisional row (issue #464)', () => {
    render(
      <SearchResultList
        results={[worldwideResult('1', 'Frontend Engineer', { provisional: true })]}
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

    expect(screen.queryByText(/live · not yet scored/i)).not.toBeInTheDocument();
  });

  it('labels the score as profile fit out of 100, visibly and for screen readers (issue #452)', () => {
    render(
      <SearchResultList
        results={[worldwideResult('1', 'Frontend Engineer', { profileScore: 98 })]}
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

    expect(screen.getByText('Profile fit 98/100')).toBeInTheDocument();
    expect(screen.getByText('Profile fit 98 out of 100')).toHaveClass('sr-only');
    expect(screen.getByRole('button', { name: /profile fit 98 out of 100/i })).toBeInTheDocument();
  });

  it('shows no score chip, and never a zero, for an unscored row', () => {
    render(
      <SearchResultList
        results={[worldwideResult('1', 'Frontend Engineer', { profileScore: null })]}
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

    expect(screen.queryByText(/profile fit/i)).not.toBeInTheDocument();
  });

  it('puts unscored rows under one "Not scored yet (N)" divider that follows the scored rows (issue #464)', () => {
    render(
      <SearchResultList
        results={[
          worldwideResult('1', 'Scored One', { profileScore: 98 }),
          worldwideResult('2', 'Scored Two', { profileScore: 80 }),
          worldwideResult('3', 'Unscored One'),
          worldwideResult('4', 'Unscored Two'),
        ]}
        totalCount={4}
        selectedKey={null}
        onSelect={vi.fn()}
        savedKeys={new Set()}
        summary="4 vacancies"
        page={0}
        pageCount={1}
        onPageChange={vi.fn()}
      />,
    );

    const divider = screen.getByRole('heading', { name: 'Not scored yet (2)' });
    expect(screen.getAllByRole('heading', { name: /not scored yet/i })).toHaveLength(1);
    const titles = screen.getAllByText(/^(Scored|Unscored) (One|Two)$/).map((node) => node.textContent);
    expect(titles).toEqual(['Scored One', 'Scored Two', 'Unscored One', 'Unscored Two']);
    // The divider sits between the last scored row and the first unscored row.
    expect(divider.compareDocumentPosition(screen.getByText('Scored Two'))).toBe(Node.DOCUMENT_POSITION_PRECEDING);
    expect(divider.compareDocumentPosition(screen.getByText('Unscored One'))).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
  });

  it('counts the unscored rows of the whole list when the caller passes it, and repeats the divider at the top of a page that starts inside the group', () => {
    render(
      <SearchResultList
        results={[worldwideResult('5', 'Unscored Five'), worldwideResult('6', 'Unscored Six')]}
        totalCount={40}
        selectedKey={null}
        onSelect={vi.fn()}
        savedKeys={new Set()}
        summary="40 vacancies"
        unscoredCount={12}
        page={1}
        pageCount={2}
        onPageChange={vi.fn()}
      />,
    );

    expect(screen.getByRole('heading', { name: 'Not scored yet (12)' })).toBeInTheDocument();
  });

  it('shows no divider when every row is scored', () => {
    render(
      <SearchResultList
        results={[worldwideResult('1', 'Scored One', { profileScore: 90 })]}
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

    expect(screen.queryByRole('heading', { name: /not scored yet/i })).not.toBeInTheDocument();
  });

  it('renders no description line for a description that is only metadata or an employer introduction (issue #463)', () => {
    const { container } = render(
      <SearchResultList
        results={[
          worldwideResult('1', 'Principal Front End Engineer', {
            description: 'Type of Requisition: Pipeline\nClearance Level Must Currently Possess: None',
          }),
          worldwideResult('2', 'Frontend Engineer', { description: 'Who We Are\nHi, we are a small search company.' }),
        ]}
        totalCount={2}
        selectedKey={null}
        onSelect={vi.fn()}
        savedKeys={new Set()}
        summary="2 vacancies"
        page={0}
        pageCount={1}
        onPageChange={vi.fn()}
      />,
    );

    expect(container.querySelector('.line-clamp-2')).not.toBeInTheDocument();
    expect(screen.queryByText(/type of requisition/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/who we are/i)).not.toBeInTheDocument();
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

  it('sizes itself from the page\'s layout choice, not from the viewport (#451)', () => {
    // jsdom runs no layout engine, so the classes are the testable contract. Beside the detail pane
    // the list is a fixed-width column; on its own (the single-pane flow) it takes the whole width.
    // Either way it is never sized by a viewport breakpoint, because the sidebar changes the width
    // the page really has without changing the viewport.
    const props = {
      results: [worldwideResult('1', 'Frontend Engineer')],
      totalCount: 1,
      selectedKey: null,
      onSelect: vi.fn(),
      savedKeys: new Set<string>(),
      summary: '1 vacancy',
      page: 0,
      pageCount: 1,
      onPageChange: vi.fn(),
    };

    const { container: split } = render(<SearchResultList {...props} />);
    expect(split.firstElementChild).toHaveClass('w-2/5', 'min-w-80', 'max-w-md', 'flex-none', 'border-r');

    const { container: alone } = render(<SearchResultList {...props} split={false} />);
    expect(alone.firstElementChild).toHaveClass('flex-1');
    expect(alone.firstElementChild).not.toHaveClass('w-2/5');
    expect(alone.firstElementChild?.className).not.toMatch(/\blg:/);
  });

  it('marks each row with its key so focus can return to it after Back', () => {
    render(
      <SearchResultList
        results={[worldwideResult('1', 'Frontend Engineer')]}
        totalCount={1}
        selectedKey="1"
        onSelect={vi.fn()}
        savedKeys={new Set()}
        summary="1 vacancy"
        page={0}
        pageCount={1}
        onPageChange={vi.fn()}
      />,
    );
    expect(document.querySelector('[data-result-key="1"]')).not.toBeNull();
  });
});
