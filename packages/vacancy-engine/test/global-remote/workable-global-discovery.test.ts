import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { CrawlerHttpError } from '../../src/crawler/errors.js';
import type { SafeHttpClient } from '../../src/crawler/http-client.js';
import {
  loadWorkableFeedSnapshot,
  WORKABLE_ALL_CUSTOMER_FEED_URL,
  writeWorkableFeedSnapshot,
} from '../../src/global-remote/workable-feed.js';
import {
  runWorkableGlobalDiscovery,
  WORKABLE_GLOBAL_MAX_RESPONSE_BYTES,
  WORKABLE_GLOBAL_TIMEOUT_MS,
} from '../../src/global-remote/workable-global-discovery.js';

const fixturePath = path.resolve(
  import.meta.dirname,
  '../fixtures/global-remote/workable-feed/valid.xml',
);
const truncatedFixturePath = path.resolve(
  import.meta.dirname,
  '../fixtures/global-remote/workable-feed/truncated.xml',
);
const encoder = new TextEncoder();
const temporaryDirectories: string[] = [];

async function temporarySnapshot(): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), 'ovr-workable-global-'));
  temporaryDirectories.push(directory);
  return path.join(directory, 'snapshot.json');
}

async function fixture(name: 'valid' | 'truncated'): Promise<Uint8Array> {
  const filePath = name === 'valid' ? fixturePath : truncatedFixturePath;
  return encoder.encode(await readFile(filePath, 'utf8'));
}

function response(status: number, headers: Readonly<Record<string, string>>, bytesRead: number) {
  return {
    requestedUrl: WORKABLE_ALL_CUSTOMER_FEED_URL,
    url: WORKABLE_ALL_CUSTOMER_FEED_URL,
    status,
    headers,
    bytesRead,
  };
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true })),
  );
});

describe('Workable global discovery', () => {
  it('streams official rows into user-visible discovery and reuses a fresh compact snapshot', async () => {
    const xml = await fixture('valid');
    const snapshotPath = await temporarySnapshot();
    const streamGet = vi.fn(async (_url, options) => {
      for (let offset = 0; offset < xml.length; offset += 17) {
        await options.onChunk(xml.slice(offset, offset + 17), new AbortController().signal);
      }
      return response(
        200,
        {
          'content-type': 'application/xml',
          etag: 'W/"feed-v1"',
        },
        xml.length,
      );
    }) satisfies SafeHttpClient['streamGet'];
    const client = { streamGet };
    let now = new Date('2026-08-30T10:00:00.000Z');

    const first = await runWorkableGlobalDiscovery(
      client,
      { minimumAnnualBaseUsd: 100_000 },
      process.cwd(),
      { snapshotPath, now: () => now },
    );

    expect(first.sources).toEqual([
      expect.objectContaining({
        provider: 'workable_global',
        requests: 1,
        listings: 1,
        status: 'success',
      }),
    ]);
    expect(first.vacancies).toEqual([
      expect.objectContaining({
        key: 'workable_global:FRONT123456',
        provider: 'workable_global',
        company: 'Example & Interfaces',
        title: 'Senior Frontend Engineer – Café ☕',
        url: 'https://apply.workable.com/j/FRONT123456',
        location: 'Remote, Amsterdam, Noord-Holland, Netherlands, 1012',
      }),
    ]);
    const requestOptions = streamGet.mock.calls[0]?.[1];
    expect(requestOptions?.allowedOrigins).toEqual(['https://www.workable.com']);
    expect(requestOptions?.timeoutMs).toBe(WORKABLE_GLOBAL_TIMEOUT_MS);
    expect(requestOptions?.maxResponseBytes).toBe(WORKABLE_GLOBAL_MAX_RESPONSE_BYTES);
    expect(requestOptions?.maxRetries).toBe(0);
    expect(new Headers(requestOptions?.headers).has('range')).toBe(false);

    now = new Date('2026-08-30T10:30:00.000Z');
    const cached = await runWorkableGlobalDiscovery(
      client,
      { minimumAnnualBaseUsd: 100_000 },
      process.cwd(),
      { snapshotPath, now: () => now },
    );
    expect(cached.sources[0]).toMatchObject({ requests: 0, listings: 1, status: 'success' });
    expect(cached.vacancies).toEqual(first.vacancies);
    expect(streamGet).toHaveBeenCalledOnce();
  });

  it('uses ETag validation after one hour and atomically refreshes 304 cadence', async () => {
    const xml = await fixture('valid');
    const snapshotPath = await temporarySnapshot();
    let call = 0;
    const streamGet = vi.fn(async (_url, options) => {
      call += 1;
      if (call === 1) {
        await options.onChunk(xml, new AbortController().signal);
        return response(200, { 'content-type': 'application/xml', etag: '"feed-v1"' }, xml.length);
      }
      expect(new Headers(options.headers).get('if-none-match')).toBe('"feed-v1"');
      return response(304, { etag: '"feed-v1"' }, 0);
    }) satisfies SafeHttpClient['streamGet'];
    const client = { streamGet };
    let now = new Date('2026-08-30T10:00:00.000Z');

    await runWorkableGlobalDiscovery(client, { minimumAnnualBaseUsd: 100_000 }, process.cwd(), {
      snapshotPath,
      now: () => now,
    });
    now = new Date('2026-08-30T11:01:00.000Z');
    const revalidated = await runWorkableGlobalDiscovery(
      client,
      { minimumAnnualBaseUsd: 100_000 },
      process.cwd(),
      { snapshotPath, now: () => now },
    );

    expect(revalidated.sources[0]).toMatchObject({ requests: 1, listings: 1, status: 'success' });
    expect(await loadWorkableFeedSnapshot(snapshotPath)).toMatchObject({
      fetchedAt: '2026-08-30T11:01:00.000Z',
      etag: '"feed-v1"',
    });
    now = new Date('2026-08-30T11:30:00.000Z');
    await runWorkableGlobalDiscovery(client, { minimumAnnualBaseUsd: 100_000 }, process.cwd(), {
      snapshotPath,
      now: () => now,
    });
    expect(streamGet).toHaveBeenCalledTimes(2);
  });

  it('keeps the prior complete snapshot when a later feed is malformed', async () => {
    const valid = await fixture('valid');
    const truncated = await fixture('truncated');
    const snapshotPath = await temporarySnapshot();
    let call = 0;
    const streamGet = vi.fn(async (_url, options) => {
      call += 1;
      const body = call === 1 ? valid : truncated;
      await options.onChunk(body, new AbortController().signal);
      return response(
        200,
        {
          'content-type': 'application/xml',
          etag: call === 1 ? '"stable"' : '"broken"',
        },
        body.length,
      );
    }) satisfies SafeHttpClient['streamGet'];
    const client = { streamGet };
    let now = new Date('2026-08-30T10:00:00.000Z');

    await runWorkableGlobalDiscovery(client, { minimumAnnualBaseUsd: 100_000 }, process.cwd(), {
      snapshotPath,
      now: () => now,
    });
    now = new Date('2026-08-30T11:01:00.000Z');
    const fallback = await runWorkableGlobalDiscovery(
      client,
      { minimumAnnualBaseUsd: 100_000 },
      process.cwd(),
      { snapshotPath, now: () => now },
    );

    expect(fallback.sources[0]).toMatchObject({ requests: 1, listings: 1, status: 'partial' });
    expect(fallback.sources[0]?.error).toContain('stale parsed snapshot reused');
    expect(fallback.vacancies).toHaveLength(1);
    expect(await loadWorkableFeedSnapshot(snapshotPath)).toMatchObject({
      fetchedAt: '2026-08-30T10:00:00.000Z',
      etag: '"stable"',
    });
  });

  it('withholds cached vacancies after an HTTP 451 legal access block', async () => {
    const valid = await fixture('valid');
    const snapshotPath = await temporarySnapshot();
    let call = 0;
    const streamGet = vi.fn(async (_url, options) => {
      call += 1;
      if (call === 1) {
        await options.onChunk(valid, new AbortController().signal);
        return response(200, { 'content-type': 'application/xml', etag: '"stable"' }, valid.length);
      }
      throw new CrawlerHttpError({
        category: 'blocked',
        code: 'blocked_status',
        url: WORKABLE_ALL_CUSTOMER_FEED_URL,
        detail: 'Unavailable for legal reasons',
        status: 451,
      });
    }) satisfies SafeHttpClient['streamGet'];
    let now = new Date('2026-08-30T10:00:00.000Z');

    await runWorkableGlobalDiscovery(
      { streamGet },
      { minimumAnnualBaseUsd: 100_000 },
      process.cwd(),
      { snapshotPath, now: () => now },
    );
    now = new Date('2026-08-30T11:01:00.000Z');
    const blocked = await runWorkableGlobalDiscovery(
      { streamGet },
      { minimumAnnualBaseUsd: 100_000 },
      process.cwd(),
      { snapshotPath, now: () => now },
    );

    expect(blocked.sources[0]).toMatchObject({ status: 'blocked', listings: 0 });
    expect(blocked.sources[0]?.error).toContain('stale vacancies withheld');
    expect(blocked.vacancies).toEqual([]);

    now = new Date('2026-08-30T11:30:00.000Z');
    const guarded = await runWorkableGlobalDiscovery(
      { streamGet },
      { minimumAnnualBaseUsd: 100_000 },
      process.cwd(),
      { snapshotPath, now: () => now },
    );
    expect(guarded.sources[0]).toMatchObject({ requests: 0, status: 'blocked', listings: 0 });
    expect(guarded.vacancies).toEqual([]);
    expect(streamGet).toHaveBeenCalledTimes(2);
    expect(await loadWorkableFeedSnapshot(snapshotPath)).toMatchObject({ etag: '"stable"' });
  });

  it('keeps the prior snapshot when a well-formed replacement is implausibly small', async () => {
    const valid = await fixture('valid');
    const snapshotPath = await temporarySnapshot();
    const streamGet = vi.fn(async (_url, options) => {
      await options.onChunk(valid, new AbortController().signal);
      return response(200, { 'content-type': 'application/xml', etag: '"smaller"' }, valid.length);
    }) satisfies SafeHttpClient['streamGet'];
    const firstClient = {
      streamGet: vi.fn(async (_url, options) => {
        await options.onChunk(valid, new AbortController().signal);
        return response(200, { 'content-type': 'application/xml', etag: '"stable"' }, valid.length);
      }) satisfies SafeHttpClient['streamGet'],
    };

    await runWorkableGlobalDiscovery(
      firstClient,
      { minimumAnnualBaseUsd: 100_000 },
      process.cwd(),
      { snapshotPath, now: () => new Date('2026-08-30T10:00:00.000Z') },
    );
    const previous = await loadWorkableFeedSnapshot(snapshotPath);
    expect(previous).not.toBeNull();
    if (previous === null) throw new Error('expected initial snapshot');
    await writeWorkableFeedSnapshot(snapshotPath, {
      etag: '"stable"',
      fetchedAt: new Date('2026-08-30T10:00:00.000Z'),
      result: { ...previous.result, totalJobs: 5, filteredJobs: 4 },
    });

    const fallback = await runWorkableGlobalDiscovery(
      { streamGet },
      { minimumAnnualBaseUsd: 100_000 },
      process.cwd(),
      { snapshotPath, now: () => new Date('2026-08-30T11:01:00.000Z') },
    );

    expect(fallback.sources[0]).toMatchObject({ status: 'partial', listings: 1 });
    expect(fallback.sources[0]?.error).toContain('shrank from 5 to 2 jobs');
    expect(await loadWorkableFeedSnapshot(snapshotPath)).toMatchObject({
      etag: '"stable"',
      result: { totalJobs: 5 },
    });

    const converged = await runWorkableGlobalDiscovery(
      { streamGet },
      { minimumAnnualBaseUsd: 100_000 },
      process.cwd(),
      { snapshotPath, now: () => new Date('2026-08-31T11:01:00.000Z') },
    );
    expect(converged.sources[0]).toMatchObject({ status: 'success', listings: 1 });
    expect(await loadWorkableFeedSnapshot(snapshotPath)).toMatchObject({
      etag: '"smaller"',
      result: { totalJobs: 2 },
    });
  });

  it('rejects a well-formed empty initial feed instead of caching data loss', async () => {
    const xml = encoder.encode(
      '<?xml version="1.0"?><source><publisher>Workable</publisher><publisherurl>https://www.workable.com</publisherurl></source>',
    );
    const snapshotPath = await temporarySnapshot();
    const streamGet = vi.fn(async (_url, options) => {
      await options.onChunk(xml, new AbortController().signal);
      return response(200, { 'content-type': 'application/xml' }, xml.length);
    }) satisfies SafeHttpClient['streamGet'];

    const result = await runWorkableGlobalDiscovery(
      { streamGet },
      { minimumAnnualBaseUsd: 100_000 },
      process.cwd(),
      { snapshotPath, now: () => new Date('2026-08-30T10:00:00.000Z') },
    );

    expect(result.sources[0]).toMatchObject({ status: 'error', listings: 0 });
    expect(result.sources[0]?.error).toContain('contained no jobs');
    await expect(loadWorkableFeedSnapshot(snapshotPath)).resolves.toBeNull();
  });

  it('isolates blocked access when no snapshot exists', async () => {
    const snapshotPath = await temporarySnapshot();
    let now = new Date('2026-08-30T10:00:00.000Z');
    const streamGet = vi.fn(() =>
      Promise.reject(
        new CrawlerHttpError({
          category: 'blocked',
          code: 'blocked_status',
          url: WORKABLE_ALL_CUSTOMER_FEED_URL,
          detail: 'Remote server blocked or requires access',
          status: 403,
        }),
      ),
    ) satisfies SafeHttpClient['streamGet'];

    const result = await runWorkableGlobalDiscovery(
      { streamGet },
      { minimumAnnualBaseUsd: 100_000 },
      process.cwd(),
      { snapshotPath, now: () => now },
    );

    expect(result).toEqual({
      sources: [
        expect.objectContaining({
          provider: 'workable_global',
          status: 'blocked',
          listings: 0,
        }),
      ],
      vacancies: [],
    });

    now = new Date('2026-08-30T10:30:00.000Z');
    const guarded = await runWorkableGlobalDiscovery(
      { streamGet },
      { minimumAnnualBaseUsd: 100_000 },
      process.cwd(),
      { snapshotPath, now: () => now },
    );
    expect(guarded.sources[0]).toMatchObject({ requests: 0, status: 'blocked', listings: 0 });
    expect(guarded.sources[0]?.error).toContain('retry deferred until');
    expect(streamGet).toHaveBeenCalledOnce();
  });

  it('persists a server Retry-After longer than the hourly minimum', async () => {
    const snapshotPath = await temporarySnapshot();
    let now = new Date('2026-08-30T10:00:00.000Z');
    const streamGet = vi.fn(() =>
      Promise.reject(
        new CrawlerHttpError({
          category: 'rate_limited',
          code: 'rate_limited_status',
          url: WORKABLE_ALL_CUSTOMER_FEED_URL,
          detail: 'Rate limited',
          status: 429,
          retryAfterMs: 3 * 24 * 60 * 60 * 1_000,
        }),
      ),
    ) satisfies SafeHttpClient['streamGet'];

    await runWorkableGlobalDiscovery(
      { streamGet },
      { minimumAnnualBaseUsd: 100_000 },
      process.cwd(),
      { snapshotPath, now: () => now },
    );
    now = new Date('2026-08-31T11:00:00.000Z');
    const guarded = await runWorkableGlobalDiscovery(
      { streamGet },
      { minimumAnnualBaseUsd: 100_000 },
      process.cwd(),
      { snapshotPath, now: () => now },
    );

    expect(guarded.sources[0]).toMatchObject({ requests: 0, listings: 0 });
    expect(guarded.sources[0]?.error).toContain('2026-09-02T10:00:00.000Z');
    expect(streamGet).toHaveBeenCalledOnce();
  });
});
