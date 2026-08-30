import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import type { AtsHttpResponse } from '../../src/ats/http.js';
import { runJobtechDiscovery } from '../../src/global-remote/jobtech-discovery.js';
import type { GlobalRemoteConfig } from '../../src/global-remote/models.js';
import { FixtureHttpClient } from '../ats/helpers.js';

const SEARCH_URL =
  'https://jobsearch.api.jobtechdev.se/search?q=frontend&remote=true&limit=100&offset=0';

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

async function fixture(): Promise<string> {
  return readFile(
    path.resolve(process.cwd(), 'test/fixtures/global-remote/jobtech-search.json'),
    'utf8',
  );
}

describe('Arbetsförmedlingen JobSearch discovery', () => {
  it('normalizes current ads, prefers the direct application URL, and omits contact fields', async () => {
    const parsed = JSON.parse(await fixture()) as {
      total: { value: number };
      hits: { removed?: boolean }[];
    };
    parsed.hits = parsed.hits.filter((hit) => hit.removed !== true);
    parsed.total.value = parsed.hits.length;
    const http = new FixtureHttpClient(new Map([[SEARCH_URL, JSON.stringify(parsed)]]));

    const result = await runJobtechDiscovery(http, config);

    expect(result.sources).toEqual([
      expect.objectContaining({
        provider: 'jobtech_sweden',
        status: 'success',
        requests: 1,
        listings: 2,
      }),
    ]);
    expect(result.vacancies).toEqual([
      expect.objectContaining({
        key: 'jobtech_sweden:jobtech-frontend-1',
        company: 'Nordic Product AB',
        title: 'Senior Frontend Engineer',
        url: 'https://careers.example.se/jobs/frontend-engineer',
        location: 'Remote or partly remote · Stockholm, Stockholms län, Sweden, Europe',
        decision: 'salary_unverified',
      }),
      expect.objectContaining({
        key: 'jobtech_sweden:jobtech-backend-1',
        url: 'https://arbetsformedlingen.se/platsbanken/annonser/jobtech-backend-1',
        decision: 'role_mismatch',
      }),
    ]);
    expect(http.requestedOptions[0]?.headers).toMatchObject({
      Accept: 'application/json',
      'X-Fields': expect.not.stringContaining('application_contacts'),
    });
    expect(http.requestedOptions[0]?.allowedOrigins).toEqual([
      'https://jobsearch.api.jobtechdev.se',
    ]);
    expect(JSON.stringify(result)).not.toContain('private-recruiter');
    expect(result.vacancies.some((vacancy) => vacancy.key.includes('removed'))).toBe(false);
  });

  it('does not let unexpected contact changes affect the stored content fingerprint', async () => {
    const firstBody = await fixture();
    const changed = JSON.parse(firstBody) as {
      hits: { application_contacts?: { name?: string }[] }[];
    };
    changed.hits[0]?.application_contacts?.splice(0, 1, { name: 'Different Private Recruiter' });
    Object.assign(changed.hits[0] ?? {}, {
      description: { text: 'Contact Different Person at changed-private@example.invalid.' },
    });
    const first = await runJobtechDiscovery(
      new FixtureHttpClient(new Map([[SEARCH_URL, firstBody]])),
      config,
    );
    const second = await runJobtechDiscovery(
      new FixtureHttpClient(new Map([[SEARCH_URL, JSON.stringify(changed)]])),
      config,
    );

    expect(first.vacancies[0]?.contentHash).toBe(second.vacancies[0]?.contentHash);
  });

  it('reports a bounded page as partial and classifies rate limiting as blocked', async () => {
    const partialBody = JSON.parse(await fixture()) as { total: { value: number } };
    partialBody.total.value = 101;
    const partial = await runJobtechDiscovery(
      new FixtureHttpClient(new Map([[SEARCH_URL, JSON.stringify(partialBody)]])),
      config,
    );
    const blockedResponse: AtsHttpResponse = {
      status: 429,
      finalUrl: SEARCH_URL,
      headers: {},
      body: 'Too many requests',
    };
    const blocked = await runJobtechDiscovery(
      new FixtureHttpClient(new Map([[SEARCH_URL, blockedResponse]])),
      config,
    );

    expect(partial.sources[0]).toMatchObject({
      status: 'partial',
    });
    expect(partial.sources[0]?.error).toContain(
      'Bounded to 3 of 101 active remote frontend matches.',
    );
    expect(partial.sources[0]?.error).toContain('Dropped 0 malformed and 1 removed hit(s).');
    expect(blocked.sources[0]).toMatchObject({ status: 'blocked', requests: 1, listings: 0 });
  });

  it('marks missing totals and malformed hits partial instead of claiming completeness', async () => {
    const body = JSON.parse(await fixture()) as {
      total?: { value: number };
      hits: unknown[];
    };
    delete body.total;
    body.hits.push({ headline: 'Missing employer and URL' });

    const result = await runJobtechDiscovery(
      new FixtureHttpClient(new Map([[SEARCH_URL, JSON.stringify(body)]])),
      config,
    );

    expect(result.sources[0]).toMatchObject({ status: 'partial', listings: 2 });
    expect(result.sources[0]?.error).toContain('Response omitted the total count');
    expect(result.sources[0]?.error).toContain('Dropped 1 malformed and 1 removed hit(s).');
  });
});
