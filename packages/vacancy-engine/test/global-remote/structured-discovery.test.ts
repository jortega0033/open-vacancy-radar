import { describe, expect, it } from 'vitest';

import type { AtsHttpResponse } from '../../src/ats/http.js';
import { runStructuredDiscovery } from '../../src/global-remote/structured-discovery.js';
import type { GlobalRemoteConfig } from '../../src/global-remote/models.js';
import { FixtureHttpClient } from '../ats/helpers.js';

const FREEHIRE_URL = 'https://freehire.me/api/v1/jobs/search?category=frontend&work_mode=remote&regions=global%2Ceu&salary_currency=USD&salary_min=100000&reality=fresh&posted_within_days=30&sort=posted_at&order=desc&limit=2';
const JOB_OPPORTUNITIES_URL = 'https://api.jobopportunitiesapi.org/public/jobs?q=frontend&remote_confirmed=true&require_fields=salary&limit=2';
const REMOTE_LANDERS_URL = 'https://remotelanders.com/api/jobs?category=Engineering&limit=100&page=1';
const JOBGETHER_URL = 'https://jobgether.com/astroapi/ai/jobs.json?keyword=frontend&remoteType=full-remote&includeHybrid=false&salaryMin=100000&currency=USD&sort=date&page=1&limit=25';

const config: GlobalRemoteConfig = {
  version: 'test',
  minimumAnnualBaseUsd: 100_000,
  discovery: {
    roleQuery: 'frontend',
    himalayasQueries: ['frontend'],
    himalayasCountry: 'NL',
    himalayasMaxPagesPerQuery: 1,
    jobicyCount: 1,
    freehireLimit: 2,
    jobOpportunitiesLimit: 2,
    remoteLandersMaxPages: 1,
    jobgetherMaxPages: 1,
    remoteFirstMaxPages: 1,
    jobRemotelyMaxPages: 1,
    arbeitnowMaxPages: 1,
    diceMaxPages: 1,
    remooteRoleTitle: 'frontend',
    remooteCountry: 'Netherlands',
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
    atsRosterConcurrency: 1,
    navArbeidsplassenApiKey: '',
    navArbeidsplassenMaxPages: 1,
  },
  officialSources: [],
};

function emptyStructuredRoutes(): Map<string, string | AtsHttpResponse> {
  return new Map([
    [FREEHIRE_URL, JSON.stringify({ data: [], meta: { total: 0, limit: 2, offset: 0 } })],
    [JOB_OPPORTUNITIES_URL, JSON.stringify({ data: [], has_more: false })],
    [REMOTE_LANDERS_URL, JSON.stringify({ total: 0, page: 1, limit: 100, count: 0, jobs: [] })],
    [JOBGETHER_URL, JSON.stringify({ jobs: [], pagination: { page: 1, limit: 25, hasMore: false } })],
  ]);
}

describe('structured global-remote discovery', () => {
  describe('FreeHire: contract and reliability hardening (issue #6)', () => {
    it('accepts successful responses with direct ATS URLs', async () => {
      const routes = emptyStructuredRoutes();
      routes.set(FREEHIRE_URL, JSON.stringify({
        data: [
          {
            public_slug: 'acme-senior-frontend',
            url: 'https://jobs.ashbyhq.com/acme/frontend?utm_source=freehire.me',
            title: 'Senior Frontend Engineer',
            company: 'Acme',
            location: 'Remote',
            regions: ['global'],
            countries: [],
            description: 'Build the customer-facing application.',
            posted_at: '2026-08-20T09:00:00Z',
            enrichment: {
              employment_type: 'full_time',
              salary_min: 140000,
              salary_currency: 'USD',
              salary_period: 'year',
            },
          },
        ],
        meta: { total: 1, limit: 2, offset: 0 },
      }));
      const result = await runStructuredDiscovery(new FixtureHttpClient(routes), config);
      const freehireSource = result.sources.find((s) => s.provider === 'freehire');
      expect(freehireSource).toMatchObject({ status: 'success', listings: 1 });
    });

    it('marks bounded responses as partial when total > returned results', async () => {
      const routes = emptyStructuredRoutes();
      routes.set(FREEHIRE_URL, JSON.stringify({
        data: [
          {
            public_slug: 'job-1',
            url: 'https://jobs.ashbyhq.com/acme/frontend',
            title: 'Frontend Engineer',
            company: 'Acme',
            regions: ['global'],
            enrichment: { salary_min: 140000, salary_currency: 'USD', salary_period: 'year' },
          },
          {
            public_slug: 'job-2',
            url: 'https://greenhouse.io/boards/acme/jobs/1',
            title: 'Senior Frontend',
            company: 'BrightCorp',
            regions: ['eu'],
            enrichment: { salary_min: 160000, salary_currency: 'USD', salary_period: 'year' },
          },
        ],
        meta: { total: 847, limit: 2, offset: 0 },
      }));
      const result = await runStructuredDiscovery(new FixtureHttpClient(routes), config);
      const freehireSource = result.sources.find((s) => s.provider === 'freehire');
      expect(freehireSource).toMatchObject({
        status: 'partial',
        listings: 2,
        error: expect.stringContaining('Bounded to 2 of 847'),
      });
    });

    it('handles malformed JSON response gracefully and does not block other providers', async () => {
      const routes = emptyStructuredRoutes();
      routes.set(FREEHIRE_URL, 'not valid json{]');
      const result = await runStructuredDiscovery(new FixtureHttpClient(routes), config);
      const freehireSource = result.sources.find((s) => s.provider === 'freehire');
      expect(freehireSource).toMatchObject({
        status: 'error',
        listings: 0,
        error: expect.stringContaining('invalid discovery JSON'),
      });
      // Ensure other sources still completed: FreeHire failure never blocks local direct-ATS scanning
      const otherSources = result.sources.filter((s) => s.provider !== 'freehire');
      expect(otherSources.every((s) => s.status === 'success')).toBe(true);
    });

    it('handles rate-limited (429) response as blocked and continues other providers', async () => {
      const routes = emptyStructuredRoutes();
      routes.set(FREEHIRE_URL, {
        status: 429,
        finalUrl: FREEHIRE_URL,
        headers: { 'retry-after': '3600' },
        body: 'Too Many Requests',
      });
      const result = await runStructuredDiscovery(new FixtureHttpClient(routes), config);
      const freehireSource = result.sources.find((s) => s.provider === 'freehire');
      expect(freehireSource).toMatchObject({
        status: 'blocked',
        listings: 0,
      });
      // Verify FreeHire failure does not block other providers
      const otherSources = result.sources.filter((s) => s.provider !== 'freehire');
      expect(otherSources.every((s) => s.status === 'success')).toBe(true);
    });

    it('skips jobs with missing required fields and processes valid entries', async () => {
      const routes = emptyStructuredRoutes();
      routes.set(FREEHIRE_URL, JSON.stringify({
        data: [
          {
            public_slug: 'missing-title',
            url: 'https://jobs.ashbyhq.com/acme/job1',
            company: 'Acme',
            regions: ['global'],
            // Missing title
          },
          {
            public_slug: 'missing-company',
            url: 'https://jobs.ashbyhq.com/acme/job2',
            title: 'Frontend Engineer',
            regions: ['global'],
            // Missing company
          },
          {
            public_slug: 'missing-url',
            title: 'Frontend Engineer',
            company: 'Acme',
            regions: ['global'],
            // Missing url
          },
          {
            public_slug: 'non-ats-url',
            url: 'https://freehire-aggregator.example/jobs/123',
            title: 'Frontend Engineer',
            company: 'Acme',
            regions: ['global'],
            // Non-ATS URL
          },
          {
            public_slug: 'valid-job',
            url: 'https://jobs.ashbyhq.com/acme/valid',
            title: 'Valid Frontend Engineer',
            company: 'Acme',
            regions: ['global'],
            enrichment: { salary_min: 140000, salary_currency: 'USD', salary_period: 'year' },
          },
        ],
        meta: { total: 5, limit: 5, offset: 0 },
      }));
      const result = await runStructuredDiscovery(new FixtureHttpClient(routes), config);
      const freehireVacancies = result.vacancies.filter((v) => v.provider === 'freehire');
      expect(freehireVacancies).toHaveLength(1);
      expect(freehireVacancies[0]).toMatchObject({ title: 'Valid Frontend Engineer' });
    });

    it('preserves direct ATS destination URLs for provider attribution across supported hosts', async () => {
      const routes = emptyStructuredRoutes();
      routes.set(FREEHIRE_URL, JSON.stringify({
        data: [
          {
            public_slug: 'ashby-job',
            url: 'https://jobs.ashbyhq.com/acme/frontend?utm_source=freehire.me',
            title: 'Frontend at Ashby',
            company: 'Acme',
            regions: ['global'],
            enrichment: { salary_min: 140000, salary_currency: 'USD', salary_period: 'year' },
          },
          {
            public_slug: 'lever-job',
            url: 'https://jobs.lever.co/startup/frontend-engineer',
            title: 'Frontend at Lever',
            company: 'Startup Co',
            regions: ['eu'],
            enrichment: { salary_min: 120000, salary_currency: 'USD', salary_period: 'year' },
          },
          {
            public_slug: 'workday-job',
            url: 'https://myworkdayjobs.com/en-US/Acme/job/Remote_Remote/Senior-Frontend-Engineer_1',
            title: 'Senior Frontend at Workday',
            company: 'Acme',
            regions: ['global'],
            enrichment: { salary_min: 160000, salary_currency: 'USD', salary_period: 'year' },
          },
          {
            public_slug: 'bamboohr-job',
            url: 'https://bamboohr.com/jobs/job?123',
            title: 'BambooHR Role',
            company: 'BambooHR Co',
            regions: ['global'],
            enrichment: { salary_min: 130000, salary_currency: 'USD', salary_period: 'year' },
          },
        ],
        meta: { total: 4, limit: 4, offset: 0 },
      }));
      const result = await runStructuredDiscovery(new FixtureHttpClient(routes), config);
      const freehireVacancies = result.vacancies.filter((v) => v.provider === 'freehire');
      expect(freehireVacancies.map((v) => new URL(v.url).hostname)).toEqual([
        'jobs.ashbyhq.com',
        'jobs.lever.co',
        'myworkdayjobs.com',
        'bamboohr.com',
      ]);
    });

    it('handles locations with regions array mapping to user-readable names', async () => {
      const routes = emptyStructuredRoutes();
      routes.set(FREEHIRE_URL, JSON.stringify({
        data: [
          {
            public_slug: 'global-job',
            url: 'https://jobs.ashbyhq.com/acme/job1',
            title: 'Global Role',
            company: 'Acme',
            regions: ['global'],
            enrichment: { salary_min: 140000, salary_currency: 'USD', salary_period: 'year' },
          },
          {
            public_slug: 'eu-job',
            url: 'https://jobs.ashbyhq.com/acme/job2',
            title: 'EU Role',
            company: 'Acme',
            regions: ['eu'],
            enrichment: { salary_min: 140000, salary_currency: 'USD', salary_period: 'year' },
          },
          {
            public_slug: 'uk-job',
            url: 'https://jobs.ashbyhq.com/acme/job3',
            title: 'UK Role',
            company: 'Acme',
            regions: ['uk'],
            enrichment: { salary_min: 140000, salary_currency: 'USD', salary_period: 'year' },
          },
          {
            public_slug: 'countries-job',
            url: 'https://jobs.ashbyhq.com/acme/job4',
            title: 'Country-specific Role',
            company: 'Acme',
            countries: ['United States', 'Canada'],
            enrichment: { salary_min: 140000, salary_currency: 'USD', salary_period: 'year' },
          },
        ],
        meta: { total: 4, limit: 4, offset: 0 },
      }));
      const result = await runStructuredDiscovery(new FixtureHttpClient(routes), config);
      const freehireVacancies = result.vacancies.filter((v) => v.provider === 'freehire');
      expect(freehireVacancies.map((v) => v.location)).toEqual([
        'Worldwide',
        'Europe',
        'United Kingdom',
        'United States, Canada',
      ]);
    });

    it('handles missing or null enrichment data gracefully', async () => {
      const routes = emptyStructuredRoutes();
      routes.set(FREEHIRE_URL, JSON.stringify({
        data: [
          {
            public_slug: 'no-enrichment',
            url: 'https://jobs.ashbyhq.com/acme/job1',
            title: 'Job Without Enrichment',
            company: 'Acme',
            regions: ['global'],
            // No enrichment object
          },
          {
            public_slug: 'null-enrichment',
            url: 'https://jobs.ashbyhq.com/acme/job2',
            title: 'Job With Null Enrichment',
            company: 'Acme',
            regions: ['global'],
            enrichment: null,
          },
          {
            public_slug: 'partial-enrichment',
            url: 'https://jobs.ashbyhq.com/acme/job3',
            title: 'Job With Partial Enrichment',
            company: 'Acme',
            regions: ['global'],
            enrichment: { salary_min: 140000 }, // Missing currency and period
          },
        ],
        meta: { total: 3, limit: 3, offset: 0 },
      }));
      const result = await runStructuredDiscovery(new FixtureHttpClient(routes), config);
      const freehireVacancies = result.vacancies.filter((v) => v.provider === 'freehire');
      expect(freehireVacancies).toHaveLength(3);
      expect(freehireVacancies.map((v) => v.currency)).toEqual([null, null, null]);
      expect(freehireVacancies.map((v) => v.employmentType)).toEqual([null, null, null]);
    });

    it('detects when API ignores request parameters and reports as error', async () => {
      const routes = emptyStructuredRoutes();
      routes.set(FREEHIRE_URL, JSON.stringify({
        data: [],
        meta: {
          total: 0,
          limit: 2,
          offset: 0,
          ignored_params: ['category', 'salary_min'],
        },
      }));
      const result = await runStructuredDiscovery(new FixtureHttpClient(routes), config);
      const freehireSource = result.sources.find((s) => s.provider === 'freehire');
      expect(freehireSource).toMatchObject({
        status: 'error',
        error: expect.stringContaining('ignored filters: category, salary_min'),
      });
    });

    it('detects server errors (5xx) as errors without blocking other providers', async () => {
      const routes = emptyStructuredRoutes();
      routes.set(FREEHIRE_URL, {
        status: 500,
        finalUrl: FREEHIRE_URL,
        headers: {},
        body: 'Internal Server Error',
      });
      const result = await runStructuredDiscovery(new FixtureHttpClient(routes), config);
      const freehireSource = result.sources.find((s) => s.provider === 'freehire');
      expect(freehireSource).toMatchObject({
        status: 'error',
        listings: 0,
      });
      // FreeHire error should not block other providers
      const otherSources = result.sources.filter((s) => s.provider !== 'freehire');
      expect(otherSources.every((s) => s.status === 'success')).toBe(true);
    });

    it('records single request even if partial response returned', async () => {
      const routes = emptyStructuredRoutes();
      routes.set(FREEHIRE_URL, JSON.stringify({
        data: Array.from({ length: 10 }, (_, i) => ({
          public_slug: `job-${i}`,
          url: 'https://jobs.ashbyhq.com/acme/job',
          title: `Job ${i}`,
          company: 'Acme',
          regions: ['global'],
          enrichment: { salary_min: 140000, salary_currency: 'USD', salary_period: 'year' },
        })),
        meta: { total: 500, limit: 10, offset: 0 },
      }));
      const result = await runStructuredDiscovery(new FixtureHttpClient(routes), config);
      const freehireSource = result.sources.find((s) => s.provider === 'freehire');
      expect(freehireSource).toMatchObject({ requests: 1, status: 'partial' });
    });
  });

  it('normalizes four public APIs and rejects non-ATS Freehire links', async () => {
    const routes = emptyStructuredRoutes();
    routes.set(FREEHIRE_URL, JSON.stringify({
      data: [
        {
          public_slug: 'acme-senior-frontend',
          url: 'https://jobs.ashbyhq.com/acme/frontend?utm_source=freehire.me',
          title: 'Senior Frontend Engineer',
          company: 'Acme',
          location: 'Remote',
          regions: ['global'],
          countries: [],
          description: 'Build the customer-facing application.',
          posted_at: '2026-08-20T09:00:00Z',
          enrichment: {
            employment_type: 'full_time',
            salary_min: 140000,
            salary_currency: 'USD',
            salary_period: 'year',
          },
        },
        {
          public_slug: 'aggregator-only',
          url: 'https://example-job-board.invalid/jobs/frontend',
          title: 'Frontend Engineer',
          company: 'Unknown',
          regions: ['global'],
          enrichment: { salary_min: 160000, salary_currency: 'USD', salary_period: 'year' },
        },
      ],
      meta: { total: 2, limit: 2, offset: 0 },
    }));
    routes.set(JOB_OPPORTUNITIES_URL, JSON.stringify({
      data: [{
        id: 'joa-1',
        title: 'Frontend Developer',
        company: 'Ledger Co',
        location: 'Worldwide',
        remote: 'remote',
        remote_inferred: false,
        salary_min: 125000,
        salary_currency: 'USD',
        salary_period: 'year',
        posted_at: '2026-08-21T09:00:00Z',
        apply_url: 'https://jobs.lever.co/ledger/frontend',
        source_type: 'ats',
        field_sources: { salary: 'published', remote: 'published' },
      }],
      has_more: false,
    }));
    routes.set(REMOTE_LANDERS_URL, JSON.stringify({
      total: 1,
      page: 1,
      limit: 100,
      count: 1,
      jobs: [{
        slug: 'europe-frontend',
        title: 'Frontend Engineer',
        company: 'Landers Co',
        location: 'Europe',
        type: 'Full-time',
        salary: '$145k–155k / yr',
        postedDate: '2026-08-22',
        applyUrl: 'https://boards.greenhouse.io/landers/jobs/1',
      }],
    }));
    routes.set(JOBGETHER_URL, JSON.stringify({
      jobs: [{
        id: 'jobgether-1',
        title: 'Angular Developer',
        company: 'Remote Co',
        url: 'https://jobgether.com/offer/jobgether-1-angular-developer',
        location: 'Worldwide',
        remote: 'Full Remote',
        contractType: 'Full time',
        salaryRange: '110000-150000 USD',
        postedAt: '2026-08-23T09:00:00.000Z',
      }],
      pagination: { page: 1, limit: 25, hasMore: false },
    }));

    const result = await runStructuredDiscovery(new FixtureHttpClient(routes), config);

    expect(result.sources.map((source) => source.provider)).toEqual([
      'freehire',
      'job_opportunities',
      'remote_landers',
      'jobgether',
    ]);
    expect(result.sources.every((source) => source.status === 'success')).toBe(true);
    expect(result.vacancies).toHaveLength(4);
    expect(result.vacancies.map((vacancy) => vacancy.decision)).toEqual([
      'official_review_candidate',
      'official_review_candidate',
      'official_review_candidate',
      'official_review_candidate',
    ]);
    expect(result.vacancies.find((vacancy) => vacancy.provider === 'remote_landers'))
      .toMatchObject({ advertisedMinimum: 145_000, annualizedMinimumUsd: 145_000, postedAt: '2026-08-22T00:00:00.000Z' });
    expect(result.vacancies.some((vacancy) => vacancy.url.includes('.invalid'))).toBe(false);
    expect(result.vacancies.find((vacancy) => vacancy.provider === 'freehire'))
      .toMatchObject({ postedAt: '2026-08-20T09:00:00.000Z' });
    expect(result.vacancies.find((vacancy) => vacancy.provider === 'job_opportunities'))
      .toMatchObject({ postedAt: '2026-08-21T09:00:00.000Z' });
    expect(result.vacancies.find((vacancy) => vacancy.provider === 'jobgether'))
      .toMatchObject({ postedAt: '2026-08-23T09:00:00.000Z' });
  });

  it('records a blocked source without aborting the other providers', async () => {
    const routes = emptyStructuredRoutes();
    routes.set(FREEHIRE_URL, {
      status: 403,
      finalUrl: FREEHIRE_URL,
      headers: {},
      body: 'Forbidden',
    });

    const result = await runStructuredDiscovery(new FixtureHttpClient(routes), config);

    expect(result.sources.find((source) => source.provider === 'freehire'))
      .toMatchObject({ status: 'blocked', requests: 1, listings: 0 });
    expect(result.sources.filter((source) => source.provider !== 'freehire')
      .every((source) => source.status === 'success')).toBe(true);
  });

  it('omits the role-query parameter entirely when no default role is configured, rather than sending an empty string', async () => {
    const unconfigured: GlobalRemoteConfig = {
      ...config,
      minimumAnnualBaseUsd: null,
      discovery: { ...config.discovery, roleQuery: '' },
    };
    const routes = new Map<string, string | AtsHttpResponse>([
      [
        'https://freehire.me/api/v1/jobs/search?work_mode=remote&regions=global%2Ceu&salary_currency=USD&reality=fresh&posted_within_days=30&sort=posted_at&order=desc&limit=2',
        JSON.stringify({ data: [], meta: { total: 0, limit: 2, offset: 0 } }),
      ],
      [
        'https://api.jobopportunitiesapi.org/public/jobs?remote_confirmed=true&require_fields=salary&limit=2',
        JSON.stringify({ data: [], has_more: false }),
      ],
      [REMOTE_LANDERS_URL, JSON.stringify({ total: 0, page: 1, limit: 100, count: 0, jobs: [] })],
      [
        'https://jobgether.com/astroapi/ai/jobs.json?remoteType=full-remote&includeHybrid=false&currency=USD&sort=date&page=1&limit=25',
        JSON.stringify({ jobs: [], pagination: { page: 1, limit: 25, hasMore: false } }),
      ],
    ]);
    const http = new FixtureHttpClient(routes);

    const result = await runStructuredDiscovery(http, unconfigured);

    expect(result.sources.every((source) => source.status === 'success')).toBe(true);
    expect(http.requestedUrls.some((url) => url.includes('frontend'))).toBe(false);
  });
});
