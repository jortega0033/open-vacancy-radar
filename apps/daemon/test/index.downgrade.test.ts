import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FAKE_PROVIDER_CAPABILITIES, FakeProvider, ProviderRegistry, noopLogger } from '@agent-dock/agent-runtime';
import type { Logger } from '@agent-dock/agent-runtime';
import { ActiveSessionLimiter } from '../src/active-session-limiter.js';
import { openDurableStore } from '../src/open-durable-store.js';
import { buildServer, type BuildServerV2Options } from '../src/server.js';
import { SessionManager } from '../src/session-manager.js';
import { STATE_DIR_ENV_VAR } from '../src/state-directory.js';
import { eventLine, makeRecord, seedManifest, seedRecord, snapshotTree } from './support/lineage-fixtures.js';
import { PERSISTED_SCHEMA_VERSION } from '../src/persisted-session-schema.js';

/**
 * The rollback path: a user runs a newer build, then goes back to this one.
 *
 * Exercised through the very function `index.ts` calls (`openDurableStore`) plus the real
 * `buildServer`, rather than by spawning the daemon binary: the daemon's own provider registry
 * would spawn actual Claude/Codex CLIs on `POST /sessions`, so an end-to-end v1 session could not
 * be asserted against a real process. Everything between the state directory and the HTTP routes is
 * the production code path.
 */

const TOKEN = 'downgrade-token';
const AUTH = { authorization: `Bearer ${TOKEN}` };

let stateRoot: string;
let cwd: string;

beforeEach(() => {
  stateRoot = mkdtempSync(join(tmpdir(), 'agent-dock-downgrade-'));
  cwd = mkdtempSync(join(tmpdir(), 'agent-dock-downgrade-cwd-'));
  vi.stubEnv(STATE_DIR_ENV_VAR, stateRoot);
});

afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(stateRoot, { recursive: true, force: true });
  rmSync(cwd, { recursive: true, force: true });
});

function silentLogger(): Logger {
  return noopLogger;
}

/** Boots the same stack `main()` does, minus the port bind and the discovery file. */
function boot() {
  const registry = new ProviderRegistry();
  registry.register(
    new FakeProvider(
      'claude',
      {
        id: 'claude',
        name: 'Claude Code',
        installed: true,
        authenticated: 'authenticated',
        capabilities: FAKE_PROVIDER_CAPABILITIES,
      },
      'success',
    ),
  );
  const limiter = new ActiveSessionLimiter();
  const durable = openDurableStore('agent-dock', silentLogger());
  const sessionManager = new SessionManager(registry, silentLogger(), undefined, limiter, durable);
  const v2: BuildServerV2Options | undefined = durable ? { store: durable, limiter } : undefined;
  const app = buildServer({
    registry,
    sessionManager,
    token: TOKEN,
    logger: silentLogger(),
    ...(v2 ? { v2 } : {}),
  });
  return { app, durable, sessionManager };
}

/**
 * State written by a build one schema version ahead of this one.
 *
 * Derived from `PERSISTED_SCHEMA_VERSION` rather than hardcoded: ADI-13 moved that constant from 1
 * to 2, which turned every literal `2` here from "a newer build" into "this build" and would have
 * left this whole suite passing while testing nothing. See the ADI-13 subsection in
 * docs/rollback-runbook-agentdock-v2.md -- a store written by *this* build (`schemaVersion: 2`) is
 * exactly the state a pre-ADI-13 daemon sees, and it refuses it the same way.
 */
function seedFutureState(): void {
  seedManifest(stateRoot, { schemaVersion: PERSISTED_SCHEMA_VERSION + 1 });
  const record = makeRecord({ status: 'completed', terminalReason: 'provider_completed', acceptedWork: 'accepted' });
  seedRecord(stateRoot, record, [eventLine(0)]);
}

describe('a future state schema version downgrades the daemon to v1-only', () => {
  it('still starts: openDurableStore returns undefined instead of throwing', () => {
    seedFutureState();
    expect(() => openDurableStore('agent-dock', silentLogger())).not.toThrow();
    expect(openDurableStore('agent-dock', silentLogger())).toBeUndefined();
  });

  it('serves v1 POST /sessions end to end', async () => {
    seedFutureState();
    const { app } = boot();

    const created = await app.inject({
      method: 'POST',
      url: '/sessions',
      headers: AUTH,
      payload: { provider: 'claude', cwd, prompt: 'hello' },
    });
    expect(created.statusCode).toBe(201);

    await new Promise((resolve) => setTimeout(resolve, 40));

    const fetched = await app.inject({ method: 'GET', url: `/sessions/${created.json().id}`, headers: AUTH });
    expect(fetched.statusCode).toBe(200);
    expect(fetched.json().status).toBe('completed');

    const events = await app.inject({ method: 'GET', url: `/sessions/${created.json().id}/events`, headers: AUTH });
    expect(events.headers['content-type']).toContain('text/event-stream');
    expect(events.payload).toContain('event: session.completed');
    await app.close();
  });

  it('reports supportedProtocolVersions: [1] on /health', async () => {
    seedFutureState();
    const { app } = boot();
    const health = (await app.inject({ method: 'GET', url: '/health' })).json();
    expect(health.protocolVersion).toBe(1);
    expect(health.supportedProtocolVersions).toEqual([1]);
    await app.close();
  });

  it('404s every v2 route', async () => {
    seedFutureState();
    const { app } = boot();
    for (const url of [
      '/v2/providers',
      '/v2/providers/claude',
      '/v2/sessions',
      '/v2/sessions/00000000-0000-4000-8000-000000000000',
      '/v2/sessions/00000000-0000-4000-8000-000000000000/events',
    ]) {
      const res = await app.inject({ method: 'GET', url, headers: AUTH });
      expect(res.statusCode, `${url} should not be registered`).toBe(404);
    }
    await app.close();
  });

  it('leaves the whole state tree byte-identical across a full start / serve / shutdown cycle', async () => {
    seedFutureState();
    const before = snapshotTree(stateRoot);

    const { app, sessionManager } = boot();
    const created = await app.inject({
      method: 'POST',
      url: '/sessions',
      headers: AUTH,
      payload: { provider: 'claude', cwd, prompt: 'hello' },
    });
    expect(created.statusCode).toBe(201);
    await new Promise((resolve) => setTimeout(resolve, 40));
    await sessionManager.cancelAll(500);
    await app.close();

    // A whole session ran, and not one byte of the newer build's state was read into, written over,
    // quarantined, or renamed. This is what makes rolling forward again safe.
    expect(snapshotTree(stateRoot)).toEqual(before);
  });
});

describe('the same stack with a current schema version runs v2', () => {
  it('opens the store, registers v2 routes, and advertises [1, 2]', async () => {
    seedManifest(stateRoot, { schemaVersion: 1 });
    const { app, durable } = boot();

    expect(durable).toBeDefined();
    const health = (await app.inject({ method: 'GET', url: '/health' })).json();
    expect(health.supportedProtocolVersions).toEqual([1, 2]);
    expect((await app.inject({ method: 'GET', url: '/v2/sessions', headers: AUTH })).statusCode).toBe(200);
    await app.close();
  });

  it('records a v1-created session in the durable store', async () => {
    seedManifest(stateRoot, { schemaVersion: 1 });
    const { app, durable } = boot();

    const created = await app.inject({
      method: 'POST',
      url: '/sessions',
      headers: AUTH,
      payload: { provider: 'claude', cwd, prompt: 'hello' },
    });
    await new Promise((resolve) => setTimeout(resolve, 40));

    const record = durable?.get(created.json().id);
    expect(record?.session.status).toBe('completed');
    expect(record?.session.terminalReason).toBe('provider_completed');
    expect(JSON.stringify(record)).not.toContain('hello');
    await app.close();
  });
});
