import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { Logger } from '@agent-dock/agent-runtime';
import { auditEntryV2Schema, type AuditEntryV2 } from '@agent-dock/shared';
import { appendDurably, quarantine } from './durable-store/atomic-fs.js';

/**
 * The append-only audit log for workspace trust decisions (ADI-06).
 *
 * Built on ADI-05's primitives (`appendDurably`, `quarantine`) rather than ported from upstream's
 * hand-rolled append, which has a real bug this repo already fixed elsewhere: a single `writeFile`
 * with no short-write loop can tear a line. `appendDurably` has the loop, opens with
 * `O_APPEND | O_NOFOLLOW`, and fsyncs, so one correct implementation serves both stores.
 *
 * ## The retention policy is the opposite of `SessionLineageStore`'s, on purpose
 *
 * `SessionLineageStore` evicts its oldest records when it hits its quota, because losing old session
 * history degrades a feature. This store **throws** when it hits its cap, because an audit log that
 * silently forgets is not an audit log. The consequence is deliberate and is the whole design: when
 * the log cannot record a decision, the decision is refused. Refusing to grant access to a
 * workspace is a recoverable inconvenience; granting access that nothing recorded is not.
 *
 * ## Three properties, and what enforces each
 *
 * 1. **Ordering.** Writes are serialized on a promise tail, so `sequence` assignment and the append
 *    that carries it cannot interleave. Two concurrent `append()` calls produce two contiguous
 *    sequence numbers in the order their writes actually land, never a gap or a swap.
 * 2. **No entry after a failure.** A single failed write or a `close()` latches `#unhealthy`, and
 *    every subsequent `append()` throws. Without the latch, a write that failed halfway would be
 *    followed by later entries at higher sequence numbers, and the gap would be indistinguishable
 *    from deliberate tampering on the next load.
 * 3. **Truncation is detectable.** Sequences are validated as contiguous from zero at load. Any gap,
 *    any unparseable line, and any non-zero starting sequence quarantines the file (never deletes
 *    it) and starts a fresh log.
 *
 * ## Why there is no hash chain (D5)
 *
 * A hash chain would only defend against an attacker who can edit the file but not recompute the
 * chain. This repo's own threat model (SECURITY.md) names a **same-user local attacker**, who can do
 * both: the chain, the file, and the code that verifies it are all readable and writable by that
 * user. Shipping one would look like tamper-evidence while providing none. Contiguous-sequence
 * validation makes the honest, smaller claim it can actually keep: truncation and deletion are
 * detected, editing is not.
 */

const STORE_DIR = 'workspace-audit';
const LOG_FILE = 'audit.jsonl';
const QUARANTINE_DIR = 'quarantine';

/** 64 MB. At roughly 300 bytes per entry that is over 200,000 decisions, which no local user reaches. */
export const DEFAULT_AUDIT_MAX_BYTES = 64 * 1024 * 1024;

/** Default page size for `list()`, matching the v2 read routes' own default. */
export const DEFAULT_AUDIT_PAGE_LIMIT = 50;

/** Thrown when the log has reached its byte cap. The caller must deny whatever it was about to do. */
export class AuditCapacityError extends Error {
  readonly code = 'audit_log_full';

  constructor(maxBytes: number) {
    super(
      `the workspace audit log has reached its ${maxBytes}-byte cap. Actions that require an audit ` +
        'entry are refused until it is archived: an unrecorded grant is not an acceptable fallback.',
    );
    this.name = 'AuditCapacityError';
  }
}

/** Thrown by every `append()` after the store has latched unhealthy. */
export class AuditUnavailableError extends Error {
  readonly code = 'audit_unavailable';

  constructor(cause?: string) {
    super(
      'the workspace audit log is no longer writable, so no further action can be recorded' +
        (cause ? `: ${cause}` : '') +
        '. Every action that requires an audit entry is refused until the daemon restarts.',
    );
    this.name = 'AuditUnavailableError';
  }
}

/** What a caller supplies. `schemaVersion`, `sequence`, `entryId`, and `recordedAt` are assigned here. */
export type AuditEntryInput = Omit<AuditEntryV2, 'schemaVersion' | 'sequence' | 'entryId' | 'recordedAt'>;

export interface AuditStoreOptions {
  stateRoot: string;
  logger?: Logger;
  now?: () => Date;
  maxBytes?: number;
}

export interface AuditPage {
  entries: AuditEntryV2[];
  nextCursor?: string;
}

export interface AuditListOptions {
  /** Opaque: the decimal sequence number to start *after*. See `v2-audit.ts`. */
  cursor?: string;
  limit?: number;
}

const noopLogger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

export class AuditStore {
  readonly root: string;
  readonly #logPath: string;
  readonly #quarantineDir: string;
  readonly #logger: Logger;
  readonly #now: () => Date;
  readonly #maxBytes: number;

  /** Every entry currently on disk, in sequence order. Small and bounded by `#maxBytes`. */
  #entries: AuditEntryV2[] = [];
  #bytes = 0;
  #nextSequence = 0;
  #unhealthy: string | undefined;
  /** The serialization tail. Never rejects: failures are reported through the returned promise. */
  #writeQueue: Promise<unknown> = Promise.resolve();

  constructor(options: AuditStoreOptions) {
    this.root = join(options.stateRoot, STORE_DIR);
    this.#logPath = join(this.root, LOG_FILE);
    this.#quarantineDir = join(this.root, QUARANTINE_DIR);
    this.#logger = options.logger ?? noopLogger;
    this.#now = options.now ?? (() => new Date());
    this.#maxBytes = options.maxBytes ?? DEFAULT_AUDIT_MAX_BYTES;

    mkdirSync(this.root, { recursive: true, mode: 0o700 });
    this.#load();
  }

  /** True once a write or close has failed. Every later `append()` throws. */
  get unhealthy(): boolean {
    return this.#unhealthy !== undefined;
  }

  /** Bytes currently on disk. Exposed for the capacity tests and for the daemon's startup log. */
  get byteLength(): number {
    return this.#bytes;
  }

  get entryCount(): number {
    return this.#entries.length;
  }

  /**
   * Loads and validates the existing log.
   *
   * Validation is deliberately all-or-nothing. A log with a gap has had entries removed, and there
   * is no way to tell which part of the remainder is still trustworthy, so the whole file is
   * quarantined and a fresh one started, rather than salvaging a prefix. Quarantining preserves the
   * evidence (`quarantine` never deletes), which is the entire reason the file mattered.
   */
  #load(): void {
    if (!existsSync(this.#logPath)) return;

    let raw: string;
    try {
      raw = readFileSync(this.#logPath, 'utf8');
    } catch (err) {
      this.#quarantineLog('unreadable');
      this.#logger.warn('workspace audit log could not be read; it was quarantined', {
        error: err instanceof Error ? err.message : String(err),
      });
      return;
    }

    const lines = raw.split('\n').filter((line) => line.length > 0);
    const parsed: AuditEntryV2[] = [];
    for (const [index, line] of lines.entries()) {
      let candidate: unknown;
      try {
        candidate = JSON.parse(line);
      } catch {
        this.#quarantineLog('unparseable-line');
        this.#logger.warn('workspace audit log had an unparseable line; it was quarantined', { line: index });
        return;
      }
      const entry = auditEntryV2Schema.safeParse(candidate);
      if (!entry.success) {
        this.#quarantineLog('invalid-entry');
        this.#logger.warn('workspace audit log had an entry this build cannot validate; it was quarantined', {
          line: index,
        });
        return;
      }
      // The contiguity rule, and both halves matter. `!== index` catches a gap in the middle (a
      // deleted entry) AND a non-zero first sequence (a truncated head), which a
      // "each is one more than the last" check on its own would miss entirely.
      if (entry.data.sequence !== index) {
        this.#quarantineLog('sequence-gap');
        this.#logger.warn('workspace audit log sequence is not contiguous; it was quarantined', {
          line: index,
          sequence: entry.data.sequence,
        });
        return;
      }
      parsed.push(entry.data);
    }

    this.#entries = parsed;
    this.#nextSequence = parsed.length;
    try {
      this.#bytes = statSync(this.#logPath).size;
    } catch {
      this.#bytes = Buffer.byteLength(raw, 'utf8');
    }
  }

  #quarantineLog(reason: string): void {
    try {
      quarantine(this.#logPath, this.#quarantineDir, reason);
    } catch (err) {
      // Quarantining is itself a filesystem operation and can fail. If it does, the log stays where
      // it is and the store latches unhealthy rather than appending onto a file it does not trust:
      // appending after an unvalidated prefix is exactly the state contiguity checking exists to
      // make impossible.
      this.#unhealthy = 'the corrupt audit log could not be quarantined';
      this.#logger.error('could not quarantine a corrupt workspace audit log', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
    this.#entries = [];
    this.#nextSequence = 0;
    this.#bytes = 0;
  }

  /**
   * Records one entry, durably, and resolves only once it is on stable storage.
   *
   * The `await` a caller does on this is the ordering guarantee the trust routes depend on: an
   * "allowed" answer is returned only after the entry that justifies it has been fsynced. Nothing
   * here is best-effort, and nothing here swallows an error.
   */
  append(input: AuditEntryInput): Promise<AuditEntryV2> {
    const task = this.#writeQueue.then(
      () => this.#appendNow(input),
      () => this.#appendNow(input),
    );
    // The tail must never reject, or an unrelated later append would inherit this one's failure as
    // an unhandled rejection. The caller still sees the real error through `task`.
    this.#writeQueue = task.then(
      () => undefined,
      () => undefined,
    );
    return task;
  }

  #appendNow(input: AuditEntryInput): AuditEntryV2 {
    if (this.#unhealthy) throw new AuditUnavailableError(this.#unhealthy);

    const entry: AuditEntryV2 = auditEntryV2Schema.parse({
      schemaVersion: 1,
      sequence: this.#nextSequence,
      entryId: randomUUID(),
      recordedAt: this.#now().toISOString(),
      ...input,
    });

    const line = JSON.stringify(entry);
    const lineBytes = Buffer.byteLength(line, 'utf8') + 1; // + the newline appendDurably adds
    if (this.#bytes + lineBytes > this.#maxBytes) {
      // Deliberately NOT latched as unhealthy: a full log is a recoverable condition (archive the
      // file and restart), not a broken one, and latching would keep refusing even after the
      // operator fixed it. It still denies the action, which is the part that matters.
      throw new AuditCapacityError(this.#maxBytes);
    }

    try {
      appendDurably(this.#logPath, line);
    } catch (err) {
      // The latch. Whether the write landed partially, fully, or not at all is unknowable from
      // here, and every one of those states makes the next entry's position untrustworthy.
      this.#unhealthy = err instanceof Error ? err.message : String(err);
      this.#logger.error('the workspace audit log could not be written; refusing all further entries', {
        error: this.#unhealthy,
      });
      throw new AuditUnavailableError(this.#unhealthy);
    }

    this.#entries.push(entry);
    this.#nextSequence += 1;
    this.#bytes += lineBytes;
    return entry;
  }

  /** Every entry, oldest first. Used by tests and by the read route's paging. */
  all(): readonly AuditEntryV2[] {
    return this.#entries;
  }

  /**
   * One page, oldest first. The cursor is the decimal sequence number to resume *after*, which is
   * opaque to clients by contract (see `opaqueCursorV2Schema`) even though it is trivially decodable:
   * the guarantee is that a client that parses it is relying on something this repo may change.
   */
  list(options: AuditListOptions = {}): AuditPage {
    const limit = options.limit ?? DEFAULT_AUDIT_PAGE_LIMIT;
    let start = 0;
    if (options.cursor !== undefined) {
      const after = Number(options.cursor);
      if (!Number.isInteger(after) || after < 0) return { entries: [] };
      start = this.#entries.findIndex((entry) => entry.sequence > after);
      if (start === -1) return { entries: [] };
    }
    const slice = this.#entries.slice(start, start + limit);
    const last = slice[slice.length - 1];
    const hasMore = last !== undefined && start + slice.length < this.#entries.length;
    return { entries: slice, ...(hasMore ? { nextCursor: String(last.sequence) } : {}) };
  }

  /**
   * Marks the store unwritable. There is no file handle to release (every append opens, writes,
   * fsyncs, and closes), so this exists to make "the daemon is shutting down" indistinguishable from
   * "a write failed" for any late caller: both must refuse, not silently succeed.
   */
  close(reason = 'the audit store was closed'): void {
    this.#unhealthy ??= reason;
  }
}
