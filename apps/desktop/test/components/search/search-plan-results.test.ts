import type { DiscoveryVacancyAudit, GlobalRemoteReport } from '@open-vacancy-radar/vacancy-engine';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_FILTERS,
  filterResults,
  reportSearchContext,
  sortResults,
  toWorldwideResults,
  withReportQueryAlternatives,
} from '../../../src/components/search/results.js';
import {
  describeLeadQueries,
  describeSearchPlanDiagnostics,
  searchPlanCoverageNotice,
  searchPlanStatusNotice,
} from '../../../src/components/search/search-plan-view.js';

function lead(overrides: Partial<DiscoveryVacancyAudit>): DiscoveryVacancyAudit {
  return {
    key: 'k',
    provider: 'jobicy',
    company: 'Acme',
    title: 'Frontend Engineer',
    url: 'https://example.com/job',
    location: 'Netherlands',
    employmentType: null,
    currency: null,
    salaryPeriod: null,
    advertisedMinimum: null,
    annualizedMinimumUsd: null,
    decision: 'official_review_candidate',
    reasons: [],
    contentHash: 'h',
    description: null,
    postedAt: null,
    profileScore: null,
    worldwideSponsorMatch: null,
    ...overrides,
  };
}

const LEADS = [
  lead({ key: 'a', title: 'React Developer', url: 'https://example.com/a' }),
  lead({ key: 'b', title: 'Frontend Engineer', url: 'https://example.com/b' }),
  lead({ key: 'c', title: 'Senior UI Engineer', url: 'https://example.com/c' }),
  lead({ key: 'd', title: 'Backend Engineer', url: 'https://example.com/d' }),
];

function reportWithPlan(overrides: Partial<NonNullable<GlobalRemoteReport['searchPlan']>> = {}): GlobalRemoteReport {
  return {
    runId: 'r1',
    generatedAt: '2026-10-29T10:00:00.000Z',
    scanBounds: { mode: 'focused', resultCap: null, resultCountBeforeCap: 3, complete: true, completenessReason: null },
    discoverySources: [
      {
        id: 'jobicy:frontend',
        provider: 'jobicy',
        focusedScan: {
          requested: { role: 'React developer' },
          applied: [],
          deferred: [],
          unsupported: [],
          searchPlan: [
            { variantId: 'literal', query: 'React developer', language: null, handling: 'sent_upstream', reason: null },
            { variantId: 'ui', query: 'UI engineer', language: null, handling: 'deferred_request_budget', reason: 'spent' },
          ],
        },
      },
    ],
    officialAudit: [],
    discoveryAudit: LEADS.slice(0, 3),
    searchPlan: {
      planRevision: 2,
      primaryFunction: 'Frontend engineering',
      markets: [],
      workingLanguages: ['Dutch'],
      queries: [
        { variantId: 'literal', query: 'React developer', language: null },
        { variantId: 'frontend-engineer', query: 'Frontend engineer', language: null },
        { variantId: 'ui-engineer', query: 'UI engineer', language: null },
      ],
      literal: { handling: 'sent_upstream', reason: null, attempts: 14, providersQueried: ['jobicy'], providersNotAsked: [] },
      variants: [
        { variantId: 'frontend-engineer', query: 'Frontend engineer', language: null, handling: 'sent_upstream', reason: null, attempts: 4, providersQueried: ['jobicy'], providersNotAsked: [] },
        { variantId: 'ui-engineer', query: 'UI engineer', language: null, handling: 'deferred_request_budget', reason: 'Not searched at the sources: the plan had used its whole shared request allowance before this title was reached.', attempts: 0, providersQueried: [], providersNotAsked: ['jobicy'] },
      ],
      envelope: { maxRequests: 18, maxDurationMs: 120_000, maxResults: 1_500 },
      budgetScope: { unit: 'network_attempt', includes: 'everything the plan searched', excludes: 'Sponsor-registry lookups.' },
      usage: { attempts: 18, literalAttempts: 14, variantAttempts: 4, refusedCalls: 1, refusedFollowUps: 0, elapsedMs: 900, matchingRows: 3, trimmedRows: 0, outsideEnvelopeAttempts: 2 },
      criteria: [{ criterion: 'markets', value: 'Netherlands', treatment: 'not_applied', reason: 'Plan markets do not filter searches.' }],
      providersNeverAsked: [],
      coverage: 'partial',
      coverageReason: '1 of 2 approved titles were not fully searched at the sources within the shared allowance.',
      ...overrides,
    },
  } as unknown as GlobalRemoteReport;
}

describe('the results list agrees with the scan about which titles are equally good (#686)', () => {
  it('keeps a row found under another approved title instead of hiding it behind the typed query', () => {
    const results = toWorldwideResults(reportWithPlan());
    expect(filterResults(results, { ...DEFAULT_FILTERS, query: 'React developer' }).map((r) => r.title)).toEqual(['React Developer']);
    const either = filterResults(results, {
      ...DEFAULT_FILTERS,
      query: 'React developer',
      queryAlternatives: ['Frontend engineer', 'UI engineer'],
    });
    expect(either.map((r) => r.title).sort()).toEqual(['Frontend Engineer', 'React Developer', 'Senior UI Engineer']);
    // An approved title only mentioned in a description is not a match (the engine's rule), while the typed
    // query keeps matching descriptions as before.
    const backend = filterResults(
      toWorldwideResults({
        ...reportWithPlan(),
        discoveryAudit: [lead({ key: 'm', title: 'Backend Engineer', url: 'https://example.com/m', description: 'Pairs with our UI engineer colleagues.' })],
      } as GlobalRemoteReport),
      { ...DEFAULT_FILTERS, query: 'React developer', queryAlternatives: ['UI engineer'] },
    );
    expect(backend).toEqual([]);
    expect(sortResults(either, 'React developer').map((r) => r.title)).toContain('Senior UI Engineer');
  });

  it('takes the alternatives from the report only when the applied query is the one the report ran', () => {
    const report = reportWithPlan();
    expect(withReportQueryAlternatives({ ...DEFAULT_FILTERS, query: ' react DEVELOPER ' }, report).queryAlternatives).toEqual([
      'Frontend engineer',
      'UI engineer',
    ]);
    expect(withReportQueryAlternatives({ ...DEFAULT_FILTERS, query: 'something else' }, report).queryAlternatives).toBeUndefined();
    const filters = { ...DEFAULT_FILTERS, query: 'React developer' };
    expect(withReportQueryAlternatives(filters, null)).toBe(filters);
    expect(reportSearchContext(report).alternatives).toEqual(['Frontend engineer', 'UI engineer']);
  });
});

describe('search plan descriptions (#686)', () => {
  it('says which approved title found a lead, in which language, and whether the source returned it', () => {
    expect(
      describeLeadQueries({
        queryProvenance: {
          planRevision: 2,
          matchedLocally: [{ variantId: 'v', query: 'Frontend ontwikkelaar', language: 'Dutch' }],
          fetchedBy: [{ variantId: 'v', query: 'Frontend ontwikkelaar', language: 'Dutch', provider: 'jobicy' }],
        },
      }),
    ).toBe('Frontend ontwikkelaar (Dutch). Returned by the source for: Frontend ontwikkelaar (Dutch) at Jobicy');
    expect(
      describeLeadQueries({
        queryProvenance: { planRevision: 2, matchedLocally: [{ variantId: 'literal', query: 'React developer', language: null }], fetchedBy: [] },
      }),
    ).toBe('React developer. Matched in the source feed, which cannot filter by title');
    expect(
      describeLeadQueries({
        queryProvenance: {
          planRevision: 2,
          matchedLocally: [{ variantId: 'literal', query: 'React developer', language: null, field: 'description' }],
          fetchedBy: [],
        },
      }),
    ).toBe('React developer (mentioned only in the description). Matched in the source feed, which cannot filter by title');
    expect(describeLeadQueries({})).toBeNull();
    expect(describeLeadQueries({ queryProvenance: { planRevision: 1, matchedLocally: 'broken' } as never })).toBeNull();
  });

  it('warns only when coverage is partial, naming the titles that were not fully searched', () => {
    expect(searchPlanCoverageNotice(reportWithPlan())).toContain('1 of 2 approved titles (UI engineer) could not be fully searched');
    expect(
      searchPlanCoverageNotice(
        reportWithPlan({ literal: { handling: 'partial', reason: 'cut', attempts: 18, providersQueried: [], providersNotAsked: [] } }),
      ),
    ).toContain('the typed query was only partly searched and 1 of 2');
    expect(searchPlanCoverageNotice(reportWithPlan({ coverage: 'complete', coverageReason: null }))).toBeNull();
    expect(searchPlanCoverageNotice({})).toBeNull();
    expect(searchPlanCoverageNotice(null)).toBeNull();
  });

  it('puts the allowance, its use, each title and each source into the copied diagnostics', () => {
    const lines = describeSearchPlanDiagnostics(reportWithPlan());
    expect(lines[0]).toContain('Search plan revision 2');
    expect(lines[0]).toContain('One shared allowance for the whole plan: 18 network requests (each retry and redirect counted)');
    expect(lines[0]).toContain('used 18 (14 typed query, 4 approved titles), 1 requests not made');
    expect(lines.join('\n')).toContain('Outside the allowance (2 network requests): Sponsor-registry lookups.');
    expect(lines.join('\n')).toContain('Typed query: searched at the source');
    expect(lines.join('\n')).toContain('Frontend engineer: searched at the source; asked at Jobicy');
    expect(lines.join('\n')).toContain('UI engineer: not searched: request allowance used up');
    expect(lines.join('\n')).toContain('markets "Netherlands": not applied (Plan markets do not filter searches.)');
    expect(lines.join('\n')).toContain('Jobicy (jobicy:frontend): searched at the source: React developer; not searched: request allowance used up: UI engineer');
    expect(describeSearchPlanDiagnostics({ discoverySources: [] })).toEqual([]);
    expect(
      describeSearchPlanDiagnostics({
        discoverySources: [],
        searchPlanStatus: { state: 'empty_at_start', message: 'Your search plan had no approved titles when this search started.' },
      }),
    ).toEqual(['Search plan not used: Your search plan had no approved titles when this search started.']);
    expect(searchPlanStatusNotice({ searchPlanStatus: { state: 'unreadable', message: 'damaged' } })).toBe('damaged');
    expect(searchPlanStatusNotice({})).toBeNull();
  });
});
