import { randomUUID } from 'node:crypto';
import Fastify, { type FastifyError, type FastifyInstance } from 'fastify';
import type { Logger, ProviderRegistry } from '@agent-dock/agent-runtime';
import { extractBearerToken, tokensMatch } from './auth-token.js';
import { registerHealthRoute } from './routes/health.js';
import { registerProviderRoutes } from './routes/providers.js';
import { registerSessionRoutes } from './routes/sessions.js';
import type { SessionManager } from './session-manager.js';
import { registerMcpRoutes } from './routes/mcp.js';
import type { McpConnectionManager } from './mcp/manager.js';
import { registerV2ProviderRoutes } from './routes/v2-providers.js';
import { registerV2SessionRoutes } from './routes/v2-sessions.js';
import type { ActiveSessionLimiter } from './active-session-limiter.js';
import type { SessionLineageStore } from './session-lineage-store.js';
import { registerV2WorkspaceRoutes } from './routes/v2-workspaces.js';
import { registerV2SessionCreateRoute } from './routes/v2-sessions-create.js';
import { registerV2AuditRoutes } from './routes/v2-audit.js';
import type { WorkspaceTrustStore } from './workspace-trust-store.js';
import type { AuditStore } from './audit-store.js';
import type { WorkspaceExecutionLeaseManager } from './workspace-execution-lease.js';

/**
 * Present only when the daemon has a working durable store this run.
 *
 * Its absence is the whole downgrade mechanism: when `index.ts` cannot open the store (because it
 * was written by a newer build), it omits this option, and the consequence is not a flag check
 * scattered through handlers but the v2 routes never being registered at all. `GET /v2/...` then
 * 404s through the ordinary not-found handler, and `/health` advertises `[1]`. There is no path by
 * which a v2 route can exist without the store it reads from.
 */
export interface BuildServerV2Options {
  store: SessionLineageStore;
  limiter: ActiveSessionLimiter;
  /**
   * The ADI-06 workspace-trust pair, present only when **both** stores opened.
   *
   * Nested inside `v2` rather than beside it, and required together rather than individually, for
   * the same reason `v2` itself is optional: the workspace routes cannot function without either one
   * of them. A trust store with no audit store would grant access it could not record, which is the
   * exact failure mode the audit store exists to prevent; an audit store with no trust store would
   * record decisions nothing can act on. Absence of the pair is the downgrade path -- the workspace
   * and audit routes are simply never registered, and every `/v2/workspaces/...` call 404s through
   * the ordinary not-found handler.
   */
  workspace?: {
    trustStore: WorkspaceTrustStore;
    auditStore: AuditStore;
    /**
     * ADI-13. Required alongside the pair above rather than optional, for the same reason they are
     * required together: `POST /v2/sessions` cannot admit a session without taking an exclusive
     * lease on the folder it will run in, and a create route that skipped leasing would let two
     * agents write the same directory at once -- precisely what the lease manager exists to stop.
     *
     * It must be the **same instance** the `SessionManager` was constructed with, because that is
     * where every release happens; two instances would mean leases that are acquired and never
     * freed. `index.ts` constructs one and passes it to both.
     */
    leaseManager: WorkspaceExecutionLeaseManager;
  };
}

export interface BuildServerOptions {
  registry: ProviderRegistry;
  sessionManager: SessionManager;
  token: string;
  logger: Logger;
  mcpManager?: McpConnectionManager;
  v2?: BuildServerV2Options;
  /** Overridable only for tests that assert the value round-trips; production mints a fresh UUID. */
  daemonInstanceId?: string;
}

/**
 * Builds (but does not start) the daemon's HTTP server.
 *
 * Local-auth model (see SECURITY.md): every route except /health requires
 * `Authorization: Bearer <token>` with the token generated at process startup and handed to the
 * desktop client out-of-band (a local file, not the network). No CORS headers are ever added, so
 * a browser page cannot read cross-origin responses even if it guessed the token; and because
 * `Authorization` is a non-simple header, any cross-origin browser request triggers a CORS
 * preflight that this server never approves, so the request is never even sent to a route
 * handler. The Origin check below is an additional, explicit layer on top of that.
 */
export function buildServer(opts: BuildServerOptions): FastifyInstance {
  const app = Fastify({ logger: false, trustProxy: false });
  const startedAt = Date.now();

  app.addHook('onRequest', async (req, reply) => {
    // AD-04: any Origin header at all is treated as browser-authored and rejected outright: a
    // non-browser client (curl, Electron main's own fetch, another local process) never sends
    // one. The previous version only recognized the literal `null` and `http(s)://` schemes, so a
    // `chrome-extension://` origin (or any other future scheme) fell straight through
    // unrecognized. There is no legitimate browser-originated caller of this API today: the
    // renderer talks to the daemon only through Electron main, never directly (see SECURITY.md),
    // so there's nothing to allowlist. An `AGENT_DOCK_ALLOWED_ORIGINS` escape hatch used to
    // exist for a hypothetical dev-server case, but nothing ever paired it with a real CORS
    // response header, so an allowlisted origin still couldn't complete a request; it was dead
    // configuration and has been removed rather than fixed, since nothing currently needs it.
    if (req.headers.origin !== undefined) {
      opts.logger.warn('rejected request carrying an Origin header', { origin: req.headers.origin, url: req.url });
      reply.code(403).send({ error: 'browser-originated requests are not allowed' });
      return reply;
    }
  });

  app.addHook('onRequest', async (req, reply) => {
    if (req.url === '/health') return;
    const provided = extractBearerToken(req.headers.authorization);
    if (!provided || !tokensMatch(opts.token, provided)) {
      reply.code(401).send({ error: 'unauthorized' });
      return reply;
    }
  });

  registerHealthRoute(app, startedAt, {
    v2Enabled: !!opts.v2,
    daemonInstanceId: opts.daemonInstanceId ?? randomUUID(),
  });
  registerProviderRoutes(app, opts.registry);
  registerSessionRoutes(app, opts.sessionManager, opts.registry);
  if (opts.mcpManager) registerMcpRoutes(app, opts.mcpManager);
  if (opts.v2) {
    registerV2ProviderRoutes(app, opts.registry, opts.v2.limiter);
    registerV2SessionRoutes(app, opts.v2.store, opts.v2.limiter);
    if (opts.v2.workspace) {
      registerV2WorkspaceRoutes(app, {
        trustStore: opts.v2.workspace.trustStore,
        auditStore: opts.v2.workspace.auditStore,
        sessionManager: opts.sessionManager,
      });
      registerV2AuditRoutes(app, opts.v2.workspace.auditStore);
      // ADI-13, and deliberately its own registration call rather than a fourth argument to
      // `registerV2SessionRoutes` above: this route needs the trust store, the audit store, and the
      // lease manager, which the read-only v2 session routes have no business holding. Removing
      // exactly this line rolls session creation back to v1-only and leaves v1, the v2 read routes,
      // and the workspace/audit routes untouched -- which
      // `apps/daemon/test/v2-sessions-create.rollback.test.ts` asserts by doing precisely that.
      registerV2SessionCreateRoute(app, {
        registry: opts.registry,
        sessionManager: opts.sessionManager,
        store: opts.v2.store,
        auditStore: opts.v2.workspace.auditStore,
        leaseManager: opts.v2.workspace.leaseManager,
      });
    }
  }

  app.setErrorHandler((err: FastifyError, req, reply) => {
    // Fastify's own body-parsing errors (malformed JSON, payload-too-large, ...) carry a real
    // 4xx statusCode already. Preserving it (rather than flattening everything to 500) keeps
    // client-error semantics correct without risking leaking anything: these messages describe
    // the malformed request, never internal state. Anything without a 4xx statusCode is treated
    // as unexpected and sanitized to a generic 500, same as before.
    const statusCode =
      typeof err.statusCode === 'number' && err.statusCode >= 400 && err.statusCode < 500 ? err.statusCode : 500;

    if (statusCode >= 500) {
      opts.logger.error('unhandled route error', { message: err.message, url: req.url });
      reply.code(500).send({ error: 'internal server error' });
      return;
    }
    opts.logger.warn('client error', { message: err.message, url: req.url, statusCode });
    reply.code(statusCode).send({ error: err.message });
  });

  app.setNotFoundHandler((req, reply) => {
    reply.code(404).send({ error: 'not found' });
  });

  return app;
}
