import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FakeProvider, FAKE_PROVIDER_CAPABILITIES, noopLogger, ProviderRegistry } from '@agent-dock/agent-runtime';
import type { FastifyInstance } from 'fastify';
import { ApplicationQueueStore } from '../src/application-queue-store.js';
import { buildServer } from '../src/server.js';
import { SessionManager } from '../src/session-manager.js';

const TOKEN = 'daemon-test-token';
const AUTH = { authorization: `Bearer ${TOKEN}` };

let stateRoot: string;

beforeEach(() => {
  stateRoot = mkdtempSync(join(tmpdir(), 'ovr-v2-applications-'));
});

afterEach(() => {
  rmSync(stateRoot, { recursive: true, force: true });
});

function setup(): { app: FastifyInstance; store: ApplicationQueueStore } {
  const registry = new ProviderRegistry();
  registry.register(
    new FakeProvider('claude', {
      id: 'claude',
      name: 'Claude',
      installed: true,
      authenticated: 'authenticated',
      capabilities: FAKE_PROVIDER_CAPABILITIES,
    }),
  );
  const store = new ApplicationQueueStore({ stateRoot, logger: noopLogger });
  const app = buildServer({
    registry,
    sessionManager: new SessionManager(registry, noopLogger),
    token: TOKEN,
    logger: noopLogger,
    applicationQueue: store,
  });
  return { app, store };
}

describe('v2 application queue routes: auth and downgrade', () => {
  it('requires the daemon bearer token like every other route', async () => {
    const { app } = setup();
    const res = await app.inject({ method: 'GET', url: '/v2/applications' });
    expect(res.statusCode).toBe(401);
  });

  it('is not registered at all when no applicationQueue store is supplied', async () => {
    const registry = new ProviderRegistry();
    const app = buildServer({
      registry,
      sessionManager: new SessionManager(registry, noopLogger),
      token: TOKEN,
      logger: noopLogger,
    });
    const res = await app.inject({ method: 'GET', url: '/v2/applications', headers: AUTH });
    expect(res.statusCode).toBe(404);
  });
});

describe('v2 application queue routes: enqueue, list, get', () => {
  it('enqueues an attempt and lists it back', async () => {
    const { app } = setup();
    const created = await app.inject({
      method: 'POST',
      url: '/v2/applications',
      headers: AUTH,
      payload: { attemptId: 'attempt-1' },
    });
    expect(created.statusCode).toBe(201);
    expect(created.json().entry).toMatchObject({ attemptId: 'attempt-1', state: 'queued' });

    const list = await app.inject({ method: 'GET', url: '/v2/applications', headers: AUTH });
    expect(list.json().entries).toHaveLength(1);
    expect(list.json().lease).toBeNull();
  });

  it('rejects an enqueue body missing attemptId', async () => {
    const { app } = setup();
    const res = await app.inject({ method: 'POST', url: '/v2/applications', headers: AUTH, payload: {} });
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe('invalid_body');
  });

  it('returns 404 for an unknown attempt id', async () => {
    const { app } = setup();
    const res = await app.inject({ method: 'GET', url: '/v2/applications/nope', headers: AUTH });
    expect(res.statusCode).toBe(404);
    expect(res.json().code).toBe('application_not_found');
  });
});

describe('v2 application queue routes: pause/resume/skip/cancel', () => {
  it('pauses and resumes an attempt over HTTP', async () => {
    const { app } = setup();
    await app.inject({ method: 'POST', url: '/v2/applications', headers: AUTH, payload: { attemptId: 'attempt-1' } });

    const paused = await app.inject({ method: 'POST', url: '/v2/applications/attempt-1/pause', headers: AUTH });
    expect(paused.statusCode).toBe(200);
    expect(paused.json().entry.state).toBe('paused');

    const resumed = await app.inject({ method: 'POST', url: '/v2/applications/attempt-1/resume', headers: AUTH });
    expect(resumed.json().entry.state).toBe('queued');
  });

  it('skips and cancels each report the entry as cancelled', async () => {
    const { app } = setup();
    await app.inject({ method: 'POST', url: '/v2/applications', headers: AUTH, payload: { attemptId: 'attempt-1' } });
    await app.inject({ method: 'POST', url: '/v2/applications', headers: AUTH, payload: { attemptId: 'attempt-2' } });

    const skipped = await app.inject({ method: 'POST', url: '/v2/applications/attempt-1/skip', headers: AUTH });
    expect(skipped.json().entry.state).toBe('cancelled');

    const cancelled = await app.inject({ method: 'POST', url: '/v2/applications/attempt-2/cancel', headers: AUTH });
    expect(cancelled.json().entry.state).toBe('cancelled');
  });

  it('returns 404 for a transition on an unknown attempt id', async () => {
    const { app } = setup();
    const res = await app.inject({ method: 'POST', url: '/v2/applications/nope/pause', headers: AUTH });
    expect(res.statusCode).toBe(404);
    expect(res.json().code).toBe('application_not_found');
  });

  it('returns 409 with the from-state and action for an invalid transition', async () => {
    const { app } = setup();
    await app.inject({ method: 'POST', url: '/v2/applications', headers: AUTH, payload: { attemptId: 'attempt-1' } });
    const res = await app.inject({ method: 'POST', url: '/v2/applications/attempt-1/resume', headers: AUTH });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ code: 'invalid_transition', from: 'queued', action: 'resume' });
  });
});

describe('v2 application queue routes: lease acquire/release', () => {
  it('acquires the oldest queued attempt over HTTP', async () => {
    const { app } = setup();
    await app.inject({ method: 'POST', url: '/v2/applications', headers: AUTH, payload: { attemptId: 'attempt-1' } });

    const res = await app.inject({ method: 'POST', url: '/v2/applications/lease/acquire', headers: AUTH });
    expect(res.statusCode).toBe(200);
    expect(res.json().lease).toMatchObject({ attemptId: 'attempt-1' });
  });

  it('reports lease: null rather than an error when nothing is schedulable', async () => {
    const { app } = setup();
    const res = await app.inject({ method: 'POST', url: '/v2/applications/lease/acquire', headers: AUTH });
    expect(res.statusCode).toBe(200);
    expect(res.json().lease).toBeNull();
  });

  it('releases a lease and moves the entry to done', async () => {
    const { app } = setup();
    await app.inject({ method: 'POST', url: '/v2/applications', headers: AUTH, payload: { attemptId: 'attempt-1' } });
    const acquired = await app.inject({ method: 'POST', url: '/v2/applications/lease/acquire', headers: AUTH });
    const leaseId = acquired.json().lease.leaseId as string;

    const released = await app.inject({
      method: 'POST',
      url: '/v2/applications/lease/release',
      headers: AUTH,
      payload: { leaseId, outcome: 'completed' },
    });
    expect(released.statusCode).toBe(204);

    const entry = await app.inject({ method: 'GET', url: '/v2/applications/attempt-1', headers: AUTH });
    expect(entry.json().entry.state).toBe('done');
  });

  it('rejects a release body with an invalid outcome', async () => {
    const { app } = setup();
    const res = await app.inject({
      method: 'POST',
      url: '/v2/applications/lease/release',
      headers: AUTH,
      payload: { leaseId: 'x', outcome: 'bogus' },
    });
    expect(res.statusCode).toBe(400);
  });
});

describe('v2 application queue routes: live SSE stream', () => {
  it('replays history then delivers a live event, over a real socket', async () => {
    const { app, store } = setup();
    store.enqueue('attempt-1');
    await app.listen({ port: 0, host: '127.0.0.1' });
    try {
      const address = app.server.address();
      const port = typeof address === 'object' && address ? address.port : 0;

      const controller = new AbortController();
      const res = await fetch(`http://127.0.0.1:${port}/v2/applications/events`, {
        headers: AUTH,
        signal: controller.signal,
      });
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toContain('text/event-stream');

      const reader = res.body!.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      // The replayed 'enqueued' event should already be there from the history buffer.
      while (!buffer.includes('event: enqueued')) {
        const { value, done } = await reader.read();
        if (done) throw new Error('stream ended before the replayed event arrived');
        buffer += decoder.decode(value, { stream: true });
      }
      expect(buffer).toContain('attempt-1');

      // Trigger a live event and confirm it arrives over the same open connection.
      store.acquireNextLease();
      while (!buffer.includes('event: lease_acquired')) {
        const { value, done } = await reader.read();
        if (done) throw new Error('stream ended before the live event arrived');
        buffer += decoder.decode(value, { stream: true });
      }

      controller.abort();
    } finally {
      await app.close();
    }
  });
});
