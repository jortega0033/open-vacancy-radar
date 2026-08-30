import { describe, expect, it } from 'vitest';

import {
  globalRemoteSourceSchema,
  type GlobalRemoteConfig,
} from '../../src/global-remote/models.js';
import { runOfficialGlobalRemoteSources } from '../../src/global-remote/official.js';
import { atsFixture, FixtureHttpClient } from '../ats/helpers.js';

const review = {
  roleFrontendOnly: true,
  usMarketRole: 'uncertain' as const,
  fullyRemote: 'uncertain' as const,
  outsideUsEligible: 'uncertain' as const,
  minimumAnnualBaseUsd: null,
  salaryAppliesOutsideUs: 'uncertain' as const,
  notes: [],
};

function config(officialSources: GlobalRemoteConfig['officialSources']): GlobalRemoteConfig {
  return {
    version: 'test',
    minimumAnnualBaseUsd: 100_000,
    discovery: {
      himalayasQueries: ['frontend'],
      himalayasCountry: 'Worldwide',
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
    },
    officialSources,
  };
}

describe('official global-remote ATS coverage', () => {
  it.each([
    'ashby',
    'greenhouse',
    'lever',
    'personio',
    'recruitee',
    'smartrecruiters',
    'successfactors',
    'teamtailor',
    'workable',
    'workday',
    'html',
  ] as const)('accepts the production %s provider in reviewed configuration', (provider) => {
    expect(
      globalRemoteSourceSchema.safeParse({
        id: `${provider}-source`,
        company: 'Acme',
        provider,
        boardIdentifier: provider === 'html' ? null : 'acme',
        externalId: 'job-1',
        expectedTitle: 'Frontend Engineer',
        url: 'https://example.com/jobs/1',
        reviewedAt: '2026-08-30',
        reviewedContentHash: null,
        review,
      }).success,
    ).toBe(true);
  });

  it('runs a reviewed Workable source through the official-source adapter factory', async () => {
    const http = new FixtureHttpClient(
      new Map([
        [
          'https://www.workable.com/api/accounts/acme?details=true',
          await atsFixture('workable/jobs.json'),
        ],
      ]),
    );

    const result = await runOfficialGlobalRemoteSources(
      http,
      config([
        {
          id: 'workable-acme-hybrid',
          company: 'Acme',
          provider: 'workable',
          boardIdentifier: 'acme',
          externalId: 'HYBRID123',
          expectedTitle: 'Senior Platform Engineer',
          url: 'https://apply.workable.com/acme/j/HYBRID123/',
          reviewedAt: '2026-08-30',
          reviewedContentHash: null,
          review,
        },
      ]),
    );

    expect(result.requestCount).toBe(1);
    expect(result.audits[0]).toMatchObject({
      provider: 'workable',
      state: 'active',
      title: 'Senior Platform Engineer',
      url: 'https://apply.workable.com/j/HYBRID123',
    });
  });

  it('does not mark a missing vacancy inactive when its board scan was incomplete', async () => {
    const http = new FixtureHttpClient(
      new Map([
        [
          'https://www.workable.com/api/accounts/acme?details=true',
          JSON.stringify({ jobs: [{ shortcode: 'BROKEN', title: 'Missing description' }] }),
        ],
      ]),
    );

    const result = await runOfficialGlobalRemoteSources(
      http,
      config([
        {
          id: 'workable-acme-missing',
          company: 'Acme',
          provider: 'workable',
          boardIdentifier: 'acme',
          externalId: 'NOT-RETURNED',
          expectedTitle: 'Frontend Engineer',
          url: 'https://apply.workable.com/acme/j/NOT-RETURNED/',
          reviewedAt: '2026-08-30',
          reviewedContentHash: null,
          review,
        },
      ]),
    );

    expect(result.audits[0]).toMatchObject({
      state: 'error',
      decision: 'error',
    });
    expect(result.audits[0]?.evidence).toContain(
      'Board scan was incomplete, so absence cannot prove this vacancy is inactive.',
    );
  });

  it('runs a reviewed Personio source through the official-source adapter factory', async () => {
    const feedUrl = 'https://acme.jobs.personio.com/xml?language=en';
    const http = new FixtureHttpClient(
      new Map([[feedUrl, await atsFixture('personio/positions.xml')]]),
    );

    const result = await runOfficialGlobalRemoteSources(
      http,
      config([
        {
          id: 'personio-acme-platform',
          company: 'Acme',
          provider: 'personio',
          boardIdentifier: 'acme',
          externalId: '1834171',
          expectedTitle: 'Staff Software Engineer, Data Platform',
          url: 'https://acme.jobs.personio.com/job/1834171',
          reviewedAt: '2026-08-30',
          reviewedContentHash: null,
          review,
        },
      ]),
    );

    expect(result.requestCount).toBe(1);
    expect(result.audits[0]).toMatchObject({
      provider: 'personio',
      state: 'active',
      title: 'Staff Software Engineer, Data Platform',
      url: 'https://acme.jobs.personio.com/job/1834171',
    });
  });

  it('runs a reviewed SuccessFactors source through the official-source adapter factory', async () => {
    const origin = 'https://jobs.tetrapak.com';
    const http = new FixtureHttpClient(
      new Map([
        [`${origin}/job_sitemap.xml`, await atsFixture('successfactors/sitemap.xml')],
        [
          `${origin}/job/Bogota-Frontend-Engineer/1428907233/`,
          await atsFixture('successfactors/detail-microdata.html'),
        ],
        [
          `${origin}/job/Berlin-Platform-Engineer/883999301-de_DE/`,
          await atsFixture('successfactors/detail-jsonld.html'),
        ],
      ]),
    );

    const result = await runOfficialGlobalRemoteSources(
      http,
      config([
        {
          id: 'successfactors-tetrapak-frontend',
          company: 'Tetra Pak',
          provider: 'successfactors',
          boardIdentifier: 'jobs.tetrapak.com',
          externalId: '100283',
          expectedTitle: 'Senior Frontend Engineer',
          url: `${origin}/job/Frontend-Engineer/100283-en_GB/`,
          reviewedAt: '2026-08-30',
          reviewedContentHash: null,
          review,
        },
      ]),
    );

    expect(result.requestCount).toBe(3);
    expect(result.audits[0]).toMatchObject({
      provider: 'successfactors',
      state: 'active',
      title: 'Senior Frontend Engineer',
      url: `${origin}/job/Frontend-Engineer/100283-en_GB/`,
    });
  });
});
