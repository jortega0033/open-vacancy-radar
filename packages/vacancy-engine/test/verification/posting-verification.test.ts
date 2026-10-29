import { describe, expect, it } from 'vitest';

import { AtsResponseError, type AtsHttpClient, type AtsHttpRequestOptions, type AtsHttpResponse } from '../../src/ats/http.js';
import { CrawlerHttpError } from '../../src/crawler/errors.js';
import {
  comparePostingText,
  createPostingVerifier,
  observePosting,
  parseStatedDeadline,
  postingContentHash,
  resolvePostingProbe,
} from '../../src/verification/posting-verification.js';

type Step = AtsHttpResponse | Error;

class Fixture implements AtsHttpClient {
  public readonly calls: Array<{ url: string; options: AtsHttpRequestOptions | undefined }> = [];
  public constructor(private readonly routes: Map<string, Step>) {}
  public async get(url: string, options?: AtsHttpRequestOptions): Promise<AtsHttpResponse> {
    this.calls.push({ url, options });
    const step = this.routes.get(url);
    if (step === undefined) throw new Error(`unexpected request: ${url}`);
    if (step instanceof Error) throw step;
    return step;
  }
  public async postJson(): Promise<AtsHttpResponse> {
    throw new Error('verification never POSTs');
  }
}

const NOW = new Date('2026-10-29T10:00:00.000Z');
const now = () => NOW;

const GH_URL = 'https://boards.greenhouse.io/acme/jobs/4012345';
const GH_API = 'https://boards-api.greenhouse.io/v1/boards/acme/jobs/4012345';
const LEVER_URL = 'https://jobs.lever.co/acme/0a1b2c3d-1111-4222-8333-444455556666';
const LEVER_API = 'https://api.lever.co/v0/postings/acme/0a1b2c3d-1111-4222-8333-444455556666';
const WORKABLE_URL = 'https://apply.workable.com/acme/j/F587C0434B/';
const WORKABLE_API = 'https://apply.workable.com/api/v2/accounts/acme/jobs/F587C0434B';
const WORKABLE_SHORT = 'https://apply.workable.com/j/F587C0434B';
const JOBGETHER_URL = 'https://jobgether.com/offer/6a6144881b23f4f87b3172fb-frontend-engineer';
const JOBGETHER_API = 'https://jobgether.com/astroapi/offer/6a6144881b23f4f87b3172fb.json';

const ok = (body: unknown, extra: Partial<AtsHttpResponse> = {}, url = GH_API): AtsHttpResponse => ({
  status: 200,
  finalUrl: url,
  headers: {},
  body: typeof body === 'string' ? body : JSON.stringify(body),
  ...extra,
});

const GH_BODY = {
  id: 4012345,
  title: 'Frontend Engineer',
  content:
    '&lt;p&gt;Build the product UI with React and TypeScript.&lt;/p&gt;&lt;ul&gt;&lt;li&gt;Five years of frontend experience&lt;/li&gt;&lt;li&gt;Fluent English&lt;/li&gt;&lt;/ul&gt;',
};

describe('resolvePostingProbe', () => {
  it('recognises only providers with an official single-posting route on an origin the app already reads', () => {
    expect(resolvePostingProbe(GH_URL)?.endpoint).toBe(GH_API);
    expect(resolvePostingProbe('https://job-boards.greenhouse.io/acme/jobs/4012345?gh_src=x')?.endpoint).toBe(GH_API);
    expect(resolvePostingProbe(LEVER_URL)?.endpoint).toBe(LEVER_API);
    expect(resolvePostingProbe('https://jobs.eu.lever.co/acme/0a1b2c3d-1111-4222-8333-444455556666/apply')?.endpoint).toBe(
      'https://api.eu.lever.co/v0/postings/acme/0a1b2c3d-1111-4222-8333-444455556666',
    );
    expect(resolvePostingProbe(WORKABLE_URL)?.endpoint).toBe(WORKABLE_API);
    expect(resolvePostingProbe(WORKABLE_SHORT)?.endpoint).toBeNull();
    expect(resolvePostingProbe(JOBGETHER_URL)?.endpoint).toBe(JOBGETHER_API);
  });

  it('refuses everything else, so it provably costs no request', () => {
    for (const url of [
      'https://example.com/careers/frontend',
      'http://boards.greenhouse.io/acme/jobs/4012345',
      'https://boards.greenhouse.io/acme/jobs/not-a-number',
      'https://boards.greenhouse.io/acme',
      'https://jobs.lever.co/acme',
      'https://evil.example/https://boards.greenhouse.io/acme/jobs/1',
      'https://user:pw@boards.greenhouse.io/acme/jobs/4012345',
      'not a url',
      '',
    ]) {
      expect(resolvePostingProbe(url), url).toBeNull();
    }
  });
});

describe('observePosting: open', () => {
  it('reads the authoritative payload once and stores hash, validators and provenance', async () => {
    const http = new Fixture(new Map([[GH_API, ok(GH_BODY, { headers: { etag: '"v1"', 'last-modified': 'Mon, 26 Oct 2026 08:00:00 GMT' } })]]));
    const observation = await observePosting(http, GH_URL, { now });
    expect(http.calls).toHaveLength(1);
    expect(http.calls[0]?.options).toMatchObject({ allowedOrigins: ['https://boards-api.greenhouse.io'], maxRetries: 0, cache: 'default' });
    expect(observation).toMatchObject({
      outcome: 'open',
      reason: 'verified_open',
      source: 'greenhouse',
      sourceRef: 'boards-api.greenhouse.io/v1/boards/{board}/jobs/{id}',
      observedAt: NOW.toISOString(),
      notModified: false,
      validators: { etag: '"v1"', lastModified: 'Mon, 26 Oct 2026 08:00:00 GMT' },
    });
    expect(observation.text).toContain('Build the product UI with React and TypeScript.');
    expect(observation.text).toContain('Five years of frontend experience');
    expect(observation.contentHash).toBe(postingContentHash(observation.text ?? ''));
  });

  it('reports a cache revalidation (stored ETag still current) as not modified at THIS observation time', async () => {
    const http = new Fixture(new Map([[GH_API, ok(GH_BODY, { revalidated: true, headers: { etag: '"v1"' } })]]));
    const observation = await observePosting(http, GH_URL, { now });
    expect(observation).toMatchObject({ outcome: 'open', reason: 'not_modified', notModified: true, observedAt: NOW.toISOString() });
    expect(observation.contentHash).not.toBeNull();
  });

  it('sends stored validators for a no-store source and treats a bare 304 as unchanged', async () => {
    const http = new Fixture(new Map([[WORKABLE_API, { status: 304, finalUrl: WORKABLE_API, headers: {}, body: '' }]]));
    const observation = await observePosting(http, WORKABLE_URL, {
      now,
      validators: { etag: '"w1"', lastModified: 'Tue, 27 Oct 2026 08:00:00 GMT' },
    });
    expect(http.calls[0]?.options).toMatchObject({ cache: 'no-store' });
    expect(new Headers(http.calls[0]?.options?.headers).get('if-none-match')).toBe('"w1"');
    expect(new Headers(http.calls[0]?.options?.headers).get('if-modified-since')).toBe('Tue, 27 Oct 2026 08:00:00 GMT');
    expect(observation).toMatchObject({ outcome: 'open', reason: 'not_modified', notModified: true, text: null, contentHash: null });
    expect(observation.validators).toEqual({ etag: '"w1"', lastModified: 'Tue, 27 Oct 2026 08:00:00 GMT' });
  });

  it('treats the real client\'s thrown unexpected_not_modified (no-store 304) as unchanged', async () => {
    const error = new CrawlerHttpError({
      category: 'http_error',
      code: 'unexpected_not_modified',
      url: JOBGETHER_API,
      detail: 'Received 304 without a reusable cached response',
      status: 304,
    });
    const http = new Fixture(new Map([[JOBGETHER_API, error]]));
    const observation = await observePosting(http, JOBGETHER_URL, { now, validators: { etag: '"j1"' } });
    expect(observation).toMatchObject({ outcome: 'open', reason: 'not_modified', notModified: true });
  });

  it('resolves an account-less Workable link with one lookup, then one detail request', async () => {
    const http = new Fixture(
      new Map<string, Step>([
        [WORKABLE_SHORT.replace(/\/$/u, ''), ok('<!doctype html>', {}, WORKABLE_URL)],
        [WORKABLE_API, ok({ description: '<p>Own the checkout UI.</p>', requirements: '<ul><li>TypeScript</li></ul>' }, {}, WORKABLE_API)],
      ]),
    );
    const observation = await observePosting(http, WORKABLE_SHORT, { now });
    expect(http.calls.map((call) => call.url)).toEqual([WORKABLE_SHORT, WORKABLE_API]);
    expect(observation.outcome).toBe('open');
    expect(observation.text).toContain('Own the checkout UI.');
    expect(observation.text).toContain('TypeScript');
  });
});

describe('observePosting: explicit closure', () => {
  it.each([
    ['a returned 404', ok('{"error":"not found"}', { status: 404 }), 'not_found'],
    ['a returned 410', ok('', { status: 410 }), 'gone'],
    [
      'a thrown 404 from the real client',
      new CrawlerHttpError({ category: 'http_error', code: 'http_status', url: GH_API, detail: 'HTTP 404', status: 404 }),
      'not_found',
    ],
    ['an AtsResponseError 404', new AtsResponseError('greenhouse', 'HTTP 404', 404), 'not_found'],
  ] as Array<[string, Step, string]>)('%s is confirmed closed', async (_label, step, reason) => {
    const observation = await observePosting(new Fixture(new Map([[GH_API, step]])), GH_URL, { now });
    expect(observation).toMatchObject({ outcome: 'closed', reason, text: null });
  });

  it('treats an explicit closure notice at the head of the payload as closed', async () => {
    const http = new Fixture(new Map([[GH_API, ok({ content: '<p>This position has been filled and is no longer available.</p><p>Thanks!</p>' })]]));
    expect(await observePosting(http, GH_URL, { now })).toMatchObject({ outcome: 'closed', reason: 'closure_notice' });
  });

  it('does NOT treat the same words deep inside an ordinary description as closure', async () => {
    const filler = 'We build accessible web products for logistics teams. '.repeat(8);
    const http = new Fixture(
      new Map([[GH_API, ok({ content: `<p>${filler}</p><p>We are no longer accepting applications from recruitment agencies.</p>` })]]),
    );
    expect(await observePosting(http, GH_URL, { now })).toMatchObject({ outcome: 'open', reason: 'verified_open' });
  });

  it('treats Workable\'s /oops destination for an unknown shortcode as closed', async () => {
    const http = new Fixture(new Map([[WORKABLE_SHORT, ok('<html></html>', {}, 'https://apply.workable.com/oops')]]));
    expect(await observePosting(http, WORKABLE_SHORT, { now })).toMatchObject({ outcome: 'closed', reason: 'account_not_found' });
  });
});

describe('observePosting: inability to verify is never closure', () => {
  const blocked = (status: number) =>
    new CrawlerHttpError({ category: 'blocked', code: 'blocked_status', url: GH_API, detail: 'blocked', status });
  it.each([
    ['timeout', new CrawlerHttpError({ category: 'timeout', code: 'request_timeout', url: GH_API, detail: 'timed out' }), 'timeout'],
    ['403 from the real client', blocked(403), 'denied'],
    ['401 from the real client', blocked(401), 'denied'],
    ['a returned 403', ok('', { status: 403 }), 'denied'],
    ['429', new CrawlerHttpError({ category: 'rate_limited', code: 'rate_limited_status', url: GH_API, detail: 'rl', status: 429 }), 'rate_limited'],
    ['500', new CrawlerHttpError({ category: 'http_error', code: 'http_status', url: GH_API, detail: '500', status: 500 }), 'server_error'],
    ['a returned 503', ok('', { status: 503 }), 'server_error'],
    ['DNS/network failure', new CrawlerHttpError({ category: 'network_error', code: 'request_failed', url: GH_API, detail: 'net' }), 'network_error'],
    ['an off-origin redirect', new CrawlerHttpError({ category: 'unsafe_url', code: 'disallowed_redirect_origin', url: GH_API, detail: 'x' }), 'redirected_elsewhere'],
    ['a login redirect', ok('<html>Sign in</html>', {}, 'https://boards-api.greenhouse.io/users/sign_in'), 'login_wall'],
    ['an SSO host redirect', ok('<html></html>', {}, 'https://sso.example.com/start'), 'login_wall'],
    ['a login form served as 200', ok('<html><form action="/login"><input type="password"></form></html>'), 'login_wall'],
    ['an HTML shell instead of JSON', ok('<!doctype html><html>app</html>'), 'unexpected_response'],
    ['a JSON error object with no posting', ok({ id: 1 }), 'empty_content'],
    ['an unknown status', ok('', { status: 418 }), 'unexpected_response'],
  ] as Array<[string, Step, string]>)('%s is unable to verify (reason %s)', async (_label, step, reason) => {
    const http = new Fixture(new Map([[GH_API, step]]));
    const observation = await observePosting(http, GH_URL, { now });
    expect(observation.outcome).toBe('unable');
    expect(observation.reason).toBe(reason);
    expect(observation.text).toBeNull();
    // One request, no retry ladder, no alternative route to get around the denial.
    expect(http.calls).toHaveLength(1);
  });

  it('spends no request at all on a source with no authoritative route', async () => {
    const http = new Fixture(new Map());
    const observation = await observePosting(http, 'https://example.com/jobs/1', { now });
    expect(http.calls).toHaveLength(0);
    expect(observation).toMatchObject({ outcome: 'unable', reason: 'no_authoritative_source', source: 'none' });
  });

  it('bounds a hanging request with the verifier timeout', async () => {
    const hanging: AtsHttpClient = {
      get: () => new Promise<AtsHttpResponse>(() => {}),
      postJson: () => Promise.reject(new Error('no')),
    };
    const verifier = createPostingVerifier(hanging, { now, timeoutMs: 20 });
    expect(await verifier.verify({ url: GH_URL })).toMatchObject({ outcome: 'unable', reason: 'timeout', source: 'greenhouse' });
  });
});

describe('parseStatedDeadline', () => {
  it('parses only an explicitly stated date and keeps the sentence as provenance', () => {
    expect(parseStatedDeadline('Great team.\nApply by 15 November 2026 to be considered.')).toMatchObject({
      date: '2026-11-15',
      provenance: { source: 'posting_text', excerpt: expect.stringContaining('Apply by 15 November 2026') },
    });
    expect(parseStatedDeadline('Application deadline: 2026-12-01.')?.date).toBe('2026-12-01');
    expect(parseStatedDeadline('Closing date: March 3rd, 2027')?.date).toBe('2027-03-03');
  });

  it('returns null when none is stated or the date is ambiguous or impossible', () => {
    expect(parseStatedDeadline('We are hiring now. Posted 2026-10-01.')).toBeNull();
    expect(parseStatedDeadline('Application deadline: 03/04/2026')).toBeNull();
    expect(parseStatedDeadline('Apply by 31 February 2026')).toBeNull();
    expect(parseStatedDeadline('Deadline: soon')).toBeNull();
  });

  it('never derives a deadline from the posted or first-seen time', async () => {
    const http = new Fixture(new Map([[GH_API, ok({ ...GH_BODY, updated_at: '2026-10-20T00:00:00Z', first_published: '2026-10-01T00:00:00Z' })]]));
    expect((await observePosting(http, GH_URL, { now })).deadline).toBeNull();
  });
});

describe('comparePostingText', () => {
  const base = 'Build the UI with React.\nFive years of frontend experience.\nFluent English is required.\nHybrid in Utrecht.';

  it('ignores markup, whitespace, case and punctuation', () => {
    const reformatted = '<p>build the ui with react</p>\n\n<ul><li>FIVE years of   frontend experience</li></ul>\nFluent English is required\nHybrid in Utrecht';
    expect(comparePostingText(base, reformatted)).toEqual({ same: true, material: false, added: [], removed: [] });
  });

  it('flags a changed requirement as material and reports what changed', () => {
    const changed = base.replace('Five years of frontend experience.', 'Eight years of frontend experience.');
    const comparison = comparePostingText(base, changed);
    expect(comparison.material).toBe(true);
    expect(comparison.removed).toEqual(['Five years of frontend experience.']);
    expect(comparison.added).toEqual(['Eight years of frontend experience.']);
  });

  it('flags a new language or location requirement', () => {
    expect(comparePostingText(base, `${base}\nDutch is required for client calls.`).material).toBe(true);
    expect(comparePostingText(base, base.replace('Hybrid in Utrecht', 'Onsite in Eindhoven')).material).toBe(true);
  });

  it('does not treat a wording/typo fix with unchanged numbers as material', () => {
    const typo = base.replace('Build the UI with React.', 'Build the UI wth React.');
    const comparison = comparePostingText(base, typo);
    expect(comparison.same).toBe(false);
    expect(comparison.material).toBe(false);
  });

  it('flags a large rewrite even when no single line carries a cue word', () => {
    const lines = Array.from({ length: 10 }, (_, i) => `Paragraph about topic number ${i} of the company story.`).join('\n');
    const rewritten = Array.from({ length: 10 }, (_, i) => (i < 3 ? `Totally new narrative alpha ${i} entirely.` : `Paragraph about topic number ${i} of the company story.`)).join('\n');
    expect(comparePostingText(lines, rewritten).material).toBe(true);
  });
});

describe('comparePostingText: spelled-out numbers are not typos', () => {
  it('flags "Five years" -> "Eight years" even though the lines are otherwise identical', () => {
    const comparison = comparePostingText('Five years of TypeScript experience is required.', 'Eight years of TypeScript experience is required.');
    expect(comparison.material).toBe(true);
    expect(comparison.removed).toEqual(['Five years of TypeScript experience is required.']);
    expect(comparison.added).toEqual(['Eight years of TypeScript experience is required.']);
  });
});
