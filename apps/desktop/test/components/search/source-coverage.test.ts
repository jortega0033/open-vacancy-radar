import type { GlobalRemoteReport } from '@open-vacancy-radar/vacancy-engine';
import { describe, expect, it } from 'vitest';
import { isRosterMissing, summarizeSourceCoverage } from '../../../src/components/search/source-coverage.js';

type Source = GlobalRemoteReport['discoverySources'][number];

function source(overrides: Partial<Source> = {}): Source {
  return {
    id: 'remotive:all',
    provider: 'remotive',
    url: 'https://example.test/feed',
    requests: 1,
    listings: 3,
    status: 'success',
    error: null,
    networkAttempts: 1,
    retries: 0,
    complete: true,
    completenessReason: null,
    continuationCursor: null,
    ...overrides,
  };
}

describe('summarizeSourceCoverage', () => {
  it('reports nothing to warn about when every source finished', () => {
    const coverage = summarizeSourceCoverage([source(), source({ id: 'jobicy:all', provider: 'jobicy' })]);
    expect(coverage.warnings).toEqual([]);
    expect(coverage.groups).toEqual([]);
    expect(coverage.completeCount).toBe(2);
    expect(coverage.rosterMissing).toBe(false);
  });

  it('separates failed, stopped-early and not-set-up sources with counts that match the run data', () => {
    const coverage = summarizeSourceCoverage([
      source(),
      source({ id: 'jobicy:all', provider: 'jobicy', status: 'partial', complete: false, completenessReason: 'page cap' }),
      source({ id: 'dice:all', provider: 'dice', status: 'error', complete: false, error: 'HTTP 500' }),
      source({ id: 'reed:all', provider: 'reed', status: 'blocked', complete: false }),
      source({ id: 'adzuna:all', provider: 'adzuna', status: 'success', complete: false, completenessReason: 'result cap' }),
      source({
        id: 'ats_roster_lever:roster-scan',
        provider: 'ats_roster_lever',
        requests: 0,
        listings: 0,
        error: 'No imported roster entries for this provider yet; run the ats-roster:import CLI command first.',
      }),
    ]);
    expect(coverage.warnings).toHaveLength(5);
    expect(coverage.completeCount).toBe(1);
    expect(coverage.rosterMissing).toBe(true);
    expect(coverage.groups.map((group) => [group.kind, group.providers.length])).toEqual([
      ['not_set_up', 1],
      ['failed', 2],
      ['incomplete', 2],
    ]);
    expect(coverage.summary).toBe('5 sources returned partial or no results. Results from the other source are complete.');
  });

  it('groups repeated provider names with feed counts', () => {
    const coverage = summarizeSourceCoverage([
      source(),
      source({ id: 'jobicy:all-1', provider: 'jobicy', status: 'partial', complete: false }),
      source({ id: 'jobicy:all-2', provider: 'jobicy', status: 'partial', complete: false }),
      source({ id: 'dice:roster', provider: 'dice', status: 'error', complete: false, error: 'HTTP 500' }),
      source({ id: 'dice:all', provider: 'dice', status: 'error', complete: false, error: 'HTTP 500' }),
    ]);
    expect(coverage.warnings).toHaveLength(4);
    const incompleteGroup = coverage.groups.find((g) => g.kind === 'incomplete');
    expect(incompleteGroup).toBeDefined();
    expect(incompleteGroup?.providers).toEqual([{ name: 'Jobicy', count: 2 }]);
    const failedGroup = coverage.groups.find((g) => g.kind === 'failed');
    expect(failedGroup).toBeDefined();
    expect(failedGroup?.providers).toEqual([{ name: 'Dice', count: 2 }]);
  });

  it('does not claim other sources are complete when every source needs attention', () => {
    const coverage = summarizeSourceCoverage([source({ status: 'error', complete: false })]);
    expect(coverage.summary).toBe('1 source returned partial or no results.');
  });
});

describe('isRosterMissing', () => {
  it('flags an empty roster run by its roster size or its message, and not an ordinary empty source', () => {
    const roster = { id: 'ats_roster_ashby:roster-scan', provider: 'ats_roster_ashby' as const, requests: 0, listings: 0 };
    expect(isRosterMissing(source({ ...roster, error: 'No imported roster entries for this provider yet; run it.' }))).toBe(true);
    expect(
      isRosterMissing(
        source({
          ...roster,
          rosterScan: {
            mode: 'complete',
            totalRosterSize: 0,
            dueSourcesAttempted: 0,
            explorationSourcesAttempted: 0,
            newlyVerifiedSources: 0,
            skippedNotDue: 0,
            failuresByCategory: {},
            checkpoint: 0,
          },
        }),
      ),
    ).toBe(true);
    expect(isRosterMissing(source({ listings: 0 }))).toBe(false);
    expect(isRosterMissing(source({ ...roster, requests: 4, listings: 9 }))).toBe(false);
  });
});
