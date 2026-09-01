import { existsSync, statSync } from 'node:fs';
import type { FastifyInstance } from 'fastify';
import { createSessionRequestSchema, sessionIdParamSchema } from '@agent-dock/shared';
import type { ProviderRegistry } from '@agent-dock/agent-runtime';
import type { SessionManager } from '../session-manager.js';
import { ActiveSessionLimitError } from '../active-session-limiter.js';
import { StorageFullError } from '../session-lineage-store.js';

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
    reply.raw.write(':ok\n\n');

    const lastEventIdHeader = req.headers['last-event-id'];
    const lastEventId = Array.isArray(lastEventIdHeader) ? lastEventIdHeader[0] : lastEventIdHeader;
    const sinceIndex = lastEventId ? Number(lastEventId) + 1 : 0;

    let ended = false;
    // Declared separately (not `const unsubscribe = subscribe(...)`) because the listener below
    // can run *synchronously inside* this call (replaying already-stored events). Referencing
    // `unsubscribe` from inside it before a combined declaration+assignment finished initializing
    // would throw. `let` here is deliberate, not a lint slip.
    let unsubscribe: (() => void) | undefined;
    // eslint-disable-next-line prefer-const
    unsubscribe = sessionManager.subscribe(
      params.data.sessionId,
      Number.isFinite(sinceIndex) ? sinceIndex : 0,
      (index, event) => {
        reply.raw.write(`id: ${index}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
        if (event.type === 'session.completed' || event.type === 'session.failed' || event.type === 'session.cancelled') {
          ended = true;
          unsubscribe?.();
          reply.raw.end();
        }
      },
    );

    if (!unsubscribe) {
      // Lost the race against a concurrent DELETE that ran between the existence check above and
      // subscribe(): the session's runtime state is already gone. Without this, the already-200
      // response would stay open forever with no data and no close (the exact race the daemon
      // audit flagged for this route).
      reply.raw.end();
      return;
    }

    // If the session was already terminal, the listener above fired synchronously during
    // subscribe() (before `unsubscribe` was assigned). Clean it up now instead.
    if (ended) unsubscribe();
    else req.raw.on('close', () => unsubscribe?.());
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
