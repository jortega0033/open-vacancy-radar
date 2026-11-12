// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import type { PostingObservation } from '@open-vacancy-radar/vacancy-engine';
import {
  createPostingLivenessService,
  POSTING_LIVENESS_MEMORY_LIMIT,
  POSTING_LIVENESS_READ_LIMIT,
} from '../electron/vacancy-posting-liveness.js';

// #720: plain liveness for search results. Reading costs no request; a check of one selected result is
// one bounded request through the injected verifier, reused while fresh, shared while in flight.

const ASHBY = 'https://jobs.ashbyhq.com/itlabs/5f2c1a7e-1111-4222-8333-444455556666';
const LEVER = 'https://jobs.lever.co/mendix/0a1b2c3d-1111-4222-8333-444455556666';
const UNSUPPORTED = 'https://careers.example.org/jobs/42';
const T0 = new Date('2026-10-30T09:00:00.000Z');

function observation(outcome: PostingObservation['outcome'], reason: PostingObservation['reason'], at = T0): PostingObservation {
  return {
    observedAt: at.toISOString(),
    source: 'ashby',
    sourceRef: 'api.ashbyhq.com/posting-api/job-board/{board}',
    outcome,
    reason,
    httpStatus: 200,
    text: outcome === 'open' ? 'posting text that must never be kept' : null,
    contentHash: null,
    validators: null,
    notModified: false,
    deadline: null,
    logicalRequests: 1,
  };
}

function setup(urls: Record<string, string | null>, verify = vi.fn(async () => observation('closed', 'not_listed'))) {
  let clock = new Date(T0);
  const service = createPostingLivenessService({
    resolveUrl: (key) => urls[key] ?? null,
    verify,
    now: () => clock,
  });
  return { service, verify, advance: (ms: number) => (clock = new Date(clock.getTime() + ms)) };
}

describe('posting liveness for search results (#720)', () => {
  it('reading makes no request and says only what is known', () => {
    const { service, verify } = setup({ a: ASHBY, u: UNSUPPORTED, gone: null });
    expect(service.read(['a', 'u', 'gone'])).toEqual([
      { vacancyKey: 'a', state: 'not_checked', checkedAt: null, source: null, sourceRef: null, reason: null, checkable: true },
      { vacancyKey: 'u', state: 'unverifiable', checkedAt: null, source: null, sourceRef: null, reason: 'no_authoritative_source', checkable: false },
      { vacancyKey: 'gone', state: 'unverifiable', checkedAt: null, source: null, sourceRef: null, reason: 'no_authoritative_source', checkable: false },
    ]);
    expect(verify).not.toHaveBeenCalled();
  });

  it('a check of a link with no route costs no request', async () => {
    const { service, verify } = setup({ u: UNSUPPORTED });
    expect(await service.check('u')).toMatchObject({ state: 'unverifiable', checkedAt: null });
    expect(verify).not.toHaveBeenCalled();
  });

  it('one bounded check: closed with its real time, reused while fresh, asked again after the window', async () => {
    const { service, verify, advance } = setup({ a: ASHBY });
    expect(await service.check('a')).toMatchObject({ state: 'closed', reason: 'not_listed', checkedAt: T0.toISOString(), source: 'ashby' });
    expect(verify).toHaveBeenCalledTimes(1);
    expect(verify).toHaveBeenCalledWith({ url: ASHBY });
    advance(23 * 60 * 60 * 1000);
    expect(await service.check('a')).toMatchObject({ state: 'closed', checkedAt: T0.toISOString() });
    expect(verify).toHaveBeenCalledTimes(1);
    advance(2 * 60 * 60 * 1000);
    await service.check('a');
    expect(verify).toHaveBeenCalledTimes(2);
  });

  it('"could not check" is retried after 15 minutes, never kept as an answer for a day', async () => {
    const verify = vi.fn(async () => observation('unable', 'timeout'));
    const { service, advance } = setup({ a: ASHBY }, verify);
    expect(await service.check('a')).toMatchObject({ state: 'unverifiable', reason: 'timeout' });
    advance(10 * 60 * 1000);
    await service.check('a');
    expect(verify).toHaveBeenCalledTimes(1);
    advance(6 * 60 * 1000);
    await service.check('a');
    expect(verify).toHaveBeenCalledTimes(2);
  });

  it('overlapping checks of one link share one request', async () => {
    let release: (value: PostingObservation) => void = () => undefined;
    const verify = vi.fn(() => new Promise<PostingObservation>((resolve) => (release = resolve)));
    const { service } = setup({ a: ASHBY, b: ASHBY }, verify);
    const first = service.check('a');
    const second = service.check('b');
    await vi.waitFor(() => expect(verify).toHaveBeenCalled());
    release(observation('open', 'verified_open'));
    expect((await first).state).toBe('open');
    expect((await second).state).toBe('open');
    expect(verify).toHaveBeenCalledTimes(1);
  });

  it('a verifier that throws is "couldn\'t check", never closed', async () => {
    const verify = vi.fn(async () => {
      throw new Error('engine database unavailable');
    });
    const { service } = setup({ a: ASHBY }, verify);
    expect(await service.check('a')).toMatchObject({ state: 'unverifiable', reason: 'check_failed', checkedAt: T0.toISOString() });
  });

  it("remembers preparation's own checks, keeps no posting text, and never lets an older answer win", () => {
    const { service } = setup({ a: ASHBY });
    service.remember(ASHBY, observation('open', 'verified_open', new Date(T0.getTime() + 1000)));
    service.remember(ASHBY, observation('closed', 'not_listed', T0));
    const [view] = service.read(['a']);
    expect(view).toMatchObject({ state: 'open', checkedAt: new Date(T0.getTime() + 1000).toISOString() });
    expect(JSON.stringify(view)).not.toContain('posting text');
  });

  it('is bounded: reads at most a page-sized batch and remembers a fixed number of links', () => {
    const urls: Record<string, string> = {};
    for (let index = 0; index < POSTING_LIVENESS_MEMORY_LIMIT + 5; index += 1) urls[`k${index}`] = `${LEVER}?n=${index}`;
    const { service } = setup(urls);
    expect(service.read(Object.keys(urls))).toHaveLength(POSTING_LIVENESS_READ_LIMIT);
    for (const url of Object.values(urls)) service.remember(url, observation('open', 'verified_open'));
    // The oldest entries were dropped: they honestly read "not checked yet" again.
    expect(service.read(['k0'])[0]?.state).toBe('not_checked');
    expect(service.read([`k${POSTING_LIVENESS_MEMORY_LIMIT + 4}`])[0]?.state).toBe('open');
  });
});
