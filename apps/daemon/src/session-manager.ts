import { randomUUID } from 'node:crypto';
import type { AgentEvent, AgentEventEnvelope, AgentSession, ProviderId } from '@agent-dock/shared';
import type { Logger, ProviderRegistry, ProviderSessionHandle } from '@agent-dock/agent-runtime';
import { MemorySessionStore, type SessionStore } from './session-store.js';

/**
 * Live, non-persistable state for one session: its process handle and buffered event history.
 * Kept out of SessionStore; see session-store.ts for why. Events are stored as the
 * protocol's public `AgentEventEnvelope` (event + sequence + timestamp), stamped once here so
 * every subscriber (live or replayed) sees the same sequence and timestamp for an event.
 */
interface RuntimeState {
  handle: ProviderSessionHandle;
  events: AgentEventEnvelope[];
  listeners: Set<(index: number, event: AgentEventEnvelope) => void>;
  /**
   * Per-session monotonic counter for `AgentEventEnvelope.sequence`. Deliberately independent of
   * `events.length`: once the history cap is reached, `events` stops growing but this keeps
   * incrementing, so sequence numbers stay monotonic and live delivery never depends on how much
   * of the buffer is retained (AD-01; see the cap-guard note in `consume()` below).
   */
  nextSequence: number;
  /**
   * Resolves once `consume()` has drained this session's terminal event. At that point, the underlying
   * provider process has actually exited, not merely been asked to. `cancelAll()` awaits these
   * (with a bound) so daemon shutdown doesn't return before child processes are confirmed gone
   * (AD-12).
   */
  done: Promise<void>;
}

const MAX_STORED_EVENTS_PER_SESSION = 5_000;

/**
 * Bounds the retained runtime state (event history and listener set) for terminal sessions.
 * Without this, a long-lived
 * daemon whose client never calls DELETE accumulates one RuntimeState per session for its entire
 * lifetime, unbounded (AD-11). Eviction is FIFO by completion order: the daemon is single-user
 * and local, so a fixed bound is sufficient. This is not a cache-replacement policy.
 */
const MAX_RETAINED_COMPLETED_SESSIONS = 50;

/**
 * Coordinates the session lifecycle: creates sessions through the provider registry, consumes their
 * normalized event stream, and keeps `AgentSession` records up to date in a `SessionStore`.
 * `MemorySessionStore` is the current default and only implementation; see session-store.ts.
 */
export class SessionManager {
  private readonly runtime = new Map<string, RuntimeState>();
  /** FIFO of session ids in terminal-state order. See `MAX_RETAINED_COMPLETED_SESSIONS`. */
  private readonly completedOrder: string[] = [];

  constructor(
    private readonly registry: ProviderRegistry,
    private readonly logger: Logger,
    private readonly store: SessionStore = new MemorySessionStore(),
  ) {}

  create(provider: ProviderId, cwd: string, prompt: string, resumeProviderSessionId?: string, model?: string): AgentSession {
    const providerImpl = this.registry.get(provider);
    if (!providerImpl) {
      throw new Error(`No provider registered for id: ${provider}.`);
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
    this.store.create(session);

    const handle = providerImpl.startSession({ sessionId: id, cwd, prompt, resumeProviderSessionId, model });
    const runtimeEntry: RuntimeState = { handle, events: [], listeners: new Set(), nextSequence: 0, done: Promise.resolve() };
    this.runtime.set(id, runtimeEntry);
    runtimeEntry.done = this.consume(id, handle);

    this.logger.info('session created', { sessionId: id, provider, resumed: !!resumeProviderSessionId });
    return session;
  }

  private async consume(id: string, handle: ProviderSessionHandle): Promise<void> {
    const runtime = this.runtime.get(id);
    if (!runtime) return;

    this.mutateSession(id, (session) => {
      session.status = 'running';
    });

    for await (const event of handle.events) {
      this.mutateSession(id, (session) => this.applyStatusTransition(session, event));

      // AD-01 fix: listeners are notified for every event. The cap below only
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
      for (const listener of runtime.listeners) listener(sequence, envelope);
    }

    // The loop only exits after the provider's terminal event closed its channel (exactly one,
    // always last; see run-session.ts), so reaching here means the session is now terminal.
    // Track it for bounded retention (AD-11) rather than keeping every RuntimeState forever.
    this.completedOrder.push(id);
    this.evictOldestCompletedIfOverCap();
  }

  private evictOldestCompletedIfOverCap(): void {
    while (this.completedOrder.length > MAX_RETAINED_COMPLETED_SESSIONS) {
      const staleId = this.completedOrder.shift();
      if (staleId === undefined) break;
      // Already removed through remove()/DELETE. Drop the stale FIFO entry.
      if (!this.runtime.has(staleId)) continue;
      this.runtime.delete(staleId);
      this.store.delete(staleId);
    }
  }

  /** Reads the authoritative record from the store, applies `fn`, and writes it back. */
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

  /** `false` for an unknown session and for one that is already terminal (AD-11). Cancelling a
   * finished session is not a success, even though the previous version reported it as one. */
  async cancel(id: string): Promise<boolean> {
    const session = this.store.get(id);
    if (!session || (session.status !== 'starting' && session.status !== 'running')) return false;
    const runtime = this.runtime.get(id);
    if (!runtime) return false;
    await runtime.handle.cancel();
    return true;
  }

  async remove(id: string): Promise<boolean> {
    const session = this.store.get(id);
    if (!session) return false;
    const runtime = this.runtime.get(id);
    if ((session.status === 'starting' || session.status === 'running') && runtime) {
      await runtime.handle.cancel();
    }
    this.runtime.delete(id);
    this.store.delete(id);
    const orderIndex = this.completedOrder.indexOf(id);
    if (orderIndex !== -1) this.completedOrder.splice(orderIndex, 1);
    return true;
  }

  /**
   * Cancels every in-flight session and waits for their processes to exit, up to a fixed limit.
   * Called on daemon shutdown to avoid orphaned CLI processes. `handle.cancel()` only *initiates*
   * termination (fires SIGTERM / taskkill and returns); without the bounded wait here, the daemon
   * could call `process.exit(0)` while a child is still mid-teardown (AD-12). If a child ignores
   * termination entirely, this still returns after `timeoutMs` rather than hanging shutdown
   * forever. The process-level SIGKILL escalation in spawnProcess ultimately reaps it.
   */
  async cancelAll(timeoutMs = 5_000): Promise<void> {
    const activeRuntimes = this.store
      .list()
      .filter((session) => session.status === 'starting' || session.status === 'running')
      .map((session) => this.runtime.get(session.id))
      .filter((runtime): runtime is RuntimeState => !!runtime);

    await Promise.all(activeRuntimes.map((runtime) => runtime.handle.cancel()));

    await Promise.race([
      Promise.all(activeRuntimes.map((runtime) => runtime.done)),
      new Promise<void>((resolve) => setTimeout(resolve, timeoutMs)),
    ]);
  }
}
