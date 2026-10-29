import { describe, expect, it } from 'vitest';

import type { AtsHttpResponse } from '../../src/ats/http.js';
import type { AtsRosterEntry } from '../../src/companies/ats-roster-source.js';
import { runAtsRosterDiscovery } from '../../src/global-remote/ats-roster-discovery.js';
import type { GlobalRemoteConfig } from '../../src/global-remote/models.js';
import { FixtureHttpClient } from '../ats/helpers.js';

function config(atsRosterConcurrency = 4): GlobalRemoteConfig {
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
      taiwanJobsMaxCities: 1,
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
      atsRosterConcurrency,
    },
    officialSources: [],
  };
}

const greenhouseEntry: AtsRosterEntry = {
  provider: 'greenhouse',
  slug: 'acme',
  baseUrl: 'https://job-boards.greenhouse.io',
  company: 'Acme Corp',
};
const leverEntry: AtsRosterEntry = {
  provider: 'lever',
  slug: 'widgets',
  baseUrl: 'https://jobs.lever.co',
  company: 'Widgets Inc',
};

const greenhouseListUrl = 'https://boards-api.greenhouse.io/v1/boards/acme/jobs?content=true';
const leverListUrl = 'https://api.lever.co/v0/postings/widgets?mode=json&skip=0&limit=100';

describe('runAtsRosterDiscovery', () => {
  it('scans every roster company through the matching ATS adapter and tags vacancies by ATS type', async () => {
    const http = new FixtureHttpClient(
      new Map([
        [
          greenhouseListUrl,
          JSON.stringify({
            jobs: [{
              id: 1,
              title: 'Frontend Engineer',
              absolute_url: 'https://job-boards.greenhouse.io/acme/jobs/1',
              content: '<p>Build things.</p>',
              location: { name: 'Remote' },
            }],
          }),
        ],
        [
          leverListUrl,
          JSON.stringify([{
            id: 'lever-1',
            text: 'Backend Engineer',
            hostedUrl: 'https://jobs.lever.co/widgets/lever-1',
            descriptionPlain: 'Build the backend.',
            categories: { location: 'Berlin' },
          }]),
        ],
      ]),
    );

    const result = await runAtsRosterDiscovery(http, config(), [greenhouseEntry, leverEntry]);

    expect(result.vacancies).toHaveLength(2);
    const greenhouseVacancy = result.vacancies.find((vacancy) => vacancy.provider === 'ats_roster_greenhouse');
    expect(greenhouseVacancy).toMatchObject({
      provider: 'ats_roster_greenhouse',
      company: 'Acme Corp',
      title: 'Frontend Engineer',
      url: 'https://job-boards.greenhouse.io/acme/jobs/1',
      currency: null,
      salaryPeriod: null,
      advertisedMinimum: null,
    });
    const leverVacancy = result.vacancies.find((vacancy) => vacancy.provider === 'ats_roster_lever');
    expect(leverVacancy).toMatchObject({
      provider: 'ats_roster_lever',
      company: 'Widgets Inc',
      title: 'Backend Engineer',
      url: 'https://jobs.lever.co/widgets/lever-1',
    });

    const greenhouseSource = result.sources.find((source) => source.provider === 'ats_roster_greenhouse');
    expect(greenhouseSource).toMatchObject({
      status: 'success',
      requests: 1,
      listings: 1,
      rosterScan: {
        mode: 'complete',
        totalRosterSize: 2,
        dueSourcesAttempted: 2,
        explorationSourcesAttempted: 0,
        newlyVerifiedSources: 2,
        skippedNotDue: 0,
        failuresByCategory: {},
      },
    });
  });

  it('isolates one failing company without failing the rest of that provider scan', async () => {
    const staleEntry: AtsRosterEntry = {
      provider: 'greenhouse',
      slug: 'gone',
      baseUrl: 'https://job-boards.greenhouse.io',
      company: 'Defunct Co',
    };
    const staleListUrl = 'https://boards-api.greenhouse.io/v1/boards/gone/jobs?content=true';
    const http = new FixtureHttpClient(
      new Map<string, string | AtsHttpResponse>([
        [greenhouseListUrl, JSON.stringify({ jobs: [] })],
        [staleListUrl, { status: 404, finalUrl: staleListUrl, headers: {}, body: 'not found' }],
      ]),
    );

    const result = await runAtsRosterDiscovery(http, config(), [greenhouseEntry, staleEntry]);

    expect(result.vacancies).toHaveLength(0);
    const source = result.sources.find((item) => item.provider === 'ats_roster_greenhouse');
    expect(source).toMatchObject({ status: 'partial', requests: 2 });
    expect(source?.error).toContain('1/2 companies failed');
    expect(source?.rosterScan?.failuresByCategory).toEqual({ not_found: 1 });
  });

  it('reports a not-yet-imported provider without failing the run', async () => {
    const http = new FixtureHttpClient(new Map());

    const result = await runAtsRosterDiscovery(http, config(), []);

    expect(result.vacancies).toHaveLength(0);
    expect(result.sources).toHaveLength(5);
    for (const source of result.sources) {
      expect(source).toMatchObject({ requests: 0, listings: 0, status: 'success' });
      expect(source.error).toContain('ats-roster:import');
    }
  });

  it('never reads a country field from the roster entry or the resulting vacancy audit', async () => {
    const http = new FixtureHttpClient(
      new Map([[greenhouseListUrl, JSON.stringify({ jobs: [] })]]),
    );

    const result = await runAtsRosterDiscovery(http, config(), [greenhouseEntry]);

    expect(Object.keys(greenhouseEntry)).not.toContain('country');
    expect(result.vacancies).toHaveLength(0);
  });
});

describe('runAtsRosterDiscovery under a search plan allowance (#686)', () => {
  it('a tenant the plan did not let this run ask is deferred: no request counted, no failure observation written', async () => {
    const { mkdtemp, rm } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const path = await import('node:path');
    const { SearchPlanBudgetError } = await import('../../src/global-remote/search-plan-ledger.js');
    const { loadAtsSourceObservations } = await import('../../src/companies/ats-source-observation-repository.js');
    const root = await mkdtemp(path.join(tmpdir(), 'ovr-686-roster-'));
    try {
      const refusing = {
        get: () => Promise.reject(new SearchPlanBudgetError('request')),
        postJson: () => Promise.reject(new SearchPlanBudgetError('request')),
      };
      const result = await runAtsRosterDiscovery(refusing, config(), [greenhouseEntry], root);
      const row = result.sources.find((source) => source.provider === 'ats_roster_greenhouse')!;
      expect(row.requests).toBe(0);
      expect(row.status).toBe('partial');
      expect(row.error).toBe("1/1 companies were not asked within the search plan's shared allowance.");
      const observations = await loadAtsSourceObservations(root);
      expect(observations.observations.filter((entry) => entry.slug === 'acme' && entry.status === 'error')).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('a tenant cut AFTER its request reached the network counts as a request and as stopped, never as failed or not asked', async () => {
    const { mkdtemp, rm } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const path = await import('node:path');
    const { SearchPlanBudgetError } = await import('../../src/global-remote/search-plan-ledger.js');
    const { loadAtsSourceObservations } = await import('../../src/companies/ats-source-observation-repository.js');
    const root = await mkdtemp(path.join(tmpdir(), 'ovr-686-roster-cut-'));
    try {
      const cut = {
        get: () => Promise.reject(new SearchPlanBudgetError('time', true)),
        postJson: () => Promise.reject(new SearchPlanBudgetError('time', true)),
      };
      const result = await runAtsRosterDiscovery(cut, config(), [greenhouseEntry], root);
      const row = result.sources.find((source) => source.provider === 'ats_roster_greenhouse')!;
      expect(row.requests).toBe(1);
      expect(row.status).toBe('partial');
      expect(row.complete).toBe(false);
      expect(row.error).toBe(
        "1/1 companies were asked but stopped before they finished, because the search plan's shared allowance ran out.",
      );
      expect(row.error).not.toMatch(/not asked/i);
      const observations = await loadAtsSourceObservations(root);
      expect(observations.observations.filter((entry) => entry.slug === 'acme')).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
