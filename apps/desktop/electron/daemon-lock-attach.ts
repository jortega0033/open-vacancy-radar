/**
 * What to check when `spawnDaemon()`'s child exits with `DAEMON_EXIT_CODE_LOCK_CONFLICT`
 * (`apps/daemon/src/discovery-file.ts`'s `assertNoLiveDaemon`): another daemon with the same app id
 * is already alive, by definition, and already wrote the discovery file this process reads for its
 * own connection. Treating that exit the same as any other startup failure -- scheduling a bounded
 * respawn via `daemon-respawn.ts` -- can only lose the same lock race again on every attempt, which
 * burns the whole respawn budget and leaves this process stuck in a startup-failure state it never
 * recovers from on its own (this is exactly what two Electron main-process instances racing to
 * spawn their own daemon sidecar on a slow dev-server cold start produces in practice -- see
 * `quitAsDuplicateInstance` in `main.ts` for why that race can happen and what this process does
 * about it once this module confirms the sibling's daemon is actually there).
 *
 * This module only answers the IO question -- "is there a reachable daemon at the other end of
 * this discovery file" -- and leaves the resulting decision to `main.ts`. Lives here, not there,
 * for the same reason `daemon-respawn.ts` does: `main.ts` cannot be imported by a test (doing so
 * boots Electron and spawns the daemon sidecar for real).
 */

import type { HealthResponse } from '@agent-dock/client';

export interface DiscoveredDaemon {
  baseUrl: string;
  token: string;
}

export interface DaemonLockAttachDeps {
  /** Reads and parses the discovery file. `undefined` for anything that isn't a daemon to confirm:
   * the file doesn't exist, or its contents are missing/corrupt. */
  readDiscoveryFile: () => DiscoveredDaemon | undefined;
  /** Calls the candidate daemon's health endpoint. `undefined` if it isn't actually reachable --
   * the discovery file could be stale (its daemon died after writing it, before this process got
   * here) or mid-write by a daemon that hasn't finished starting yet. Returns the real
   * `HealthResponse` (not a hand-picked subset) so a field this module doesn't use today -- e.g.
   * `supportedProtocolVersions` -- doesn't need a second, drifting declaration here to use later. */
  checkHealth: (daemon: DiscoveredDaemon) => Promise<HealthResponse | undefined>;
}

/**
 * Returns the sibling daemon this process lost the lock race to, confirmed reachable, or
 * `undefined` if there is nothing valid to confirm -- in which case the caller falls back to
 * treating the exit as a genuine failure (the ordinary `scheduleDaemonRespawn` path).
 */
export async function tryAttachToWinningDaemon(
  deps: DaemonLockAttachDeps,
): Promise<{ daemon: DiscoveredDaemon; health: HealthResponse } | undefined> {
  const daemon = deps.readDiscoveryFile();
  if (!daemon) return undefined;
  const health = await deps.checkHealth(daemon);
  if (!health) return undefined;
  return { daemon, health };
}
