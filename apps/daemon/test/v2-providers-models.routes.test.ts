import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { noopLogger, ProviderRegistry } from '@agent-dock/agent-runtime';
import type { AgentProvider, ProviderModelCatalogOptions, ProviderSessionHandle, StartSessionOptions } from '@agent-dock/agent-runtime';
import type { ProviderId, ProviderModelV2, ProviderStatus } from '@agent-dock/shared';
import { providerModelCatalogV2ResponseSchema } from '@agent-dock/shared';
import { ActiveSessionLimiter } from '../src/active-session-limiter.js';
import { SessionLineageStore } from '../src/session-lineage-store.js';
import { SessionManager } from '../src/session-manager.js';
import { buildServer } from '../src/server.js';

/**
 * `GET /v2/providers/:providerId/models` (ADI-22a), against fake providers -- never a real Codex
 * or Claude CLI/RPC. `CatalogProvider.fetchModelCatalog` is a plain, in-process stand-in the test
 * itself controls (resolve with a real catalog, or reject), which is enough to prove the route's
 * own logic: it never has to prove `probeCodexModelCatalog`'s real RPC behavior, which
 * `codex-app-server-model-catalog.test.ts` (packages/agent-runtime) already covers against a real
 * fake-RPC fixture process.
 */
const TOKEN = 'v2-providers-models-token';
const AUTH = { authorization: `Bearer ${TOKEN}` };

/** Base fake, with no `fetchModelCatalog` at all -- Claude's real shape until #144. */
class TestProvider implements AgentProvider {
  readonly id: ProviderId;
  readonly name = 'Test Provider';

  constructor(id: ProviderId) {
    this.id = id;
  }

  async detect(): Promise<ProviderStatus> {
    return { id: this.id, name: this.name, installed: true, authenticated: 'authenticated', capabilities: {} };
  }

  startSession(_options: StartSessionOptions): ProviderSessionHandle {
    throw new Error('not used by this suite');
  }
}

/** A provider that DOES implement `fetchModelCatalog` -- Codex's real shape as of ADI-22a -- with
 * a test-controlled outcome, so one class covers both the "returns a real catalog" and "the live
 * probe rejects" scenarios. */
class CatalogProvider extends TestProvider implements AgentProvider {
  fetchModelCatalogCalls: ProviderModelCatalogOptions[] = [];
  models: ProviderModelV2[] = [];
  shouldReject = false;
  error = new Error('live probe failed');

  async fetchModelCatalog(options: ProviderModelCatalogOptions): Promise<readonly ProviderModelV2[]> {
    this.fetchModelCatalogCalls.push(options);
    if (this.shouldReject) throw this.error;
    return this.models;
  }
}

let stateRoot: string;

beforeEach(() => {
  stateRoot = mkdtempSync(join(tmpdir(), 'ovr-v2-providers-models-'));
});

afterEach(() => {
  rmSync(stateRoot, { recursive: true, force: true });
});

function setup(): { app: FastifyInstance; codex: CatalogProvider; claude: TestProvider } {
  const codex = new CatalogProvider('codex');
  const claude = new TestProvider('claude');
  const registry = new ProviderRegistry();
  registry.register(codex);
  registry.register(claude);

  const store = new SessionLineageStore({ stateRoot });
  const limiter = new ActiveSessionLimiter();
  const app = buildServer({
    registry,
    sessionManager: new SessionManager(registry, noopLogger),
    token: TOKEN,
    logger: noopLogger,
    v2: { store, limiter },
  });
  return { app, codex, claude };
}

describe('GET /v2/providers/:providerId/models', () => {
  it('requires the daemon bearer token like every other route', async () => {
    const { app } = setup();
    const res = await app.inject({ method: 'GET', url: '/v2/providers/codex/models' });
    expect(res.statusCode).toBe(401);
  });

  it('rejects a syntactically invalid provider id with 400', async () => {
    const { app } = setup();
    const res = await app.inject({ method: 'GET', url: '/v2/providers/not-a-real-provider/models', headers: AUTH });
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe('invalid_provider_id');
  });

  it('answers 404 for a well-formed but unregistered provider id', async () => {
    const registry = new ProviderRegistry(); // nothing registered
    const store = new SessionLineageStore({ stateRoot });
    const limiter = new ActiveSessionLimiter();
    const app = buildServer({
      registry,
      sessionManager: new SessionManager(registry, noopLogger),
      token: TOKEN,
      logger: noopLogger,
      v2: { store, limiter },
    });

    const res = await app.inject({ method: 'GET', url: '/v2/providers/codex/models', headers: AUTH });
    expect(res.statusCode).toBe(404);
    expect(res.json().code).toBe('provider_not_found');
  });

  it('returns a real catalog for a provider whose fetchModelCatalog resolves', async () => {
    const { app, codex } = setup();
    codex.models = [
      { id: 'gpt-5-codex', displayName: 'GPT-5 Codex', isDefault: true },
      { id: 'gpt-5-mini', displayName: 'GPT-5 Mini', isDefault: false },
    ];

    const res = await app.inject({ method: 'GET', url: '/v2/providers/codex/models', headers: AUTH });

    expect(res.statusCode).toBe(200);
    const body = providerModelCatalogV2ResponseSchema.parse(res.json());
    expect(body).toEqual({ schemaVersion: 1, providerId: 'codex', models: codex.models });
    expect(codex.fetchModelCatalogCalls).toHaveLength(1);
  });

  it('returns an empty catalog, with 200, for a provider that implements no fetchModelCatalog at all', async () => {
    const { app, claude } = setup();
    // TestProvider (Claude's real shape until #144) never has a `fetchModelCatalog` property.
    expect((claude as AgentProvider).fetchModelCatalog).toBeUndefined();

    const res = await app.inject({ method: 'GET', url: '/v2/providers/claude/models', headers: AUTH });

    expect(res.statusCode).toBe(200);
    const body = providerModelCatalogV2ResponseSchema.parse(res.json());
    expect(body).toEqual({ schemaVersion: 1, providerId: 'claude', models: [] });
  });

  it('degrades to an empty catalog, with 200 rather than an error status, when the live probe rejects', async () => {
    const { app, codex } = setup();
    codex.shouldReject = true;

    const res = await app.inject({ method: 'GET', url: '/v2/providers/codex/models', headers: AUTH });

    expect(res.statusCode).toBe(200);
    expect(providerModelCatalogV2ResponseSchema.parse(res.json())).toEqual({
      schemaVersion: 1,
      providerId: 'codex',
      models: [],
    });
  });
});
