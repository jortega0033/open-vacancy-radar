import type { Logger } from '@agent-dock/agent-runtime';
import { ApplicationQueueStore } from './application-queue-store.js';
import { resolveStateDirectory } from './state-directory.js';

/**
 * Opens the #200 application queue store, or returns `undefined` to run without it.
 *
 * Mirrors `openDurableStore`'s shape and reasoning: constructing the store here, before
 * `buildServer`/`listen`, makes "the queue's own state is loaded before the daemon accepts new
 * work" structural rather than an ordering convention a future edit could break. Any failure to
 * open it (a permissions problem, an unreadable state root) degrades to running without the
 * feature rather than refusing to start the whole daemon -- a local coding daemon that cannot track
 * an application queue is degraded, not broken, and every other route still works.
 */
export function openApplicationQueueStore(appId: string, logger: Logger): ApplicationQueueStore | undefined {
  try {
    // Same reasoning as `openDurableStore`: no `reservedPaths` here, because the daemon cannot
    // resolve Electron's `userData` path. What actually keeps this store separate from
    // `workspace.db` is `AGENT_DOCK_STATE_DIR` (set by `apps/desktop/electron/main.ts`) plus this
    // store never holding SQLite or any dependency that could open one.
    const stateRoot = resolveStateDirectory({ appId });
    return new ApplicationQueueStore({ stateRoot, logger });
  } catch (err) {
    logger.error('could not open the application queue store; running without it', {
      message: err instanceof Error ? err.message : String(err),
    });
    return undefined;
  }
}
