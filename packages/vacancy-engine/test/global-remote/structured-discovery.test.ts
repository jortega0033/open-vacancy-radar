import { describe, expect, it } from 'vitest';

import { AtsResponseError, type AtsHttpResponse } from '../../src/ats/http.js';
import {
  fetchJobgetherOfferDetail,
  fetchWorkableJobDetail,
  jobgetherOfferIdFromUrl,
  runStructuredDiscovery,
  workableJobReferenceFromUrl,
} from '../../src/global-remote/structured-discovery.js';
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

describe('jobgetherOfferIdFromUrl', () => {
  it('extracts the 24-hex-char id from a real offer URL', () => {
    expect(jobgetherOfferIdFromUrl('https://jobgether.com/offer/6a6144881b23f4f87b3172fb-senior-frontend-engineer-benelux'))
      .toBe('6a6144881b23f4f87b3172fb');
  });

  it('returns null for a URL that is not a Jobgether offer link', () => {
    expect(jobgetherOfferIdFromUrl('https://himalayas.app/jobs/himalayas-1')).toBeNull();
    expect(jobgetherOfferIdFromUrl('https://jobgether.com/company/lateralgroup')).toBeNull();
  });

  it('still extracts the id when the URL carries a query string or fragment instead of a slug', () => {
    // A URL a real user actually clicked through, or one a tracking param got appended to, can look
    // like this even though nothing a scan discovers ever does.
    expect(jobgetherOfferIdFromUrl('https://jobgether.com/offer/6a6144881b23f4f87b3172fb?ref=email'))
      .toBe('6a6144881b23f4f87b3172fb');
    expect(jobgetherOfferIdFromUrl('https://jobgether.com/offer/6a6144881b23f4f87b3172fb#requirements'))
      .toBe('6a6144881b23f4f87b3172fb');
  });
});

describe('fetchJobgetherOfferDetail', () => {
  // Real-world regression: this endpoint was verified live against the actual Jobgether API (not
  // assumed from documentation) while investigating why "Prepare application" refused every real
  // Jobgether result -- the list scan's own response never carries a description at all, but this
  // per-offer endpoint does, as plain HTML with no page chrome (nav, "Related jobs", footer links)
  // mixed in, unlike the public offer page.
  const OFFER_URL = 'https://jobgether.com/astroapi/offer/6a6144881b23f4f87b3172fb.json';

  it('extracts the description from the real response shape, converted to plain text', async () => {
    const http = new FixtureHttpClient(new Map([
      [
        OFFER_URL,
        JSON.stringify({
          offer: {
            _id: '6a6144881b23f4f87b3172fb',
            title: 'Senior Frontend Engineer (Benelux)',
            description: '<p>Lateral stands for technology excellence.</p><h3>What You’ll Do</h3><p>Build things.</p>',
          },
        }),
      ],
    ]));

    const detail = await fetchJobgetherOfferDetail(http, '6a6144881b23f4f87b3172fb');

    expect(detail).toEqual({
      description: 'Lateral stands for technology excellence.\n\nWhat You’ll Do\n\nBuild things.',
    });
  });

  it('resolves to a null description, not an empty string, for an offer that no longer exists', async () => {
    const http = new FixtureHttpClient(new Map([
      [OFFER_URL, { status: 404, finalUrl: OFFER_URL, headers: {}, body: '' }],
    ]));

    const detail = await fetchJobgetherOfferDetail(http, '6a6144881b23f4f87b3172fb');

    expect(detail).toEqual({ description: null });
  });

  it('throws instead of silently returning an empty description when the response shape changes unexpectedly', async () => {
    const http = new FixtureHttpClient(new Map([[OFFER_URL, 'not valid json']]));

    await expect(fetchJobgetherOfferDetail(http, '6a6144881b23f4f87b3172fb')).rejects.toBeInstanceOf(AtsResponseError);
  });

  it('resolves to a null description when the offer object carries none', async () => {
    const http = new FixtureHttpClient(new Map([
      [OFFER_URL, JSON.stringify({ offer: { _id: '6a6144881b23f4f87b3172fb', title: 'No description here' } })],
    ]));

    const detail = await fetchJobgetherOfferDetail(http, '6a6144881b23f4f87b3172fb');

    expect(detail).toEqual({ description: null });
  });
});

describe('workableJobReferenceFromUrl', () => {
  it('reads the short apply URL the workable_global feed actually emits', () => {
    // `workable-feed.ts` rejects any job whose <url> is not exactly this, so this is the only shape
    // a scanned workable_global vacancy can ever reach "Prepare application" with.
    expect(workableJobReferenceFromUrl('https://apply.workable.com/j/F587C0434B')).toEqual({
      account: null,
      shortcode: 'F587C0434B',
    });
  });

  it('keeps the account when the URL is already the canonical one the short form redirects to', () => {
    // Worth one less request: a saved or hand-corrected apply URL is usually this one, because it is
    // what the address bar shows after Workable's own 301.
    expect(workableJobReferenceFromUrl('https://apply.workable.com/nhfca/j/EA3E38A2AA/')).toEqual({
      account: 'nhfca',
      shortcode: 'EA3E38A2AA',
    });
  });

  it('ignores a tracking query string or fragment rather than failing to parse', () => {
    expect(workableJobReferenceFromUrl('https://apply.workable.com/j/f587c0434b?utm_source=email'))
      .toEqual({ account: null, shortcode: 'F587C0434B' });
    expect(workableJobReferenceFromUrl('https://apply.workable.com/nhfca/j/EA3E38A2AA#apply'))
      .toEqual({ account: 'nhfca', shortcode: 'EA3E38A2AA' });
  });

  it('returns null for a Workable URL that is not a single job listing', () => {
    expect(workableJobReferenceFromUrl('https://apply.workable.com/nhfca/')).toBeNull();
    expect(workableJobReferenceFromUrl('https://apply.workable.com/oops')).toBeNull();
    expect(workableJobReferenceFromUrl('https://www.workable.com/boards/workable.xml')).toBeNull();
    expect(workableJobReferenceFromUrl('https://jobs.workable.com/view/1234/some-role')).toBeNull();
  });

  it('returns null for anything that is not a Workable apply URL at all', () => {
    expect(workableJobReferenceFromUrl('https://jobgether.com/offer/6a6144881b23f4f87b3172fb')).toBeNull();
    expect(workableJobReferenceFromUrl('https://apply.workable.com.evil.example/j/F587C0434B')).toBeNull();
    expect(workableJobReferenceFromUrl('http://apply.workable.com/j/F587C0434B')).toBeNull();
    expect(workableJobReferenceFromUrl('not a url at all')).toBeNull();
  });

  it('rejects a path that only looks like a shortcode', () => {
    // Every one of the 33,013 job URLs in a live all-customer feed pull was exactly ten hex
    // characters; anything else is a URL this has misread, not a listing worth a request.
    expect(workableJobReferenceFromUrl('https://apply.workable.com/j/F587C0434')).toBeNull();
    expect(workableJobReferenceFromUrl('https://apply.workable.com/j/F587C0434BB')).toBeNull();
    expect(workableJobReferenceFromUrl('https://apply.workable.com/j/ZZZZZZZZZZ')).toBeNull();
  });
});

describe('fetchWorkableJobDetail', () => {
  // Verified live against the real endpoint while building the workable_global detail fetch, not
  // assumed from documentation: this is the same `/api/v2/accounts/<account>/jobs/<shortcode>` route
  // apply.workable.com's own front end calls (found in its `careers.*.js` bundle), and it answers
  // with the full posting split across `description`, `requirements` and `benefits`. The listing
  // page itself is an 8 KB JavaScript shell whose only posting text is a truncated og:description.
  const SHORT_URL = 'https://apply.workable.com/j/F587C0434B';
  const CANONICAL_URL = 'https://apply.workable.com/heartstrings/j/F587C0434B';
  const DETAIL_URL = 'https://apply.workable.com/api/v2/accounts/heartstrings/jobs/F587C0434B';

  function redirectToCanonical(): AtsHttpResponse {
    return { status: 200, finalUrl: CANONICAL_URL, headers: {}, body: '<!doctype html><html></html>' };
  }

  it('joins the three posting fields the apply page itself renders, converted to plain text', async () => {
    const http = new FixtureHttpClient(new Map<string, string | AtsHttpResponse>([
      [SHORT_URL, redirectToCanonical()],
      [
        DETAIL_URL,
        JSON.stringify({
          id: 5_517_737,
          shortcode: 'F587C0434B',
          title: 'Part-Time Mobile Veterinarian',
          description: '<h3>About us</h3><p>We visit families at home.</p>',
          requirements: '<h3>Requirements</h3><ul><li>DVM from an accredited school</li></ul>',
          benefits: '<h3>Benefits</h3><ul><li>Paid time off</li></ul>',
        }),
      ],
    ]));

    const detail = await fetchWorkableJobDetail(http, { account: null, shortcode: 'F587C0434B' });

    // Dropping `requirements` would silently throw away the half of a real Workable posting that
    // actually lists what the role needs, which is the half tailoring depends on most.
    expect(detail).toEqual({
      description: 'About us\n\nWe visit families at home.\n\nRequirements\n\nDVM from an accredited school\n\nBenefits\n\nPaid time off',
    });
    expect(http.requestedUrls).toEqual([SHORT_URL, DETAIL_URL]);
  });

  it('skips the redirect lookup entirely when the URL already named the account', async () => {
    const http = new FixtureHttpClient(new Map([
      [DETAIL_URL, JSON.stringify({ shortcode: 'F587C0434B', description: '<p>Only one request.</p>' })],
    ]));

    const detail = await fetchWorkableJobDetail(http, { account: 'heartstrings', shortcode: 'F587C0434B' });

    expect(detail).toEqual({ description: 'Only one request.' });
    expect(http.requestedUrls).toEqual([DETAIL_URL]);
  });

  it('asks for at most one retry, because this runs inside a click someone is waiting on', async () => {
    const http = new FixtureHttpClient(new Map([
      [DETAIL_URL, JSON.stringify({ shortcode: 'F587C0434B', description: '<p>Text.</p>' })],
    ]));

    await fetchWorkableJobDetail(http, { account: 'heartstrings', shortcode: 'F587C0434B' });

    expect(http.requestedOptions[0]).toMatchObject({ maxRetries: 1, cache: 'no-store' });
  });

  it('resolves to a null description for a shortcode that no longer resolves to a live job', async () => {
    // Workable answers a dead shortcode with a 200 redirect to its generic /oops page rather than a
    // 404, so the destination is what says "gone", not the status code.
    const http = new FixtureHttpClient(new Map<string, string | AtsHttpResponse>([
      [SHORT_URL, { status: 200, finalUrl: 'https://apply.workable.com/oops', headers: {}, body: '' }],
    ]));

    const detail = await fetchWorkableJobDetail(http, { account: null, shortcode: 'F587C0434B' });

    expect(detail).toEqual({ description: null });
    expect(http.requestedUrls).toEqual([SHORT_URL]);
  });

  it('resolves to a null description, not an empty string, when the detail endpoint 404s', async () => {
    const http = new FixtureHttpClient(new Map<string, string | AtsHttpResponse>([
      [DETAIL_URL, { status: 404, finalUrl: DETAIL_URL, headers: {}, body: 'Job not found' }],
    ]));

    const detail = await fetchWorkableJobDetail(http, { account: 'heartstrings', shortcode: 'F587C0434B' });

    expect(detail).toEqual({ description: null });
  });

  it('throws rather than inventing a description when the detail response is not JSON', async () => {
    const http = new FixtureHttpClient(new Map([[DETAIL_URL, '<!doctype html><html>nope</html>']]));

    await expect(fetchWorkableJobDetail(http, { account: 'heartstrings', shortcode: 'F587C0434B' }))
      .rejects.toBeInstanceOf(AtsResponseError);
  });

  it('throws when the detail response is JSON of an unexpected shape', async () => {
    const http = new FixtureHttpClient(new Map([[DETAIL_URL, '["not", "an", "object"]']]));

    await expect(fetchWorkableJobDetail(http, { account: 'heartstrings', shortcode: 'F587C0434B' }))
      .rejects.toBeInstanceOf(AtsResponseError);
  });

  it('throws on a server error instead of reporting the listing as having no description', async () => {
    const http = new FixtureHttpClient(new Map<string, string | AtsHttpResponse>([
      [DETAIL_URL, { status: 503, finalUrl: DETAIL_URL, headers: {}, body: '' }],
    ]));

    await expect(fetchWorkableJobDetail(http, { account: 'heartstrings', shortcode: 'F587C0434B' }))
      .rejects.toBeInstanceOf(AtsResponseError);
  });

  it('resolves to a null description when the job carries no posting text at all', async () => {
    const http = new FixtureHttpClient(new Map([
      [DETAIL_URL, JSON.stringify({ shortcode: 'F587C0434B', title: 'Untitled', description: '  ' })],
    ]));

    const detail = await fetchWorkableJobDetail(http, { account: 'heartstrings', shortcode: 'F587C0434B' });

    expect(detail).toEqual({ description: null });
  });
});
