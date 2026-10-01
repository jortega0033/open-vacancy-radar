/**
 * The daemon process (apps/daemon) and the Electron main process that spawns it
 * (apps/desktop/electron/main.ts) run as two separate Node processes with no shared module graph,
 * so an exit code is the only contract precise enough to tell "another instance already owns this
 * app id's discovery file" (apps/daemon/src/discovery-file.ts's `assertNoLiveDaemon`,
 * `DaemonLockConflictError`) apart from every other reason the daemon can fail to start. The
 * parent process needs that distinction: a lock conflict means a sibling daemon is already alive
 * and reachable through the discovery file it just wrote, so the parent should attach to it
 * (see main.ts's daemon-exit handler) instead of burning its bounded respawn budget retrying a
 * spawn that can only lose the same race again.
 */
export const DAEMON_EXIT_CODE_LOCK_CONFLICT = 75;
