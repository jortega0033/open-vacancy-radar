import { AsyncLocalStorage } from 'node:async_hooks';

import { describe, expect, it, vi } from 'vitest';

import { RequestScheduler } from '../../src/crawler/scheduler.js';

describe('RequestScheduler', () => {
  it('enforces global and per-domain concurrency without blocking other domains', async () => {
    const scheduler = new RequestScheduler(2, 1);
    const started: string[] = [];
    const activeByDomain = new Map<string, number>();
    const maximumByDomain = new Map<string, number>();
    let activeGlobal = 0;
    let maximumGlobal = 0;
    const releases = new Map<string, () => void>();

    const task = (domain: string, id: string) =>
      scheduler.run(domain, async () => {
        started.push(id);
        activeGlobal += 1;
        maximumGlobal = Math.max(maximumGlobal, activeGlobal);
        const domainActive = (activeByDomain.get(domain) ?? 0) + 1;
        activeByDomain.set(domain, domainActive);
        maximumByDomain.set(domain, Math.max(maximumByDomain.get(domain) ?? 0, domainActive));

        await new Promise<void>((resolve) => releases.set(id, resolve));
        activeGlobal -= 1;
        activeByDomain.set(domain, domainActive - 1);
      });

    const firstA = task('a.example', 'a1');
    const secondA = task('a.example', 'a2');
    const firstB = task('b.example', 'b1');
    await Promise.resolve();
    await Promise.resolve();

    expect(started).toEqual(['a1', 'b1']);
    expect(scheduler.snapshot()).toMatchObject({ activeGlobal: 2, queued: 1 });

    releases.get('a1')?.();
    await firstA;
    await vi.waitFor(() => expect(started).toEqual(['a1', 'b1', 'a2']));

    releases.get('a2')?.();
    releases.get('b1')?.();
    await Promise.all([secondA, firstB]);

    expect(maximumGlobal).toBe(2);
    expect(maximumByDomain.get('a.example')).toBe(1);
    expect(maximumByDomain.get('b.example')).toBe(1);
    expect(scheduler.snapshot()).toMatchObject({ activeGlobal: 0, queued: 0 });
  });

  it('releases capacity when a task rejects', async () => {
    const scheduler = new RequestScheduler(1, 1);
    await expect(
      scheduler.run('example.com', () => Promise.reject(new Error('failure'))),
    ).rejects.toThrow('failure');

    await expect(scheduler.run('example.com', () => 'next')).resolves.toBe('next');
  });

  it('preserves the enqueueing async context for queued tasks', async () => {
    const scheduler = new RequestScheduler(1, 1);
    const context = new AsyncLocalStorage<string>();
    const observed: string[] = [];
    let releaseFirst: (() => void) | undefined;

    const first = context.run('source-a', () =>
      scheduler.run('shared.example', async () => {
        observed.push(context.getStore() ?? 'missing');
        await new Promise<void>((resolve) => {
          releaseFirst = resolve;
        });
      }),
    );
    const second = context.run('source-b', () =>
      scheduler.run('shared.example', () => {
        observed.push(context.getStore() ?? 'missing');
      }),
    );

    await vi.waitFor(() => expect(observed).toEqual(['source-a']));
    releaseFirst?.();
    await Promise.all([first, second]);

    expect(observed).toEqual(['source-a', 'source-b']);
  });
});
