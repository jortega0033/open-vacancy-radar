import { describe, expect, it } from 'vitest';

import { WorkdayAdapter } from '../../src/ats/workday.js';
import {
  atsFixture,
  careerSource,
  FixtureHttpClient,
  jsonPostFixtureKey,
} from './helpers.js';

const origin = 'https://acme.wd5.myworkdayjobs.com';
const boardUrl = `${origin}/en-US/External`;
const listUrl = `${origin}/wday/cxs/acme/External/jobs`;
const detailPrefix = `${origin}/wday/cxs/acme/External`;
const source = careerSource('workday', 'External', boardUrl);

const listBody = (offset: number, limit = 2) => ({
  appliedFacets: {},
  limit,
  offset,
  searchText: '',
});

const listRoute = (offset: number, limit = 2) =>
  jsonPostFixtureKey(listUrl, listBody(offset, limit));

const detailUrl = (externalPath: string) => `${detailPrefix}${externalPath}`;
const angularPath = '/job/Netherlands/Senior-Angular-Developer_R-1001';
const platformPath = '/job/Netherlands/Frontend-Platform-Engineer_R-1002';
const onsitePath = '/job/Netherlands/QA-Automation-Engineer_R-1003';

async function completeRoutes(): Promise<Map<string, string>> {
  return new Map([
    [listRoute(0), await atsFixture('workday/list-page-1.json')],
    [listRoute(2), await atsFixture('workday/list-page-2.json')],
    [detailUrl(angularPath), await atsFixture('workday/detail-angular.json')],
    [detailUrl(platformPath), await atsFixture('workday/detail-platform.json')],
    [detailUrl(onsitePath), await atsFixture('workday/detail-onsite.json')],
  ]);
}

describe('WorkdayAdapter', () => {
  it('paginates CXS summaries, fetches details sequentially, and normalizes vacancies', async () => {
    const http = new FixtureHttpClient(await completeRoutes());
    const result = await new WorkdayAdapter(http, {
      pageSize: 2,
      maxPages: 3,
      maxDetails: 10,
    }).listVacancies(source);

    expect(result).toMatchObject({
      complete: true,
      requestCount: 5,
      invalidCount: 0,
    });
    expect(result.vacancies).toHaveLength(3);
    expect(result.vacancies[0]).toMatchObject({
      externalId: 'acme:External:R-1001',
      title: 'Senior Angular Developer',
      location: 'Amsterdam, Netherlands / Utrecht, Netherlands',
      remote: null,
      workplaceMode: 'hybrid',
      url: `${boardUrl}${angularPath}`,
      postedAt: new Date('2026-08-20'),
      employmentType: 'Full time',
      source: 'workday',
    });
    expect(result.vacancies[0]?.description).toContain('Angular and TypeScript');
    expect(result.vacancies[1]).toMatchObject({
      externalId: 'acme:External:R-1002',
      title: 'Frontend Platform Engineer',
      location: 'Rotterdam, Netherlands / Eindhoven, Netherlands',
      remote: true,
      workplaceMode: 'remote',
      url: `${boardUrl}${platformPath}`,
      employmentType: 'Permanent',
    });
    expect(result.vacancies[2]).toMatchObject({
      externalId: 'acme:External:QA-Automation-Engineer_R-1003',
      location: 'Netherlands',
      remote: false,
      workplaceMode: 'onsite',
      url: `${boardUrl}${onsitePath}`,
      employmentType: 'Part time',
    });
    expect(http.requestedJsonBodies).toEqual([listBody(0), listBody(2)]);
    expect(http.requestedUrls).toEqual([
      listUrl,
      listUrl,
      detailUrl(angularPath),
      detailUrl(platformPath),
      detailUrl(onsitePath),
    ]);
    expect(http.requestedOptions).toEqual(
      Array.from({ length: 5 }, () => ({ allowedOrigins: [origin] })),
    );
  });

  it('treats a recognized total-zero page as an authoritative empty board', async () => {
    const http = new FixtureHttpClient(
      new Map([[listRoute(0), await atsFixture('workday/empty.json')]]),
    );

    await expect(
      new WorkdayAdapter(http, { pageSize: 2, maxPages: 1 }).listVacancies(source),
    ).resolves.toEqual({
      vacancies: [],
      complete: true,
      requestCount: 1,
      invalidCount: 0,
    });
  });

  it('ignores an unreliable total-zero value when the page contains vacancies', async () => {
    const http = new FixtureHttpClient(
      new Map([
        [
          listRoute(0, 20),
          JSON.stringify({
            total: 0,
            jobPostings: [{ title: 'Senior Angular Developer', externalPath: angularPath }],
          }),
        ],
        [detailUrl(angularPath), await atsFixture('workday/detail-angular.json')],
      ]),
    );

    const result = await new WorkdayAdapter(http).listVacancies(source);

    expect(result).toMatchObject({ complete: true, requestCount: 2, invalidCount: 0 });
    expect(result.vacancies.map((vacancy) => vacancy.externalId)).toEqual([
      'acme:External:R-1001',
    ]);
  });

  it('stops a repeated page without duplicating vacancies and marks coverage incomplete', async () => {
    const repeated = await atsFixture('workday/repeated-page.json');
    const http = new FixtureHttpClient(
      new Map([
        [listRoute(0), repeated],
        [listRoute(2), repeated],
        [detailUrl(angularPath), await atsFixture('workday/detail-angular.json')],
        [detailUrl(platformPath), await atsFixture('workday/detail-platform.json')],
      ]),
    );

    const result = await new WorkdayAdapter(http, {
      pageSize: 2,
      maxPages: 4,
    }).listVacancies(source);

    expect(result).toMatchObject({ complete: false, requestCount: 4, invalidCount: 0 });
    expect(result.vacancies.map((vacancy) => vacancy.externalId)).toEqual([
      'acme:External:R-1001',
      'acme:External:R-1002',
    ]);
    expect(http.requestedJsonBodies).toEqual([listBody(0), listBody(2)]);
  });

  it('keeps valid vacancies when a summary is malformed and marks coverage incomplete', async () => {
    const http = new FixtureHttpClient(
      new Map([
        [listRoute(0), await atsFixture('workday/invalid-summary.json')],
        [detailUrl(angularPath), await atsFixture('workday/detail-angular.json')],
      ]),
    );

    const result = await new WorkdayAdapter(http, {
      pageSize: 2,
      maxPages: 1,
    }).listVacancies(source);

    expect(result).toMatchObject({ complete: false, requestCount: 2, invalidCount: 1 });
    expect(result.vacancies.map((vacancy) => vacancy.externalId)).toEqual([
      'acme:External:R-1001',
    ]);
  });

  it('rejects malformed JSON and unknown list response shapes', async () => {
    const unknown = new FixtureHttpClient(
      new Map([[listRoute(0), await atsFixture('workday/unknown-shape.json')]]),
    );
    await expect(
      new WorkdayAdapter(unknown, { pageSize: 2, maxPages: 1 }).listVacancies(source),
    ).rejects.toThrow('unknown response shape');

    const malformed = new FixtureHttpClient(
      new Map([[listRoute(0), await atsFixture('workday/malformed.json')]]),
    );
    await expect(
      new WorkdayAdapter(malformed, { pageSize: 2, maxPages: 1 }).listVacancies(source),
    ).rejects.toThrow('response is not valid JSON');
  });

  it('classifies recognizable HTML access challenges even without a content-type header', async () => {
    const http = new FixtureHttpClient(
      new Map([
        [
          listRoute(0, 20),
          {
            status: 200,
            finalUrl: listUrl,
            headers: {},
            body: '<html><div id="cf-chl-widget">Just a moment</div></html>',
          },
        ],
      ]),
    );

    await expect(new WorkdayAdapter(http).listVacancies(source)).rejects.toMatchObject({
      status: 403,
    });
  });

  it('isolates a malformed detail document as incomplete source data', async () => {
    const http = new FixtureHttpClient(
      new Map([
        [
          listRoute(0, 20),
          JSON.stringify({
            total: 1,
            jobPostings: [{ title: 'Senior Angular Developer', externalPath: angularPath }],
          }),
        ],
        [detailUrl(angularPath), JSON.stringify({ unexpected: true })],
      ]),
    );

    await expect(new WorkdayAdapter(http).listVacancies(source)).resolves.toEqual({
      vacancies: [],
      complete: false,
      requestCount: 2,
      invalidCount: 1,
    });
  });

  it('marks a bounded detail cap as incomplete coverage', async () => {
    const routes = await completeRoutes();
    routes.delete(detailUrl(platformPath));
    routes.delete(detailUrl(onsitePath));
    const http = new FixtureHttpClient(routes);

    const result = await new WorkdayAdapter(http, {
      pageSize: 2,
      maxPages: 3,
      maxDetails: 1,
    }).listVacancies(source);

    expect(result).toMatchObject({ complete: false, requestCount: 3, invalidCount: 0 });
    expect(result.vacancies.map((vacancy) => vacancy.externalId)).toEqual([
      'acme:External:R-1001',
    ]);
  });

  it('keeps an endpoint-reported 2,000-result ceiling incomplete after consuming every page slot', async () => {
    const routes = new Map<string, string>();
    const paths = Array.from(
      { length: 119 },
      (_unused, index) => `/job/Netherlands/Role-${index}_R-${index}`,
    );
    for (let page = 0; page < 100; page += 1) {
      const pagePaths = page === 0
        ? paths.slice(0, 20)
        : [paths[19 + page], ...paths.slice(0, 19)];
      routes.set(
        listRoute(page * 20, 20),
        JSON.stringify({
          total: 2_000,
          jobPostings: pagePaths.map((externalPath, index) => ({
            title: `Role ${page}-${index}`,
            externalPath,
          })),
        }),
      );
    }
    for (const [index, externalPath] of paths.entries()) {
      routes.set(
        detailUrl(externalPath),
        JSON.stringify({
          jobPostingInfo: {
            title: `Role ${index}`,
            jobDescription: 'Angular engineering role',
            jobReqId: `R-${index}`,
          },
        }),
      );
    }
    const http = new FixtureHttpClient(routes);

    const result = await new WorkdayAdapter(http, {
      pageSize: 20,
      maxPages: 100,
      maxDetails: 500,
    }).listVacancies(source);

    expect(result).toMatchObject({ complete: false, requestCount: 219, invalidCount: 0 });
    expect(result.vacancies).toHaveLength(119);
    expect(http.requestedJsonBodies).toHaveLength(100);
  });

  it('requires the configured provider and board identifier to match the exact Workday board', async () => {
    const http = new FixtureHttpClient(new Map());
    const adapter = new WorkdayAdapter(http);

    expect(adapter.supports(source)).toBe(true);
    expect(adapter.supports({ ...source, boardIdentifier: 'external' })).toBe(true);
    expect(adapter.supports({ ...source, boardIdentifier: 'Internal' })).toBe(false);
    expect(adapter.supports({ ...source, provider: 'greenhouse' })).toBe(false);
    expect(adapter.supports({ ...source, baseUrl: 'https://careers.example.com/jobs' })).toBe(false);
    await expect(
      adapter.listVacancies({ ...source, boardIdentifier: 'Internal' }),
    ).rejects.toThrow('source is not supported');
    expect(http.requestedUrls).toEqual([]);
  });
});
