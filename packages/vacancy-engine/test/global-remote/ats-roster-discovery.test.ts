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
    expect(greenhouseSource).toMatchObject({ status: 'success', requests: 1, listings: 1 });
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
