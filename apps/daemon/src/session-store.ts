import type { AgentSession } from '@agent-dock/shared';

/**
 * Where SessionManager keeps `AgentSession` records: deliberately synchronous, since the only
 * implementation (`MemorySessionStore`) is. A future persistent store (e.g. SQLite) would likely
 * need this interface, and every call site in SessionManager, to become async; that's a real,
 * larger change intentionally left for when it's actually needed rather than half-implemented
 * (an untested `Promise<void>` union here today would just be a place for a future store to
 * silently break the current synchronous call sites).
 *
 * Scope is deliberately narrow: only the `AgentSession` record. A session's live process handle
 * (an `AsyncGenerator` plus a `cancel()` closure) isn't something you can "store" at all, and its
 * buffered event history is kept as separate runtime-only state in SessionManager: see
 * docs/daemon.md#session-lifecycle-sessionmanager-sessionstore for why persisting replayable event history isn't part of
 * what this interface owns.
 */
export interface SessionStore {
  create(session: AgentSession): void;
  get(id: string): AgentSession | undefined;
  update(id: string, session: AgentSession): void;
  delete(id: string): void;
  list(): AgentSession[];
}

/**
 * The only `SessionStore` implementation, and the daemon's default: the live v1 `AgentSession` view
 * is fully in-memory.
 *
 * ADI-05 did **not** replace this with a persistent implementation, deliberately. Durability landed
 * as a second, parallel store (`session-lineage-store.ts`) rather than as a `SessionStore`, because
 * the two answer different questions: this one answers "what is this session doing right now, in
 * v1's vocabulary", and the durable one answers "what happened, and is it safe to run it again".
 * Folding them together would have meant either making this interface async (touching every v1 call
 * site) or making the durable store speak v1's status vocabulary, which has no way to express
 * `interrupted`.
 *
 * When a durable store is active, `SessionManager` seeds this store at startup with the v1
 * projection of every recovered record, so a v1 client asking about a session from before the
 * restart gets an answer rather than a 404.
 */
export class MemorySessionStore implements SessionStore {
  private readonly sessions = new Map<string, AgentSession>();

  create(session: AgentSession): void {
    this.sessions.set(session.id, session);
  }

  get(id: string): AgentSession | undefined {
    return this.sessions.get(id);
  }

  update(id: string, session: AgentSession): void {
    this.sessions.set(id, session);
  }

  delete(id: string): void {
    this.sessions.delete(id);
  }

  list(): AgentSession[] {
    return [...this.sessions.values()];
  }
}
