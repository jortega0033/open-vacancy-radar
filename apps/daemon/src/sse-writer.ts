import { utf8ByteLength, type AgentEventEnvelope } from '@agent-dock/shared';

/**
 * Per-connection bounded SSE writer for the v1 `/sessions/:sessionId/events` stream (ADI-17).
 *
 * Event producers (`SessionManager.subscribe`'s listener callback) only ever enqueue synchronously
 * via `write()`; draining a slow socket never stalls the provider session or any other subscriber.
 * `session-manager.ts`'s own `MAX_STORED_EVENTS_PER_SESSION`/`MAX_STORED_EVENT_BYTES_PER_SESSION`
 * bounds what a session *keeps for replay*; this bounds what one live HTTP connection is allowed to
 * *queue* while its own socket is backpressured, which is a genuinely separate failure mode: a
 * subscriber that never drains (a stalled client, a dead network path Node hasn't noticed yet) could
 * otherwise make this one connection's write queue grow without limit even though the session's own
 * history is already bounded.
 *
 * Not generic over a protocol, unlike upstream's `BoundedSseWriter<TEvent>`/`BoundedV1SseWriter`
 * split: this repo has exactly one SSE stream (v1's), so a second, config-object layer of
 * indirection existing purely to share code with a v2 writer this repo does not have would be
 * abstraction for a use case that doesn't exist yet. If a second SSE-streaming protocol is ever
 * added here, extracting a shared base class then is a small, mechanical refactor -- not something
 * worth predicting now.
 */

const MAX_QUEUED_EVENTS = 256;
const MAX_QUEUED_BYTES = 4 * 1024 * 1024;

const TERMINAL_EVENT_TYPES: ReadonlySet<AgentEventEnvelope['type']> = new Set([
  'session.completed',
  'session.failed',
  'session.cancelled',
]);

/** The subset of Fastify's `reply.raw` (a `http.ServerResponse`) this writer actually needs,
 * narrowed so a fake can implement it in a test without a real HTTP server. `off` is optional so an
 * output that genuinely cannot remove a listener (none exist in this codebase; every real caller is
 * a Node `EventEmitter`) still satisfies the interface -- but whenever it's present, `#finish()`
 * uses it to avoid leaving a `once('drain', ...)` registration on an output this writer no longer
 * owns after closing. */
export interface SseOutput {
  write(chunk: string): boolean;
  end(chunk?: string): void;
  once(event: 'drain', listener: () => void): void;
  off?(event: 'drain', listener: () => void): void;
}

interface QueuedFrame {
  bytes: number;
  frame: string;
  terminal: boolean;
}

function eventFrame(event: AgentEventEnvelope): string {
  return `id: ${event.sequence}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
}

/**
 * Owns exactly one subscriber connection's outgoing frame queue and its backpressure state.
 *
 * Protocol v1 has no wire-level "stream error" concept to expand (a deliberate non-goal), so an
 * overflowing subscriber's connection is simply ended -- the same as a normal stream close, with no
 * extra frame -- terminating only that one subscriber, never the provider session or its replay
 * history. `SessionManager` never learns an overflow happened; it just stops having a listener.
 */
export class BoundedSseWriter {
  readonly #output: SseOutput;
  readonly #onClose: () => void;
  readonly #queue: QueuedFrame[] = [];
  #queuedBytes = 0;
  #backpressured = false;
  #drainArmed = false;
  #terminalReceived = false;
  #endAfterDrain = false;
  #closed = false;

  constructor(output: SseOutput, onClose: () => void) {
    this.#output = output;
    this.#onClose = onClose;
  }

  /** Sends the SSE comment line every stream opens with. Safe to call at most once, before any
   * `write()`. */
  start(): void {
    if (this.#closed || this.#backpressured) return;
    try {
      if (this.#output.write(':ok\n\n')) return;
      this.#backpressured = true;
      this.#armDrain();
    } catch {
      this.#finish();
    }
  }

  /** Enqueues one event for delivery. A no-op once a terminal event has already been handed off or
   * queued -- protocol v1 emits exactly one terminal event, always last, so nothing legitimate ever
   * arrives after it. */
  write(event: AgentEventEnvelope): void {
    if (this.#closed || this.#terminalReceived) return;

    const terminal = TERMINAL_EVENT_TYPES.has(event.type);
    if (terminal) this.#terminalReceived = true;
    const frame = eventFrame(event);
    const queued: QueuedFrame = { bytes: utf8ByteLength(frame), frame, terminal };

    if (this.#backpressured) {
      if (this.#queue.length >= MAX_QUEUED_EVENTS || this.#queuedBytes + queued.bytes > MAX_QUEUED_BYTES) {
        this.#overflow();
        return;
      }
      this.#queue.push(queued);
      this.#queuedBytes += queued.bytes;
      return;
    }

    this.#handOff(queued);
  }

  /** Ends the connection immediately, queue and all. Idempotent. */
  close(): void {
    this.#finish();
  }

  /** Ends the connection only when no terminal event was ever written -- a subscriber reconnecting
   * with a `Last-Event-ID` past the session's own terminal event has nothing left to replay and
   * would otherwise never see this writer close on its own. A no-op when a terminal event already
   * closed it, so calling this after a normal terminal delivery is always safe. */
  finishReplay(): void {
    if (!this.#terminalReceived) this.#finish();
  }

  #handOff(queued: QueuedFrame): void {
    let ready: boolean;
    try {
      ready = this.#output.write(queued.frame);
    } catch {
      this.#finish();
      return;
    }

    if (ready) {
      if (queued.terminal) this.#finish();
      return;
    }

    this.#backpressured = true;
    this.#endAfterDrain = queued.terminal;
    this.#armDrain();
  }

  #armDrain(): void {
    if (this.#closed || this.#drainArmed) return;
    this.#drainArmed = true;
    try {
      this.#output.once('drain', this.#handleDrain);
    } catch {
      this.#finish();
    }
  }

  readonly #handleDrain = (): void => {
    this.#drainArmed = false;
    if (this.#closed) return;
    this.#backpressured = false;

    if (this.#endAfterDrain) {
      this.#finish();
      return;
    }

    while (!this.#closed && !this.#backpressured && this.#queue.length > 0) {
      const queued = this.#queue.shift() as QueuedFrame;
      this.#queuedBytes -= queued.bytes;
      this.#handOff(queued);
    }
  };

  #overflow(): void {
    this.#queue.length = 0;
    this.#queuedBytes = 0;
    // No wire-level overflow frame for v1 (see the class doc comment) -- the connection just ends.
    this.#finish();
  }

  #finish(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#queue.length = 0;
    this.#queuedBytes = 0;
    if (this.#drainArmed) {
      this.#drainArmed = false;
      try {
        this.#output.off?.('drain', this.#handleDrain);
      } catch {
        // Best-effort: an output that can't remove its own listener still gets closed below.
      }
    }
    try {
      this.#output.end();
    } catch {
      // The peer may already have gone away; local subscription cleanup must still run.
    }
    try {
      this.#onClose();
    } catch {
      // A cleanup callback must not escape into the provider event producer.
    }
  }
}
