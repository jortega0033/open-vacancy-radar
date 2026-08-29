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

function emptyStructuredRoutes(): Map<string, string | AtsHttpResponse> {
  return new Map([
    [FREEHIRE_URL, JSON.stringify({ data: [], meta: { total: 0, limit: 2, offset: 0 } })],
    [JOB_OPPORTUNITIES_URL, JSON.stringify({ data: [], has_more: false })],
    [REMOTE_LANDERS_URL, JSON.stringify({ total: 0, page: 1, limit: 100, count: 0, jobs: [] })],
    [JOBGETHER_URL, JSON.stringify({ jobs: [], pagination: { page: 1, limit: 25, hasMore: false } })],
  ]);
}

describe('structured global-remote discovery', () => {
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
      .toMatchObject({ advertisedMinimum: 145_000, annualizedMinimumUsd: 145_000 });
    expect(result.vacancies.some((vacancy) => vacancy.url.includes('.invalid'))).toBe(false);
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
});
