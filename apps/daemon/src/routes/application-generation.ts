import { existsSync, statSync } from 'node:fs';
import type { FastifyInstance } from 'fastify';
import { createSessionRequestSchema } from '@agent-dock/shared';
import type { ProviderRegistry } from '@agent-dock/agent-runtime';
import type { SessionManager } from '../session-manager.js';
import { ActiveSessionLimitError } from '../active-session-limiter.js';
import { StorageFullError } from '../session-lineage-store.js';

/**
 * `POST /sessions/application-field-map` -- the one and only entry point for the application
 * executor's Domain A (#196 §2, issue #201): a text-only generation session that reasons over a
 * closed value table and a structured form snapshot to produce a field map, with no browser tool
 * and no network egress of its own.
 *
 * A dedicated route rather than a field on the general `POST /sessions` body, deliberately: the
 * hardening profile a session gets must be chosen by which route a trusted caller (this app's own
 * Electron main process) hits, never by a value inside the request body that same caller controls.
 * `SessionManager.create()`'s own doc comment states this as the general rule; this route is what
 * it looks like in practice. See `CLAUDE_HARDENING_ARGS_NO_NETWORK` in
 * `packages/agent-runtime/src/providers/claude/build-args.ts` for what the profile restricts.
 *
 * No `resumeProviderSessionId`: every field-map generation is a fresh, one-shot call against the
 * current snapshot generation (#196 §2.4 rule 2 refuses a stale one downstream anyway), so there is
 * no thread to resume and the schema omits the field entirely rather than accepting and ignoring it.
 */
export function registerApplicationGenerationRoutes(
  app: FastifyInstance,
  sessionManager: SessionManager,
  registry: ProviderRegistry,
): void {
  const requestSchema = createSessionRequestSchema.omit({ resumeProviderSessionId: true });

  app.post('/sessions/application-field-map', async (req, reply) => {
    const parsed = requestSchema.safeParse(req.body);
    if (!parsed.success) {
      reply.code(400).send({ error: 'invalid request body', details: parsed.error.flatten() });
      return;
    }
    const { provider, cwd, prompt, model } = parsed.data;

    const providerImpl = registry.get(provider);
    if (!providerImpl) {
      reply.code(400).send({ error: `unsupported provider: ${provider}` });
      return;
    }
    // CodeQL flags this existsSync/statSync call as missing rate limiting (js/missing-rate-limiting),
    // the same finding already dismissed on POST /sessions in sessions.ts, for the same reason: the
    // daemon binds 127.0.0.1 only, every request requires the per-launch bearer token, and there is
    // exactly one legitimate caller -- the desktop app's own Electron main process. See that route's
    // own comment for the full reasoning; it applies to this route unchanged.
    if (!existsSync(cwd) || !statSync(cwd).isDirectory()) {
      reply.code(400).send({ error: `working directory does not exist: ${cwd}` });
      return;
    }

    try {
      const session = sessionManager.create(provider, cwd, prompt, undefined, model, 1, undefined, undefined, 'no-network');
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
        reply.code(507).send({ error: 'session storage is full', code: err.code });
        return;
      }
      throw err;
    }
  });
}
