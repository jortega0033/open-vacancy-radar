/**
 * The `window.applicationQueue` wire contract (#200), mirroring `agent-workspace-types.ts`'s role
 * for the AI workspace: declared here, implemented by `preload.ts`, re-exported by
 * `src/window.d.ts`. Type-only, so nothing here is emitted into the renderer bundle.
 *
 * Every shape is intentionally content-free, matching the daemon's own
 * `application-queue-store.ts`: an `attemptId` is the only identifying detail that ever crosses
 * this bridge. The full record of what an attempt actually is lives in `workspace.db`
 * (`electron/workspace/schema.ts`'s `applicationAttempts` table, #198), reachable through the
 * existing `workspace:*` bridge, not this one.
 */

export type ApplicationQueueEntryState = 'queued' | 'active' | 'paused' | 'cancelled' | 'done' | 'failed';

export interface ApplicationQueueEntry {
  attemptId: string;
  state: ApplicationQueueEntryState;
  /** ISO-8601 */
  queuedAt: string;
  /** ISO-8601 */
  updatedAt: string;
}

export interface ApplicationQueueLease {
  leaseId: string;
  attemptId: string;
  /** ISO-8601 */
  acquiredAt: string;
}

export interface ApplicationQueueStatus {
  entries: ApplicationQueueEntry[];
  lease: ApplicationQueueLease | null;
}

export type ApplicationQueueEventType =
  | 'enqueued'
  | 'lease_acquired'
  | 'paused'
  | 'resumed'
  | 'skipped'
  | 'cancelled'
  | 'released';

export interface ApplicationQueueEvent {
  seq: number;
  /** ISO-8601 */
  at: string;
  type: ApplicationQueueEventType;
  attemptId: string;
}

export interface ApplicationQueueBridge {
  enqueue(attemptId: string): Promise<ApplicationQueueEntry>;
  pause(attemptId: string): Promise<ApplicationQueueEntry>;
  resume(attemptId: string): Promise<ApplicationQueueEntry>;
  skip(attemptId: string): Promise<ApplicationQueueEntry>;
  cancel(attemptId: string): Promise<ApplicationQueueEntry>;
  getStatus(): Promise<ApplicationQueueStatus>;
  /** Subscribes to live queue events. Returns an unsubscribe function, matching
   * `agentWorkspace.onActivity`'s own contract. */
  onActivity(callback: (event: ApplicationQueueEvent) => void): () => void;
}
