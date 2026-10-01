import { existsSync, statSync } from 'node:fs';
import type { FastifyInstance } from 'fastify';
import { createSessionRequestSchema } from '@agent-dock/shared';
import type { ProviderRegistry } from '@agent-dock/agent-runtime';
import type { SessionManager } from '../session-manager.js';
import { ActiveSessionLimitError } from '../active-session-limiter.js';
import { StorageFullError } from '../session-lineage-store.js';

/**
 * `POST /sessions/vacancy-web-discovery` -- the one and only entry point for issue #398's AI-web
 * vacancy discovery (Phase 1, on-demand): a Claude session with `WebSearch`/`WebFetch` and nothing
 * else, searching and reading live job-posting pages on the desktop orchestrator's behalf.
 *
 * Modeled directly on `routes/application-generation.ts`'s `POST /sessions/application-field-map`,
 * for the same reason that route gives: the hardening profile a session gets must be chosen by
 * which route a trusted caller (this app's own Electron main process) hits, never by a value inside
 * the request body that same caller controls. This route hardcodes `'web-only'` server-side in its
 * `sessionManager.create()` call below; the general `POST /sessions` request schema gains no
 * caller-supplied `toolProfile` field. See `CLAUDE_HARDENING_ARGS_WEB_ONLY` in
 * `packages/agent-runtime/src/providers/claude/build-args.ts` for exactly what the profile grants
 * (`WebSearch`/`WebFetch` only -- no `Read`/`Write`/`Edit`/`Glob`/`Grep`/`NotebookEdit`) and why:
 * this session type deliberately, repeatedly fetches untrusted, attacker-influenceable web content
 * (scraped job postings) unattended, and must never also be able to read a workspace file and
 * exfiltrate it via a crafted `WebFetch` URL.
 *
 * No `resumeProviderSessionId`: every AI-web-discovery run is a fresh, one-shot search-and-extract
 * pass against the desktop orchestrator's current query budget (issue #398's bounded, auditable
 * query generation), so there is no thread to resume and the schema omits the field entirely rather
 * than accepting and ignoring it, exactly like `application-generation.ts`'s own route.
 *
 * `vacancy-engine`'s `AiWebDiscoveryCandidateSchema` is never imported here, and never will be: the
 * daemon stays generic AgentDock infrastructure with no vacancy-domain knowledge (issue #398's
 * explicit architecture boundary). This route only starts the session and hands back its raw
 * `AgentSession`; validating the model's JSON against that schema, normalizing it into
 * `DiscoveryVacancyAudit` rows, and checking candidate domains against `source-registry.ts` are all
 * the desktop layer's job, downstream of this route's response.
 */
export function registerVacancyWebDiscoveryRoutes(
  app: FastifyInstance,
  sessionManager: SessionManager,
  registry: ProviderRegistry,
): void {
  const requestSchema = createSessionRequestSchema.omit({ resumeProviderSessionId: true });

  app.post('/sessions/vacancy-web-discovery', async (req, reply) => {
    const parsed = requestSchema.safeParse(req.body);
    if (!parsed.success) {
      reply.code(400).send({ error: 'invalid request body', details: parsed.error.flatten() });
      return;
    }
    const { provider, cwd, prompt, model } = parsed.data;

    // Issue #398 is explicitly Claude-only in V1: `buildClaudeArgs` is the only provider adapter
    // that reads `opts.hardened` at all (Codex's own `buildCodexArgs` doc comment states this is
    // deliberate and permanent), so any other registered provider would silently start an
    // unrestricted, network-capable session with none of the tool restrictions this route exists
    // to guarantee. Mirrors `application-generation.ts`'s identical guard for the same reason.
    if (provider !== 'claude') {
      reply.code(400).send({ error: `provider does not support the vacancy-web-discovery hardening profile: ${provider}` });
      return;
    }

    const providerImpl = registry.get(provider);
    if (!providerImpl) {
      reply.code(400).send({ error: `unsupported provider: ${provider}` });
      return;
    }
    // CodeQL flags this existsSync/statSync call as missing rate limiting (js/missing-rate-limiting),
    // the same finding already dismissed on POST /sessions and POST /sessions/application-field-map:
    // the daemon binds 127.0.0.1 only, every request requires the per-launch bearer token, and there
    // is exactly one legitimate caller -- the desktop app's own Electron main process.
    if (!existsSync(cwd) || !statSync(cwd).isDirectory()) {
      reply.code(400).send({ error: `working directory does not exist: ${cwd}` });
      return;
    }

    try {
      const session = sessionManager.create(provider, cwd, prompt, undefined, model, 1, undefined, undefined, 'web-only');
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
