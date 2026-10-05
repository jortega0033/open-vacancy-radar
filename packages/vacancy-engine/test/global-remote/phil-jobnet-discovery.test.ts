import { readFileSync } from 'node:fs';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import type { AtsHttpClient, AtsHttpResponse } from '../../src/ats/http.js';
import { AtsResponseError } from '../../src/ats/http.js';
import type { GlobalRemoteConfig } from '../../src/global-remote/models.js';
import {
  discoverPhilJobNet,
  normalizePhilJobNetLocation,
  parsePhilJobNetDate,
  parsePhilJobNetDetail,
  parsePhilJobNetListing,
  parsePhilJobNetSalary,
  philJobNetSearchUrl,
  PHIL_JOBNET_ORIGIN,
} from '../../src/global-remote/phil-jobnet-discovery.js';
import { globalRemoteSourceRegistry } from '../../src/global-remote/source-registry.js';

function fixture(name: string): string {
  return readFileSync(
    path.resolve(process.cwd(), 'test/fixtures/global-remote/phil-jobnet', name),
    'utf8',
  );
}

function profile(overrides: Partial<GlobalRemoteConfig['discovery']> = {}): GlobalRemoteConfig {
  return {
    version: 'test',
    minimumAnnualBaseUsd: null,
    discovery: {
      roleQuery: 'cashier',
      himalayasQueries: [],
      himalayasCountry: '',
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
      remooteRoleTitle: '',
      remooteCountry: '',
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
      navArbeidsplassenApiKey: '',
      navArbeidsplassenMaxPages: 1,
      atsRosterConcurrency: 1,
      philJobNetEnabled: true,
      philJobNetMaxPages: 2,
      philJobNetMaxDetails: 20,
      ...overrides,
    },
    officialSources: [],
  };
}

function page(body: string, status = 200): AtsHttpResponse {
  return { status, finalUrl: PHIL_JOBNET_ORIGIN, headers: {}, body };
}

class PortalClient implements AtsHttpClient {
  public readonly gets: string[] = [];
  public readonly posts: { url: string; fields: Record<string, string> }[] = [];

  public constructor(
    private readonly routes: Map<string, AtsHttpResponse>,
    private readonly postRoutes: Map<string, AtsHttpResponse> = new Map(),
  ) {}

  public async get(url: string): Promise<AtsHttpResponse> {
    this.gets.push(url);
    const route = this.routes.get(url);
    if (route === undefined) throw new Error(`Unexpected GET ${url}`);
    return route;
  }

  public async postJson(): Promise<AtsHttpResponse> {
    throw new Error('postJson must not be used');
  }

  public async postForm(url: string, fields: Readonly<Record<string, string>>): Promise<AtsHttpResponse> {
    this.posts.push({ url, fields: { ...fields } });
    const route = this.postRoutes.get(fields['__EVENTARGUMENT'] ?? '');
    if (route === undefined) throw new Error(`Unexpected POST ${fields['__EVENTARGUMENT']}`);
    return route;
  }
}

const SEARCH = philJobNetSearchUrl('cashier');
const detailUrl = (id: string): string => `${PHIL_JOBNET_ORIGIN}/job-vacancies/job/cashier-${id}`;

function fullClient(): PortalClient {
  return new PortalClient(
    new Map([
      [SEARCH, page(fixture('list-page1.html'))],
      [detailUrl('1000001'), page(fixture('detail-1000001.html'))],
      [detailUrl('1000002'), page(fixture('detail-1000002.html'))],
      [detailUrl('1000003'), page(fixture('detail-closed.html'))],
      [detailUrl('1000004'), page(fixture('detail-closed.html'))],
      [detailUrl('1000005'), page(fixture('detail-1000002.html'))],
    ]),
    new Map([['Page$2', page(fixture('list-page2.html'))]]),
  );
}

describe('PhilJobNet parsing', () => {
  it('parses listing cards, pager and Web Forms state', () => {
    const listing = parsePhilJobNetListing(fixture('list-page1.html'));
    expect(listing.cards.map((card) => card.id)).toEqual(['1000001', '1000002', '1000003']);
    expect(listing.cards[0]).toMatchObject({
      title: 'CASHIER',
      company: 'EXAMPLE RETAIL CORP',
      url: detailUrl('1000001'),
      employmentType: 'Permanent',
    });
    expect(listing.cards[2]?.employmentType).toBeNull();
    expect(listing.currentPage).toBe(1);
    expect(listing.nextPage).toBe(2);
    expect(listing.formState).toMatchObject({ __VIEWSTATE: 'vs-p1', __EVENTVALIDATION: 'ev-p1' });
    expect(parsePhilJobNetListing(fixture('list-page2.html')).nextPage).toBeNull();
  });

  it('treats a site-confirmed empty result as empty, not drift', () => {
    const listing = parsePhilJobNetListing(fixture('list-empty.html'));
    expect(listing.cards).toEqual([]);
  });

  it('fails clearly on markup it does not recognise', () => {
    expect(() => parsePhilJobNetListing(fixture('list-malformed.html'))).toThrow(/parser drift/u);
    expect(() => parsePhilJobNetDetail(fixture('detail-malformed.html'))).toThrow(/parser drift/u);
    expect(parsePhilJobNetListing(fixture('list-invalid-card.html')).invalidCards).toBe(1);
  });

  it('parses detail pages and flags closed ones', () => {
    const detail = parsePhilJobNetDetail(fixture('detail-1000001.html'));
    expect(detail).toMatchObject({
      closed: false,
      title: 'CASHIER',
      company: 'EXAMPLE RETAIL CORP',
      industry: 'RETAIL TRADE',
      remarks: 'Walk-ins accepted',
    });
    expect(detail.description).toContain('Balances the till');
    expect(detail.qualifications).toContain('1 year of cashiering');
    expect(parsePhilJobNetDetail(fixture('detail-1000002.html')).qualifications).toBeNull();
    expect(parsePhilJobNetDetail(fixture('detail-closed.html')).closed).toBe(true);
  });

  it('normalizes Philippine locations without defaulting to Manila', () => {
    expect(normalizePhilJobNetLocation('CITY OF MAKATI, NCR, FOURTH DISTRICT')).toMatchObject({
      display: 'Makati City, Metro Manila, Philippines',
      region: 'NCR',
    });
    expect(normalizePhilJobNetLocation('CEBU CITY (CAPITAL), CEBU')?.display).toBe('Cebu City, Cebu, Philippines');
    expect(normalizePhilJobNetLocation('DAVAO CITY, DAVAO DEL SUR')?.display).toBe(
      'Davao City, Davao del Sur, Philippines',
    );
    expect(normalizePhilJobNetLocation('UNITED ARAB EMIRATES')).toMatchObject({
      display: 'United Arab Emirates',
      country: 'United Arab Emirates',
    });
    expect(normalizePhilJobNetLocation('Location not specified')).toBeNull();
  });

  it('never invents Philippines for an unrecognised place', () => {
    expect(normalizePhilJobNetLocation('DUBAI, PHILIPPINES')).toEqual({
      display: 'Dubai',
      country: null,
      region: null,
      province: null,
      city: null,
    });
    expect(normalizePhilJobNetLocation('Somewhere')).toMatchObject({ display: 'Somewhere', country: null });
    expect(normalizePhilJobNetLocation('BAGUIO CITY, BENGUET')).toMatchObject({ country: 'Philippines' });
  });

  it('maps PHP salary without conversion or invention', () => {
    expect(parsePhilJobNetSalary('₱22,000.00')).toEqual({ minimum: 22000, currency: 'PHP' });
    expect(parsePhilJobNetSalary('₱18,000.00 - ₱20,000.00')).toEqual({ minimum: 18000, currency: 'PHP' });
    expect(parsePhilJobNetSalary('Salary not specified')).toEqual({ minimum: null, currency: null });
    expect(parsePhilJobNetSalary('22,000')).toEqual({ minimum: null, currency: null });
  });

  it('parses both date formats the portal prints', () => {
    expect(parsePhilJobNetDate('Posted on 5 October 2026')).toBe('2026-10-05T00:00:00.000Z');
    expect(parsePhilJobNetDate('Posted on 25/5/2026')).toBe('2026-05-25T00:00:00.000Z');
    expect(parsePhilJobNetDate('Posted on 5/25/2026')).toBe('2026-05-25T00:00:00.000Z');
    expect(parsePhilJobNetDate('soon')).toBeNull();
  });

  it('drops ambiguous numeric dates and future dates', () => {
    const now = new Date('2026-10-06T00:00:00.000Z');
    expect(parsePhilJobNetDate('Posted on 10/5/2026', now)).toBeNull();
    expect(parsePhilJobNetDate('Posted on 5 November 2026', now)).toBeNull();
    expect(parsePhilJobNetDate('Posted on 5 October 2026', now)).toBe('2026-10-05T00:00:00.000Z');
  });

  it('keeps the literal text 00a0 and strips real no-break spaces', () => {
    const html = fixture('detail-1000001.html').replace(
      'Balances the till at end of shift.',
      'Ref 00a0 code\u00a0A.',
    );
    const detail = parsePhilJobNetDetail(html);
    expect(detail.description).toContain('Ref 00a0 code A.');
    const listing = parsePhilJobNetListing(fixture('list-page1.html').replace('EXAMPLE RETAIL CORP', 'ACME 00a0\u00a0INC'));
    expect(listing.cards[0]?.company).toBe('ACME 00a0 INC');
  });

  it('rejects an empty grid unless the site reports an explicit zero', () => {
    const html = fixture('list-empty.html').replace('0 job openings', 'Please try again');
    expect(() => parsePhilJobNetListing(html)).toThrow(/parser drift/u);
  });
});

afterEach(() => {
  vi.useRealTimers();
});

describe('discoverPhilJobNet', () => {
  it('makes no request without a role or while disabled', async () => {
    const client = new PortalClient(new Map());
    expect(await discoverPhilJobNet(client, profile({ roleQuery: '  ' }))).toEqual({ sources: [], vacancies: [] });
    expect(await discoverPhilJobNet(client, profile({ philJobNetEnabled: false }))).toEqual({ sources: [], vacancies: [] });
    expect(client.gets).toEqual([]);
    expect(client.posts).toEqual([]);
  });

  it('walks bounded pages with Web Forms state and hydrates details', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-06T12:00:00.000Z'));
    const client = fullClient();
    const run = await discoverPhilJobNet(client, profile());
    expect(client.posts).toHaveLength(1);
    expect(client.posts[0]?.fields).toMatchObject({
      __VIEWSTATE: 'vs-p1',
      __EVENTVALIDATION: 'ev-p1',
      __EVENTTARGET: 'ctl00$BodyContentPlaceHolder$GridView1',
      __EVENTARGUMENT: 'Page$2',
      ctl00$BodyContentPlaceHolder$searchterm: 'cashier',
    });
    const [source] = run.sources;
    // 5 unique cards (page 2 repeats card 1); two detail pages are closed and skipped.
    expect(run.vacancies.map((v) => v.key)).toEqual([
      'phil_jobnet:1000001',
      'phil_jobnet:1000002',
      'phil_jobnet:1000005',
    ]);
    expect(source).toMatchObject({ provider: 'phil_jobnet', status: 'success', complete: true });
    expect(source?.error).toMatch(/2 closed or missing/u);
    expect(client.gets).toContain(detailUrl('1000003'));
    const makati = run.vacancies[0];
    expect(makati).toMatchObject({
      title: 'CASHIER',
      company: 'EXAMPLE RETAIL CORP',
      url: detailUrl('1000001'),
      location: 'Makati City, Metro Manila, Philippines',
      currency: 'PHP',
      advertisedMinimum: 22000,
      salaryPeriod: null,
      annualizedMinimumUsd: null,
      employmentType: 'Permanent',
      postedAt: '2026-10-05T00:00:00.000Z',
    });
    expect(makati?.description).toContain('Qualifications: At least 1 year');
    expect(run.vacancies[1]).toMatchObject({ advertisedMinimum: null, currency: null });
  });

  it('is stable across repeat scans', async () => {
    const first = await discoverPhilJobNet(fullClient(), profile());
    const second = await discoverPhilJobNet(fullClient(), profile());
    expect(second.vacancies.map((v) => [v.key, v.url, v.contentHash])).toEqual(
      first.vacancies.map((v) => [v.key, v.url, v.contentHash]),
    );
    expect(new Set(first.vacancies.map((v) => v.key)).size).toBe(first.vacancies.length);
  });

  it('stops at the page budget and reports partial coverage', async () => {
    const client = fullClient();
    const run = await discoverPhilJobNet(client, profile({ philJobNetMaxPages: 1 }));
    expect(client.posts).toHaveLength(0);
    expect(run.sources[0]).toMatchObject({ status: 'partial', complete: false, continuationCursor: '2' });
  });

  it('reports a detail budget as partial and keeps listing-level rows', async () => {
    const client = fullClient();
    const run = await discoverPhilJobNet(client, profile({ philJobNetMaxDetails: 1, philJobNetMaxPages: 1 }));
    expect(client.gets.filter((url) => url.includes('/job/'))).toHaveLength(1);
    expect(run.vacancies).toHaveLength(3);
    expect(run.sources[0]?.status).toBe('partial');
  });

  it('survives a failing detail page', async () => {
    const routes = new Map([
      [SEARCH, page(fixture('list-page1.html'))],
      [detailUrl('1000001'), page('', 503)],
      [detailUrl('1000002'), page(fixture('detail-malformed.html'))],
      [detailUrl('1000003'), page(fixture('detail-1000002.html'))],
    ]);
    const run = await discoverPhilJobNet(new PortalClient(routes), profile({ philJobNetMaxPages: 1 }));
    expect(run.vacancies).toHaveLength(3);
    expect(run.sources[0]?.status).toBe('partial');
  });

  it('returns an empty successful run for no results', async () => {
    const client = new PortalClient(new Map([[SEARCH, page(fixture('list-empty.html'))]]));
    const run = await discoverPhilJobNet(client, profile());
    expect(run.vacancies).toEqual([]);
    expect(run.sources[0]).toMatchObject({ status: 'success', listings: 0, complete: true });
  });

  it('surfaces parser drift as a visible failed source', async () => {
    const client = new PortalClient(new Map([[SEARCH, page(fixture('list-malformed.html'))]]));
    const run = await discoverPhilJobNet(client, profile());
    expect(run.vacancies).toEqual([]);
    expect(run.sources[0]).toMatchObject({ status: 'error', complete: false });
    expect(run.sources[0]?.error).toMatch(/parser drift/u);
  });

  it('reports a blocked response and does not retry around it', async () => {
    const client = new PortalClient(new Map([[SEARCH, page('', 403)]]));
    const run = await discoverPhilJobNet(client, profile());
    expect(run.sources[0]?.status).toBe('blocked');
    expect(client.gets).toHaveLength(1);
  });

  it('stops on a blocked detail page instead of counting it as a detail failure', async () => {
    for (const status of [429, 403]) {
      const client = new PortalClient(new Map([[SEARCH, page(fixture('list-page1.html'))]]));
      const get = client.get.bind(client);
      client.get = async (url: string): Promise<AtsHttpResponse> => {
        if (url.includes('/job/')) {
          client.gets.push(url);
          throw new AtsResponseError('phil_jobnet', `HTTP ${status}`, status);
        }
        return get(url);
      };
      const run = await discoverPhilJobNet(client, profile({ philJobNetMaxPages: 1 }));
      expect(run.sources[0]?.status).toBe('blocked');
      expect(client.gets.filter((url) => url.includes('/job/'))).toHaveLength(1);
    }
  });

  it('fails fast as blocked on a login wall', async () => {
    const client = new PortalClient(
      new Map([[SEARCH, { ...page(fixture('list-page1.html')), finalUrl: `${PHIL_JOBNET_ORIGIN}/login.aspx?url=x` }]]),
    );
    const run = await discoverPhilJobNet(client, profile());
    expect(run.sources[0]?.status).toBe('blocked');
    expect(client.gets).toHaveLength(1);
  });

  it('reports partial when no next page is offered but the total says more listings exist', async () => {
    const html = fixture('list-page2.html').replace('5 job openings', '50 job openings');
    const run = await discoverPhilJobNet(new PortalClient(new Map([[SEARCH, page(html)]])), profile());
    expect(run.sources[0]).toMatchObject({ status: 'partial', complete: false });
    expect(run.sources[0]?.error).toMatch(/50 openings/u);
  });

  it('reports drift when cards are shown but no pager is found and the total is unknown', async () => {
    const html = fixture('list-page1.html')
      .replace(/<tr class="pagination-vs">[\s\S]*?<\/table><\/td><\/tr>/u, '')
      .replace('5 job openings', 'Search results');
    const run = await discoverPhilJobNet(new PortalClient(new Map([[SEARCH, page(html)]])), profile());
    expect(run.sources[0]?.status).toBe('error');
    expect(run.sources[0]?.error).toMatch(/pager/u);
  });

  it('flags a postback that returns the wrong page as drift', async () => {
    const client = new PortalClient(
      new Map([[SEARCH, page(fixture('list-page1.html'))]]),
      new Map([['Page$2', page(fixture('list-page1.html'))]]),
    );
    const run = await discoverPhilJobNet(client, profile());
    expect(run.sources[0]?.status).toBe('error');
  });

  it('is gated in the source registry until explicitly enabled', () => {
    const off = globalRemoteSourceRegistry(profile({ philJobNetEnabled: false })).find((s) => s.id === 'phil_jobnet');
    const on = globalRemoteSourceRegistry(profile()).find((s) => s.id === 'phil_jobnet');
    expect(off).toMatchObject({ state: 'configuration_required', ingestionMode: 'disabled' });
    expect(on).toMatchObject({ state: 'active', ingestionMode: 'linked_index' });
  });
});
