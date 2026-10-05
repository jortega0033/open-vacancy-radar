import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { AtsHttpClient, AtsHttpResponse } from '../../src/ats/http.js';
import type { AtsRosterEntry } from '../../src/companies/ats-roster-source.js';
import { CrawlerHttpError } from '../../src/crawler/errors.js';
import { loadAtsSourceObservations } from '../../src/companies/ats-source-observation-repository.js';
import {
  resolveAtsSourceScoutLimits,
  runAtsSourceScout,
  scoutExplorationQuota,
} from '../../src/global-remote/ats-source-scout.js';

let projectRoot: string;

beforeEach(async () => {
  projectRoot = await mkdtemp(join(tmpdir(), 'ats-source-scout-'));
});

afterEach(async () => {
  await rm(projectRoot, { recursive: true, force: true });
});

function entry(slug: string): AtsRosterEntry {
  return { provider: 'greenhouse', slug, baseUrl: 'https://job-boards.greenhouse.io', company: `${slug} Inc` };
}

function roster(count: number): AtsRosterEntry[] {
  return Array.from({ length: count }, (_, index) => entry(`tenant-${String(index).padStart(3, '0')}`));
}

type Behavior = 'jobs' | 'empty' | Error;

/** Fake ATS client: never touches the network; behavior is chosen per tenant slug. */
class FakeAts implements AtsHttpClient {
  public readonly requested: string[] = [];
  public onRequest: (() => void) | undefined;
  public constructor(private readonly behaviors: Record<string, Behavior> = {}) {}

  public async get(url: string): Promise<AtsHttpResponse> {
    const slug = /boards\/([^/]+)\/jobs/u.exec(url)?.[1];
    if (slug === undefined) throw new Error(`unexpected url ${url}`);
    this.requested.push(slug);
    this.onRequest?.();
    const behavior = this.behaviors[slug] ?? 'jobs';
    if (behavior instanceof Error) throw behavior;
    const jobs =
      behavior === 'empty'
        ? []
        : [
            {
              id: 1,
              title: 'Frontend Engineer',
              absolute_url: `https://job-boards.greenhouse.io/${slug}/jobs/1`,
              content: '<p>Build things.</p>',
              location: { name: 'Amsterdam, Netherlands' },
            },
          ];
    return { status: 200, finalUrl: url, headers: {}, body: JSON.stringify({ jobs }) };
  }

  public async postJson(): Promise<AtsHttpResponse> {
    throw new Error('unexpected POST');
  }
}

function clock(startIso = '2026-10-05T10:00:00.000Z') {
  let current = Date.parse(startIso);
  return {
    now: () => new Date(current),
    advance: (ms: number) => {
      current += ms;
    },
  };
}

describe('resolveAtsSourceScoutLimits', () => {
  it('clamps every bound into a safe range and keeps the exploration quota above zero', () => {
    expect(resolveAtsSourceScoutLimits({ maxSources: 0, maxRequests: -5, concurrency: 99, maxDurationMs: 1 })).toEqual({
      maxSources: 1,
      maxRequests: 1,
      concurrency: 8,
      maxDurationMs: 1_000,
    });
    expect(scoutExplorationQuota(1)).toBe(1);
    expect(scoutExplorationQuota(2)).toBe(1);
    expect(scoutExplorationQuota(40)).toBe(10);
  });
});

describe('runAtsSourceScout', () => {
  it('refuses to run without a role or keyword, before any request', async () => {
    const http = new FakeAts();
    await expect(
      runAtsSourceScout({ http, roster: roster(3), projectRoot, roleQuery: '   ' }),
    ).rejects.toThrow('role or keyword');
    expect(http.requested).toEqual([]);
  });

  it('bounds one run by the source limit and advances the durable exploration cursor', async () => {
    const http = new FakeAts();
    const result = await runAtsSourceScout({
      http,
      roster: roster(20),
      projectRoot,
      roleQuery: 'frontend',
      limits: { maxSources: 5 },
    });
    expect(result.counters).toMatchObject({ attempted: 5, explored: 5, refreshed: 0, newlyVerified: 5, skipped: 0 });
    expect(result.stoppedBecause).toBe('finished');
    expect(http.requested).toHaveLength(5);
    const stored = await loadAtsSourceObservations(projectRoot);
    expect(stored.observations).toHaveLength(5);
    expect(stored.cursor.nextIndex).toBe(scoutExplorationQuota(5));
    expect(result.dueRemaining).toBe(15);
  });

  it('resumes after a restart without repeating the completed batch', async () => {
    const all = roster(12);
    const first = new FakeAts();
    await runAtsSourceScout({ http: first, roster: all, projectRoot, roleQuery: 'frontend', limits: { maxSources: 4 } });
    // A fresh call stands in for a restarted process: all state comes back from disk.
    const second = new FakeAts();
    await runAtsSourceScout({ http: second, roster: all, projectRoot, roleQuery: 'frontend', limits: { maxSources: 4 } });
    expect(second.requested.filter((slug) => first.requested.includes(slug))).toEqual([]);
    expect((await loadAtsSourceObservations(projectRoot)).observations).toHaveLength(8);
  });

  it('keeps completed sources when a run is cut short mid-batch and does not redo them', async () => {
    const all = roster(8);
    const controller = new AbortController();
    const interrupted = new FakeAts();
    let seen = 0;
    interrupted.onRequest = () => {
      seen += 1;
      if (seen === 3) controller.abort();
    };
    const partial = await runAtsSourceScout({
      http: interrupted,
      roster: all,
      projectRoot,
      roleQuery: 'frontend',
      limits: { maxSources: 8, concurrency: 1 },
      signal: controller.signal,
    });
    expect(partial.stoppedBecause).toBe('cancelled');
    expect(partial.counters.attempted).toBe(3);
    const resumed = new FakeAts();
    await runAtsSourceScout({ http: resumed, roster: all, projectRoot, roleQuery: 'frontend', limits: { maxSources: 8 } });
    expect(resumed.requested.filter((slug) => interrupted.requested.slice(0, 3).includes(slug))).toEqual([]);
  });

  it('stops at the request budget and never exceeds it', async () => {
    const http = new FakeAts();
    const result = await runAtsSourceScout({
      http,
      roster: roster(30),
      projectRoot,
      roleQuery: 'frontend',
      limits: { maxSources: 30, maxRequests: 4, concurrency: 3 },
    });
    expect(http.requested.length).toBeLessThanOrEqual(4);
    expect(result.requestsUsed).toBeLessThanOrEqual(4);
    expect(result.stoppedBecause).toBe('requests');
    expect(result.counters.skipped).toBeGreaterThan(0);
  });

  it('stops at the wall-clock limit using the injected clock', async () => {
    const time = clock();
    const http = new FakeAts();
    http.onRequest = () => time.advance(40_000);
    const result = await runAtsSourceScout({
      http,
      roster: roster(30),
      projectRoot,
      roleQuery: 'frontend',
      limits: { maxSources: 30, concurrency: 1, maxDurationMs: 100_000 },
      now: time.now,
    });
    expect(result.stoppedBecause).toBe('duration');
    expect(result.counters.attempted).toBe(3);
  });

  it('isolates a failing source and records the rest', async () => {
    const http = new FakeAts({
      'tenant-001': new Error('Greenhouse: HTTP 500'),
      'tenant-002': 'empty',
    });
    const result = await runAtsSourceScout({
      http,
      roster: roster(5),
      projectRoot,
      roleQuery: 'frontend',
      limits: { maxSources: 5, concurrency: 1 },
    });
    expect(result.counters).toMatchObject({ attempted: 5, newlyVerified: 3, empty: 1, failed: 1, blocked: 0 });
    const stored = await loadAtsSourceObservations(projectRoot);
    expect(stored.observations.find((item) => item.slug === 'tenant-001')?.status).toBe('error');
  });

  it('counts blocked sources apart from other failures', async () => {
    const http = new FakeAts({ 'tenant-000': new Error('Greenhouse: HTTP 403') });
    const result = await runAtsSourceScout({
      http,
      roster: roster(2),
      projectRoot,
      roleQuery: 'frontend',
      limits: { maxSources: 2, concurrency: 1 },
    });
    expect(result.counters).toMatchObject({ blocked: 1, failed: 0, attempted: 2 });
  });

  it('honors Retry-After and backs off more after repeated failures', async () => {
    const time = clock();
    const rateLimited = new CrawlerHttpError({
      category: 'rate_limited',
      code: 'rate_limited_status',
      url: 'https://boards-api.greenhouse.io/v1/boards/tenant-000/jobs',
      detail: 'HTTP 429',
      status: 429,
      retryAfterMs: 3 * 24 * 60 * 60 * 1_000,
    });
    const single = [entry('tenant-000')];
    await runAtsSourceScout({
      http: new FakeAts({ 'tenant-000': rateLimited }),
      roster: single,
      projectRoot,
      roleQuery: 'frontend',
      now: time.now,
    });
    const afterRetryAfter = (await loadAtsSourceObservations(projectRoot)).observations[0]!;
    expect(afterRetryAfter.errorCategory).toBe('rate_limited');
    expect(Date.parse(afterRetryAfter.nextDueAt) - time.now().valueOf()).toBe(3 * 24 * 60 * 60 * 1_000);

    // Recently checked: nothing is retried before nextDueAt.
    time.advance(60 * 60 * 1_000);
    const early = new FakeAts();
    const idle = await runAtsSourceScout({ http: early, roster: single, projectRoot, roleQuery: 'frontend', now: time.now });
    expect(early.requested).toEqual([]);
    expect(idle.stoppedBecause).toBe('nothing_due');
    expect(idle.earliestNextDueAt).toBe(afterRetryAfter.nextDueAt);

    // Plain repeated failures (no Retry-After) wait longer each time.
    const gaps: number[] = [];
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const failing = new Error('Greenhouse: HTTP 500');
      const other = [entry('tenant-007')];
      await runAtsSourceScout({
        http: new FakeAts({ 'tenant-007': failing }),
        roster: other,
        projectRoot,
        roleQuery: 'frontend',
        now: time.now,
      });
      const saved = (await loadAtsSourceObservations(projectRoot)).observations.find((item) => item.slug === 'tenant-007')!;
      gaps.push(Date.parse(saved.nextDueAt) - time.now().valueOf());
      time.advance(Date.parse(saved.nextDueAt) - time.now().valueOf());
    }
    expect(gaps[1]).toBeGreaterThan(gaps[0]!);
    expect(gaps[2]).toBeGreaterThan(gaps[1]!);
  });

  it('reserves a non-zero exploration quota while matching sources are also due', async () => {
    const time = clock();
    const all = roster(30);
    await runAtsSourceScout({
      http: new FakeAts(),
      roster: all,
      projectRoot,
      roleQuery: 'frontend',
      limits: { maxSources: 10 },
      now: time.now,
    });
    // A day later the verified Amsterdam frontend sources are due again, and unseen ones remain.
    time.advance(25 * 60 * 60 * 1_000);
    const http = new FakeAts();
    const result = await runAtsSourceScout({
      http,
      roster: all,
      projectRoot,
      roleQuery: 'frontend',
      limits: { maxSources: 10 },
      now: time.now,
    });
    expect(result.counters.refreshed).toBeGreaterThan(0);
    expect(result.counters.explored).toBeGreaterThanOrEqual(scoutExplorationQuota(10));
  });
});
