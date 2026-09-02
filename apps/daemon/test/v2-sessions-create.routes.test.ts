import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * `resolveModelSelection` is wrapped rather than spied on, for the same reason the store tests wrap
 * `node:fs`: the adapter package's ESM namespace is not configurable, so `vi.spyOn` cannot touch it.
 * The wrapper delegates to the real implementation, so every assertion below runs against the real
 * resolver -- the counter exists only to prove the *resume* path never reaches it.
 */
const { resolveCalls } = vi.hoisted(() => ({ resolveCalls: [] as unknown[][] }));

vi.mock('@agent-dock/vacancy-agent-adapter', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@agent-dock/vacancy-agent-adapter')>();
  return {
    ...actual,
    resolveModelSelection: (...args: Parameters<typeof actual.resolveModelSelection>) => {
      resolveCalls.push(args);
      return actual.resolveModelSelection(...args);
    },
  };
});

const { ProviderRegistry, noopLogger } = await import('@agent-dock/agent-runtime');
const { MODEL_SELECT_CAPABILITY_ID, agentSessionV2ViewSchema } = await import('@agent-dock/shared');
const { buildModelSelectConstraints } = await import('@agent-dock/vacancy-agent-adapter');
const { AuditCapacityError, AuditStore, AuditUnavailableError } = await import('../src/audit-store.js');
const { ActiveSessionLimitError, ActiveSessionLimiter } = await import('../src/active-session-limiter.js');
const { SessionLineageStore, StorageFullError } = await import('../src/session-lineage-store.js');
const { SessionManager } = await import('../src/session-manager.js');
const { WorkspaceTrustStore } = await import('../src/workspace-trust-store.js');
const { WorkspaceExecutionLeaseManager } = await import('../src/workspace-execution-lease.js');
const { buildServer } = await import('../src/server.js');

import type { FastifyInstance } from 'fastify';
import type { AgentEvent, ProviderId, ProviderStatus } from '@agent-dock/shared';
import type { AgentProvider, ProviderSessionHandle, StartSessionOptions } from '@agent-dock/agent-runtime';

/**
 * `POST /v2/sessions` (ADI-13), end to end through the real server, the real durable store, the real
 * trust store, the real audit store, the real limiter, and the real lease manager.
 *
 * Only the provider is a fake, for the reason every other route suite here uses one: the real
 * registry spawns actual Claude/Codex CLIs. Workspace identity is **not** faked -- these tests
 * resolve real directories, which means real `git rev-parse` / `git status` subprocesses and the
 * same 30-second ceiling `v2-workspaces.routes.test.ts` documents.
 *
 * Trust is established the only way it can be: by consuming a grant through
 * `POST /v2/workspaces/consume-grant`. There is deliberately no shortcut, because a test that
 * reached into the trust store directly would not notice if the create route stopped requiring
 * trust at all.
 */
vi.setConfig({ testTimeout: 30_000 });

const TOKEN = 'test-token-adi13';
const AUTH = { authorization: `Bearer ${TOKEN}` };

type ProviderMode = 'complete' | 'fail' | 'hang';

class TestProvider implements AgentProvider {
  readonly id: ProviderId = 'claude';
  readonly name = 'Test Provider';
  readonly started: StartSessionOptions[] = [];
  detectCalls = 0;
  mode: ProviderMode = 'complete';
  models: string[] | undefined = ['sonnet', 'opus'];
  resumeSupported = true;
  startError: Error | undefined;
  /** The provider-native thread id a completed session reports, so a later resume can name it. */
  providerSessionId: string | undefined = 'thread-one';
  readonly #gates = new Map<string, () => void>();

  async detect(): Promise<ProviderStatus> {
    this.detectCalls += 1;
    return {
      id: this.id,
      name: this.name,
      installed: true,
      authenticated: 'authenticated',
      capabilities: {
        resume: this.resumeSupported,
        cancellation: true,
        tools: true,
        usage: true,
        thinking: true,
      },
      ...(this.models === undefined ? {} : { availableModels: [...this.models] }),
    };
  }

  startSession(options: StartSessionOptions): ProviderSessionHandle {
    this.started.push(options);
    if (this.startError) throw this.startError;

    const mode = this.mode;
    const providerSessionId = this.providerSessionId;
    let open!: () => void;
    const gate = new Promise<void>((resolve) => {
      open = resolve;
    });
    this.#gates.set(options.sessionId, open);

    return {
      events: (async function* () {
        if (mode === 'complete') {
          yield { type: 'session.completed', ...(providerSessionId ? { providerSessionId } : {}) } as AgentEvent;
          return;
        }
        if (mode === 'fail') {
          yield { type: 'session.failed', message: 'the provider gave up' } as AgentEvent;
          return;
        }
        await gate;
        yield { type: 'session.cancelled' } as AgentEvent;
      })(),
      cancel: async () => {
        this.#gates.get(options.sessionId)?.();
      },
    };
  }

  /** Ends a `hang`ing session, the way a cancel would. */
  finish(sessionId: string): void {
    this.#gates.get(sessionId)?.();
  }
}

let stateRoot: string;
let workspaceRoot: string;
let workspaceDir: string;

interface Harness {
  app: FastifyInstance;
  provider: TestProvider;
  auditStore: InstanceType<typeof AuditStore>;
  trustStore: InstanceType<typeof WorkspaceTrustStore>;
  sessionManager: InstanceType<typeof SessionManager>;
  leaseManager: InstanceType<typeof WorkspaceExecutionLeaseManager>;
  store: InstanceType<typeof SessionLineageStore>;
}

function setup(options: { maxAuditBytes?: number } = {}): Harness {
  const provider = new TestProvider();
  const registry = new ProviderRegistry();
  registry.register(provider);

  const trustStore = new WorkspaceTrustStore({ stateRoot });
  const auditStore = new AuditStore({
    stateRoot,
    ...(options.maxAuditBytes === undefined ? {} : { maxBytes: options.maxAuditBytes }),
  });
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

  const app = buildServer({
    registry,
    sessionManager,
    token: TOKEN,
    logger: noopLogger,
    v2: { store, limiter, workspace: { trustStore, auditStore, leaseManager } },
  });

  return { app, provider, auditStore, trustStore, sessionManager, leaseManager, store };
}

beforeEach(() => {
  resolveCalls.length = 0;
  stateRoot = mkdtempSync(join(tmpdir(), 'agent-dock-v2-create-state-'));
  workspaceRoot = mkdtempSync(join(tmpdir(), 'agent-dock-v2-create-ws-'));
  workspaceDir = join(workspaceRoot, 'SENTINEL_WORKSPACE');
  mkdirSync(workspaceDir, { recursive: true });
});

afterEach(() => {
  rmSync(stateRoot, { recursive: true, force: true });
  rmSync(workspaceRoot, { recursive: true, force: true });
});

interface Identity {
  workspaceId: string;
  incarnation: string;
}

async function inspect(app: FastifyInstance, path = workspaceDir): Promise<Identity> {
  const res = await app.inject({
    method: 'POST',
    url: '/v2/workspaces/inspect',
    headers: AUTH,
    payload: { path, provider: 'claude' },
  });
  expect(res.statusCode).toBe(200);
  const view = res.json().workspace as Identity;
  return { workspaceId: view.workspaceId, incarnation: view.incarnation };
}

/** Establishes trust the only way the product can: by consuming a grant. */
async function trust(app: FastifyInstance, path = workspaceDir): Promise<Identity> {
  const identity = await inspect(app, path);
  const res = await app.inject({
    method: 'POST',
    url: '/v2/workspaces/consume-grant',
    headers: AUTH,
    payload: { path, provider: 'claude', ...identity },
  });
  expect(res.statusCode).toBe(200);
  return identity;
}

function createBody(identity: Identity, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { provider: 'claude', cwd: workspaceDir, prompt: 'do the thing', ...identity, ...extra };
}

function create(app: FastifyInstance, body: Record<string, unknown>) {
  return app.inject({ method: 'POST', url: '/v2/sessions', headers: AUTH, payload: body });
}

function modelSelect(model: string): { id: string; constraints: unknown } {
  return { id: MODEL_SELECT_CAPABILITY_ID, constraints: buildModelSelectConstraints(model) };
}

function auditLines(): Record<string, unknown>[] {
  const file = join(stateRoot, 'workspace-audit', 'audit.jsonl');
  return readFileSync(file, 'utf8')
    .trim()
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

/** Every persisted session record's raw bytes, for the no-content-on-disk assertions. */
function readAllRecords(): string {
  const lineages = join(stateRoot, 'sessions-v1', 'lineages');
  return readdirSync(lineages)
    .flatMap((rootId) => {
      const records = join(lineages, rootId, 'records');
      return readdirSync(records).map((name) => readFileSync(join(records, name), 'utf8'));
    })
    .join('\n');
}

/** Lets the event loop drain a session's stream so its terminal cleanup (and lease release) runs. */
async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 40));
}

// -------------------------------------------------------------------------------------------
// Happy path and capability resolution
// -------------------------------------------------------------------------------------------

describe('POST /v2/sessions: the happy path', () => {
  it('creates a session, resolves the requested model, and returns the v2 view', async () => {
    const { app, provider } = setup();
    const identity = await trust(app);

    const res = await create(app, createBody(identity, { capabilities: [modelSelect('opus')] }));

    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.schemaVersion).toBe(1);
    const view = agentSessionV2ViewSchema.parse(body.session);
    expect(view.protocolVersion).toBe(2);
    expect(view.model).toBe('opus');
    expect(view.continuationKind).toBe('fresh');
    expect(view.selection).toEqual({
      enabled: [modelSelect('opus')],
      unavailableOptional: [],
    });

    // The resolved model reached the provider, not just the record.
    expect(provider.started).toHaveLength(1);
    expect(provider.started[0]?.model).toBe('opus');
    expect(provider.started[0]?.cwd).toBe(workspaceDir);
  });

  it('returns exactly what GET /v2/sessions/:id returns for the same session', async () => {
    const { app } = setup();
    const identity = await trust(app);

    const created = await create(app, createBody(identity, { capabilities: [modelSelect('sonnet')] }));
    const sessionId = created.json().session.id as string;
    await settle();

    const fetched = await app.inject({ method: 'GET', url: `/v2/sessions/${sessionId}`, headers: AUTH });
    expect(fetched.statusCode).toBe(200);

    // Byte-for-byte on the part that must not diverge. The rest of the view legitimately moves on
    // (status, completedAt, eventCount), which is why this compares `selection` and not the whole
    // object -- both projections still come from the one exported `toV2View`.
    expect(JSON.stringify(fetched.json().session.selection)).toBe(
      JSON.stringify(created.json().session.selection),
    );
    expect(fetched.json().session.model).toBe(created.json().session.model);
  });

  it('lists the resolved model among the provider view s availableModels', async () => {
    const { app } = setup();
    const identity = await trust(app);
    const created = await create(app, createBody(identity, { capabilities: [modelSelect('opus')] }));

    const providerView = await app.inject({ method: 'GET', url: '/v2/providers/claude', headers: AUTH });
    expect(providerView.statusCode).toBe(200);
    expect(providerView.json().provider.availableModels).toContain(created.json().session.model);
  });

  it('carries no selection at all when the request names no capabilities', async () => {
    const { app } = setup();
    const identity = await trust(app);

    const res = await create(app, createBody(identity));

    expect(res.statusCode).toBe(201);
    // Absent, not empty: this session negotiated nothing, exactly like a v1 session.
    expect('selection' in res.json().session).toBe(false);
    expect(res.json().session.model).toBeUndefined();
  });

  it('produces a present-but-empty selection when every requested capability was unavailable', async () => {
    const { app } = setup();
    const identity = await trust(app);

    const res = await create(
      app,
      createBody(identity, { capabilities: [{ id: 'ext.acme.turbo', constraints: { kind: 'opaque', value: {} } }] }),
    );

    // Negotiation happened and produced nothing, which is a different fact from no negotiation.
    expect(res.json().session.selection).toEqual({
      enabled: [],
      unavailableOptional: [{ id: 'ext.acme.turbo', reason: 'unsupported_capability' }],
    });
  });
});

describe('POST /v2/sessions: capability resolution outcomes', () => {
  it('records unknown_model and still starts the session on the provider default', async () => {
    const { app, provider } = setup();
    const identity = await trust(app);

    const res = await create(app, createBody(identity, { capabilities: [modelSelect('not-a-model')] }));

    expect(res.statusCode).toBe(201);
    expect(res.json().session.selection).toEqual({
      enabled: [],
      unavailableOptional: [{ id: MODEL_SELECT_CAPABILITY_ID, reason: 'unknown_model' }],
    });
    expect(res.json().session.model).toBeUndefined();
    expect(provider.started[0]?.model).toBeUndefined();
  });

  it('records no_catalog for a provider that offers no model selection', async () => {
    const { app, provider } = setup();
    provider.models = undefined;
    const identity = await trust(app);

    const res = await create(app, createBody(identity, { capabilities: [modelSelect('sonnet')] }));

    expect(res.statusCode).toBe(201);
    expect(res.json().session.selection.unavailableOptional).toEqual([
      { id: MODEL_SELECT_CAPABILITY_ID, reason: 'no_catalog' },
    ]);
  });

  it('fails the whole request for a malformed capability value', async () => {
    const { app, provider } = setup();
    const identity = await trust(app);

    const res = await create(
      app,
      createBody(identity, {
        // Well-formed as an `OpaqueExtension` (so the request schema accepts it) but not a
        // well-formed model-select ask, which is exactly the invalid_request case.
        capabilities: [{ id: MODEL_SELECT_CAPABILITY_ID, constraints: { kind: 'opaque', value: { nope: 1 } } }],
      }),
    );

    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe('invalid_capability_request');
    expect(provider.started).toHaveLength(0);
  });

  it('never echoes the resolver s own message into the persisted unavailable reason', async () => {
    const { app } = setup();
    const identity = await trust(app);

    await create(app, createBody(identity, { capabilities: [modelSelect('SENTINEL-NOT-A-MODEL')] }));

    // The reason is a closed-enum token and nothing else. `resolveModelSelection`'s `invalid_request`
    // outcome carries a human-readable Zod message and `unknown_model` carries the value the caller
    // asked for; neither may reach a store whose rule is that no free-form or caller-supplied text
    // is written. The `enabled` list legitimately echoes a requested constraint, so this checks the
    // whole `unavailableOptional` array rather than the whole file.
    const onDisk = readAllRecords();
    expect(onDisk).toContain('"reason":"unknown_model"');
    expect(onDisk).not.toContain('SENTINEL-NOT-A-MODEL');
  });

  it('mixes enabled and unavailable entries in one selection', async () => {
    const { app } = setup();
    const identity = await trust(app);

    const res = await create(
      app,
      createBody(identity, {
        capabilities: [
          modelSelect('sonnet'),
          { id: 'ext.acme.turbo', constraints: { kind: 'opaque', value: { x: 1 } } },
        ],
      }),
    );

    expect(res.statusCode).toBe(201);
    expect(res.json().session.model).toBe('sonnet');
    expect(res.json().session.selection.enabled).toHaveLength(1);
    expect(res.json().session.selection.unavailableOptional).toEqual([
      { id: 'ext.acme.turbo', reason: 'unsupported_capability' },
    ]);
  });
});

// -------------------------------------------------------------------------------------------
// Resume
// -------------------------------------------------------------------------------------------

describe('POST /v2/sessions: resume', () => {
  async function seedParent(
    app: FastifyInstance,
    identity: Identity,
    capabilities?: unknown[],
  ): Promise<{ sessionId: string; providerSessionId: string }> {
    const res = await create(app, createBody(identity, capabilities === undefined ? {} : { capabilities }));
    expect(res.statusCode).toBe(201);
    await settle();
    const sessionId = res.json().session.id as string;
    return { sessionId, providerSessionId: 'thread-one' };
  }

  it('inherits the parent selection and model verbatim, without re-resolving', async () => {
    const { app } = setup();
    const identity = await trust(app);
    const parent = await seedParent(app, identity, [modelSelect('opus')]);
    const parentView = await app.inject({ method: 'GET', url: `/v2/sessions/${parent.sessionId}`, headers: AUTH });

    resolveCalls.length = 0;
    const res = await create(
      app,
      createBody(identity, { resumeProviderSessionId: parent.providerSessionId }),
    );

    expect(res.statusCode).toBe(201);
    expect(res.json().session.continuationKind).toBe('resume');
    expect(res.json().session.parentSessionId).toBe(parent.sessionId);
    expect(res.json().session.model).toBe('opus');
    expect(JSON.stringify(res.json().session.selection)).toBe(
      JSON.stringify(parentView.json().session.selection),
    );
    // The proof that inheritance is inheritance and not a second resolution against a catalog that
    // may since have changed.
    expect(resolveCalls).toEqual([]);
  });

  it('refuses a model-select capability on a resume even when the value matches the parent', async () => {
    const { app, provider } = setup();
    const identity = await trust(app);
    const parent = await seedParent(app, identity, [modelSelect('opus')]);
    const startedBefore = provider.started.length;

    const res = await create(
      app,
      createBody(identity, {
        resumeProviderSessionId: parent.providerSessionId,
        capabilities: [modelSelect('opus')],
      }),
    );

    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe('resume_cannot_override_model');
    expect(provider.started).toHaveLength(startedBefore);
  });

  it('refuses a model-select capability on a resume when the value differs, with the same code', async () => {
    const { app } = setup();
    const identity = await trust(app);
    const parent = await seedParent(app, identity, [modelSelect('opus')]);

    const res = await create(
      app,
      createBody(identity, {
        resumeProviderSessionId: parent.providerSessionId,
        capabilities: [modelSelect('sonnet')],
      }),
    );

    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe('resume_cannot_override_model');
  });

  it('allows a non-model capability on a resume, without negotiating it', async () => {
    const { app } = setup();
    const identity = await trust(app);
    const parent = await seedParent(app, identity, [modelSelect('opus')]);

    const res = await create(
      app,
      createBody(identity, {
        resumeProviderSessionId: parent.providerSessionId,
        capabilities: [{ id: 'ext.acme.turbo', constraints: { kind: 'opaque', value: {} } }],
      }),
    );

    // The rule is specifically about the model, so an unrelated capability is not a refusal -- but
    // the resumed session still inherits, and negotiates nothing of its own.
    expect(res.statusCode).toBe(201);
    expect(JSON.stringify(res.json().session.selection)).toContain(MODEL_SELECT_CAPABILITY_ID);
  });

  it('inherits an absent selection as absent, carrying only the model', async () => {
    const { app, store } = setup();
    const identity = await trust(app);
    const parent = await seedParent(app, identity);
    // A parent with a model but no negotiation: exactly the shape a v1-originated or pre-ADI-13
    // record has.
    expect('selection' in store.get(parent.sessionId)!.session).toBe(false);

    const res = await create(app, createBody(identity, { resumeProviderSessionId: parent.providerSessionId }));

    expect(res.statusCode).toBe(201);
    expect('selection' in res.json().session).toBe(false);
  });

  it('refuses an unknown resume target rather than treating it as a fresh session', async () => {
    const { app, provider } = setup();
    const identity = await trust(app);

    const res = await create(app, createBody(identity, { resumeProviderSessionId: 'never-existed' }));

    expect(res.statusCode).toBe(409);
    expect(res.json().code).toBe('unknown_resume_target');
    expect(provider.started).toHaveLength(0);
  });

  it('refuses a resume for a provider that cannot resume', async () => {
    const { app, provider } = setup();
    provider.resumeSupported = false;
    const identity = await trust(app);

    const res = await create(app, createBody(identity, { resumeProviderSessionId: 'thread-one' }));

    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe('resume_not_supported');
  });
});

// -------------------------------------------------------------------------------------------
// Request validation and provider resolution
// -------------------------------------------------------------------------------------------

describe('POST /v2/sessions: request refusals that identify no workspace', () => {
  it('rejects a malformed body with invalid_request and writes no audit entry', async () => {
    const { app, auditStore } = setup();
    await trust(app);
    const before = auditStore.entryCount;

    const res = await create(app, { provider: 'claude', cwd: workspaceDir });

    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe('invalid_request');
    expect(auditStore.entryCount).toBe(before);
  });

  it('rejects an unknown key rather than dropping it', async () => {
    const { app } = setup();
    const identity = await trust(app);

    const res = await create(app, createBody(identity, { model: 'opus' }));

    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe('invalid_request');
  });

  it('rejects an unregistered provider with unsupported_provider and no audit entry', async () => {
    const { app, auditStore } = setup();
    const identity = await trust(app);
    const before = auditStore.entryCount;

    const res = await create(app, createBody(identity, { provider: 'codex' }));

    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe('unsupported_provider');
    expect(auditStore.entryCount).toBe(before);
  });

  it('requires the bearer token, like every other privileged route', async () => {
    const { app } = setup();
    const res = await app.inject({ method: 'POST', url: '/v2/sessions', payload: {} });
    expect(res.statusCode).toBe(401);
  });
});

// -------------------------------------------------------------------------------------------
// Trust, identity, and revocation races
// -------------------------------------------------------------------------------------------

describe('POST /v2/sessions: trust and identity', () => {
  it('refuses an untrusted workspace, creating no session, record, or lease', async () => {
    const { app, provider, store, leaseManager } = setup();
    const identity = await inspect(app); // inspected, never granted

    const res = await create(app, createBody(identity));

    expect(res.statusCode).toBe(403);
    expect(res.json().code).toBe('workspace_not_trusted');
    expect(provider.started).toHaveLength(0);
    expect(store.stats().records).toBe(0);
    expect(leaseManager.activeLeaseCount).toBe(0);
    expect(auditLines().at(-1)).toMatchObject({
      event: 'session.workspace_denied',
      reason: 'not_trusted',
      workspaceId: identity.workspaceId,
    });
  });

  it('refuses a claimed identity that does not match the resolved one', async () => {
    const { app, store } = setup();
    const identity = await trust(app);

    const res = await create(app, createBody({ ...identity, incarnation: 'f'.repeat(64) }));

    expect(res.statusCode).toBe(409);
    expect(res.json().code).toBe('workspace_identity_drift');
    expect(store.stats().records).toBe(0);
    expect(auditLines().at(-1)).toMatchObject({ event: 'session.workspace_denied', reason: 'identity_drift' });
  });

  it('refuses a workspace whose trust was revoked before the request', async () => {
    const { app, sessionManager, store } = setup();
    const identity = await trust(app);
    sessionManager.blockWorkspace(identity.workspaceId);

    const res = await create(app, createBody(identity));

    expect(res.statusCode).toBe(403);
    expect(res.json().code).toBe('workspace_revoked');
    expect(store.stats().records).toBe(0);
  });

  it('refuses a UNC cwd before any workspace is identified', async () => {
    const { app, auditStore } = setup();
    const identity = await trust(app);
    const before = auditStore.entryCount;

    const res = await create(app, createBody(identity, { cwd: '\\\\server\\share\\repo' }));

    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe('unc_workspace_unsupported');
    // No entry: nothing was decided about a workspace, because none could be identified.
    expect(auditStore.entryCount).toBe(before);
  });

  it('refuses a cwd that does not exist', async () => {
    const { app } = setup();
    const identity = await trust(app);

    const res = await create(app, createBody(identity, { cwd: join(workspaceRoot, 'gone') }));

    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe('invalid_workspace_path');
  });
});

describe('POST /v2/sessions: revocation injected at each await gap', () => {
  /**
   * The gaps are exercised by revoking from inside a seam the request must pass through, which is
   * the same mutation-testing shape `session-manager.workspace.test.ts` uses: each test revokes at
   * exactly one point and requires a refusal, so removing the corresponding re-check breaks exactly
   * one of them.
   */
  it('denies when a revocation lands inside the trust check itself', async () => {
    const { app, sessionManager, provider, store, leaseManager } = setup();
    const identity = await trust(app);

    // `workspaceIsTrusted` re-reads the epoch after every one of its own awaits (ADI-06). Blocking
    // on the way in and then delegating to the real implementation puts the revocation inside it.
    const real = sessionManager.workspaceIsTrusted.bind(sessionManager);
    vi.spyOn(sessionManager, 'workspaceIsTrusted').mockImplementation(async (check) => {
      sessionManager.blockWorkspace(check.workspaceId);
      return real(check);
    });

    const res = await create(app, createBody(identity));

    expect(res.statusCode).toBe(403);
    expect(res.json().code).toBe('workspace_not_trusted');
    expect(provider.started).toHaveLength(0);
    expect(store.stats().records).toBe(0);
    expect(leaseManager.activeLeaseCount).toBe(0);
    vi.restoreAllMocks();
  });

  it('denies when a revocation lands between the audit write and lease acquisition', async () => {
    const { app, sessionManager, provider, leaseManager, store, auditStore } = setup();
    const identity = await trust(app);

    // The pre-effect audit append is the last await before the step-12 re-check, so revoking as it
    // resolves puts the revocation in exactly that gap and nowhere else.
    const append = auditStore.append.bind(auditStore);
    vi.spyOn(auditStore, 'append').mockImplementation(async (entry) => {
      const result = await append(entry);
      if (entry.event === 'session.workspace_allowed') sessionManager.blockWorkspace(entry.workspaceId);
      return result;
    });

    const res = await create(app, createBody(identity));

    expect(res.statusCode).toBe(403);
    expect(res.json().code).toBe('workspace_revoked');
    expect(provider.started).toHaveLength(0);
    expect(store.stats().records).toBe(0);
    // The denial happened before acquisition, so there is nothing held.
    expect(leaseManager.activeLeaseCount).toBe(0);
    vi.restoreAllMocks();
  });

  it('denies between lease acquisition and create, and does not leave the lease held', async () => {
    const { app, sessionManager, provider, leaseManager, store } = setup();
    const identity = await trust(app);

    // Revoke from inside the lease acquisition itself: the last await before `create()`.
    const acquire = leaseManager.acquire.bind(leaseManager);
    vi.spyOn(leaseManager, 'acquire').mockImplementation(async (request) => {
      const lease = await acquire(request);
      sessionManager.blockWorkspace(request.workspaceId);
      return lease;
    });

    const res = await create(app, createBody(identity));

    expect(res.statusCode).toBe(403);
    expect(res.json().code).toBe('workspace_revoked');
    expect(provider.started).toHaveLength(0);
    expect(store.stats().records).toBe(0);
    // The whole point: `create()`'s own catch handed the lease back, so the folder is not locked
    // out for the rest of the daemon's life by a session that never started.
    expect(leaseManager.activeLeaseCount).toBe(0);
    vi.restoreAllMocks();
  });

  it('denies with workspace_grant_stale when the epoch moved without a standing block', async () => {
    const { app, sessionManager, leaseManager, store } = setup();
    const identity = await trust(app);

    const acquire = leaseManager.acquire.bind(leaseManager);
    vi.spyOn(leaseManager, 'acquire').mockImplementation(async (request) => {
      const lease = await acquire(request);
      // A block-and-allow cycle: nothing is blocked afterwards, but the decision that authorized
      // this request was made against a state that no longer holds.
      sessionManager.blockWorkspace(request.workspaceId);
      sessionManager.allowWorkspace(request.workspaceId);
      return lease;
    });

    const res = await create(app, createBody(identity));

    expect(res.statusCode).toBe(409);
    expect(res.json().code).toBe('workspace_grant_stale');
    expect(store.stats().records).toBe(0);
    expect(leaseManager.activeLeaseCount).toBe(0);
    vi.restoreAllMocks();
  });
});

// -------------------------------------------------------------------------------------------
// Leases
// -------------------------------------------------------------------------------------------

describe('POST /v2/sessions: workspace execution leases', () => {
  it('refuses a second concurrent session for the same workspace', async () => {
    const { app, provider } = setup();
    provider.mode = 'hang';
    const identity = await trust(app);

    const first = await create(app, createBody(identity));
    expect(first.statusCode).toBe(201);

    const second = await create(app, createBody(identity));
    expect(second.statusCode).toBe(409);
    expect(second.json().code).toBe('workspace_lease_conflict');
  });

  it('admits a second session once the first has finished', async () => {
    const { app, provider, leaseManager } = setup();
    provider.mode = 'hang';
    const identity = await trust(app);

    const first = await create(app, createBody(identity));
    const firstId = first.json().session.id as string;
    expect(leaseManager.activeLeaseCount).toBe(1);

    provider.finish(firstId);
    await settle();
    expect(leaseManager.activeLeaseCount).toBe(0);

    const second = await create(app, createBody(identity));
    expect(second.statusCode).toBe(201);
  });

  for (const mode of ['complete', 'fail'] as const) {
    it(`releases the lease when a session ends with ${mode}`, async () => {
      const { app, provider, leaseManager } = setup();
      provider.mode = mode;
      const identity = await trust(app);

      expect((await create(app, createBody(identity))).statusCode).toBe(201);
      await settle();

      expect(leaseManager.activeLeaseCount).toBe(0);
    });
  }

  it('releases the lease when the session is cancelled through the v1 route', async () => {
    const { app, provider, leaseManager } = setup();
    provider.mode = 'hang';
    const identity = await trust(app);

    const created = await create(app, createBody(identity));
    const sessionId = created.json().session.id as string;

    await app.inject({ method: 'POST', url: `/sessions/${sessionId}/cancel`, headers: AUTH });
    await settle();

    expect(leaseManager.activeLeaseCount).toBe(0);
  });

  it('releases the lease when the provider refuses to start at all', async () => {
    const { app, provider, leaseManager, store } = setup();
    provider.startError = new Error('the CLI is missing');
    const identity = await trust(app);

    const res = await create(app, createBody(identity));

    expect(res.statusCode).toBe(500);
    expect(leaseManager.activeLeaseCount).toBe(0);
    // The record was written and then finalized as a failed launch, never left as `starting`.
    expect(store.stats().records).toBe(1);
    expect(store.allRecords()[0]?.session.terminalReason).toBe('launch_failed');
  });

  it('releases the lease when the active-session limiter refuses', async () => {
    const { app, provider, sessionManager, leaseManager, store } = setup();
    provider.mode = 'hang';
    const identity = await trust(app);

    vi.spyOn(sessionManager.activeSessionLimiter, 'reserve').mockImplementation((providerId, sessionId) => {
      void sessionId;
      throw new ActiveSessionLimitError('global', providerId, {
        global: { active: 4, limit: 4 },
        provider: { active: 2, limit: 2 },
      });
    });

    const res = await create(app, createBody(identity));

    expect(res.statusCode).toBe(409);
    expect(res.json().code).toBe('active_session_limit');
    expect(store.stats().records).toBe(0);
    expect(leaseManager.activeLeaseCount).toBe(0);
    vi.restoreAllMocks();
  });

  it('releases the lease when the durable store is full', async () => {
    const { app, provider, store, leaseManager } = setup();
    provider.mode = 'hang';
    const identity = await trust(app);

    vi.spyOn(store, 'create').mockImplementation(() => {
      throw new StorageFullError('no room');
    });

    const res = await create(app, createBody(identity));

    expect(res.statusCode).toBe(507);
    expect(res.json().code).toBe('storage_full');
    expect(leaseManager.activeLeaseCount).toBe(0);
    vi.restoreAllMocks();
  });
});

// -------------------------------------------------------------------------------------------
// Audit ordering
// -------------------------------------------------------------------------------------------

describe('POST /v2/sessions: audit before effect', () => {
  it('writes session.workspace_allowed naming the session it authorizes', async () => {
    const { app } = setup();
    const identity = await trust(app);

    const res = await create(app, createBody(identity));

    const last = auditLines().at(-1)!;
    expect(last.event).toBe('session.workspace_allowed');
    expect(last.sessionId).toBe(res.json().session.id);
    expect(last.workspaceId).toBe(identity.workspaceId);
    // Digests and enums only: no path anywhere in the log.
    expect(JSON.stringify(auditLines())).not.toContain(workspaceDir);
  });

  it('fsyncs the audit entry before the provider is started', async () => {
    const { app, provider, auditStore } = setup();
    const identity = await trust(app);

    const order: string[] = [];
    const append = auditStore.append.bind(auditStore);
    vi.spyOn(auditStore, 'append').mockImplementation(async (entry) => {
      const result = await append(entry);
      // Recorded only after the real append resolved, which is after its fsync (see
      // audit-store.durability.test.ts, which proves the fsync precedes the resolution).
      order.push(`audit:${entry.event}`);
      return result;
    });
    const startSession = provider.startSession.bind(provider);
    vi.spyOn(provider, 'startSession').mockImplementation((options) => {
      order.push('startSession');
      return startSession(options);
    });

    await create(app, createBody(identity));

    expect(order).toEqual(['audit:session.workspace_allowed', 'startSession']);
    vi.restoreAllMocks();
  });

  it('fsyncs the audit entry before SessionManager.create() is ever called', async () => {
    const { app, sessionManager, auditStore } = setup();
    const identity = await trust(app);

    // The stricter twin of the test above. `startSession` is the *last* effect inside `create()`, so
    // the previous ordering assertion would still hold if a future edit moved the limiter
    // reservation, the durable record write, or the lease bookkeeping ahead of the audit write. This
    // one brackets the whole of `create()` instead, which is the boundary ADI-06's own review had to
    // force into `v2-workspaces.ts` and the one this route claims in its header.
    const order: string[] = [];
    const append = auditStore.append.bind(auditStore);
    vi.spyOn(auditStore, 'append').mockImplementation(async (entry) => {
      const result = await append(entry);
      // Pushed only after the real append resolved, i.e. after its fsync (see
      // audit-store.durability.test.ts, which proves the fsync precedes the resolution).
      order.push(`audit:${entry.event}`);
      return result;
    });
    const create_ = sessionManager.create.bind(sessionManager);
    vi.spyOn(sessionManager, 'create').mockImplementation((...args) => {
      order.push('SessionManager.create');
      return create_(...args);
    });

    const res = await create(app, createBody(identity));

    expect(res.statusCode).toBe(201);
    expect(order).toEqual(['audit:session.workspace_allowed', 'SessionManager.create']);
    vi.restoreAllMocks();
  });

  it('never calls SessionManager.create when the pre-effect audit write fails', async () => {
    const { app, sessionManager, auditStore } = setup();
    const identity = await trust(app);

    const append = auditStore.append.bind(auditStore);
    vi.spyOn(auditStore, 'append').mockImplementation(async (entry) => {
      if (entry.event === 'session.workspace_allowed') throw new AuditCapacityError(1024);
      return append(entry);
    });
    const createSpy = vi.spyOn(sessionManager, 'create');

    const res = await create(app, createBody(identity));

    // The other half of "audit before effect": the ordering above proves the write happens first,
    // and this proves a failed write means the effect never happens at all rather than happening
    // unrecorded.
    expect(res.statusCode).toBe(507);
    expect(createSpy).not.toHaveBeenCalled();
    vi.restoreAllMocks();
  });

  it('refuses the session outright when the pre-effect audit write fails', async () => {
    const { app, provider, auditStore, store, leaseManager } = setup();
    const identity = await trust(app);

    const append = auditStore.append.bind(auditStore);
    vi.spyOn(auditStore, 'append').mockImplementation(async (entry) => {
      if (entry.event === 'session.workspace_allowed') throw new AuditCapacityError(1024);
      return append(entry);
    });

    const res = await create(app, createBody(identity));

    expect(res.statusCode).toBe(507);
    expect(res.json().code).toBe('audit_log_full');
    expect(provider.started).toHaveLength(0);
    expect(store.stats().records).toBe(0);
    expect(leaseManager.activeLeaseCount).toBe(0);
    vi.restoreAllMocks();
  });

  it('still answers the real refusal when auditing a denial fails', async () => {
    const { app, auditStore } = setup();
    const identity = await inspect(app); // untrusted

    vi.spyOn(auditStore, 'append').mockImplementation(() => Promise.reject(new AuditUnavailableError('disk gone')));

    const res = await create(app, createBody(identity));

    // The caller learns its workspace is not trusted, not that a log file is broken. The audit
    // failure is the operator's problem and is logged, never substituted for the answer.
    expect(res.statusCode).toBe(403);
    expect(res.json().code).toBe('workspace_not_trusted');
    vi.restoreAllMocks();
  });
});

// -------------------------------------------------------------------------------------------
// v1 regression
// -------------------------------------------------------------------------------------------

describe('v1 sessions are unaffected by ADI-13', () => {
  it('creates a v1 session whose v2 view carries no selection key at all', async () => {
    const { app, store } = setup();

    const created = await app.inject({
      method: 'POST',
      url: '/sessions',
      headers: AUTH,
      payload: { provider: 'claude', cwd: workspaceDir, prompt: 'hello', model: 'opus' },
    });
    expect(created.statusCode).toBe(201);
    await settle();

    const view = await app.inject({
      method: 'GET',
      url: `/v2/sessions/${created.json().id}`,
      headers: AUTH,
    });
    expect(view.statusCode).toBe(200);
    expect(view.json().session.protocolVersion).toBe(1);
    expect(view.json().session.model).toBe('opus');
    // The stop condition: a v1 session can never be made to carry a fabricated selection.
    expect('selection' in view.json().session).toBe(false);
    expect('selection' in store.get(created.json().id as string)!.session).toBe(false);
  });

  it('takes no lease for a v1 session, so v1 keeps its unrestricted cwd behavior', async () => {
    const { app, provider, leaseManager } = setup();
    provider.mode = 'hang';

    const first = await app.inject({
      method: 'POST',
      url: '/sessions',
      headers: AUTH,
      payload: { provider: 'claude', cwd: workspaceDir, prompt: 'hello' },
    });
    const second = await app.inject({
      method: 'POST',
      url: '/sessions',
      headers: AUTH,
      payload: { provider: 'claude', cwd: workspaceDir, prompt: 'hello again' },
    });

    expect(first.statusCode).toBe(201);
    expect(second.statusCode).toBe(201);
    expect(leaseManager.activeLeaseCount).toBe(0);
  });
});
