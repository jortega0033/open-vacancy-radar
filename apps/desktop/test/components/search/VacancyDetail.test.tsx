import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { VacancyDetail } from '../../../src/components/search/VacancyDetail.js';
import type { SearchResult } from '../../../src/components/search/results.js';

function worldwideResult(overrides: Partial<SearchResult> = {}): SearchResult {
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
    verification: { level: 'not_available', label: 'Not available for this market', tone: null, note: '' },
    profileScore: null,
    strongPoints: [],
    gaps: [],
    reasons: [],
    lead: { title: 'Remote Frontend Engineer', company: 'Acme Corp', location: 'Worldwide', url: 'https://example.invalid/jobs/ww-1' },
    ...overrides,
  } as SearchResult;
}

function renderDetail(result: SearchResult) {
  render(
    <VacancyDetail
      result={result}
      sponsorSource={null}
      runId="run-1"
      defaultCvName={null}
      saveState="idle"
      onSave={vi.fn()}
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
});
