import { describe, expect, it } from 'vitest';

import { discoverHimalayas, discoverJobicy, runGlobalRemoteDiscovery } from '../../src/global-remote/discovery.js';
import type { GlobalRemoteConfig, ScanProgressEvent } from '../../src/global-remote/models.js';
import { FixtureHttpClient } from '../ats/helpers.js';

function config(overrides: Partial<GlobalRemoteConfig['discovery']> = {}): GlobalRemoteConfig {
  return {
    version: 'test',
    minimumAnnualBaseUsd: null,
    discovery: {
      roleQuery: '',
      himalayasQueries: [],
      himalayasCountry: '',
      himalayasMaxPagesPerQuery: 1,
      jobicyCount: 1,
      freehireLimit: 1,
      jobOpportunitiesLimit: 1,
      remoteLandersMaxPages: 1,
      jobgetherMaxPages: 1,
      remoteFirstMaxPages: 1,
      jobRemotelyMaxPages: 1,
      arbeitnowMaxPages: 1,
      diceMaxPages: 1,
      remooteRoleTitle: '',
      remooteCountry: '',
      remooteLimit: 10,
      aiDevJobsMaxPages: 1,
      museEnabled: false,
      museMaxPages: 1,
      adzunaAppId: '',
      adzunaAppKey: '',
      adzunaMaxPages: 1,
      joobleApiKey: '',
      reedApiKey: '',
      jobspipeApiKey: '',
      ...overrides,
    },
    officialSources: [],
  };
}

describe('discoverHimalayas', () => {
  it('regression: still runs one broad, unfiltered request when himalayasQueries is empty, rather than silently disabling the source', async () => {
    const routes = new Map([
      [
        'https://himalayas.app/jobs/api/search?sort=salaryDesc&page=1',
        JSON.stringify({ jobs: [], totalCount: 0 }),
      ],
    ]);
    const http = new FixtureHttpClient(routes);

    const result = await discoverHimalayas(http, config({ himalayasQueries: [] }));

    expect(result.sources).toHaveLength(1);
    expect(result.sources[0]).toMatchObject({ id: 'himalayas:all-jobs', status: 'success', requests: 1 });
    expect(http.requestedUrls).toEqual(['https://himalayas.app/jobs/api/search?sort=salaryDesc&page=1']);
  });

  it('sends the configured query term and country when set', async () => {
    const routes = new Map([
      [
        'https://himalayas.app/jobs/api/search?q=backend&country=NL&sort=salaryDesc&page=1',
        JSON.stringify({ jobs: [], totalCount: 0 }),
      ],
    ]);
    const http = new FixtureHttpClient(routes);

    const result = await discoverHimalayas(
      http,
      config({ himalayasQueries: ['backend'], himalayasCountry: 'NL' }),
    );

    expect(result.sources[0]).toMatchObject({ id: 'himalayas:backend', status: 'success' });
  });

  it('converts the unix-seconds pubDate to an ISO posting date', async () => {
    const routes = new Map([
      [
        'https://himalayas.app/jobs/api/search?sort=salaryDesc&page=1',
        JSON.stringify({
          jobs: [{
            guid: 'himalayas-1',
            title: 'Frontend Engineer',
            companyName: 'Himalayas Co',
            applicationLink: 'https://himalayas.app/jobs/himalayas-1',
            pubDate: 1788188988,
          }],
          totalCount: 1,
        }),
      ],
    ]);
    const http = new FixtureHttpClient(routes);

    const result = await discoverHimalayas(http, config({ himalayasQueries: [] }));

    expect(result.vacancies).toEqual([
      expect.objectContaining({ provider: 'himalayas', postedAt: '2026-08-31T15:09:48.000Z' }),
    ]);
  });
});

describe('discoverJobicy', () => {
  it('omits the tag parameter entirely when no role is configured', async () => {
    const url = 'https://jobicy.com/api/v2/remote-jobs?count=1';
    const http = new FixtureHttpClient(new Map([[url, JSON.stringify({ jobs: [] })]]));

    const result = await discoverJobicy(http, config());

    expect(result.sources[0]).toMatchObject({ status: 'success' });
    expect(http.requestedUrls).toEqual([url]);
  });

  it('includes the tag parameter when a role is configured', async () => {
    const url = 'https://jobicy.com/api/v2/remote-jobs?count=1&tag=backend';
    const http = new FixtureHttpClient(new Map([[url, JSON.stringify({ jobs: [] })]]));

    const result = await discoverJobicy(http, config({ roleQuery: 'backend' }));

    expect(result.sources[0]).toMatchObject({ status: 'success' });
  });

  it('normalizes the offset-bearing pubDate to an ISO posting date', async () => {
    const url = 'https://jobicy.com/api/v2/remote-jobs?count=1';
    const http = new FixtureHttpClient(new Map([[url, JSON.stringify({
      jobs: [{
        id: 'jobicy-1',
        jobTitle: 'Frontend Engineer',
        companyName: 'Jobicy Co',
        url: 'https://jobicy.com/jobs/jobicy-1',
        pubDate: '2026-08-31T20:08:43+00:00',
      }],
    })]]));

    const result = await discoverJobicy(http, config());

    expect(result.vacancies).toEqual([
      expect.objectContaining({ provider: 'jobicy', postedAt: '2026-08-31T20:08:43.000Z' }),
    ]);
  });
});

describe('runGlobalRemoteDiscovery progress callback (issue #252)', () => {
  /**
   * Proves the exact acceptance criterion "at least one vacancy becomes visible before the scan's
   * own promise resolves" at the engine layer, with real ordering instead of a timing-dependent
   * `setTimeout`: himalayas resolves immediately, jobicy is held open on a deferred this test
   * controls, and every other one of the eight sub-sources has no fixture route registered at all,
   * which is not an error here -- each adapter catches its own network/parse failures internally
   * (see `sourceFailure` throughout global-remote/*.ts) and reports a `'blocked'`/`'error'` status
   * rather than rejecting, the same as a real unreachable source would.
   */
  it('reports a fast source before a still-pending one, strictly before the aggregate promise settles', async () => {
    let releaseJobicy: () => void = () => {};
    const jobicyGate = new Promise<void>((resolve) => {
      releaseJobicy = resolve;
    });

    const routes = new Map<string, string | (() => Promise<string>)>([
      [
        'https://himalayas.app/jobs/api/search?sort=salaryDesc&page=1',
        JSON.stringify({ jobs: [], totalCount: 0 }),
      ],
      [
        'https://jobicy.com/api/v2/remote-jobs?count=1',
        async () => {
          await jobicyGate;
          return JSON.stringify({ jobs: [] });
        },
      ],
    ]);
    const http = new FixtureHttpClient(routes);

    const progress: ScanProgressEvent[] = [];
    const done = runGlobalRemoteDiscovery(http, config({ himalayasQueries: [] }), (event) => {
      progress.push(event);
    });

    // Flush pending microtasks so every source that resolves without waiting on the jobicy gate
    // (himalayas, plus every other source failing fast on its own missing fixture route) has
    // already reported, while jobicy provably has not.
    for (let i = 0; i < 10; i += 1) await Promise.resolve();

    expect(progress.map((event) => event.sourceId)).toContain('himalayas');
    expect(progress.map((event) => event.sourceId)).not.toContain('jobicy');

    releaseJobicy();
    const result = await done;

    const sourceIds = progress.map((event) => event.sourceId);
    expect(sourceIds).toContain('jobicy');
    expect(sourceIds.indexOf('himalayas')).toBeLessThan(sourceIds.indexOf('jobicy'));
    // Every progress event's own `sourceId` shows up exactly once, and only once, across the whole
    // discovery run -- the callback is not fired again on some later, unrelated resolution.
    expect(new Set(sourceIds).size).toBe(sourceIds.length);
    expect(sourceIds.sort()).toEqual(
      ['additional', 'ai_dev_jobs', 'feeds', 'himalayas', 'jobicy', 'jobtech', 'keyed', 'structured'].sort(),
    );

    // Unchanged aggregate contract: `onProgress` is purely an observability hook layered on top,
    // never a second source of truth for the final result.
    expect(result.sources.length).toBeGreaterThan(0);
  });

  it('never calls onProgress when none is supplied (existing non-streaming callers unaffected)', async () => {
    const http = new FixtureHttpClient(
      new Map([
        [
          'https://himalayas.app/jobs/api/search?sort=salaryDesc&page=1',
          JSON.stringify({ jobs: [], totalCount: 0 }),
        ],
        ['https://jobicy.com/api/v2/remote-jobs?count=1', JSON.stringify({ jobs: [] })],
      ]),
    );

    // No third argument at all: the pre-existing call shape every non-streaming caller still uses.
    const result = await runGlobalRemoteDiscovery(http, config({ himalayasQueries: [] }));

    expect(result.sources.length).toBeGreaterThan(0);
  });
});
