import type { FastifyInstance } from 'fastify';
import {
  DEFAULT_PAGE_LIMIT_V2,
  V2_SESSION_VIEW_SCHEMA_VERSION,
  opaqueCursorV2Schema,
  pageLimitV2Schema,
  sessionIdParamSchema,
  type ActiveSessionCapacityView,
  type AgentSessionV2View,
} from '@agent-dock/shared';
import { ACTIVE_SESSION_LIMITS, type ActiveSessionLimiter } from '../active-session-limiter.js';
import { InvalidCursorError, type SessionLineageStore } from '../session-lineage-store.js';
import type { PersistedSessionRecordV1 } from '../persisted-session-schema.js';

/**
 * The v2 session **read** routes. Registered only when a durable store is active (see server.ts).
 *
 * There is deliberately no `POST /v2/sessions`, no `DELETE`, and no `/cancel` here. Creating a
 * session over v2 means accepting a capability-negotiation request shape, and this repo has no such
 * schema -- inventing one ad hoc, under this ticket, would freeze a public request contract that
 * nothing has reviewed. Session creation and control stay on the v1 routes, which are unchanged and
 * remain the only way to start or stop anything. See
 * docs/adr-agentdock-v2-provenance.md#adi-05 for the full deferral note.
 *
 * `GET /sessions/:id/events` (the live v1 SSE stream) is likewise untouched. The v2 events route
 * below is a **JSON page over the durable, redacted log**, which is a different thing serving a
 * different need: SSE answers "what is happening now", this answers "what happened, including
 * before the last restart".
 */

function toV2View(record: PersistedSessionRecordV1): AgentSessionV2View {
  const s = record.session;
  return {
    schemaVersion: V2_SESSION_VIEW_SCHEMA_VERSION as 1,
    id: s.id,
    provider: s.provider,
    protocolVersion: record.protocolVersion,
    transportId: s.transportId,
    cwd: s.cwd,
    ...(s.model === undefined ? {} : { model: s.model }),
    status: s.status,
    ...(s.terminalReason === undefined ? {} : { terminalReason: s.terminalReason }),
    acceptedWork: s.acceptedWork,
    ...(s.providerSessionId === undefined ? {} : { providerSessionId: s.providerSessionId }),
    rootSessionId: s.rootSessionId,
    ...(s.parentSessionId === undefined ? {} : { parentSessionId: s.parentSessionId }),
    continuationKind: s.continuationKind,
    startedAt: s.startedAt,
    ...(s.completedAt === undefined ? {} : { completedAt: s.completedAt }),
    earliestSequence: s.earliestSequence,
    eventCount: s.eventCount,
    eventsTruncated: s.eventsTruncated,
    scope: s.scope,
    unknownFrames: [...s.unknownFrames],
  };
}

/**
 * Capacity for a listing that is not scoped to one provider.
 *
 * `global` is exact. The `provider` bucket reports the **most-utilized** provider, because the
 * question a client asks a list response is "can I start another session?", and the honest answer
 * across all providers is bounded by whichever bucket is closest to full. Reporting zero, or an
 * arbitrary provider's count, would let a UI render spare capacity that a `POST` would then refuse.
 * A client that wants one provider's exact figure asks for it with `?provider=`.
 */
function aggregateCapacity(limiter: ActiveSessionLimiter): ActiveSessionCapacityView {
  const snapshot = limiter.snapshot();
  const busiest = Object.values(snapshot.byProvider).reduce((max, count) => Math.max(max, count), 0);
  return {
    global: { active: snapshot.global, limit: ACTIVE_SESSION_LIMITS.global },
    provider: { active: busiest, limit: ACTIVE_SESSION_LIMITS.perProvider },
  };
}

/** Parses and bounds `?limit=`. An out-of-range or non-numeric value is a 400, never a clamp. */
function parseLimit(raw: unknown): number | undefined {
  if (raw === undefined) return DEFAULT_PAGE_LIMIT_V2;
  const parsed = pageLimitV2Schema.safeParse(Number(raw));
  return parsed.success ? parsed.data : undefined;
}

export function registerV2SessionRoutes(
  app: FastifyInstance,
  store: SessionLineageStore,
  limiter: ActiveSessionLimiter,
): void {
  app.get('/v2/sessions', async (req, reply) => {
    const query = (req.query ?? {}) as Record<string, unknown>;

    const limit = parseLimit(query.limit);
    if (limit === undefined) {
      reply.code(400).send({ error: 'invalid limit', code: 'invalid_limit' });
      return;
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

    try {
      const page = store.listSessions({ ...(cursor === undefined ? {} : { cursor }), limit });
      reply.send({
        schemaVersion: V2_SESSION_VIEW_SCHEMA_VERSION,
        sessions: page.sessions.map(toV2View),
        ...(page.nextCursor === undefined ? {} : { nextCursor: page.nextCursor }),
        capacity: aggregateCapacity(limiter),
      });
    } catch (err) {
      if (err instanceof InvalidCursorError) {
        // Well-formed by charset but addressing nothing: a cursor whose record has since been
        // evicted lands here. 400 rather than 404 -- the collection exists, the cursor does not.
        reply.code(400).send({ error: 'invalid cursor', code: 'invalid_cursor' });
        return;
      }
      throw err;
    }
  });

  app.get('/v2/sessions/:sessionId', async (req, reply) => {
    const params = sessionIdParamSchema.safeParse(req.params);
    if (!params.success) {
      reply.code(400).send({ error: 'invalid session id', code: 'invalid_session_id' });
      return;
    }
    const record = store.get(params.data.sessionId);
    if (!record) {
      reply.code(404).send({ error: 'session not found', code: 'session_not_found' });
      return;
    }
    reply.send({ schemaVersion: V2_SESSION_VIEW_SCHEMA_VERSION, session: toV2View(record) });
  });

  app.get('/v2/sessions/:sessionId/events', async (req, reply) => {
    const params = sessionIdParamSchema.safeParse(req.params);
    if (!params.success) {
      reply.code(400).send({ error: 'invalid session id', code: 'invalid_session_id' });
      return;
    }
    const record = store.get(params.data.sessionId);
    if (!record) {
      reply.code(404).send({ error: 'session not found', code: 'session_not_found' });
      return;
    }

    const query = (req.query ?? {}) as Record<string, unknown>;
    const limit = parseLimit(query.limit);
    if (limit === undefined) {
      reply.code(400).send({ error: 'invalid limit', code: 'invalid_limit' });
      return;
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

    try {
      const page = store.listEvents(params.data.sessionId, {
        ...(cursor === undefined ? {} : { cursor }),
        limit,
      });
      reply.send({
        schemaVersion: V2_SESSION_VIEW_SCHEMA_VERSION,
        sessionId: params.data.sessionId,
        events: page.events,
        ...(page.nextCursor === undefined ? {} : { nextCursor: page.nextCursor }),
      });
    } catch (err) {
      if (err instanceof InvalidCursorError) {
        reply.code(400).send({ error: 'invalid cursor', code: 'invalid_cursor' });
        return;
      }
      throw err;
    }
  });
}
