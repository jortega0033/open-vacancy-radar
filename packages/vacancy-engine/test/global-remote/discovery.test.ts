import { describe, expect, it } from 'vitest';

import { discoverHimalayas, discoverJobicy } from '../../src/global-remote/discovery.js';
import type { GlobalRemoteConfig } from '../../src/global-remote/models.js';
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
});
