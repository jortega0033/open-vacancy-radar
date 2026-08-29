import { describe, expect, it } from 'vitest';

import type { AtsHttpResponse } from '../../src/ats/http.js';
import { inspectOfficialCompanySite } from '../../src/companies/site-discovery.js';
import { FixtureHttpClient } from '../ats/helpers.js';

const officialUrl = 'https://acme.example/';
const careersUrl = 'https://acme.example/careers';

function response(finalUrl: string, body: string, contentType = 'text/html'): AtsHttpResponse {
  return {
    status: 200,
    finalUrl,
    headers: { 'content-type': contentType },
    body,
  };
}

describe('official company-site discovery', () => {
  it.each([
    ['anchor', '<a href="https://jobs.lever.co/acme">Jobs</a>'],
    ['iframe', '<iframe src="https://jobs.lever.co/acme"></iframe>'],
    ['script', '<script src="https://jobs.lever.co/acme"></script>'],
  ])('recognizes a guarded ATS URL from a %s without fetching it', async (_kind, html) => {
    const http = new FixtureHttpClient(new Map([[officialUrl, html]]));

    const result = await inspectOfficialCompanySite(http, officialUrl);

    expect(result).toMatchObject({
      status: 'careers_found',
      pagesInspected: 1,
      provider: 'lever',
      boardIdentifier: 'acme',
    });
    expect(http.requestedUrls).toEqual([officialUrl]);
    expect(http.requestedOptions).toEqual([{ allowedOrigins: ['https://acme.example'] }]);
    expect(result.observations).toHaveLength(1);
    expect(result.observations[0]).toMatchObject({
      provider: 'lever',
      boardIdentifier: 'acme',
      sourceBaseUrl: 'https://jobs.lever.co',
      observedOnPage: officialUrl,
      element: _kind,
    });
  });

  it('recognizes an exact Workday tenant board observation without fetching it', async () => {
    const workdayUrl =
      'https://acme.wd5.myworkdayjobs.com/en-US/External/job/Amsterdam/Angular-Developer_JR-123';
    const http = new FixtureHttpClient(
      new Map([[officialUrl, `<a href="${workdayUrl}">Open positions</a>`]]),
    );

    const result = await inspectOfficialCompanySite(http, officialUrl);

    expect(result).toMatchObject({
      status: 'careers_found',
      pagesInspected: 1,
      careersUrl: workdayUrl,
      provider: 'workday',
      sourceBaseUrl: 'https://acme.wd5.myworkdayjobs.com/en-US/External',
      boardIdentifier: 'External',
    });
    expect(result.observations).toEqual([
      expect.objectContaining({
        provider: 'workday',
        boardIdentifier: 'External',
        sourceBaseUrl: 'https://acme.wd5.myworkdayjobs.com/en-US/External',
        observedUrl: workdayUrl,
        observedOnPage: officialUrl,
        element: 'anchor',
      }),
    ]);
    expect(http.requestedUrls).toEqual([officialUrl]);
  });

  it.each([
    [
      'generic host',
      'https://www.myworkdayjobs.com/en-US/External',
    ],
    [
      'reserved board identifier',
      'https://acme.wd5.myworkdayjobs.com/en-US/jobs',
    ],
    [
      'tenant-mismatched CXS route',
      'https://acme.wd5.myworkdayjobs.com/wday/cxs/other/External/jobs',
    ],
    [
      'credential-bearing URL',
      'https://user:secret@acme.wd5.myworkdayjobs.com/en-US/External',
    ],
  ])('does not recognize a Workday-shaped %s', async (_case, workdayUrl) => {
    const http = new FixtureHttpClient(
      new Map([[officialUrl, `<a href="${workdayUrl}">Workday portal</a>`]]),
    );

    const result = await inspectOfficialCompanySite(http, officialUrl);

    expect(result.provider).toBeNull();
    expect(result.boardIdentifier).toBeNull();
    expect(result.observations.every((observation) => observation.provider !== 'workday')).toBe(
      true,
    );
    expect(http.requestedUrls).toEqual([officialUrl]);
  });

  it('deduplicates links for the same ATS board before ambiguity checking', async () => {
    const html = `<a href="https://job-boards.greenhouse.io/acme">Careers</a>
      <iframe src="https://boards.greenhouse.io/embed/job_board/js?for=acme"></iframe>`;
    const http = new FixtureHttpClient(new Map([[officialUrl, html]]));

    const result = await inspectOfficialCompanySite(http, officialUrl);
    expect(result).toMatchObject({
      status: 'careers_found',
      provider: 'greenhouse',
      boardIdentifier: 'acme',
    });
    expect(result.observations).toHaveLength(2);
    expect(http.requestedUrls).toEqual([officialUrl]);
  });

  it('withholds an observation when distinct ATS boards make ownership ambiguous', async () => {
    const html = `<a href="https://jobs.lever.co/acme">Acme jobs</a>
      <a href="https://jobs.lever.co/acme-labs">Labs jobs</a>`;
    const http = new FixtureHttpClient(new Map([[officialUrl, html]]));

    const result = await inspectOfficialCompanySite(http, officialUrl);
    expect(result).toMatchObject({
      status: 'manual_review',
      provider: null,
      boardIdentifier: null,
    });
    expect(result.diagnostic).toContain('Multiple distinct');
    expect(result.observations).toHaveLength(2);
  });

  it('keeps same-named Workday sites on different tenants distinct', async () => {
    const html = `<a href="https://acme.wd5.myworkdayjobs.com/en-US/External">Acme jobs</a>
      <a href="https://acme-labs.wd5.myworkdayjobs.com/en-US/External">Labs jobs</a>`;
    const http = new FixtureHttpClient(new Map([[officialUrl, html]]));

    const result = await inspectOfficialCompanySite(http, officialUrl);

    expect(result).toMatchObject({ status: 'manual_review', provider: null });
    expect(result.observations).toHaveLength(2);
  });

  it('fetches only the deterministically ranked same-origin careers anchor', async () => {
    const homepage = `<a href="https://outside.example/careers">External careers</a>
      <a href="/jobs">Jobs</a>
      <a href="/careers">Careers</a>`;
    const careers = '<script src="https://jobs.eu.lever.co/acme"></script>';
    const http = new FixtureHttpClient(
      new Map([
        [officialUrl, homepage],
        [careersUrl, careers],
      ]),
    );

    const result = await inspectOfficialCompanySite(http, officialUrl);

    expect(result).toMatchObject({ status: 'careers_found', pagesInspected: 2, provider: 'lever' });
    expect(http.requestedUrls).toEqual([officialUrl, careersUrl]);
    expect(http.requestedOptions).toEqual([
      { allowedOrigins: ['https://acme.example'] },
      { allowedOrigins: ['https://acme.example'] },
    ]);
    expect(http.requestedUrls).not.toContain('https://outside.example/careers');
  });

  it('does not fetch a second page when the first URL is already a careers page', async () => {
    const firstPage = 'https://acme.example/careers';
    const http = new FixtureHttpClient(
      new Map([[firstPage, '<a href="/jobs">Another careers page</a>']]),
    );

    await expect(inspectOfficialCompanySite(http, firstPage)).resolves.toMatchObject({
      status: 'manual_review',
      pagesInspected: 1,
      careersUrl: firstPage,
      provider: null,
    });
    expect(http.requestedUrls).toEqual([firstPage]);
  });

  it('ignores inline strings, data attributes, forms, and meta refresh targets', async () => {
    const html = `<div data-href="https://jobs.lever.co/acme">Jobs</div>
      <form action="https://jobs.lever.co/acme"></form>
      <meta http-equiv="refresh" content="0;url=https://jobs.lever.co/acme">
      <script>window.jobs = "https://jobs.lever.co/acme";</script>`;
    const http = new FixtureHttpClient(new Map([[officialUrl, html]]));

    await expect(inspectOfficialCompanySite(http, officialUrl)).resolves.toMatchObject({
      status: 'no_public_careers',
      provider: null,
    });
    expect(http.requestedUrls).toEqual([officialUrl]);
  });

  it('does not promote provider-shaped reserved or incomplete identifiers', async () => {
    const html = `<iframe src="https://boards.greenhouse.io/embed/job_board/js"></iframe>
      <script src="https://jobs.lever.co/privacy"></script>
      <a href="https://www.recruitee.com/jobs">Recruitee jobs</a>
      <a href="https://www.teamtailor.com/jobs">Teamtailor jobs</a>
      <a href="https://jobs.smartrecruiters.com/job">SmartRecruiters job</a>
      <a href="https://careers.smartrecruiters.com/privacy">Jobs privacy</a>`;
    const http = new FixtureHttpClient(new Map([[officialUrl, html]]));

    const result = await inspectOfficialCompanySite(http, officialUrl);

    expect(result.provider).toBeNull();
    expect(result.boardIdentifier).toBeNull();
    expect(http.requestedUrls).toEqual([officialUrl]);
  });

  it('requires whole career tokens and rejects fragments, queries, details, login, and files', async () => {
    const html = `<a href="/notjobs">jobsworth</a>
      <a href="#careers">Careers</a>
      <a href="https://acme.example/careers#roles">Careers</a>
      <a href="?view=jobs">Jobs</a>
      <a href="/jobs/frontend-engineer">Jobs</a>
      <a href="/login/jobs">Careers login</a>
      <a href="/sign-in">Careers</a>
      <a href="/careers.pdf">Careers</a>`;
    const http = new FixtureHttpClient(new Map([[officialUrl, html]]));

    await expect(inspectOfficialCompanySite(http, officialUrl)).resolves.toMatchObject({
      status: 'no_public_careers',
    });
    expect(http.requestedUrls).toEqual([officialUrl]);
  });

  it('returns manual review for exact-origin boundary escapes on either page', async () => {
    const homepageRedirect = new FixtureHttpClient(
      new Map([[officialUrl, response('https://www.acme.example/', '<a href="/careers">Jobs</a>')]]),
    );
    const homepageResult = await inspectOfficialCompanySite(homepageRedirect, officialUrl);
    expect(homepageResult).toMatchObject({
      status: 'manual_review',
      pagesInspected: 1,
    });
    expect(homepageResult.diagnostic).toContain('exact origin');

    const careersRedirect = new FixtureHttpClient(
      new Map<string, string | AtsHttpResponse>([
        [officialUrl, '<a href="/careers">Careers</a>'],
        [careersUrl, response('https://careers.acme.example/', '<p>Jobs</p>')],
      ]),
    );
    const careersResult = await inspectOfficialCompanySite(careersRedirect, officialUrl);
    expect(careersResult).toMatchObject({
      status: 'manual_review',
      pagesInspected: 2,
      careersUrl,
    });
    expect(careersResult.diagnostic).toContain('exact origin');
    expect(careersRedirect.requestedUrls).toEqual([officialUrl, careersUrl]);
  });

  it('rejects unsafe official URLs before issuing a request', async () => {
    for (const unsafe of [
      'ftp://acme.example/',
      'https://user:secret@acme.example/',
      'https://acme.example/?jobs=true',
      'https://acme.example/#careers',
    ]) {
      const http = new FixtureHttpClient(new Map());
      await expect(inspectOfficialCompanySite(http, unsafe)).rejects.toThrow(
        'credential-free HTTP(S)',
      );
      expect(http.requestedUrls).toEqual([]);
    }
  });

  it('rejects LinkedIn and its subdomains before issuing a request', async () => {
    for (const forbidden of [
      'https://linkedin.com/company/acme/',
      'https://www.linkedin.com/company/acme/',
      'https://jobs.linkedin.com/acme/',
    ]) {
      const http = new FixtureHttpClient(new Map());
      await expect(inspectOfficialCompanySite(http, forbidden)).rejects.toThrow(
        'LinkedIn is forbidden',
      );
      expect(http.requestedUrls).toEqual([]);
    }
  });

  it('classifies access challenges and non-HTML responses without further requests', async () => {
    const challenge = new FixtureHttpClient(
      new Map([[officialUrl, '<title>Just a moment...</title><p>Cloudflare Ray ID</p>']]),
    );
    await expect(inspectOfficialCompanySite(challenge, officialUrl)).rejects.toMatchObject({
      status: 403,
    });
    expect(challenge.requestedUrls).toEqual([officialUrl]);

    const json = new FixtureHttpClient(
      new Map([[officialUrl, response(officialUrl, '{}', 'application/json')]]),
    );
    await expect(inspectOfficialCompanySite(json, officialUrl)).rejects.toThrow(
      'did not return HTML',
    );
    expect(json.requestedUrls).toEqual([officialUrl]);
  });
});
