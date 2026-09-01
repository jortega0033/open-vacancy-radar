import type { FastifyInstance } from 'fastify';
import { V2_SESSION_VIEW_SCHEMA_VERSION, providerIdSchema } from '@agent-dock/shared';
import type { ProviderRegistry } from '@agent-dock/agent-runtime';
import type { ActiveSessionLimiter } from '../active-session-limiter.js';
import { toProviderV2View } from '../v2-legacy-provider.js';

/**
 * `GET /v2/providers` and `GET /v2/providers/:providerId`: read-only projections of the same
 * `detect()` results the v1 routes serve, plus the transport/compatibility/capacity facts a v2
 * client needs. Registered only when a durable store is active (see server.ts).
 *
 * Both handlers call into `detect()`, which probes the filesystem and can spawn a `where`/`which`
 * child process. Not rate-limited, for exactly the reason the v1 provider routes are not: this
 * daemon binds 127.0.0.1 only and every request needs the per-launch bearer token, so the only
 * caller that can reach this cost is the desktop app's own Electron main process.
 */
export function registerV2ProviderRoutes(
  app: FastifyInstance,
  registry: ProviderRegistry,
  limiter: ActiveSessionLimiter,
): void {
  app.get('/v2/providers', async () => {
    const statuses = await registry.detectAll();
    return {
      schemaVersion: V2_SESSION_VIEW_SCHEMA_VERSION,
      providers: statuses.map((status) => toProviderV2View(status, limiter.capacityFor(status.id))),
    };
  });

  app.get('/v2/providers/:providerId', async (req, reply) => {
    // Same two-stage validation the v1 route uses, and the same two distinct answers: a
    // syntactically invalid id is a caller mistake (400), while a well-formed id for a provider
    // this build does not have registered is a real, meaningful 404. Collapsing them would make a
    // typo indistinguishable from a provider that was deliberately not wired in.
    const parsed = providerIdSchema.safeParse((req.params as Record<string, unknown>).providerId);
    if (!parsed.success) {
      reply.code(400).send({ error: 'unknown provider id', code: 'invalid_provider_id' });
      return;
    }
    const provider = registry.get(parsed.data);
    if (!provider) {
      reply.code(404).send({ error: 'provider not registered', code: 'provider_not_found' });
      return;
    }
    const status = await provider.detect();
    reply.send({
      schemaVersion: V2_SESSION_VIEW_SCHEMA_VERSION,
      provider: toProviderV2View(status, limiter.capacityFor(status.id)),
    });
  });
}
