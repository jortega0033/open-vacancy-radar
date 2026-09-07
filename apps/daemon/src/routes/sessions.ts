import { existsSync, statSync } from 'node:fs';
import type { FastifyInstance } from 'fastify';
import { createSessionRequestSchema, sessionIdParamSchema } from '@agent-dock/shared';
import type { ProviderRegistry } from '@agent-dock/agent-runtime';
import type { SessionManager } from '../session-manager.js';
import { ActiveSessionLimitError } from '../active-session-limiter.js';
import { StorageFullError } from '../session-lineage-store.js';
import { BoundedSseWriter } from '../sse-writer.js';

const TERMINAL_SESSION_STATUSES = new Set(['completed', 'failed', 'cancelled']);

export function registerSessionRoutes(
  app: FastifyInstance,
  sessionManager: SessionManager,
  registry: ProviderRegistry,
): void {
  // CodeQL flags this handler's existsSync/statSync call as missing rate limiting
  // (js/missing-rate-limiting). Dismissed rather than fixed: the daemon binds to 127.0.0.1 only,
  // every request requires the per-launch bearer token from the discovery file (SECURITY.md#local-auth-token),
  // and there is exactly one legitimate caller — the desktop app's own Electron main process. Reaching
  // this route at all already requires the same trust level needed to spawn arbitrary local coding
  // agents through every other route here, so a request-rate limit would add a dependency and a new
  // way for the desktop app's own legitimate rapid session creation to fail, for no realistic
  // attacker this authentication boundary doesn't already stop.
  app.post('/sessions', async (req, reply) => {
    const parsed = createSessionRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      reply.code(400).send({ error: 'invalid request body', details: parsed.error.flatten() });
      return;
    }
    const { provider, cwd, prompt, resumeProviderSessionId, model } = parsed.data;

    const providerImpl = registry.get(provider);
    if (!providerImpl) {
      reply.code(400).send({ error: `unsupported provider: ${provider}` });
      return;
    }
    if (resumeProviderSessionId && !(await providerImpl.detect()).capabilities.resume) {
      reply.code(400).send({ error: `provider does not support resume: ${provider}` });
      return;
    }
    if (!existsSync(cwd) || !statSync(cwd).isDirectory()) {
      reply.code(400).send({ error: `working directory does not exist: ${cwd}` });
      return;
    }

    // Both failures below are refusals to *start*, not failures of a started session, so they are
    // reported as client-visible states with machine-readable codes rather than being flattened
    // into the generic 500 the error handler would otherwise produce. Crucially, neither one has
    // spawned a provider process or written a durable record by the time it throws (see
    // `SessionManager.create`), so a caller is safe to retry either after freeing capacity.
    try {
      const session = sessionManager.create(provider, cwd, prompt, resumeProviderSessionId, model);
      reply.code(201).send(session);
    } catch (err) {
      if (err instanceof ActiveSessionLimitError) {
        reply.code(409).send({
          error: 'too many active sessions',
          code: err.code,
          scope: err.scope,
          capacity: err.capacity,
        });
        return;
      }
      if (err instanceof StorageFullError) {
        // 507 Insufficient Storage, not 503: the daemon is healthy and every other route works.
        // What is exhausted is the session store's retention budget, and nothing evictable remains.
        reply.code(507).send({ error: 'session storage is full', code: err.code });
        return;
      }
      throw err;
    }
  });

  app.get('/sessions/:sessionId', async (req, reply) => {
    const params = sessionIdParamSchema.safeParse(req.params);
    if (!params.success) {
      reply.code(400).send({ error: 'invalid session id' });
      return;
    }
    const session = sessionManager.get(params.data.sessionId);
    if (!session) {
      reply.code(404).send({ error: 'session not found' });
      return;
    }
    reply.send(session);
  });

  app.get('/sessions/:sessionId/events', async (req, reply) => {
    const params = sessionIdParamSchema.safeParse(req.params);
    if (!params.success) {
      reply.code(400).send({ error: 'invalid session id' });
      return;
    }
    if (!sessionManager.get(params.data.sessionId)) {
      reply.code(404).send({ error: 'session not found' });
      return;
    }

    reply.hijack();
    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
    });

    const lastEventIdHeader = req.headers['last-event-id'];
    const lastEventId = Array.isArray(lastEventIdHeader) ? lastEventIdHeader[0] : lastEventIdHeader;
    const sinceIndex = lastEventId ? Number(lastEventId) + 1 : 0;

    // Declared separately (not `const unsubscribe = subscribe(...)`) because the listener below
    // can run *synchronously inside* this call (replaying already-stored events). Referencing
    // `unsubscribe`/`cleanup` from inside it before a combined declaration+assignment finished
    // initializing would throw. `let` here is deliberate, not a lint slip.
    let unsubscribe: (() => void) | undefined;
    let cleanupRequested = false;
    const cleanup = (): void => {
      if (!unsubscribe) {
        // subscribe() hasn't returned its disposer yet -- the writer closed synchronously during
        // replay, before `unsubscribe` below could be assigned. Remember it and unsubscribe the
        // instant it is.
        cleanupRequested = true;
        return;
      }
      const release = unsubscribe;
      unsubscribe = undefined;
      release();
    };
    // Bounded, backpressure-aware writer (see sse-writer.ts): enqueues synchronously, honors
    // `reply.raw.write`'s drain signal, and disconnects only this one slow subscriber -- never the
    // provider session -- on overflow.
    const writer = new BoundedSseWriter(reply.raw, cleanup);
    // Both `reply.raw` (the response) and `req.raw` (the request) can independently emit their own
    // `'close'`, and on some platforms/Node versions one can fire without the other -- both routes
    // to teardown go through `writer.close()`, never a second, independent cleanup path, so there is
    // exactly one place that decides "this connection is done" regardless of which side noticed
    // first. `writer.close()` -> `#finish()` is idempotent, so both firing is always safe.
    reply.raw.once('close', () => writer.close());
    req.raw.once('close', () => writer.close());
    if (reply.raw.destroyed || reply.raw.writableEnded) {
      // The response was already torn down before this handler even reached here (a client that
      // aborted during routing/auth, before either 'close' listener above could be registered in
      // time to observe it) -- `once('close', ...)` never replays a past event to a late listener,
      // so without this check the writer, and the session-manager listener it will register below,
      // would never be torn down until the runtime object itself became unreachable.
      writer.close();
      return;
    }
    writer.start();

    unsubscribe = sessionManager.subscribe(
      params.data.sessionId,
      Number.isFinite(sinceIndex) ? sinceIndex : 0,
      (_index, event) => writer.write(event),
    );

    if (!unsubscribe) {
      // Lost the race against a concurrent DELETE that ran between the existence check above and
      // subscribe(): the session's runtime state is already gone. Without this, the already-200
      // response would stay open forever with no data and no close (the exact race the daemon
      // audit flagged for this route).
      writer.close();
      return;
    }
    if (cleanupRequested) {
      // The writer already closed synchronously during replay (a terminal event was already
      // stored, or the connection overflowed while replaying); the disposer above never ran it.
      cleanup();
      return;
    }
    // A client reconnecting with Last-Event-ID past the terminal event (it already has that event)
    // replays nothing, so the writer never sees a terminal frame to close on; without this the
    // connection would stay open forever once the session has no more events left to ever emit.
    const current = sessionManager.get(params.data.sessionId);
    if (!current || TERMINAL_SESSION_STATUSES.has(current.status)) writer.finishReplay();
    // No separate `req.raw`/`reply.raw` 'close' listener needed here: both were already registered,
    // once each, before `writer.start()` above, and both route through the same `writer.close()`.
  });

  app.post('/sessions/:sessionId/cancel', async (req, reply) => {
    const params = sessionIdParamSchema.safeParse(req.params);
    if (!params.success) {
      reply.code(400).send({ error: 'invalid session id' });
      return;
    }
    const ok = await sessionManager.cancel(params.data.sessionId);
    if (!ok) {
      reply.code(404).send({ error: 'session not found' });
      return;
    }
    reply.code(202).send({ status: 'cancelling' });
  });

  // Narrow, single-purpose route (not a generic process-control endpoint) so Electron's shutdown
  // path can ask the daemon to cancel every in-flight session over HTTP, which Windows can
  // deliver reliably, unlike a real SIGTERM to the daemon process itself (child.kill() maps to
  // TerminateProcess on Windows, so the daemon's own SIGTERM handler never runs there; see
  // apps/desktop/electron/main.ts#killDaemon and SECURITY.md). AD-12.
  app.post('/sessions/cancel-all', async (_req, reply) => {
    await sessionManager.cancelAll();
    reply.code(202).send({ status: 'cancelling' });
  });

  app.delete('/sessions/:sessionId', async (req, reply) => {
    const params = sessionIdParamSchema.safeParse(req.params);
    if (!params.success) {
      reply.code(400).send({ error: 'invalid session id' });
      return;
    }
    const ok = await sessionManager.remove(params.data.sessionId);
    if (!ok) {
      reply.code(404).send({ error: 'session not found' });
      return;
    }
    reply.code(204).send();
  });
}
