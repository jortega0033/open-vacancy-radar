import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { discoverHimalayas, discoverJobicy, runGlobalRemoteDiscovery } from '../../src/global-remote/discovery.js';
import type { GlobalRemoteConfig } from '../../src/global-remote/models.js';
import { loadGapRecords } from '../../src/global-remote/source-gap-telemetry.js';
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
      navArbeidsplassenApiKey: '',
      navArbeidsplassenMaxPages: 1,
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

describe('runGlobalRemoteDiscovery gap telemetry wiring', () => {
  // Integration test: proves gap records actually get captured from a real discovery run (through
  // the fixture-based discovery test harness, no live network call), not just from the
  // source-gap-telemetry.ts/gap-report.ts unit tests exercising each piece in isolation against
  // hand-built DiscoverySourceAudit fixtures. Issue #9 requires the report to reflect real scan
  // data, so this is what proves `runGlobalRemoteDiscovery` -> `recordDiscoveryGapTelemetry` ->
  // `gap-telemetry.json` is actually wired end to end.
  let projectRoot: string;

  afterEach(async () => {
    await rm(projectRoot, { recursive: true, force: true });
  });

  it('persists a gap record for a source that fails during a real discovery run', async () => {
    projectRoot = await mkdtemp(path.join(tmpdir(), 'ovr-gap-telemetry-'));
    // No fixture routes registered at all: keyed-discovery skips every source outright (no API
    // keys configured, see config() below), and every other source's single unconfigured request
    // hits FixtureHttpClient's "Unexpected fixture URL" -- the same shape of failure a genuinely
    // unsupported/unreachable ATS host would produce, caught by each source's own `sourceFailure`
    // handling and turned into a `status: 'error'` DiscoverySourceAudit.
    const http = new FixtureHttpClient(new Map());

    const result = await runGlobalRemoteDiscovery(http, config({ himalayasQueries: [] }), projectRoot);

    const failedSources = result.sources.filter((source) => source.status !== 'success');
    expect(failedSources.length).toBeGreaterThan(0);
    expect(failedSources.some((source) => source.provider === 'himalayas')).toBe(true);

    const records = await loadGapRecords(projectRoot);
    expect(records.length).toBeGreaterThan(0);
    expect(records.length).toBe(failedSources.length);
    expect(records.some((record) => record.redactedUrl.includes('himalayas.app'))).toBe(true);
  });

  it('aggregates gap records across repeated scans instead of resetting them each run', async () => {
    projectRoot = await mkdtemp(path.join(tmpdir(), 'ovr-gap-telemetry-'));
    const http = new FixtureHttpClient(new Map());

    await runGlobalRemoteDiscovery(http, config({ himalayasQueries: [] }), projectRoot);
    const afterFirstRun = await loadGapRecords(projectRoot);

    await runGlobalRemoteDiscovery(http, config({ himalayasQueries: [] }), projectRoot);
    const afterSecondRun = await loadGapRecords(projectRoot);

    expect(afterSecondRun.length).toBe(afterFirstRun.length * 2);
  });

  it('does not touch disk when no projectRoot is given', async () => {
    const http = new FixtureHttpClient(new Map());

    // Must not throw even though every source fails: telemetry persistence is opt-in via
    // `projectRoot`, and this call omits it entirely.
    const result = await runGlobalRemoteDiscovery(http, config({ himalayasQueries: [] }));

    expect(result.sources.some((source) => source.status !== 'success')).toBe(true);
  });
});
