import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  ApplicationQueueInvalidTransitionError,
  ApplicationQueueNotFoundError,
  type ApplicationQueueStore,
} from '../application-queue-store.js';

/**
 * The daemon-owned application queue routes (#200). Registered only when a durable store is
 * active (`server.ts`'s `applicationQueue` v2 option), the same downgrade discipline every other
 * v2 route already follows: absence of the option is the whole rollback mechanism.
 *
 * These routes never see a job description, a CV, or a rendered file -- only opaque attempt ids
 * and this queue's own scheduling state. See `application-queue-store.ts`'s own doc comment for
 * why that boundary is deliberate.
 */

const attemptIdParamSchema = z.object({ attemptId: z.string().min(1).max(200) });
const enqueueBodySchema = z.object({ attemptId: z.string().min(1).max(200) });
const releaseBodySchema = z.object({
  leaseId: z.string().min(1).max(200),
  outcome: z.enum(['completed', 'failed', 'requeue']),
});

export function registerV2ApplicationRoutes(app: FastifyInstance, store: ApplicationQueueStore): void {
  app.post('/v2/applications', async (req, reply) => {
    const parsed = enqueueBodySchema.safeParse(req.body);
    if (!parsed.success) {
      reply.code(400).send({ error: 'invalid request body', code: 'invalid_body' });
      return;
    }
    const entry = store.enqueue(parsed.data.attemptId);
    reply.code(201).send({ schemaVersion: 1, entry });
  });

  app.get('/v2/applications', async (_req, reply) => {
    reply.send({ schemaVersion: 1, entries: store.list(), lease: store.currentLease() });
  });

  app.get('/v2/applications/:attemptId', async (req, reply) => {
    const params = attemptIdParamSchema.safeParse(req.params);
    if (!params.success) {
      reply.code(400).send({ error: 'invalid attempt id', code: 'invalid_attempt_id' });
      return;
    }
    const entry = store.get(params.data.attemptId);
    if (!entry) {
      reply.code(404).send({ error: 'no such attempt in the queue', code: 'application_not_found' });
      return;
    }
    reply.send({ schemaVersion: 1, entry });
  });

  /** One handler shared by pause/resume/skip/cancel: same params, same success/error shape, only
   * the store method called differs. Kept as one function rather than four near-identical route
   * bodies so the error mapping can never drift between them. */
  function registerTransition(path: string, action: (attemptId: string) => ReturnType<ApplicationQueueStore['pause']>) {
    app.post(path, async (req, reply) => {
      const params = attemptIdParamSchema.safeParse(req.params);
      if (!params.success) {
        reply.code(400).send({ error: 'invalid attempt id', code: 'invalid_attempt_id' });
        return;
      }
      try {
        const entry = action(params.data.attemptId);
        reply.send({ schemaVersion: 1, entry });
      } catch (err) {
        if (err instanceof ApplicationQueueNotFoundError) {
          reply.code(404).send({ error: err.message, code: 'application_not_found' });
          return;
        }
        if (err instanceof ApplicationQueueInvalidTransitionError) {
          reply.code(409).send({ error: err.message, code: 'invalid_transition', from: err.from, action: err.action });
          return;
        }
        throw err;
      }
    });
  }

  registerTransition('/v2/applications/:attemptId/pause', (id) => store.pause(id));
  registerTransition('/v2/applications/:attemptId/resume', (id) => store.resume(id));
  registerTransition('/v2/applications/:attemptId/skip', (id) => store.skip(id));
  registerTransition('/v2/applications/:attemptId/cancel', (id) => store.cancel(id));

  /**
   * The scheduling decision Electron main's worker polls: "is there work for me?" Returns
   * `{ lease: null }` (200, not 404 or 409) when nothing is schedulable -- an empty or fully-busy
   * queue is a normal, expected outcome for a poller, not an error condition.
   */
  app.post('/v2/applications/lease/acquire', async (_req, reply) => {
    const lease = store.acquireNextLease();
    reply.send({ schemaVersion: 1, lease });
  });

  /**
   * Ends a lease Electron main finished (or gave up on). A no-op that still replies 204 for a
   * `leaseId` that no longer matches the current lease -- see `ApplicationQueueStore.release`'s own
   * doc comment for why that has to be silent rather than an error.
   */
  app.post('/v2/applications/lease/release', async (req, reply) => {
    const parsed = releaseBodySchema.safeParse(req.body);
    if (!parsed.success) {
      reply.code(400).send({ error: 'invalid request body', code: 'invalid_body' });
      return;
    }
    store.release(parsed.data.leaseId, parsed.data.outcome);
    reply.code(204).send();
  });

  /**
   * SSE stream of queue state-change events, mirroring `/sessions/:id/events`'s shape exactly
   * (hijack + manual `text/event-stream` head + `Last-Event-ID` resume), scoped to the whole queue
   * rather than one session since there is exactly one queue, not one per attempt.
   */
  app.get('/v2/applications/events', async (req, reply) => {
    reply.hijack();
    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
    });
    reply.raw.write(':ok\n\n');

    const lastEventIdHeader = req.headers['last-event-id'];
    const lastEventId = Array.isArray(lastEventIdHeader) ? lastEventIdHeader[0] : lastEventIdHeader;
    const sinceSeq = lastEventId ? Number(lastEventId) + 1 : 0;

    const unsubscribe = store.subscribe(Number.isFinite(sinceSeq) ? sinceSeq : 0, (event) => {
      reply.raw.write(`id: ${event.seq}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
    });
    req.raw.on('close', unsubscribe);
  });
}
