import { useState } from 'react';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { VacancyDetail } from '../../../src/components/search/VacancyDetail.js';
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
    verification: { level: 'not_available', label: 'Not available for this vacancy', tone: null, note: '' },
    profileScore: null,
    strongPoints: [],
    gaps: [],
    reasons: [],
    lead: { title: 'Remote Frontend Engineer', company: 'Acme Corp', location: 'Worldwide', url: 'https://example.invalid/jobs/ww-1' },
    ...overrides,
  } as SearchResult;
}

function renderDetail(
  result: SearchResult,
  overrides: { prepareAvailable?: boolean } = {},
) {
  render(
    <VacancyDetail
      result={result}
      defaultCvName={null}
      saveState="idle"
      prepareState="idle"
      prepareAvailable={overrides.prepareAvailable ?? true}
      onSave={vi.fn()}
      onPrepare={vi.fn()}
      assistantOpen={false}
      onToggleAssistant={vi.fn()}
      assistant={null}
    />,
  );
}

describe('VacancyDetail work arrangement hint (#565a)', () => {
  it('names the setup and quotes the wording it rests on', () => {
    renderDetail(
      worldwideResult({
        workArrangement: { arrangement: 'hybrid', evidence: 'Office three days per week' },
      }),
    );
    expect(screen.getByText('Work setup')).toBeInTheDocument();
    const text = screen.getByText(/going by the posting/).textContent ?? '';
    expect(text).toBe('Hybrid, going by the posting: "Office three days per week"');
    expect(text).not.toContain('—');
  });

  it('shows no line when nothing was detected', () => {
    renderDetail(worldwideResult({ workArrangement: { arrangement: 'unknown', evidence: null } }));
    expect(screen.queryByText('Work setup')).not.toBeInTheDocument();
  });
});

describe('VacancyDetail', () => {
  it('shows the description text when the source provided one', () => {
    renderDetail(worldwideResult({ description: 'Join our fully-remote engineering team.' }));

    expect(screen.getByText('Join our fully-remote engineering team.')).toBeInTheDocument();
  });

  it('names the source, rather than blaming the pipeline, when it provided no description text', () => {
    renderDetail(worldwideResult({ description: null, provider: 'remotive' }));

    expect(screen.getByText(/remotive did not include description text/i)).toBeInTheDocument();
  });

  // UX audit finding: the "Vacancy source" card and the Overview "Source" field both rendered the
  // raw snake_case `DiscoveryProvider` id (e.g. "devitjobs_uk") instead of a human label.
  it('shows a human-readable provider label, not the raw snake_case id, in the source card and Overview', () => {
    renderDetail(worldwideResult({ provider: 'devitjobs_uk', description: null }));

    expect(screen.getAllByText('DevITjobs UK').length).toBeGreaterThan(0);
    expect(screen.queryByText('devitjobs_uk')).not.toBeInTheDocument();
    expect(screen.getByText(/DevITjobs UK did not include description text/i)).toBeInTheDocument();
  });

  it('offers application preparation and saving from the vacancy', () => {
    renderDetail(worldwideResult());

    expect(screen.getByRole('button', { name: 'Save job' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Start application' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Compare with my CV' })).toBeInTheDocument();
  });

  it('holds preparation until a streamed vacancy belongs to the final report', () => {
    renderDetail(worldwideResult(), { prepareAvailable: false });
    expect(screen.getByRole('button', { name: 'Finishing scan…' })).toBeDisabled();
  });

  describe('profile-score breakdown (issue #367)', () => {
    it('shows the honest unscored state, and no breakdown, when profileScore is null', () => {
      renderDetail(worldwideResult({ profileScore: null }));

      expect(within(screen.getByRole('region', { name: 'Profile score breakdown' })).getByText(/not scored yet/i)).toBeInTheDocument();
      expect(screen.queryByText(/Profile fit: \d+ out of 100/i)).not.toBeInTheDocument();
    });

    it("renders the scorer's preserved breakdown -- matching signals and gaps, without engine reasons or role classification", () => {
      renderDetail(
        worldwideResult({
          profileScore: 82,
          profileMatch: {
            technicalFit: 90,
            roleFit: 85,
            seniorityFit: 70,
            primaryFit: 'Frontend Engineer',
            matchingSkills: ['Angular', 'TypeScript'],
            gaps: ['Advertised seniority is below the candidate’s experience'],
            reasons: ['Technical fit (90): strong match on Angular and TypeScript.'],
            unmetMandatoryLanguages: [],
          },
        }),
      );

      // The full breakdown. The compact summary above it repeats some of these, so scope to it.
      const breakdown = within(screen.getByRole('region', { name: 'Profile score breakdown' }));
      expect(breakdown.getByText(/Profile fit: 82 out of 100\./)).toBeInTheDocument();
      expect(breakdown.queryByText('Frontend Engineer')).not.toBeInTheDocument();
      expect(breakdown.getByText('Angular')).toBeInTheDocument();
      expect(breakdown.getByText('TypeScript')).toBeInTheDocument();
      expect(breakdown.getByText('Advertised seniority is below the candidate’s experience')).toBeInTheDocument();
      expect(breakdown.queryByText('Technical fit (90): strong match on Angular and TypeScript.')).not.toBeInTheDocument();
    });

    it('shows the explicit older-report fallback, never fabricating a breakdown, when profileScore exists but profileMatch does not', () => {
      renderDetail(worldwideResult({ profileScore: 82 }));

      expect(screen.getByText(/details not available/i)).toBeInTheDocument();
      expect(screen.queryByText(/Profile fit: \d+ out of 100/i)).not.toBeInTheDocument();
    });
  });
});

const FULL_BREAKDOWN = {
  technicalFit: 90,
  roleFit: 85,
  seniorityFit: 70,
  primaryFit: 'Frontend Engineer',
  matchingSkills: ['Angular', 'TypeScript', 'RxJS', 'Playwright', 'Storybook'],
  gaps: ['Gap one', 'Gap two', 'Gap three'],
  reasons: ['Technical fit (90): strong match.'],
  unmetMandatoryLanguages: [],
};

describe('VacancyDetail fit summary (issues #452, #465)', () => {
  it('shows the score with its scale, the three fit chips, the top three signals and the top two gaps', () => {
    renderDetail(worldwideResult({ profileScore: 98, profileMatch: FULL_BREAKDOWN }));

    const summary = within(screen.getByRole('region', { name: 'Profile fit summary' }));
    expect(summary.getByText('98/100')).toBeInTheDocument();
    expect(summary.getByText('Profile fit 98 out of 100')).toHaveClass('sr-only');
    expect(summary.getByText('Technical fit 90')).toBeInTheDocument();
    expect(summary.getByText('Role fit 85')).toBeInTheDocument();
    expect(summary.getByText('Seniority fit 70')).toBeInTheDocument();
    expect(summary.getAllByRole('listitem').map((item) => item.textContent)).toEqual([
      'Angular',
      'TypeScript',
      'RxJS',
      'Gap one',
      'Gap two',
    ]);
    expect(summary.queryByText('Playwright')).not.toBeInTheDocument();
    expect(summary.queryByText('Gap three')).not.toBeInTheDocument();
  });

  it('shows only what the scorer returned: no gaps section and one signal when that is all there is', () => {
    renderDetail(
      worldwideResult({ profileScore: 70, profileMatch: { ...FULL_BREAKDOWN, matchingSkills: ['Angular'], gaps: [] } }),
    );

    const summary = within(screen.getByRole('region', { name: 'Profile fit summary' }));
    expect(summary.getAllByRole('listitem')).toHaveLength(1);
    expect(summary.queryByText('Top gaps')).not.toBeInTheDocument();
  });

  it('says "Not scored yet" for an unscored vacancy and never shows a zero or a scale', () => {
    renderDetail(worldwideResult({ profileScore: null }));

    const summary = within(screen.getByRole('region', { name: 'Profile fit summary' }));
    expect(summary.getByText('Not scored yet')).toBeInTheDocument();
    expect(summary.queryByText(/\/100/)).not.toBeInTheDocument();
    expect(summary.queryByRole('listitem')).not.toBeInTheDocument();
  });

  it('shows the bare score, with no invented chips, for an older report that has no breakdown', () => {
    renderDetail(worldwideResult({ profileScore: 82 }));

    const summary = within(screen.getByRole('region', { name: 'Profile fit summary' }));
    expect(summary.getByText('82/100')).toBeInTheDocument();
    expect(summary.queryByText(/Technical fit/)).not.toBeInTheDocument();
  });

  it('puts the full breakdown above the job description', () => {
    renderDetail(worldwideResult({ profileScore: 82, profileMatch: FULL_BREAKDOWN, description: 'A long posting.' }));

    const breakdown = screen.getByRole('region', { name: 'Profile score breakdown' });
    const description = screen.getByText('A long posting.');
    expect(breakdown.compareDocumentPosition(description) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('keeps the CV card honest and gives it no second control for the assistant', () => {
    renderDetail(worldwideResult());

    expect(screen.getByText('Not compared to your CV yet')).toBeInTheDocument();
    expect(screen.queryByText('Manual review')).not.toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: /compare with my cv/i })).toHaveLength(1);
    expect(screen.queryByRole('button', { name: /analyse against my cv/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /use for ai/i })).not.toBeInTheDocument();
  });
});

describe('VacancyDetail employer verification (issue #465)', () => {
  const absentNote = 'No sponsor register match was found. That is an absent check, not a negative result.';

  it('takes one line, with the explanation behind an info toggle and shown once when opened', () => {
    renderDetail(
      worldwideResult({
        verification: { level: 'not_available', label: 'Not available for this vacancy', tone: null, note: absentNote },
      }),
    );

    expect(screen.getByText('Employer verification: none for this vacancy')).toBeInTheDocument();
    expect(screen.queryByText(absentNote)).not.toBeInTheDocument();
    expect(screen.queryByText('Not available for this vacancy')).not.toBeInTheDocument();

    const toggle = screen.getByRole('button', { name: 'About employer verification' });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    fireEvent.click(toggle);

    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getAllByText(absentNote)).toHaveLength(1);
    expect(screen.queryByText(/employer verification is not available/i)).not.toBeInTheDocument();
  });

  it('still shows a prominent card, with its label and note, for a possible sponsor match', () => {
    renderDetail(
      worldwideResult({
        verification: {
          level: 'possible_sponsor_match',
          label: 'Possible sponsor match (best effort)',
          tone: 'warning',
          note: 'A best-effort name search matched this employer to Acme Nederland B.V.',
        },
      }),
    );

    expect(screen.getByText('Possible sponsor match (best effort)')).toBeInTheDocument();
    expect(screen.getByText('A best-effort name search matched this employer to Acme Nederland B.V.')).toBeInTheDocument();
    expect(screen.queryByText('Employer verification: none for this vacancy')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'About employer verification' })).not.toBeInTheDocument();
  });
});

function AssistantHarness({ onScrollTopChange }: { onScrollTopChange?: (top: number) => void }) {
  const [open, setOpen] = useState(false);
  return (
    <VacancyDetail
      result={worldwideResult()}
      defaultCvName={null}
      saveState="idle"
      prepareState="idle"
      onSave={vi.fn()}
      onPrepare={vi.fn()}
      assistantOpen={open}
      onToggleAssistant={() => setOpen((current) => !current)}
      {...(onScrollTopChange ? { onScrollTopChange } : {})}
      assistant={
        <div>
          <h2>CV assistant</h2>
          <button type="button" onClick={() => setOpen(false)}>
            Back to vacancy
          </button>
        </div>
      }
    />
  );
}

describe('VacancyDetail CV assistant opening (issue #453)', () => {
  const originalScrollIntoView = HTMLElement.prototype.scrollIntoView;
  afterEach(() => {
    HTMLElement.prototype.scrollIntoView = originalScrollIntoView;
  });

  it('opens from one control whose label follows the state', () => {
    render(<AssistantHarness />);

    const opener = screen.getByRole('button', { name: 'Compare with my CV' });
    expect(opener).toHaveAttribute('aria-expanded', 'false');
    fireEvent.click(opener);

    expect(screen.getByRole('button', { name: 'Hide CV assistant' })).toHaveAttribute('aria-expanded', 'true');
    expect(screen.queryByRole('button', { name: 'Compare with my CV' })).not.toBeInTheDocument();
  });

  it('focuses the assistant heading and scrolls only the details pane, never the shell (#550)', () => {
    const scrollIntoView = vi.fn();
    HTMLElement.prototype.scrollIntoView = scrollIntoView;
    render(<AssistantHarness />);

    fireEvent.click(screen.getByRole('button', { name: 'Compare with my CV' }));

    const heading = screen.getByRole('heading', { name: 'CV assistant' });
    expect(heading).toHaveFocus();
    expect(scrollIntoView).not.toHaveBeenCalled();
  });

  it('on close restores the earlier scroll position and returns focus to the opener, whichever control closed it', () => {
    HTMLElement.prototype.scrollIntoView = vi.fn();
    const onScrollTopChange = vi.fn();
    render(<AssistantHarness onScrollTopChange={onScrollTopChange} />);
    const pane = screen.getByLabelText('Vacancy details');
    let top = 340;
    Object.defineProperty(pane, 'scrollTop', { configurable: true, get: () => top, set: (value: number) => { top = value; } });

    fireEvent.click(screen.getByRole('button', { name: 'Compare with my CV' }));
    top = 1200; // the pane scrolled down to the assistant
    fireEvent.click(screen.getByRole('button', { name: 'Back to vacancy' }));

    expect(top).toBe(340);
    expect(onScrollTopChange).toHaveBeenLastCalledWith(340);
    expect(screen.getByRole('button', { name: 'Compare with my CV' })).toHaveFocus();
  });

  it('does not steal focus when the pane renders with the assistant already open', () => {
    HTMLElement.prototype.scrollIntoView = vi.fn();
    render(
      <VacancyDetail
        result={worldwideResult()}
        defaultCvName={null}
        saveState="idle"
        prepareState="idle"
        onSave={vi.fn()}
        onPrepare={vi.fn()}
        assistantOpen
        onToggleAssistant={vi.fn()}
        assistant={<h2>CV assistant</h2>}
      />,
    );

    expect(screen.getByRole('heading', { name: 'CV assistant' })).not.toHaveFocus();
  });
});
