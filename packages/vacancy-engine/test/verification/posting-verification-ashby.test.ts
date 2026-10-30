import { describe, expect, it, vi } from 'vitest';

import { AshbyAdapter } from '../../src/ats/ashby.js';
import type { AtsHttpClient, AtsHttpRequestOptions, AtsHttpResponse } from '../../src/ats/http.js';
import { SafeHttpClient } from '../../src/crawler/http-client.js';
import type { DnsResolver } from '../../src/crawler/url-safety.js';
import type { CareerSourceDescriptor } from '../../src/domain/models.js';
import { createAtsHttpClient } from '../../src/pipeline/ats-http-client.js';
import {
  createPostingVerifier,
  observePosting,
  postingContentHash,
  POSTING_REQUEST_ENVELOPE,
  resolvePostingProbe,
} from '../../src/verification/posting-verification.js';

// #720: Ashby has no public single-posting route, so the verifier reads the employer's official board
// (the exact URL the Ashby adapter already reads) and looks the posting up in it. Synthetic fixtures
// only; no network.

const NOW = new Date('2026-10-30T09:00:00.000Z');
const now = () => NOW;

const JOB_ID = '5f2c1a7e-1111-4222-8333-444455556666';
const OTHER_ID = '9a8b7c6d-1111-4222-8333-444455556666';
const POSTING_URL = `https://jobs.ashbyhq.com/itlabs/${JOB_ID}`;
const BOARD_API = 'https://api.ashbyhq.com/posting-api/job-board/itlabs?includeCompensation=true';

function job(id: string, extra: Record<string, unknown> = {}) {
  return {
    id,
    title: 'Senior Frontend Engineer',
    jobUrl: `https://jobs.ashbyhq.com/itlabs/${id}`,
    isListed: true,
    descriptionHtml: '<p>Build the product UI with React and TypeScript.</p><ul><li>Five years of frontend experience</li></ul>',
    compensation: { scrapeableCompensationSalarySummary: 'EUR 60K - 75K' },
    ...extra,
  };
}

class Fixture implements AtsHttpClient {
  public readonly calls: Array<{ url: string; options: AtsHttpRequestOptions | undefined }> = [];
  public constructor(private readonly respond: (url: string) => AtsHttpResponse) {}
  public async get(url: string, options?: AtsHttpRequestOptions): Promise<AtsHttpResponse> {
    this.calls.push({ url, options });
    return this.respond(url);
  }
  public async postJson(): Promise<AtsHttpResponse> {
    throw new Error('verification never POSTs');
  }
}

const board =
  (jobs: unknown[], status = 200) =>
  (url: string): AtsHttpResponse => ({
    status,
    finalUrl: url,
    headers: { etag: '"board-v9"' },
    body: JSON.stringify({ apiVersion: '1', jobs }),
  });

describe('resolvePostingProbe: Ashby', () => {
  it('maps an official Ashby posting link to the board route the adapter reads', () => {
    expect(resolvePostingProbe(POSTING_URL)).toMatchObject({
      source: 'ashby',
      endpoint: BOARD_API,
      allowedOrigin: 'https://api.ashbyhq.com',
      cache: 'no-store',
      boardJobId: JOB_ID,
      sourceRef: 'api.ashbyhq.com/posting-api/job-board/{board}',
    });
    expect(resolvePostingProbe(`https://jobs.ashbyhq.com/itlabs/${JOB_ID}/application`)?.endpoint).toBe(BOARD_API);
    expect(resolvePostingProbe(`https://jobs.ashbyhq.com/IT%20Labs/${JOB_ID}`)?.endpoint).toBe(
      'https://api.ashbyhq.com/posting-api/job-board/IT%20Labs?includeCompensation=true',
    );
  });

  it('refuses anything that is not an official Ashby posting link, so it costs no request', () => {
    for (const url of [
      'https://jobs.ashbyhq.com/itlabs',
      'https://jobs.ashbyhq.com/itlabs/not-a-job-id',
      `http://jobs.ashbyhq.com/itlabs/${JOB_ID}`,
      `https://user:pw@jobs.ashbyhq.com/itlabs/${JOB_ID}`,
      `https://careers.itlabs.example/jobs/${JOB_ID}`,
      `https://jobs.ashbyhq.com/it%2Flabs/${JOB_ID}`,
      `https://jobs.ashbyhq.com/%E0%A4%A/${JOB_ID}`,
    ]) {
      expect(resolvePostingProbe(url), url).toBeNull();
    }
  });
});

describe('observePosting: Ashby board evidence', () => {
  it('a job the official board omits is closed (not listed), from one bounded request', async () => {
    const http = new Fixture(board([job(OTHER_ID)]));
    const observation = await observePosting(http, POSTING_URL, { now });
    expect(observation).toMatchObject({
      outcome: 'closed',
      reason: 'not_listed',
      source: 'ashby',
      httpStatus: 200,
      observedAt: NOW.toISOString(),
      text: null,
      logicalRequests: 1,
    });
    expect(http.calls).toHaveLength(1);
    expect(http.calls[0]?.url).toBe(BOARD_API);
    expect(http.calls[0]?.options).toMatchObject({
      allowedOrigins: ['https://api.ashbyhq.com'],
      cache: 'no-store',
      maxRetries: POSTING_REQUEST_ENVELOPE.maxRetries,
      maxRedirects: POSTING_REQUEST_ENVELOPE.detailMaxRedirects,
    });
  });

  it('a job the board marks unlisted is closed, exactly as the adapter drops it', async () => {
    const http = new Fixture(board([job(JOB_ID, { isListed: false })]));
    expect(await observePosting(http, POSTING_URL, { now })).toMatchObject({ outcome: 'closed', reason: 'not_listed' });
  });

  it('a listed job is open, with the same text (and hash) the Ashby adapter stored at scan time', async () => {
    const listed = job(JOB_ID);
    const http = new Fixture(board([job(OTHER_ID), listed]));
    const observation = await observePosting(http, POSTING_URL, { now });
    expect(observation).toMatchObject({ outcome: 'open', reason: 'verified_open', source: 'ashby', notModified: false });

    const source = { provider: 'ashby', boardIdentifier: 'itlabs' } as unknown as CareerSourceDescriptor;
    const scanned = await new AshbyAdapter(new Fixture(board([listed]))).listVacancies(source);
    const stored = scanned.vacancies[0]?.description ?? '';
    expect(stored).toContain('Compensation: EUR 60K');
    expect(observation.text).toBe(stored);
    expect(observation.contentHash).toBe(postingContentHash(stored));
  });

  it('matches the job by its posting URL when the board omits the id field', async () => {
    const { id: _id, ...withoutId } = job(JOB_ID);
    const http = new Fixture(board([withoutId]));
    expect((await observePosting(http, POSTING_URL, { now })).outcome).toBe('open');
  });

  it('never sends or keeps board validators: they say nothing about one posting', async () => {
    const http = new Fixture(board([job(JOB_ID)]));
    const observation = await observePosting(http, POSTING_URL, { now, validators: { etag: '"stale"' } });
    expect(new Headers(http.calls[0]?.options?.headers).get('if-none-match')).toBeNull();
    expect(observation.outcome).toBe('open');
  });

  it('a missing board (404) is "could not check", never closure', async () => {
    const http = new Fixture(board([], 404));
    expect(await observePosting(http, POSTING_URL, { now })).toMatchObject({ outcome: 'unable', reason: 'board_not_found' });
  });

  it('an unreadable or unexpected board answer is "could not check", never closure', async () => {
    for (const body of ['not json', JSON.stringify({ jobs: 'nope' }), JSON.stringify([])]) {
      const http = new Fixture((url) => ({ status: 200, finalUrl: url, headers: {}, body }));
      expect(await observePosting(http, POSTING_URL, { now }), body).toMatchObject({
        outcome: 'unable',
        reason: 'unexpected_response',
      });
    }
    for (const status of [403, 429, 503]) {
      const http = new Fixture(board([], status));
      expect((await observePosting(http, POSTING_URL, { now })).outcome, String(status)).toBe('unable');
    }
  });

  it('a listed job with no description text is "could not check", never open or closed', async () => {
    const http = new Fixture(board([job(JOB_ID, { descriptionHtml: '<p></p>', compensation: null })]));
    expect(await observePosting(http, POSTING_URL, { now })).toMatchObject({ outcome: 'unable', reason: 'empty_content' });
  });

  it('the verifier answers through the same path', async () => {
    const http = new Fixture(board([job(OTHER_ID)]));
    const observation = await createPostingVerifier(http, { now }).verify({ url: POSTING_URL });
    expect(observation).toMatchObject({ outcome: 'closed', reason: 'not_listed', logicalRequests: 1 });
  });
});

const publicResolver: DnsResolver = () => Promise.resolve([{ address: '93.184.216.34', family: 4 }]);

function realClient(handler: (url: string) => Response) {
  const physical: string[] = [];
  const fetchFn = vi.fn(async (input: string | URL | Request) =>
    handler(input instanceof Request ? input.url : input.toString()),
  );
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
  });
  return { http: createAtsHttpClient(safe), physical };
}

describe('the Ashby request envelope, on the real SafeHttpClient', () => {
  it('an omitted job is closed with exactly one physical request', async () => {
    const { http, physical } = realClient(
      () =>
        new Response(JSON.stringify({ jobs: [job(OTHER_ID)] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    );
    expect(await observePosting(http, POSTING_URL, { now })).toMatchObject({ outcome: 'closed', reason: 'not_listed' });
    expect(physical).toHaveLength(1);
    expect(physical[0]?.startsWith('https://api.ashbyhq.com/')).toBe(true);
  });

  it('a server error is not retried, and redirects stay inside the standard envelope', async () => {
    const failing = realClient(() => new Response('{}', { status: 503 }));
    expect(await observePosting(failing.http, POSTING_URL, { now })).toMatchObject({ outcome: 'unable', reason: 'server_error' });
    expect(failing.physical).toHaveLength(1);

    let hop = 0;
    const looping = realClient(() => {
      hop += 1;
      return new Response(null, { status: 302, headers: { location: `/posting-api/job-board/itlabs?hop=${hop}` } });
    });
    expect((await observePosting(looping.http, POSTING_URL, { now })).outcome).toBe('unable');
    expect(looping.physical).toHaveLength(POSTING_REQUEST_ENVELOPE.standard.physical);
  });

  it('a redirect off the Ashby API origin is refused, not followed', async () => {
    const { http, physical } = realClient(
      () => new Response(null, { status: 302, headers: { location: 'https://elsewhere.example/board' } }),
    );
    expect(await observePosting(http, POSTING_URL, { now })).toMatchObject({
      outcome: 'unable',
      reason: 'redirected_elsewhere',
    });
    expect(physical).toHaveLength(1);
  });
});
