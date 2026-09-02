import type { FastifyInstance } from 'fastify';
import {
  DEFAULT_PAGE_LIMIT_V2,
  V2_WORKSPACE_VIEW_SCHEMA_VERSION,
  opaqueCursorV2Schema,
  pageLimitV2Schema,
} from '@agent-dock/shared';
import type { AuditStore } from '../audit-store.js';

/**
 * `GET /v2/audit`: the read surface over the workspace trust audit log (ADI-06).
 *
 * Read-only and paged, with no delete, no filter-by-workspace, and no "clear" verb. The omissions
 * are the design: a log that a client can prune is not evidence of anything, and this repo's own
 * threat model already concedes that the same-user attacker can edit the file directly (D5) -- there
 * is no reason to also hand them a supported API for it.
 *
 * Cursor and limit reuse `opaqueCursorV2Schema`/`pageLimitV2Schema` from `session-v2.ts` rather than
 * defining their own: two independently-maintained "is this cursor safe" rules is how one of them
 * ends up weaker, which is the same reasoning `state-directory.ts` gives for sharing `sanitizeAppId`.
 */
export function registerV2AuditRoutes(app: FastifyInstance, auditStore: AuditStore): void {
  app.get('/v2/audit', async (req, reply) => {
    const query = (req.query ?? {}) as Record<string, unknown>;

    let limit = DEFAULT_PAGE_LIMIT_V2;
    if (query.limit !== undefined) {
      const parsed = pageLimitV2Schema.safeParse(Number(query.limit));
      if (!parsed.success) {
        reply.code(400).send({ error: 'invalid limit', code: 'invalid_limit' });
        return;
      }
      limit = parsed.data;
    }

    let cursor: string | undefined;
    if (query.cursor !== undefined) {
      const parsed = opaqueCursorV2Schema.safeParse(query.cursor);
      if (!parsed.success) {
        reply.code(400).send({ error: 'invalid cursor', code: 'invalid_cursor' });
        return;
      }
      cursor = parsed.data;
    }

    const page = auditStore.list({ ...(cursor === undefined ? {} : { cursor }), limit });
    reply.send({
      schemaVersion: V2_WORKSPACE_VIEW_SCHEMA_VERSION,
      entries: page.entries,
      ...(page.nextCursor === undefined ? {} : { nextCursor: page.nextCursor }),
      // A client cannot fix a full or broken log, but it can stop pretending everything is fine:
      // both states mean the daemon is currently refusing trust decisions.
      unhealthy: auditStore.unhealthy,
    });
  });
}
