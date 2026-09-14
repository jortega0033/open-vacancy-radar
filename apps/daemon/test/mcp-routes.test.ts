import { describe, expect, it, vi } from 'vitest';
import { FakeProvider, FAKE_PROVIDER_CAPABILITIES, noopLogger, ProviderRegistry } from '@agent-dock/agent-runtime';
import { buildServer } from '../src/server.js';
import { SessionManager } from '../src/session-manager.js';
import { McpConnectionManager } from '../src/mcp/manager.js';
import { mcpProviderResultSchema, type McpCredentialStore, type McpProviderPolicy, type McpSession } from '../src/mcp/types.js';

const TOKEN = 'daemon-test-token';
const credential = 'secret-api-key';
const job = {
  externalId: 'job-1',
  title: 'Security Analyst',
  company: 'Example BV',
  url: 'https://jobs.example.test/job-1',
  location: 'Remote',
  description: null,
  employmentType: 'full-time',
  publishedAt: '2026-08-30T10:00:00.000Z',
};

function setup() {
  const registry = new ProviderRegistry();
  registry.register(new FakeProvider('claude', {
    id: 'claude', name: 'Claude', installed: true, authenticated: 'authenticated', capabilities: FAKE_PROVIDER_CAPABILITIES,
  }));
  const credentials: McpCredentialStore = {
    get: vi.fn(async () => credential),
    set: vi.fn(async () => undefined),
    delete: vi.fn(async () => undefined),
  };
  const session: McpSession = {
    connect: vi.fn(async () => undefined),
    listTools: vi.fn(async () => [{ name: 'search_jobs' }, { name: 'get_job' }]),
    callTool: vi.fn(async (name: string) => (name === 'get_job' ? job : { jobs: [] })),
    close: vi.fn(async () => undefined),
  };
  const policy: McpProviderPolicy = {
    id: 'approved',
    displayName: 'Approved',
    transport: { kind: 'streamable-http', endpoint: 'https://approved.example.test/mcp', auth: 'api-key' },
    searchTool: 'search_jobs',
    mapSearchArguments: ({ query, limit }) => ({ query, limit }),
    parseResult: (value) => mcpProviderResultSchema.parse(value).jobs,
    detailTool: 'get_job',
    mapDetailArguments: ({ externalId }) => ({ id: externalId }),
    parseDetailResult: (value) => value,
    sourceUrl: 'https://approved.example.test/jobs',
    attribution: 'Approved jobs',
    policyVersion: '1',
    policyReviewedAt: '2026-08-30',
    retentionMs: 60_000,
    timeoutMs: 1_000,
    maximumPayloadBytes: 10_000,
    killSwitches: { connection: true, search: true, persistence: true },
  };
  const manager = new McpConnectionManager([policy], { create: vi.fn(async () => session) }, credentials, noopLogger);
  const app = buildServer({
    registry,
    sessionManager: new SessionManager(registry, noopLogger),
    token: TOKEN,
    logger: noopLogger,
    mcpManager: manager,
  });
  return { app, credentials, session };
}

const auth = { authorization: `Bearer ${TOKEN}` };

describe('typed MCP daemon routes', () => {
  it('requires daemon authentication and never returns stored credentials', async () => {
    const { app } = setup();
    expect((await app.inject({ method: 'GET', url: '/mcp/providers' })).statusCode).toBe(401);
    const response = await app.inject({ method: 'GET', url: '/mcp/providers', headers: auth });
    expect(response.statusCode).toBe(200);
    expect(response.body).not.toContain(credential);
    expect(response.json().providers[0]).toMatchObject({ providerId: 'approved', credentialConfigured: true });
  });

  it('rejects arbitrary servers, tools, headers, and provider arguments', async () => {
    const { app, session } = setup();
    const response = await app.inject({
      method: 'POST',
      url: '/mcp/search',
      headers: auth,
      payload: {
        providerId: 'approved',
        query: 'frontend',
        limit: 10,
        serverUrl: 'https://attacker.example/mcp',
        toolName: 'write_application',
        headers: { authorization: 'stolen' },
        arguments: { enumerateAll: true },
      },
    });
    expect(response.statusCode).toBe(400);
    expect(session.connect).not.toHaveBeenCalled();
  });

  it('accepts only an allowlisted provider and bounded user-directed query', async () => {
    const { app, session } = setup();
    const unknown = await app.inject({ method: 'POST', url: '/mcp/search', headers: auth, payload: { providerId: 'unknown', query: 'frontend', limit: 10 } });
    expect(unknown.statusCode).toBe(400);
    const approved = await app.inject({ method: 'POST', url: '/mcp/search', headers: auth, payload: { providerId: 'approved', query: 'frontend', limit: 10 } });
    expect(approved.statusCode).toBe(200);
    expect(session.callTool).toHaveBeenCalledWith('search_jobs', { query: 'frontend', limit: 10 }, expect.any(AbortSignal));
  });

  it('serves the get_job detail route for an allowlisted provider and externalId, calling only the reviewed detail tool', async () => {
    const { app, session } = setup();
    const response = await app.inject({
      method: 'GET',
      url: '/mcp/providers/approved/jobs/job-1',
      headers: auth,
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ ...job, providerId: 'approved' });
    expect(session.callTool).toHaveBeenCalledWith('get_job', { id: 'job-1' }, expect.any(AbortSignal));
  });

  it('404s the detail route for an unknown provider without connecting', async () => {
    const { app, session } = setup();
    const response = await app.inject({ method: 'GET', url: '/mcp/providers/unknown/jobs/job-1', headers: auth });
    expect(response.statusCode).toBe(404);
    expect(session.connect).not.toHaveBeenCalled();
  });

  it('requires daemon authentication on the detail route', async () => {
    const { app } = setup();
    const response = await app.inject({ method: 'GET', url: '/mcp/providers/approved/jobs/job-1' });
    expect(response.statusCode).toBe(401);
  });
});
