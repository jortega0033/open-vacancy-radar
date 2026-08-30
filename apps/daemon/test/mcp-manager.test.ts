import { describe, expect, it, vi } from 'vitest';
import type { Logger } from '@agent-dock/agent-runtime';
import { McpConnectionManager } from '../src/mcp/manager.js';
import { mcpProviderResultSchema, type McpConnectorFactory, type McpCredentialStore, type McpProviderPolicy, type McpSession } from '../src/mcp/types.js';

const secret = 'sk-test-never-log-this';
const job = {
  externalId: 'job-1',
  title: 'Frontend Engineer',
  company: 'Example BV',
  url: 'https://jobs.example.test/job-1',
  location: 'Remote',
  description: null,
  employmentType: 'full-time',
  publishedAt: '2026-08-30T10:00:00.000Z',
};

class MemoryCredentials implements McpCredentialStore {
  value: string | null = null;
  async get() { return this.value; }
  async set(_providerId: string, value: string) { this.value = value; }
  async delete() { this.value = null; }
}

function policy(overrides: Partial<McpProviderPolicy> = {}): McpProviderPolicy {
  return {
    id: 'fake_jobs',
    displayName: 'Fake Jobs',
    transport: { kind: 'streamable-http', endpoint: 'https://mcp.example.test/mcp', auth: 'api-key' },
    searchTool: 'search_jobs',
    mapSearchArguments: ({ query, limit }) => ({ query, limit, approvedMode: 'user-directed' }),
    parseResult: (value) => mcpProviderResultSchema.parse(value).jobs,
    sourceUrl: 'https://example.test/jobs',
    attribution: 'Jobs supplied by Fake Jobs',
    policyVersion: '2026-08-30',
    policyReviewedAt: '2026-08-30',
    retentionMs: 60_000,
    timeoutMs: 1_000,
    maximumPayloadBytes: 10_000,
    killSwitches: { connection: true, search: true, persistence: true },
    ...overrides,
  };
}

function setup(result: unknown = { jobs: [job] }, overrides: Partial<McpProviderPolicy> = {}) {
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const session: McpSession = {
    connect: vi.fn(async () => undefined),
    listTools: vi.fn(async () => [{ name: 'search_jobs', inputSchema: { type: 'object' } }]),
    callTool: vi.fn(async (name, args) => { calls.push({ name, args }); return result; }),
    close: vi.fn(async () => undefined),
  };
  const connectors: McpConnectorFactory = { create: vi.fn(async () => session) };
  const credentials = new MemoryCredentials();
  credentials.value = secret;
  const logs: unknown[] = [];
  const logger: Logger = {
    debug: (message, meta) => logs.push([message, meta]),
    info: (message, meta) => logs.push([message, meta]),
    warn: (message, meta) => logs.push([message, meta]),
    error: (message, meta) => logs.push([message, meta]),
  };
  let now = new Date('2026-08-30T10:00:00.000Z');
  const manager = new McpConnectionManager([policy(overrides)], connectors, credentials, logger, () => now);
  return { manager, session, credentials, calls, logs, setNow: (value: string) => { now = new Date(value); } };
}

describe('MCP connection manager', () => {
  it('initializes, discovers only the approved tool, maps fixed arguments, and preserves provenance', async () => {
    const { manager, session, calls } = setup();
    const rows = await manager.search({ providerId: 'fake_jobs', query: 'frontend', limit: 10 });
    expect(session.connect).toHaveBeenCalledOnce();
    expect(session.listTools).toHaveBeenCalledOnce();
    expect(calls).toEqual([{ name: 'search_jobs', args: { query: 'frontend', limit: 10, approvedMode: 'user-directed' } }]);
    expect(rows[0]).toMatchObject({ ...job, providerId: 'fake_jobs', policyVersion: '2026-08-30', attribution: 'Jobs supplied by Fake Jobs' });
    expect(rows[0]?.expiresAt).toBe('2026-08-30T10:01:00.000Z');
  });

  it('rejects missing and unknown tools without calling them', async () => {
    const { manager, session } = setup();
    vi.mocked(session.listTools).mockResolvedValue([{ name: 'write_application' }]);
    await expect(manager.search({ providerId: 'fake_jobs', query: 'frontend', limit: 10 })).rejects.toThrow('approved MCP search tool is unavailable');
    expect(session.callTool).not.toHaveBeenCalled();
  });

  it.each([
    ['unknown fields', { jobs: [{ ...job, privateEmail: 'person@example.test' }] }],
    ['wrong field types', { jobs: [{ ...job, title: 42 }] }],
    ['credential-bearing URLs', { jobs: [{ ...job, url: 'https://user:secret@jobs.example.test/1' }] }],
  ])('rejects malformed provider data: %s', async (_label, result) => {
    const { manager } = setup(result);
    await expect(manager.search({ providerId: 'fake_jobs', query: 'frontend', limit: 10 })).rejects.toThrow();
  });

  it('rejects oversized payloads before provider parsing', async () => {
    const { manager } = setup({ jobs: [{ ...job, description: 'x'.repeat(1_000) }] }, { maximumPayloadBytes: 100 });
    await expect(manager.search({ providerId: 'fake_jobs', query: 'frontend', limit: 10 })).rejects.toThrow('payload exceeds');
  });

  it.each(['OAuth authorization required', 'MCP rate limit exceeded'])('sanitizes provider failures in logs: %s', async (message) => {
    const { manager, session, logs } = setup();
    vi.mocked(session.connect).mockRejectedValue(new Error(`${message}: ${secret}`));
    await expect(manager.search({ providerId: 'fake_jobs', query: 'frontend', limit: 10 })).rejects.toThrow(
      message.startsWith('OAuth') ? 'authorization failed' : 'rate limited',
    );
    expect(JSON.stringify(logs)).not.toContain(secret);
    expect(JSON.stringify(logs)).not.toContain(message);
  });

  it('times out, cancels the operation signal, and closes the session', async () => {
    const { manager, session } = setup(undefined, { timeoutMs: 10 });
    vi.mocked(session.connect).mockImplementation((signal) => new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    }));
    await expect(manager.search({ providerId: 'fake_jobs', query: 'frontend', limit: 10 })).rejects.toThrow('timed out');
    expect(session.close).toHaveBeenCalledOnce();
  });

  it('honors caller cancellation', async () => {
    const { manager, session } = setup();
    vi.mocked(session.connect).mockImplementation((signal) => new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(new Error('cancelled')), { once: true });
    }));
    const controller = new AbortController();
    const pending = manager.search({ providerId: 'fake_jobs', query: 'frontend', limit: 10 }, controller.signal);
    controller.abort(new Error('cancelled'));
    await expect(pending).rejects.toThrow('cancelled');
  });

  it('purges expired data deterministically and disables persistence independently', async () => {
    const { manager, setNow } = setup();
    await manager.search({ providerId: 'fake_jobs', query: 'frontend', limit: 10 });
    expect(manager.cached('fake_jobs')).toHaveLength(1);
    setNow('2026-08-30T10:01:00.000Z');
    expect(manager.purgeExpired()).toBe(1);
    expect(manager.cached('fake_jobs')).toEqual([]);

    const noPersistence = setup(undefined, { killSwitches: { connection: true, search: true, persistence: false } });
    await noPersistence.manager.search({ providerId: 'fake_jobs', query: 'frontend', limit: 10 });
    expect(noPersistence.manager.cached('fake_jobs')).toEqual([]);
  });

  it('enforces independent connection and search kill switches', async () => {
    const connectionOff = setup(undefined, { killSwitches: { connection: false, search: true, persistence: true } });
    await expect(connectionOff.manager.search({ providerId: 'fake_jobs', query: 'frontend', limit: 10 })).rejects.toThrow('connection is disabled');
    const searchOff = setup(undefined, { killSwitches: { connection: true, search: false, persistence: true } });
    await expect(searchOff.manager.search({ providerId: 'fake_jobs', query: 'frontend', limit: 10 })).rejects.toThrow('search is disabled');
  });

  it('revokes and deletes credentials and provider-controlled cached rows on removal', async () => {
    const revoke = vi.fn(async () => undefined);
    const { manager, credentials } = setup(undefined, { revokeCredential: revoke });
    await manager.search({ providerId: 'fake_jobs', query: 'frontend', limit: 10 });
    await manager.remove('fake_jobs');
    expect(revoke).toHaveBeenCalledWith(secret);
    expect(credentials.value).toBeNull();
    expect(manager.cached('fake_jobs')).toEqual([]);
  });

  it('still deletes local credentials and cache when remote revocation fails', async () => {
    const { manager, credentials } = setup(undefined, {
      revokeCredential: vi.fn(async () => { throw new Error(`remote failed: ${secret}`); }),
    });
    await manager.search({ providerId: 'fake_jobs', query: 'frontend', limit: 10 });
    await expect(manager.remove('fake_jobs')).rejects.toThrow('removed locally');
    expect(credentials.value).toBeNull();
    expect(manager.cached('fake_jobs')).toEqual([]);
  });

  it('propagates credential-store deletion failure while still deleting cached rows', async () => {
    const { manager, credentials } = setup();
    await manager.search({ providerId: 'fake_jobs', query: 'frontend', limit: 10 });
    vi.spyOn(credentials, 'delete').mockRejectedValue(new Error('credential backend denied deletion'));
    await expect(manager.remove('fake_jobs')).rejects.toThrow('credential backend denied deletion');
    expect(manager.cached('fake_jobs')).toEqual([]);
  });

  it('aborts active searches and generation-guards cache against repopulation after removal', async () => {
    const { manager, session } = setup();
    let release: ((value: unknown) => void) | undefined;
    vi.mocked(session.callTool).mockImplementation(async () => new Promise((resolve) => { release = resolve; }));
    const pending = manager.search({ providerId: 'fake_jobs', query: 'frontend', limit: 10 });
    await vi.waitFor(() => expect(session.callTool).toHaveBeenCalledOnce());
    await manager.remove('fake_jobs');
    release?.({ jobs: [job] });
    await expect(pending).rejects.toThrow('cancelled');
    expect(manager.cached('fake_jobs')).toEqual([]);
  });

  it('rejects searches that start while connection removal is in progress', async () => {
    let finishRevocation: (() => void) | undefined;
    const revokeCredential = vi.fn(async () => new Promise<void>((resolve) => { finishRevocation = resolve; }));
    const { manager } = setup(undefined, { revokeCredential });
    const removal = manager.remove('fake_jobs');
    await vi.waitFor(() => expect(revokeCredential).toHaveBeenCalledOnce());
    await expect(manager.search({ providerId: 'fake_jobs', query: 'frontend', limit: 10 })).rejects.toThrow('being removed');
    finishRevocation?.();
    await removal;
  });

  it('aborts active operations and closes their sessions during daemon shutdown', async () => {
    const { manager, session } = setup();
    vi.mocked(session.callTool).mockImplementation(async (_name, _args, signal) => new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(new Error('closed')), { once: true });
    }));
    const pending = manager.search({ providerId: 'fake_jobs', query: 'frontend', limit: 10 });
    await vi.waitFor(() => expect(session.callTool).toHaveBeenCalledOnce());
    await manager.close();
    await expect(pending).rejects.toThrow('cancelled');
    expect(session.close).toHaveBeenCalled();
    await expect(manager.search({ providerId: 'fake_jobs', query: 'frontend', limit: 10 })).rejects.toThrow('manager is closed');
  });
});
