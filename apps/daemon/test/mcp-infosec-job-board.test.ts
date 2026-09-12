import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { Logger } from '@agent-dock/agent-runtime';
import { McpConnectionManager } from '../src/mcp/manager.js';
import { infosecJobBoardMcpPolicy, INFOSEC_JOB_BOARD_PROVIDER_ID } from '../src/mcp/providers/infosec-job-board.js';
import type { McpConnectorFactory, McpCredentialStore, McpSession, McpTool } from '../src/mcp/types.js';

/**
 * #48: InfoSec Job Board, the first real (non-fabricated-for-tests) `McpProviderPolicy` wired into
 * this repo's MCP foundation. These are hermetic fixture-driven tests, exercised the same way
 * `mcp-manager.test.ts` exercises the manager itself: a fake `McpSession` resolves/rejects with
 * captured-and-sanitized MCP payloads, so nothing here performs a live MCP handshake. Live
 * verification (real handshake, one capped `search_jobs`, one `get_job`) stays a separate opt-in
 * check, matching this project's `*-live.test.ts` convention (see e.g.
 * `packages/vacancy-engine/test/global-remote/ai-dev-jobs-live.test.ts`) -- default `pnpm test` never
 * depends on infosecjobboard.com being reachable.
 */

function fixture(name: string): unknown {
  return JSON.parse(
    readFileSync(path.resolve(process.cwd(), 'test/fixtures/mcp/infosec-job-board', name), 'utf8'),
  ) as unknown;
}

const TOOLS: McpTool[] = fixture('tools-list.json') as McpTool[];

class MemoryCredentials implements McpCredentialStore {
  async get() { return null; }
  async set() { /* no-op: this provider's transport auth is 'none' */ }
  async delete() { /* no-op */ }
}

function setup(overrides: { listTools?: McpTool[]; callTool?: (name: string, args: Record<string, unknown>) => Promise<unknown> } = {}) {
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const session: McpSession = {
    connect: vi.fn(async () => undefined),
    listTools: vi.fn(async () => overrides.listTools ?? TOOLS),
    callTool: vi.fn(async (name, args) => {
      calls.push({ name, args });
      if (overrides.callTool) return overrides.callTool(name, args);
      throw new Error(`unexpected tool call in test setup: ${name}`);
    }),
    close: vi.fn(async () => undefined),
  };
  const connectors: McpConnectorFactory = { create: vi.fn(async () => session) };
  const logs: Array<{ message: string; meta: unknown }> = [];
  const logger: Logger = {
    debug: (message, meta) => logs.push({ message, meta }),
    info: (message, meta) => logs.push({ message, meta }),
    warn: (message, meta) => logs.push({ message, meta }),
    error: (message, meta) => logs.push({ message, meta }),
  };
  const manager = new McpConnectionManager(
    [infosecJobBoardMcpPolicy],
    connectors,
    new MemoryCredentials(),
    logger,
    () => new Date('2026-09-10T12:00:00.000Z'),
  );
  return { manager, session, calls, logs };
}

describe('InfoSec Job Board MCP source (#48)', () => {
  it('search_jobs: normalizes results, attaches attribution/canonical links, and never exceeds the 10-result cap', async () => {
    const { manager, calls } = setup({
      callTool: async (name) => (name === 'search_jobs' ? fixture('search-valid.json') : Promise.reject(new Error('unexpected'))),
    });

    const rows = await manager.search({ providerId: INFOSEC_JOB_BOARD_PROVIDER_ID, query: 'incident response', limit: 50 });

    // 12 raw rows in the fixture; the source's published cap of 10 is enforced regardless of the
    // caller's requested limit (50) and regardless of how many rows the server itself returned.
    expect(rows).toHaveLength(10);
    expect(rows[0]).toMatchObject({
      externalId: 'job-001',
      title: 'Security Engineer 1',
      company: 'Example Security Corp 1',
      url: 'https://www.infosecjobboard.com/jobs/job-001',
      location: 'Remote',
      providerId: INFOSEC_JOB_BOARD_PROVIDER_ID,
      sourceUrl: infosecJobBoardMcpPolicy.sourceUrl,
      attribution: infosecJobBoardMcpPolicy.attribution,
      policyVersion: infosecJobBoardMcpPolicy.policyVersion,
      policyReviewedAt: infosecJobBoardMcpPolicy.policyReviewedAt,
    });
    expect(rows[0]?.attribution).toContain('not exhaustive of cybersecurity hiring');
    expect(rows.every((row) => row.url.startsWith('https://www.infosecjobboard.com/jobs/'))).toBe(true);
    // The argument actually sent to the server is itself capped at 10, not just the returned rows.
    expect(calls).toEqual([{ name: 'search_jobs', args: { query: 'incident response', limit: 10 } }]);
  });

  it('search_jobs: an explicit caller limit under the cap is still respected', async () => {
    const { manager } = setup({
      callTool: async () => fixture('search-valid.json'),
    });
    const rows = await manager.search({ providerId: INFOSEC_JOB_BOARD_PROVIDER_ID, query: 'soc analyst', limit: 3 });
    expect(rows).toHaveLength(3);
  });

  it('search_jobs: an empty result set is a clean, isolated empty list', async () => {
    const { manager } = setup({ callTool: async () => fixture('search-empty.json') });
    const rows = await manager.search({ providerId: INFOSEC_JOB_BOARD_PROVIDER_ID, query: 'threat hunter', limit: 10 });
    expect(rows).toEqual([]);
  });

  it('search_jobs: malformed provider data is rejected rather than surfaced as a partial vacancy', async () => {
    const { manager, logs } = setup({ callTool: async () => fixture('search-malformed.json') });
    await expect(
      manager.search({ providerId: INFOSEC_JOB_BOARD_PROVIDER_ID, query: 'malware analyst', limit: 10 }),
    ).rejects.toThrow();
    expect(logs.some((log) => log.message === 'MCP provider search failed')).toBe(true);
  });

  it('search_jobs: a JSON-RPC protocol error is isolated as a sanitized rejection, not a crash', async () => {
    const protocolError = fixture('protocol-error.json') as { error: { message: string } };
    const { manager } = setup({
      callTool: async () => Promise.reject(new Error(protocolError.error.message)),
    });
    await expect(
      manager.search({ providerId: INFOSEC_JOB_BOARD_PROVIDER_ID, query: '', limit: 10 }),
    ).rejects.toThrow('MCP provider returned an invalid response');
  });

  it('search_jobs: a rate-limit failure is categorized and sanitized, not leaked verbatim', async () => {
    const rateLimited = fixture('rate-limit.json') as { error: { message: string } };
    const { manager, logs } = setup({
      callTool: async () => Promise.reject(new Error(rateLimited.error.message)),
    });
    await expect(
      manager.search({ providerId: INFOSEC_JOB_BOARD_PROVIDER_ID, query: 'pentester', limit: 10 }),
    ).rejects.toThrow('MCP provider rate limited');
    const warnLog = logs.find((log) => log.message === 'MCP provider search failed');
    expect(warnLog?.meta).toMatchObject({ reason: 'rate_limited' });
    // The raw provider message (which could carry operational detail) never reaches the log.
    expect(JSON.stringify(logs)).not.toContain('retry after 60 seconds');
  });

  it('get_job: normalizes one detail lookup, sends only the externalId, and attaches provenance', async () => {
    const { manager, calls } = setup({
      callTool: async (name) => (name === 'get_job' ? fixture('detail-valid.json') : Promise.reject(new Error('unexpected'))),
    });
    const row = await manager.getJob({ providerId: INFOSEC_JOB_BOARD_PROVIDER_ID, externalId: 'job-001' });
    expect(row).toMatchObject({
      externalId: 'job-001',
      title: 'Security Engineer 1',
      url: 'https://www.infosecjobboard.com/jobs/job-001',
      providerId: INFOSEC_JOB_BOARD_PROVIDER_ID,
      attribution: infosecJobBoardMcpPolicy.attribution,
    });
    expect(calls).toEqual([{ name: 'get_job', args: { id: 'job-001' } }]);
    // A single detail lookup is a point read, not a corpus scan -- it is never persisted.
    expect(manager.cached(INFOSEC_JOB_BOARD_PROVIDER_ID)).toEqual([]);
  });

  it('get_job: a not-found tool error is isolated as a rejection, never a fabricated vacancy', async () => {
    const { manager } = setup({
      callTool: async (name) => (name === 'get_job' ? fixture('detail-not-found.json') : Promise.reject(new Error('unexpected'))),
    });
    await expect(
      manager.getJob({ providerId: INFOSEC_JOB_BOARD_PROVIDER_ID, externalId: 'job-does-not-exist' }),
    ).rejects.toThrow();
  });

  it('security: only the two allowlisted tool names are ever called, even though the server advertises a third', async () => {
    const { manager, session, calls } = setup({
      callTool: async (name) => (name === 'search_jobs' ? fixture('search-empty.json') : fixture('detail-valid.json')),
    });
    await manager.search({ providerId: INFOSEC_JOB_BOARD_PROVIDER_ID, query: 'red team', limit: 10 });
    await manager.getJob({ providerId: INFOSEC_JOB_BOARD_PROVIDER_ID, externalId: 'job-001' });

    expect(session.listTools).toHaveBeenCalled();
    const calledToolNames = new Set(calls.map((call) => call.name));
    expect(calledToolNames).toEqual(new Set(['search_jobs', 'get_job']));
    // `apply_to_job` is advertised by the fixture server but is not this policy's searchTool or
    // detailTool, so it is structurally unreachable -- there is no code path in this policy or the
    // shared manager that could ever name it.
    expect(calledToolNames.has('apply_to_job')).toBe(false);
  });

  it('security: a provider that stops advertising an approved tool is refused before any call, not silently skipped', async () => {
    const { manager, session } = setup({ listTools: [{ name: 'apply_to_job' }] });
    await expect(
      manager.search({ providerId: INFOSEC_JOB_BOARD_PROVIDER_ID, query: 'blue team', limit: 10 }),
    ).rejects.toThrow('approved MCP search tool is unavailable');
    await expect(
      manager.getJob({ providerId: INFOSEC_JOB_BOARD_PROVIDER_ID, externalId: 'job-001' }),
    ).rejects.toThrow('approved MCP detail tool is unavailable');
    expect(session.callTool).not.toHaveBeenCalled();
  });

  it('pins the assumed MCP initialize contract this policy depends on (evidence only, not live-verified here)', () => {
    const init = fixture('initialize.json') as { result: { protocolVersion: string; serverInfo: { name: string } } };
    expect(init.result.protocolVersion).toBe('2025-06-18');
    expect(init.result.serverInfo.name).toBe('infosec-job-board-mcp');
  });
});
