import type { FastifyInstance } from 'fastify';
import { providerIdSchema } from '@agent-dock/shared';
import type { ProviderRegistry } from '@agent-dock/agent-runtime';

// Both handlers below call into provider detect(), which probes the filesystem and can spawn a
// `where`/`which` child process per candidate install directory (see
// packages/agent-runtime/src/detect-executable.ts). Not rate-limited, for the same reason
// POST /sessions isn't (see the dismissal on apps/daemon/src/routes/sessions.ts): this daemon
// binds 127.0.0.1 only and every request needs the per-launch bearer token, so the only caller
// that can ever reach this cost is the desktop app's own Electron main process.
export function registerProviderRoutes(app: FastifyInstance, registry: ProviderRegistry): void {
  app.get('/providers', async () => ({ providers: await registry.detectAll() }));

  app.get('/providers/:providerId', async (req, reply) => {
    const parsed = providerIdSchema.safeParse((req.params as Record<string, unknown>).providerId);
    if (!parsed.success) {
      reply.code(400).send({ error: 'unknown provider id' });
      return;
    }
    const provider = registry.get(parsed.data);
    if (!provider) {
      reply.code(404).send({ error: 'provider not registered' });
      return;
    }
    reply.send(await provider.detect());
  });
}
