import { describe, expect, it } from 'vitest';

import { CompanySiteJsonLdAdapter } from '../../src/ats/company-site.js';
import type { AtsHttpResponse } from '../../src/ats/http.js';
import { createVacancyAdapter } from '../../src/ats/factory.js';
import { atsFixture, careerSource, FixtureHttpClient } from './helpers.js';

const listingUrl = 'https://careers.acme.example/careers';
const detailPrefix = 'https://careers.acme.example/careers/jobs/';
const frontendUrl = 'https://careers.acme.example/careers/jobs/frontend-engineer';
const platformUrl = 'https://careers.acme.example/careers/jobs/platform-engineer';
const source = {
  ...careerSource('json_ld', detailPrefix, listingUrl),
  lifecycleAuthoritative: true,
};

describe('CompanySiteJsonLdAdapter', () => {
  it('fetches one verified listing and deduplicated same-origin JSON-LD details', async () => {
    const http = new FixtureHttpClient(
      new Map([
        [listingUrl, await atsFixture('company-site/listing.html')],
        [frontendUrl, await atsFixture('company-site/frontend-engineer.html')],
        [platformUrl, await atsFixture('company-site/platform-engineer.html')],
      ]),
    );

    const result = await new CompanySiteJsonLdAdapter(http).listVacancies(source);

    expect(result).toMatchObject({ complete: true, requestCount: 3, invalidCount: 0 });
    expect(result.vacancies).toHaveLength(2);
    expect(result.vacancies[0]).toMatchObject({
      externalId: 'official-frontend-1',
      title: 'Senior Frontend Engineer',
      location: 'Amsterdam, Netherlands',
      url: frontendUrl,
      source: 'json_ld',
    });
    expect(result.vacancies[1]).toMatchObject({
      externalId: 'official-platform-2',
      remote: true,
      workplaceMode: 'remote',
      url: platformUrl,
    });
    expect(http.requestedUrls).toEqual([listingUrl, frontendUrl, platformUrl]);
    expect(http.requestedOptions).toEqual([
      { allowedOrigins: ['https://careers.acme.example'] },
      { allowedOrigins: ['https://careers.acme.example'] },
      { allowedOrigins: ['https://careers.acme.example'] },
    ]);
  });

  it('is non-authoritative by default even when every discovered detail is valid', async () => {
    const http = new FixtureHttpClient(
      new Map([
        [listingUrl, `<a href="${frontendUrl}">Frontend</a>`],
        [frontendUrl, await atsFixture('company-site/frontend-engineer.html')],
      ]),
    );

    const result = await new CompanySiteJsonLdAdapter(http).listVacancies({
      ...source,
      lifecycleAuthoritative: false,
    });

    expect(result).toMatchObject({ complete: false, requestCount: 2, invalidCount: 0 });
    expect(result.vacancies).toHaveLength(1);
  });

  it('revokes an explicit authority claim when the listing exposes pagination', async () => {
    const listing = `<a href="${frontendUrl}">Frontend</a>
      <a href="/careers?page=2" rel="next">Next</a>`;
    const http = new FixtureHttpClient(
      new Map([
        [listingUrl, listing],
        [frontendUrl, await atsFixture('company-site/frontend-engineer.html')],
      ]),
    );

    const result = await new CompanySiteJsonLdAdapter(http).listVacancies(source);

    expect(result).toMatchObject({ complete: false, requestCount: 2, invalidCount: 0 });
    expect(http.requestedUrls).toEqual([listingUrl, frontendUrl]);
  });

  it('treats a visible load-more control as partial discovery', async () => {
    const listing = `<a href="${frontendUrl}">Frontend</a><button>Load more</button>`;
    const http = new FixtureHttpClient(
      new Map([
        [listingUrl, listing],
        [frontendUrl, await atsFixture('company-site/frontend-engineer.html')],
      ]),
    );

    const result = await new CompanySiteJsonLdAdapter(http).listVacancies(source);

    expect(result).toMatchObject({ complete: false, requestCount: 2, invalidCount: 0 });
  });

  it('never fetches a cross-origin lookalike and marks discovery incomplete', async () => {
    const listing = `<a href="${frontendUrl}">Valid</a>
      <a href="https://outside.example/careers/jobs/foreign">Foreign</a>`;
    const http = new FixtureHttpClient(
      new Map([
        [listingUrl, listing],
        [frontendUrl, await atsFixture('company-site/frontend-engineer.html')],
      ]),
    );

    const result = await new CompanySiteJsonLdAdapter(http).listVacancies(source);

    expect(result).toMatchObject({ complete: false, requestCount: 2, invalidCount: 1 });
    expect(result.vacancies).toHaveLength(1);
    expect(http.requestedUrls).not.toContain('https://outside.example/careers/jobs/foreign');
  });

  it('uses a deterministic detail cap and never claims capped discovery is complete', async () => {
    const firstUrl = 'https://careers.acme.example/careers/jobs/a';
    const secondUrl = 'https://careers.acme.example/careers/jobs/b';
    const listing = `<a href="${secondUrl}">B</a><a href="${firstUrl}">A</a><a href="${platformUrl}">C</a>`;
    const http = new FixtureHttpClient(
      new Map([
        [listingUrl, listing],
        [firstUrl, await atsFixture('company-site/frontend-engineer.html')],
        [secondUrl, await atsFixture('company-site/platform-engineer.html')],
      ]),
    );

    const result = await new CompanySiteJsonLdAdapter(http, { maxDetails: 2 }).listVacancies(
      source,
    );

    expect(result).toMatchObject({ complete: false, requestCount: 3, invalidCount: 0 });
    expect(result.vacancies).toHaveLength(2);
    expect(http.requestedUrls).toEqual([listingUrl, firstUrl, secondUrl]);
  });

  it('withholds completeness when discovery exactly reaches the configured ceiling', async () => {
    const http = new FixtureHttpClient(
      new Map([
        [listingUrl, `<a href="${frontendUrl}">Frontend</a>`],
        [frontendUrl, await atsFixture('company-site/frontend-engineer.html')],
      ]),
    );

    const result = await new CompanySiteJsonLdAdapter(http, { maxDetails: 1 }).listVacancies(
      source,
    );

    expect(result).toMatchObject({ complete: false, requestCount: 2, invalidCount: 0 });
    expect(result.vacancies).toHaveLength(1);
  });

  it('treats zero matching links as unknown/incomplete instead of an empty complete feed', async () => {
    const http = new FixtureHttpClient(
      new Map([[listingUrl, '<html><body><a href="/about">About</a></body></html>']]),
    );

    await expect(new CompanySiteJsonLdAdapter(http).listVacancies(source)).resolves.toEqual({
      vacancies: [],
      complete: false,
      requestCount: 1,
      invalidCount: 0,
    });
  });

  it('retains valid details but marks malformed or empty JSON-LD details incomplete', async () => {
    const malformedUrl = 'https://careers.acme.example/careers/jobs/malformed';
    const listing = `<a href="${frontendUrl}">Valid</a><a href="${malformedUrl}">Malformed</a>`;
    const http = new FixtureHttpClient(
      new Map([
        [listingUrl, listing],
        [frontendUrl, await atsFixture('company-site/frontend-engineer.html')],
        [malformedUrl, await atsFixture('company-site/malformed-detail.html')],
      ]),
    );

    const result = await new CompanySiteJsonLdAdapter(http).listVacancies(source);

    expect(result.complete).toBe(false);
    expect(result.invalidCount).toBeGreaterThan(0);
    expect(result.vacancies).toHaveLength(1);
  });

  it('rejects cross-origin final redirects without parsing or following discovered content', async () => {
    const redirected: AtsHttpResponse = {
      status: 200,
      finalUrl: 'https://outside.example/careers/jobs/frontend-engineer',
      headers: { 'content-type': 'text/html' },
      body: await atsFixture('company-site/frontend-engineer.html'),
    };
    const http = new FixtureHttpClient(
      new Map<string, string | AtsHttpResponse>([
        [listingUrl, `<a href="${frontendUrl}">Frontend</a>`],
        [frontendUrl, redirected],
      ]),
    );

    const result = await new CompanySiteJsonLdAdapter(http).listVacancies(source);

    expect(result).toMatchObject({
      vacancies: [],
      complete: false,
      requestCount: 2,
      invalidCount: 1,
    });
  });

  it('rejects a same-origin final URL outside the configured detail prefix', async () => {
    const redirected: AtsHttpResponse = {
      status: 200,
      finalUrl: 'https://careers.acme.example/about',
      headers: { 'content-type': 'text/html' },
      body: await atsFixture('company-site/frontend-engineer.html'),
    };
    const http = new FixtureHttpClient(
      new Map<string, string | AtsHttpResponse>([
        [listingUrl, `<a href="${frontendUrl}">Frontend</a>`],
        [frontendUrl, redirected],
      ]),
    );

    await expect(new CompanySiteJsonLdAdapter(http).listVacancies(source)).resolves.toMatchObject({
      vacancies: [],
      complete: false,
      invalidCount: 1,
    });
  });

  it('rejects an extracted canonical vacancy URL outside the detail prefix', async () => {
    const detail = `<link rel="canonical" href="/about">
      <script type="application/ld+json">{
        "@type":"JobPosting",
        "identifier":"outside-prefix",
        "title":"Frontend Engineer",
        "description":"Build the product UI"
      }</script>`;
    const http = new FixtureHttpClient(
      new Map([
        [listingUrl, `<a href="${frontendUrl}">Frontend</a>`],
        [frontendUrl, detail],
      ]),
    );

    await expect(new CompanySiteJsonLdAdapter(http).listVacancies(source)).resolves.toMatchObject({
      vacancies: [],
      complete: false,
      invalidCount: 1,
    });
  });

  it('does not silently collapse duplicate external IDs from different details', async () => {
    const sharedJob = (canonical: string, title: string) => `<link rel="canonical" href="${canonical}">
      <script type="application/ld+json">{
        "@type":"JobPosting",
        "identifier":"shared-id",
        "title":"${title}",
        "description":"Build a product interface"
      }</script>`;
    const http = new FixtureHttpClient(
      new Map([
        [listingUrl, `<a href="${frontendUrl}">Frontend</a><a href="${platformUrl}">Platform</a>`],
        [frontendUrl, sharedJob(frontendUrl, 'Frontend Engineer')],
        [platformUrl, sharedJob(platformUrl, 'Platform Engineer')],
      ]),
    );

    const result = await new CompanySiteJsonLdAdapter(http).listVacancies(source);

    expect(result).toMatchObject({ complete: false, requestCount: 3, invalidCount: 1 });
    expect(result.vacancies).toHaveLength(1);
  });

  it('classifies a recognizable JavaScript access challenge instead of bypassing it', async () => {
    const http = new FixtureHttpClient(
      new Map([
        [
          listingUrl,
          '<html><title>Just a moment...</title><div>Cloudflare Ray ID</div></html>',
        ],
      ]),
    );

    await expect(new CompanySiteJsonLdAdapter(http).listVacancies(source)).rejects.toMatchObject({
      status: 403,
    });
  });

  it('requires the configured detail prefix to remain on the exact seed origin', () => {
    const http = new FixtureHttpClient(new Map());
    const adapter = new CompanySiteJsonLdAdapter(http);

    expect(adapter.supports(source)).toBe(true);
    expect(
      adapter.supports(
        careerSource(
          'json_ld',
          'https://outside.example/careers/jobs/',
          listingUrl,
        ),
      ),
    ).toBe(false);
  });

  it('is registered in the production vacancy-adapter factory', () => {
    const adapter = createVacancyAdapter('json_ld', new FixtureHttpClient(new Map()));
    expect(adapter).toBeInstanceOf(CompanySiteJsonLdAdapter);
  });
});
