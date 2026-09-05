/**
 * The Electron-main-side relay for the daemon's application-queue SSE stream (#200).
 *
 * Simpler than `AgentWorkspaceRelay` in one structural way: there is exactly one queue, not one
 * per session, so this relay holds a single optional stream rather than a `Map`. Everything else
 * about the shape is deliberately the same -- idempotent `attach`, a targeted `detach`, and a
 * `client()` getter (not a captured value) so a daemon restart's replaced connection is picked up
 * on the next attach rather than streaming from a client that no longer exists.
 *
 * Events pushed here are already content-free at the source (`application-queue-store.ts` never
 * holds a job description, a CV, or a rendered file -- only an opaque attempt id and scheduling
 * state), so there is no redaction boundary to enforce here the way `toActivityEntry` enforces one
 * for AI-session events.
 */

import type { ApplicationQueueEvent } from './application-queue-types.js';
export type { ApplicationQueueEvent };

/** The one method this relay needs from a daemon connection, named so tests can supply a fake
 * without depending on `fetch`/SSE parsing at all. */
export interface ApplicationQueueEventSource {
  events(options: { signal: AbortSignal; lastEventId?: string }): AsyncIterable<ApplicationQueueEvent>;
}

export interface ApplicationQueueRelayDeps {
  /** The current event source, read fresh on every attach -- see this module's own doc comment. */
  client(): ApplicationQueueEventSource | undefined;
  /** Pushes one event to whatever the caller wants to notify (the renderer, most likely). */
  push(event: ApplicationQueueEvent): void;
  onEvent?(message: string, meta?: Record<string, unknown>): void;
}

export class ApplicationQueueRelay {
  #controller: AbortController | undefined;
  #lastSeq: number | undefined;
  readonly #deps: ApplicationQueueRelayDeps;

  constructor(deps: ApplicationQueueRelayDeps) {
    this.#deps = deps;
  }

  get isAttached(): boolean {
    return this.#controller !== undefined;
  }

  /** Idempotent: a second `attach()` while already streaming is a no-op, matching
   * `AgentWorkspaceRelay.attach`'s own reasoning -- a caller re-attaching on every render must not
   * open a second connection and double-deliver every event. */
  attach(): void {
    if (this.#controller) return;
    const client = this.#deps.client();
    if (!client) return;

    const controller = new AbortController();
    this.#controller = controller;
    void this.#pump(controller, client);
  }

  detach(): void {
    this.#controller?.abort();
    this.#controller = undefined;
  }

  async #pump(controller: AbortController, client: ApplicationQueueEventSource): Promise<void> {
    try {
      const lastEventId = typeof this.#lastSeq === 'number' ? String(this.#lastSeq) : undefined;
      for await (const event of client.events({ signal: controller.signal, ...(lastEventId ? { lastEventId } : {}) })) {
        if (controller.signal.aborted) return;
        this.#lastSeq = event.seq;
        this.#deps.push(event);
      }
    } catch (err) {
      if (controller.signal.aborted) return;
      this.#deps.onEvent?.('the application queue stream ended unexpectedly', {
        error: err instanceof Error ? err.message : String(err),
      });
    } finally {
      if (this.#controller === controller) this.#controller = undefined;
    }
  }
}
