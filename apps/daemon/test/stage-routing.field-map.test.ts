import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { FAKE_PROVIDER_CAPABILITIES, FakeProvider, ProviderRegistry, noopLogger } from '@agent-dock/agent-runtime';
import type { AgentProvider, ProviderSessionHandle, StartSessionOptions } from '@agent-dock/agent-runtime';
import type { ProviderCapabilities, ProviderId, ProviderStatus } from '@agent-dock/shared';
import { routeStage } from '@agent-dock/vacancy-agent-adapter';
import { ActiveSessionLimiter } from '../src/active-session-limiter.js';
import { SessionLineageStore } from '../src/session-lineage-store.js';
import { SessionManager } from '../src/session-manager.js';
import { buildServer } from '../src/server.js';

const TOKEN = 'stage-routing-field-map-token';
const AUTH = { authorization: `Bearer ${TOKEN}` };

/**
 * The two real adapters' capability declarations, written out rather than imported.
 *
 * `packages/agent-runtime`'s barrel deliberately does not export either object (see the AD-09 note
 * at the top of its `index.ts`: the internal surface is trimmed to what `apps/daemon` genuinely
 * needs, and a test is not that). The drift guard that keeps these honest lives on the other side
 * of the boundary, in `packages/agent-runtime/test/hardening-capability.test.ts`, which pins each
 * declaration against the argv its own `buildArgs` actually produces. What matters here is only the
 * one key: Claude declares it, Codex does not.
 */
const CLAUDE_CAPABILITIES: ProviderCapabilities = {
  resume: true,
  cancellation: true,
  tools: true,
  usage: true,
  thinking: true,
  hardenedNoNetwork: true,
};

const CODEX_CAPABILITIES: ProviderCapabilities = {
  resume: true,
  cancellation: true,
  tools: true,
  usage: true,
  thinking: true,
  modelCatalog: true,
};

class CapabilityProvider implements AgentProvider {
  readonly id: ProviderId;
  readonly name: string;

  constructor(
    id: ProviderId,
    private readonly capabilities: ProviderCapabilities,
    private readonly installed = true,
  ) {
    this.id = id;
    this.name = id === 'claude' ? 'Claude Code' : 'Codex';
  }

  async detect(): Promise<ProviderStatus> {
    return {
      id: this.id,
      name: this.name,
      installed: this.installed,
      authenticated: this.installed ? 'authenticated' : 'unauthenticated',
      capabilities: this.capabilities,
    };
  }

  startSession(_options: StartSessionOptions): ProviderSessionHandle {
    throw new Error('not used by this suite');
  }
}

let stateRoot: string;
let cwd: string;

beforeEach(() => {
  stateRoot = mkdtempSync(join(tmpdir(), 'ovr-stage-routing-'));
  cwd = mkdtempSync(join(tmpdir(), 'ovr-stage-routing-cwd-'));
});

afterEach(() => {
  rmSync(stateRoot, { recursive: true, force: true });
  rmSync(cwd, { recursive: true, force: true });
});

function stageRoutingServer(providers: AgentProvider[]): FastifyInstance {
  const registry = new ProviderRegistry();
  for (const provider of providers) registry.register(provider);
  return buildServer({
    registry,
    sessionManager: new SessionManager(registry, noopLogger),
    token: TOKEN,
    logger: noopLogger,
    v2: { store: new SessionLineageStore({ stateRoot }), limiter: new ActiveSessionLimiter() },
  });
}

/**
 * Issue #284, acceptance check 1, at the daemon boundary.
 *
 * The point of this file is the *pair* of gates, not either one alone. The stage router refuses to
 * **select** a provider that does not declare the no-network hardening profile; `POST
 * /sessions/application-field-map` refuses to **admit** any provider but the one this repo reviewed
 * for it, without consulting a declared capability at all. Neither is allowed to become the only
 * layer, because they fail in different directions: the router would be fooled by an adapter that
 * declares a capability it does not implement, and the route alone would say nothing useful to a
 * client trying to explain the refusal before making the request.
 */
describe('the field-map route keeps its own provider gate, independent of the stage router', () => {
  it('still refuses a non-claude provider, even one declaring the hardening capability', async () => {
    // The strongest form of the regression: a registered, installed, authenticated Codex that
    // *claims* `hardenedNoNetwork`. The router would now consider it eligible; the route must not
    // care, because `buildCodexArgs` still never reads `opts.hardened`, and the route's guarantee
    // deliberately does not rest on an adapter's self-description.
    const lyingCodex = new FakeProvider(
      'codex',
      {
        id: 'codex',
        name: 'Codex',
        installed: true,
        authenticated: 'authenticated',
        capabilities: { ...FAKE_PROVIDER_CAPABILITIES, hardenedNoNetwork: true },
      },
      'success',
    );
    const claude = new FakeProvider(
      'claude',
      { id: 'claude', name: 'Claude Code', installed: true, authenticated: 'authenticated', capabilities: FAKE_PROVIDER_CAPABILITIES },
      'success',
    );
    const app = stageRoutingServer([claude, lyingCodex]);

    const res = await app.inject({
      method: 'POST',
      url: '/sessions/application-field-map',
      headers: AUTH,
      payload: { provider: 'codex', cwd, prompt: 'map these fields' },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/does not support the field-map-generation hardening profile/);
  });

  it('still admits claude, so the router change did not narrow the one path that works', async () => {
    const claude = new FakeProvider(
      'claude',
      { id: 'claude', name: 'Claude Code', installed: true, authenticated: 'authenticated', capabilities: FAKE_PROVIDER_CAPABILITIES },
      'success',
    );
    const app = stageRoutingServer([claude]);

    const res = await app.inject({
      method: 'POST',
      url: '/sessions/application-field-map',
      headers: AUTH,
      payload: { provider: 'claude', cwd, prompt: 'map these fields' },
    });

    expect(res.statusCode).toBe(201);
    expect(claude.startedOptions[0]?.hardened).toBe('no-network');
  });

  it('routes the field-map stage to claude and rejects codex when given the real adapters capability sets', () => {
    // The selection half. Codex is free here and Claude's price is unknown, and the cheaper-first
    // tie-break is on -- so if the capability contract were anything but a hard filter, this is the
    // call that would pick Codex.
    const decision = routeStage({
      stage: 'application_field_map',
      candidates: [
        {
          providerId: 'codex',
          capabilities: CODEX_CAPABILITIES,
          tier: 'small',
          tierEvidence: 'operator_declared',
          price: { kind: 'known', usdPerMillionInputTokens: 0, usdPerMillionOutputTokens: 0, source: 'free tier' },
          installed: true,
          authenticated: 'authenticated',
        },
        {
          providerId: 'claude',
          capabilities: CLAUDE_CAPABILITIES,
          tier: 'capable',
          tierEvidence: 'operator_declared',
          price: { kind: 'unknown', reason: 'not_configured' },
          installed: true,
          authenticated: 'authenticated',
        },
      ],
      preferCheaperWithinTier: true,
    });

    expect(decision.outcome).toBe('routed');
    if (decision.outcome !== 'routed') throw new Error('unreachable');
    expect(decision.providerId).toBe('claude');
    expect(decision.rejected).toEqual([
      { providerId: 'codex', reason: 'missing_capability', missingCapabilities: ['hardenedNoNetwork'] },
    ]);
  });
});

describe('GET /v2/stage-routing', () => {
  it('requires the daemon bearer token like every other route', async () => {
    const app = stageRoutingServer([new CapabilityProvider('claude', CLAUDE_CAPABILITIES)]);
    const res = await app.inject({ method: 'GET', url: '/v2/stage-routing' });
    expect(res.statusCode).toBe(401);
  });

  it('reports the field-map stage as eligible for claude and rejected for codex, with the reason', async () => {
    const app = stageRoutingServer([
      new CapabilityProvider('claude', CLAUDE_CAPABILITIES),
      new CapabilityProvider('codex', CODEX_CAPABILITIES),
    ]);
    const res = await app.inject({ method: 'GET', url: '/v2/stage-routing', headers: AUTH });

    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      stages: {
        stage: string;
        requiredCapabilities: string[];
        eligibleProviders: string[];
        rejectedProviders: { providerId: string; reason: string; missingCapabilities?: string[] }[];
      }[];
    };
    const fieldMap = body.stages.find((entry) => entry.stage === 'application_field_map');
    expect(fieldMap?.requiredCapabilities).toEqual(['hardenedNoNetwork']);
    expect(fieldMap?.eligibleProviders).toEqual(['claude']);
    expect(fieldMap?.rejectedProviders).toEqual([
      { providerId: 'codex', reason: 'missing_capability', missingCapabilities: ['hardenedNoNetwork'] },
    ]);

    // Every other stage has no adapter-level requirement, so both providers are eligible for them.
    const tailoring = body.stages.find((entry) => entry.stage === 'cv_tailoring');
    expect(tailoring?.eligibleProviders.sort()).toEqual(['claude', 'codex']);
  });

  it('reports an uninstalled provider as rejected rather than silently absent', async () => {
    const app = stageRoutingServer([new CapabilityProvider('claude', CLAUDE_CAPABILITIES, false)]);
    const res = await app.inject({ method: 'GET', url: '/v2/stage-routing', headers: AUTH });
    const body = res.json() as { stages: { stage: string; eligibleProviders: string[]; rejectedProviders: { reason: string }[] }[] };
    const tailoring = body.stages.find((entry) => entry.stage === 'cv_tailoring');
    expect(tailoring?.eligibleProviders).toEqual([]);
    expect(tailoring?.rejectedProviders[0]?.reason).toBe('not_installed');
  });

  it('is not registered at all without the v2 durable store, like every other v2 route', async () => {
    const registry = new ProviderRegistry();
    registry.register(new CapabilityProvider('claude', CLAUDE_CAPABILITIES));
    const app = buildServer({
      registry,
      sessionManager: new SessionManager(registry, noopLogger),
      token: TOKEN,
      logger: noopLogger,
    });
    const res = await app.inject({ method: 'GET', url: '/v2/stage-routing', headers: AUTH });
    expect(res.statusCode).toBe(404);
  });
});
