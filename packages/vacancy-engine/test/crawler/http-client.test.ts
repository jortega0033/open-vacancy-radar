import { describe, expect, it, vi } from 'vitest';

import { CrawlerHttpError } from '../../src/crawler/errors.js';
import { MemoryHttpCache } from '../../src/crawler/http-cache.js';
import {
  SafeHttpClient,
  type SafeHttpClientOptions,
} from '../../src/crawler/http-client.js';
import { RequestScheduler } from '../../src/crawler/scheduler.js';
import type { DnsResolver } from '../../src/crawler/url-safety.js';

const publicResolver: DnsResolver = () =>
  Promise.resolve([{ address: '93.184.216.34', family: 4 }]);

function asFetch(implementation: (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>): typeof fetch {
  return implementation;
}

function createClient(overrides: Partial<SafeHttpClientOptions> = {}): SafeHttpClient {
  return new SafeHttpClient({
    globalConcurrency: 3,
    perDomainConcurrency: 1,
    timeoutMs: 500,
    maxRetries: 2,
    userAgent: 'INDJobRadar/test (+personal vacancy research)',
    resolver: publicResolver,
    fetchFn: asFetch(() => Promise.resolve(new Response('ok'))),
    random: () => 0.5,
    ...overrides,
  });
}

describe('SafeHttpClient redirects', () => {
  it('manually revalidates a redirect target before making the next request', async () => {
    const fetchFn = vi.fn(
      asFetch(() =>
        Promise.resolve(
          new Response(null, {
            status: 302,
            headers: { location: 'http://127.0.0.1/admin?credential=secret' },
          }),
        ),
      ),
    );
    const client = createClient({ fetchFn });

    const request = client.get('https://jobs.example.com/start');
    await expect(request).rejects.toMatchObject({
      category: 'unsafe_url',
      code: 'private_address',
    });
    await expect(request).rejects.not.toThrow(/credential|secret/u);
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it('bounds redirect chains', async () => {
    const fetchFn = vi.fn(
      asFetch((input) => {
        const url = new URL(input instanceof Request ? input.url : input.toString());
        return Promise.resolve(
          new Response(null, {
            status: 302,
            headers: { location: url.pathname === '/' ? '/one' : '/two' },
          }),
        );
      }),
    );
    const client = createClient({ fetchFn, maxRedirects: 1 });

    await expect(client.get('https://jobs.example.com/')).rejects.toMatchObject({
      category: 'http_error',
      code: 'redirect_limit',
    });
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it('does not forward sensitive headers to another origin', async () => {
    const observedHeaders: Headers[] = [];
    const fetchFn = vi.fn(
      asFetch((input, init) => {
        observedHeaders.push(new Headers(init?.headers));
        const url = new URL(input instanceof Request ? input.url : input.toString());
        if (url.hostname === 'jobs.example.com') {
          return Promise.resolve(
            new Response(null, {
              status: 302,
              headers: { location: 'https://boards.example.net/jobs' },
            }),
          );
        }
        return Promise.resolve(new Response('job'));
      }),
    );
    const client = createClient({ fetchFn });

    await client.get('https://jobs.example.com', {
      headers: { authorization: 'Bearer secret', cookie: 'session=secret' },
    });
    expect(observedHeaders[0]?.get('authorization')).toBe('Bearer secret');
    expect(observedHeaders[1]?.has('authorization')).toBe(false);
    expect(observedHeaders[1]?.has('cookie')).toBe(false);
  });

  it('does not follow a redirect outside a per-request origin boundary', async () => {
    const fetchFn = vi.fn(
      asFetch(() =>
        Promise.resolve(
          new Response(null, {
            status: 302,
            headers: { location: 'https://outside.example.net/jobs' },
          }),
        ),
      ),
    );
    const client = createClient({ fetchFn });

    await expect(
      client.get('https://jobs.example.com/start', {
        allowedOrigins: ['https://jobs.example.com'],
      }),
    ).rejects.toMatchObject({
      category: 'unsafe_url',
      code: 'disallowed_redirect_origin',
    });
    expect(fetchFn).toHaveBeenCalledOnce();
  });

  it('rejects a JSON POST redirect that would change the request method', async () => {
    const fetchFn = vi.fn(
      asFetch(() =>
        Promise.resolve(
          new Response(null, {
            status: 302,
            headers: { location: '/login' },
          }),
        ),
      ),
    );
    const client = createClient({ fetchFn });

    await expect(
      client.postJson('https://jobs.example.com/query', { offset: 0 }),
    ).rejects.toMatchObject({
      category: 'http_error',
      code: 'post_redirect_not_preserved',
      status: 302,
    });
    expect(fetchFn).toHaveBeenCalledOnce();
  });
});

describe('SafeHttpClient read-only JSON POST', () => {
  it('serializes JSON, applies safety headers, retries transient failures, and bypasses GET cache', async () => {
    const cache = {
      get: vi.fn(() => Promise.resolve(undefined)),
      set: vi.fn(() => Promise.resolve()),
    };
    const attempts: RequestInit[] = [];
    const statuses = [503, 200];
    const fetchFn = vi.fn(
      asFetch((_input, init) => {
        attempts.push(init ?? {});
        return Promise.resolve(
          new Response('{"jobPostings":[]}', {
            status: statuses.shift() ?? 500,
            headers: { 'content-type': 'application/json' },
          }),
        );
      }),
    );
    const client = createClient({
      cache,
      fetchFn,
      baseRetryDelayMs: 10,
      sleep: () => Promise.resolve(),
    });
    const payload = { appliedFacets: {}, limit: 20, offset: 0, searchText: '' };

    const response = await client.postJson(
      'https://jobs.example.com/query',
      payload,
      { allowedOrigins: ['https://jobs.example.com'] },
    );

    expect(response.text()).toBe('{"jobPostings":[]}');
    expect(fetchFn).toHaveBeenCalledTimes(2);
    expect(attempts.every((attempt) => attempt.method === 'POST')).toBe(true);
    expect(attempts.every((attempt) => attempt.body === JSON.stringify(payload))).toBe(true);
    expect(new Headers(attempts[0]?.headers).get('content-type')).toBe('application/json');
    expect(new Headers(attempts[0]?.headers).get('user-agent')).toContain(
      'personal vacancy research',
    );
    expect(cache.get).not.toHaveBeenCalled();
    expect(cache.set).not.toHaveBeenCalled();
  });
});

describe('SafeHttpClient retries and status categorization', () => {
  it('owns a bounded exponential retry loop for transient 5xx responses', async () => {
    const statuses = [503, 503, 200];
    const fetchFn = vi.fn(
      asFetch(() => Promise.resolve(new Response('result', { status: statuses.shift() ?? 500 }))),
    );
    const delays: number[] = [];
    const client = createClient({
      fetchFn,
      baseRetryDelayMs: 100,
      sleep: (milliseconds) => {
        delays.push(milliseconds);
        return Promise.resolve();
      },
    });

    await expect(client.get('https://jobs.example.com/feed')).resolves.toHaveProperty('status', 200);
    expect(fetchFn).toHaveBeenCalledTimes(3);
    expect(delays).toEqual([100, 200]);
  });

  it('caps Retry-After and stops exactly at the configured retry boundary', async () => {
    const fetchFn = vi.fn(
      asFetch(() =>
        Promise.resolve(
          new Response(null, { status: 429, headers: { 'retry-after': '999999' } }),
        ),
      ),
    );
    const delays: number[] = [];
    const client = createClient({
      fetchFn,
      maxRetries: 1,
      timeoutMs: 5_000,
      maxRetryAfterMs: 4_000,
      sleep: (milliseconds) => {
        delays.push(milliseconds);
        return Promise.resolve();
      },
    });

    await expect(client.get('https://jobs.example.com/feed')).rejects.toMatchObject({
      category: 'rate_limited',
      code: 'rate_limited_status',
      status: 429,
    });
    expect(fetchFn).toHaveBeenCalledTimes(2);
    expect(delays).toEqual([4_000]);
  });

  it('does not retry a non-transient 5xx response', async () => {
    const fetchFn = vi.fn(asFetch(() => Promise.resolve(new Response(null, { status: 501 }))));
    const sleep = vi.fn(() => Promise.resolve());
    const client = createClient({ fetchFn, maxRetries: 5, sleep });

    await expect(client.get('https://jobs.example.com/feed')).rejects.toMatchObject({
      category: 'http_error',
      status: 501,
    });
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it.each([403, 406])('categorizes %i as blocked and never retries it', async (status) => {
    const fetchFn = vi.fn(asFetch(() => Promise.resolve(new Response(null, { status }))));
    const sleep = vi.fn(() => Promise.resolve());
    const client = createClient({ fetchFn, maxRetries: 5, sleep });

    const request = client.get('https://jobs.example.com/private?token=secret');
    await expect(request).rejects.toBeInstanceOf(CrawlerHttpError);
    await expect(request).rejects.toMatchObject({
      category: 'blocked',
      code: 'blocked_status',
      status,
      safeUrl: 'https://jobs.example.com/[REDACTED]?[REDACTED]',
    });
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it('applies a 429 cooldown to another queued request for the same hostname', async () => {
    const scheduler = new RequestScheduler(1, 1);
    const statuses = [429, 200];
    const delays: number[] = [];
    let now = 0;
    const fetchFn = vi.fn(
      asFetch(() =>
        Promise.resolve(
          new Response('result', {
            status: statuses.shift() ?? 500,
            headers: { 'retry-after': '1' },
          }),
        ),
      ),
    );
    const client = createClient({
      scheduler,
      fetchFn,
      timeoutMs: 20,
      queueTimeoutMs: 2_000,
      maxRetries: 0,
      now: () => now,
      sleep: (milliseconds) => {
        delays.push(milliseconds);
        now += milliseconds;
        return Promise.resolve();
      },
    });

    const [first, second] = await Promise.allSettled([
      client.get('https://jobs.example.com/first'),
      client.get('https://jobs.example.com/second'),
    ]);

    expect(first.status).toBe('rejected');
    expect(second.status).toBe('fulfilled');
    expect(delays).toContain(1_000);
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it('fails with the known 429 status when Retry-After cannot fit the deadline', async () => {
    const fetchFn = vi.fn(
      asFetch(() =>
        Promise.resolve(new Response(null, { status: 429, headers: { 'retry-after': '60' } })),
      ),
    );
    const sleep = vi.fn(() => Promise.resolve());
    const client = createClient({ fetchFn, sleep, timeoutMs: 15_000, maxRetries: 2 });

    await expect(client.get('https://rate.example/feed')).rejects.toMatchObject({
      category: 'rate_limited',
      code: 'rate_limited_status',
      status: 429,
    });
    expect(fetchFn).toHaveBeenCalledOnce();
    expect(sleep).not.toHaveBeenCalled();
  });

  it('honors Retry-After beyond one network-attempt timeout when it fits the overall budget', async () => {
    let now = 0;
    const delays: number[] = [];
    const statuses = [429, 200];
    const fetchFn = vi.fn(
      asFetch(() =>
        Promise.resolve(
          new Response('result', {
            status: statuses.shift() ?? 500,
            headers: { 'retry-after': '1' },
          }),
        ),
      ),
    );
    const client = createClient({
      fetchFn,
      timeoutMs: 20,
      queueTimeoutMs: 2_000,
      maxRetries: 1,
      now: () => now,
      sleep: (milliseconds) => {
        delays.push(milliseconds);
        now += milliseconds;
        return Promise.resolve();
      },
    });

    await expect(client.get('https://rate.example/feed')).resolves.toHaveProperty('status', 200);
    expect(delays).toEqual([1_000]);
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it('does not let one host cooldown consume global capacity for a healthy host', async () => {
    const scheduler = new RequestScheduler(1, 1);
    let now = 0;
    let releaseCooldown: (() => void) | undefined;
    const sleep = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          releaseCooldown = () => {
            now = 1_000;
            resolve();
          };
        }),
    );
    const fetchFn = vi.fn(
      asFetch((input) => {
        const hostname = new URL(input instanceof Request ? input.url : input.toString()).hostname;
        return Promise.resolve(
          hostname === 'rate.example'
            ? new Response(null, { status: 429, headers: { 'retry-after': '1' } })
            : new Response('healthy'),
        );
      }),
    );
    const client = createClient({
      scheduler,
      fetchFn,
      sleep,
      now: () => now,
      timeoutMs: 5_000,
      maxRetries: 0,
    });

    const first = client.get('https://rate.example/first');
    const second = client.get('https://rate.example/second');
    const healthy = client.get('https://healthy.example/feed');

    await expect(first).rejects.toMatchObject({ status: 429 });
    await expect(healthy).resolves.toMatchObject({ status: 200 });
    expect(releaseCooldown).toBeTypeOf('function');
    releaseCooldown?.();
    await expect(second).rejects.toMatchObject({ status: 429 });
    expect(
      fetchFn.mock.calls.some(([input]) => {
        const rawUrl =
          input instanceof Request
            ? input.url
            : typeof input === 'string'
              ? input
              : input.href;
        return new URL(rawUrl).hostname === 'healthy.example';
      }),
    ).toBe(true);
  });

  it('shares an explicit 503 Retry-After cooldown with the same hostname', async () => {
    const scheduler = new RequestScheduler(1, 1);
    let now = 0;
    const delays: number[] = [];
    const statuses = [503, 200];
    const client = createClient({
      scheduler,
      timeoutMs: 5_000,
      maxRetries: 0,
      now: () => now,
      sleep: (milliseconds) => {
        delays.push(milliseconds);
        now += milliseconds;
        return Promise.resolve();
      },
      fetchFn: asFetch(() =>
        Promise.resolve(
          new Response('result', {
            status: statuses.shift() ?? 500,
            headers: { 'retry-after': '1' },
          }),
        ),
      ),
    });

    const [first, second] = await Promise.allSettled([
      client.get('https://jobs.example.com/first'),
      client.get('https://jobs.example.com/second'),
    ]);

    expect(first).toMatchObject({ status: 'rejected' });
    expect(second).toMatchObject({ status: 'fulfilled' });
    expect(delays).toContain(1_000);
  });
});

describe('SafeHttpClient resource bounds and caching', () => {
  it('continues uncached when a cache read never settles', async () => {
    const fetchFn = vi.fn(asFetch(() => Promise.resolve(new Response('network'))));
    const onCacheError = vi.fn();
    const client = createClient({
      fetchFn,
      cacheTimeoutMs: 20,
      cache: {
        get: () => new Promise(() => undefined),
        set: () => Promise.resolve(),
      },
      onCacheError,
    });

    await expect(client.get('https://jobs.example.com/feed')).resolves.toHaveProperty(
      'fromCache',
      false,
    );
    expect(fetchFn).toHaveBeenCalledOnce();
    expect(onCacheError).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'CacheTimeoutError' }),
      'get',
      expect.any(String),
    );
  });

  it('returns the network response when a cache write never settles', async () => {
    const onCacheError = vi.fn();
    const client = createClient({
      cacheTimeoutMs: 20,
      cache: {
        get: () => Promise.resolve(undefined),
        set: () => new Promise(() => undefined),
      },
      onCacheError,
    });

    await expect(client.get('https://jobs.example.com/feed')).resolves.toHaveProperty(
      'status',
      200,
    );
    expect(onCacheError).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'CacheTimeoutError' }),
      'set',
      expect.any(String),
    );
  });

  it('applies the request timeout to initial DNS resolution', async () => {
    const resolver: DnsResolver = () => new Promise(() => undefined);
    const fetchFn = vi.fn(asFetch(() => Promise.resolve(new Response('unexpected'))));
    const client = createClient({ resolver, fetchFn, timeoutMs: 20, maxRetries: 0 });

    await expect(client.get('https://jobs.example.com/stuck-dns')).rejects.toMatchObject({
      category: 'timeout',
      code: 'request_timeout',
    });
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('applies the same overall deadline to redirect DNS resolution', async () => {
    let resolutions = 0;
    const resolver: DnsResolver = () => {
      resolutions += 1;
      return resolutions === 1
        ? Promise.resolve([{ address: '93.184.216.34', family: 4 }])
        : new Promise(() => undefined);
    };
    const fetchFn = vi.fn(
      asFetch(() =>
        Promise.resolve(
          new Response(null, {
            status: 302,
            headers: { location: 'https://redirect.example.net/jobs' },
          }),
        ),
      ),
    );
    const client = createClient({ resolver, fetchFn, timeoutMs: 20, maxRetries: 0 });

    await expect(client.get('https://jobs.example.com/start')).rejects.toMatchObject({
      category: 'timeout',
      code: 'request_timeout',
    });
    expect(fetchFn).toHaveBeenCalledOnce();
  });

  it('releases the scheduler slot after a timeout', async () => {
    const scheduler = new RequestScheduler(1, 1);
    const fetchFn = vi.fn(
      asFetch((input) => {
        const url = new URL(input instanceof Request ? input.url : input.toString());
        if (url.pathname === '/stuck') return new Promise<Response>(() => undefined);
        return Promise.resolve(new Response('next'));
      }),
    );
    const client = createClient({ scheduler, fetchFn, timeoutMs: 20, maxRetries: 0 });

    await expect(client.get('https://jobs.example.com/stuck')).rejects.toMatchObject({
      category: 'timeout',
      code: 'request_timeout',
    });
    const next = client.get('https://jobs.example.com/next');
    await expect(next).resolves.toHaveProperty('status', 200);
    expect(fetchFn).toHaveBeenCalledTimes(2);
    expect(scheduler.snapshot()).toMatchObject({ activeGlobal: 0, queued: 0 });
  });

  it('times out while queued and never fetches after the expired task is released', async () => {
    const scheduler = new RequestScheduler(1, 1);
    let releaseHolder: (() => void) | undefined;
    const holder = scheduler.run(
      'jobs.example.com',
      () => new Promise<void>((resolve) => (releaseHolder = resolve)),
    );
    const fetchFn = vi.fn(asFetch(() => Promise.resolve(new Response('unexpected'))));
    const client = createClient({ scheduler, fetchFn, timeoutMs: 10, maxRetries: 0 });

    await expect(client.get('https://jobs.example.com/queued')).rejects.toMatchObject({
      category: 'timeout',
      code: 'request_timeout',
    });
    expect(fetchFn).not.toHaveBeenCalled();
    releaseHolder?.();
    await holder;
    await vi.waitFor(() => expect(scheduler.snapshot().queued).toBe(0));
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('uses validators and reuses the cached body after 304', async () => {
    const cache = new MemoryHttpCache();
    const seenHeaders: Headers[] = [];
    let call = 0;
    const fetchFn = vi.fn(
      asFetch((_input, init) => {
        seenHeaders.push(new Headers(init?.headers));
        call += 1;
        if (call === 1) {
          return Promise.resolve(
            new Response('{"jobs":[1]}', {
              headers: {
                etag: '"jobs-v1"',
                'last-modified': 'Fri, 28 Aug 2026 08:00:00 GMT',
                'content-type': 'application/json',
              },
            }),
          );
        }
        return Promise.resolve(
          new Response(null, { status: 304, headers: { etag: '"jobs-v1"' } }),
        );
      }),
    );
    const client = createClient({ cache, fetchFn });

    const first = await client.get('https://jobs.example.com/feed');
    const second = await client.get('https://jobs.example.com/feed');

    expect(first.fromCache).toBe(false);
    expect(second).toMatchObject({ status: 200, fromCache: true, revalidated: true });
    expect(second.text()).toBe('{"jobs":[1]}');
    expect(seenHeaders[1]?.get('if-none-match')).toBe('"jobs-v1"');
    expect(seenHeaders[1]?.get('if-modified-since')).toBe('Fri, 28 Aug 2026 08:00:00 GMT');
    expect(seenHeaders[0]?.get('user-agent')).toContain('personal vacancy research');
  });

  it('rejects a declared response larger than the configured bound', async () => {
    const fetchFn = vi.fn(
      asFetch(() =>
        Promise.resolve(
          new Response('small', { headers: { 'content-length': '1000000' } }),
        ),
      ),
    );
    const client = createClient({ fetchFn, maxResponseBytes: 100 });

    await expect(client.get('https://jobs.example.com/feed')).rejects.toMatchObject({
      category: 'http_error',
      code: 'response_too_large',
    });
  });

  it('stops streaming when an undeclared body crosses the configured bound', async () => {
    const fetchFn = vi.fn(
      asFetch(() => Promise.resolve(new Response('x'.repeat(101)))),
    );
    const client = createClient({ fetchFn, maxResponseBytes: 100 });

    await expect(client.get('https://jobs.example.com/feed')).rejects.toMatchObject({
      category: 'http_error',
      code: 'response_too_large',
    });
  });
});
