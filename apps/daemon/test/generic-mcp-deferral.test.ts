import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FAKE_PROVIDER_CAPABILITIES, FakeProvider, ProviderRegistry, noopLogger } from '@agent-dock/agent-runtime';
import { buildServer } from '../src/server.js';
import { SessionManager } from '../src/session-manager.js';
import { McpConnectionManager } from '../src/mcp/manager.js';
import { mcpProviderResultSchema, type McpCredentialStore, type McpProviderPolicy, type McpSession } from '../src/mcp/types.js';
import { AuditStore } from '../src/audit-store.js';
import { ActiveSessionLimiter } from '../src/active-session-limiter.js';
import { SessionLineageStore } from '../src/session-lineage-store.js';
import { WorkspaceTrustStore } from '../src/workspace-trust-store.js';
import { WorkspaceExecutionLeaseManager } from '../src/workspace-execution-lease.js';

/**
 * ADI-10: this repo deliberately never ports upstream AgentDock's generic, renderer-configurable
 * provider-MCP and component-control surface (arbitrary server URL/command/tool-name/arguments) --
 * see docs/mcp-source-policy.md and the ADR at docs/adr-generic-mcp-reconsideration.md for why. That
 * decision has held so far only because nobody has built the routes, not because anything mechanical
 * stops them. This file is that mechanical stop: it fails the moment a generic MCP or component route
 * is registered anywhere in this package, or a preload/IPC channel exposes one, rather than relying on
 * a human noticing in review.
 */

const SRC_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'src');

/** Every route-registration source file under src/, so a new route file cannot hide from this scan. */
function routeSources(): string {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.ts')) out.push(readFileSync(full, 'utf8'));
    }
  };
  walk(SRC_DIR);
  return out.join('\n');
}

const TOKEN = 'daemon-test-token';
let stateRoot: string;

afterEach(() => {
  if (stateRoot) rmSync(stateRoot, { recursive: true, force: true });
});

function setup() {
  stateRoot = mkdtempSync(join(tmpdir(), 'agent-dock-generic-mcp-deferral-'));
  const registry = new ProviderRegistry();
  registry.register(new FakeProvider('claude', {
    id: 'claude', name: 'Claude', installed: true, authenticated: 'authenticated', capabilities: FAKE_PROVIDER_CAPABILITIES,
  }));
  const credentials: McpCredentialStore = { get: vi.fn(async () => null), set: vi.fn(async () => undefined), delete: vi.fn(async () => undefined) };
  const session: McpSession = {
    connect: vi.fn(async () => undefined),
    listTools: vi.fn(async () => [{ name: 'search_jobs' }]),
    callTool: vi.fn(async () => ({ jobs: [] })),
    close: vi.fn(async () => undefined),
  };
  const policy: McpProviderPolicy = {
    id: 'approved',
    displayName: 'Approved',
    transport: { kind: 'streamable-http', endpoint: 'https://approved.example.test/mcp', auth: 'api-key' },
    searchTool: 'search_jobs',
    mapSearchArguments: ({ query, limit }) => ({ query, limit }),
    parseResult: (value) => mcpProviderResultSchema.parse(value).jobs,
    sourceUrl: 'https://approved.example.test/jobs',
    attribution: 'Approved jobs',
    policyVersion: '1',
    policyReviewedAt: '2026-08-30',
    retentionMs: 60_000,
    timeoutMs: 1_000,
    maximumPayloadBytes: 10_000,
    killSwitches: { connection: true, search: true, persistence: true },
  };
  const mcpManager = new McpConnectionManager([policy], { create: vi.fn(async () => session) }, credentials, noopLogger);

  // The most capable configuration this daemon can be built in -- not just an active
  // McpConnectionManager, but the full v2 surface (store/limiter/workspace trust+audit+lease)
  // wired exactly as `apps/daemon/src/index.ts` always wires it in a real desktop run whenever a
  // durable store opens successfully. An earlier version of this test omitted `v2` entirely, which
  // made 9 of its 12 route-injection cases below vacuous: `/v2/...` routes are gated behind a
  // separate `if (opts.v2)` branch in `server.ts` that was never exercised, so they would have 404'd
  // identically whether or not a route existed there. Every route family that could plausibly host a
  // future generic-MCP/component surface must actually be registered here for the negative checks
  // below to mean anything.
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
    mcpManager,
    v2: { store, limiter, workspace: { trustStore, auditStore, leaseManager } },
  });
  return { app };
}

const auth = { authorization: `Bearer ${TOKEN}` };

describe('generic AgentDock MCP and component control stay unregistered (ADI-10)', () => {
  it.each([
    ['GET', '/v2/integrations/mcp'],
    ['GET', '/v2/integrations/mcp/servers'],
    ['POST', '/v2/integrations/mcp/servers'],
    ['GET', '/v2/mcp'],
    ['GET', '/v2/mcp/servers'],
    ['POST', '/v2/mcp/connect'],
    ['GET', '/v2/components'],
    ['POST', '/v2/components/manage'],
    ['POST', '/v2/components/invoke'],
    ['POST', '/mcp/servers'],
    ['POST', '/mcp/connect'],
    ['POST', '/mcp/invoke'],
  ] as const)('%s %s does not exist, with the daemon\'s fullest real configuration wired in (v2 + MCP)', async (method, url) => {
    const { app } = setup();
    const response = await app.inject({ method, url, headers: auth, payload: method === 'POST' ? {} : undefined });
    expect(response.statusCode).toBe(404);
  });

  it('never spawns a renderer-suppliable command or connects to a renderer-suppliable server URL', () => {
    const source = routeSources();
    // The only place `serverUrl`/`command`/`toolName`-shaped renderer input is even conceivable is
    // a route handler reading `request.body`. No route registration anywhere in src/ names a path
    // under /v2/integrations, /v2/mcp, or /v2/components -- the compiled, reviewed vacancy-source
    // policy (docs/mcp-source-policy.md) is the only path from a request to an MCP connection.
    expect(source).not.toMatch(/['"]\/v2\/(integrations|mcp)\b/);
    expect(source).not.toMatch(/['"]\/v2\/components?\b/);
  });

  /**
   * The real, reviewed vacancy-source MCP routes (`src/routes/mcp.ts`) live under the bare `/mcp/`
   * prefix, not `/v2/` -- the check above bans a *few named* dangerous `/v2/` paths, but a sibling
   * route added directly to `mcp.ts` (e.g. `/mcp/providers/:id/invoke`) would be a `/mcp/...` path
   * too, just not one of the twelve literal strings the injection test above happens to try. This is
   * a positive allowlist instead: every `/mcp/...` string literal that appears as an
   * `app.<method>(...)` route path anywhere in src/ must be one of the four this repo has actually
   * reviewed, full stop -- a new one is a review trigger by construction, not by remembering to add
   * it to a list of things to guess and inject-test.
   */
  it('registers exactly the reviewed set of /mcp/ route paths, nothing else', () => {
    const source = routeSources();
    const mcpPaths = new Set([...source.matchAll(/app\.(?:get|post|put|delete|patch)\(\s*'(\/mcp\/[^']*)'/g)].map((m) => m[1] as string));
    // ADI-15/#48 added the `get_job` counterpart to `/mcp/search`: still an allowlisted providerId
    // plus an opaque externalId path segment, never a caller-suppliable tool name or arguments.
    expect(mcpPaths).toEqual(new Set([
      '/mcp/providers',
      '/mcp/providers/:providerId',
      '/mcp/providers/:providerId/credential',
      '/mcp/providers/:providerId/jobs/:externalId',
      '/mcp/search',
    ]));
  });
});
