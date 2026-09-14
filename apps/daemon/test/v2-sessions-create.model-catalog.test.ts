import { mkdirSync, mkdtempSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { noopLogger, ProviderRegistry } from '@agent-dock/agent-runtime';
import type { AgentProvider, ProviderModelCatalogOptions, ProviderSessionHandle, StartSessionOptions } from '@agent-dock/agent-runtime';
import type { AgentEvent, ProviderId, ProviderModelV2, ProviderStatus } from '@agent-dock/shared';
import { MODEL_SELECT_CAPABILITY_ID } from '@agent-dock/shared';
import { buildModelSelectConstraints } from '@agent-dock/vacancy-agent-adapter';
import type { FastifyInstance } from 'fastify';
import { AuditStore } from '../src/audit-store.js';
import { ActiveSessionLimiter } from '../src/active-session-limiter.js';
import { SessionLineageStore } from '../src/session-lineage-store.js';
import { SessionManager } from '../src/session-manager.js';
import { WorkspaceTrustStore } from '../src/workspace-trust-store.js';
import { WorkspaceExecutionLeaseManager } from '../src/workspace-execution-lease.js';
import { buildServer } from '../src/server.js';

/**
 * ADI-22a: `POST /v2/sessions` prefers a provider's live `fetchModelCatalog()` over the static
 * `status.availableModels` when resolving a fresh session's `ext.open_vacancy_radar.model_select`
 * capability -- Codex only, per this ticket's own non-goals. This suite proves the wiring itself
 * (`liveOrStaticModelCatalog` in `v2-sessions-create.ts`), never a real Codex app-server RPC: that
 * round trip is already covered end to end by
 * `packages/agent-runtime/test/codex-app-server-model-catalog.test.ts`.
 *
 * `ScriptedProvider` mirrors `v2-sessions-create.routes.test.ts`'s own `TestProvider`, widened with
 * a scriptable `fetchModelCatalog` -- present or absent per instance, matching how a real
 * `AgentProvider` either implements the optional method or omits it entirely.
 */
type ProviderMode = 'complete' | 'fail';

class ScriptedProvider implements AgentProvider {
  readonly id: ProviderId;
  readonly name = 'Scripted Provider';
  readonly started: StartSessionOptions[] = [];
  readonly fetchModelCatalogCalls: ProviderModelCatalogOptions[] = [];
  mode: ProviderMode = 'complete';
  resumeSupported = true;
  /** The static catalog `detect()` reports -- `status.availableModels`. */
  staticModels: string[] | undefined;
  /** What a live probe resolves to. `'reject'` simulates a failed/timed-out probe. Only read when
   * this instance was constructed with a `fetchModelCatalog` at all. */
  liveCatalog: readonly ProviderModelV2[] | 'reject' = [];
  /** Present or absent per instance -- never reassigned after construction, matching a real
   * `AgentProvider`, which either implements the method or doesn't. */
  readonly fetchModelCatalog?: (options: ProviderModelCatalogOptions) => Promise<readonly ProviderModelV2[]>;

  constructor(id: ProviderId, options: { hasFetchModelCatalog: boolean }) {
    this.id = id;
    if (options.hasFetchModelCatalog) {
      this.fetchModelCatalog = async (opts: ProviderModelCatalogOptions) => {
        this.fetchModelCatalogCalls.push(opts);
        if (this.liveCatalog === 'reject') throw new Error('live model catalog probe failed');
        return this.liveCatalog;
      };
    }
  }

  async detect(): Promise<ProviderStatus> {
    return {
      id: this.id,
      name: this.name,
      installed: true,
      authenticated: 'authenticated',
      capabilities: { resume: this.resumeSupported, cancellation: true, tools: true, usage: true, thinking: true },
      ...(this.staticModels === undefined ? {} : { availableModels: [...this.staticModels] }),
    };
  }

  startSession(options: StartSessionOptions): ProviderSessionHandle {
    this.started.push(options);
    const mode = this.mode;
    return {
      events: (async function* () {
        if (mode === 'complete') {
          yield { type: 'session.completed', providerSessionId: `thread-${options.sessionId}` } as AgentEvent;
          return;
        }
        yield { type: 'session.failed', message: 'scripted failure' } as AgentEvent;
      })(),
      cancel: async () => undefined,
    };
  }
}

// Workspace identity resolution spawns real `git` subprocesses (see workspace-identity.ts), the
// same reason `v2-sessions-create.routes.test.ts` widens its own timeout.
vi.setConfig({ testTimeout: 30_000 });

const TOKEN = 'v2-create-model-catalog-token';
const AUTH = { authorization: `Bearer ${TOKEN}` };

let stateRoot: string;
let workspaceRoot: string;
let workspaceDir: string;

beforeEach(() => {
  stateRoot = mkdtempSync(join(tmpdir(), 'ovr-v2-create-catalog-state-'));
  workspaceRoot = mkdtempSync(join(tmpdir(), 'ovr-v2-create-catalog-ws-'));
  workspaceDir = join(workspaceRoot, 'SENTINEL_WORKSPACE');
  mkdirSync(workspaceDir, { recursive: true });
});

afterEach(async () => {
  // Async with retries, not rmSync: on Windows a just-torn-down child process (git, in workspace
  // identity resolution) can hold a lingering handle on this directory for a few milliseconds
  // after the request resolves, and a synchronous delete during that window fails with EPERM (see
  // codex-app-server-scope-probe.test.ts's own cleanup, which uses this same pattern).
  await rm(stateRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  await rm(workspaceRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

interface Identity {
  workspaceId: string;
  incarnation: string;
}

function setup(codex: ScriptedProvider, claude: ScriptedProvider): { app: FastifyInstance } {
  const registry = new ProviderRegistry();
  registry.register(codex);
  registry.register(claude);

  const trustStore = new WorkspaceTrustStore({ stateRoot });
  const auditStore = new AuditStore({ stateRoot });
  const limiter = new ActiveSessionLimiter();
  const store = new SessionLineageStore({ stateRoot });
  const leaseManager = new WorkspaceExecutionLeaseManager();
  const sessionManager = new SessionManager(registry, noopLogger, undefined, limiter, store, { trustStore }, leaseManager);

  const app = buildServer({
    registry,
    sessionManager,
    token: TOKEN,
    logger: noopLogger,
    v2: { store, limiter, workspace: { trustStore, auditStore, leaseManager } },
  });
  return { app };
}

async function trust(app: FastifyInstance, provider: ProviderId): Promise<Identity> {
  const inspectRes = await app.inject({
    method: 'POST',
    url: '/v2/workspaces/inspect',
    headers: AUTH,
    payload: { path: workspaceDir, provider },
  });
  expect(inspectRes.statusCode).toBe(200);
  const view = inspectRes.json().workspace as Identity;
  // `workspaceConsumeGrantRequestSchema` is `.strict()`: only the two identity fields may be sent,
  // never the raw inspect view (which also carries `state`/`reusable`/`dirty`/...).
  const identity: Identity = { workspaceId: view.workspaceId, incarnation: view.incarnation };
  const grantRes = await app.inject({
    method: 'POST',
    url: '/v2/workspaces/consume-grant',
    headers: AUTH,
    payload: { path: workspaceDir, provider, ...identity },
  });
  expect(grantRes.statusCode).toBe(200);
  return identity;
}

function create(app: FastifyInstance, provider: ProviderId, identity: Identity, model: string) {
  return app.inject({
    method: 'POST',
    url: '/v2/sessions',
    headers: AUTH,
    payload: {
      provider,
      cwd: workspaceDir,
      prompt: 'do the thing',
      ...identity,
      capabilities: [{ id: MODEL_SELECT_CAPABILITY_ID, constraints: buildModelSelectConstraints(model) }],
    },
  });
}

describe('POST /v2/sessions: Codex resolves the model-select capability against a live catalog (ADI-22a)', () => {
  it('selects a model present only in the live catalog, absent from status.availableModels', async () => {
    const codex = new ScriptedProvider('codex', { hasFetchModelCatalog: true });
    codex.staticModels = ['gpt-5-codex']; // the static list does NOT contain the model below
    codex.liveCatalog = [
      { id: 'gpt-5-codex', displayName: 'GPT-5 Codex', isDefault: true },
      { id: 'gpt-5-turbo-preview', displayName: 'GPT-5 Turbo Preview', isDefault: false },
    ];
    const claude = new ScriptedProvider('claude', { hasFetchModelCatalog: false });
    const { app } = setup(codex, claude);
    const identity = await trust(app, 'codex');

    const res = await create(app, 'codex', identity, 'gpt-5-turbo-preview');

    expect(res.statusCode).toBe(201);
    expect(res.json().session.model).toBe('gpt-5-turbo-preview');
    expect(res.json().session.selection.unavailableOptional).toEqual([]);
    expect(codex.started[0]?.model).toBe('gpt-5-turbo-preview');
    expect(codex.fetchModelCatalogCalls).toHaveLength(1);
  });

  it('falls back to status.availableModels, unavailableOptional (not a request failure), when the live probe rejects', async () => {
    const codex = new ScriptedProvider('codex', { hasFetchModelCatalog: true });
    codex.staticModels = ['gpt-5-codex'];
    codex.liveCatalog = 'reject';
    const claude = new ScriptedProvider('claude', { hasFetchModelCatalog: false });
    const { app } = setup(codex, claude);
    const identity = await trust(app, 'codex');

    const res = await create(app, 'codex', identity, 'gpt-5-codex');

    expect(res.statusCode).toBe(201);
    expect(res.json().session.model).toBe('gpt-5-codex');
    expect(codex.fetchModelCatalogCalls).toHaveLength(1); // it was tried
  });

  it('falls back to status.availableModels for a Codex provider that implements no fetchModelCatalog at all', async () => {
    const codex = new ScriptedProvider('codex', { hasFetchModelCatalog: false });
    codex.staticModels = ['gpt-5-codex'];
    const claude = new ScriptedProvider('claude', { hasFetchModelCatalog: false });
    const { app } = setup(codex, claude);
    const identity = await trust(app, 'codex');

    const res = await create(app, 'codex', identity, 'gpt-5-codex');

    expect(res.statusCode).toBe(201);
    expect(res.json().session.model).toBe('gpt-5-codex');
  });

  it('still resolves unknown_model, never a request failure, when a model is in neither catalog', async () => {
    const codex = new ScriptedProvider('codex', { hasFetchModelCatalog: true });
    codex.staticModels = ['gpt-5-codex'];
    codex.liveCatalog = [{ id: 'gpt-5-codex', displayName: 'GPT-5 Codex', isDefault: true }];
    const claude = new ScriptedProvider('claude', { hasFetchModelCatalog: false });
    const { app } = setup(codex, claude);
    const identity = await trust(app, 'codex');

    const res = await create(app, 'codex', identity, 'not-a-real-model');

    expect(res.statusCode).toBe(201);
    expect(res.json().session.selection.unavailableOptional).toEqual([
      { id: MODEL_SELECT_CAPABILITY_ID, reason: 'unknown_model' },
    ]);
  });
});

describe("POST /v2/sessions: Claude's model-select resolution is unaffected by ADI-22a", () => {
  it('never calls fetchModelCatalog for Claude, even when the provider implements one', async () => {
    const codex = new ScriptedProvider('codex', { hasFetchModelCatalog: false });
    const claude = new ScriptedProvider('claude', { hasFetchModelCatalog: true });
    claude.staticModels = ['sonnet', 'opus'];
    // A live catalog that, if ever consulted, would resolve a DIFFERENT model than the static list
    // -- so a test that only checked the resolved model would not catch a regression that started
    // consulting it. The real proof is `fetchModelCatalogCalls` staying empty below.
    claude.liveCatalog = [{ id: 'claude-live-only', displayName: 'Live-only', isDefault: true }];
    const { app } = setup(codex, claude);
    const identity = await trust(app, 'claude');

    const res = await create(app, 'claude', identity, 'opus');

    expect(res.statusCode).toBe(201);
    expect(res.json().session.model).toBe('opus');
    expect(claude.fetchModelCatalogCalls).toHaveLength(0);
  });

  it('still resolves no_catalog for Claude exactly as before when status.availableModels is absent', async () => {
    const codex = new ScriptedProvider('codex', { hasFetchModelCatalog: false });
    const claude = new ScriptedProvider('claude', { hasFetchModelCatalog: true });
    claude.staticModels = undefined;
    claude.liveCatalog = [{ id: 'claude-live-only', displayName: 'Live-only', isDefault: true }];
    const { app } = setup(codex, claude);
    const identity = await trust(app, 'claude');

    const res = await create(app, 'claude', identity, 'opus');

    expect(res.statusCode).toBe(201);
    expect(res.json().session.selection.unavailableOptional).toEqual([
      { id: MODEL_SELECT_CAPABILITY_ID, reason: 'no_catalog' },
    ]);
    expect(claude.fetchModelCatalogCalls).toHaveLength(0);
  });
});
