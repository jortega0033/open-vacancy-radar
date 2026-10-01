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
  /**
   * A UUID minted once per daemon process (ADI-06, D7).
   *
   * It exists so the desktop app can tell "the daemon I am talking to" from "a daemon that replaced
   * it". Workspace grants are approvals the *user* gave to a specific running daemon; when that
   * process dies and a new one takes its place under the same port and discovery file, every
   * outstanding grant refers to a decision the new daemon never saw, and main expires all of them on
   * noticing the id changed. Without a per-process id there is nothing to notice: the port, the
   * token, and the discovery file can all be identical across a restart.
   *
   * Additive on the wire (`healthResponseSchema` is not `.strict()`, and the field is optional), so
   * a client built before this ticket validates the response unchanged.
   */
  daemonInstanceId: string;
}

export function registerHealthRoute(app: FastifyInstance, startedAt: number, options: HealthRouteOptions): void {
  app.get('/health', async () => ({
    status: 'ok' as const,
    uptimeSeconds: Math.round((Date.now() - startedAt) / 1000),
    protocolVersion: AGENT_DOCK_PROTOCOL_VERSION,
    supportedProtocolVersions: options.v2Enabled ? [1, 2] : [1],
    daemonInstanceId: options.daemonInstanceId,
  }));
}
