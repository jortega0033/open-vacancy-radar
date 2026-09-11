import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
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
  overrides: { onGenerateLetter?: () => void; providerLabel?: string; prepareAvailable?: boolean } = {},
) {
  render(
    <VacancyDetail
      result={result}
      defaultCvName={null}
      providerLabel={overrides.providerLabel ?? 'Claude Code'}
      saveState="idle"
      prepareState="idle"
      prepareAvailable={overrides.prepareAvailable ?? true}
      onSave={vi.fn()}
      onPrepare={vi.fn()}
      onGenerateLetter={overrides.onGenerateLetter ?? vi.fn()}
      assistantOpen={false}
      onToggleAssistant={vi.fn()}
      assistant={null}
    />,
  );
}

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

  it('offers application preparation, letter generation and saving from the vacancy', () => {
    const onGenerateLetter = vi.fn();
    renderDetail(worldwideResult(), { onGenerateLetter });

    expect(screen.getByRole('button', { name: 'Save job' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Prepare application' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Generate Letter' }));

    expect(onGenerateLetter).toHaveBeenCalledTimes(1);
  });

  it('holds preparation until a streamed vacancy belongs to the final report', () => {
    renderDetail(worldwideResult(), { prepareAvailable: false });
    expect(screen.getByRole('button', { name: 'Finishing scan…' })).toBeDisabled();
  });

  it("names the actually-configured provider in the CV match card, not a hardcoded Claude Code", () => {
    renderDetail(worldwideResult(), { providerLabel: 'Codex' });

    expect(screen.getByText(/your own Codex CLI/)).toBeInTheDocument();
    expect(screen.queryByText(/Claude Code CLI/)).not.toBeInTheDocument();
  });
});
