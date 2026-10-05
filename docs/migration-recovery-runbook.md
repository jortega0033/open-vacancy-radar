# Migration, recovery and downgrade runbook

Operational runbook for the Windows desktop app (issue #127). Every statement below was checked
against the code named next to it. Anything not checked is marked **Not verified** instead of
guessed. For rolling back an AgentDock v2 change in the repository, see
[rollback-runbook-agentdock-v2.md](rollback-runbook-agentdock-v2.md). For backing up and restoring
user data, see [troubleshooting.md](troubleshooting.md).

## What lives where

All of it is under Electron's `userData` directory (`%APPDATA%\Open Vacancy Radar`), and none of it
is removed by uninstalling the app (see [packaging.md](packaging.md#uninstall-behavior)).

| Item | Written by | Migrated by |
|---|---|---|
| `workspace.db` | `apps/desktop/electron/workspace/client.ts` | drizzle, `electron/workspace/drizzle/*.sql` |
| `vacancy-engine.db` | `packages/vacancy-engine`, opened in `ensureVacancyEngine()` in `electron/main.ts` | drizzle, `packages/vacancy-engine/drizzle` |
| `agentdock-state/sessions-v1/` | the daemon (`apps/daemon/src/session-lineage-store.ts`) | its own `schemaVersion` checks, no SQL |

## Migration

**Workspace database.** `createWorkspaceDb()` opens `workspace.db`, then runs drizzle's
`migrate()` against the SQL files that ship inside `app.asar` at `dist-electron/drizzle`. This
happens on first use of the workspace in a run, not as a separate installer step. drizzle applies
every migration newer than the newest row in its `__drizzle_migrations` table, inside one
transaction, and rolls the whole batch back if any statement fails (read from drizzle's SQLite
dialect `migrate()`). A failed upgrade therefore leaves the schema at its previous version.

**Vacancy-engine database.** `ensureVacancyEngine()` opens the file and calls `migrateDatabase()`
with the folder shipped at `resources/vacancy-engine/drizzle`. Concurrent callers share one
in-flight attempt, and a failure is not cached, so a later call retries. A failure is recorded with
the stage (`open` or `migrate`) so the UI can explain it. If the file itself is damaged,
Settings > Data > Rebuild job cache sets it aside and builds a fresh one. Locked, migration and
unknown failures get no rebuild offer (`rebuildVacancyCache()` in `electron/main.ts`).

**Daemon state.** There is no SQL. On start the daemon opens the store before it binds a port;
anything it cannot read is quarantined, never deleted (see
[daemon.md](daemon.md#corruption-retention-and-future-versions)).

**Release gate.** `scripts/packaged-smoke.mjs` fails the `Package Windows installer` job when any
workspace or vacancy-engine migration file, or the vacancy-engine config, is missing from the
unpacked package.

## Recovery

- **Daemon crash or app kill.** On the next start, a session found `starting` or `running` with no
  terminal event gets a synthetic `session.interrupted` event and is recorded as `interrupted` with
  reason `daemon_restart`. Its accepted-work flag is kept as it was, so a session whose prompt was
  already delivered is not retried automatically. A v1 client sees it as `failed`
  ([daemon.md](daemon.md#restart-recovery)). Recovery completes before the daemon accepts requests.
- **Corrupt or torn state.** Moved to `sessions-v1/quarantine/`. Safe to copy out and attach to an
  issue. Do not delete it while diagnosing.
- **Stale discovery file.** The daemon writes `%TEMP%\agent-dock\<app id>.json` (port, token, pid)
  and refuses to start while a live process owns it. A leftover file from a dead process is not a
  blocker (`assertNoLiveDaemon()` in `apps/daemon/src/discovery-file.ts` checks the pid).
- **Damaged `workspace.db`.** **Not verified.** There is no in-app repair or restore flow
  ([troubleshooting.md](troubleshooting.md)). Restore from your own backup with the app closed.
- **Provider child processes.** On Windows the app asks the daemon to cancel every session over HTTP
  (`POST /sessions/cancel-all`) before it terminates the daemon, because terminating the process
  skips its signal handler. Provider processes run under the Job Object host
  (`agent-dock-job-host.exe`). The termination suite (`pnpm test:windows-process-tree`) proves the
  host kills a tree whose middle process already exited. The packaged smoke checks that no JobHost
  process is left after it stops the packaged daemon. A packaged-app run that starts a real provider
  session and then cancels it is **not verified** by any automated check yet.

## Active-session limits

The daemon admits at most 4 active sessions in total and 2 per provider
(`ACTIVE_SESSION_LIMITS` in `apps/daemon/src/active-session-limiter.ts`). A session over either cap
is refused with HTTP 409 and `code: "active_session_limit"`, which names the scope and the current
counts. The limiter is created in memory by `main()` in `apps/daemon/src/index.ts`, so counts start
from zero on every daemon start. Interrupted sessions from a previous run are history, not running
work. Whether the UI offers a specific recovery action for the 409 is **not verified** here.

## Downgrade

Installing an older build over a newer one keeps `userData` as it is.

- **Daemon state: safe.** If `agentdock-state` was written by a newer schema, the older daemon
  detects it in a read-only preflight, logs an error, runs on the in-memory v1 store, mounts no v2
  routes (`/health` reports `supportedProtocolVersions: [1]`) and leaves the state byte-identical.
  Pinned by `apps/daemon/test/index.downgrade.test.ts`. A fresh start of the newer build finds the
  state intact.
- **Workspace and vacancy-engine databases: no guard.** drizzle only compares the newest applied
  migration time with the migration files it has. An older build that finds a newer database applies
  nothing and raises no error. Whether the older code then reads and writes the newer schema
  correctly depends on what the newer migrations changed. That is **not verified** and there are no
  down-migrations in the repository. Before moving to an older build, copy `workspace.db`,
  `application-artifacts/` and `vacancy-engine/config/candidate-profile-v1.json` (backup list in
  [troubleshooting.md](troubleshooting.md)). The vacancy-engine database holds public data and can
  be rebuilt.

## Rollback of a release

1. Close the app. Back up the three items above.
2. Uninstall (user data stays) or install the previous installer over the current one.
3. Launch once and check Settings, saved jobs and applications.
4. If the previous build rejects or misreads `workspace.db`, close the app and restore the backup
   taken in step 1 from before the newer build first ran, if you have one. Otherwise open an issue
   with the `agentdock-state/sessions-v1/quarantine/` contents and the log.
5. Never delete `agentdock-state/`. See the rollback runbook for why.

Issue #127 states the intended rollback as "remove only the additive AgentDock native/runtime
resources and force legacy transports, preserving local resources and retained v2 state". There is
no switch in the app that forces legacy transports. That path is **not verified** and is not offered
here as a procedure. Rolling back means installing an earlier build, as above.
