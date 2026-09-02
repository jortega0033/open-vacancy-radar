import { mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { ProviderRegistry, noopLogger } from '@agent-dock/agent-runtime';
import type { AgentEvent, ProviderId, ProviderStatus } from '@agent-dock/shared';
import type { AgentProvider, ProviderSessionHandle, StartSessionOptions } from '@agent-dock/agent-runtime';
import { auditEntryV2Schema, workspaceTrustViewSchema } from '@agent-dock/shared';
import { AuditStore, AuditUnavailableError } from '../src/audit-store.js';
import { ActiveSessionLimiter } from '../src/active-session-limiter.js';
import { SessionLineageStore } from '../src/session-lineage-store.js';
import { SessionManager } from '../src/session-manager.js';
import { WorkspaceTrustStore } from '../src/workspace-trust-store.js';
import { buildServer } from '../src/server.js';
import { resolveWorkspaceIdentity } from '../src/workspace-identity.js';

// Every route here resolves a real workspace identity, which spawns `git rev-parse` and
// `git status`. See the same note in workspace-identity.test.ts for why the default 5s ceiling is
// too close to real process-startup cost under a parallel run.
vi.setConfig({ testTimeout: 30_000 });

const TOKEN = 'test-token-123';
const AUTH = { authorization: `Bearer ${TOKEN}` };

/** A provider whose sessions never end on their own, so revocation has something live to cancel. */
class TestProvider implements AgentProvider {
  readonly id: ProviderId = 'claude';
  readonly name = 'Test Provider';
  readonly started: string[] = [];
  readonly cancelled = new Set<string>();

  async detect(): Promise<ProviderStatus> {
    return {
      id: this.id,
      name: this.name,
      installed: true,
      authenticated: 'authenticated',
      capabilities: { resume: true, cancellation: true, tools: true, usage: true, thinking: true },
    };
  }

  startSession(options: StartSessionOptions): ProviderSessionHandle {
    this.started.push(options.sessionId);
    let closed = false;
    const waiters: Array<(result: IteratorResult<AgentEvent>) => void> = [];
    const cancelled = this.cancelled;
    return {
      events: (async function* () {
        while (!closed) {
          const next = await new Promise<IteratorResult<AgentEvent>>((resolve) => waiters.push(resolve));
          if (next.done) return;
          yield next.value;
        }
      })(),
      cancel: async () => {
        cancelled.add(options.sessionId);
        closed = true;
        for (const waiter of waiters.splice(0)) waiter({ value: undefined, done: true });
      },
    };
  }
}

let stateRoot: string;
let workspaceRoot: string;
let workspaceDir: string;

interface Harness {
  app: FastifyInstance;
  auditStore: AuditStore;
  trustStore: WorkspaceTrustStore;
  sessionManager: SessionManager;
  provider: TestProvider;
}

function setup(options: { withWorkspaceStores?: boolean; maxAuditBytes?: number } = {}): Harness {
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
  const sessionManager = new SessionManager(registry, noopLogger, undefined, limiter, store, { trustStore });

  const app = buildServer({
    registry,
    sessionManager,
    token: TOKEN,
    logger: noopLogger,
    v2: {
      store,
      limiter,
      ...(options.withWorkspaceStores === false ? {} : { workspace: { trustStore, auditStore } }),
    },
  });

  return { app, auditStore, trustStore, sessionManager, provider };
}

beforeEach(() => {
  stateRoot = mkdtempSync(join(tmpdir(), 'agent-dock-v2-workspaces-state-'));
  workspaceRoot = mkdtempSync(join(tmpdir(), 'agent-dock-v2-workspaces-'));
  workspaceDir = join(workspaceRoot, 'SENTINEL_WORKSPACE_NAME');
  mkdirSync(workspaceDir, { recursive: true });
});

afterEach(() => {
  rmSync(stateRoot, { recursive: true, force: true });
  rmSync(workspaceRoot, { recursive: true, force: true });
});

async function inspect(app: FastifyInstance, path = workspaceDir) {
  return app.inject({
    method: 'POST',
    url: '/v2/workspaces/inspect',
    headers: AUTH,
    payload: { path, provider: 'claude' },
  });
}

async function consume(app: FastifyInstance, body: Record<string, unknown>) {
  return app.inject({ method: 'POST', url: '/v2/workspaces/consume-grant', headers: AUTH, payload: body });
}

function auditLines(): Record<string, unknown>[] {
  const file = join(stateRoot, 'workspace-audit', 'audit.jsonl');
  return readFileSync(file, 'utf8')
    .trim()
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

describe('POST /v2/workspaces/inspect', () => {
  it('returns a trust view carrying no path at all', async () => {
    const { app } = setup();
    const res = await inspect(app);
    expect(res.statusCode).toBe(200);

    const view = workspaceTrustViewSchema.parse(res.json().workspace);
    expect(view.state).toBe('untrusted');
    expect(view.displayName).toBe('SENTINEL_WORKSPACE_NAME');
    expect(view.reusable).toBe(true);

    // The whole response body, not just the fields the schema names.
    const body = res.body;
    expect(body).not.toContain(workspaceDir);
    expect(body).not.toContain(workspaceRoot);
    expect(body).not.toMatch(/[A-Za-z]:\\\\/);
  });

  it('refuses a UNC path with a distinct, actionable code (D6)', async () => {
    const { app } = setup();
    const res = await inspect(app, '\\\\server\\share\\repo');
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe('unc_workspace_unsupported');
    expect(res.json().error).toMatch(/local drive/i);
  });

  it('refuses a path that does not exist, with a different code from the UNC one', async () => {
    const { app } = setup();
    const res = await inspect(app, join(workspaceRoot, 'nope'));
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe('invalid_workspace_path');
  });

  it('writes no audit entry: inspection is not a decision', async () => {
    const { app, auditStore } = setup();
    await inspect(app);
    expect(auditStore.entryCount).toBe(0);
  });

  it('requires the bearer token, like every other privileged route', async () => {
    const { app } = setup();
    const res = await app.inject({
      method: 'POST',
      url: '/v2/workspaces/inspect',
      payload: { path: workspaceDir, provider: 'claude' },
    });
    expect(res.statusCode).toBe(401);
  });
});

describe('trust cannot be self-asserted (D3)', () => {
  it('rejects PUT .../trust with state "trusted", specifically and with an explanation', async () => {
    const { app, trustStore } = setup();
    const view = workspaceTrustViewSchema.parse((await inspect(app)).json().workspace);

    const res = await app.inject({
      method: 'PUT',
      url: `/v2/workspaces/${view.workspaceId}/trust`,
      headers: AUTH,
      payload: { state: 'trusted', incarnation: view.incarnation },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe('trust_not_self_assertable');
    expect(trustStore.inspectSync(view.workspaceId).state).toBe('untrusted');
  });

  it('has no other route that produces a trusted state from a caller-supplied value', async () => {
    // An exhaustive negative: every method/URL combination a caller could reach with a body naming
    // `trusted`, none of which may result in a trusted workspace.
    const { app, trustStore } = setup();
    const view = workspaceTrustViewSchema.parse((await inspect(app)).json().workspace);
    const attempts: Array<{ method: 'POST' | 'PUT' | 'PATCH'; url: string }> = [
      { method: 'PUT', url: `/v2/workspaces/${view.workspaceId}/trust` },
      { method: 'POST', url: `/v2/workspaces/${view.workspaceId}/trust` },
      { method: 'PATCH', url: `/v2/workspaces/${view.workspaceId}/trust` },
      { method: 'POST', url: '/v2/workspaces/inspect' },
      { method: 'POST', url: '/v2/workspaces/grant-events' },
    ];

    for (const attempt of attempts) {
      await app.inject({
        method: attempt.method,
        url: attempt.url,
        headers: AUTH,
        payload: {
          state: 'trusted',
          workspaceId: view.workspaceId,
          incarnation: view.incarnation,
          provider: 'claude',
          path: workspaceDir,
          event: 'trust.granted',
          actor: 'user',
        },
      });
      expect(trustStore.inspectSync(view.workspaceId).state, `${attempt.method} ${attempt.url}`).toBe(
        'untrusted',
      );
    }
  });

  it('refuses a consume-grant whose claimed identity nothing on disk vouches for', async () => {
    const { app, trustStore, auditStore } = setup();
    const res = await consume(app, {
      path: workspaceDir,
      provider: 'claude',
      // A caller inventing a pair: exactly what a renderer-asserted trust request would look like.
      workspaceId: 'd'.repeat(64),
      incarnation: 'e'.repeat(64),
    });

    expect(res.statusCode).toBe(409);
    expect(res.json().code).toBe('workspace_identity_drift');
    expect(trustStore.all()).toHaveLength(0);
    // The refusal is recorded against the RESOLVED identity, never the claimed one.
    expect(auditStore.entryCount).toBe(1);
    const entry = auditEntryV2Schema.parse(auditLines()[0]);
    expect(entry.event).toBe('grant.denied');
    expect(entry.reason).toBe('identity_drift');
    expect(entry.workspaceId).not.toBe('d'.repeat(64));
  });

  it('refuses the grant-events route as a way to fabricate a trust event', async () => {
    const { app } = setup();
    const view = workspaceTrustViewSchema.parse((await inspect(app)).json().workspace);
    const res = await app.inject({
      method: 'POST',
      url: '/v2/workspaces/grant-events',
      headers: AUTH,
      payload: {
        event: 'trust.granted',
        workspaceId: view.workspaceId,
        incarnation: view.incarnation,
        provider: 'claude',
        actor: 'user',
      },
    });
    expect(res.statusCode).toBe(400);
  });
});

describe('POST /v2/workspaces/consume-grant', () => {
  it('marks the workspace trusted, once both of its audit entries are durable', async () => {
    const { app, trustStore, sessionManager } = setup();
    const view = workspaceTrustViewSchema.parse((await inspect(app)).json().workspace);

    const res = await consume(app, {
      path: workspaceDir,
      provider: 'claude',
      workspaceId: view.workspaceId,
      incarnation: view.incarnation,
    });

    expect(res.statusCode).toBe(200);
    expect(workspaceTrustViewSchema.parse(res.json().workspace).state).toBe('trusted');
    expect(trustStore.matches(view.workspaceId, view.incarnation)).toBe(true);
    expect(sessionManager.isWorkspaceBlocked(view.workspaceId)).toBe(false);

    const events = auditLines().map((entry) => entry.event);
    expect(events).toEqual(['grant.consumed', 'trust.granted']);
  });

  it('reports trusted on a later inspection, and only for the granted incarnation', async () => {
    const { app } = setup();
    const view = workspaceTrustViewSchema.parse((await inspect(app)).json().workspace);
    await consume(app, {
      path: workspaceDir,
      provider: 'claude',
      workspaceId: view.workspaceId,
      incarnation: view.incarnation,
    });

    const after = workspaceTrustViewSchema.parse((await inspect(app)).json().workspace);
    expect(after.state).toBe('trusted');

    // Move the directory: same object, different place, so a new incarnation. The stored record
    // still names the old one, and the view must not claim trust for a folder the user did not
    // approve at this path.
    const moved = join(workspaceRoot, 'moved-workspace');
    renameSync(workspaceDir, moved);
    const afterMove = workspaceTrustViewSchema.parse((await inspect(app, moved)).json().workspace);
    expect(afterMove.state).toBe('untrusted');
  });

  it('denies when the directory was swapped between inspection and consumption', async () => {
    const { app, trustStore } = setup();
    const view = workspaceTrustViewSchema.parse((await inspect(app)).json().workspace);

    // The classic time-of-check/time-of-use swap: same path, different object.
    rmSync(workspaceDir, { recursive: true, force: true });
    mkdirSync(workspaceDir, { recursive: true });

    const res = await consume(app, {
      path: workspaceDir,
      provider: 'claude',
      workspaceId: view.workspaceId,
      incarnation: view.incarnation,
    });

    expect(res.statusCode).toBe(409);
    expect(res.json().code).toBe('workspace_identity_drift');
    expect(trustStore.all()).toHaveLength(0);
  });

  it('denies a workspace whose trust was revoked while the request was in flight', async () => {
    const { app, sessionManager, trustStore } = setup();
    const view = workspaceTrustViewSchema.parse((await inspect(app)).json().workspace);
    sessionManager.blockWorkspace(view.workspaceId);

    const res = await consume(app, {
      path: workspaceDir,
      provider: 'claude',
      workspaceId: view.workspaceId,
      incarnation: view.incarnation,
    });

    expect(res.statusCode).toBe(403);
    expect(res.json().code).toBe('workspace_revoked');
    expect(trustStore.all()).toHaveLength(0);
    expect(auditLines().at(-1)?.reason).toBe('trust_revoked');
  });

  it('rejects a malformed body rather than resolving anything from it', async () => {
    const { app } = setup();
    const res = await consume(app, { path: workspaceDir, provider: 'claude', workspaceId: 'short' });
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe('invalid_request');
  });
});

describe('audit is never best-effort', () => {
  it('denies the grant, grants no trust, and spawns no provider process when the audit append fails', async () => {
    const { app, auditStore, trustStore, provider } = setup();
    const view = workspaceTrustViewSchema.parse((await inspect(app)).json().workspace);

    auditStore.append = () => Promise.reject(new AuditUnavailableError('injected'));

    const res = await consume(app, {
      path: workspaceDir,
      provider: 'claude',
      workspaceId: view.workspaceId,
      incarnation: view.incarnation,
    });

    expect(res.statusCode).toBe(503);
    expect(res.json().code).toBe('audit_unavailable');
    expect(trustStore.all()).toHaveLength(0);
    expect(provider.started).toEqual([]);
  });

  it('answers 507 for a full log, distinguishing "archive this" from "restart this"', async () => {
    // A cap below the size of a single entry, so the very first append this route attempts is
    // refused for capacity rather than for a fault. 507 (Insufficient Storage) rather than 503:
    // the daemon is healthy, and archiving one file fixes it.
    const { app, trustStore } = setup({ maxAuditBytes: 10 });
    const view = workspaceTrustViewSchema.parse((await inspect(app)).json().workspace);

    const res = await consume(app, {
      path: workspaceDir,
      provider: 'claude',
      workspaceId: view.workspaceId,
      incarnation: view.incarnation,
    });

    expect(res.statusCode).toBe(507);
    expect(res.json().code).toBe('audit_log_full');
    // Denied, not degraded: a full audit log refuses the action rather than performing it unrecorded.
    expect(trustStore.all()).toHaveLength(0);
  });

  it('completes BOTH audit writes BEFORE it grants trust or answers, in that exact order', async () => {
    const { app, auditStore, trustStore } = setup();
    const view = workspaceTrustViewSchema.parse((await inspect(app)).json().workspace);

    const order: string[] = [];
    const realAppend = auditStore.append.bind(auditStore);
    auditStore.append = async (entry) => {
      const written = await realAppend(entry);
      order.push(`audit:${entry.event}`);
      return written;
    };
    const realSetTrusted = trustStore.setTrusted.bind(trustStore);
    trustStore.setTrusted = async (identity, provider) => {
      order.push('trust:set');
      return realSetTrusted(identity, provider);
    };

    await consume(app, {
      path: workspaceDir,
      provider: 'claude',
      workspaceId: view.workspaceId,
      incarnation: view.incarnation,
    });
    order.push('responded');

    // `trust.granted` is a pre-commit record: it is fsynced before the durable, externally
    // observable mutation it describes, never after it. The reverse order leaves a window in which a
    // crash produces a permanently trusted workspace that nothing recorded.
    expect(order).toEqual(['audit:grant.consumed', 'audit:trust.granted', 'trust:set', 'responded']);
  });

  it('never reaches setTrusted when the pre-commit audit entry cannot be written', async () => {
    const { app, auditStore, trustStore, sessionManager } = setup();
    const view = workspaceTrustViewSchema.parse((await inspect(app)).json().workspace);

    const realAppend = auditStore.append.bind(auditStore);
    auditStore.append = async (entry) => {
      if (entry.event === 'trust.granted') throw new AuditUnavailableError('injected');
      return realAppend(entry);
    };
    let setTrustedCalls = 0;
    const realSetTrusted = trustStore.setTrusted.bind(trustStore);
    trustStore.setTrusted = async (identity, provider) => {
      setTrustedCalls += 1;
      return realSetTrusted(identity, provider);
    };

    const res = await consume(app, {
      path: workspaceDir,
      provider: 'claude',
      workspaceId: view.workspaceId,
      incarnation: view.incarnation,
    });

    expect(res.statusCode).toBe(503);
    // Nothing to roll back, because nothing was ever done: the audit write is a precondition of the
    // mutation now, not a report of it. No trust on disk, and no block needed to contain a
    // half-grant that never existed.
    expect(setTrustedCalls).toBe(0);
    expect(trustStore.matches(view.workspaceId, view.incarnation)).toBe(false);
    expect(sessionManager.isWorkspaceBlocked(view.workspaceId)).toBe(false);
  });

  it('leaves NO trust on disk when the daemon dies between the audit entry and setTrusted', async () => {
    // The crash simulation the ordering exists for: the audit write succeeds and fsyncs, and then
    // the process never gets to persist trust. A second store opened over the same state root is
    // what a restarted daemon would see, so this asserts on the bytes, not on an in-memory object.
    const { app, trustStore } = setup();
    const view = workspaceTrustViewSchema.parse((await inspect(app)).json().workspace);

    trustStore.setTrusted = () => {
      throw new Error('simulated crash: the daemon died before trust could be persisted');
    };

    const res = await consume(app, {
      path: workspaceDir,
      provider: 'claude',
      workspaceId: view.workspaceId,
      incarnation: view.incarnation,
    });

    expect(res.statusCode).toBe(500);
    expect(res.json().code).toBe('trust_write_failed');

    // What a restart would read back.
    const afterRestart = new WorkspaceTrustStore({ stateRoot });
    expect(afterRestart.matches(view.workspaceId, view.incarnation)).toBe(false);
    expect(afterRestart.inspectSync(view.workspaceId).state).toBe('untrusted');

    // And the log is the conservative side of the discrepancy: it claims a grant that did not take
    // effect, rather than hiding one that did.
    expect(auditLines().map((entry) => entry.event)).toEqual(['grant.consumed', 'trust.granted']);
  });

  it('reports an audit fault with a closed code and no filesystem path in the body', async () => {
    // A real failure, not an injected error object: the audit log's own file is replaced by a
    // directory, so `appendDurably`'s open fails with an EISDIR whose message names the log path.
    // That message must never reach a caller -- main.ts relays these bodies toward the renderer.
    const { app } = setup();
    const view = workspaceTrustViewSchema.parse((await inspect(app)).json().workspace);

    const logPath = join(stateRoot, 'workspace-audit', 'audit.jsonl');
    mkdirSync(logPath, { recursive: true });

    const res = await consume(app, {
      path: workspaceDir,
      provider: 'claude',
      workspaceId: view.workspaceId,
      incarnation: view.incarnation,
    });

    expect(res.statusCode).toBe(503);
    expect(res.json().code).toBe('audit_unavailable');
    for (const sentinel of [logPath, stateRoot, 'audit.jsonl', tmpdir()]) {
      expect(res.body, `${sentinel} leaked into the response`).not.toContain(sentinel);
    }
    expect(res.body).not.toMatch(/[A-Za-z]:\\/);
    expect(res.body).not.toContain('/');
  });
});

describe('consume-grant brackets its awaits with the revocation epoch', () => {
  it('denies, and does not clear the block, when a revocation lands during the audit writes', async () => {
    const { app, auditStore, trustStore, sessionManager } = setup();
    const view = workspaceTrustViewSchema.parse((await inspect(app)).json().workspace);

    // The revocation lands inside the `trust.granted` write: after the entry check at the top of the
    // route, and before the mutation. Only the re-check placed immediately before `setTrusted` can
    // see it.
    const realAppend = auditStore.append.bind(auditStore);
    auditStore.append = async (entry) => {
      const written = await realAppend(entry);
      if (entry.event === 'trust.granted') sessionManager.blockWorkspace(view.workspaceId);
      return written;
    };
    let setTrustedCalls = 0;
    const realSetTrusted = trustStore.setTrusted.bind(trustStore);
    trustStore.setTrusted = async (identity, provider) => {
      setTrustedCalls += 1;
      return realSetTrusted(identity, provider);
    };

    const res = await consume(app, {
      path: workspaceDir,
      provider: 'claude',
      workspaceId: view.workspaceId,
      incarnation: view.incarnation,
    });

    expect(res.statusCode).toBe(403);
    expect(res.json().code).toBe('workspace_revoked');
    // Never persisted in the first place. Both re-checks would leave the *answer* at 403 -- the one
    // after `setTrusted` would write trust and then roll it back -- so this call count is what
    // distinguishes the pre-persist check from its successor, and what fails if it is removed.
    expect(setTrustedCalls).toBe(0);
    // The consumption must not overwrite the revocation that beat it.
    expect(sessionManager.isWorkspaceBlocked(view.workspaceId)).toBe(true);
    expect(trustStore.matches(view.workspaceId, view.incarnation)).toBe(false);
    expect(new WorkspaceTrustStore({ stateRoot }).inspectSync(view.workspaceId).state).toBe('untrusted');
    expect(auditLines().at(-1)?.reason).toBe('trust_revoked');
  });

  it('rolls trust back and keeps the block when a revocation lands during setTrusted itself', async () => {
    const { app, trustStore, sessionManager } = setup();
    const view = workspaceTrustViewSchema.parse((await inspect(app)).json().workspace);

    // The narrowest window there is: the trust write itself. Without the second re-check the route
    // would fall through to `allowWorkspace()` and silently convert this revocation into a grant.
    const realSetTrusted = trustStore.setTrusted.bind(trustStore);
    trustStore.setTrusted = async (identity, provider) => {
      const result = await realSetTrusted(identity, provider);
      sessionManager.blockWorkspace(view.workspaceId);
      return result;
    };

    const res = await consume(app, {
      path: workspaceDir,
      provider: 'claude',
      workspaceId: view.workspaceId,
      incarnation: view.incarnation,
    });

    expect(res.statusCode).toBe(403);
    expect(res.json().code).toBe('workspace_revoked');
    expect(sessionManager.isWorkspaceBlocked(view.workspaceId)).toBe(true);
    expect(new WorkspaceTrustStore({ stateRoot }).matches(view.workspaceId, view.incarnation)).toBe(false);
  });

  it('denies a consumption whose epoch moved even though nothing is blocked right now', async () => {
    const { app, auditStore, trustStore, sessionManager } = setup();
    const view = workspaceTrustViewSchema.parse((await inspect(app)).json().workspace);

    // Block and allow inside one await: a boolean "is it blocked" test would see nothing at either
    // end. The epoch counter is what makes the intervening revocation visible at all. Recorded as
    // `not_trusted`, not `trust_revoked`, because by the time we look nothing is revoked.
    const realAppend = auditStore.append.bind(auditStore);
    auditStore.append = async (entry) => {
      const written = await realAppend(entry);
      if (entry.event === 'grant.consumed') {
        sessionManager.blockWorkspace(view.workspaceId);
        sessionManager.allowWorkspace(view.workspaceId);
      }
      return written;
    };

    const res = await consume(app, {
      path: workspaceDir,
      provider: 'claude',
      workspaceId: view.workspaceId,
      incarnation: view.incarnation,
    });

    expect(res.statusCode).toBe(409);
    expect(res.json().code).toBe('workspace_grant_stale');
    expect(trustStore.matches(view.workspaceId, view.incarnation)).toBe(false);
    expect(auditLines().at(-1)?.reason).toBe('not_trusted');
  });
});

describe('PUT /v2/workspaces/:workspaceId/trust: revocation', () => {
  it('cancels every live session in the workspace and records both revocation events', async () => {
    const { app, sessionManager, provider, trustStore } = setup();
    const view = workspaceTrustViewSchema.parse((await inspect(app)).json().workspace);
    await consume(app, {
      path: workspaceDir,
      provider: 'claude',
      workspaceId: view.workspaceId,
      incarnation: view.incarnation,
    });

    const session = sessionManager.create(
      'claude',
      workspaceDir,
      'prompt',
      undefined,
      undefined,
      1,
      view.workspaceId,
    );

    const res = await app.inject({
      method: 'PUT',
      url: `/v2/workspaces/${view.workspaceId}/trust`,
      headers: AUTH,
      payload: { state: 'untrusted' },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().cancelledSessions).toBe(1);
    expect(provider.cancelled.has(session.id)).toBe(true);
    expect(sessionManager.isWorkspaceBlocked(view.workspaceId)).toBe(true);
    expect(trustStore.inspectSync(view.workspaceId).state).toBe('untrusted');

    const events = auditLines().map((entry) => entry.event);
    expect(events).toEqual([
      'grant.consumed',
      'trust.granted',
      'trust.revocation_started',
      'trust.revoked',
    ]);
  });

  it('holds a workspace closed in the `revoking` state without finishing the revocation', async () => {
    const { app, sessionManager, trustStore } = setup();
    const view = workspaceTrustViewSchema.parse((await inspect(app)).json().workspace);
    await consume(app, {
      path: workspaceDir,
      provider: 'claude',
      workspaceId: view.workspaceId,
      incarnation: view.incarnation,
    });

    const res = await app.inject({
      method: 'PUT',
      url: `/v2/workspaces/${view.workspaceId}/trust`,
      headers: AUTH,
      payload: { state: 'revoking' },
    });

    expect(res.statusCode).toBe(200);
    expect(trustStore.inspectSync(view.workspaceId).state).toBe('revoking');
    expect(sessionManager.isWorkspaceBlocked(view.workspaceId)).toBe(true);
    expect(auditLines().map((entry) => entry.event)).toEqual([
      'grant.consumed',
      'trust.granted',
      'trust.revocation_started',
    ]);
  });

  it('still cancels live sessions when the trust.revocation_started audit entry fails', async () => {
    // The inversion of the grant path's rule, and the reason it exists. `blockWorkspace()` has
    // already run by the time the audit is attempted, so returning on a failed write would leave a
    // workspace that is revoked for new sessions but still has the user's files open under a running
    // CLI. The audit fault is reported; the teardown happens anyway.
    const { app, auditStore, sessionManager, provider, trustStore } = setup();
    const view = workspaceTrustViewSchema.parse((await inspect(app)).json().workspace);
    await consume(app, {
      path: workspaceDir,
      provider: 'claude',
      workspaceId: view.workspaceId,
      incarnation: view.incarnation,
    });

    const session = sessionManager.create(
      'claude',
      workspaceDir,
      'prompt',
      undefined,
      undefined,
      1,
      view.workspaceId,
    );

    const realAppend = auditStore.append.bind(auditStore);
    auditStore.append = async (entry) => {
      if (entry.event === 'trust.revocation_started') throw new AuditUnavailableError('injected');
      return realAppend(entry);
    };

    const res = await app.inject({
      method: 'PUT',
      url: `/v2/workspaces/${view.workspaceId}/trust`,
      headers: AUTH,
      payload: { state: 'untrusted' },
    });

    // The caller is told the log is broken, with the same closed code every other route uses...
    expect(res.statusCode).toBe(503);
    expect(res.json().code).toBe('audit_unavailable');
    expect(res.body).not.toContain(stateRoot);
    // ...about a revocation that was nonetheless carried out in full.
    expect(provider.cancelled.has(session.id)).toBe(true);
    expect(sessionManager.isWorkspaceBlocked(view.workspaceId)).toBe(true);
    expect(trustStore.inspectSync(view.workspaceId).state).toBe('untrusted');
  });

  it('404s for a workspace nothing was ever granted for, rather than inventing audit fields', async () => {
    const { app, auditStore } = setup();
    const res = await app.inject({
      method: 'PUT',
      url: `/v2/workspaces/${'c'.repeat(64)}/trust`,
      headers: AUTH,
      payload: { state: 'untrusted' },
    });
    expect(res.statusCode).toBe(404);
    expect(auditStore.entryCount).toBe(0);
  });

  it('400s for a workspace id that is not a digest', async () => {
    const { app } = setup();
    const res = await app.inject({
      method: 'PUT',
      url: '/v2/workspaces/not-a-digest/trust',
      headers: AUTH,
      payload: { state: 'untrusted' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe('invalid_workspace_id');
  });
});

describe('the full grant-issue-consume-revoke cycle leaves no path behind (sentinel sweep)', () => {
  it('writes only digests, enums, uuids, and timestamps to every file it touched', async () => {
    const { app } = setup();
    const view = workspaceTrustViewSchema.parse((await inspect(app)).json().workspace);

    await app.inject({
      method: 'POST',
      url: '/v2/workspaces/grant-events',
      headers: AUTH,
      payload: {
        event: 'grant.issued',
        workspaceId: view.workspaceId,
        incarnation: view.incarnation,
        provider: 'claude',
        actor: 'user',
      },
    });
    await consume(app, {
      path: workspaceDir,
      provider: 'claude',
      workspaceId: view.workspaceId,
      incarnation: view.incarnation,
    });
    await app.inject({
      method: 'PUT',
      url: `/v2/workspaces/${view.workspaceId}/trust`,
      headers: AUTH,
      payload: { state: 'untrusted' },
    });

    const contents = readAllContents(join(stateRoot, 'workspace-audit')) + readAllContents(join(stateRoot, 'workspace-trust'));
    for (const sentinel of ['SENTINEL_WORKSPACE_NAME', workspaceDir, workspaceRoot, tmpdir()]) {
      expect(contents, `${sentinel} leaked to disk`).not.toContain(sentinel);
    }
    expect(contents).not.toMatch(/[A-Za-z]:\\/);

    // And the cycle really did happen: four audit events, in order.
    expect(auditLines().map((entry) => entry.event)).toEqual([
      'grant.issued',
      'grant.consumed',
      'trust.granted',
      'trust.revocation_started',
      'trust.revoked',
    ]);
  });
});

describe('GET /v2/audit', () => {
  it('pages the log oldest-first and is read-only', async () => {
    const { app, auditStore } = setup();
    for (let i = 0; i < 5; i++) {
      await auditStore.append({
        event: 'grant.issued',
        workspaceId: 'a'.repeat(64),
        incarnation: 'b'.repeat(64),
        provider: 'claude',
        transport: 'legacy-one-shot',
        actor: 'user',
      });
    }

    const first = await app.inject({ method: 'GET', url: '/v2/audit?limit=2', headers: AUTH });
    expect(first.statusCode).toBe(200);
    expect(first.json().entries.map((entry: { sequence: number }) => entry.sequence)).toEqual([0, 1]);

    const second = await app.inject({
      method: 'GET',
      url: `/v2/audit?limit=2&cursor=${first.json().nextCursor as string}`,
      headers: AUTH,
    });
    expect(second.json().entries.map((entry: { sequence: number }) => entry.sequence)).toEqual([2, 3]);

    // There is no way to remove anything.
    for (const method of ['DELETE', 'POST', 'PUT'] as const) {
      const res = await app.inject({ method, url: '/v2/audit', headers: AUTH });
      expect(res.statusCode).toBe(404);
    }
  });

  it('400s an out-of-range limit and a malformed cursor rather than clamping either', async () => {
    const { app } = setup();
    expect((await app.inject({ method: 'GET', url: '/v2/audit?limit=0', headers: AUTH })).statusCode).toBe(400);
    expect((await app.inject({ method: 'GET', url: '/v2/audit?limit=9999', headers: AUTH })).statusCode).toBe(400);
    expect(
      (await app.inject({ method: 'GET', url: '/v2/audit?cursor=../../etc', headers: AUTH })).statusCode,
    ).toBe(400);
  });

  it('reports the store`s health, so a client can stop pretending decisions are being recorded', async () => {
    const { app, auditStore } = setup();
    auditStore.close();
    const res = await app.inject({ method: 'GET', url: '/v2/audit', headers: AUTH });
    expect(res.json().unhealthy).toBe(true);
  });

  it('requires the bearer token', async () => {
    const { app } = setup();
    expect((await app.inject({ method: 'GET', url: '/v2/audit' })).statusCode).toBe(401);
  });
});

describe('the downgrade path', () => {
  it('registers no workspace or audit route at all when the stores are absent', async () => {
    const { app } = setup({ withWorkspaceStores: false });
    for (const url of ['/v2/audit', '/v2/workspaces/inspect', `/v2/workspaces/${'a'.repeat(64)}/trust`]) {
      const res = await app.inject({ method: 'POST', url, headers: AUTH, payload: {} });
      expect(res.statusCode, url).toBe(404);
    }
    // The ADI-05 v2 read routes are unaffected: this downgrade is narrower than that one.
    expect((await app.inject({ method: 'GET', url: '/v2/sessions', headers: AUTH })).statusCode).toBe(200);
  });
});

describe('GET /health carries a stable daemon instance id (D7)', () => {
  it('reports the same uuid for the life of one server, and a different one for another', async () => {
    const first = setup();
    const a = (await first.app.inject({ method: 'GET', url: '/health' })).json();
    const b = (await first.app.inject({ method: 'GET', url: '/health' })).json();
    expect(a.daemonInstanceId).toMatch(/^[0-9a-f-]{36}$/);
    expect(b.daemonInstanceId).toBe(a.daemonInstanceId);

    const second = setup();
    const c = (await second.app.inject({ method: 'GET', url: '/health' })).json();
    expect(c.daemonInstanceId).not.toBe(a.daemonInstanceId);
  });
});

/** File contents only, with no filenames: see the same helper in audit-store.test.ts. */
function readAllContents(dir: string): string {
  let out = '';
  for (const child of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, child.name);
    out += child.isDirectory() ? readAllContents(full) : readFileSync(full, 'utf8');
  }
  return out;
}

/** Kept honest: the identity the routes resolve is the one this module resolves. */
describe('route identity matches the module`s own', () => {
  it('returns the same workspaceId the resolver produces directly', async () => {
    const { app } = setup();
    const view = workspaceTrustViewSchema.parse((await inspect(app)).json().workspace);
    const direct = await resolveWorkspaceIdentity(workspaceDir);
    expect(view.workspaceId).toBe(direct.workspaceId);
    expect(view.incarnation).toBe(direct.incarnation);
  });
});
