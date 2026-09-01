import type { Logger } from '@agent-dock/agent-runtime';
import { SessionLineageStore, UnsupportedStateSchemaVersionError } from './session-lineage-store.js';
import { resolveStateDirectory } from './state-directory.js';

/**
 * Opens the v2 durable session store, or returns `undefined` to run v1-only.
 *
 * Lives in its own module rather than inside `index.ts` so it can be exercised directly: importing
 * `index.ts` executes `main()` as a side effect, which would mean a test of the downgrade path also
 * bound a port and wrote a discovery file. This is the exact function `index.ts` calls.
 *
 * ## Why constructing this before `buildServer`/`listen` is the design
 *
 * `SessionLineageStore`'s constructor performs crash recovery synchronously (see its docstring), so
 * calling it here -- before the server object exists, let alone binds a port -- makes "recovery
 * finishes before the daemon accepts new work" a structural fact rather than an ordering convention
 * a future edit could break. There is no interleaving to get wrong.
 *
 * ## Why a future schema version is not fatal
 *
 * A user who runs a newer build and then rolls back must not end up with a daemon that refuses to
 * start. `UnsupportedStateSchemaVersionError` is therefore logged and swallowed: the daemon
 * continues on the in-memory store, no v2 options reach `buildServer` (so no v2 route is registered
 * and `/health` reports `[1]`), and -- critically -- the newer state is left byte-for-byte untouched
 * on disk so the newer build still finds it intact. See docs/rollback-runbook-agentdock-v2.md.
 *
 * Any *other* failure to open the store (a permissions problem, an unreadable state root) is
 * treated the same way for the same reason: a local coding daemon that cannot write its history is
 * degraded, not broken, and refusing to launch would be a worse outcome for the user than losing v2
 * features for that run.
 */
export function openDurableStore(appId: string, logger: Logger): SessionLineageStore | undefined {
  try {
    // The reserved-paths guard is left empty here on purpose. The daemon has no visibility into
    // where the desktop app keeps `workspace.db` / `vacancy-engine.db`: those live under Electron's
    // `app.getPath('userData')`, which is an Electron-side concept this process cannot resolve.
    // What actually keeps the two apart is the desktop app setting AGENT_DOCK_STATE_DIR to a
    // dedicated subdirectory (see apps/desktop/electron/main.ts), plus `resolveStateDirectory`
    // enforcing the guard for any caller that *can* name those paths. Inventing a check against
    // guessed paths here would look like protection while verifying nothing.
    const stateRoot = resolveStateDirectory({ appId });
    const store = new SessionLineageStore({ stateRoot, logger });
    logger.info('durable session store ready', { stateRoot, ...store.stats() });
    return store;
  } catch (err) {
    if (err instanceof UnsupportedStateSchemaVersionError) {
      logger.error('durable session state was written by a newer build; running v1-only', {
        foundVersion: err.foundVersion,
        path: err.path,
      });
      return undefined;
    }
    logger.error('could not open the durable session store; running v1-only', {
      message: err instanceof Error ? err.message : String(err),
    });
    return undefined;
  }
}
