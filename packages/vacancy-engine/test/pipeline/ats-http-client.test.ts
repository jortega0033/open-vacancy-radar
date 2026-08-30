import { describe, expect, it, vi } from 'vitest';

import { CrawlerHttpError } from '../../src/crawler/errors.js';
import { SafeHttpResponse } from '../../src/crawler/http-client.js';
import type { Database } from '../../src/db/client.js';
import {
  createAtsHttpClient,
  createDatabaseBackedHttpClients,
} from '../../src/pipeline/ats-http-client.js';

describe('createAtsHttpClient', () => {
  it('preserves the safe response final URL, status, headers, and decoded body', async () => {
    const headers = { 'content-type': 'application/json', etag: '"jobs-v2"' };
    const safeResponse = new SafeHttpResponse({
      requestedUrl: 'https://careers.example.com/jobs',
      url: 'https://ats.example.net/boards/acme/jobs',
      status: 200,
      headers,
      body: new TextEncoder().encode('{"role":"Développeur"}'),
      fromCache: true,
      revalidated: true,
    });
    const get = vi.fn(() => Promise.resolve(safeResponse));
    const postJson = vi.fn(() => Promise.resolve(safeResponse));
    const client = createAtsHttpClient({ get, postJson });

    await expect(client.get('https://careers.example.com/jobs')).resolves.toEqual({
      status: 200,
      finalUrl: 'https://ats.example.net/boards/acme/jobs',
      headers: safeResponse.headers,
      body: '{"role":"Développeur"}',
    });
    expect(get).toHaveBeenCalledOnce();
    expect(get).toHaveBeenCalledWith('https://careers.example.com/jobs');
  });

  it('composes ATS and streaming views over the same safe client', async () => {
    const clients = createDatabaseBackedHttpClients(
      {
        globalConcurrency: 3,
        perDomainConcurrency: 1,
        requestTimeoutMs: 500,
        requestQueueTimeoutMs: 1_000,
        maxResponseBytes: 1024,
        maxRetries: 0,
        userAgent: 'INDJobRadar/test (+personal vacancy research)',
      },
      {} as Database,
      {
        maxStreamTimeoutMs: 15 * 60 * 1_000,
        maxStreamResponseBytes: 2 * 1024 * 1024 * 1024,
      },
    );
    const safeResponse = new SafeHttpResponse({
      requestedUrl: 'https://careers.example.com/jobs',
      url: 'https://careers.example.com/jobs',
      status: 200,
      headers: {},
      body: new TextEncoder().encode('shared'),
      fromCache: false,
      revalidated: false,
    });
    const get = vi.spyOn(clients.safeClient, 'get').mockResolvedValue(safeResponse);

    await expect(clients.atsClient.get(safeResponse.url)).resolves.toMatchObject({
      status: 200,
      body: 'shared',
    });
    expect(get).toHaveBeenCalledWith(safeResponse.url);
    expect(clients.safeClient.streamGet).toBeTypeOf('function');
  });

  it('preserves categorized safe-client failures', async () => {
    const error = new CrawlerHttpError({
      category: 'blocked',
      code: 'blocked_status',
      url: 'https://careers.example.com/private?token=secret',
      detail: 'Remote server blocked or requires access',
      status: 403,
    });
    const client = createAtsHttpClient({
      get: () => Promise.reject(error),
      postJson: () => Promise.reject(error),
    });

    await expect(client.get('https://careers.example.com/private')).rejects.toBe(error);
  });

  it('forwards an adapter origin boundary to the safe HTTP client', async () => {
    const safeResponse = new SafeHttpResponse({
      requestedUrl: 'https://careers.example.com/jobs',
      url: 'https://careers.example.com/jobs',
      status: 200,
      headers: {},
      body: new TextEncoder().encode('ok'),
      fromCache: false,
      revalidated: false,
    });
    const get = vi.fn(() => Promise.resolve(safeResponse));
    const postJson = vi.fn(() => Promise.resolve(safeResponse));
    const client = createAtsHttpClient({ get, postJson });
    const options = { allowedOrigins: ['https://careers.example.com'] };

    await client.get('https://careers.example.com/jobs', options);

    expect(get).toHaveBeenCalledWith('https://careers.example.com/jobs', options);
  });

  it('forwards read-only JSON queries through the safe HTTP client', async () => {
    const safeResponse = new SafeHttpResponse({
      requestedUrl: 'https://acme.wd5.myworkdayjobs.com/wday/cxs/acme/External/jobs',
      url: 'https://acme.wd5.myworkdayjobs.com/wday/cxs/acme/External/jobs',
      status: 200,
      headers: { 'content-type': 'application/json' },
      body: new TextEncoder().encode('{"total":0,"jobPostings":[]}'),
      fromCache: false,
      revalidated: false,
    });
    const get = vi.fn(() => Promise.resolve(safeResponse));
    const postJson = vi.fn(() => Promise.resolve(safeResponse));
    const client = createAtsHttpClient({ get, postJson });
    const body = { appliedFacets: {}, limit: 20, offset: 0, searchText: '' };
    const options = { allowedOrigins: ['https://acme.wd5.myworkdayjobs.com'] };

    await expect(client.postJson(safeResponse.url, body, options)).resolves.toMatchObject({
      status: 200,
      body: '{"total":0,"jobPostings":[]}',
    });
    expect(postJson).toHaveBeenCalledWith(safeResponse.url, body, options);
    expect(get).not.toHaveBeenCalled();
  });
});
