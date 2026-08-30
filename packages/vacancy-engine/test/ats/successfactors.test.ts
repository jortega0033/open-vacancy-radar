import { describe, expect, it } from 'vitest';

import { SuccessFactorsAdapter } from '../../src/ats/successfactors.js';
import type { AtsHttpResponse } from '../../src/ats/http.js';
import { createVacancyAdapter } from '../../src/pipeline/vacancies.js';
import { atsFixture, careerSource, FixtureHttpClient } from './helpers.js';

const origin = 'https://jobs.tetrapak.com';
const sitemapUrl = `${origin}/job_sitemap.xml`;
const microdataUrl = `${origin}/job/Bogota-Frontend-Engineer/1428907233/`;
const jsonLdUrl = `${origin}/job/Berlin-Platform-Engineer/883999301-de_DE/`;
const source = careerSource('successfactors', 'jobs.tetrapak.com', `${origin}/`);

async function completeRoutes(): Promise<Map<string, string>> {
  return new Map([
    [sitemapUrl, await atsFixture('successfactors/sitemap.xml')],
    [microdataUrl, await atsFixture('successfactors/detail-microdata.html')],
    [jsonLdUrl, await atsFixture('successfactors/detail-jsonld.html')],
  ]);
}

function sitemap(locs: string[]): string {
  return `<?xml version="1.0"?><urlset>${locs
    .map((loc) => `<url><loc>${loc}</loc><lastmod>2026-08-20</lastmod></url>`)
    .join('')}</urlset>`;
}

describe('SuccessFactorsAdapter', () => {
  it('is registered in the production adapter factory', () => {
    const http = new FixtureHttpClient(new Map());
    expect(createVacancyAdapter('successfactors', http)).toBeInstanceOf(SuccessFactorsAdapter);
  });

  it('hydrates the public sitemap sequentially and normalizes microdata and JSON-LD jobs', async () => {
    const http = new FixtureHttpClient(await completeRoutes());

    const result = await new SuccessFactorsAdapter(http).listVacancies(source);

    expect(result).toMatchObject({ complete: true, requestCount: 3, invalidCount: 0 });
    expect(result.vacancies).toHaveLength(2);
    expect(result.vacancies[0]).toMatchObject({
      externalId: '100283',
      title: 'Senior Frontend Engineer',
      location: 'Amsterdam, Netherlands',
      remote: null,
      workplaceMode: 'hybrid',
      url: `${origin}/job/Frontend-Engineer/100283-en_GB/`,
      postedAt: new Date('2026-08-19'),
      employmentType: 'FULL_TIME',
      source: 'successfactors',
    });
    expect(result.vacancies[0]?.description).toContain('Angular and TypeScript');
    expect(result.vacancies[1]).toMatchObject({
      externalId: '200456',
      title: 'Frontend Platform Engineer',
      location: 'Germany',
      remote: true,
      workplaceMode: 'remote',
      url: `${origin}/job/Platform-Engineer/200456-de_DE/`,
      postedAt: new Date('2026-08-21'),
      employmentType: 'Permanent',
    });
    expect(http.requestedUrls).toEqual([sitemapUrl, microdataUrl, jsonLdUrl]);
    expect(http.requestedOptions).toEqual(
      Array.from({ length: 3 }, () => ({ allowedOrigins: [origin] })),
    );
  });

  it('treats a recognized empty sitemap as an authoritative empty board', async () => {
    const http = new FixtureHttpClient(
      new Map([[sitemapUrl, await atsFixture('successfactors/empty.xml')]]),
    );

    await expect(new SuccessFactorsAdapter(http).listVacancies(source)).resolves.toEqual({
      vacancies: [],
      complete: true,
      requestCount: 1,
      invalidCount: 0,
    });
  });

  it('rejects a response that is not a SuccessFactors job sitemap', async () => {
    const http = new FixtureHttpClient(
      new Map([[sitemapUrl, await atsFixture('successfactors/malformed.xml')]]),
    );

    await expect(new SuccessFactorsAdapter(http).listVacancies(source)).rejects.toThrow(
      'sitemap has an unknown response shape',
    );
  });

  it('deduplicates repeated sitemap locations and revokes completeness', async () => {
    const http = new FixtureHttpClient(
      new Map([
        [sitemapUrl, sitemap([microdataUrl, microdataUrl])],
        [microdataUrl, await atsFixture('successfactors/detail-microdata.html')],
      ]),
    );

    const result = await new SuccessFactorsAdapter(http).listVacancies(source);

    expect(result).toMatchObject({ complete: false, requestCount: 2, invalidCount: 1 });
    expect(result.vacancies.map((vacancy) => vacancy.externalId)).toEqual(['100283']);
  });

  it('marks a reached detail cap incomplete and never requests beyond it', async () => {
    const routes = await completeRoutes();
    routes.delete(jsonLdUrl);
    const http = new FixtureHttpClient(routes);

    const result = await new SuccessFactorsAdapter(http, { maxDetails: 1 }).listVacancies(source);

    expect(result).toMatchObject({ complete: false, requestCount: 2, invalidCount: 0 });
    expect(result.vacancies.map((vacancy) => vacancy.externalId)).toEqual(['100283']);
    expect(http.requestedUrls).toEqual([sitemapUrl, microdataUrl]);
  });

  it('remains complete when the board exactly fits the configured detail bound', async () => {
    const http = new FixtureHttpClient(
      new Map([
        [sitemapUrl, sitemap([microdataUrl])],
        [microdataUrl, await atsFixture('successfactors/detail-microdata.html')],
      ]),
    );

    const result = await new SuccessFactorsAdapter(http, { maxDetails: 1 }).listVacancies(source);

    expect(result).toMatchObject({ complete: true, requestCount: 2, invalidCount: 0 });
  });

  it('keeps valid details while malformed detail markup makes the result partial', async () => {
    const http = new FixtureHttpClient(
      new Map([
        [sitemapUrl, await atsFixture('successfactors/sitemap.xml')],
        [microdataUrl, await atsFixture('successfactors/detail-microdata.html')],
        [jsonLdUrl, await atsFixture('successfactors/malformed-detail.html')],
      ]),
    );

    const result = await new SuccessFactorsAdapter(http).listVacancies(source);

    expect(result).toMatchObject({ complete: false, requestCount: 3, invalidCount: 1 });
    expect(result.vacancies.map((vacancy) => vacancy.externalId)).toEqual(['100283']);
  });

  it('never requests cross-origin or non-job sitemap entries', async () => {
    const outside = 'https://outside.example/job/Bad/999/';
    const nonJob = `${origin}/content/Privacy/123/`;
    const http = new FixtureHttpClient(
      new Map([
        [sitemapUrl, sitemap([microdataUrl, outside, nonJob])],
        [microdataUrl, await atsFixture('successfactors/detail-microdata.html')],
      ]),
    );

    const result = await new SuccessFactorsAdapter(http).listVacancies(source);

    expect(result).toMatchObject({ complete: false, requestCount: 2, invalidCount: 2 });
    expect(http.requestedUrls).toEqual([sitemapUrl, microdataUrl]);
  });

  it('stops on recognizable access challenges instead of treating them as partial data', async () => {
    const listingChallenge: AtsHttpResponse = {
      status: 200,
      finalUrl: sitemapUrl,
      headers: { 'content-type': 'text/html' },
      body: '<html><title>Just a moment...</title><div>Cloudflare Ray ID</div></html>',
    };
    const listingHttp = new FixtureHttpClient(new Map([[sitemapUrl, listingChallenge]]));
    await expect(
      new SuccessFactorsAdapter(listingHttp).listVacancies(source),
    ).rejects.toMatchObject({
      status: 403,
    });

    const detailChallenge: AtsHttpResponse = {
      status: 200,
      finalUrl: microdataUrl,
      headers: { 'content-type': 'text/html' },
      body: '<html><div id="cf-chl-widget">Enable JavaScript and cookies to continue</div></html>',
    };
    const detailHttp = new FixtureHttpClient(
      new Map<string, string | AtsHttpResponse>([
        [sitemapUrl, sitemap([microdataUrl])],
        [microdataUrl, detailChallenge],
      ]),
    );
    await expect(new SuccessFactorsAdapter(detailHttp).listVacancies(source)).rejects.toMatchObject(
      {
        status: 403,
      },
    );
  });

  it('isolates ordinary detail-fetch failures and returns remaining jobs as partial', async () => {
    const http = new FixtureHttpClient(
      new Map([
        [sitemapUrl, await atsFixture('successfactors/sitemap.xml')],
        [microdataUrl, await atsFixture('successfactors/detail-microdata.html')],
      ]),
    );

    const result = await new SuccessFactorsAdapter(http).listVacancies(source);

    expect(result).toMatchObject({ complete: false, requestCount: 3, invalidCount: 1 });
    expect(result.vacancies.map((vacancy) => vacancy.externalId)).toEqual(['100283']);
  });

  it('requires the exact HTTPS origin and matching lowercase board hostname', async () => {
    const adapter = new SuccessFactorsAdapter(new FixtureHttpClient(new Map()));

    expect(adapter.supports(source)).toBe(true);
    expect(adapter.supports({ ...source, provider: 'greenhouse' })).toBe(false);
    expect(adapter.supports({ ...source, baseUrl: `http://jobs.tetrapak.com/` })).toBe(false);
    expect(adapter.supports({ ...source, baseUrl: `${origin}/search/` })).toBe(false);
    expect(adapter.supports({ ...source, baseUrl: `${origin}/?locale=en_GB` })).toBe(false);
    expect(adapter.supports({ ...source, boardIdentifier: 'JOBS.TETRAPAK.COM' })).toBe(false);
    expect(adapter.supports({ ...source, boardIdentifier: 'outside.example' })).toBe(false);
    expect(adapter.supports({ ...source, baseUrl: 'https://user:secret@jobs.tetrapak.com/' })).toBe(
      false,
    );
    expect(adapter.supports({ ...source, baseUrl: 'https://jobs.tetrapak.com:8443/' })).toBe(false);
    await expect(
      adapter.listVacancies({ ...source, boardIdentifier: 'outside.example' }),
    ).rejects.toThrow('source requires an exact HTTPS career-site origin');
  });

  it('validates the detail bound', () => {
    const http = new FixtureHttpClient(new Map());
    expect(() => new SuccessFactorsAdapter(http, { maxDetails: 0 })).toThrow(
      'maxDetails must be between 1 and 1000',
    );
    expect(() => new SuccessFactorsAdapter(http, { maxDetails: 1_001 })).toThrow(
      'maxDetails must be between 1 and 1000',
    );
  });
});
