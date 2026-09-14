import type { Logger } from '@agent-dock/agent-runtime';
import { AttachmentStore } from './attachment-store.js';
import { resolveStateDirectory } from './state-directory.js';

/**
 * Opens the ADI-29 attachment store, or returns `undefined` to run without one.
 *
 * Mirrors `openDurableStore`'s own shape and reasoning: lives in its own module so it is testable
 * without importing `index.ts` (which runs `main()` as a side effect), and any failure to open --
 * a permissions problem, an unreadable state root -- degrades rather than blocks startup. Unlike
 * `SessionLineageStore`, this store keeps no cross-version on-disk schema to preflight, so there is
 * only the one failure class to handle.
 *
 * `SessionManager` already treats its `attachments` collaborator as fully optional (ADI-29): when
 * this returns `undefined`, `tool.completed` results simply never get an attachment, exactly as if
 * this feature did not exist for that run.
 */
export function openAttachmentStore(appId: string, logger: Logger): AttachmentStore | undefined {
  try {
    const stateRoot = resolveStateDirectory({ appId });
    const store = new AttachmentStore({ stateRoot, logger });
    logger.info('attachment store ready', { stateRoot });
    return store;
  } catch (err) {
    logger.error('could not open the attachment store; large tool results will not be retrievable', {
      message: err instanceof Error ? err.message : String(err),
    });
    return undefined;
  }
}
