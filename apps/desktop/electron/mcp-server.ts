/**
 * #421's local MCP endpoint (slice 2): the local HTTP transport, authentication, and audit layer.
 * No MCP tool is registered here yet -- #421's own delivery order puts tool wiring in slice 3,
 * after this transport/auth/audit layer has its own negative-security-test coverage. This module
 * proves the endpoint can be stood up, authenticated against, rejected for every disallowed shape
 * of request, and torn down cleanly; slice 3 only ever needs to add `registerTool` calls inside
 * `createMcpServerInstance` below.
 *
 * Bound to `127.0.0.1` on a dynamic port, only while explicitly enabled (`appSettings
 * .mcpEndpointEnabled`) and only for the app's own lifetime -- there is no persistence across
 * restarts, matching the ticket's own requirement that a client must reconnect using the current
 * endpoint rather than a cached port. This is the first inbound listener Electron main has ever
 * hosted; see SECURITY.md for the fuller threat-model writeup this module's existence requires.
 *
 * Deliberately independent of `apps/daemon`'s own Fastify server, even though the hardening ideas
 * below (reject any `Origin` header, reject a mismatched `Host`, compare credentials in constant
 * time, never leak internal errors) mirror its `server.ts`/`auth-token.ts` almost exactly. The
 * ticket requires this endpoint's identity, credentials, and audit trail to be entirely separate
 * from the daemon's own discovery token and `/mcp/*` vacancy-source routes -- sharing the
 * implementation would risk sharing state next.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import * as workspace from './workspace/repository.js';
import type { WorkspaceDb } from './workspace/client.js';
import { describeMcpGrantBlockers } from './workspace/mcp-grant-schema.js';

/** Generous for a real MCP JSON-RPC payload (tool arguments, JD text excerpts in a future slice),
 * finite against a hostile or malfunctioning caller -- the same two-tier reasoning
 * `CV_EVIDENCE_LIMITS` already states for database fields, applied here to a request body instead. */
const MAX_BODY_BYTES = 1_000_000;

export interface McpServerHandle {
  readonly port: number;
  close(): Promise<void>;
}

/** name+version identify this endpoint to a connecting client; bumped only when the tool surface
 * itself changes, not on every unrelated release. */
const SERVER_INFO = { name: 'open-vacancy-radar-cv-assistant', version: '0.1.0' };

/**
 * A fresh `McpServer` per request, matching `StreamableHTTPServerTransport`'s own stateless usage
 * pattern -- and not merely a style choice: the underlying `Server.connect` throws ("Already
 * connected to a transport... use a separate Protocol instance per connection") if the same
 * `McpServer` is reconnected to a second transport, which a shared, reused instance would hit on
 * this server's very first follow-up request (the client's own `notifications/initialized` is a
 * second HTTP POST, hitting a second transport). Tool registration (slice 3) is static and cheap
 * to repeat per request; there is no per-client state worth keeping across requests that a fresh
 * instance would lose.
 */
function createMcpServerInstance(): McpServer {
  return new McpServer(SERVER_INFO);
}

function extractBearerToken(header: string | string[] | undefined): string | undefined {
  const value = Array.isArray(header) ? header[0] : header;
  if (!value?.startsWith('Bearer ')) return undefined;
  return value.slice('Bearer '.length);
}

/** Port-agnostic hostname check against `127.0.0.1`/`localhost` -- DNS-rebinding protection for a
 * server without its own TLS, the same reasoning the MCP SDK's own `localhostHostValidation`
 * middleware documents (not used directly here since it is an Express `RequestHandler`, and this
 * server deliberately adds no framework dependency for a two-line check). */
function hasAllowedHost(header: string | string[] | undefined): boolean {
  const value = Array.isArray(header) ? header[0] : header;
  if (!value) return false;
  const hostname = value.split(':')[0]?.toLowerCase();
  return hostname === '127.0.0.1' || hostname === 'localhost' || hostname === '[::1]';
}

async function readJsonBody(req: IncomingMessage, maxBytes: number): Promise<unknown> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buf.length;
    if (total > maxBytes) throw new PayloadTooLargeError();
    chunks.push(buf);
  }
  if (total === 0) return undefined;
  const text = Buffer.concat(chunks).toString('utf8');
  try {
    return JSON.parse(text);
  } catch {
    throw new MalformedBodyError();
  }
}

class PayloadTooLargeError extends Error {}
class MalformedBodyError extends Error {}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text) });
  res.end(text);
}

/**
 * Every request runs the same gate, in order, before anything MCP-specific happens: reject a
 * browser-authored request outright (any `Origin` header at all, the same policy the daemon's own
 * server.ts already documents), reject a mismatched `Host` (DNS rebinding), then authenticate
 * against a grant's credential. Each rejection is audited (#421: every attempt, not only
 * successful ones) before the response is sent, so a failed audit write can still block the call
 * by throwing -- there is no tool call to "block" yet in this slice, but the gate itself already
 * follows the same discipline slice 3's tool handlers will.
 */
async function handleRequest(req: IncomingMessage, res: ServerResponse, getDb: () => Promise<WorkspaceDb>): Promise<void> {
  try {
    if (req.headers.origin !== undefined) {
      const db = await getDb();
      workspace.appendMcpAuditLogEntry(db, { grantId: '', toolName: '', outcome: 'denied' });
      sendJson(res, 403, { error: 'browser-originated requests are not allowed' });
      return;
    }
    if (!hasAllowedHost(req.headers.host)) {
      const db = await getDb();
      workspace.appendMcpAuditLogEntry(db, { grantId: '', toolName: '', outcome: 'denied' });
      sendJson(res, 403, { error: 'unexpected Host header' });
      return;
    }

    const db = await getDb();
    const credential = extractBearerToken(req.headers.authorization);
    const grant = credential ? workspace.findMcpClientGrantByCredential(db, credential) : null;
    if (!grant) {
      workspace.appendMcpAuditLogEntry(db, { grantId: '', toolName: '', outcome: 'denied' });
      sendJson(res, 401, { error: 'unauthorized' });
      return;
    }
    const blockers = describeMcpGrantBlockers(grant, new Date().toISOString());
    if (blockers.length > 0) {
      workspace.appendMcpAuditLogEntry(db, { grantId: grant.id, toolName: '', outcome: 'denied' });
      sendJson(res, 403, { error: blockers.join('; ') });
      return;
    }

    let parsedBody: unknown;
    if (req.method === 'POST') {
      try {
        parsedBody = await readJsonBody(req, MAX_BODY_BYTES);
      } catch (err) {
        workspace.appendMcpAuditLogEntry(db, { grantId: grant.id, toolName: '', outcome: 'denied' });
        if (err instanceof PayloadTooLargeError) {
          sendJson(res, 413, { error: 'request body too large' });
        } else {
          sendJson(res, 400, { error: 'malformed JSON body' });
        }
        return;
      }
    }

    const mcpServer = createMcpServerInstance();
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    await mcpServer.connect(transport);
    await transport.handleRequest(req, res, parsedBody);
    workspace.appendMcpAuditLogEntry(db, { grantId: grant.id, toolName: '', outcome: 'success' });
  } catch {
    // Never a stack trace or an internal message across this boundary -- the same "sanitize
    // anything without a known 4xx shape" discipline the daemon's own error handler documents.
    if (!res.headersSent) sendJson(res, 500, { error: 'internal server error' });
  }
}

/**
 * Starts the endpoint. Binds `127.0.0.1` on a dynamic port (`0`), so the caller (`main.ts`) always
 * reads the real port back from the returned handle rather than assuming one -- a fixed port
 * would collide across machines or a second launch attempt, the same reasoning the daemon's own
 * dynamic port already follows.
 */
export async function startMcpServer(getDb: () => Promise<WorkspaceDb>): Promise<McpServerHandle> {
  const httpServer: Server = createServer((req, res) => {
    void handleRequest(req, res, getDb);
  });

  await new Promise<void>((resolve, reject) => {
    httpServer.once('error', reject);
    httpServer.listen(0, '127.0.0.1', () => resolve());
  });

  const address = httpServer.address();
  if (!address || typeof address === 'string') {
    httpServer.close();
    throw new Error('MCP server failed to bind a TCP port');
  }

  return {
    port: address.port,
    close: () =>
      new Promise<void>((resolve) => {
        httpServer.close(() => resolve());
        // A client that opened a standalone GET SSE stream (a normal MCP client behavior, even
        // with zero tools registered) holds an open keep-alive connection `close()`'s callback
        // would otherwise wait on forever, since Node's `Server.close` only fires once every
        // existing connection ends on its own. `closeAllConnections` ends them now -- correct
        // here because "closing OVR removes the endpoint" (#421) means immediately, not once
        // every open stream happens to end by itself.
        httpServer.closeAllConnections();
      }),
  };
}
