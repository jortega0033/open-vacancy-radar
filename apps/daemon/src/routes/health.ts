import type { FastifyInstance } from 'fastify';
import { AGENT_DOCK_PROTOCOL_VERSION } from '@agent-dock/shared';

export interface HealthRouteOptions {
  /**
   * Whether the daemon actually has v2 routes mounted this run.
   *
   * This is not a build-time constant, and that is the point: the daemon falls back to memory-only
   * v1 operation when its durable state was written by a newer build (see
   * `UnsupportedStateSchemaVersionError`), and in that mode there are genuinely no v2 routes to
   * call. Advertising `[1, 2]` there would send a v2 client to endpoints that 404. `protocolVersion`
   * stays frozen at 1 in every mode, so a v1 client reading only that field never sees a change.
   */
  v2Enabled: boolean;
}

export function registerHealthRoute(app: FastifyInstance, startedAt: number, options: HealthRouteOptions): void {
  app.get('/health', async () => ({
    status: 'ok' as const,
    uptimeSeconds: Math.round((Date.now() - startedAt) / 1000),
    protocolVersion: AGENT_DOCK_PROTOCOL_VERSION,
    supportedProtocolVersions: options.v2Enabled ? [1, 2] : [1],
  }));
}
