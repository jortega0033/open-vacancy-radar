import type { Logger } from '@agent-dock/agent-runtime';
import { AuditStore } from './audit-store.js';
import { WorkspaceTrustStore } from './workspace-trust-store.js';
import { resolveStateDirectory } from './state-directory.js';

export interface WorkspaceStores {
  trustStore: WorkspaceTrustStore;
  auditStore: AuditStore;
}

/**
 * Opens the ADI-06 workspace-trust pair, or returns `undefined` to run without workspace routes.
 *
 * Mirrors `open-durable-store.ts` deliberately, including living in its own module so it can be
 * exercised without importing `index.ts` (which runs `main()` as a side effect). Two differences are
 * worth being explicit about:
 *
 * - **The pair is all-or-nothing.** If either store fails to open, neither is returned. A trust
 *   store without an audit store would grant access it could not record; an audit store without a
 *   trust store would record decisions nothing can act on. Half of this feature is not a degraded
 *   version of it, it is the dangerous half.
 * - **Failing to open is a downgrade, not a crash**, for the same reason ADI-05 chose that: a local
 *   coding daemon that cannot write its state should lose features, not refuse to launch. The
 *   consequence here is stricter than losing a read view, though, and worth stating plainly: with no
 *   trust store, `POST /v2/workspaces/...` does not exist, so nothing can be granted at all. The
 *   downgrade path is closed, not open.
 */
export function openWorkspaceStores(appId: string, logger: Logger): WorkspaceStores | undefined {
  let auditStore: AuditStore | undefined;
  try {
    const stateRoot = resolveStateDirectory({ appId });
    const trustStore = new WorkspaceTrustStore({ stateRoot, logger });
    auditStore = new AuditStore({ stateRoot, logger });
    if (auditStore.unhealthy) {
      // The audit store latches unhealthy at construction only when it found a corrupt log it could
      // not even quarantine. Every `append()` would throw, so every trust decision would be denied
      // anyway: not registering the routes says that plainly instead of failing each call.
      logger.error('the workspace audit log is unusable; workspace trust routes are disabled');
      return undefined;
    }
    logger.info('workspace trust stores ready', {
      stateRoot,
      trustedWorkspaces: trustStore.all().filter((record) => record.state === 'trusted').length,
      auditEntries: auditStore.entryCount,
    });
    return { trustStore, auditStore };
  } catch (err) {
    auditStore?.close('the workspace stores failed to open');
    logger.error('could not open the workspace trust stores; workspace trust routes are disabled', {
      message: err instanceof Error ? err.message : String(err),
    });
    return undefined;
  }
}
