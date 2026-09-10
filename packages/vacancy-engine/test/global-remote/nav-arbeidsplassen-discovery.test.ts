import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import type { AtsHttpResponse } from '../../src/ats/http.js';
import {
  NAV_ARBEIDSPLASSEN_FEED_URL,
  navArbeidsplassenEntryUrl,
  runNavArbeidsplassenDiscovery,
} from '../../src/global-remote/nav-arbeidsplassen-discovery.js';
import type { GlobalRemoteConfig } from '../../src/global-remote/models.js';
import { FixtureHttpClient } from '../ats/helpers.js';

function fixture(name: string): string {
  return readFileSync(
    path.resolve(process.cwd(), 'test/fixtures/global-remote/nav-arbeidsplassen', name),
    'utf8',
  );
}

function fixtureJson(name: string): Record<string, unknown> {
  return JSON.parse(fixture(name)) as Record<string, unknown>;
}

function profile(overrides: Partial<GlobalRemoteConfig['discovery']> = {}): GlobalRemoteConfig {
  return {
    version: 'test',
    minimumAnnualBaseUsd: 100_000,
    discovery: {
      roleQuery: '',
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
      remooteRoleTitle: '',
      remooteCountry: '',
      remooteLimit: 10,
      aiDevJobsMaxPages: 1,
      museEnabled: false,
      museMaxPages: 1,
      adzunaAppId: '',
      adzunaAppKey: '',
      adzunaMaxPages: 1,
      joobleApiKey: '',
      reedApiKey: '',
      jobspipeApiKey: '',
      navArbeidsplassenApiKey: 'test-nav-key',
      navArbeidsplassenMaxPages: 1,
      atsRosterConcurrency: 1,
      ...overrides,
    },
    officialSources: [],
  };
}

const PAGE_1_URL = NAV_ARBEIDSPLASSEN_FEED_URL;
const PAGE_2_URL = 'https://pam-stilling-feed.nav.no/api/v1/feed/22222222-0000-4000-8000-000000000002';
const FRONTEND_UUID = '11111111-1111-4111-8111-111111111111';
const INACTIVE_UUID = '22222222-2222-4222-8222-222222222222';
const BACKEND_UUID = '33333333-3333-4333-8333-333333333333';
const STAVANGER_UUID = '44444444-4444-4444-8444-444444444444';
const TO_BE_DELETED_UUID = '55555555-5555-4555-8555-555555555555';

describe('NAV Arbeidsplassen feed discovery (configuration-required until a bearer token is set)', () => {
  it('fetches detail only for ACTIVE feed lines and normalizes the frontend and backend ads', async () => {
    const routes = new Map<string, string | AtsHttpResponse>([
      [PAGE_1_URL, fixture('feed-page-1.json')],
      [navArbeidsplassenEntryUrl(FRONTEND_UUID), fixture('detail-active.json')],
      [navArbeidsplassenEntryUrl(BACKEND_UUID), fixture('detail-backend.json')],
    ]);
    const http = new FixtureHttpClient(routes);

    const result = await runNavArbeidsplassenDiscovery(http, profile());

    // The INACTIVE entry (Rådgiver) must never trigger a detail round trip.
    expect(http.requestedUrls).toEqual([
      PAGE_1_URL,
      navArbeidsplassenEntryUrl(FRONTEND_UUID),
      navArbeidsplassenEntryUrl(BACKEND_UUID),
    ]);
    expect(http.requestedUrls).not.toContain(navArbeidsplassenEntryUrl(INACTIVE_UUID));
    expect(result.sources).toEqual([
      expect.objectContaining({
        id: 'nav_arbeidsplassen:feed',
        provider: 'nav_arbeidsplassen',
        requests: 3,
        listings: 2,
        // feed-page-1.json has a next_url and navArbeidsplassenMaxPages defaults to 1 in this
        // profile, so the walk stops at its configured page budget, not an error or rate limit.
        status: 'partial',
        error: expect.stringContaining('configured 1-page limit'),
      }),
    ]);
    expect(result.vacancies.map((vacancy) => vacancy.key)).toEqual([
      `nav_arbeidsplassen:${FRONTEND_UUID}`,
      `nav_arbeidsplassen:${BACKEND_UUID}`,
    ]);
    expect(result.vacancies[0]).toEqual(
      expect.objectContaining({
        provider: 'nav_arbeidsplassen',
        company: 'Nordic Product AS',
        title: 'Frontend Developer',
        url: 'https://nordicproduct.example/careers/frontend-developer/apply',
        location: 'Oslo, Norway, Europe',
        employmentType: 'Fast',
        currency: null,
        salaryPeriod: null,
        advertisedMinimum: null,
        decision: 'salary_unverified',
        postedAt: '2026-08-15T08:00:00.000Z',
      }),
    );
    expect(result.vacancies[0]?.description).toContain(
      `NAV Arbeidsplassen listing: https://arbeidsplassen.nav.no/stillinger/stilling/${FRONTEND_UUID}`,
    );
    expect(result.vacancies[1]).toEqual(
      expect.objectContaining({
        key: `nav_arbeidsplassen:${BACKEND_UUID}`,
        // No applicationUrl in the fixture: falls back to the canonical NAV listing link.
        url: `https://arbeidsplassen.nav.no/stillinger/stilling/${BACKEND_UUID}`,
        location: 'Trondheim, Trøndelag, Norway, Europe',
        decision: 'role_mismatch',
      }),
    );
  });

  it('excludes contactList (named contacts, personal email/phone) from output and from the content fingerprint', async () => {
    const routes = new Map<string, string | AtsHttpResponse>([
      [PAGE_1_URL, fixture('feed-page-1.json')],
      [navArbeidsplassenEntryUrl(FRONTEND_UUID), fixture('detail-active.json')],
      [navArbeidsplassenEntryUrl(BACKEND_UUID), fixture('detail-backend.json')],
    ]);
    const result = await runNavArbeidsplassenDiscovery(new FixtureHttpClient(routes), profile());

    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain('Kari Nordmann');
    expect(serialized).not.toContain('kari.nordmann@example.invalid');
    expect(serialized).not.toContain('12345678');
  });

  it('does not let a changed contact list affect the stored content fingerprint', async () => {
    const withDifferentContact = fixtureJson('detail-active.json');
    const adContent = withDifferentContact.ad_content as Record<string, unknown>;
    adContent.contactList = [{ name: 'Different Recruiter', email: 'different@example.invalid', phone: '+47 00000000', role: 'Recruiter', title: null }];

    const first = await runNavArbeidsplassenDiscovery(
      new FixtureHttpClient(new Map([
        [PAGE_1_URL, fixture('feed-page-1.json')],
        [navArbeidsplassenEntryUrl(FRONTEND_UUID), fixture('detail-active.json')],
        [navArbeidsplassenEntryUrl(BACKEND_UUID), fixture('detail-backend.json')],
      ])),
      profile(),
    );
    const second = await runNavArbeidsplassenDiscovery(
      new FixtureHttpClient(new Map([
        [PAGE_1_URL, fixture('feed-page-1.json')],
        [navArbeidsplassenEntryUrl(FRONTEND_UUID), JSON.stringify(withDifferentContact)],
        [navArbeidsplassenEntryUrl(BACKEND_UUID), fixture('detail-backend.json')],
      ])),
      profile(),
    );

    expect(first.vacancies[0]?.contentHash).toBe(second.vacancies[0]?.contentHash);
  });

  it('walks into the next page within the configured budget and stops once next_url is null', async () => {
    const routes = new Map<string, string | AtsHttpResponse>([
      [PAGE_1_URL, fixture('feed-page-1.json')],
      [PAGE_2_URL, fixture('feed-page-2.json')],
      [navArbeidsplassenEntryUrl(FRONTEND_UUID), fixture('detail-active.json')],
      [navArbeidsplassenEntryUrl(BACKEND_UUID), fixture('detail-backend.json')],
      [navArbeidsplassenEntryUrl(STAVANGER_UUID), fixture('detail-stavanger.json')],
    ]);
    const http = new FixtureHttpClient(routes);

    const result = await runNavArbeidsplassenDiscovery(http, profile({ navArbeidsplassenMaxPages: 3 }));

    expect(http.requestedUrls).toEqual([
      PAGE_1_URL,
      navArbeidsplassenEntryUrl(FRONTEND_UUID),
      navArbeidsplassenEntryUrl(BACKEND_UUID),
      PAGE_2_URL,
      navArbeidsplassenEntryUrl(STAVANGER_UUID),
    ]);
    expect(result.sources).toEqual([
      expect.objectContaining({ requests: 5, listings: 3, status: 'success', error: null }),
    ]);
    expect(result.vacancies.map((vacancy) => vacancy.key)).toEqual([
      `nav_arbeidsplassen:${FRONTEND_UUID}`,
      `nav_arbeidsplassen:${BACKEND_UUID}`,
      `nav_arbeidsplassen:${STAVANGER_UUID}`,
    ]);
  });

  it('treats an empty feed page as a successful empty result', async () => {
    const routes = new Map([[PAGE_1_URL, fixture('feed-empty.json')]]);

    const result = await runNavArbeidsplassenDiscovery(new FixtureHttpClient(routes), profile());

    expect(result.sources).toEqual([
      expect.objectContaining({ requests: 1, listings: 0, status: 'success', error: null }),
    ]);
    expect(result.vacancies).toEqual([]);
  });

  it('treats a 304 response as an empty page rather than an error', async () => {
    const response: AtsHttpResponse = { status: 304, finalUrl: PAGE_1_URL, headers: {}, body: '' };
    const routes = new Map<string, string | AtsHttpResponse>([[PAGE_1_URL, response]]);

    const result = await runNavArbeidsplassenDiscovery(new FixtureHttpClient(routes), profile());

    expect(result.sources).toEqual([
      expect.objectContaining({ requests: 1, listings: 0, status: 'success', error: null }),
    ]);
    expect(result.vacancies).toEqual([]);
  });

  it('isolates a malformed feed page as an errored source without throwing', async () => {
    const routes = new Map([[PAGE_1_URL, fixture('feed-malformed.json')]]);

    const result = await runNavArbeidsplassenDiscovery(new FixtureHttpClient(routes), profile());

    expect(result.sources).toEqual([
      expect.objectContaining({
        status: 'error',
        listings: 0,
        error: expect.stringContaining('items is not an array'),
      }),
    ]);
    expect(result.vacancies).toEqual([]);
  });

  it('isolates an authentication error (401) as blocked without retrying', async () => {
    const response: AtsHttpResponse = { status: 401, finalUrl: PAGE_1_URL, headers: {}, body: fixture('auth-error.json') };
    const routes = new Map<string, string | AtsHttpResponse>([[PAGE_1_URL, response]]);
    const http = new FixtureHttpClient(routes);

    const result = await runNavArbeidsplassenDiscovery(http, profile());

    expect(http.requestedUrls).toEqual([PAGE_1_URL]);
    expect(result.sources).toEqual([
      expect.objectContaining({ requests: 1, listings: 0, status: 'blocked', error: expect.stringContaining('HTTP 401') }),
    ]);
    expect(http.requestedOptions[0]?.headers).toMatchObject({ Authorization: 'Bearer test-nav-key' });
  });

  it('isolates a rate limit (429) as blocked', async () => {
    const response: AtsHttpResponse = { status: 429, finalUrl: PAGE_1_URL, headers: {}, body: fixture('rate-limited.json') };
    const routes = new Map<string, string | AtsHttpResponse>([[PAGE_1_URL, response]]);

    const result = await runNavArbeidsplassenDiscovery(new FixtureHttpClient(routes), profile());

    expect(result.sources).toEqual([
      expect.objectContaining({ status: 'blocked', requests: 1, listings: 0, error: expect.stringContaining('HTTP 429') }),
    ]);
  });

  it('silently drops a contract-violating ad detail while still normalizing the other active ad', async () => {
    const singlePage = fixtureJson('feed-page-1.json');
    singlePage.next_url = null;
    singlePage.next_id = null;
    const routes = new Map<string, string | AtsHttpResponse>([
      [PAGE_1_URL, JSON.stringify(singlePage)],
      [navArbeidsplassenEntryUrl(FRONTEND_UUID), fixture('detail-malformed.json')],
      [navArbeidsplassenEntryUrl(BACKEND_UUID), fixture('detail-backend.json')],
    ]);

    const result = await runNavArbeidsplassenDiscovery(new FixtureHttpClient(routes), profile());

    expect(result.sources).toEqual([
      expect.objectContaining({ status: 'success', listings: 1, error: null }),
    ]);
    expect(result.vacancies.map((vacancy) => vacancy.key)).toEqual([`nav_arbeidsplassen:${BACKEND_UUID}`]);
  });

  it('isolates a failed ad-detail lookup (transient error) and reports it as partial', async () => {
    const singlePage = fixtureJson('feed-page-1.json');
    singlePage.next_url = null;
    singlePage.next_id = null;
    const failure: AtsHttpResponse = {
      status: 500,
      finalUrl: navArbeidsplassenEntryUrl(FRONTEND_UUID),
      headers: {},
      body: 'Internal Server Error',
    };
    const routes = new Map<string, string | AtsHttpResponse>([
      [PAGE_1_URL, JSON.stringify(singlePage)],
      [navArbeidsplassenEntryUrl(FRONTEND_UUID), failure],
      [navArbeidsplassenEntryUrl(BACKEND_UUID), fixture('detail-backend.json')],
    ]);

    const result = await runNavArbeidsplassenDiscovery(new FixtureHttpClient(routes), profile());

    expect(result.sources).toEqual([
      expect.objectContaining({
        status: 'partial',
        listings: 1,
        error: expect.stringContaining('1 ad detail lookup(s) failed'),
      }),
    ]);
    expect(result.vacancies.map((vacancy) => vacancy.key)).toEqual([`nav_arbeidsplassen:${BACKEND_UUID}`]);
  });

  it('never resurrects an ad whose expires date has already passed, even while status is ACTIVE', async () => {
    const expiredUuid = '77777777-7777-4777-8777-777777777777';
    const page = fixtureJson('feed-page-1.json');
    page.items = [{
      id: expiredUuid,
      url: `https://arbeidsplassen.nav.no/stillinger/stilling/${expiredUuid}`,
      title: 'Frontend Developer',
      content_text: 'Expired listing',
      date_modified: '2020-02-01T00:00:00Z',
      _feed_entry: {
        uuid: expiredUuid,
        status: 'ACTIVE',
        title: 'Frontend Developer',
        businessName: 'Old Corp AS',
        municipal: 'Oslo',
        sistEndret: '2020-02-01T00:00:00Z',
      },
    }];
    page.next_url = null;
    page.next_id = null;
    const routes = new Map<string, string | AtsHttpResponse>([
      [PAGE_1_URL, JSON.stringify(page)],
      [navArbeidsplassenEntryUrl(expiredUuid), fixture('detail-expired.json')],
    ]);

    const result = await runNavArbeidsplassenDiscovery(new FixtureHttpClient(routes), profile());

    expect(result.vacancies).toEqual([]);
    expect(result.sources[0]).toMatchObject({ status: 'success', listings: 0 });
  });

  it('reflects an update and a deletion on the next successful run (reconciliation)', async () => {
    function feedPage(frontendStatus: string, toBeDeletedStatus: string): string {
      return JSON.stringify({
        version: 'https://jsonfeed.org/version/1',
        title: 'Arbeidsplassen.no - Stillingsannonser',
        home_page_url: 'https://arbeidsplassen.nav.no',
        feed_url: PAGE_1_URL,
        description: 'Offentlig feed av stillingsannonser fra Arbeidsplassen.no',
        next_url: null,
        id: '22222222-0000-4000-8000-000000000001',
        next_id: null,
        items: [
          {
            id: FRONTEND_UUID,
            url: `https://arbeidsplassen.nav.no/stillinger/stilling/${FRONTEND_UUID}`,
            title: 'Frontend Developer',
            content_text: 'Frontend Developer at Nordic Product AS',
            date_modified: '2026-08-20T09:00:00Z',
            _feed_entry: { uuid: FRONTEND_UUID, status: frontendStatus, title: 'Frontend Developer', businessName: 'Nordic Product AS', municipal: 'Oslo', sistEndret: '2026-08-20T09:00:00Z' },
          },
          {
            id: TO_BE_DELETED_UUID,
            url: `https://arbeidsplassen.nav.no/stillinger/stilling/${TO_BE_DELETED_UUID}`,
            title: 'HR Coordinator',
            content_text: 'HR Coordinator at Bergen Kommune',
            date_modified: '2026-08-21T09:00:00Z',
            _feed_entry: { uuid: TO_BE_DELETED_UUID, status: toBeDeletedStatus, title: 'HR Coordinator', businessName: 'Bergen Kommune', municipal: 'Bergen', sistEndret: '2026-08-21T09:00:00Z' },
          },
        ],
      });
    }

    const runOne = await runNavArbeidsplassenDiscovery(
      new FixtureHttpClient(new Map<string, string | AtsHttpResponse>([
        [PAGE_1_URL, feedPage('ACTIVE', 'ACTIVE')],
        [navArbeidsplassenEntryUrl(FRONTEND_UUID), fixture('detail-active.json')],
        [navArbeidsplassenEntryUrl(TO_BE_DELETED_UUID), fixture('detail-to-be-deleted.json')],
      ])),
      profile(),
    );

    expect(runOne.vacancies.map((vacancy) => vacancy.key)).toEqual([
      `nav_arbeidsplassen:${FRONTEND_UUID}`,
      `nav_arbeidsplassen:${TO_BE_DELETED_UUID}`,
    ]);
    expect(runOne.vacancies[0]?.title).toBe('Frontend Developer');

    const runTwo = await runNavArbeidsplassenDiscovery(
      new FixtureHttpClient(new Map<string, string | AtsHttpResponse>([
        [PAGE_1_URL, feedPage('ACTIVE', 'DELETED')],
        [navArbeidsplassenEntryUrl(FRONTEND_UUID), fixture('detail-updated.json')],
      ])),
      profile(),
    );

    // The updated ad replaces the stale title; the deleted ad is gone without a stale fallback,
    // and its detail endpoint is never even called since its feed-line status is no longer ACTIVE.
    expect(runTwo.vacancies.map((vacancy) => vacancy.key)).toEqual([`nav_arbeidsplassen:${FRONTEND_UUID}`]);
    expect(runTwo.vacancies[0]?.title).toBe('Senior Frontend Developer');
  });
});
