import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { noopLogger, ProviderRegistry } from '@agent-dock/agent-runtime';
import type { AgentEvent, ProviderId, ProviderStatus } from '@agent-dock/shared';
import type { AgentProvider, ProviderSessionHandle, StartSessionOptions } from '@agent-dock/agent-runtime';
import { ACTIVE_SESSION_LIMITS, ActiveSessionLimiter } from '../src/active-session-limiter.js';
import { SessionLineageStore, type RetentionPolicy } from '../src/session-lineage-store.js';
import { SessionManager } from '../src/session-manager.js';
import { buildServer } from '../src/server.js';

const TOKEN = 'limits-token';
const AUTH = { authorization: `Bearer ${TOKEN}` };

/**
 * A provider whose `detect()` can be parked on a caller-controlled promise, and whose event stream
 * is driven event-by-event.
 *
 * The parked `detect()` is the point of the whole fixture: `POST /sessions` genuinely awaits
 * `providerImpl.detect()` on the resume path, so parking it there produces a *real* interleaving of
 * five in-flight HTTP requests inside one Fastify instance -- the exact shape of the race the
 * limiter has to survive. A test that merely called `create()` five times in a row would prove
 * nothing about concurrency.
 */
class ControllableProvider implements AgentProvider {
  readonly id: ProviderId;
  readonly name = 'Controllable';
  readonly startedOptions: StartSessionOptions[] = [];
  readonly sessions = new Map<string, ReturnType<typeof makeChannel>>();
  /** When set, `detect()` awaits it before resolving. */
  detectGate: Promise<void> | undefined;
  /** When true, the event generator throws instead of yielding a terminal event. */
  throwOnIterate = false;

  constructor(id: ProviderId) {
    this.id = id;
  }

  async detect(): Promise<ProviderStatus> {
    if (this.detectGate) await this.detectGate;
    return {
      id: this.id,
      name: this.name,
      installed: true,
      authenticated: 'authenticated',
      capabilities: { resume: true, cancellation: true, tools: true, usage: true, thinking: true },
    };
  }

  startSession(options: StartSessionOptions): ProviderSessionHandle {
    this.startedOptions.push(options);
    const channel = makeChannel(this.throwOnIterate);
    this.sessions.set(options.sessionId, channel);
    return channel.handle;
  }
}

function makeChannel(throwOnIterate: boolean) {
  const queue: AgentEvent[] = [];
  const waiters: Array<(result: IteratorResult<AgentEvent>) => void> = [];
  let closed = false;
  let cancelled = false;

  function push(event: AgentEvent): void {
    const waiter = waiters.shift();
    if (waiter) waiter({ value: event, done: false });
    else queue.push(event);
  }

  function finish(): void {
    if (closed) return;
    closed = true;
    for (const waiter of waiters.splice(0)) waiter({ value: undefined, done: true });
  }

  async function* events(): AsyncGenerator<AgentEvent, void, void> {
    if (throwOnIterate) throw new Error('provider stream exploded');
    while (true) {
      if (queue.length > 0) {
        yield queue.shift() as AgentEvent;
        continue;
      }
      if (closed) return;
      const result = await new Promise<IteratorResult<AgentEvent>>((resolve) => waiters.push(resolve));
      if (result.done) return;
      yield result.value;
    }
  }

  const handle: ProviderSessionHandle = {
    events: events(),
    cancel: async () => {
      cancelled = true;
      push({ type: 'session.cancelled' });
      finish();
    },
  };

  return { handle, push, finish, isCancelled: () => cancelled };
}

interface Harness {
  app: FastifyInstance;
  manager: SessionManager;
  limiter: ActiveSessionLimiter;
  store: SessionLineageStore;
  claude: ControllableProvider;
  codex: ControllableProvider;
  stateRoot: string;
}

let harnesses: Harness[] = [];
let cwd: string;

function setup(retention?: RetentionPolicy): Harness {
  const stateRoot = mkdtempSync(join(tmpdir(), 'agent-dock-limits-'));
  const claude = new ControllableProvider('claude');
  const codex = new ControllableProvider('codex');
  const registry = new ProviderRegistry();
  registry.register(claude);
  registry.register(codex);

  const store = new SessionLineageStore({ stateRoot, ...(retention ? { retention } : {}) });
  const limiter = new ActiveSessionLimiter();
  const manager = new SessionManager(registry, noopLogger, undefined, limiter, store);
  const app = buildServer({
    registry,
    sessionManager: manager,
    token: TOKEN,
    logger: noopLogger,
    v2: { store, limiter },
  });

  const harness: Harness = { app, manager, limiter, store, claude, codex, stateRoot };
  harnesses.push(harness);
  return harness;
}

function createBody(provider: ProviderId, extra: Record<string, unknown> = {}) {
  return { provider, cwd, prompt: 'hello', ...extra };
}

beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), 'agent-dock-limits-cwd-'));
});

afterEach(async () => {
  for (const harness of harnesses) {
    await harness.manager.cancelAll(500).catch(() => {});
    await harness.app.close().catch(() => {});
    rmSync(harness.stateRoot, { recursive: true, force: true });
  }
  harnesses = [];
  rmSync(cwd, { recursive: true, force: true });
});

describe('POST /sessions: 409 at the active-session limit', () => {
  it('refuses the third session for one provider with the documented body shape', async () => {
    const { app } = setup();

    for (let i = 0; i < ACTIVE_SESSION_LIMITS.perProvider; i++) {
      const ok = await app.inject({ method: 'POST', url: '/sessions', headers: AUTH, payload: createBody('claude') });
      expect(ok.statusCode).toBe(201);
    }

    const refused = await app.inject({ method: 'POST', url: '/sessions', headers: AUTH, payload: createBody('claude') });

    expect(refused.statusCode).toBe(409);
    expect(refused.json()).toEqual({
      error: 'too many active sessions',
      code: 'active_session_limit',
      scope: 'provider',
      capacity: {
        global: { active: 2, limit: 4 },
        provider: { active: 2, limit: 2 },
      },
    });
  });

  it('refuses the fifth session across providers with scope "global"', async () => {
    const { app } = setup();
    for (const provider of ['claude', 'claude', 'codex', 'codex'] as ProviderId[]) {
      const ok = await app.inject({ method: 'POST', url: '/sessions', headers: AUTH, payload: createBody(provider) });
      expect(ok.statusCode).toBe(201);
    }

    const refused = await app.inject({ method: 'POST', url: '/sessions', headers: AUTH, payload: createBody('codex') });
    expect(refused.statusCode).toBe(409);
    expect(refused.json().scope).toBe('global');
    expect(refused.json().capacity.global).toEqual({ active: 4, limit: 4 });
  });

  it('creates no durable record and never calls startSession for a refused request', async () => {
    const { app, claude, store } = setup();
    await app.inject({ method: 'POST', url: '/sessions', headers: AUTH, payload: createBody('claude') });
    await app.inject({ method: 'POST', url: '/sessions', headers: AUTH, payload: createBody('claude') });

    const startedBefore = claude.startedOptions.length;
    const recordsBefore = store.stats().records;

    const refused = await app.inject({ method: 'POST', url: '/sessions', headers: AUTH, payload: createBody('claude') });

    expect(refused.statusCode).toBe(409);
    expect(claude.startedOptions.length).toBe(startedBefore);
    expect(store.stats().records).toBe(recordsBefore);
  });
});

describe('POST /sessions: 507 when the durable store has no room', () => {
  /**
   * The store is given a one-record budget and that record is spent on a session that is still
   * running, so retention has nothing it is allowed to evict (an active lineage is never a
   * candidate). This is the only way the 507 path can be reached honestly: it is not a disk-space
   * condition, it is "the retention budget is full and every lineage in it is still in use".
   */
  it('refuses with the documented body, writes no record, and never starts a provider', async () => {
    const { app, claude, store, limiter } = setup({ maxRecords: 1 });

    const first = await app.inject({ method: 'POST', url: '/sessions', headers: AUTH, payload: createBody('claude') });
    expect(first.statusCode).toBe(201);
    expect(store.stats().records).toBe(1);

    const startedBefore = claude.startedOptions.length;

    const refused = await app.inject({ method: 'POST', url: '/sessions', headers: AUTH, payload: createBody('claude') });

    expect(refused.statusCode).toBe(507);
    expect(refused.json()).toEqual({ error: 'session storage is full', code: 'storage_full' });
    // Refused before anything irreversible: no provider process, no record, and -- because the
    // reservation is released on the way out -- no permanently shrunk capacity either.
    expect(claude.startedOptions.length).toBe(startedBefore);
    expect(store.stats().records).toBe(1);
    expect(store.get(first.json().id)).toBeDefined();
    expect(limiter.snapshot().global).toBe(1);
  });

  it('admits the next session once the one holding the budget has finished', async () => {
    const { app, claude, store } = setup({ maxRecords: 1 });
    const first = await app.inject({ method: 'POST', url: '/sessions', headers: AUTH, payload: createBody('claude') });
    expect(
      (await app.inject({ method: 'POST', url: '/sessions', headers: AUTH, payload: createBody('claude') })).statusCode,
    ).toBe(507);

    const channel = claude.sessions.get(first.json().id)!;
    channel.push({ type: 'session.completed' });
    channel.finish();
    await new Promise((resolve) => setTimeout(resolve, 20));

    // Now the first lineage is terminal, so it is evictable and the budget can be reclaimed. A 507
    // is a "not right now", never a wedged store.
    const admitted = await app.inject({ method: 'POST', url: '/sessions', headers: AUTH, payload: createBody('claude') });
    expect(admitted.statusCode).toBe(201);
    expect(store.get(first.json().id)).toBeUndefined();
    expect(store.get(admitted.json().id)).toBeDefined();
  });
});

describe('POST /sessions: the concurrency race', () => {
  /**
   * Five requests are put genuinely in flight at once by parking every one of them inside the
   * route's real `await providerImpl.detect()`, then released together. If the limiter's
   * check-then-increment were not atomic on the event loop, every request would read the same
   * pre-increment counters and all five would be admitted.
   */
  async function runRace(): Promise<{ created: number; refused: number; started: number }> {
    const { app, claude, codex } = setup();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    claude.detectGate = gate;
    codex.detectGate = gate;

    const providers: ProviderId[] = ['claude', 'claude', 'codex', 'codex', 'codex'];
    const inFlight = providers.map((provider) =>
      app.inject({
        method: 'POST',
        url: '/sessions',
        headers: AUTH,
        // The resume path is the one that actually awaits detect(), which is what creates the
        // suspension point every request has to be parked on.
        payload: createBody(provider, { resumeProviderSessionId: 'prior-thread' }),
      }),
    );

    release();
    const responses = await Promise.all(inFlight);

    const created = responses.filter((res) => res.statusCode === 201).length;
    const refused = responses.filter((res) => res.statusCode === 409).length;
    for (const res of responses) expect([201, 409]).toContain(res.statusCode);
    return { created, refused, started: claude.startedOptions.length + codex.startedOptions.length };
  }

  it('admits exactly the budget and refuses the rest, repeatedly', async () => {
    for (let attempt = 0; attempt < 25; attempt++) {
      const result = await runRace();
      expect(result).toEqual({ created: 4, refused: 1, started: 4 });
    }
  }, 60_000);
});

describe('shared accounting across protocol versions', () => {
  it('counts v1 and v2 creates against the same budget', () => {
    const { manager, limiter } = setup();
    manager.create('claude', cwd, 'a', undefined, undefined, 1);
    manager.create('claude', cwd, 'b', undefined, undefined, 2);
    manager.create('codex', cwd, 'c', undefined, undefined, 2);
    manager.create('codex', cwd, 'd', undefined, undefined, 1);

    expect(limiter.snapshot().global).toBe(4);
    expect(() => manager.create('claude', cwd, 'e', undefined, undefined, 2)).toThrow(/too many active sessions/);
  });

  it('records the protocol version each session was created under', () => {
    const { manager, store } = setup();
    const v1 = manager.create('claude', cwd, 'a', undefined, undefined, 1);
    const v2 = manager.create('claude', cwd, 'b', undefined, undefined, 2);
    expect(store.get(v1.id)?.protocolVersion).toBe(1);
    expect(store.get(v2.id)?.protocolVersion).toBe(2);
  });
});

describe('every terminal path returns capacity', () => {
  const tick = (ms = 10) => new Promise((resolve) => setTimeout(resolve, ms));

  it.each([
    ['session.completed', { type: 'session.completed' } as AgentEvent],
    ['session.failed', { type: 'session.failed', message: 'boom' } as AgentEvent],
    ['session.cancelled', { type: 'session.cancelled' } as AgentEvent],
  ])('releases the reservation on %s', async (_name, terminal) => {
    const { manager, limiter, claude } = setup();
    const session = manager.create('claude', cwd, 'x');
    expect(limiter.holds(session.id)).toBe(true);

    const channel = claude.sessions.get(session.id)!;
    channel.push(terminal);
    channel.finish();
    await tick();

    expect(limiter.holds(session.id)).toBe(false);
    expect(limiter.snapshot().global).toBe(0);
  });

  it('releases the reservation when the provider stream throws instead of ending', async () => {
    const { manager, limiter, claude } = setup();
    claude.throwOnIterate = true;
    const session = manager.create('claude', cwd, 'x');
    await tick(20);
    expect(limiter.holds(session.id)).toBe(false);
  });

  it('releases the reservation on DELETE /sessions/:id', async () => {
    const { app, limiter } = setup();
    const created = await app.inject({ method: 'POST', url: '/sessions', headers: AUTH, payload: createBody('claude') });
    const id = created.json().id;
    expect(limiter.holds(id)).toBe(true);

    const deleted = await app.inject({ method: 'DELETE', url: `/sessions/${id}`, headers: AUTH });
    expect(deleted.statusCode).toBe(204);
    await tick();
    expect(limiter.holds(id)).toBe(false);
  });

  it('releases the reservation on POST /sessions/:id/cancel', async () => {
    const { app, limiter } = setup();
    const created = await app.inject({ method: 'POST', url: '/sessions', headers: AUTH, payload: createBody('claude') });
    const id = created.json().id;

    const cancelled = await app.inject({ method: 'POST', url: `/sessions/${id}/cancel`, headers: AUTH });
    expect(cancelled.statusCode).toBe(202);
    await tick();
    expect(limiter.holds(id)).toBe(false);
  });

  it('releases every reservation on POST /sessions/cancel-all', async () => {
    const { app, limiter } = setup();
    for (const provider of ['claude', 'claude', 'codex', 'codex'] as ProviderId[]) {
      await app.inject({ method: 'POST', url: '/sessions', headers: AUTH, payload: createBody(provider) });
    }
    expect(limiter.snapshot().global).toBe(4);

    await app.inject({ method: 'POST', url: '/sessions/cancel-all', headers: AUTH });
    await tick(20);
    expect(limiter.snapshot()).toEqual({ global: 0, byProvider: {} });
  });

  it('releases every reservation on daemon shutdown (cancelAll)', async () => {
    const { manager, limiter } = setup();
    manager.create('claude', cwd, 'a');
    manager.create('codex', cwd, 'b');
    expect(limiter.snapshot().global).toBe(2);

    await manager.cancelAll(1_000);
    await tick(20);
    expect(limiter.snapshot()).toEqual({ global: 0, byProvider: {} });
  });

  it('frees a slot a refused request can then use', async () => {
    const { app, limiter } = setup();
    const first = await app.inject({ method: 'POST', url: '/sessions', headers: AUTH, payload: createBody('claude') });
    await app.inject({ method: 'POST', url: '/sessions', headers: AUTH, payload: createBody('claude') });
    expect(
      (await app.inject({ method: 'POST', url: '/sessions', headers: AUTH, payload: createBody('claude') })).statusCode,
    ).toBe(409);

    await app.inject({ method: 'POST', url: `/sessions/${first.json().id}/cancel`, headers: AUTH });
    await tick(20);

    expect(limiter.snapshot().global).toBe(1);
    expect(
      (await app.inject({ method: 'POST', url: '/sessions', headers: AUTH, payload: createBody('claude') })).statusCode,
    ).toBe(201);
  });
});

describe('route inventory', () => {
  const V1_ROUTES: Array<[string, string]> = [
    ['GET', '/health'],
    ['GET', '/providers'],
    ['GET', '/providers/:providerId'],
    ['POST', '/sessions'],
    ['GET', '/sessions/:sessionId'],
    ['GET', '/sessions/:sessionId/events'],
    ['POST', '/sessions/:sessionId/cancel'],
    ['POST', '/sessions/cancel-all'],
    ['DELETE', '/sessions/:sessionId'],
  ];

  const V2_ROUTES: Array<[string, string]> = [
    ['GET', '/v2/providers'],
    ['GET', '/v2/providers/:providerId'],
    ['GET', '/v2/sessions'],
    ['GET', '/v2/sessions/:sessionId'],
    ['GET', '/v2/sessions/:sessionId/events'],
  ];

  it('registers every v1 route unchanged plus exactly five v2 GET routes', async () => {
    const { app } = setup();
    await app.ready();

    for (const [method, url] of [...V1_ROUTES, ...V2_ROUTES]) {
      expect(app.hasRoute({ method: method as 'GET', url }), `${method} ${url} is missing`).toBe(true);
    }
    expect(V2_ROUTES).toHaveLength(5);
  });

  it('exposes no v2 write surface: creation and control stay on v1', async () => {
    const { app } = setup();
    await app.ready();

    const notShipped: Array<[string, string]> = [
      ['POST', '/v2/sessions'],
      ['DELETE', '/v2/sessions/00000000-0000-4000-8000-000000000000'],
      ['POST', '/v2/sessions/00000000-0000-4000-8000-000000000000/cancel'],
      ['POST', '/v2/sessions/cancel-all'],
      ['GET', '/v2/mcp'],
      ['POST', '/v2/mcp'],
      ['GET', '/v2/health'],
      ['POST', '/v2/providers'],
    ];

    for (const [method, url] of notShipped) {
      const res = await app.inject({ method: method as 'GET', url, headers: AUTH, payload: {} });
      expect(res.statusCode, `${method} ${url} should not exist`).toBe(404);
    }
  });

  it('registers no v2 route at all when there is no durable store', async () => {
    const registry = new ProviderRegistry();
    registry.register(new ControllableProvider('claude'));
    const manager = new SessionManager(registry, noopLogger);
    const app = buildServer({ registry, sessionManager: manager, token: TOKEN, logger: noopLogger });
    await app.ready();

    for (const [, url] of V2_ROUTES) {
      expect(app.hasRoute({ method: 'GET', url })).toBe(false);
    }
    expect((await app.inject({ method: 'GET', url: '/health' })).json().supportedProtocolVersions).toEqual([1]);
    await app.close();
  });

  it('advertises [1, 2] when the durable store is active', async () => {
    const { app } = setup();
    const health = (await app.inject({ method: 'GET', url: '/health' })).json();
    expect(health.protocolVersion).toBe(1);
    expect(health.supportedProtocolVersions).toEqual([1, 2]);
  });
});

describe('v2 read routes', () => {
  it('lists sessions newest-first with capacity, and pages by opaque cursor', async () => {
    const { app, manager } = setup();
    const first = manager.create('claude', cwd, 'a');
    await new Promise((resolve) => setTimeout(resolve, 5));
    const second = manager.create('claude', cwd, 'b');

    const page = await app.inject({ method: 'GET', url: '/v2/sessions?limit=1', headers: AUTH });
    expect(page.statusCode).toBe(200);
    const body = page.json();
    expect(body.schemaVersion).toBe(1);
    expect(body.sessions).toHaveLength(1);
    expect(body.sessions[0].id).toBe(second.id);
    expect(body.capacity.global).toEqual({ active: 2, limit: 4 });
    expect(body.nextCursor).toMatch(/^[A-Za-z0-9_-]+$/);

    const next = await app.inject({
      method: 'GET',
      url: `/v2/sessions?limit=1&cursor=${body.nextCursor}`,
      headers: AUTH,
    });
    expect(next.json().sessions[0].id).toBe(first.id);
  });

  it('400s a malformed cursor and a cursor that addresses nothing', async () => {
    const { app } = setup();
    const malformed = await app.inject({ method: 'GET', url: '/v2/sessions?cursor=not%20a%20cursor', headers: AUTH });
    expect(malformed.statusCode).toBe(400);
    expect(malformed.json().code).toBe('invalid_cursor');

    const unknown = await app.inject({
      method: 'GET',
      url: `/v2/sessions?cursor=${Buffer.from('nope', 'utf8').toString('base64url')}`,
      headers: AUTH,
    });
    expect(unknown.statusCode).toBe(400);
    expect(unknown.json().code).toBe('invalid_cursor');
  });

  it('returns one session view and 404s an unknown id', async () => {
    const { app, manager } = setup();
    const session = manager.create('claude', cwd, 'a');

    const found = await app.inject({ method: 'GET', url: `/v2/sessions/${session.id}`, headers: AUTH });
    expect(found.statusCode).toBe(200);
    expect(found.json().session).toMatchObject({
      id: session.id,
      provider: 'claude',
      transportId: 'legacy-one-shot',
      acceptedWork: 'unknown',
      continuationKind: 'fresh',
    });
    expect(found.json().session).not.toHaveProperty('prompt');

    const missing = await app.inject({
      method: 'GET',
      url: '/v2/sessions/00000000-0000-4000-8000-000000000000',
      headers: AUTH,
    });
    expect(missing.statusCode).toBe(404);
    expect(missing.json().code).toBe('session_not_found');
  });

  it('returns a JSON page of redacted events, not an SSE stream', async () => {
    const { app, manager, claude } = setup();
    const session = manager.create('claude', cwd, 'a');
    const channel = claude.sessions.get(session.id)!;
    channel.push({ type: 'assistant.message', text: 'secret text' });
    channel.push({ type: 'session.completed' });
    channel.finish();
    await new Promise((resolve) => setTimeout(resolve, 20));

    const res = await app.inject({ method: 'GET', url: `/v2/sessions/${session.id}/events`, headers: AUTH });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('application/json');
    const body = res.json();
    expect(body.sessionId).toBe(session.id);
    expect(body.events.map((event: { type: string }) => event.type)).toEqual([
      'assistant.message',
      'session.completed',
    ]);
    expect(res.payload).not.toContain('secret text');
  });

  it('serves the v2 provider views and validates the provider id', async () => {
    const { app } = setup();
    const all = await app.inject({ method: 'GET', url: '/v2/providers', headers: AUTH });
    expect(all.statusCode).toBe(200);
    expect(all.json().providers.map((p: { id: string }) => p.id).sort()).toEqual(['claude', 'codex']);
    expect(all.json().providers[0]).toMatchObject({ transportId: 'legacy-one-shot' });

    const one = await app.inject({ method: 'GET', url: '/v2/providers/claude', headers: AUTH });
    expect(one.json().provider.id).toBe('claude');

    const bad = await app.inject({ method: 'GET', url: '/v2/providers/nonsense', headers: AUTH });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().code).toBe('invalid_provider_id');
  });

  it('404s a valid-but-unregistered provider id', async () => {
    const registry = new ProviderRegistry();
    registry.register(new ControllableProvider('claude'));
    const stateRoot = mkdtempSync(join(tmpdir(), 'agent-dock-limits-'));
    const store = new SessionLineageStore({ stateRoot });
    const limiter = new ActiveSessionLimiter();
    const manager = new SessionManager(registry, noopLogger, undefined, limiter, store);
    const app = buildServer({ registry, sessionManager: manager, token: TOKEN, logger: noopLogger, v2: { store, limiter } });

    const res = await app.inject({ method: 'GET', url: '/v2/providers/codex', headers: AUTH });
    expect(res.statusCode).toBe(404);
    expect(res.json().code).toBe('provider_not_found');

    await app.close();
    rmSync(stateRoot, { recursive: true, force: true });
  });

  it('requires the bearer token like every other privileged route', async () => {
    const { app } = setup();
    for (const url of ['/v2/sessions', '/v2/providers']) {
      expect((await app.inject({ method: 'GET', url })).statusCode).toBe(401);
    }
  });
});
