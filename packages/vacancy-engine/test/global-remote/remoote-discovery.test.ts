import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import type { AtsHttpResponse } from '../../src/ats/http.js';
import {
  discoverRemoote,
  REMOOTE_PUBLIC_LIMIT,
  REMOOTE_SEARCH_URL,
} from '../../src/global-remote/remoote-discovery.js';
import type { GlobalRemoteConfig } from '../../src/global-remote/models.js';
import { FixtureHttpClient, jsonPostFixtureKey } from '../ats/helpers.js';

function fixture(name: string): string {
  return readFileSync(
    path.resolve(process.cwd(), 'test/fixtures/global-remote/remoote', name),
    'utf8',
  );
}

function profile(): GlobalRemoteConfig {
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
      remooteRoleTitle: 'frontend',
      remooteCountry: 'Netherlands',
      remooteLimit: 10,
      museEnabled: false,
      museMaxPages: 1,
      adzunaAppId: '',
      adzunaAppKey: '',
      adzunaMaxPages: 1,
      joobleApiKey: '',
      reedApiKey: '',
      jobspipeApiKey: '',
    },
    officialSources: [],
  };
}

function searchBody(): unknown {
  return {
    role_title: 'frontend',
    country: 'Netherlands',
    salary_required: false,
    limit: 10,
  };
}

describe('Remoote linked-index discovery', () => {
  it('makes one capped anonymous search and retains only canonical normalized fields', async () => {
    const routes = new Map([
      [jsonPostFixtureKey(REMOOTE_SEARCH_URL, searchBody()), fixture('search-valid.json')],
    ]);
    const http = new FixtureHttpClient(routes);

    const result = await discoverRemoote(http, profile());

    expect(result.sources).toEqual([
      expect.objectContaining({
        provider: 'remoote',
        requests: 1,
        listings: 1,
        status: 'success',
      }),
    ]);
    expect(result.vacancies).toEqual([
      expect.objectContaining({
        key: 'remoote:12345',
        provider: 'remoote',
        company: 'Example Systems',
        title: 'Senior Frontend Engineer',
        url: 'https://remoote.app/jobs/12345-senior-frontend-engineer',
        location: 'Europe, including Netherlands',
        employmentType: 'full-time',
        currency: 'USD',
        salaryPeriod: 'year',
        advertisedMinimum: 120_000,
        annualizedMinimumUsd: 120_000,
      }),
    ]);
    expect(http.requestedUrls).toEqual([REMOOTE_SEARCH_URL]);
    expect(http.requestedJsonBodies).toEqual([searchBody()]);
    expect(http.requestedOptions[0]).toEqual({
      allowedOrigins: ['https://api.remoote.app'],
      headers: { Accept: 'application/json' },
    });
    expect(JSON.stringify(result)).not.toContain('employer.invalid');
  });

  it.each([
    ['empty search', 'search-empty.json'],
    ['non-canonical job link', 'search-noncanonical.json'],
  ])('returns a successful empty source for %s', async (_label, fixtureName) => {
    const routes = new Map([
      [jsonPostFixtureKey(REMOOTE_SEARCH_URL, searchBody()), fixture(fixtureName)],
    ]);

    const result = await discoverRemoote(new FixtureHttpClient(routes), profile());

    expect(result.sources).toEqual([
      expect.objectContaining({
        provider: 'remoote',
        listings: 0,
        status: 'success',
      }),
    ]);
    expect(result.vacancies).toEqual([]);
  });

  it('preserves missing salary and location as explicit uncertainty', async () => {
    const routes = new Map([
      [jsonPostFixtureKey(REMOOTE_SEARCH_URL, searchBody()), fixture('search-uncertain.json')],
    ]);

    const result = await discoverRemoote(new FixtureHttpClient(routes), profile());

    expect(result.vacancies).toEqual([
      expect.objectContaining({
        key: 'remoote:12347',
        location: 'Remote (eligibility unspecified)',
        advertisedMinimum: null,
        annualizedMinimumUsd: null,
      }),
    ]);
  });

  it('rejects response limits above the anonymous public cap', async () => {
    const payload = JSON.parse(fixture('search-empty.json')) as {
      limits: { applied_limit: number; max_public_results: number };
    };
    payload.limits.applied_limit = REMOOTE_PUBLIC_LIMIT + 1;
    payload.limits.max_public_results = REMOOTE_PUBLIC_LIMIT + 1;
    const routes = new Map([
      [jsonPostFixtureKey(REMOOTE_SEARCH_URL, searchBody()), JSON.stringify(payload)],
    ]);

    const result = await discoverRemoote(new FixtureHttpClient(routes), profile());

    expect(result.sources).toEqual([
      expect.objectContaining({
        provider: 'remoote',
        status: 'error',
        error: expect.stringContaining('public result limits are invalid'),
      }),
    ]);
    expect(result.vacancies).toEqual([]);
  });

  it('does not retain POST search results between discovery runs', async () => {
    const routes = new Map([
      [jsonPostFixtureKey(REMOOTE_SEARCH_URL, searchBody()), fixture('search-empty.json')],
    ]);
    const http = new FixtureHttpClient(routes);

    await discoverRemoote(http, profile());
    await discoverRemoote(http, profile());

    expect(http.requestedUrls).toEqual([REMOOTE_SEARCH_URL, REMOOTE_SEARCH_URL]);
  });

  it('does not fold an unknown raw employer URL into retained content', async () => {
    const firstPayload = fixture('search-valid.json');
    const secondPayload = firstPayload.replace(
      'https://employer.invalid/apply/12345',
      'https://different-employer.invalid/apply/12345',
    );
    const firstRoutes = new Map([
      [jsonPostFixtureKey(REMOOTE_SEARCH_URL, searchBody()), firstPayload],
    ]);
    const secondRoutes = new Map([
      [jsonPostFixtureKey(REMOOTE_SEARCH_URL, searchBody()), secondPayload],
    ]);

    const first = await discoverRemoote(new FixtureHttpClient(firstRoutes), profile());
    const second = await discoverRemoote(new FixtureHttpClient(secondRoutes), profile());

    expect(first.vacancies[0]?.contentHash).toBe(second.vacancies[0]?.contentHash);
  });

  it('isolates malformed search responses', async () => {
    const routes = new Map([
      [jsonPostFixtureKey(REMOOTE_SEARCH_URL, searchBody()), fixture('search-malformed.json')],
    ]);

    const result = await discoverRemoote(new FixtureHttpClient(routes), profile());

    expect(result.sources).toEqual([
      expect.objectContaining({
        provider: 'remoote',
        status: 'error',
        listings: 0,
        error: expect.stringContaining('data.jobs is not an array'),
      }),
    ]);
    expect(result.vacancies).toEqual([]);
  });

  it('isolates public rate limits as a blocked source', async () => {
    const response: AtsHttpResponse = {
      status: 429,
      finalUrl: REMOOTE_SEARCH_URL,
      headers: { 'retry-after': '60' },
      body: fixture('rate-limit.json'),
    };
    const routes = new Map([[jsonPostFixtureKey(REMOOTE_SEARCH_URL, searchBody()), response]]);

    const result = await discoverRemoote(new FixtureHttpClient(routes), profile());

    expect(result.sources).toEqual([
      expect.objectContaining({
        provider: 'remoote',
        requests: 1,
        listings: 0,
        status: 'blocked',
        error: expect.stringContaining('HTTP 429'),
      }),
    ]);
  });

  it('pins the sanitized public tools, detail, and inactive response contracts', () => {
    const tools = JSON.parse(fixture('tools.json')) as {
      tools: Array<{
        name: string;
        auth_required: boolean;
        public_limit: number | null;
        input_schema: { properties: Record<string, unknown>; required?: string[] };
      }>;
      public_limits: {
        max_results_per_call: number;
        max_authenticated_results_per_call: number;
        bulk_export: boolean;
        raw_employer_apply_urls: boolean;
      };
    };
    const detail = JSON.parse(fixture('detail-valid.json')) as {
      status: string;
      data: { job: { remoote_url: string; apply_action: { url: string } } };
    };
    const inactive = JSON.parse(fixture('detail-inactive.json')) as {
      status: string;
      data: unknown;
    };

    const searchTool = tools.tools.find((tool) => tool.name === 'search_jobs');
    const detailTool = tools.tools.find((tool) => tool.name === 'get_job');
    expect(searchTool).toMatchObject({ auth_required: false, public_limit: 10 });
    expect(searchTool?.input_schema.properties).toMatchObject({
      role_title: { default: null, maxLength: 200 },
      country: { default: null, maxLength: 100 },
      salary_required: { default: true, type: 'boolean' },
      limit: { default: 10, minimum: 1, maximum: 25, type: 'integer' },
    });
    expect(detailTool).toMatchObject({
      auth_required: false,
      public_limit: null,
      input_schema: { required: ['job_id'] },
    });
    expect(tools.public_limits).toEqual({
      max_results_per_call: REMOOTE_PUBLIC_LIMIT,
      max_authenticated_results_per_call: 25,
      bulk_export: false,
      raw_employer_apply_urls: false,
    });
    expect(detail.status).toBe('ok');
    expect(detail.data.job.remoote_url).toBe(detail.data.job.apply_action.url);
    expect(detail.data.job.remoote_url).toMatch(/^https:\/\/remoote\.app\/jobs\//u);
    expect(inactive).toMatchObject({ status: 'not_found', data: null });
  });
});
