import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import type { AtsHttpResponse } from '../../src/ats/http.js';
import {
  AI_DEV_JOBS_JOBS_URL,
  AI_DEV_JOBS_MAX_PAGE_SIZE,
  aiDevJobDetailUrl,
  discoverAiDevJobs,
  fetchAiDevJobDetail,
} from '../../src/global-remote/ai-dev-jobs-discovery.js';
import type { GlobalRemoteConfig } from '../../src/global-remote/models.js';
import { FixtureHttpClient } from '../ats/helpers.js';

function fixture(name: string): string {
  return readFileSync(
    path.resolve(process.cwd(), 'test/fixtures/global-remote/ai-dev-jobs', name),
    'utf8',
  );
}

function profile(overrides: Partial<GlobalRemoteConfig['discovery']> = {}): GlobalRemoteConfig {
  return {
    version: 'test',
    minimumAnnualBaseUsd: 100_000,
    discovery: {
      roleQuery: '',
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
      ...overrides,
    },
    officialSources: [],
  };
}

function pageUrl(page: number, extra = ''): string {
  return `${AI_DEV_JOBS_JOBS_URL}?workplace=remote${extra}&limit=${AI_DEV_JOBS_MAX_PAGE_SIZE}&page=${page}`;
}

describe('AI Dev Jobs linked-index discovery', () => {
  it('requests the documented remote-workplace filter and normalizes active jobs, dropping an expired row', async () => {
    const routes = new Map([[pageUrl(1), fixture('list-page1.json')]]);
    const http = new FixtureHttpClient(routes);

    const result = await discoverAiDevJobs(http, profile());

    expect(http.requestedUrls).toEqual([pageUrl(1)]);
    expect(result.sources).toEqual([
      expect.objectContaining({
        id: 'ai_dev_jobs:remote-search',
        provider: 'ai_dev_jobs',
        requests: 1,
        listings: 2,
        // list-page1.json has has_next: true and aiDevJobsMaxPages defaults to 1 in this profile,
        // so the scan stops at its configured page budget rather than an error/rate limit.
        status: 'partial',
        error: expect.stringContaining('configured 1-page limit'),
      }),
    ]);
    expect(result.vacancies).toHaveLength(2);
    expect(result.vacancies.map((vacancy) => vacancy.key)).toEqual([
      'ai_dev_jobs:11111111-1111-4111-8111-111111111111',
      'ai_dev_jobs:22222222-2222-4222-8222-222222222222',
    ]);
    expect(result.vacancies[0]).toEqual(
      expect.objectContaining({
        provider: 'ai_dev_jobs',
        company: 'Example Corp',
        title: 'Senior Machine Learning Engineer',
        url: 'https://boards.greenhouse.io/examplecorp/jobs/1234567',
        location: 'Remote (Worldwide)',
        employmentType: 'full-time',
        currency: 'USD',
        salaryPeriod: 'annual',
        advertisedMinimum: 180_000,
        annualizedMinimumUsd: 180_000,
        postedAt: '2026-09-01T09:00:00.000Z',
      }),
    );
    expect(result.vacancies[0]?.description).toContain(
      'AI Dev Jobs listing: https://aidevboard.com/job/11111111-1111-4111-8111-111111111111',
    );
    expect(result.vacancies[0]?.description).toContain('Level: senior');
    expect(result.vacancies[0]?.description).toContain('Tags: llm, pytorch, python');
    expect(result.vacancies[1]).toEqual(
      expect.objectContaining({
        key: 'ai_dev_jobs:22222222-2222-4222-8222-222222222222',
        currency: null,
        salaryPeriod: null,
        advertisedMinimum: null,
        annualizedMinimumUsd: null,
      }),
    );
  });

  it('preserves the direct employer apply link as the primary url and the AI Dev Jobs page as attribution', async () => {
    const routes = new Map([[pageUrl(1), fixture('list-page1.json')]]);
    const result = await discoverAiDevJobs(new FixtureHttpClient(routes), profile());

    const vacancy = result.vacancies[0];
    expect(vacancy?.url).toBe('https://boards.greenhouse.io/examplecorp/jobs/1234567');
    expect(vacancy?.description).toMatch(/^AI Dev Jobs listing: https:\/\/aidevboard\.com\/job\//u);
  });

  it('sends the configured query term as q, in addition to the workplace filter', async () => {
    const routes = new Map([[pageUrl(1, '&q=llm'), fixture('list-empty.json')]]);
    const result = await discoverAiDevJobs(
      new FixtureHttpClient(routes),
      profile({ roleQuery: 'llm' }),
    );

    expect(result.sources[0]).toMatchObject({ status: 'success', listings: 0 });
  });

  it('walks pages until has_next is false, without exceeding the configured page budget', async () => {
    const routes = new Map([
      [pageUrl(1), fixture('list-page1.json')],
      [pageUrl(2), fixture('list-page2.json')],
    ]);
    const http = new FixtureHttpClient(routes);

    const result = await discoverAiDevJobs(http, profile({ aiDevJobsMaxPages: 3 }));

    expect(http.requestedUrls).toEqual([pageUrl(1), pageUrl(2)]);
    expect(result.sources).toEqual([
      expect.objectContaining({ requests: 2, listings: 3, status: 'success', error: null }),
    ]);
    expect(result.vacancies.map((vacancy) => vacancy.key)).toEqual([
      'ai_dev_jobs:11111111-1111-4111-8111-111111111111',
      'ai_dev_jobs:22222222-2222-4222-8222-222222222222',
      'ai_dev_jobs:44444444-4444-4444-8444-444444444444',
    ]);
  });

  it('treats a page requested past the end of the result set (jobs: null) as a successful empty page', async () => {
    const routes = new Map([[pageUrl(1), fixture('list-empty.json')]]);

    const result = await discoverAiDevJobs(new FixtureHttpClient(routes), profile());

    expect(result.sources).toEqual([
      expect.objectContaining({ requests: 1, listings: 0, status: 'success', error: null }),
    ]);
    expect(result.vacancies).toEqual([]);
  });

  it('isolates a malformed list response as an errored source without throwing', async () => {
    const routes = new Map([[pageUrl(1), fixture('list-malformed.json')]]);

    const result = await discoverAiDevJobs(new FixtureHttpClient(routes), profile());

    expect(result.sources).toEqual([
      expect.objectContaining({
        status: 'error',
        listings: 0,
        error: expect.stringContaining('jobs is not an array'),
      }),
    ]);
    expect(result.vacancies).toEqual([]);
  });

  it('isolates an hourly rate limit (429) as blocked without retrying', async () => {
    const response: AtsHttpResponse = {
      status: 429,
      finalUrl: pageUrl(1),
      headers: { 'retry-after': '3600', 'x-ratelimit-remaining': '0' },
      body: fixture('rate-limited.json'),
    };
    const routes = new Map([[pageUrl(1), response]]);
    const http = new FixtureHttpClient(routes);

    const result = await discoverAiDevJobs(http, profile());

    expect(http.requestedUrls).toEqual([pageUrl(1)]);
    expect(result.sources).toEqual([
      expect.objectContaining({
        requests: 1,
        listings: 0,
        status: 'blocked',
        error: expect.stringContaining('HTTP 429'),
      }),
    ]);
  });

  it('fetches and normalizes one active job detail', async () => {
    const url = aiDevJobDetailUrl('senior-machine-learning-engineer-abc123');
    const http = new FixtureHttpClient(new Map([[url, fixture('detail-valid.json')]]));

    const detail = await fetchAiDevJobDetail(http, 'senior-machine-learning-engineer-abc123', 100_000);

    expect(detail.status).toBe('active');
    if (detail.status !== 'active') throw new Error('expected an active detail');
    expect(detail.job).toEqual(
      expect.objectContaining({
        key: 'ai_dev_jobs:11111111-1111-4111-8111-111111111111',
        company: 'Example Corp',
        title: 'Senior Machine Learning Engineer',
        url: 'https://boards.greenhouse.io/examplecorp/jobs/1234567',
      }),
    );
    expect(http.requestedOptions).toEqual([
      {
        allowedOrigins: ['https://aidevboard.com'],
        headers: { Accept: 'application/json' },
        cache: 'no-store',
      },
    ]);
  });

  it('maps an expired detail response to inactive rather than fabricating a vacancy', async () => {
    const url = aiDevJobDetailUrl('closed-ml-platform-role-ghi789');
    const http = new FixtureHttpClient(new Map([[url, fixture('detail-inactive.json')]]));

    await expect(fetchAiDevJobDetail(http, 'closed-ml-platform-role-ghi789', 100_000)).resolves.toEqual({
      status: 'inactive',
      job: null,
    });
  });

  it('maps a 404 detail response to not_found', async () => {
    const url = aiDevJobDetailUrl('does-not-exist');
    const response: AtsHttpResponse = {
      status: 404,
      finalUrl: url,
      headers: {},
      body: fixture('detail-not-found.json'),
    };
    const http = new FixtureHttpClient(new Map([[url, response]]));

    await expect(fetchAiDevJobDetail(http, 'does-not-exist', 100_000)).resolves.toEqual({
      status: 'not_found',
      job: null,
    });
  });

  it('rejects a malformed detail response instead of returning a partial vacancy', async () => {
    const url = aiDevJobDetailUrl('55555555-5555-4555-8555-555555555555');
    const http = new FixtureHttpClient(new Map([[url, fixture('detail-malformed.json')]]));

    await expect(
      fetchAiDevJobDetail(http, '55555555-5555-4555-8555-555555555555', 100_000),
    ).rejects.toThrow('ai_dev_jobs: detail job contract is invalid');
  });

  it('rejects id/slug lookups with an empty string before making a request', () => {
    expect(() => aiDevJobDetailUrl('  ')).toThrow(RangeError);
  });

  it('pins the published OpenAPI contract this adapter depends on', () => {
    const spec = JSON.parse(fixture('openapi-subset.json')) as {
      paths: {
        '/jobs': {
          get: {
            parameters: Array<{ name: string; schema?: { type?: string; enum?: string[]; default?: unknown } }>;
          };
        };
      };
      components: { schemas: { Job: { properties: Record<string, unknown> } } };
    };
    const jobsGet = spec.paths['/jobs'].get;
    const workplaceParam = jobsGet.parameters.find((param) => param.name === 'workplace');
    const limitParam = jobsGet.parameters.find((param) => param.name === 'limit');
    const pageParam = jobsGet.parameters.find((param) => param.name === 'page');
    const queryParam = jobsGet.parameters.find((param) => param.name === 'q');

    expect(workplaceParam?.schema?.enum).toEqual(['remote', 'hybrid', 'onsite']);
    expect(limitParam?.schema?.default).toBe(20);
    expect(pageParam?.schema?.default).toBe(1);
    expect(queryParam?.schema?.type).toBe('string');
    // The documented max page size this adapter's AI_DEV_JOBS_MAX_PAGE_SIZE constant must never exceed.
    expect(AI_DEV_JOBS_MAX_PAGE_SIZE).toBeLessThanOrEqual(50);

    const jobProperties = Object.keys(spec.components.schemas.Job.properties);
    for (const field of [
      'id',
      'title',
      'company_name',
      'location',
      'workplace',
      'remote_scope',
      'job_type',
      'experience_level',
      'salary_min',
      'salary_max',
      'tags',
      'apply_url',
      'slug',
    ]) {
      expect(jobProperties).toContain(field);
    }
  });
});
