import { describe, expect, it } from 'vitest';

import type { AtsHttpResponse } from '../../src/ats/http.js';
import { runKeyedDiscovery } from '../../src/global-remote/keyed-discovery.js';
import type { GlobalRemoteConfig } from '../../src/global-remote/models.js';
import { FixtureHttpClient, jsonPostFixtureKey } from '../ats/helpers.js';

function config(overrides: Partial<GlobalRemoteConfig['discovery']> = {}): GlobalRemoteConfig {
  return {
    version: 'test',
    minimumAnnualBaseUsd: 100_000,
    discovery: {
      himalayasQueries: ['frontend'],
      himalayasCountry: 'NL',
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

const ADZUNA_URL = 'https://api.adzuna.com/v1/api/jobs/gb/search/1?app_id=test-id&app_key=test-key&content-type=application%2Fjson&what=frontend+developer&results_per_page=50';
const JOOBLE_URL = 'https://jooble.org/api/test-jooble-key';
const JOOBLE_BODY = { keywords: 'frontend developer', location: 'remote' };
const REED_URL = 'https://www.reed.co.uk/api/1.0/search?keywords=frontend+developer&resultsToTake=100';
const JOBSPIPE_URL = 'https://api.jobspipe.dev/v1/jobs/search';
const JOBSPIPE_BODY = {
  job_title_or: ['frontend developer', 'frontend engineer', 'frontend architect'],
  remote: true,
  posted_at_max_age_days: 30,
  limit: 25,
};

describe('keyed discovery sources (configuration-required until a project key is set)', () => {
  it('runs no keyed source and makes no requests when every key is unset', async () => {
    const http = new FixtureHttpClient(new Map());

    const result = await runKeyedDiscovery(http, config());

    expect(result.sources).toEqual([]);
    expect(result.vacancies).toEqual([]);
    expect(http.requestedUrls).toEqual([]);
  });

  it('normalizes all four keyed providers once their keys are configured', async () => {
    const routes = new Map<string, string | AtsHttpResponse>([
      [ADZUNA_URL, JSON.stringify({
        count: 1,
        results: [{
          id: 'adz-1',
          title: 'Senior Frontend Developer',
          description: 'Build UI in London.',
          company: { display_name: 'Adzuna Co' },
          location: { display_name: 'London, UK' },
          salary_min: 65000,
          salary_max: 80000,
          contract_time: 'full_time',
          redirect_url: 'https://www.adzuna.co.uk/jobs/details/adz-1',
        }],
      })],
      [jsonPostFixtureKey(JOOBLE_URL, JOOBLE_BODY), JSON.stringify({
        totalCount: 1,
        jobs: [{
          id: 501,
          title: 'Frontend Engineer',
          location: 'Worldwide',
          snippet: 'Remote role paying $130,000 per year.',
          salary: '',
          type: 'Full-time',
          link: 'https://jooble.org/jobs/frontend-engineer-501',
          company: 'Jooble Co',
          updated: '2026-08-01T00:00:00Z',
        }],
      })],
      [REED_URL, JSON.stringify({
        totalResults: 1,
        results: [{
          jobId: 901,
          employerName: 'Reed Co',
          jobTitle: 'Frontend Developer',
          locationName: 'London',
          minimumSalary: 60000,
          maximumSalary: 75000,
          currency: 'GBP',
          jobUrl: 'https://www.reed.co.uk/jobs/frontend-developer/901',
          jobDescription: 'Build accessible web interfaces.',
        }],
      })],
      [jsonPostFixtureKey(JOBSPIPE_URL, JOBSPIPE_BODY), JSON.stringify({
        metadata: { total_results: 1, truncated_results: 0, next_cursor: null },
        data: [{
          id: 'jp-1',
          job_title: 'Frontend Architect',
          company: 'JobsPipe Co',
          location: 'Worldwide',
          country_code: null,
          remote: true,
          seniority: 'senior',
          date_posted: '2026-08-01',
          source_url: 'https://api.jobspipe.dev/redirect/jp-1',
          last_seen_at: '2026-08-28',
          verified_at: '2026-08-28',
          sources: [],
        }],
      })],
    ]);

    const result = await runKeyedDiscovery(new FixtureHttpClient(routes), config({
      adzunaAppId: 'test-id',
      adzunaAppKey: 'test-key',
      joobleApiKey: 'test-jooble-key',
      reedApiKey: 'test-reed-key',
      jobspipeApiKey: 'test-jobspipe-key',
    }));

    expect(result.sources.map((source) => source.provider).sort()).toEqual(['adzuna', 'jobspipe', 'jooble', 'reed']);
    expect(result.sources.every((source) => source.status === 'success')).toBe(true);
    expect(result.vacancies).toHaveLength(4);
    expect(result.vacancies.find((vacancy) => vacancy.provider === 'adzuna'))
      .toMatchObject({ company: 'Adzuna Co', location: 'London, UK', decision: 'location_restricted' });
    expect(result.vacancies.find((vacancy) => vacancy.provider === 'jooble'))
      .toMatchObject({ company: 'Jooble Co', location: 'Worldwide', decision: 'official_review_candidate' });
    expect(result.vacancies.find((vacancy) => vacancy.provider === 'reed'))
      .toMatchObject({ company: 'Reed Co', location: 'London', decision: 'location_restricted' });
    expect(result.vacancies.find((vacancy) => vacancy.provider === 'jobspipe'))
      .toMatchObject({ company: 'JobsPipe Co', location: 'Worldwide', decision: 'salary_unverified' });
  });

  it('sends the Reed API key as a Basic auth header and isolates a blocked Jooble response', async () => {
    const routes = new Map<string, string | AtsHttpResponse>([
      [REED_URL, JSON.stringify({ totalResults: 0, results: [] })],
      [jsonPostFixtureKey(JOOBLE_URL, JOOBLE_BODY), { status: 403, finalUrl: JOOBLE_URL, headers: {}, body: 'Access Denied' }],
    ]);
    const http = new FixtureHttpClient(routes);

    const result = await runKeyedDiscovery(http, config({ reedApiKey: 'test-reed-key', joobleApiKey: 'test-jooble-key' }));

    const reedRequestIndex = http.requestedUrls.indexOf(REED_URL);
    expect(http.requestedOptions[reedRequestIndex]?.headers).toMatchObject({
      Authorization: `Basic ${Buffer.from('test-reed-key:', 'utf8').toString('base64')}`,
    });
    expect(result.sources.find((source) => source.provider === 'jooble'))
      .toMatchObject({ status: 'blocked', requests: 1, listings: 0 });
    expect(result.sources.find((source) => source.provider === 'reed'))
      .toMatchObject({ status: 'success', listings: 0 });
  });
});
