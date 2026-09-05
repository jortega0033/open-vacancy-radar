import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import type { Logger } from '@agent-dock/agent-runtime';
import { noopLogger } from '@agent-dock/agent-runtime';
import { appendDurably, atomicWriteJson } from './durable-store/atomic-fs.js';

/**
 * A daemon-owned, durable, single-worker queue of application attempts (#200, part of the #193
 * auto-apply split).
 *
 * **Deliberately content-free.** This store never holds a job description, a CV, a rendered file,
 * or any of the detail #198's `applicationAttempts` table records -- only an opaque `attemptId`
 * and this queue's own scheduling state (`queued`/`active`/`paused`/`cancelled`/`done`/`failed`).
 * The daemon has no SQLite dependency and never opens `workspace.db` (see `state-directory.ts`'s
 * `assertNotColocatedWithProductData` and this repo's daemon/product-data isolation); the detailed
 * checkpoint machinery, and all of an attempt's actual content, stay exactly where #198/#199 put
 * them -- in Electron main, which is also the only process that ever does the real work of an
 * attempt (reading a JD, tailoring a CV, rendering a PDF) and writes its own result back into its
 * own database. This store's only job is answering "which attempt, if any, may Electron main work
 * on right now" durably enough to survive a daemon crash or restart -- mirroring the content-free
 * discipline `workspace-audit/audit.jsonl` already applies to a different kind of sensitive
 * content (folder identity) for the same underlying reason: a store that never holds the sensitive
 * thing cannot leak it.
 *
 * **Why one snapshot file, unlike `SessionLineageStore`'s per-event journal.** An AI session can
 * accumulate thousands of large text events, so `SessionLineageStore` journals every event to a
 * JSONL log and only checkpoints the summary record at a few key moments, to avoid an atomic
 * replace (open/write/fsync/rename/fsync-parent) per event. This queue's entire state -- a handful
 * of attempt ids and their scheduling state -- is tiny and changes rarely (an enqueue, a lease
 * acquired, a pause), so one atomically-replaced snapshot is both simpler and cheap enough to
 * rewrite on every mutation. There is no "believe the log over the record" ambiguity to resolve on
 * recovery, because there is no separate, potentially-stale record: the snapshot file *is* the
 * whole state, and `atomicWriteJson`'s write-temp/fsync/rename/fsync-parent sequence guarantees a
 * reader after a crash sees either the complete old snapshot or the complete new one, never a
 * partial write. "Reclaim the lease after a restart" therefore falls directly out of "read the
 * file back": nothing needs to be reconstructed or reinterpreted.
 *
 * A separate, append-only `events.jsonl` exists purely to feed `subscribe()`'s replay for the SSE
 * route -- it is history for observers, not the store's own source of truth.
 */

export type ApplicationQueueEntryState = 'queued' | 'active' | 'paused' | 'cancelled' | 'done' | 'failed';

/** States `acquireNextLease()` may still promote to `active`. A `paused` entry must be explicitly
 * resumed first -- pausing is a deliberate hold, not a suggestion the scheduler can override. */
const SCHEDULABLE_STATES: readonly ApplicationQueueEntryState[] = ['queued'];

/** States that admit no further transition: the entry's story here is over. */
const TERMINAL_STATES: readonly ApplicationQueueEntryState[] = ['cancelled', 'done', 'failed'];

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

export class ApplicationQueueNotFoundError extends Error {
  constructor(public readonly attemptId: string) {
    super(`no queued attempt with id "${attemptId}"`);
    this.name = 'ApplicationQueueNotFoundError';
  }
}

export class ApplicationQueueInvalidTransitionError extends Error {
  constructor(
    public readonly attemptId: string,
    public readonly from: ApplicationQueueEntryState,
    public readonly action: string,
  ) {
    super(`cannot ${action} attempt "${attemptId}" from state "${from}"`);
    this.name = 'ApplicationQueueInvalidTransitionError';
  }
}

interface QueueSnapshot {
  schemaVersion: 1;
  entries: ApplicationQueueEntry[];
  lease: ApplicationQueueLease | null;
  nextEventSeq: number;
}

const SCHEMA_VERSION = 1;

/** A fresh, empty snapshot. A function, not a shared constant: `{ ...EMPTY_SNAPSHOT }` would be a
 * shallow copy that still shares the *same* `entries` array across every instance that starts
 * empty, so a `push()` in one store would silently leak into every other one. */
function emptySnapshot(): QueueSnapshot {
  return { schemaVersion: SCHEMA_VERSION, entries: [], lease: null, nextEventSeq: 0 };
}

/** How many recent events `subscribe()` can replay to a newly-attaching listener. Bounded for the
 * same reason `RuntimeState.events` is bounded in `session-manager.ts`: this is operational
 * history for a live UI, not an archive: `events.jsonl` on disk is unbounded and is the durable
 * record; this in-memory tail only serves replay. */
const MAX_REPLAY_EVENTS = 500;

export interface ApplicationQueueStoreOptions {
  stateRoot: string;
  logger?: Logger;
}

export class ApplicationQueueStore {
  readonly #dir: string;
  readonly #snapshotPath: string;
  readonly #eventLogPath: string;
  readonly #logger: Logger;
  #snapshot: QueueSnapshot;
  #recentEvents: ApplicationQueueEvent[] = [];
  readonly #listeners = new Set<(event: ApplicationQueueEvent) => void>();

  constructor(options: ApplicationQueueStoreOptions) {
    this.#logger = options.logger ?? noopLogger;
    this.#dir = join(options.stateRoot, 'application-queue-v1');
    this.#snapshotPath = join(this.#dir, 'queue.json');
    this.#eventLogPath = join(this.#dir, 'events.jsonl');
    mkdirSync(this.#dir, { recursive: true, mode: 0o700 });

    this.#snapshot = this.#loadSnapshot();
    this.#recentEvents = this.#loadRecentEvents();
    this.#logger.info('application queue store ready', {
      entries: this.#snapshot.entries.length,
      leased: this.#snapshot.lease?.attemptId,
    });
  }

  #loadSnapshot(): QueueSnapshot {
    if (!existsSync(this.#snapshotPath)) return emptySnapshot();
    try {
      const raw = JSON.parse(readFileSync(this.#snapshotPath, 'utf8')) as Partial<QueueSnapshot>;
      if (raw.schemaVersion !== SCHEMA_VERSION || !Array.isArray(raw.entries)) return emptySnapshot();
      return {
        schemaVersion: SCHEMA_VERSION,
        entries: raw.entries,
        lease: raw.lease ?? null,
        nextEventSeq: typeof raw.nextEventSeq === 'number' ? raw.nextEventSeq : 0,
      };
    } catch (err) {
      // A snapshot that can't be parsed is treated as absent rather than fatal: the daemon is a
      // local coding tool, and refusing to start over a corrupt operational queue would be a worse
      // outcome than starting with an empty one. Nothing here is unrecoverable data -- the source
      // of truth for an attempt's actual content is always #198's workspace.db, never this store.
      this.#logger.error('application queue snapshot could not be read; starting with an empty queue', {
        message: err instanceof Error ? err.message : String(err),
      });
      return emptySnapshot();
    }
  }

  #loadRecentEvents(): ApplicationQueueEvent[] {
    if (!existsSync(this.#eventLogPath)) return [];
    try {
      const lines = readFileSync(this.#eventLogPath, 'utf8').split('\n').filter((line) => line.trim().length > 0);
      const parsed = lines.map((line) => JSON.parse(line) as ApplicationQueueEvent);
      return parsed.slice(-MAX_REPLAY_EVENTS);
    } catch (err) {
      this.#logger.error('application queue event log could not be read; replay history starts empty', {
        message: err instanceof Error ? err.message : String(err),
      });
      return [];
    }
  }

  #persist(): void {
    atomicWriteJson(this.#snapshotPath, this.#snapshot);
  }

  #emit(type: ApplicationQueueEventType, attemptId: string): void {
    const event: ApplicationQueueEvent = { seq: this.#snapshot.nextEventSeq, at: new Date().toISOString(), type, attemptId };
    this.#snapshot.nextEventSeq += 1;
    appendDurably(this.#eventLogPath, JSON.stringify(event));
    this.#recentEvents.push(event);
    if (this.#recentEvents.length > MAX_REPLAY_EVENTS) this.#recentEvents.shift();
    for (const listener of [...this.#listeners]) listener(event);
  }

  #find(attemptId: string): ApplicationQueueEntry {
    const entry = this.#snapshot.entries.find((e) => e.attemptId === attemptId);
    if (!entry) throw new ApplicationQueueNotFoundError(attemptId);
    return entry;
  }

  list(): ApplicationQueueEntry[] {
    return this.#snapshot.entries.map((entry) => ({ ...entry }));
  }

  get(attemptId: string): ApplicationQueueEntry | undefined {
    const entry = this.#snapshot.entries.find((e) => e.attemptId === attemptId);
    return entry ? { ...entry } : undefined;
  }

  currentLease(): ApplicationQueueLease | null {
    return this.#snapshot.lease ? { ...this.#snapshot.lease } : null;
  }

  /**
   * Adds `attemptId` to the queue. Idempotent for an attempt already tracked in a non-terminal
   * state: returns the existing entry unchanged rather than creating a duplicate, since #198's own
   * `createApplicationAttempt` already owns the real dedup decision (whether a *new* attempt should
   * exist at all) -- this queue only ever schedules attempts it's told about.
   */
  enqueue(attemptId: string): ApplicationQueueEntry {
    const existing = this.#snapshot.entries.find((e) => e.attemptId === attemptId);
    if (existing && !TERMINAL_STATES.includes(existing.state)) return { ...existing };

    const now = new Date().toISOString();
    const entry: ApplicationQueueEntry = { attemptId, state: 'queued', queuedAt: now, updatedAt: now };
    if (existing) {
      // A terminal entry for the same attempt id is replaced outright: re-enqueuing a done/failed/
      // cancelled attempt is the "explicitly requested new attempt" case, not a resurrection of the
      // old one -- there is only ever one queue row per attempt id.
      const index = this.#snapshot.entries.indexOf(existing);
      this.#snapshot.entries[index] = entry;
    } else {
      this.#snapshot.entries.push(entry);
    }
    this.#persist();
    this.#emit('enqueued', attemptId);
    return { ...entry };
  }

  /**
   * The single-worker scheduling decision: if no lease is currently held, promotes the
   * longest-waiting `queued` entry to `active` and mints a lease for it. Returns `null` (not a
   * throw) when there is nothing to do -- "no work available" is a normal, expected outcome for a
   * poller, not an error.
   */
  acquireNextLease(): ApplicationQueueLease | null {
    if (this.#snapshot.lease) return null;
    const next = this.#snapshot.entries.find((e) => SCHEDULABLE_STATES.includes(e.state));
    if (!next) return null;

    const now = new Date().toISOString();
    next.state = 'active';
    next.updatedAt = now;
    const lease: ApplicationQueueLease = { leaseId: randomUUID(), attemptId: next.attemptId, acquiredAt: now };
    this.#snapshot.lease = lease;
    this.#persist();
    this.#emit('lease_acquired', next.attemptId);
    return { ...lease };
  }

  /**
   * Ends the current lease. `outcome: 'requeue'` returns the entry to `queued` (a graceful
   * mid-attempt handoff, e.g. the daemon is restarting); `'completed'`/`'failed'` mark it terminal.
   * A no-op, not a throw, if `leaseId` no longer matches the current lease -- an Electron-side
   * worker reporting completion after the lease already moved on (paused/cancelled from elsewhere,
   * or a previous release already ran) must not be able to release someone else's lease.
   */
  release(leaseId: string, outcome: 'completed' | 'failed' | 'requeue'): void {
    if (!this.#snapshot.lease || this.#snapshot.lease.leaseId !== leaseId) return;
    const attemptId = this.#snapshot.lease.attemptId;
    const entry = this.#snapshot.entries.find((e) => e.attemptId === attemptId);
    this.#snapshot.lease = null;
    if (entry) {
      entry.state = outcome === 'requeue' ? 'queued' : outcome === 'completed' ? 'done' : 'failed';
      entry.updatedAt = new Date().toISOString();
    }
    this.#persist();
    this.#emit('released', attemptId);
  }

  /** Holds a `queued` or `active` entry. Releases the lease too if this was the leased entry, so
   * the scheduler can move on to the next attempt while this one waits. */
  pause(attemptId: string): ApplicationQueueEntry {
    const entry = this.#find(attemptId);
    if (entry.state !== 'queued' && entry.state !== 'active') {
      throw new ApplicationQueueInvalidTransitionError(attemptId, entry.state, 'pause');
    }
    if (this.#snapshot.lease?.attemptId === attemptId) this.#snapshot.lease = null;
    entry.state = 'paused';
    entry.updatedAt = new Date().toISOString();
    this.#persist();
    this.#emit('paused', attemptId);
    return { ...entry };
  }

  /** Returns a `paused` entry to `queued`, eligible for `acquireNextLease()` again. */
  resume(attemptId: string): ApplicationQueueEntry {
    const entry = this.#find(attemptId);
    if (entry.state !== 'paused') throw new ApplicationQueueInvalidTransitionError(attemptId, entry.state, 'resume');
    entry.state = 'queued';
    entry.updatedAt = new Date().toISOString();
    this.#persist();
    this.#emit('resumed', attemptId);
    return { ...entry };
  }

  /** Terminally skips an entry (the user chose not to pursue this attempt). Releases the lease
   * too if it was the active one. */
  skip(attemptId: string): ApplicationQueueEntry {
    const entry = this.#find(attemptId);
    if (TERMINAL_STATES.includes(entry.state)) {
      throw new ApplicationQueueInvalidTransitionError(attemptId, entry.state, 'skip');
    }
    if (this.#snapshot.lease?.attemptId === attemptId) this.#snapshot.lease = null;
    entry.state = 'cancelled';
    entry.updatedAt = new Date().toISOString();
    this.#persist();
    this.#emit('skipped', attemptId);
    return { ...entry };
  }

  /** Terminally cancels an entry. Distinguished from `skip` only by the event type recorded --
   * both leave the entry `cancelled` -- so a later observer can tell "the user skipped it" from
   * "the user cancelled it" without needing a third state. */
  cancel(attemptId: string): ApplicationQueueEntry {
    const entry = this.#find(attemptId);
    if (TERMINAL_STATES.includes(entry.state)) {
      throw new ApplicationQueueInvalidTransitionError(attemptId, entry.state, 'cancel');
    }
    if (this.#snapshot.lease?.attemptId === attemptId) this.#snapshot.lease = null;
    entry.state = 'cancelled';
    entry.updatedAt = new Date().toISOString();
    this.#persist();
    this.#emit('cancelled', attemptId);
    return { ...entry };
  }

  /**
   * Replays every buffered event with `seq >= sinceSeq` synchronously (mirroring
   * `SessionManager.subscribe`'s replay-then-live contract), then registers `listener` for future
   * events. Returns an unsubscribe function.
   */
  subscribe(sinceSeq: number, listener: (event: ApplicationQueueEvent) => void): () => void {
    for (const event of this.#recentEvents) {
      if (event.seq >= sinceSeq) listener(event);
    }
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }
}
