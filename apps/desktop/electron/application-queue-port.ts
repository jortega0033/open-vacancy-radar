import type { ApplicationQueueEntryState, ApplicationQueuePort } from './application-pipeline.js';

/**
 * The daemon's application queue as the pipeline consumes it: four HTTP calls to routes the daemon
 * owns, and no queue state of this process's own -- a daemon restart is the daemon's recovery to
 * perform, not this one's to reconstruct.
 *
 * Lives here rather than inline in `main.ts` for one reason: `main.ts` cannot be imported by a test.
 * Loading it boots Electron, spawns the daemon sidecar and opens two SQLite databases (a
 * long-standing architectural gap several test files already record), so anything that stays in it
 * is covered by code review alone. That is exactly how the `release` call below came to spend its
 * whole life ignoring the daemon's answer: a refused release is the single condition under which the
 * queue is still wedged after an abandoned preparation gave its lease back, and it resolved as a
 * success and said nothing. The decidable part is small, so it moves out to where a test can drive
 * it, the same narrow extraction `tick.ts` made for the recurring worker's own untested logic.
 *
 * Everything genuinely Electron-shaped -- authentication, the base URL, the abort timeout -- stays
 * in `main.ts` behind the two injected callbacks below.
 */

/** Every state the daemon's queue entries can be in. Anything else on the wire is treated as no
 * entry at all rather than passed through: this process decides what it is willing to understand. */
const APPLICATION_QUEUE_ENTRY_STATES: readonly ApplicationQueueEntryState[] = [
  'queued',
  'active',
  'paused',
  'cancelled',
  'done',
  'failed',
];

export interface ApplicationQueuePortDeps {
  /** One authenticated request to a daemon route -- `main.ts`'s `daemonFetch`. */
  request(path: string, init: { method: string; body?: unknown }): Promise<Response>;
  /** One authenticated GET returning the parsed body -- `main.ts`'s `daemonGetJson`, which already
   * turns a 404 into `undefined` and refuses to let daemon-authored text cross. */
  getJson(path: string): Promise<Record<string, unknown> | undefined>;
  /** Where a refusal nobody can act on programmatically still gets said out loud. */
  log(message: string, meta?: Record<string, unknown>): void;
}

/**
 * The renderer-facing message for a queue-route refusal, chosen from a closed table by the daemon's
 * machine-readable `code` -- never its `error` text -- matching `daemonRefusal`'s own discipline in
 * `main.ts` for the same reason: a message this process did not write must never reach the renderer
 * verbatim.
 */
export async function applicationQueueRefusal(res: Response, fallback: string): Promise<string> {
  const body = (await res.json().catch(() => ({}))) as { code?: unknown };
  if (body.code === 'application_not_found') return 'no such attempt is in the queue';
  if (body.code === 'invalid_transition') return 'that action cannot be applied to this attempt right now';
  return fallback;
}

export function createApplicationQueuePort(deps: ApplicationQueuePortDeps): ApplicationQueuePort {
  return {
    async enqueue(attemptId: string): Promise<void> {
      const res = await deps.request('/v2/applications', { method: 'POST', body: { attemptId } });
      if (!res.ok) throw new Error(await applicationQueueRefusal(res, 'could not add this attempt to the queue'));
    },

    async acquireLease() {
      const res = await deps.request('/v2/applications/lease/acquire', { method: 'POST' });
      if (!res.ok) return null;
      const body = (await res.json().catch(() => ({}))) as { lease?: unknown };
      const lease = body.lease && typeof body.lease === 'object' ? (body.lease as Record<string, unknown>) : undefined;
      if (!lease || typeof lease.leaseId !== 'string' || typeof lease.attemptId !== 'string') return null;
      return { leaseId: lease.leaseId, attemptId: lease.attemptId };
    },

    /**
     * Hands the daemon's one global lease back, and -- unlike every other caller of a daemon route
     * here -- reports a refusal instead of raising one.
     *
     * Not a throw, deliberately. The worker releases on paths that have already decided what
     * happened to the attempt, including the abandonment path, whose whole purpose is to get the
     * lease back so the queue can move on; turning a refusal there into an exception would replace
     * "the queue may be stuck" with "the tick crashed" and lose the outcome the run had settled on.
     * There is also nothing useful to retry with: the daemon refuses a release exactly when the
     * lease is no longer this caller's to give back, which a second identical call cannot change.
     *
     * But it must not be silent, which is what it was. A daemon that refuses a release while still
     * considering the lease held is the one condition under which the queue stays blocked with no
     * run in flight -- invisible from the app, and cleared only by the daemon's own startup
     * reconciliation (`ApplicationQueueStore#reconcileStaleLeaseOnStartup`), i.e. by a restart.
     * A log line is the whole fix: it is what turns "applications silently stopped preparing" into
     * something a person can actually diagnose.
     */
    async release(leaseId: string, outcome: 'completed' | 'failed' | 'requeue'): Promise<void> {
      const res = await deps.request('/v2/applications/lease/release', { method: 'POST', body: { leaseId, outcome } });
      if (res.ok) return;
      deps.log('the agent runtime refused to take back an application-queue lease; the queue may stay blocked until the app is restarted', {
        leaseId,
        outcome,
        status: res.status,
        reason: await applicationQueueRefusal(res, 'the agent runtime gave no reason it recognises'),
      });
    },

    async entryState(attemptId: string) {
      const body = await deps.getJson(`/v2/applications/${encodeURIComponent(attemptId)}`);
      const entry = body?.entry && typeof body.entry === 'object' ? (body.entry as Record<string, unknown>) : undefined;
      const state = entry?.state;
      if (typeof state !== 'string' || !(APPLICATION_QUEUE_ENTRY_STATES as readonly string[]).includes(state)) return null;
      return state as ApplicationQueueEntryState;
    },
  };
}
