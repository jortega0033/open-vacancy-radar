import { describe, expect, it, vi } from 'vitest';

import type { AtsHttpClient } from '../../src/ats/http.js';
import { SafeHttpClient, type SafeHttpClientOptions } from '../../src/crawler/http-client.js';
import type { DnsResolver } from '../../src/crawler/url-safety.js';
import { discoverHimalayas, discoverJobicy } from '../../src/global-remote/discovery.js';
import {
  attributeNetworkRequests,
  newNetworkAttemptCounters,
  recordAttributedNetworkAttempt,
} from '../../src/global-remote/discovery-attribution.js';
import type { GlobalRemoteConfig } from '../../src/global-remote/models.js';
import { createAtsHttpClient } from '../../src/pipeline/ats-http-client.js';
import { FixtureHttpClient } from '../ats/helpers.js';

/**
 * Regression coverage for issue #279 -- extending discovery telemetry to distinguish logical
 * requests from actual network attempts, retries, and final completeness, and to attribute those
 * correctly per source. Uses a real `SafeHttpClient` (never a real network call -- `fetchFn` is
 * always a scripted stub, exactly `crawler/http-client.test.ts`'s own pattern) wherever retry/
 * timeout/cancellation mechanics under test live in `SafeHttpClient` itself, and `FixtureHttpClient`
 * for the shape-only cases that don't need those mechanics.
 */

const publicResolver: DnsResolver = () => Promise.resolve([{ address: '93.184.216.34', family: 4 }]);

function asFetch(
  implementation: (input: string | URL | Request, init?: RequestInit) => Promise<Response>,
): typeof fetch {
  return implementation;
}

/**
 * A real `SafeHttpClient` (never a real network call -- `fetchFn` is always a scripted stub) with
 * `onNetworkRequest` wired exactly the way `pipeline/global-remote.ts`'s production composition
 * root wires it: every attempt routed through `recordAttributedNetworkAttempt`, so a discovery
 * source's own `attributeNetworkRequests`-wrapped client (see each `discover*` function under test)
 * actually receives real attempt/retry telemetry, the same as a live scan would.
 */
function realHttpClient(overrides: Partial<SafeHttpClientOptions> = {}): AtsHttpClient {
  const safeClient = new SafeHttpClient({
    globalConcurrency: 3,
    perDomainConcurrency: 3,
    timeoutMs: 500,
    maxRetries: 2,
    userAgent: 'OpenVacancyRadar/test (+personal vacancy research)',
    resolver: publicResolver,
    fetchFn: asFetch(() => Promise.resolve(new Response('ok'))),
    random: () => 0.5,
    sleep: () => Promise.resolve(),
    onNetworkRequest: (_url, meta) => recordAttributedNetworkAttempt(meta.retryIndex),
    ...overrides,
  });
  return createAtsHttpClient(safeClient);
}

function config(overrides: Partial<GlobalRemoteConfig['discovery']> = {}): GlobalRemoteConfig {
  return {
    version: 'test',
    minimumAnnualBaseUsd: null,
    discovery: {
      roleQuery: '',
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
      atsRosterConcurrency: 1,
      navArbeidsplassenApiKey: '',
      navArbeidsplassenMaxPages: 1,
      ...overrides,
    },
    officialSources: [],
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

describe('acceptance: a 429 followed by an eventual success is retried but still complete', () => {
  it('records the retry attempt (networkAttempts/retries) while status stays success and complete stays true', async () => {
    const statuses = [429, 200];
    const bodies = [null, JSON.stringify({ jobs: [], totalCount: 0 })];
    const fetchFn = vi.fn(
      asFetch(() => {
        const status = statuses.shift() ?? 500;
        const body = bodies.shift() ?? null;
        return Promise.resolve(new Response(body, { status }));
      }),
    );
    const http = realHttpClient({ fetchFn, maxRetries: 2, baseRetryDelayMs: 1 });

    const result = await discoverHimalayas(http, config({ himalayasQueries: [] }));

    expect(fetchFn).toHaveBeenCalledTimes(2);
    expect(result.sources).toEqual([
      expect.objectContaining({
        status: 'success',
        requests: 1,
        networkAttempts: 2,
        retries: 1,
        complete: true,
        completenessReason: null,
      }),
    ]);
  });
});

describe('acceptance: a capped or failed page walk reports incomplete coverage with a reason/continuation marker', () => {
  it('reports complete: false with a reason and a next-page continuation cursor when the page cap is hit', async () => {
    const routes = new Map([
      [
        'https://himalayas.app/jobs/api/search?sort=salaryDesc&page=1',
        JSON.stringify({
          jobs: [{
            guid: 'himalayas-1',
            title: 'Frontend Engineer',
            companyName: 'Himalayas Co',
            applicationLink: 'https://himalayas.app/jobs/himalayas-1',
          }],
          totalCount: 40, // more than one page's worth (20/page) remains unseen
        }),
      ],
    ]);
    const http = new FixtureHttpClient(routes);

    const result = await discoverHimalayas(http, config({ himalayasQueries: [], himalayasMaxPagesPerQuery: 1 }));

    expect(result.sources).toEqual([
      expect.objectContaining({
        status: 'partial',
        complete: false,
        completenessReason: expect.stringContaining('1-page limit'),
        continuationCursor: '2',
      }),
    ]);
    // Never a falsely-clean "full scan" status just because the request itself succeeded.
    expect(result.sources[0]?.status).not.toBe('success');
  });

  it('reports complete: false with a reason when the page walk fails outright, distinct from a capped walk', async () => {
    const http = new FixtureHttpClient(
      new Map([
        [
          'https://himalayas.app/jobs/api/search?sort=salaryDesc&page=1',
          () => {
            throw new Error('boom');
          },
        ],
      ]),
    );

    const result = await discoverHimalayas(http, config({ himalayasQueries: [], himalayasMaxPagesPerQuery: 3 }));

    expect(result.sources).toEqual([
      expect.objectContaining({
        status: 'error',
        complete: false,
        completenessReason: expect.stringContaining('boom'),
        continuationCursor: null,
      }),
    ]);
  });
});

describe('acceptance: shared HTTP client retry counters attribute to the correct source', () => {
  it('never pools one source\'s retries into another source running at the same time', async () => {
    const himalayasUrl = 'https://himalayas.app/jobs/api/search?sort=salaryDesc&page=1';
    const jobicyUrl = 'https://jobicy.com/api/v2/remote-jobs?count=1';
    const himalayasStatuses = [429, 200];
    const fetchFn = vi.fn(
      asFetch((input) => {
        const url = input instanceof Request ? input.url : input.toString();
        if (url === himalayasUrl) {
          const status = himalayasStatuses.shift() ?? 500;
          return Promise.resolve(
            jsonResponse(status === 200 ? { jobs: [], totalCount: 0 } : null, status),
          );
        }
        if (url === jobicyUrl) {
          return Promise.resolve(jsonResponse({ jobs: [] }));
        }
        throw new Error(`unexpected fetch: ${url}`);
      }),
    );
    // One shared client for both sources -- the exact shape of `runGlobalRemoteDiscovery`'s
    // `Promise.all` fan-out, and the failure mode issue #279 calls out: without attribution, a
    // single pooled counter could not tell himalayas' retry from jobicy's clean first attempt.
    const http = realHttpClient({ fetchFn, maxRetries: 2, baseRetryDelayMs: 1 });

    const [himalayas, jobicy] = await Promise.all([
      discoverHimalayas(http, config({ himalayasQueries: [] })),
      discoverJobicy(http, config()),
    ]);

    expect(himalayas.sources[0]).toMatchObject({ networkAttempts: 2, retries: 1, status: 'success' });
    expect(jobicy.sources[0]).toMatchObject({ networkAttempts: 1, retries: 0, status: 'success' });
  });
});

describe('acceptance: fixture coverage for success, retries-exhausted, Retry-After honored, timeout, and empty-but-complete', () => {
  it('success: a single clean attempt is networkAttempts: 1, retries: 0, complete: true', async () => {
    const fetchFn = vi.fn(asFetch(() => Promise.resolve(jsonResponse({ jobs: [] }))));
    const http = realHttpClient({ fetchFn });

    const result = await discoverJobicy(http, config());

    expect(result.sources[0]).toMatchObject({
      status: 'success',
      networkAttempts: 1,
      retries: 0,
      complete: true,
      completenessReason: null,
    });
  });

  it('retries-exhausted: reports error/incomplete with every attempt counted, no request credited as logically successful', async () => {
    const fetchFn = vi.fn(asFetch(() => Promise.resolve(new Response(null, { status: 503 }))));
    const http = realHttpClient({ fetchFn, maxRetries: 2, baseRetryDelayMs: 1 });

    const result = await discoverJobicy(http, config());

    expect(fetchFn).toHaveBeenCalledTimes(3); // 1 initial + 2 retries
    expect(result.sources[0]).toMatchObject({
      status: 'error',
      requests: 0, // the logical fetch never resolved
      networkAttempts: 3,
      retries: 2,
      complete: false,
    });
    expect(result.sources[0]?.completenessReason).not.toBeNull();
  });

  it('Retry-After honored: the server-specified delay is used and the retry still resolves successfully', async () => {
    const statuses = [429, 200];
    const fetchFn = vi.fn(
      asFetch(() =>
        Promise.resolve(
          statuses.shift() === 429
            ? new Response(null, { status: 429, headers: { 'retry-after': '2' } })
            : jsonResponse({ jobs: [] }),
        ),
      ),
    );
    const delays: number[] = [];
    const http = realHttpClient({
      fetchFn,
      maxRetries: 1,
      timeoutMs: 5_000, // must comfortably exceed the 2s Retry-After below, or the deadline check
      // rejects the retry outright rather than sleeping for it (see http-client.test.ts's own
      // "fails with the known 429 status when Retry-After cannot fit the deadline").
      sleep: (ms) => {
        delays.push(ms);
        return Promise.resolve();
      },
    });

    const result = await discoverJobicy(http, config());

    expect(delays).toEqual([2_000]);
    expect(result.sources[0]).toMatchObject({
      status: 'success',
      networkAttempts: 2,
      retries: 1,
      complete: true,
    });
  });

  it('timeout: a hung request is reported as an incomplete, non-success source with its attempt counted', async () => {
    const fetchFn = vi.fn(asFetch(() => new Promise<Response>(() => {})));
    const http = realHttpClient({ fetchFn, timeoutMs: 20, maxRetries: 0 });

    const result = await discoverJobicy(http, config());

    expect(result.sources[0]).toMatchObject({
      status: 'error',
      networkAttempts: 1,
      retries: 0,
      complete: false,
    });
  });

  it('empty-but-complete: zero listings from a source that genuinely reached the end is complete: true, never mistaken for a stopped-early scan', async () => {
    const fetchFn = vi.fn(
      asFetch(() => Promise.resolve(jsonResponse({ jobs: [], totalCount: 0 }))),
    );
    const http = realHttpClient({ fetchFn });

    const result = await discoverHimalayas(http, config({ himalayasQueries: [] }));

    expect(result.sources[0]).toMatchObject({
      status: 'success',
      listings: 0,
      networkAttempts: 1,
      retries: 0,
      complete: true,
      completenessReason: null,
    });
  });
});

describe('discovery-attribution module', () => {
  it('recordAttributedNetworkAttempt is a no-op outside any attributed context', () => {
    expect(() => recordAttributedNetworkAttempt(0)).not.toThrow();
  });

  it('attributeNetworkRequests isolates two concurrent wrapped clients sharing one underlying client', async () => {
    let retryMeCalls = 0;
    const fetchFn = vi.fn(
      asFetch((input) => {
        const url = input instanceof Request ? input.url : input.toString();
        if (url.includes('retry-me')) {
          retryMeCalls += 1;
          return Promise.resolve(
            retryMeCalls === 1
              ? new Response(null, { status: 429, headers: { 'retry-after': '0' } })
              : new Response('ok'),
          );
        }
        return Promise.resolve(new Response('ok'));
      }),
    );
    // One retries (429 then success), the other resolves cleanly first try -- both through the same
    // underlying `SafeHttpClient` and its one `onNetworkRequest` callback, at the same time.
    let callCount = 0;
    const orderedFetch = vi.fn(
      asFetch((input) => {
        callCount += 1;
        return fetchFn(input);
      }),
    );
    const underlying = new SafeHttpClient({
      globalConcurrency: 3,
      perDomainConcurrency: 3,
      timeoutMs: 500,
      maxRetries: 2,
      userAgent: 'OpenVacancyRadar/test (+personal vacancy research)',
      resolver: publicResolver,
      fetchFn: orderedFetch,
      random: () => 0.5,
      sleep: () => Promise.resolve(),
      onNetworkRequest: (_url, meta) => recordAttributedNetworkAttempt(meta.retryIndex),
    });
    const atsClient = createAtsHttpClient(underlying);
    const countersA = newNetworkAttemptCounters();
    const countersB = newNetworkAttemptCounters();
    const clientA = attributeNetworkRequests(atsClient, countersA);
    const clientB = attributeNetworkRequests(atsClient, countersB);

    await Promise.all([
      clientA.get('https://a.example.test/retry-me'),
      clientB.get('https://b.example.test/clean'),
    ]);

    expect(countersA).toEqual({ attempts: 2, retries: 1 });
    expect(countersB).toEqual({ attempts: 1, retries: 0 });
    expect(callCount).toBe(3);
  });
});
