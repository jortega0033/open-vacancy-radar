import type { FastifyInstance } from 'fastify';
import { V2_SESSION_VIEW_SCHEMA_VERSION, providerIdSchema, type ProviderModelCatalogV2Response } from '@agent-dock/shared';
import type { ProviderRegistry } from '@agent-dock/agent-runtime';
import type { ActiveSessionLimiter } from '../active-session-limiter.js';
import { toProviderV2View } from '../v2-legacy-provider.js';

/**
 * `GET /v2/providers`, `GET /v2/providers/:providerId`, and `GET
 * /v2/providers/:providerId/models`: read-only projections of the same `detect()` results the v1
 * routes serve, plus the transport/compatibility/capacity facts a v2 client needs, plus (ADI-22a) a
 * provider's live model catalog where one exists. Registered only when a durable store is active
 * (see server.ts).
 *
 * The first two handlers call into `detect()`, which probes the filesystem and can spawn a
 * `where`/`which` child process; the third calls `fetchModelCatalog()` where a provider implements
 * one (Codex, as of ADI-22a -- see `packages/agent-runtime/src/providers/codex/adapter.ts`), which
 * for Codex means a short-lived `codex app-server --stdio` process. None of the three is
 * rate-limited, for exactly the reason the v1 provider routes are not: this daemon binds
 * 127.0.0.1 only and every request needs the per-launch bearer token, so the only caller that can
 * reach this cost is the desktop app's own Electron main process.
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

  /**
   * ADI-22a. `models` is empty -- never a distinct error status -- for a provider that implements
   * no `fetchModelCatalog` at all (Claude today, blocked on #144) and for one that does but whose
   * live probe failed or timed out: both are "no live catalog available right now" from a caller's
   * point of view, and `providerModelCatalogV2ResponseSchema`'s own doc comment
   * (`packages/shared/src/capabilities-v2.ts`) is explicit that an empty array carries no meaning
   * beyond that. The two 4xx branches above (invalid id / unregistered provider) are unchanged and
   * still real refusals -- this route only softens the *catalog* failure mode, not provider lookup.
   */
  app.get('/v2/providers/:providerId/models', async (req, reply) => {
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

    let models: ProviderModelCatalogV2Response['models'] = [];
    if (provider.fetchModelCatalog) {
      try {
        models = [...(await provider.fetchModelCatalog({}))];
      } catch (error) {
        req.log.warn(
          { providerId: parsed.data, error },
          'a live model catalog probe failed; answering with an empty catalog rather than failing the request',
        );
      }
    }

    const response: ProviderModelCatalogV2Response = {
      schemaVersion: V2_SESSION_VIEW_SCHEMA_VERSION as 1,
      providerId: parsed.data,
      models,
    };
    reply.send(response);
  });
}
