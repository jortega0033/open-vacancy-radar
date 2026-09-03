import { fireEvent, render, screen } from '@testing-library/react';
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

type NetherlandsRaw = Extract<SearchResult, { market: 'netherlands' }>['raw'];

function netherlandsResult(rawOverrides: Partial<NetherlandsRaw> = {}): SearchResult {
  const raw: NetherlandsRaw = {
    id: 'nl-1',
    title: 'Senior Backend Engineer',
    description: 'Build the payments platform.',
    company: 'Redwood',
    location: 'Amsterdam',
    remote: false,
    workplaceMode: 'hybrid',
    provider: 'greenhouse',
    url: 'https://example.invalid/jobs/nl-1',
    sponsorLegalNames: ['Redwood B.V.'],
    mappingConfidence: 'high',
    firstSeenAt: '2026-08-01T00:00:00.000Z',
    lastSeenAt: '2026-08-28T00:00:00.000Z',
    postedAt: '2026-08-20T00:00:00.000Z',
    verifiedInRun: true,
    sourceOutcomeStatus: 'succeeded',
    ...rawOverrides,
  };

  return {
    market: 'netherlands',
    raw,
    key: raw.id,
    title: raw.title,
    company: raw.company,
    location: raw.location,
    url: raw.url,
    provider: raw.provider,
    arrangement: 'Hybrid',
    arrangementValue: 'hybrid',
    employmentType: null,
    salary: null,
    postedAt: raw.postedAt,
    description: raw.description,
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
    lead: { title: raw.title, company: raw.company, location: 'Amsterdam', url: raw.url },
  };
}

function renderDetail(result: SearchResult, overrides: { onGenerateLetter?: () => void } = {}) {
  render(
    <VacancyDetail
      result={result}
      sponsorSource={null}
      runId="run-1"
      defaultCvName={null}
      saveState="idle"
      onSave={vi.fn()}
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

  it('offers "Generate Letter" alongside "Save job", firing the handler on click', () => {
    const onGenerateLetter = vi.fn();
    renderDetail(worldwideResult(), { onGenerateLetter });

    expect(screen.getByRole('button', { name: 'Save job' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Generate Letter' }));

    expect(onGenerateLetter).toHaveBeenCalledTimes(1);
  });

  it('labels a cross-company duplicate as a suggestion while keeping the row fully usable', () => {
    renderDetail(netherlandsResult({ duplicateGroup: {
      groupId: 'group-1',
      otherVacancyIds: ['nl-2'],
      otherCompanies: ['Redwood Netherlands B.V.'],
    } }));

    expect(screen.getByText('Possibly also posted under 1 other company record')).toBeInTheDocument();
    expect(screen.getByText(/not a confirmed link between employers/i)).toBeInTheDocument();
    expect(screen.getByText(/kept as its own result/i)).toBeInTheDocument();
    // The signal is posting text and nothing else, so the copy must say that and must not imply
    // that two similar-looking company names contributed. See cross-company-duplicates.ts v3.
    expect(screen.getByText(/local comparison of the posting text only/i)).toBeInTheDocument();
    expect(screen.getByText(/company names were not used/i)).toBeInTheDocument();
    expect(screen.queryByText(/similarly named|similar name|name similarity/i)).not.toBeInTheDocument();
    // Nothing about the row is disabled or withheld by the grouping.
    expect(screen.getByRole('button', { name: 'Save job' })).toBeEnabled();
    expect(screen.getByRole('link', { name: 'Open job' })).toHaveAttribute(
      'href',
      'https://example.invalid/jobs/nl-1',
    );
  });

  it('says nothing about duplicates for a row with no group', () => {
    renderDetail(netherlandsResult());

    expect(screen.queryByText(/possibly also posted under/i)).not.toBeInTheDocument();
  });
});
