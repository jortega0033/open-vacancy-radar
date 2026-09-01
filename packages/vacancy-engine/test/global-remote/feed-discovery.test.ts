import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import type { AtsHttpResponse } from '../../src/ats/http.js';
import { runFeedDiscovery } from '../../src/global-remote/feed-discovery.js';
import type { GlobalRemoteConfig } from '../../src/global-remote/models.js';
import { FixtureHttpClient } from '../ats/helpers.js';

const WWR_URL = 'https://weworkremotely.com/categories/remote-front-end-programming-jobs.rss';
const REMOTIVE_URL = 'https://remotive.com/remote-jobs/feed';
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
const UN_CAREERS_URL = 'https://careers.un.org/jobfeed?language=en';

const config: GlobalRemoteConfig = {
  version: 'test',
  minimumAnnualBaseUsd: 100_000,
  discovery: {
    roleQuery: 'frontend',
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

function rss(item: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?><rss version="2.0"><channel><title>Jobs</title>${item}</channel></rss>`;
}

function fixture(name: string): string {
  return readFileSync(path.resolve(process.cwd(), 'test/fixtures/global-remote', name), 'utf8');
}

function routes(): Map<string, string | AtsHttpResponse> {
  return new Map([
    [REMOTIVE_URL, fixture('remotive.rss')],
    [WWR_URL, rss(`<item>
      <title>Acme: Senior Frontend Engineer</title>
      <region>Anywhere in the World</region><type>Full-Time</type>
      <description><![CDATA[Annual base salary $150,000 per year.]]></description>
      <pubDate>Mon, 31 Aug 2026 16:30:27 +0000</pubDate>
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
        published_at: '2026-08-24T09:00:00',
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
          createdAt: '2026-08-25T09:00:00.000Z',
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
        date: '2026-08-26T09:00:00+00:00',
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
        created_at: 1788241217,
      }],
      links: { next: null },
      meta: { current_page: 1 },
    })],
    [STARTUP_JOBS_URL, rss(`<item>
      <title>Frontend Developer at Startup Co</title>
      <description><![CDATA[Annual salary $135,000 per year.]]></description>
      <pubDate>Mon, 31 Aug 2026 05:17:00 +0000</pubDate>
      <guid>startup-1</guid><link>https://startup.jobs/frontend-developer-startup-1</link>
    </item>`)],
    [DEVITJOBS_URL, rss(`<item>
      <title>Angular Developer @ Dutch Co [€80.000 - 100.000]</title>
      <description><![CDATA[Frontend product development in Amsterdam.]]></description>
      <pubDate>Mon, 31 Aug 2026 21:01:03 GMT</pubDate>
      <guid>devit-1</guid><link>https://devitjobs.nl/jobs/dutch-angular-developer</link>
    </item>`)],
    [JOBS_COLLIDER_URL, rss(`<item>
      <title>Frontend Engineer at Collider Co</title>
      <description><![CDATA[Remote role paying $145,000 per year.]]></description>
      <pubDate>Tue, 01 Sep 2026 00:20:52 +0000</pubDate>
      <guid>collider-1</guid><link>https://jobscollider.com/remote-jobs/frontend-engineer-1</link>
    </item>`)],
    [WORKING_NOMADS_URL, JSON.stringify([{
      id: 'wn-1',
      title: 'Senior Frontend Developer',
      company_name: 'Nomad Co',
      url: 'https://www.workingnomads.com/jobs/senior-frontend-developer-wn-1',
      location: 'Anywhere',
      description: '<p>Base salary $150,000 per year.</p>',
      pub_date: '2026-08-31T12:04:17-04:00',
    }])],
    [REAL_WORK_URL, rss(`<item>
      <title>Frontend Engineer at Anywhere Co</title>
      <description><![CDATA[Worldwide role paying $125,000 annually.]]></description>
      <pubDate>Wed, 05 Aug 2026 08:04:44 GMT</pubDate>
      <guid>rwfa-1</guid><link>https://www.realworkfromanywhere.com/jobs/frontend-engineer-rwfa-1</link>
    </item>`)],
    [DEVITJOBS_UK_URL, rss(`<item>
      <title>Frontend Developer @ British Co [£100,000 - 120,000]</title>
      <description><![CDATA[Build web applications in the United Kingdom.]]></description>
      <pubDate>Tue, 01 Sep 2026 06:09:06 GMT</pubDate>
      <guid>devit-uk-1</guid><link>https://devitjobs.uk/jobs/british-frontend-developer</link>
    </item>`)],
    [JOBSPRESSO_URL, rss(`<item>
      <title>Senior Frontend Engineer</title>
      <dc:creator><![CDATA[Presso Co<br>⚲&nbsp;Worldwide]]></dc:creator>
      <description><![CDATA[Remote role paying $140,000 per year.]]></description>
      <pubDate>Sat, 29 Aug 2026 02:12:12 +0000</pubDate>
      <guid isPermaLink="false">https://jobspresso.co/?post_type=job_listing&#038;p=1</guid>
      <link>https://jobspresso.co/job/senior-frontend-engineer/</link>
    </item>`)],
    [REMOTE_FRONTEND_JOBS_URL, rss(`<item>
      <title><![CDATA[Senior Frontend Engineer at Frontend Jobs Co]]></title>
      <description><![CDATA[React role paying $150,000 annually.]]></description>
      <guid>rfj-1</guid><link>https://www.remotefrontendjobs.com/rfj-1</link>
    </item>`)],
    [UN_CAREERS_URL, fixture('un-careers.rss')],
  ]);
}

describe('credential-free JSON and RSS discovery feeds', () => {
  it('normalizes all fifteen credential-free providers without upgrading aggregator claims', async () => {
    const result = await runFeedDiscovery(new FixtureHttpClient(routes()), config);

    expect(result.sources.map((source) => source.provider)).toEqual([
      'remotive',
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
      'un_careers',
    ]);
    expect(result.sources.every((source) => source.status === 'success')).toBe(true);
    expect(result.vacancies).toHaveLength(15);
    expect(result.vacancies.filter((vacancy) => vacancy.decision === 'official_review_candidate'))
      .toHaveLength(9);
    expect(result.vacancies.find((vacancy) => vacancy.provider === 'remotive'))
      .toMatchObject({
        key: 'remotive:2091000',
        company: 'Remotive Co',
        url: 'https://remotive.com/remote-jobs/software-development/senior-frontend-engineer-2091000',
        description: 'Build accessible interfaces. Annual base salary $150,000 per year.',
        postedAt: '2026-08-27T14:36:09.000Z',
      });
    expect(result.vacancies.find((vacancy) => vacancy.provider === 'we_work_remotely'))
      .toMatchObject({ postedAt: '2026-08-31T16:30:27.000Z' });
    expect(result.vacancies.find((vacancy) => vacancy.provider === 'remote_first_jobs'))
      .toMatchObject({ postedAt: '2026-08-24T09:00:00.000Z' });
    expect(result.vacancies.find((vacancy) => vacancy.provider === 'job_remotely'))
      .toMatchObject({ company: 'Unspecified employer (JobRemotely)', postedAt: '2026-08-25T09:00:00.000Z' });
    expect(result.vacancies.find((vacancy) => vacancy.provider === 'remote_ok'))
      .toMatchObject({ postedAt: '2026-08-26T09:00:00.000Z' });
    expect(result.vacancies.find((vacancy) => vacancy.provider === 'arbeitnow'))
      .toMatchObject({ postedAt: '2026-09-01T05:40:17.000Z' });
    expect(result.vacancies.find((vacancy) => vacancy.provider === 'startup_jobs'))
      .toMatchObject({ decision: 'location_restricted', postedAt: '2026-08-31T05:17:00.000Z' });
    expect(result.vacancies.find((vacancy) => vacancy.provider === 'devitjobs_nl'))
      .toMatchObject({ decision: 'salary_unverified', currency: 'EUR', postedAt: '2026-08-31T21:01:03.000Z' });
    expect(result.vacancies.find((vacancy) => vacancy.provider === 'jobs_collider'))
      .toMatchObject({ decision: 'location_restricted', postedAt: '2026-09-01T00:20:52.000Z' });
    expect(result.vacancies.find((vacancy) => vacancy.provider === 'working_nomads'))
      .toMatchObject({ company: 'Nomad Co', decision: 'official_review_candidate', postedAt: '2026-08-31T16:04:17.000Z' });
    expect(result.vacancies.find((vacancy) => vacancy.provider === 'real_work_from_anywhere'))
      .toMatchObject({ company: 'Anywhere Co', location: 'Worldwide', decision: 'salary_unverified', postedAt: '2026-08-05T08:04:44.000Z' });
    expect(result.vacancies.find((vacancy) => vacancy.provider === 'devitjobs_uk'))
      .toMatchObject({ decision: 'location_restricted', currency: 'GBP', postedAt: '2026-09-01T06:09:06.000Z' });
    expect(result.vacancies.find((vacancy) => vacancy.provider === 'jobspresso'))
      .toMatchObject({ company: 'Presso Co', location: 'Worldwide', decision: 'official_review_candidate', postedAt: '2026-08-29T02:12:12.000Z' });
    expect(result.vacancies.find((vacancy) => vacancy.provider === 'remote_frontend_jobs'))
      .toMatchObject({ company: 'Frontend Jobs Co', location: 'Worldwide', decision: 'official_review_candidate', postedAt: null });
    expect(result.vacancies.find((vacancy) => vacancy.provider === 'un_careers'))
      .toMatchObject({
        key: 'un_careers:283900',
        company: 'United Nations',
        location: 'REMOTE',
        url: 'https://careers.un.org/jobSearchDescription/283900?language=en',
      });
    expect(result.vacancies.find((vacancy) => vacancy.provider === 'un_careers'))
      .toMatchObject({ description: null, postedAt: '2026-08-29T00:00:00.000Z' });
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
    expect(result.vacancies).toHaveLength(14);
  });

  it('reports malformed RSS items as partial while preserving valid vacancies', async () => {
    const fixtureRoutes = routes();
    const original = fixtureRoutes.get(WWR_URL);
    expect(typeof original).toBe('string');
    if (typeof original !== 'string') return;
    fixtureRoutes.set(
      WWR_URL,
      original.replace('</channel>', '<item><title>Missing link</title></item></channel>'),
    );

    const result = await runFeedDiscovery(new FixtureHttpClient(fixtureRoutes), config);

    expect(result.sources.find((source) => source.provider === 'we_work_remotely'))
      .toMatchObject({
        status: 'partial',
        listings: 1,
        error: 'Dropped 1 malformed or unsupported RSS item(s).',
      });
    expect(result.vacancies).toHaveLength(15);
  });
});
