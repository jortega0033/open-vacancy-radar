import { describe, expect, it } from 'vitest';

import type { AtsHttpResponse } from '../../src/ats/http.js';
import { runFeedDiscovery } from '../../src/global-remote/feed-discovery.js';
import type { GlobalRemoteConfig } from '../../src/global-remote/models.js';
import { FixtureHttpClient } from '../ats/helpers.js';

const WWR_URL = 'https://weworkremotely.com/categories/remote-front-end-programming-jobs.rss';
const REMOTE_FIRST_URL = 'https://remotefirstjobs.com/api/search-jobs?query=frontend&page=0';
const JOB_REMOTELY_URL = 'https://jobremotely.io/api/v1/jobs?search=frontend&salaryMin=100000&sort=newest&page=1&limit=50';
const REMOTE_OK_URL = 'https://remoteok.com/api';
const ARBEITNOW_URL = 'https://www.arbeitnow.com/api/job-board-api?page=1';
const STARTUP_JOBS_URL = 'https://startup.jobs/feeds/jobs?role=engineering&workplace=remote';
const DEVITJOBS_URL = 'https://devitjobs.nl/rss';
const JOBS_COLLIDER_URL = 'https://jobscollider.com/remote-jobs.rss';
const WORKING_NOMADS_URL = 'https://www.workingnomads.com/api/exposed_jobs/';
const REAL_WORK_URL = 'https://www.realworkfromanywhere.com/remote-frontend-jobs/rss.xml';
const DEVITJOBS_UK_URL = 'https://devitjobs.uk/rss';
const JOBSPRESSO_URL = 'https://jobspresso.co/?feed=job_feed';
const REMOTE_FRONTEND_JOBS_URL = 'https://www.remotefrontendjobs.com/feed.xml';

const config: GlobalRemoteConfig = {
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
  },
  officialSources: [],
};

function rss(item: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?><rss version="2.0"><channel><title>Jobs</title>${item}</channel></rss>`;
}

function routes(): Map<string, string | AtsHttpResponse> {
  return new Map([
    [WWR_URL, rss(`<item>
      <title>Acme: Senior Frontend Engineer</title>
      <region>Anywhere in the World</region><type>Full-Time</type>
      <description><![CDATA[Annual base salary $150,000 per year.]]></description>
      <guid>wwr-1</guid><link>https://weworkremotely.com/remote-jobs/acme-frontend</link>
    </item>`)],
    [REMOTE_FIRST_URL, JSON.stringify({
      page: 0,
      jobs_count: 1,
      jobs: [{
        id: 'rf-1',
        url: 'https://remotefirstjobs.com/companies/acme/jobs/frontend-rf-1',
        company_name: 'Remote First Co',
        title: 'Frontend Developer',
        description: '<p>Build accessible interfaces.</p>',
        salary_min: 130000,
        salary_max: 160000,
        locations: ['Europe'],
      }],
    })],
    [JOB_REMOTELY_URL, JSON.stringify({
      success: true,
      data: {
        jobs: [{
          id: 'jr-1',
          title: 'Angular Developer',
          url: 'https://jobremotely.io/jobs/angular-developer',
          location: 'EU',
          jobType: 'REMOTE',
          salary: { min: 120000, max: 140000, currency: 'USD' },
          skillsRequired: ['angular', 'typescript'],
        }],
        page: 1,
        pages: 1,
        total: 1,
        limit: 50,
      },
    })],
    [REMOTE_OK_URL, JSON.stringify([
      { last_updated: 1, legal: 'Attribution required.' },
      {
        id: 'rok-1',
        position: 'UI Engineer',
        company: 'Remote OK Co',
        location: 'Worldwide',
        apply_url: 'https://remoteok.com/remote-jobs/ui-engineer-rok-1',
        salary_min: 140000,
        salary_max: 170000,
        description: 'Build the web UI.',
      },
    ])],
    [ARBEITNOW_URL, JSON.stringify({
      data: [{
        slug: 'arbeit-1',
        company_name: 'Arbeit Co',
        title: 'Frontend Engineer',
        description: 'Remote annual salary $110,000 per year.',
        remote: true,
        url: 'https://www.arbeitnow.com/jobs/companies/arbeit/frontend-engineer-1',
        job_types: ['Full-time'],
        location: 'Netherlands',
      }],
      links: { next: null },
      meta: { current_page: 1 },
    })],
    [STARTUP_JOBS_URL, rss(`<item>
      <title>Frontend Developer at Startup Co</title>
      <description><![CDATA[Annual salary $135,000 per year.]]></description>
      <guid>startup-1</guid><link>https://startup.jobs/frontend-developer-startup-1</link>
    </item>`)],
    [DEVITJOBS_URL, rss(`<item>
      <title>Angular Developer @ Dutch Co [€80.000 - 100.000]</title>
      <description><![CDATA[Frontend product development in Amsterdam.]]></description>
      <guid>devit-1</guid><link>https://devitjobs.nl/jobs/dutch-angular-developer</link>
    </item>`)],
    [JOBS_COLLIDER_URL, rss(`<item>
      <title>Frontend Engineer at Collider Co</title>
      <description><![CDATA[Remote role paying $145,000 per year.]]></description>
      <guid>collider-1</guid><link>https://jobscollider.com/remote-jobs/frontend-engineer-1</link>
    </item>`)],
    [WORKING_NOMADS_URL, JSON.stringify([{
      id: 'wn-1',
      title: 'Senior Frontend Developer',
      company_name: 'Nomad Co',
      url: 'https://www.workingnomads.com/jobs/senior-frontend-developer-wn-1',
      location: 'Anywhere',
      description: '<p>Base salary $150,000 per year.</p>',
    }])],
    [REAL_WORK_URL, rss(`<item>
      <title>Frontend Engineer at Anywhere Co</title>
      <description><![CDATA[Worldwide role paying $125,000 annually.]]></description>
      <guid>rwfa-1</guid><link>https://www.realworkfromanywhere.com/jobs/frontend-engineer-rwfa-1</link>
    </item>`)],
    [DEVITJOBS_UK_URL, rss(`<item>
      <title>Frontend Developer @ British Co [£100,000 - 120,000]</title>
      <description><![CDATA[Build web applications in the United Kingdom.]]></description>
      <guid>devit-uk-1</guid><link>https://devitjobs.uk/jobs/british-frontend-developer</link>
    </item>`)],
    [JOBSPRESSO_URL, rss(`<item>
      <title>Senior Frontend Engineer</title>
      <dc:creator><![CDATA[Presso Co<br>⚲&nbsp;Worldwide]]></dc:creator>
      <description><![CDATA[Remote role paying $140,000 per year.]]></description>
      <guid isPermaLink="false">https://jobspresso.co/?post_type=job_listing&#038;p=1</guid>
      <link>https://jobspresso.co/job/senior-frontend-engineer/</link>
    </item>`)],
    [REMOTE_FRONTEND_JOBS_URL, rss(`<item>
      <title><![CDATA[Senior Frontend Engineer at Frontend Jobs Co]]></title>
      <description><![CDATA[React role paying $150,000 annually.]]></description>
      <guid>rfj-1</guid><link>https://www.remotefrontendjobs.com/rfj-1</link>
    </item>`)],
  ]);
}

describe('credential-free JSON and RSS discovery feeds', () => {
  it('normalizes all thirteen credential-free providers without upgrading aggregator claims', async () => {
    const result = await runFeedDiscovery(new FixtureHttpClient(routes()), config);

    expect(result.sources.map((source) => source.provider)).toEqual([
      'we_work_remotely',
      'remote_first_jobs',
      'job_remotely',
      'remote_ok',
      'arbeitnow',
      'startup_jobs',
      'devitjobs_nl',
      'jobs_collider',
      'working_nomads',
      'real_work_from_anywhere',
      'devitjobs_uk',
      'jobspresso',
      'remote_frontend_jobs',
    ]);
    expect(result.sources.every((source) => source.status === 'success')).toBe(true);
    expect(result.vacancies).toHaveLength(13);
    expect(result.vacancies.filter((vacancy) => vacancy.decision === 'official_review_candidate'))
      .toHaveLength(8);
    expect(result.vacancies.find((vacancy) => vacancy.provider === 'job_remotely'))
      .toMatchObject({ company: 'Unspecified employer (JobRemotely)' });
    expect(result.vacancies.find((vacancy) => vacancy.provider === 'startup_jobs'))
      .toMatchObject({ decision: 'location_restricted' });
    expect(result.vacancies.find((vacancy) => vacancy.provider === 'devitjobs_nl'))
      .toMatchObject({ decision: 'salary_unverified', currency: 'EUR' });
    expect(result.vacancies.find((vacancy) => vacancy.provider === 'jobs_collider'))
      .toMatchObject({ decision: 'location_restricted' });
    expect(result.vacancies.find((vacancy) => vacancy.provider === 'working_nomads'))
      .toMatchObject({ company: 'Nomad Co', decision: 'official_review_candidate' });
    expect(result.vacancies.find((vacancy) => vacancy.provider === 'real_work_from_anywhere'))
      .toMatchObject({ company: 'Anywhere Co', location: 'Worldwide', decision: 'salary_unverified' });
    expect(result.vacancies.find((vacancy) => vacancy.provider === 'devitjobs_uk'))
      .toMatchObject({ decision: 'location_restricted', currency: 'GBP' });
    expect(result.vacancies.find((vacancy) => vacancy.provider === 'jobspresso'))
      .toMatchObject({ company: 'Presso Co', location: 'Worldwide', decision: 'official_review_candidate' });
    expect(result.vacancies.find((vacancy) => vacancy.provider === 'remote_frontend_jobs'))
      .toMatchObject({ company: 'Frontend Jobs Co', location: 'Worldwide', decision: 'official_review_candidate' });
  });

  it('records a blocked feed and continues every other provider', async () => {
    const fixtureRoutes = routes();
    fixtureRoutes.set(REMOTE_OK_URL, {
      status: 403,
      finalUrl: REMOTE_OK_URL,
      headers: {},
      body: 'Forbidden',
    });

    const result = await runFeedDiscovery(new FixtureHttpClient(fixtureRoutes), config);

    expect(result.sources.find((source) => source.provider === 'remote_ok'))
      .toMatchObject({ status: 'blocked', requests: 1, listings: 0 });
    expect(result.sources.filter((source) => source.provider !== 'remote_ok')
      .every((source) => source.status === 'success')).toBe(true);
    expect(result.vacancies).toHaveLength(12);
  });
});
