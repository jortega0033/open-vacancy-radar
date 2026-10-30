import { fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DiscoveryVacancyAudit } from '@open-vacancy-radar/vacancy-engine';
import type { PostingLivenessView } from '../../../electron/application-pipeline-types.js';
import { formatCheckedAt } from '../../../src/components/applications/posting-verification-text.js';
import { LIVENESS_LABEL } from '../../../src/components/search/posting-liveness.js';
import { SearchResultList } from '../../../src/components/search/SearchResultList.js';
import { VacancyDetail } from '../../../src/components/search/VacancyDetail.js';
import type { SearchResult } from '../../../src/components/search/results.js';

// #720: no fit score without a plain liveness state beside it, and a posting a check found closed
// cannot use the primary action (the override is a separate, secondary button).

const NOW = new Date('2026-10-30T12:00:00.000Z');
const CHECKED = '2026-10-30T11:58:00.000Z';

function vacancy(key: string, overrides: Partial<DiscoveryVacancyAudit> = {}): DiscoveryVacancyAudit {
  return {
    key,
    provider: 'remotive',
    company: 'IT Labs',
    title: 'Senior Frontend Engineer',
    url: `https://jobs.ashbyhq.com/itlabs/${key}`,
    location: 'Remote',
    employmentType: null,
    currency: null,
    salaryPeriod: null,
    advertisedMinimum: null,
    annualizedMinimumUsd: null,
    decision: 'official_review_candidate',
    reasons: [],
    contentHash: `hash-${key}`,
    description: 'Build the product UI.',
    postedAt: null,
    profileScore: 98,
    worldwideSponsorMatch: null,
    ...overrides,
  };
}

function result(key: string, overrides: Partial<SearchResult> = {}): SearchResult {
  return {
    raw: vacancy(key),
    official: null,
    provisional: false,
    key,
    title: 'Senior Frontend Engineer',
    company: 'IT Labs',
    location: 'Remote',
    url: `https://jobs.ashbyhq.com/itlabs/${key}`,
    provider: 'remotive',
    employmentType: null,
    salary: null,
    postedAt: null,
    description: 'Build the product UI.',
    verification: { level: 'not_available', label: 'Not available for this vacancy', tone: null, note: '' },
    profileScore: 98,
    strongPoints: [],
    gaps: [],
    reasons: [],
    lead: { title: 'Senior Frontend Engineer', company: 'IT Labs', location: 'Remote', url: '' },
    ...overrides,
  } as SearchResult;
}

function live(vacancyKey: string, state: PostingLivenessView['state'], extra: Partial<PostingLivenessView> = {}): PostingLivenessView {
  const checked = state === 'open' || state === 'closed';
  return {
    vacancyKey,
    state,
    checkedAt: checked ? CHECKED : null,
    source: checked ? 'ashby' : null,
    sourceRef: checked ? 'api.ashbyhq.com/posting-api/job-board/{board}' : null,
    reason: state === 'closed' ? 'not_listed' : state === 'open' ? 'verified_open' : state === 'unverifiable' ? 'no_authoritative_source' : null,
    checkable: state !== 'unverifiable',
    ...extra,
  };
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('result cards: liveness beside every fit score', () => {
  function renderRows(results: SearchResult[], liveness?: Map<string, PostingLivenessView>) {
    render(
      <SearchResultList
        results={results}
        totalCount={results.length}
        selectedKey={null}
        onSelect={vi.fn()}
        savedKeys={new Set()}
        {...(liveness ? { liveness } : {})}
        summary="rows"
        page={0}
        pageCount={1}
        onPageChange={vi.fn()}
      />,
    );
  }

  it('renders each of the four plain states directly after the score', () => {
    const rows = [result('a'), result('b'), result('c'), result('d')];
    renderRows(
      rows,
      new Map([
        ['a', live('a', 'open')],
        ['b', live('b', 'not_checked')],
        ['c', live('c', 'unverifiable')],
        ['d', live('d', 'closed')],
      ]),
    );
    const expected = ['Open', 'Not checked yet', "Couldn't check", 'Closed/removed'];
    rows.forEach((row, index) => {
      const card = document.querySelector(`[data-result-key="${row.key}"]`) as HTMLElement;
      const score = within(card).getByText('Profile fit 98 out of 100').parentElement!;
      const chip = within(card).getByTestId('posting-liveness');
      expect(chip).toHaveTextContent(expected[index]!);
      // Adjacent: the liveness chip is the score badge's very next sibling.
      expect(score.nextElementSibling).toBe(chip);
    });
  });

  it('every scored card has a state even when nothing is known yet (no fabricated answer)', () => {
    renderRows([result('a'), result('b', { profileScore: 41 })]);
    const chips = screen.getAllByTestId('posting-liveness');
    expect(chips).toHaveLength(2);
    for (const chip of chips) expect(chip).toHaveAttribute('data-state', 'not_checked');
    expect(screen.queryByText('Open')).toBeNull();
  });

  it('no fit score anywhere in the list is without a liveness state', () => {
    const rows = ['a', 'b', 'c', 'd', 'e'].map((key, index) => result(key, { profileScore: index % 2 === 0 ? 90 - index : null }));
    renderRows(rows, new Map([['b', live('b', 'closed')]]));
    for (const row of rows) {
      const card = document.querySelector(`[data-result-key="${row.key}"]`) as HTMLElement;
      const hasScore = within(card).queryByText(/Profile fit \d+ out of 100/u) !== null;
      if (hasScore) expect(within(card).getByTestId('posting-liveness')).toBeInTheDocument();
    }
    // An unscored row shows a state only once a check actually answered.
    const unscoredUnknown = document.querySelector('[data-result-key="d"]') as HTMLElement;
    expect(within(unscoredUnknown).queryByTestId('posting-liveness')).toBeNull();
    const unscoredClosed = document.querySelector('[data-result-key="b"]') as HTMLElement;
    expect(within(unscoredClosed).getByTestId('posting-liveness')).toHaveTextContent('Closed/removed');
  });

  it('uses only the four plain labels, never internal codes', () => {
    expect(Object.values(LIVENESS_LABEL)).toEqual(['Open', 'Not checked yet', "Couldn't check", 'Closed/removed']);
  });
});

describe('vacancy detail: liveness line and the primary action', () => {
  function renderDetail(view: PostingLivenessView | undefined, handlers = { onPrepare: vi.fn(), onPrepareAnyway: vi.fn() }) {
    render(
      <VacancyDetail
        result={result('a')}
        defaultCvName={null}
        saveState="idle"
        prepareState="idle"
        onSave={vi.fn()}
        onPrepare={handlers.onPrepare}
        onPrepareAnyway={handlers.onPrepareAnyway}
        {...(view ? { liveness: view } : {})}
        assistantOpen={false}
        onToggleAssistant={vi.fn()}
        assistant={null}
      />,
    );
    return handlers;
  }

  it('shows the state beside the score, the checked time by default and the source under "How we know"', () => {
    renderDetail(live('a', 'open'));
    const summary = within(screen.getByRole('region', { name: 'Profile fit summary' }));
    expect(summary.getByTestId('posting-liveness')).toHaveTextContent('Open');
    // The chip says the state; the line beside it adds only when.
    expect(summary.getByText('Checked 2 min ago')).toBeInTheDocument();
    expect(summary.getAllByText('Open')).toHaveLength(1);
    expect(summary.getByText('How we know')).toBeInTheDocument();
    expect(summary.getByText(`Checked ${formatCheckedAt(CHECKED)} with Ashby (api.ashbyhq.com).`)).toBeInTheDocument();
    // One place for liveness: the old "check the posting yourself" chore is not repeated below.
    expect(screen.queryByText(/Check the posting before you apply/u)).toBeNull();
  });

  it('a closed posting cannot use the primary action; the override is a separate, secondary button', () => {
    const handlers = renderDetail(live('a', 'closed'));
    const primary = screen.getByRole('button', { name: 'Get ready to apply' });
    expect(primary).toBeDisabled();
    expect(primary).toHaveAccessibleDescription('This posting looks closed or removed.');
    fireEvent.click(primary);
    expect(handlers.onPrepare).not.toHaveBeenCalled();

    const anyway = screen.getByRole('button', { name: 'Prepare anyway' });
    expect(anyway).not.toHaveClass('btn-primary');
    fireEvent.click(anyway);
    expect(handlers.onPrepareAnyway).toHaveBeenCalledTimes(1);
    expect(screen.getByText("The employer's official job board no longer lists this posting.")).toBeInTheDocument();
  });

  it.each(['open', 'not_checked', 'unverifiable'] as const)('a %s posting keeps the primary action and offers no override', (state) => {
    const handlers = renderDetail(live('a', state));
    const primary = screen.getByRole('button', { name: 'Get ready to apply' });
    expect(primary).toBeEnabled();
    fireEvent.click(primary);
    expect(handlers.onPrepare).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('button', { name: 'Prepare anyway' })).toBeNull();
  });

  it('a source that cannot be checked says so plainly, and that it is not closure', () => {
    renderDetail(live('a', 'unverifiable'));
    expect(screen.getByText("Couldn't check")).toBeInTheDocument();
    expect(screen.getByText('This job source cannot be checked automatically.')).toBeInTheDocument();
    expect(screen.getByText('This does not mean the posting is closed.')).toBeInTheDocument();
  });

  it('with nothing known the detail says "Not checked yet", never a time it was not given', () => {
    renderDetail(undefined);
    expect(screen.getByTestId('posting-liveness')).toHaveTextContent('Not checked yet');
    expect(screen.getByTestId('posting-liveness-line').textContent).not.toMatch(/checked \d|ago/iu);
  });

  it('an unscored result carries the state in its line instead', () => {
    render(
      <VacancyDetail
        result={result('a', { profileScore: null })}
        defaultCvName={null}
        saveState="idle"
        prepareState="idle"
        onSave={vi.fn()}
        onPrepare={vi.fn()}
        liveness={live('a', 'closed')}
        assistantOpen={false}
        onToggleAssistant={vi.fn()}
        assistant={null}
      />,
    );
    expect(within(screen.getByTestId('posting-liveness-line')).getByText('Closed/removed · checked 2 min ago')).toBeInTheDocument();
  });
});
