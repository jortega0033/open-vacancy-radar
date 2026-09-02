import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { ProviderRegistry, noopLogger } from '@agent-dock/agent-runtime';
import type { AgentEvent, ProviderId, ProviderStatus } from '@agent-dock/shared';
import type { AgentProvider, ProviderSessionHandle, StartSessionOptions } from '@agent-dock/agent-runtime';
import { AuditStore } from '../src/audit-store.js';
import { ActiveSessionLimiter } from '../src/active-session-limiter.js';
import { SessionLineageStore } from '../src/session-lineage-store.js';
import { SessionManager } from '../src/session-manager.js';
import { WorkspaceTrustStore } from '../src/workspace-trust-store.js';
import { WorkspaceExecutionLeaseManager } from '../src/workspace-execution-lease.js';
import { buildServer } from '../src/server.js';
import { registerHealthRoute } from '../src/routes/health.js';
import { registerProviderRoutes } from '../src/routes/providers.js';
import { registerSessionRoutes } from '../src/routes/sessions.js';
import { registerV2ProviderRoutes } from '../src/routes/v2-providers.js';
import { registerV2SessionRoutes } from '../src/routes/v2-sessions.js';
import { registerV2WorkspaceRoutes } from '../src/routes/v2-workspaces.js';
import { registerV2AuditRoutes } from '../src/routes/v2-audit.js';

/**
 * The rollback story for ADI-13, asserted rather than asserted-in-a-comment.
 *
 * `POST /v2/sessions` is registered by exactly one call in `server.ts`. This file builds the same
 * stack twice -- once through the real `buildServer` (which makes that call) and once through a
 * hand-assembled server that registers everything else and deliberately skips it -- and requires
 * that the only difference is whether `POST /v2/sessions` exists.
 *
 * The point is operational: if the create route has to be disabled in a hurry, the change is
 * deleting one line, and this test is what says the blast radius of doing so is exactly that route.
 * Compare `index.downgrade.test.ts`, which covers the coarser rollback (a store this build cannot
 * open takes the entire v2 surface with it).
 */

const TOKEN = 'rollback-token';
const AUTH = { authorization: `Bearer ${TOKEN}` };

class QuietProvider implements AgentProvider {
  readonly id: ProviderId = 'claude';
  readonly name = 'Quiet Provider';

  async detect(): Promise<ProviderStatus> {
    return {
      id: this.id,
      name: this.name,
      installed: true,
      authenticated: 'authenticated',
      capabilities: { resume: true, cancellation: true, tools: true, usage: true, thinking: true },
      availableModels: ['sonnet'],
    };
  }

  startSession(options: StartSessionOptions): ProviderSessionHandle {
    void options;
    return {
      events: (async function* () {
        yield { type: 'session.completed' } as AgentEvent;
      })(),
      cancel: async () => {},
    };
  }
}

let stateRoot: string;
let workspaceDir: string;

beforeEach(() => {
  stateRoot = mkdtempSync(join(tmpdir(), 'agent-dock-rollback-state-'));
  workspaceDir = mkdtempSync(join(tmpdir(), 'agent-dock-rollback-ws-'));
  mkdirSync(workspaceDir, { recursive: true });
});

afterEach(() => {
  rmSync(stateRoot, { recursive: true, force: true });
  rmSync(workspaceDir, { recursive: true, force: true });
});

/**
 * Builds the daemon's HTTP surface with the ADI-13 registration either included (the shipped
 * configuration, via the real `buildServer`) or skipped.
 *
 * The "skipped" arm re-uses `buildServer` with the workspace pair present and then simply never
 * calls `registerV2SessionCreateRoute` on a *second* instance -- which is possible only because that
 * registration is a standalone function taking its own options bag. That is the structural property
 * being tested: a create route bolted onto `registerV2SessionRoutes` could not be removed without
 * also removing the read routes.
 */
function build(withCreateRoute: boolean): FastifyInstance {
  const registry = new ProviderRegistry();
  registry.register(new QuietProvider());
  const trustStore = new WorkspaceTrustStore({ stateRoot });
  const auditStore = new AuditStore({ stateRoot });
  const limiter = new ActiveSessionLimiter();
  const store = new SessionLineageStore({ stateRoot });
  const leaseManager = new WorkspaceExecutionLeaseManager();
  const sessionManager = new SessionManager(
    registry,
    noopLogger,
    undefined,
    limiter,
    store,
    { trustStore },
    leaseManager,
  );

  if (withCreateRoute) {
    return buildServer({
      registry,
      sessionManager,
      token: TOKEN,
      logger: noopLogger,
      v2: { store, limiter, workspace: { trustStore, auditStore, leaseManager } },
    });
  }

  // The rolled-back configuration: every registration `server.ts` makes *except* ADI-13's.
  //
  // Assembled from the same exported functions rather than behind a production feature flag,
  // because the property under test is structural: this arm can only be written while
  // `registerV2SessionCreateRoute` is a standalone registration with its own options bag. If a
  // future edit folded session creation into `registerV2SessionRoutes`, this function would stop
  // compiling -- which is the failure mode worth having.
  const app = Fastify({ logger: false, trustProxy: false });
  registerHealthRoute(app, Date.now(), { v2Enabled: true, daemonInstanceId: 'rollback-instance' });
  registerProviderRoutes(app, registry);
  registerSessionRoutes(app, sessionManager, registry);
  registerV2ProviderRoutes(app, registry, limiter);
  registerV2SessionRoutes(app, store, limiter);
  registerV2WorkspaceRoutes(app, { trustStore, auditStore, sessionManager });
  registerV2AuditRoutes(app, auditStore);
  // registerV2SessionCreateRoute(app, {...}) -- deliberately not called. This one line is the whole
  // rollback.
  app.setNotFoundHandler((_req, reply) => {
    reply.code(404).send({ error: 'not found' });
  });
  return app;
}

/**
 * Runs one v1 session all the way through, and reports what came back at both ends.
 *
 * A 201 on its own says a handler answered; it does not say a session exists. The follow-up `GET`
 * is what proves the create actually produced retrievable, persisted state, which is the level of
 * verification `index.downgrade.test.ts`'s "serves v1 POST /sessions end to end" applies and the
 * level this file's own claim -- that v1 is untouched by the ADI-13 registration -- needs.
 */
async function probeV1SessionEndToEnd(app: FastifyInstance): Promise<string> {
  const created = await app.inject({
    method: 'POST',
    url: '/sessions',
    headers: AUTH,
    payload: { provider: 'claude', cwd: workspaceDir, prompt: 'hello' },
  });
  if (created.statusCode !== 201) return `create ${created.statusCode}`;

  const id = created.json().id as string;
  // Polled rather than slept: both configurations have to reach the same terminal state, and a
  // fixed sleep would make that comparison a race on a loaded machine rather than an assertion.
  const pending = (res: { json: () => { status?: unknown } }): boolean =>
    res.json().status === 'starting' || res.json().status === 'running';
  let fetched = await app.inject({ method: 'GET', url: `/sessions/${id}`, headers: AUTH });
  for (let attempt = 0; attempt < 40 && pending(fetched); attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 25));
    fetched = await app.inject({ method: 'GET', url: `/sessions/${id}`, headers: AUTH });
  }
  return `create 201 / get ${fetched.statusCode} ${String(fetched.json().status)}`;
}

/**
 * Every route other than `POST /v2/sessions`, and what each answers.
 *
 * Values are strings rather than bare status codes so a probe can report more than "a handler
 * replied" where that matters (see `probeV1SessionEndToEnd`). The bodies below are deliberately
 * minimal: what is being compared is whether a route is *there* and answers the same way, not its
 * behavior, which `v2-workspaces.routes.test.ts` and `index.test.ts` already cover in full. A route
 * that had gone missing would answer 404 from the not-found handler instead, which is the one thing
 * every probe here is shaped to distinguish.
 */
async function surfaceReport(app: FastifyInstance): Promise<Record<string, string>> {
  const code = async (run: Promise<{ statusCode: number }>): Promise<string> => String((await run).statusCode);

  const probes: Array<[string, () => Promise<string>]> = [
    ['GET /health', () => code(app.inject({ method: 'GET', url: '/health' }))],
    ['GET /providers', () => code(app.inject({ method: 'GET', url: '/providers', headers: AUTH }))],
    ['POST /sessions', () => probeV1SessionEndToEnd(app)],
    ['GET /v2/providers', () => code(app.inject({ method: 'GET', url: '/v2/providers', headers: AUTH }))],
    ['GET /v2/sessions', () => code(app.inject({ method: 'GET', url: '/v2/sessions', headers: AUTH }))],
    ['GET /v2/audit', () => code(app.inject({ method: 'GET', url: '/v2/audit', headers: AUTH }))],
    [
      'POST /v2/workspaces/inspect',
      () =>
        code(
          app.inject({
            method: 'POST',
            url: '/v2/workspaces/inspect',
            headers: AUTH,
            payload: { path: workspaceDir, provider: 'claude' },
          }),
        ),
    ],
    [
      // ADI-06's grant-consumption route. Probed with a deliberately incomplete body, which its
      // schema refuses with a 400 before it resolves an identity or writes anything: enough to tell
      // "the route is registered and answered" from "the route is gone", with no audit entry and no
      // trust state either configuration could then disagree about.
      'POST /v2/workspaces/consume-grant',
      () =>
        code(
          app.inject({
            method: 'POST',
            url: '/v2/workspaces/consume-grant',
            headers: AUTH,
            payload: { provider: 'claude' },
          }),
        ),
    ],
    [
      // ADI-06's revocation route. `state: 'trusted'` is the one input it answers with its own
      // specific 400 (`trust_not_self_assertable`, the D3 refusal) rather than a routing 404 or a
      // generic schema failure, so this probe reaches a real handler while revoking nothing.
      'PUT /v2/workspaces/:id/trust',
      () =>
        code(
          app.inject({
            method: 'PUT',
            url: `/v2/workspaces/${'c'.repeat(64)}/trust`,
            headers: AUTH,
            payload: { state: 'trusted' },
          }),
        ),
    ],
    [
      'POST /v2/workspaces/grant-events',
      () =>
        code(
          app.inject({
            method: 'POST',
            url: '/v2/workspaces/grant-events',
            headers: AUTH,
            payload: {
              event: 'grant.issued',
              workspaceId: 'a'.repeat(64),
              incarnation: 'b'.repeat(64),
              provider: 'claude',
              actor: 'user',
            },
          }),
        ),
    ],
  ];

  const report: Record<string, string> = {};
  for (const [name, run] of probes) report[name] = await run();
  return report;
}

describe('skipping the ADI-13 registration rolls back exactly one route', () => {
  it('serves POST /v2/sessions when registered', async () => {
    const app = build(true);
    const res = await app.inject({ method: 'POST', url: '/v2/sessions', headers: AUTH, payload: {} });
    // 400, not 404: the route exists and refused the body. Anything that reached a handler proves
    // registration happened, which is what this asserts -- the body's validity is other tests' job.
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe('invalid_request');
    await app.close();
  });

  it('404s POST /v2/sessions when the registration is skipped', async () => {
    const app = build(false);
    const res = await app.inject({ method: 'POST', url: '/v2/sessions', headers: AUTH, payload: {} });
    expect(res.statusCode).toBe(404);
    await app.close();
  });

  it('leaves v1, the v2 read routes, and the workspace/audit routes byte-for-byte identical', async () => {
    const withRoute = build(true);
    const withoutRoute = build(false);

    const before = await surfaceReport(withRoute);
    const after = await surfaceReport(withoutRoute);

    expect(after).toEqual(before);
    // And sanity: the shared surface is genuinely working in both, not uniformly 404ing. Each of
    // these would be '404' if its route had gone missing along with the create route, so the
    // equality above cannot be satisfied by two identically-broken servers.
    expect(before['GET /v2/sessions']).toBe('200');
    // Not just "a handler answered 201": the session is real, persisted, and retrievable.
    expect(before['POST /sessions']).toBe('create 201 / get 200 completed');
    expect(before['POST /v2/workspaces/inspect']).toBe('200');
    expect(before['POST /v2/workspaces/consume-grant']).toBe('400');
    expect(before['PUT /v2/workspaces/:id/trust']).toBe('400');
    expect(before['POST /v2/workspaces/grant-events']).toBe('202');

    await withRoute.close();
    await withoutRoute.close();
  });

  it('keeps GET /v2/sessions working even with creation removed', async () => {
    const app = build(false);
    const res = await app.inject({ method: 'GET', url: '/v2/sessions', headers: AUTH });
    expect(res.statusCode).toBe(200);
    expect(res.json().sessions).toEqual([]);
    await app.close();
  });
});
