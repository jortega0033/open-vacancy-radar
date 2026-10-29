import { describe, expect, it, vi } from 'vitest';

import type { AtsHttpClient, AtsHttpResponse } from '../../src/ats/http.js';
import { MemoryHttpCache } from '../../src/crawler/http-cache.js';
import { SafeHttpClient, type SafeHttpClientOptions } from '../../src/crawler/http-client.js';
import { RequestScheduler } from '../../src/crawler/scheduler.js';
import type { DnsResolver } from '../../src/crawler/url-safety.js';
import { createAtsHttpClient } from '../../src/pipeline/ats-http-client.js';
import {
  comparePostingText,
  createPostingVerifier,
  normalizePostingText,
  observePosting,
  parseStatedDeadline,
  POSTING_REQUEST_ENVELOPE,
} from '../../src/verification/posting-verification.js';

// #687 fix round 1: every guarantee below is exercised on the REAL exported functions and, for the
// request envelope, on the REAL SafeHttpClient with only `fetch` and DNS stubbed. No network.

const NOW = new Date('2026-10-29T10:00:00.000Z');
const now = () => NOW;
const GH_URL = 'https://boards.greenhouse.io/acme/jobs/4012345';

/** Generous wall-clock ceilings: the old implementation took seconds to minutes on these inputs. */
const FAST_MS = 250;

function timed<T>(work: () => T): { value: T; ms: number } {
  const started = performance.now();
  const value = work();
  return { value, ms: performance.now() - started };
}

function fixture(body: unknown, status = 200): AtsHttpClient {
  return {
    async get(url: string): Promise<AtsHttpResponse> {
      return { status, finalUrl: url, headers: {}, body: typeof body === 'string' ? body : JSON.stringify(body) };
    },
    async postJson(): Promise<AtsHttpResponse> {
      throw new Error('never POSTs');
    },
  };
}

describe('bounded parsing of remote text (CodeQL js/polynomial-redos #13)', () => {
  it.each([
    ['deadline + whitespace/newline runs', `deadline${' \n'.repeat(60_000)}`],
    ['apply by + a long space run and no date', `Apply by${' '.repeat(110_000)}x`],
    ['repeated cue words with separators', 'deadline : on '.repeat(8_000)],
    ['repeated "applications are open until"', 'applications are open until is - on '.repeat(3_000)],
    ['tab/colon soup after a cue', `Closing date${'\t:\t-'.repeat(25_000)}`],
  ])('parseStatedDeadline stays linear on %s', (_label, text) => {
    const { value, ms } = timed(() => parseStatedDeadline(text));
    expect(value).toBeNull();
    expect(ms).toBeLessThan(FAST_MS);
  });

  it('still finds a stated deadline after adversarial padding, with provenance', () => {
    const text = `deadline${' \n'.repeat(5_000)}\nWe hire.\nApplication deadline: 2026-12-01.`;
    const { value, ms } = timed(() => parseStatedDeadline(text));
    expect(value).toMatchObject({ date: '2026-12-01', provenance: { excerpt: expect.stringContaining('2026-12-01') } });
    expect(ms).toBeLessThan(FAST_MS);
  });

  it.each([
    ['unclosed tags', '<'.repeat(120_000)],
    ['tag-like runs with no end', '<a '.repeat(40_000)],
    ['unterminated entities', '&amp'.repeat(30_000)],
  ])('normalizePostingText is linear on %s', (_label, text) => {
    const { ms } = timed(() => normalizePostingText(text));
    expect(ms).toBeLessThan(FAST_MS);
  });

  it('the sign-in form probe does not backtrack over a huge HTML body', async () => {
    const body = `<html>${'<form '.repeat(20_000)}</html>`;
    const started = performance.now();
    const observation = await observePosting(fixture(body), GH_URL, { now });
    expect(performance.now() - started).toBeLessThan(FAST_MS);
    expect(observation).toMatchObject({ outcome: 'unable' });
  });
});

describe('bounded HTML parsing of the payload', () => {
  it('a payload with tens of thousands of elements is "could not check (too large)", without parsing it', async () => {
    const bomb = `<p>${Array.from({ length: 20_000 }, () => 'x').join('</p><p>')}</p>`;
    const started = performance.now();
    const observation = await observePosting(fixture({ content: bomb.replace(/</gu, '&lt;').replace(/>/gu, '&gt;') }), GH_URL, { now });
    expect(performance.now() - started).toBeLessThan(FAST_MS);
    expect(observation).toMatchObject({ outcome: 'unable', reason: 'content_too_large', text: null });
  });

  it('an ordinary long posting inside the budget is parsed normally', async () => {
    const long = Array.from({ length: 600 }, (_, i) => `<li>Responsibility ${i} for the routing platform team.</li>`).join('');
    const observation = await observePosting(fixture({ content: `<ul>${long}</ul>` }), GH_URL, { now });
    expect(observation).toMatchObject({ outcome: 'open', reason: 'verified_open' });
    expect(observation.text).toContain('Responsibility 599');
  });
});

describe('bounded comparison of fully rewritten postings', () => {
  const line = (prefix: string, i: number) =>
    `${prefix} paragraph id${i} describing the platform, the team rituals and the way we ship software to customers every week.`.slice(0, 150);

  it('600 rewritten 150-character lines: an honest material text change, fast', () => {
    const baseline = Array.from({ length: 600 }, (_, i) => line('Original', i)).join('\n');
    const observed = Array.from({ length: 600 }, (_, i) => line('Rewritten', i)).join('\n');
    const { value, ms } = timed(() => comparePostingText(baseline, observed));
    expect(ms).toBeLessThan(FAST_MS);
    expect(value).toMatchObject({ same: false, material: true, kind: 'text', requirementChange: false });
    expect(value.added.length).toBeGreaterThan(0);
    expect(value.removed.length).toBeGreaterThan(0);
  });

  it('adversarial same-length lines that differ only at both ends exhaust the fixed budget, not the CPU', () => {
    // Every pair has equal length and number signature and a long shared middle, so a naive pairing
    // computes a full edit distance for ~150k pairs. The two letters at each end make every pair >2 edits.
    // Baseline codes use only a-m and observed codes only n-z: every character of both ends differs.
    const code = (base: number, n: number) =>
      [Math.floor(n / 169), Math.floor(n / 13) % 13, n % 13].map((digit) => String.fromCharCode(base + digit)).join('');
    const middle = ' common middle words repeated to make every line long enough to be expensive '.repeat(2);
    const make = (base: number, i: number) => `${code(base, i)}${middle}${code(base, (i * 7) % 2197)}`;
    const baseline = Array.from({ length: 390 }, (_, i) => make(97, i)).join('\n');
    const observed = Array.from({ length: 390 }, (_, i) => make(110, i)).join('\n');
    const { value, ms } = timed(() => comparePostingText(baseline, observed));
    expect(ms).toBeLessThan(FAST_MS);
    expect(value).toMatchObject({ same: false, material: true, bounded: true });
  });

  it('a 120 KB posting with 2,000 changed lines skips pairing and says so', () => {
    const baseline = Array.from({ length: 2_000 }, (_, i) => `Line ${i} about our product and team culture here`).join('\n');
    const observed = Array.from({ length: 2_000 }, (_, i) => `Row ${i} about a different product and other culture`).join('\n');
    const { value, ms } = timed(() => comparePostingText(baseline, observed));
    expect(ms).toBeLessThan(FAST_MS);
    expect(value).toMatchObject({ material: true, bounded: true });
  });

  it('typo pairing still works inside the budget', () => {
    const base = Array.from({ length: 40 }, (_, i) => `Item ${i} of our onboarding guide for new engineers`).join('\n');
    const typo = base.replace('Item 7 of our onboarding guide', 'Item 7 of our onbaording guide');
    expect(comparePostingText(base, typo)).toMatchObject({ same: false, material: false, kind: 'minor', bounded: false });
  });
});

describe('closure needs an authoritative signal: open postings with closure-like prose stay open', () => {
  const filler = '<p>We build routing software for logistics teams across Europe and ship every week.</p>'.repeat(6);
  it.each([
    'The job is closed to applicants without EU work authorisation. Apply if eligible.',
    'Hiring is closed in the US for this role but open in Canada.',
    'Applications for this role are closed to external candidates until Friday.',
    'This position has been filled internally in the past; we are hiring again.',
    'Applications for the 2025 intake are closed; this 2026 role is open.',
    'Hiring is now closed for interns. This senior role remains open.',
    'We are no longer accepting applications from recruitment agencies.',
    'This role is closed to relocation candidates; remote within the Netherlands only.',
  ])('open: %s', async (head) => {
    const observation = await observePosting(fixture({ content: `<p>${head}</p>${filler}` }), GH_URL, { now });
    expect(observation.outcome).toBe('open');
    expect(observation.reason).toBe('verified_open');
  });

  it.each([
    'This position has been filled and is no longer available.',
    'This job is no longer available.',
    'No longer accepting applications.',
  ])('a payload that is ONLY an unqualified closure notice is closed: %s', async (notice) => {
    const observation = await observePosting(fixture({ content: `<p>${notice}</p>` }), GH_URL, { now });
    expect(observation).toMatchObject({ outcome: 'closed', reason: 'closure_notice' });
  });

  it('the same notice followed by a full job description is open', async () => {
    const observation = await observePosting(
      fixture({ content: `<p>This job is no longer available.</p>${filler}${filler}` }),
      GH_URL,
      { now },
    );
    expect(observation.outcome).toBe('open');
  });
});

describe('materiality: requirements versus ordinary employer copy', () => {
  const NL = '\n';
  const filler = Array.from({ length: 24 }, (_, i) => `Responsibility item number ${i} about shipping product features carefully with the team.`);
  const base = [
    'About us',
    'We build payment tooling for merchants across Europe.',
    'Requirements',
    '5 years of TypeScript',
    'Fluent English',
    ...filler,
    'Benefits',
    'Pension plan',
    'Free lunch',
  ].join(NL);

  it.each([
    ['reordered bullets', base.replace(`5 years of TypeScript${NL}Fluent English`, `Fluent English${NL}5 years of TypeScript`)],
    ['EEO boilerplate sentence added', `${base}${NL}We are an equal opportunity employer and value diversity.`],
    ['perk wording changed', base.replace('Free lunch', 'Catered meals every Friday')],
    ['company blurb rewritten with the word lead', base.replace('We build payment tooling', 'We lead the market in payment tooling')],
    ['company blurb adds founded 12 years ago', base.replace('We build payment tooling', 'Founded 12 years ago, we build payment tooling')],
    ['office blurb added', `${base}${NL}Our new office has a rooftop terrace and great coffee.`],
    ['perk with an amount in the benefits section', `${base}${NL}A €1,000 learning budget every year.`],
    ['company has offices in many locations', base.replace('We build payment tooling for merchants across Europe.', 'We build payment tooling for merchants in 12 locations across Europe.')],
  ])('not material: %s', (_label, next) => {
    const comparison = comparePostingText(base, next);
    expect(comparison.material).toBe(false);
    expect(comparison.requirementChange).toBe(false);
  });

  it.each([
    ['years 5 -> 8', base.replace('5 years', '8 years')],
    ['merged bullets', base.replace(`5 years of TypeScript${NL}Fluent English`, '5 years of TypeScript and fluent English')],
    ['new language requirement', base.replace('Fluent English', `Fluent English${NL}Dutch at C1 level`)],
    ['new skill bullet under Requirements', base.replace('Fluent English', `Fluent English${NL}Kubernetes in production`)],
    ['work mode changed', `${base}${NL}This role is onsite in Eindhoven.`],
    ['visa sponsorship removed', `${base}${NL}We cannot offer visa sponsorship.`],
    ['salary stated', base.replace('Pension plan', 'Salary: €70,000 to €90,000')],
    ['office days added', `${base}${NL}You work 3 days a week from our Utrecht office.`],
  ])('requirement change: %s', (_label, next) => {
    const comparison = comparePostingText(base, next);
    expect(comparison).toMatchObject({ material: true, requirementChange: true, kind: 'requirements' });
  });

  it('a large non-requirement rewrite is a text change, never claimed as changed requirements', () => {
    const rewrittenFiller = filler.map((line) => line.replace('Responsibility item number', 'Team ritual entry'));
    const next = base.replace(filler.join(NL), rewrittenFiller.join(NL)).replace('Requirements', 'Our week');
    const comparison = comparePostingText(base.replace('Requirements', 'Our week'), next);
    expect(comparison).toMatchObject({ material: true, requirementChange: false, kind: 'text' });
  });
});

// ------------------------------------------------------------------------------------------------
// The real request envelope on the real SafeHttpClient (stubbed fetch + DNS only).
// ------------------------------------------------------------------------------------------------

const publicResolver: DnsResolver = () => Promise.resolve([{ address: '93.184.216.34', family: 4 }]);

function realClient(
  handler: (url: string, init: RequestInit | undefined) => Promise<Response> | Response,
  overrides: Partial<SafeHttpClientOptions> = {},
) {
  const physical: string[] = [];
  const fetchFn = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : input.toString();
    return handler(url, init);
  });
  const safe = new SafeHttpClient({
    globalConcurrency: 4,
    perDomainConcurrency: 2,
    timeoutMs: 15_000,
    maxRetries: 2,
    userAgent: 'OpenVacancyRadar/test (+posting verification)',
    resolver: publicResolver,
    fetchFn: fetchFn as unknown as typeof fetch,
    random: () => 0.5,
    sleep: async () => undefined,
    onNetworkRequest: (url) => physical.push(url),
    ...overrides,
  });
  return { http: createAtsHttpClient(safe), physical, fetchFn };
}

const ghBody = JSON.stringify({ id: 4012345, content: '<p>Five years of TypeScript experience is required.</p>' });

describe('the request envelope, on the real SafeHttpClient', () => {
  it('the detail route follows at most one same-origin redirect: 2 physical requests, then unable', async () => {
    let hop = 0;
    const { http, physical } = realClient(() => {
      hop += 1;
      return new Response(null, { status: 302, headers: { location: `/v1/boards/acme/jobs/4012345?hop=${hop}` } });
    });
    const observation = await observePosting(http, GH_URL, { now });
    expect(observation).toMatchObject({ outcome: 'unable', reason: 'unexpected_response', logicalRequests: 1 });
    expect(physical).toHaveLength(POSTING_REQUEST_ENVELOPE.standard.physical);
  });

  it('a server error is not retried: exactly 1 physical request', async () => {
    const { http, physical } = realClient(() => new Response('{}', { status: 503 }));
    const observation = await observePosting(http, GH_URL, { now });
    expect(observation).toMatchObject({ outcome: 'unable', reason: 'server_error' });
    expect(physical).toHaveLength(1);
  });

  it('an account-less Workable short link stays inside its 5-request envelope', async () => {
    const { http, physical } = realClient((url) => {
      if (url === 'https://apply.workable.com/j/F587C0434B') {
        return new Response(null, { status: 301, headers: { location: 'https://apply.workable.com/acme/j/F587C0434B' } });
      }
      if (url === 'https://apply.workable.com/acme/j/F587C0434B') {
        return new Response(null, { status: 301, headers: { location: 'https://apply.workable.com/acme/j/F587C0434B/' } });
      }
      if (url === 'https://apply.workable.com/acme/j/F587C0434B/') return new Response('<html>shell</html>');
      if (url === 'https://apply.workable.com/api/v2/accounts/acme/jobs/F587C0434B') {
        return new Response(JSON.stringify({ description: '<p>Hybrid in Utrecht.</p>' }));
      }
      return new Response('', { status: 404 });
    });
    const observation = await observePosting(http, 'https://apply.workable.com/j/F587C0434B', { now });
    expect(observation).toMatchObject({ outcome: 'open', logicalRequests: 2 });
    expect(physical.length).toBeLessThanOrEqual(POSTING_REQUEST_ENVELOPE.workableShortLink.physical);
    expect(physical).toHaveLength(4);
  });

  it('a Workable lookup redirecting more than twice is unable, not closed, and stops at 3 requests', async () => {
    let hop = 0;
    const { http, physical } = realClient(() => {
      hop += 1;
      return new Response(null, { status: 302, headers: { location: `https://apply.workable.com/acme/j/F587C0434B/${hop}` } });
    });
    const observation = await observePosting(http, 'https://apply.workable.com/j/F587C0434B', { now });
    expect(observation.outcome).toBe('unable');
    expect(physical).toHaveLength(POSTING_REQUEST_ENVELOPE.lookupMaxRedirects + 1);
  });

  it('the shared cache sends stored validators and a 304 is reported as revalidated', async () => {
    const cache = new MemoryHttpCache();
    const seen: Array<string | null> = [];
    let call = 0;
    const { http, physical } = realClient(
      (_url, init) => {
        call += 1;
        seen.push(new Headers(init?.headers).get('if-none-match'));
        return call === 1
          ? new Response(ghBody, { headers: { etag: '"v1"', 'content-type': 'application/json' } })
          : new Response(null, { status: 304, headers: { etag: '"v1"' } });
      },
      { cache },
    );
    const first = await observePosting(http, GH_URL, { now });
    const second = await observePosting(http, GH_URL, { now });
    expect(first).toMatchObject({ outcome: 'open', reason: 'verified_open', validators: { etag: '"v1"' } });
    expect(second).toMatchObject({ outcome: 'open', reason: 'not_modified', notModified: true, contentHash: first.contentHash });
    expect(seen).toEqual([null, '"v1"']);
    expect(physical).toHaveLength(2);
  });

  it('the verifier deadline aborts a hanging fetch and releases the scheduler slot', async () => {
    const scheduler = new RequestScheduler(1, 1);
    let fetchSignal: AbortSignal | null | undefined;
    const { http, physical } = realClient(
      (_url, init) => {
        fetchSignal = init?.signal;
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
        });
      },
      { scheduler, timeoutMs: 60_000 },
    );
    const verifier = createPostingVerifier(http, { now, timeoutMs: 30 });
    const observation = await verifier.verify({ url: GH_URL });
    expect(observation).toMatchObject({ outcome: 'unable', reason: 'timeout', source: 'greenhouse' });
    expect(physical).toHaveLength(1);
    expect(fetchSignal?.aborted).toBe(true);
    await vi.waitFor(() => expect(scheduler.snapshot()).toMatchObject({ activeGlobal: 0, queued: 0 }));
  });

  it('a check whose deadline passes while queued behind other work never fetches', async () => {
    const scheduler = new RequestScheduler(1, 1);
    let releaseBlocker!: () => void;
    const { http, physical } = realClient(
      (url) =>
        url.includes('blocker')
          ? new Promise<Response>((resolve) => {
              releaseBlocker = () => resolve(new Response('{}'));
            })
          : new Response(ghBody),
      { scheduler, timeoutMs: 60_000 },
    );
    const blocker = http.get('https://boards-api.greenhouse.io/blocker', { cache: 'no-store' });
    await vi.waitFor(() => expect(physical).toHaveLength(1));
    const observation = await createPostingVerifier(http, { now, timeoutMs: 30 }).verify({ url: GH_URL });
    expect(observation).toMatchObject({ outcome: 'unable', reason: 'timeout' });
    releaseBlocker();
    await blocker;
    await vi.waitFor(() => expect(scheduler.snapshot()).toMatchObject({ activeGlobal: 0, queued: 0 }));
    // Only the blocker ever reached the network.
    expect(physical).toHaveLength(1);
  });

  it('a 404 from the real client is closed with one physical request', async () => {
    const { http, physical } = realClient(() => new Response('{"error":"not found"}', { status: 404 }));
    expect(await observePosting(http, GH_URL, { now })).toMatchObject({ outcome: 'closed', reason: 'not_found' });
    expect(physical).toHaveLength(1);
  });
});

describe('the banded typo check agrees with a full edit distance', () => {
  function levenshtein(a: string, b: string): number {
    let previous = Array.from({ length: b.length + 1 }, (_, j) => j);
    for (let i = 1; i <= a.length; i += 1) {
      const current = [i];
      for (let j = 1; j <= b.length; j += 1) {
        current[j] = Math.min(previous[j]! + 1, current[j - 1]! + 1, previous[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
      }
      previous = current;
    }
    return previous[b.length]!;
  }

  it('on 600 seeded random line pairs (paired as a typo exactly when within two edits)', () => {
    let seed = 687;
    const random = () => {
      seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
      return seed / 2_147_483_648;
    };
    const word = () => Array.from({ length: 3 + Math.floor(random() * 5) }, () => 'abcde'[Math.floor(random() * 5)]).join('');
    for (let n = 0; n < 600; n += 1) {
      const left = Array.from({ length: 4 }, word).join(' ');
      const chars = [...left];
      const edits = Math.floor(random() * 5);
      for (let e = 0; e < edits; e += 1) {
        const at = Math.floor(random() * chars.length);
        const op = Math.floor(random() * 3);
        if (op === 0) chars.splice(at, 1);
        else if (op === 1) chars.splice(at, 0, 'abcde'[Math.floor(random() * 5)]!);
        else chars[at] = 'abcde'[Math.floor(random() * 5)]!;
      }
      const right = chars.join('').replace(/ {2,}/gu, ' ').trim();
      const a = normalizePostingText(left);
      const b = normalizePostingText(right);
      if (a === b || b.length < 3) continue;
      const comparison = comparePostingText(left, right);
      expect(comparison.material, `${left} | ${right}`).toBe(levenshtein(a, b) > 2);
    }
  });
});
