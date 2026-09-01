import { randomUUID } from 'node:crypto';
import type { AgentEvent, AgentEventEnvelope, AgentSession, ProviderId, TerminalReasonV2 } from '@agent-dock/shared';
import type { Logger, ProviderRegistry, ProviderSessionHandle, SessionLaunchProbe } from '@agent-dock/agent-runtime';
import { AcceptedWorkLatch } from '@agent-dock/agent-runtime';
import { MemorySessionStore, type SessionStore } from './session-store.js';
import { ActiveSessionLimiter } from './active-session-limiter.js';
import { toV1Session } from './persisted-session-schema.js';
import type { SessionLineageStore } from './session-lineage-store.js';

/**
 * Live, non-persistable state for one session: its process handle and buffered event history.
 * Deliberately kept out of SessionStore: see session-store.ts for why. Events are stored as the
 * protocol's public `AgentEventEnvelope` (event + sequence + timestamp), stamped once here so
 * every subscriber (live or replayed) sees the same sequence/timestamp for the same event.
 */
interface RuntimeState {
  handle: ProviderSessionHandle;
  events: AgentEventEnvelope[];
  listeners: Set<(index: number, event: AgentEventEnvelope) => void>;
  /**
   * Per-session monotonic counter for `AgentEventEnvelope.sequence`. Deliberately independent of
   * `events.length`: once the history cap is reached, `events` stops growing but this keeps
   * incrementing, so sequence numbers stay monotonic and live delivery never depends on how much
   * of the buffer is retained (AD-01: see the cap-guard note in `consume()` below).
   */
  nextSequence: number;
  /**
   * Resolves once `consume()` has drained this session's terminal event, i.e. the underlying
   * provider process has actually exited, not merely been asked to. `cancelAll()` awaits these
   * (with a bound) so daemon shutdown doesn't return before child processes are confirmed gone
   * (AD-12).
   */
  done: Promise<void>;
}

const MAX_STORED_EVENTS_PER_SESSION = 5_000;

/**
 * Bounds how many terminal (completed/failed/cancelled) sessions' runtime state (event history
 * and listener set) stays retained for late-subscriber replay. Without this, a long-lived
 * daemon whose client never calls DELETE accumulates one RuntimeState per session for its entire
 * lifetime, unbounded (AD-11). Eviction is FIFO by completion order: the daemon is single-user
 * and local, so a simple bound is enough. This is not trying to be a cache-replacement policy.
 */
const MAX_RETAINED_COMPLETED_SESSIONS = 50;

/** How a v1 terminal event maps onto the durable store's v2 terminal vocabulary. */
const DURABLE_TERMINAL: Readonly<
  Record<string, { status: 'completed' | 'failed' | 'cancelled'; reason: TerminalReasonV2 }>
> = Object.freeze({
  'session.completed': { status: 'completed', reason: 'provider_completed' },
  'session.failed': { status: 'failed', reason: 'provider_error' },
  'session.cancelled': { status: 'cancelled', reason: 'cancelled_by_client' },
});

/**
 * Orchestrates session lifecycle: creates sessions via the provider registry, consumes their
 * normalized event stream, and keeps `AgentSession` records up to date in a `SessionStore` (see
 * session-store.ts, `MemorySessionStore` by default).
 *
 * ADI-05 adds two collaborators, both optional so every existing call site and test keeps working
 * unchanged:
 *
 * - an `ActiveSessionLimiter`, which admits or refuses a session **before** anything irreversible
 *   happens (see `create()`);
 * - an optional `SessionLineageStore`, the crash-safe on-disk record. When it is absent the daemon
 *   behaves exactly as it did before this ticket: memory-only, v1-only.
 */
export class SessionManager {
  private readonly runtime = new Map<string, RuntimeState>();
  /** FIFO of session ids in the order they reached a terminal state: see `MAX_RETAINED_COMPLETED_SESSIONS`. */
  private readonly completedOrder: string[] = [];

  constructor(
    private readonly registry: ProviderRegistry,
    private readonly logger: Logger,
    private readonly store: SessionStore = new MemorySessionStore(),
    private readonly limiter: ActiveSessionLimiter = new ActiveSessionLimiter(),
    private readonly durable?: SessionLineageStore,
  ) {
    // Sessions recovered from disk are presented to v1 clients as `failed` with an explanatory
    // error string (see `toV1Session`), so a client that was mid-session when the daemon restarted
    // gets a definite answer from `GET /sessions/:id` instead of a 404 that looks like the session
    // never existed. Every recovered record is already terminal, so none of them holds a limiter
    // reservation and the full active-session budget is available immediately.
    if (this.durable) {
      for (const record of this.durable.allRecords()) this.store.create(toV1Session(record));
    }
  }

  /** The admission gate this manager reserves against. Exposed for the v2 capacity read view. */
  get activeSessionLimiter(): ActiveSessionLimiter {
    return this.limiter;
  }

  /**
   * Creates a session, or throws.
   *
   * **This method contains no `await`, deliberately.** Everything from the limiter reservation to
   * handing the provider its start options runs in one uninterrupted turn of the event loop, which
   * is what makes the reservation un-raceable: no second request can observe the counters between
   * the check and the increment. Adding an `await` anywhere above `startSession` -- including one
   * hidden inside a helper -- reintroduces exactly the over-admission bug the limiter exists to
   * prevent. `apps/daemon/test/server.limits.test.ts` fires genuinely concurrent requests through a
   * provider parked on a deferred to keep this honest.
   *
   * Order matters and is fixed:
   *
   * 1. resolve the provider (unchanged v1 behavior: an unknown provider is a caller error);
   * 2. mint the session id;
   * 3. **reserve** -- this throws `ActiveSessionLimitError` before any record is written and before
   *    any process is spawned, so a refused request leaves no trace at all;
   * 4. write the durable record, then start the provider. A throw from either releases the
   *    reservation and, if the record made it to disk, finalizes it as `launch_failed`.
   */
  create(
    provider: ProviderId,
    cwd: string,
    prompt: string,
    resumeProviderSessionId?: string,
    model?: string,
    protocolVersion: 1 | 2 = 1,
  ): AgentSession {
    const providerImpl = this.registry.get(provider);
    if (!providerImpl) {
      throw new Error(`no provider registered for id: ${provider}`);
    }

    const id = randomUUID();
    const session: AgentSession = {
      id,
      provider,
      cwd,
      prompt,
      model,
      status: 'starting',
      startedAt: new Date().toISOString(),
    };

    // The atomic reservation point. Nothing before this can fail in a way that leaks a hold, and
    // nothing after it can proceed without one.
    this.limiter.reserve(provider, id);

    let recorded = false;
    let handle: ProviderSessionHandle;
    try {
      if (this.durable) {
        this.durable.create(session, {
          protocolVersion,
          // The honest synchronous scope. `provider.detect()` cannot be awaited here (see this
          // method's docstring), so the fields it would supply are refined below, off the critical
          // path, and default to the fail-closed 'unknown' until then.
          scope: { authenticated: 'unknown', platform: process.platform, accountEvidence: 'cli_owned' },
          ...(resumeProviderSessionId === undefined ? {} : { resumeProviderSessionId }),
        });
        recorded = true;
      }

      this.store.create(session);
      handle = providerImpl.startSession({
        sessionId: id,
        cwd,
        prompt,
        resumeProviderSessionId,
        model,
        ...(this.durable ? { launchProbe: this.buildLaunchProbe(id) } : {}),
      });
    } catch (err) {
      this.limiter.release(id);
      // The record, if it exists, describes a session that never got a provider process. Closing it
      // out as `launch_failed` (and never touching `acceptedWork`, which stays at the fail-closed
      // 'unknown' it was created with) is what stops it being recovered as `interrupted` on the next
      // startup, which would imply a process had been running.
      if (recorded) this.durable?.finalize(id, 'failed', 'launch_failed');
      this.store.delete(id);
      throw err;
    }

    const runtimeEntry: RuntimeState = { handle, events: [], listeners: new Set(), nextSequence: 0, done: Promise.resolve() };
    this.runtime.set(id, runtimeEntry);
    // `.catch` rather than a bare assignment: a provider generator that throws instead of ending
    // with a terminal event would otherwise make `done` a rejected promise nobody awaits until
    // `cancelAll()` does -- surfacing first as an unhandled rejection, and then as a rejection out
    // of the daemon's own shutdown handler, skipping the MCP/server/discovery-file cleanup that
    // follows it. The reservation and the retention bookkeeping are already released by `consume`'s
    // `finally`, so there is nothing left to do here but record why the stream ended badly.
    runtimeEntry.done = this.consume(id, handle).catch((error: unknown) => {
      this.logger.error('session event stream ended with an error', { sessionId: id, error });
    });

    // Deliberately after the session is fully live: this is a refinement of an already-written
    // record, never a precondition for starting one. It is also the only `detect()` call this path
    // makes, and only when a durable store is active, so v1-only operation spawns no extra probes.
    if (this.durable) this.refineLaunchScope(id, provider);

    this.logger.info('session created', { sessionId: id, provider, resumed: !!resumeProviderSessionId });
    return session;
  }

  /**
   * The accepted-work observation seam (ADI-04's `SessionLaunchProbe`), wired to the durable store.
   *
   * The two callbacks encode the same boundary the supervisor does, for the same reason: a CLI that
   * receives its prompt in argv (`viaStdin: false`) has been handed the work atomically by process
   * creation, while a CLI that reads stdin has provably received nothing until the write happens.
   * Both end at `'accepted'`; only the moment differs. See
   * docs/adr-agentdock-v2-provenance.md#the-three-way-scope-split.
   */
  private buildLaunchProbe(id: string): SessionLaunchProbe {
    const latch = new AcceptedWorkLatch();
    void latch.accepted.then(() => {
      this.durable?.markAcceptedWork(id, 'accepted');
    });
    return {
      onSpawnAttempt: (evidence) => {
        if (!evidence.viaStdin) latch.observe('accepted');
      },
      onPromptDelivered: () => {
        latch.observe('accepted');
      },
    };
  }

  private refineLaunchScope(id: string, provider: ProviderId): void {
    const providerImpl = this.registry.get(provider);
    if (!providerImpl) return;
    void providerImpl
      .detect()
      .then((status) => {
        this.durable?.setScope(id, {
          ...(status.executablePath === undefined ? {} : { executablePath: status.executablePath }),
          ...(status.version === undefined ? {} : { providerVersion: status.version }),
          authenticated: status.authenticated,
          platform: process.platform,
          accountEvidence: 'cli_owned',
        });
      })
      .catch((error: unknown) => {
        this.logger.warn('could not refine a session launch scope', { sessionId: id, error });
      });
  }

  private async consume(id: string, handle: ProviderSessionHandle): Promise<void> {
    const runtime = this.runtime.get(id);
    if (!runtime) {
      // No runtime state means create() never registered this id, so no reservation exists to
      // release either. Releasing anyway would be harmless (release is idempotent) but misleading.
      return;
    }

    this.mutateSession(id, (session) => {
      session.status = 'running';
    });

    try {
      for await (const event of handle.events) {
        this.mutateSession(id, (session) => this.applyStatusTransition(session, event));

        // AD-01 fix: listeners are notified unconditionally, every time: the cap below only
        // controls how much history is *retained for replay*. Before this fix, listener
        // notification lived inside the same `if` as the buffer push, so once history filled up,
        // live subscribers silently stopped receiving anything at all, including the terminal
        // event. Every SSE stream past that point hung forever. `sequence` comes from a counter
        // that keeps incrementing past the cap, never from `events.length`, so it stays monotonic
        // and consistent between what a live subscriber sees and what a replay subscriber sees for
        // the events that are still buffered.
        const sequence = runtime.nextSequence++;
        const envelope: AgentEventEnvelope = { ...event, sequence, timestamp: new Date().toISOString() };
        if (runtime.events.length < MAX_STORED_EVENTS_PER_SESSION) {
          runtime.events.push(envelope);
        } else {
          this.logger.warn('session event history full; further events will not be replayable', { sessionId: id });
        }
        this.persistEvent(id, envelope);
        for (const listener of runtime.listeners) listener(sequence, envelope);
      }
    } finally {
      // The SINGLE release site, and it is a `finally` on purpose. Every way a session can stop
      // being active passes through here: the terminal event closing the channel (completed,
      // failed, cancelled), the generator throwing, and a consumer abandoning the stream. A release
      // placed on the completion path alone would leak a reservation on the other two, and a leaked
      // reservation never expires -- it permanently shrinks the daemon's capacity until restart.
      this.limiter.release(id);

      // The loop only exits after the provider's terminal event closed its channel (exactly one,
      // always last: see run-session.ts), so reaching here means the session is now terminal.
      // Track it for bounded retention (AD-11) rather than keeping every RuntimeState forever.
      this.completedOrder.push(id);
      this.evictOldestCompletedIfOverCap();
    }
  }

  /**
   * Appends the redacted form of one event, and mirrors its terminal state, to the durable store.
   *
   * Failures are logged and swallowed, deliberately. Persistence is an observer of the session, not
   * a participant in it: a full disk, a revoked permission, or a state directory deleted underneath
   * a running daemon must degrade the *history* and nothing else. Letting the write throw here would
   * escape `consume()`'s `for await` as an unhandled rejection and tear down a live provider
   * session -- trading a lost record for a lost session, which is strictly the worse outcome, and
   * for the user the more surprising one.
   */
  private persistEvent(id: string, envelope: AgentEventEnvelope): void {
    if (!this.durable) return;
    try {
      this.durable.appendEvent(id, envelope);

      if (
        (envelope.type === 'session.started' || envelope.type === 'session.completed') &&
        envelope.providerSessionId
      ) {
        this.durable.setProviderSessionId(id, envelope.providerSessionId);
      }
      const terminal = DURABLE_TERMINAL[envelope.type];
      if (terminal) this.durable.finalize(id, terminal.status, terminal.reason);
    } catch (error: unknown) {
      this.logger.warn('could not persist a session event; the session itself is unaffected', {
        sessionId: id,
        type: envelope.type,
        error,
      });
    }
  }

  private evictOldestCompletedIfOverCap(): void {
    while (this.completedOrder.length > MAX_RETAINED_COMPLETED_SESSIONS) {
      const staleId = this.completedOrder.shift();
      if (staleId === undefined) break;
      // Already removed via remove()/DELETE. Nothing left to evict, just drop the stale FIFO entry.
      if (!this.runtime.has(staleId)) continue;
      this.runtime.delete(staleId);
      this.store.delete(staleId);
    }
  }

  /** Reads the current record from the store, applies `fn`, writes it back: the store is the source of truth, never a mutated-in-place reference held elsewhere. */
  private mutateSession(id: string, fn: (session: AgentSession) => void): void {
    const session = this.store.get(id);
    if (!session) return;
    fn(session);
    this.store.update(id, session);
  }

  private applyStatusTransition(session: AgentSession, event: AgentEvent): void {
    switch (event.type) {
      case 'session.completed':
        session.status = 'completed';
        session.completedAt = new Date().toISOString();
        session.providerSessionId = event.providerSessionId ?? session.providerSessionId;
        break;
      case 'session.failed':
        session.status = 'failed';
        session.completedAt = new Date().toISOString();
        session.error = event.message;
        break;
      case 'session.cancelled':
        session.status = 'cancelled';
        session.completedAt = new Date().toISOString();
        break;
      default:
        break;
    }
  }

  get(id: string): AgentSession | undefined {
    return this.store.get(id);
  }

  list(): AgentSession[] {
    return this.store.list();
  }

  /** Replays stored events from `sinceIndex` onward, then delivers live events as they arrive. */
  subscribe(
    id: string,
    sinceIndex: number,
    listener: (index: number, event: AgentEventEnvelope) => void,
  ): (() => void) | undefined {
    const runtime = this.runtime.get(id);
    if (!runtime) return undefined;

    for (let i = sinceIndex; i < runtime.events.length; i++) {
      listener(i, runtime.events[i] as AgentEventEnvelope);
    }

    runtime.listeners.add(listener);
    return () => runtime.listeners.delete(listener);
  }

  /** `false` for an unknown session AND for one that's already terminal (AD-11). Cancelling a
   * finished session is not a success, even though the previous version reported it as one. */
  async cancel(id: string): Promise<boolean> {
    const session = this.store.get(id);
    if (!session || (session.status !== 'starting' && session.status !== 'running')) return false;
    const runtime = this.runtime.get(id);
    if (!runtime) return false;
    await this.cancelRuntime(id, runtime);
    return true;
  }

  async remove(id: string): Promise<boolean> {
    const session = this.store.get(id);
    if (!session) return false;
    const runtime = this.runtime.get(id);
    if ((session.status === 'starting' || session.status === 'running') && runtime) {
      await this.cancelRuntime(id, runtime);
    }
    this.runtime.delete(id);
    this.store.delete(id);
    const orderIndex = this.completedOrder.indexOf(id);
    if (orderIndex !== -1) this.completedOrder.splice(orderIndex, 1);
    // The durable record is deliberately NOT deleted here. DELETE /sessions/:id removes a session
    // from the live, in-memory view; the durable store is governed by its own retention policy
    // (documented in docs/privacy.md), and letting an HTTP call erase an accepted-work record would
    // reopen the exact gap the store exists to close.
    return true;
  }

  /**
   * `handle.cancel()` can reject (e.g. a process-tree reap-confirmation timeout) rather than always
   * resolving once it merely initiated termination. The cancel signal was still sent either way, so
   * a caller here (an HTTP route, `remove()`, `cancelAll()`) must not see that as the request itself
   * having failed -- only that reap couldn't be confirmed within the budget, which is worth logging,
   * not surfacing as a 500.
   */
  private async cancelRuntime(id: string, runtime: RuntimeState): Promise<void> {
    await runtime.handle.cancel().catch((error: unknown) => {
      this.logger.warn('session cancel did not confirm a process-tree reap', { sessionId: id, error });
    });
  }

  /**
   * Cancels every in-flight session and waits (bounded) for their processes to actually exit.
   * Called on daemon shutdown to avoid orphaned CLI processes. `handle.cancel()` only *initiates*
   * termination (fires SIGTERM / taskkill and returns); without the bounded wait here, the daemon
   * could call `process.exit(0)` while a child is still mid-teardown (AD-12). If a child ignores
   * termination entirely, this still returns after `timeoutMs` rather than hanging shutdown
   * forever. The process-level SIGKILL escalation in spawnProcess is what ultimately reaps it.
   *
   * Reservations are released by each session's own `consume()` as it drains its terminal event,
   * never in bulk here: see `ActiveSessionLimiter` for why no `releaseAll()` exists.
   */
  async cancelAll(timeoutMs = 5_000): Promise<void> {
    const active = this.store
      .list()
      .filter((session) => session.status === 'starting' || session.status === 'running')
      .map((session) => ({ id: session.id, runtime: this.runtime.get(session.id) }))
      .filter((entry): entry is { id: string; runtime: RuntimeState } => !!entry.runtime);

    // This method's whole contract is best-effort and bounded -- one session's cancel failing to
    // confirm reap must never stop this from also cancelling every other active session, and must
    // never make the caller (including the daemon's own shutdown handler) see a rejection instead
    // of the documented bounded wait. See `cancelRuntime`.
    await Promise.all(active.map(({ id, runtime }) => this.cancelRuntime(id, runtime)));

    await Promise.race([
      Promise.all(active.map(({ runtime }) => runtime.done)),
      new Promise<void>((resolve) => setTimeout(resolve, timeoutMs)),
    ]);
  }
}
