import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import type { AtsHttpClient, AtsHttpRequestOptions, AtsHttpResponse } from '../../src/ats/http.js';
import { runKeyedDiscovery } from '../../src/global-remote/keyed-discovery.js';
import type { GlobalRemoteConfig } from '../../src/global-remote/models.js';
import { globalRemoteSourceRegistry, theirstackConfigured } from '../../src/global-remote/source-registry.js';
import {
  discoverTheirStack,
  redactTheirStackKey,
  THEIRSTACK_MIN_REQUEST_INTERVAL_MS,
  THEIRSTACK_SEARCH_URL,
} from '../../src/global-remote/theirstack-discovery.js';
import { vacancyIdentityFor } from '../../src/vacancies/identity.js';

/** Synthetic marker only; never a real key. */
const TEST_KEY = 'test-only-theirstack-key-0000';

function fixture(name: string): string {
  return readFileSync(path.resolve(process.cwd(), 'test/fixtures/global-remote/theirstack', name), 'utf8');
}

function profile(overrides: Partial<GlobalRemoteConfig['discovery']> = {}): GlobalRemoteConfig {
  return {
    version: 'test',
    minimumAnnualBaseUsd: null,
    discovery: {
      roleQuery: 'frontend engineer',
      himalayasQueries: ['frontend'],
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
      theirstackEnabled: true,
      theirstackApiKey: TEST_KEY,
      theirstackMaxCredits: 50,
      theirstackMaxPages: 4,
      theirstackPostedWithinDays: 7,
      ...overrides,
    },
    officialSources: [],
  };
}

type Scripted = string | AtsHttpResponse | Error;

class ScriptedClient implements AtsHttpClient {
  public readonly urls: string[] = [];
  public readonly bodies: Record<string, unknown>[] = [];
  public readonly options: (AtsHttpRequestOptions | undefined)[] = [];
  public constructor(private readonly script: Scripted[]) {}

  public async get(): Promise<AtsHttpResponse> {
    throw new Error('TheirStack must never issue GET requests');
  }

  public async postJson(url: string, body: unknown, options?: AtsHttpRequestOptions): Promise<AtsHttpResponse> {
    this.urls.push(url);
    this.bodies.push(body as Record<string, unknown>);
    this.options.push(options);
    const next = this.script.shift();
    if (next === undefined) throw new Error('Unexpected extra TheirStack request');
    if (next instanceof Error) throw next;
    if (typeof next !== 'string') return next;
    return { status: 200, finalUrl: url, headers: {}, body: next };
  }
}

function status(code: number, body: string, headers: Record<string, string> = {}): AtsHttpResponse {
  return { status: code, finalUrl: THEIRSTACK_SEARCH_URL, headers, body };
}

const noWait = { sleep: async () => undefined };

describe('TheirStack Jobs API discovery (paid, key and explicit enablement required)', () => {
  it('makes zero requests without explicit enablement, without a key, or without a role', async () => {
    for (const overrides of [
      { theirstackEnabled: false },
      { theirstackEnabled: undefined },
      { theirstackApiKey: '' },
      { theirstackApiKey: undefined },
      { theirstackApiKey: '   ' },
    ]) {
      const client = new ScriptedClient([fixture('search-page-1.json')]);
      const config = profile(overrides);
      const direct = await discoverTheirStack(client, config, noWait);
      const viaKeyed = await runKeyedDiscovery(client, config);
      expect(direct).toEqual({ sources: [], vacancies: [] });
      expect(viaKeyed.sources.filter((source) => source.provider === 'theirstack')).toEqual([]);
      expect(client.urls).toEqual([]);
      expect(theirstackConfigured(config)).toBe(false);
    }

    const client = new ScriptedClient([fixture('search-page-1.json')]);
    const result = await discoverTheirStack(client, profile({ roleQuery: '  ' }), noWait);
    expect(client.urls).toEqual([]);
    expect(result.sources[0]).toMatchObject({ status: 'error', creditsUsed: 0 });
    expect(result.sources[0]?.error).toContain('role');
  });

  it('is configuration_required until enabled with a key, and active afterwards', () => {
    const gated = globalRemoteSourceRegistry(profile({ theirstackEnabled: false })).find((s) => s.id === 'theirstack');
    expect(gated).toMatchObject({
      state: 'configuration_required',
      ingestionMode: 'disabled',
      provider: 'theirstack',
      transport: 'api',
    });
    const keyOnly = globalRemoteSourceRegistry(profile({ theirstackEnabled: false, theirstackApiKey: TEST_KEY }));
    expect(keyOnly.find((s) => s.id === 'theirstack')?.state).toBe('configuration_required');
    const active = globalRemoteSourceRegistry(profile()).find((s) => s.id === 'theirstack');
    expect(active).toMatchObject({ state: 'active', ingestionMode: 'linked_index', provider: 'theirstack' });
    expect(JSON.stringify(active)).not.toContain(TEST_KEY);
  });

  it('maps jobs with stable ids, canonical employer URL, provenance, salary and employment', async () => {
    const client = new ScriptedClient([fixture('search-page-1.json')]);
    const result = await discoverTheirStack(client, profile({ theirstackMaxCredits: 2 }), noWait);

    expect(result.vacancies.map((v) => v.key)).toEqual(['theirstack:900000001', 'theirstack:900000002']);
    const [first, second] = result.vacancies;
    expect(first).toMatchObject({
      provider: 'theirstack',
      company: 'ExampleCo',
      title: 'Senior Frontend Engineer',
      url: 'https://boards.greenhouse.io/exampleco/jobs/4012345',
      employmentType: 'full time',
      postedAt: '2026-10-01T00:00:00.000Z',
    });
    expect(first?.description).toContain('Provider: TheirStack');
    expect(first?.description).toContain('Original posting: https://jobs.example-board.test/listing/900000001');
    expect(first?.location).toBe('Amsterdam, NH, Netherlands');
    expect(second).toMatchObject({
      url: 'https://jobs.example-board.test/listing/900000002',
      currency: 'EUR',
      advertisedMinimum: 70000,
      salaryPeriod: 'annual',
      employmentType: 'contract',
    });
    expect(second?.location).toContain('Remote');
  });

  it('deduplicates against direct ATS rows by resolving the employer career-page identity', async () => {
    const client = new ScriptedClient([fixture('search-page-1.json')]);
    const result = await discoverTheirStack(client, profile({ theirstackMaxCredits: 2 }), noWait);
    const direct = vacancyIdentityFor({
      url: 'https://boards.greenhouse.io/exampleco/jobs/4012345',
      company: 'ExampleCo',
      title: 'Senior Frontend Engineer',
      location: 'Amsterdam',
    });
    expect(direct.kind).toBe('requisition');
    expect(result.vacancies[0]?.identity).toEqual(direct);
    expect(result.vacancies[0]?.sources).toEqual([
      { provider: 'theirstack', key: 'theirstack:900000001', url: 'https://boards.greenhouse.io/exampleco/jobs/4012345' },
    ]);
  });

  it('sends a bounded, authenticated, non-retrying request limited to the credit budget', async () => {
    const client = new ScriptedClient([fixture('search-page-1.json')]);
    const result = await discoverTheirStack(client, profile({ theirstackMaxCredits: 2 }), noWait);

    expect(client.urls).toEqual([THEIRSTACK_SEARCH_URL]);
    expect(client.bodies[0]).toMatchObject({
      job_title_or: ['frontend engineer'],
      posted_at_max_age_days: 7,
      is_closed: false,
      limit: 2,
      offset: 0,
      include_total_results: false,
    });
    expect(client.options[0]).toMatchObject({
      allowedOrigins: ['https://api.theirstack.com'],
      maxRetries: 0,
      cache: 'no-store',
    });
    expect(new Headers(client.options[0]?.headers).get('authorization')).toBe(`Bearer ${TEST_KEY}`);
    expect(result.sources[0]).toMatchObject({
      provider: 'theirstack',
      requests: 1,
      listings: 2,
      creditsUsed: 2,
      creditCeiling: 2,
      status: 'partial',
      complete: false,
    });
    expect(result.sources[0]?.completenessReason).toContain('2 credits');
  });

  it('enforces the credit ceiling before fetching further pages and paginates by offset', async () => {
    const client = new ScriptedClient([fixture('search-page-1.json'), fixture('search-page-2.json')]);
    const result = await discoverTheirStack(
      client,
      profile({ theirstackMaxCredits: 5 }),
      { ...noWait, pageSize: 2 },
    );
    expect(client.bodies.map((b) => [b.limit, b.offset])).toEqual([[2, 0], [2, 2]]);
    expect(result.vacancies).toHaveLength(3);
    expect(result.sources[0]).toMatchObject({ status: 'success', complete: true, creditsUsed: 3, creditCeiling: 5 });

    // A ceiling of 3 with 2-row pages shrinks the second request to the 1 remaining credit.
    const capped = new ScriptedClient([fixture('search-page-1.json'), fixture('search-page-2.json')]);
    const cappedResult = await discoverTheirStack(
      capped,
      profile({ theirstackMaxCredits: 3 }),
      { ...noWait, pageSize: 2 },
    );
    expect(capped.bodies.map((b) => [b.limit, b.offset])).toEqual([[2, 0], [1, 2]]);
    expect(cappedResult.sources[0]).toMatchObject({ status: 'partial', creditsUsed: 3 });

    // The request ceiling stops the walk even when credits remain.
    const paged = new ScriptedClient([fixture('search-page-1.json')]);
    const pagedResult = await discoverTheirStack(
      paged,
      profile({ theirstackMaxPages: 1, theirstackMaxCredits: 100 }),
      { ...noWait, pageSize: 2 },
    );
    expect(paged.urls).toHaveLength(1);
    expect(pagedResult.sources[0]).toMatchObject({ status: 'partial' });
    expect(pagedResult.sources[0]?.completenessReason).toContain('1 requests');
  });

  it('paces consecutive requests to the documented 4 requests per second', async () => {
    let clock = 1_000;
    const waits: number[] = [];
    const client = new ScriptedClient([fixture('search-page-1.json'), fixture('search-page-2.json')]);
    await discoverTheirStack(client, profile({ theirstackMaxCredits: 5 }), {
      pageSize: 2,
      now: () => clock,
      sleep: async (ms) => {
        waits.push(ms);
        clock += ms;
      },
    });
    expect(waits).toEqual([THEIRSTACK_MIN_REQUEST_INTERVAL_MS]);
    expect(THEIRSTACK_MIN_REQUEST_INTERVAL_MS).toBeGreaterThanOrEqual(250);
  });

  it('drops closed jobs so closure is reconciled on the next scan', async () => {
    const client = new ScriptedClient([fixture('search-closed.json')]);
    const result = await discoverTheirStack(client, profile(), noWait);
    expect(result.vacancies.map((v) => v.key)).toEqual(['theirstack:900000011']);
    expect(client.bodies[0]).toMatchObject({ is_closed: false });
    expect(result.sources[0]).toMatchObject({ status: 'success', listings: 1, creditsUsed: 2 });
  });

  it('reports an empty result as a complete, zero-credit success', async () => {
    const client = new ScriptedClient([fixture('search-empty.json')]);
    const result = await discoverTheirStack(client, profile(), noWait);
    expect(result.vacancies).toEqual([]);
    expect(result.sources[0]).toMatchObject({ status: 'success', complete: true, creditsUsed: 0 });
  });

  it('fails cleanly on a malformed response without leaking the key', async () => {
    const client = new ScriptedClient([fixture('search-malformed.json')]);
    const result = await discoverTheirStack(client, profile(), noWait);
    expect(result.vacancies).toEqual([]);
    expect(result.sources[0]).toMatchObject({ status: 'error', complete: false });
    expect(JSON.stringify(result)).not.toContain(TEST_KEY);
  });

  it.each([
    [401, 'error-401.json', 'blocked', 'rejected the API key'],
    [402, 'error-402.json', 'error', 'credits or plan limit'],
    [429, 'error-429.json', 'blocked', 'rate limit'],
  ] as const)('maps HTTP %i to a guided message with a single request and no retry', async (code, file, expected, text) => {
    const client = new ScriptedClient([status(code, fixture(file), { 'retry-after': '30' })]);
    const result = await discoverTheirStack(client, profile(), noWait);
    expect(client.urls).toHaveLength(1);
    expect(client.options[0]).toMatchObject({ maxRetries: 0 });
    expect(result.vacancies).toEqual([]);
    expect(result.sources[0]).toMatchObject({ status: expected, complete: false, creditsUsed: 0 });
    expect(result.sources[0]?.error).toContain(text);
    expect(JSON.stringify(result)).not.toContain(TEST_KEY);
  });

  it('keeps earlier pages and stops at once when a later page hits 429', async () => {
    const client = new ScriptedClient([fixture('search-page-1.json'), status(429, fixture('error-429.json'))]);
    const result = await discoverTheirStack(client, profile({ theirstackMaxCredits: 10 }), { ...noWait, pageSize: 2 });
    expect(client.urls).toHaveLength(2);
    expect(result.vacancies).toHaveLength(2);
    expect(result.sources[0]).toMatchObject({ status: 'partial', creditsUsed: 2 });
    expect(result.sources[0]?.error).toContain('rate limit');
  });

  it('stops without another request when the rate-limit headers show an exhausted window', async () => {
    const client = new ScriptedClient([
      status(200, fixture('search-page-1.json'), { 'RateLimit-Remaining': '0', 'RateLimit-Reset': '60' }),
      fixture('search-page-2.json'),
    ]);
    const result = await discoverTheirStack(client, profile({ theirstackMaxCredits: 10 }), { ...noWait, pageSize: 2 });
    expect(client.urls).toHaveLength(1);
    expect(result.sources[0]).toMatchObject({ status: 'partial' });
    expect(result.sources[0]?.error).toContain('rate limit');
  });

  it('stops with the credit message when the account runs out mid-result', async () => {
    const client = new ScriptedClient([fixture('search-truncated.json')]);
    const result = await discoverTheirStack(client, profile(), noWait);
    expect(client.urls).toHaveLength(1);
    expect(result.vacancies).toHaveLength(1);
    expect(result.sources[0]).toMatchObject({ status: 'partial', complete: false });
    expect(result.sources[0]?.error).toContain('credits or plan limit');
  });

  it('redacts the key from thrown transport errors and from every audit field', async () => {
    const client = new ScriptedClient([new Error(`socket failed for Authorization: Bearer ${TEST_KEY}`)]);
    const result = await discoverTheirStack(client, profile(), noWait);
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain(TEST_KEY);
    expect(result.sources[0]?.error).toContain('[redacted]');
    expect(redactTheirStackKey(`x ${TEST_KEY} y`, TEST_KEY)).toBe('x [redacted] y');
  });

  it('never places the key in vacancies or fingerprints', async () => {
    const client = new ScriptedClient([fixture('search-page-1.json')]);
    const result = await discoverTheirStack(client, profile({ theirstackMaxCredits: 2 }), noWait);
    expect(JSON.stringify(result.vacancies)).not.toContain(TEST_KEY);
    expect(fixture('search-page-1.json')).not.toContain(TEST_KEY);
  });

  it('isolates failures to the theirstack source row inside keyed discovery', async () => {
    const client = new ScriptedClient([status(402, fixture('error-402.json'))]);
    const result = await runKeyedDiscovery(client, profile());
    expect(result.sources).toHaveLength(1);
    expect(result.sources[0]).toMatchObject({ provider: 'theirstack', status: 'error' });
  });
});
