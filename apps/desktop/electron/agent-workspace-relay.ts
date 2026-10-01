import type { AgentEventEnvelope } from '@agent-dock/shared';
import { toActivityEntry } from './agent-activity-sanitize.js';
import type { ActivityPush, AttachResult } from './agent-workspace-types.js';

/**
 * The live-activity relay (ADI-07): one sanitized SSE stream per v2 session id, up to the daemon's
 * own global active-session limit.
 *
 * ## What this replaces, and why the replacement is the point of the ticket
 *
 * main.ts previously held two module-level globals -- `activeSessionId` and `activeStreamAbort` --
 * and `forwardSessionEvents` overwrote both on every new session. That is a **single-slot relay**:
 * starting a second session silently orphaned the first one's abort controller, so cancelling or
 * shutting down reached only whichever session happened to have started last. It is precisely the
 * "concurrency emulated over one active id" shape ADI-07 exists to remove, sitting in main rather
 * than in the renderer.
 *
 * The fix is not to make the single slot smarter. It is to key the state by session id, which is
 * what this class is: a `Map<sessionId, AbortController>` with an idempotent `attach`, a targeted
 * `detach`, and a `detachAll` the shutdown path calls.
 *
 * ## This is additional to `forwardSessionEvents`, not a replacement for it
 *
 * v1's CV and Letters flows still push **raw** envelopes on `daemon:session-event`, and that path
 * is untouched by this ticket -- byte-identical behavior, same channel, same payload. The two
 * mechanisms are parallel because they serve genuinely different consumers: v1's is a one-shot
 * text runner inside the app's own scratch directory, this one is a concurrent, multi-session view
 * of sessions running in the user's real folders, and only the second one has a redaction boundary
 * to enforce.
 *
 * ## Nothing raw crosses
 *
 * Every envelope goes through `toActivityEntry` before it is pushed. The renderer receives
 * `{ sessionId, entry }` (or `{ sessionId, closed }`), never an `AgentEventEnvelope`.
 */

export interface AgentWorkspaceRelayDeps {
  /**
   * The current daemon client, read fresh on every attach rather than captured once: main's
   * `client` is replaced on a daemon restart, and a relay holding the old one would stream from a
   * process that no longer exists.
   */
  client(): SessionEventSource | undefined;
  /** The per-session tool-call alias map. Owned by the caller so history and live agree on aliases. */
  aliasesFor(sessionId: string): Map<string, string>;
  /** Pushes one sanitized message to the renderer. */
  push(message: ActivityPush): void;
  /** Hard ceiling on concurrent attachments. Defaults to the daemon's own global session limit. */
  maxAttachments?: number;
  onEvent?(message: string, meta?: Record<string, unknown>): void;
}

/** The one method this relay needs from `AgentDockClient`, named so tests can supply a fake. */
export interface SessionEventSource {
  sessions: {
    events(
      id: string,
      options?: { signal?: AbortSignal; lastEventId?: string },
    ): AsyncIterable<AgentEventEnvelope>;
  };
}

/**
 * The attachment ceiling.
 *
 * Deliberately the same number as `ACTIVE_SESSION_LIMITS.global` in
 * `apps/daemon/src/active-session-limiter.ts` (4), and deliberately **not imported from it**: the
 * desktop app has no dependency on `apps/daemon`, and a hardcoded 4 here that silently disagreed
 * with the daemon would be worse than one that visibly does. It is a ceiling on this process's own
 * open SSE connections, not a second admission gate -- the daemon remains the authority on how many
 * sessions may run, and this only bounds how many of them main will stream at once.
 */
export const MAX_ACTIVE_RELAYS = 4;

export class AgentWorkspaceRelay {
  readonly #streams = new Map<string, AbortController>();
  readonly #deps: AgentWorkspaceRelayDeps;
  readonly #max: number;

  constructor(deps: AgentWorkspaceRelayDeps) {
    this.#deps = deps;
    this.#max = deps.maxAttachments ?? MAX_ACTIVE_RELAYS;
  }

  get size(): number {
    return this.#streams.size;
  }

  isAttached(sessionId: string): boolean {
    return this.#streams.has(sessionId);
  }

  /**
   * Opens (or re-opens) a live relay for one session.
   *
   * **Idempotent**: re-attaching an id that is already streaming is a no-op that reports success,
   * rather than opening a second SSE connection to the same session and delivering every event
   * twice. The renderer calls this from an effect that can re-run for reasons unrelated to the
   * session (a re-render, a list refresh), so "already attached" is the normal case, not an error.
   *
   * `lastSeq` resumes from the daemon's `Last-Event-ID`, so a reconnect after a dropped stream
   * replays only what this process has not already seen. Re-delivery is still possible (the daemon
   * replays *from* that id) and is handled by the renderer's timeline, which is keyed on `seq`.
   */
  attach(sessionId: string, lastSeq?: number): AttachResult {
    if (typeof sessionId !== 'string' || sessionId.length === 0) {
      return { ok: false, reason: 'invalid_session_id' };
    }
    if (this.#streams.has(sessionId)) return { ok: true };
    if (this.#streams.size >= this.#max) {
      this.#deps.onEvent?.('refused a live activity attach: relay limit reached', {
        limit: this.#max,
      });
      return { ok: false, reason: 'attach_limit' };
    }

    const client = this.#deps.client();
    if (!client) return { ok: false, reason: 'daemon_unavailable' };

    const controller = new AbortController();
    // Registered BEFORE the async body starts, so a `detach` issued in the same turn of the event
    // loop as the `attach` finds the controller rather than racing past it.
    this.#streams.set(sessionId, controller);

    const aliases = this.#deps.aliasesFor(sessionId);
    const lastEventId =
      typeof lastSeq === 'number' && Number.isInteger(lastSeq) && lastSeq >= 0 ? String(lastSeq) : undefined;

    void this.#pump(sessionId, controller, client, aliases, lastEventId);
    return { ok: true };
  }

  /** Aborts one session's stream. Returns whether there was one. Safe to call for an unknown id. */
  detach(sessionId: string): boolean {
    const controller = this.#streams.get(sessionId);
    if (!controller) return false;
    this.#streams.delete(sessionId);
    controller.abort();
    return true;
  }

  /**
   * Aborts every stream. Wired into `killDaemon()`.
   *
   * The pre-ADI-07 shutdown path aborted `activeStreamAbort`, which was whichever single stream
   * started most recently; every other one was left open against a daemon about to be killed.
   */
  detachAll(): void {
    for (const [sessionId, controller] of [...this.#streams]) {
      this.#streams.delete(sessionId);
      controller.abort();
    }
  }

  async #pump(
    sessionId: string,
    controller: AbortController,
    client: SessionEventSource,
    aliases: Map<string, string>,
    lastEventId: string | undefined,
  ): Promise<void> {
    try {
      for await (const envelope of client.sessions.events(sessionId, {
        signal: controller.signal,
        ...(lastEventId === undefined ? {} : { lastEventId }),
      })) {
        // A `detach` between two frames must stop delivery immediately, not at the next network
        // read: the generator only observes the abort when it next touches the socket.
        if (controller.signal.aborted) return;
        const entry = toActivityEntry(envelope, aliases);
        if (entry === null) continue;
        this.#deps.push({ sessionId, entry });
      }
      this.#close(sessionId, controller, 'stream_ended');
    } catch (err) {
      if (controller.signal.aborted) return;
      // No error text crosses. The renderer is told the stream is gone and nothing about why in
      // the daemon's own words -- a stream failure's message can quote a socket, a port, or a
      // filesystem path, and this boundary's rule is that only messages this build wrote are shown.
      this.#deps.onEvent?.('a live activity stream ended unexpectedly', {
        error: err instanceof Error ? err.message : String(err),
      });
      this.#close(sessionId, controller, 'stream_unavailable');
    }
  }

  /**
   * Retires one stream and tells the renderer.
   *
   * Guarded on the controller still being the registered one, so a stream that was detached and
   * immediately re-attached does not have its successor's registration deleted by its own late
   * teardown.
   */
  #close(sessionId: string, controller: AbortController, reason: 'stream_ended' | 'stream_unavailable'): void {
    if (this.#streams.get(sessionId) === controller) this.#streams.delete(sessionId);
    this.#deps.push({ sessionId, closed: { reason } });
  }
}
