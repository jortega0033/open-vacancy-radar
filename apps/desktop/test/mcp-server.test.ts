// @vitest-environment node
import * as http from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createWorkspaceDb, type WorkspaceDb } from '../electron/workspace/client.js';
import * as workspace from '../electron/workspace/repository.js';
import { startMcpServer, type McpServerHandle } from '../electron/mcp-server.js';

/**
 * Exercises the real local MCP endpoint (#421, slice 2) against a real HTTP server on a real port
 * and a real SQLite file -- not mocks. No tool is registered yet (that is slice 3), so the
 * meaningful behavior here is entirely the transport/auth/audit gate every future tool call will
 * also pass through: Origin/Host rejection, per-grant credential auth, size/shape limits on the
 * body, and that a real `@modelcontextprotocol/sdk` client can complete the MCP handshake end to
 * end once authorized. This is the "real client interoperability" proof for the transport layer;
 * #421's own phase-3 line about an interop test is specifically about the *tool* surface, added
 * once tools exist.
 */

const CV = {
  name: 'Resume',
  kind: 'manual' as const,
  profile: { title: '', years: '', location: '', languages: '', skills: [], summary: '', auth: '' },
};
const FUTURE = '2099-01-01T00:00:00.000Z';
const PAST = '2000-01-01T00:00:00.000Z';

let dir: string;
let db: WorkspaceDb;
let closeDb: (() => void) | undefined;
let handle: McpServerHandle;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'ovr-mcp-test-'));
  const opened = createWorkspaceDb(dir);
  db = opened.db;
  closeDb = opened.close;
  handle = await startMcpServer(async () => db);
});

afterEach(async () => {
  await handle.close();
  closeDb?.();
  rmSync(dir, { recursive: true, force: true });
});

function createGrant(overrides: { expiresAt?: string } = {}) {
  const cv = workspace.createCvDocument(db, CV);
  return workspace.createMcpClientGrant(db, {
    name: 'Test client',
    scopeType: 'source_cv',
    sourceCvId: cv.id,
    expiresAt: overrides.expiresAt ?? FUTURE,
  });
}

/** Raw `node:http` rather than `fetch`: the Host-header test specifically needs a client that
 * will send whatever `Host` value it is given, which the Fetch API forbids overriding. */
function rawRequest(headers: Record<string, string>, body?: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port: handle.port, path: '/mcp', method: 'POST', headers: { 'content-type': 'application/json', ...headers } },
      (res) => {
        let data = '';
        res.on('data', (chunk: Buffer) => {
          data += chunk.toString('utf8');
        });
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: data }));
      },
    );
    req.on('error', reject);
    req.end(body);
  });
}

describe('local MCP endpoint transport and auth gate (#421)', () => {
  it('rejects any request carrying an Origin header, browser-authored or not', async () => {
    const { credential } = createGrant();
    const res = await rawRequest({ origin: 'http://evil.example', authorization: `Bearer ${credential}` }, '{}');
    expect(res.status).toBe(403);
    expect(JSON.parse(res.body).error).toMatch(/browser-originated/);
  });

  it('rejects a mismatched Host header (DNS rebinding)', async () => {
    const { credential } = createGrant();
    const res = await rawRequest({ host: 'evil.example:9999', authorization: `Bearer ${credential}` }, '{}');
    expect(res.status).toBe(403);
    expect(JSON.parse(res.body).error).toMatch(/Host/);
  });

  it('rejects a request with no credential at all', async () => {
    const res = await rawRequest({}, '{}');
    expect(res.status).toBe(401);
  });

  it('rejects an unknown credential', async () => {
    const res = await rawRequest({ authorization: 'Bearer not-a-real-credential' }, '{}');
    expect(res.status).toBe(401);
  });

  it('rejects an expired grant\'s credential', async () => {
    const { credential } = createGrant({ expiresAt: PAST });
    const res = await rawRequest({ authorization: `Bearer ${credential}` }, '{}');
    expect(res.status).toBe(403);
    expect(JSON.parse(res.body).error).toMatch(/expired/);
  });

  it('rejects a revoked grant\'s credential immediately', async () => {
    const { grant, credential } = createGrant();
    workspace.revokeMcpClientGrant(db, grant.id);
    const res = await rawRequest({ authorization: `Bearer ${credential}` }, '{}');
    expect(res.status).toBe(403);
    expect(JSON.parse(res.body).error).toMatch(/revoked/);
  });

  it('rejects an oversized body before parsing it', async () => {
    const { credential } = createGrant();
    const res = await rawRequest({ authorization: `Bearer ${credential}` }, 'x'.repeat(2_000_000));
    expect(res.status).toBe(413);
  });

  it('rejects a malformed JSON body from an otherwise-authorized caller', async () => {
    const { credential } = createGrant();
    const res = await rawRequest({ authorization: `Bearer ${credential}` }, '{not valid json');
    expect(res.status).toBe(400);
  });

  it('records every attempt in the audit trail, successful or not', async () => {
    const { credential } = createGrant();
    await rawRequest({ authorization: 'Bearer wrong' }, '{}');
    await rawRequest({ origin: 'http://evil.example', authorization: `Bearer ${credential}` }, '{}');
    const entries = workspace.listMcpAuditLogEntries(db);
    expect(entries.length).toBeGreaterThanOrEqual(2);
    expect(entries.every((e) => e.outcome === 'denied')).toBe(true);
  });

  it('completes a real MCP handshake for a properly authorized client, advertising no tools capability yet', async () => {
    const { credential } = createGrant();
    const client = new Client({ name: 'test-client', version: '1.0.0' });
    const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${handle.port}/mcp`), {
      requestInit: { headers: { authorization: `Bearer ${credential}` } },
    });
    await client.connect(transport);
    // No tool is registered yet (slice 3's job) -- a zero-tool `McpServer` never advertises the
    // `tools` capability at all, so `listTools()` itself would correctly fail with "Method not
    // found" rather than resolve to an empty list. The handshake succeeding at all, with no
    // `tools` capability offered, is the correct proof for this slice.
    expect(client.getServerCapabilities()?.tools).toBeUndefined();
    await client.close();

    const entries = workspace.listMcpAuditLogEntries(db);
    expect(entries.some((e) => e.outcome === 'success')).toBe(true);
  });

  it('a second client authenticates independently of the first, on the same running endpoint', async () => {
    const { credential: credentialA } = createGrant();
    const { credential: credentialB } = createGrant();

    const clientA = new Client({ name: 'client-a', version: '1.0.0' });
    await clientA.connect(
      new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${handle.port}/mcp`), {
        requestInit: { headers: { authorization: `Bearer ${credentialA}` } },
      }),
    );
    await clientA.close();

    const clientB = new Client({ name: 'client-b', version: '1.0.0' });
    await clientB.connect(
      new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${handle.port}/mcp`), {
        requestInit: { headers: { authorization: `Bearer ${credentialB}` } },
      }),
    );
    await clientB.close();

    expect(workspace.listMcpAuditLogEntries(db).filter((e) => e.outcome === 'success').length).toBeGreaterThanOrEqual(2);
  });
});
