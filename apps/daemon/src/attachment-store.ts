import { randomUUID, createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import type { Logger } from '@agent-dock/agent-runtime';
import { noopLogger } from '@agent-dock/agent-runtime';
import { assertContainedIn, atomicWriteJson } from './durable-store/atomic-fs.js';

/**
 * A daemon-private, session-scoped store for tool output too large for the bounded inline preview
 * every other part of this daemon already keeps (ADI-29).
 *
 * ## This is a deliberate, documented exception to `agentdock-state/`'s content-free rule
 *
 * Every other store under `agentdock-state/` -- `SessionLineageStore`'s event log,
 * `application-queue-v1/`, the workspace trust/audit log -- is content-free *by construction*: the
 * on-disk record has no field a prompt, a reply, or a tool's output could be written into (see
 * `docs/privacy.md#agentdock-state-session-history-without-session-content`). This store is the
 * opposite of that on purpose: its entire job is retaining the complete text of a tool result that
 * exceeded the inline preview, so an operator does not permanently lose the only evidence of what a
 * long command produced. That is a real, deliberate widening of what this daemon keeps on disk, not
 * an oversight -- `docs/privacy.md` documents it explicitly as a bounded exception, with the same
 * safety properties argued below, rather than silently contradicting what that page already
 * promises about `agentdock-state/`.
 *
 * ## What makes retaining this content safe enough to justify the exception
 *
 * - **Bounded per item, per session, and in total.** `MAX_ATTACHMENT_BYTES` caps one attachment,
 *   `MAX_ATTACHMENTS_PER_SESSION` caps how many one session can accumulate, and
 *   `MAX_TOTAL_ATTACHMENT_BYTES` caps the whole store. A request that would exceed any of the three
 *   is refused outright, never silently truncated or evicted to make room -- the same "refuse rather
 *   than discard evidence of what happened" rule `workspace-audit/audit.jsonl` already applies to a
 *   different kind of content, per `docs/privacy.md`. **Known limitation, stated rather than
 *   hidden**: once the global budget is reached, every session is refused, not just the one that
 *   filled it, and the only automatic relief is the retention sweep at the next daemon start. A
 *   caller that needs to reclaim space sooner may call `pruneExpired()` directly.
 * - **Narrow MIME scope.** Only `ALLOWED_ATTACHMENT_MIME_TYPES` (`text/plain`, `application/json`)
 *   are accepted; nothing else is retained regardless of size.
 * - **Session-scoped retrieval.** `get()` takes the caller's own session id and refuses to answer
 *   for any attachment recorded under a different one -- there is no "list all attachments" or
 *   "fetch by id alone" surface anywhere in this module.
 * - **Content already crossed this daemon's normal operator-visible boundary.** This store never
 *   receives a raw provider-native envelope or anything a redaction step would otherwise digest --
 *   only the same normalized `result` a `tool.completed` event already carries (see ADI-29's
 *   Scope item 2/3, the caller that will wire this store to that event in a follow-up).
 * - **Time-bounded, on one clock.** `pruneExpired()` runs once at construction (the same point
 *   `SessionLineageStore`'s own retention sweep runs) and deletes anything whose *recorded*
 *   `createdAt` -- not the filesystem's own mtime -- is older than `ATTACHMENT_TTL_MS` compared
 *   against this store's own injected clock. Comparing `createdAt` to filesystem mtime would mix two
 *   independent clocks (the injected one and the OS's), which a review of this module caught as a
 *   real correctness hazard for any caller whose injected clock disagrees with the real one; every
 *   TTL decision here is made on the single clock `now()` provides, consistently.
 * - **Every sweep-driven delete re-validates the record it is about to remove.** A directory entry
 *   under the store root is only ever treated as a real attachment -- and only ever deleted by the
 *   TTL sweep -- once its content has been read back and shown to parse as a `v: 1` record whose own
 *   `id`/`sessionId` fields make sense. Anything else (a stray file, a corrupt fragment, a future
 *   format this build does not understand) is left alone, the same "don't touch what you don't
 *   recognize" rule `AuditStore`'s own segment-rotation sweep already applies.
 * - **Same filesystem safety discipline as every other store here.** `0700` directories, `0600`
 *   files (via `atomicWriteJson`'s own `wx`-mode temp file) -- both meaningful on POSIX; on Windows,
 *   `fs`'s `mode` option does not restrict access the way POSIX permission bits do, so this property
 *   is a POSIX-only guarantee, not a cross-platform one -- a containment check (`assertContainedIn`)
 *   before every delete, a validated-UUID session/attachment id before either is used in a public
 *   method's path, and an `lstat`-based symlink check before this store's internal sweeps ever
 *   recurse into or delete through a directory entry read back off disk (as opposed to a path this
 *   process just built itself).
 *
 * ## What this module deliberately does not do
 *
 * No HTTP route exists yet -- `put`/`get`/`deleteForSession` are plain methods, reachable only from
 * other daemon code, because nothing produces a real attachment id for a route to serve until the
 * `tool.completed` wiring (ADI-29 items 2-3) lands. No generic artifact browser, no cross-session
 * listing, no cloud sync, and no automatic reinjection into a provider's context.
 */

export const MAX_ATTACHMENT_BYTES = 1 * 1024 * 1024;
export const MAX_ATTACHMENTS_PER_SESSION = 20;
export const MAX_TOTAL_ATTACHMENT_BYTES = 64 * 1024 * 1024;
/** Backstop retention: an attachment older than this is swept on the next daemon start (or an
 * explicit `pruneExpired()` call), whether or not its owning session was ever explicitly evicted.
 * Generous for the "look at yesterday's run" use case this store exists for, far short of
 * "permanent". Compared against each record's own `createdAt`, never a filesystem timestamp -- see
 * the class doc comment's note on why the two must not be mixed. */
export const ATTACHMENT_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export const ALLOWED_ATTACHMENT_MIME_TYPES = ['text/plain', 'application/json'] as const;
export type AllowedAttachmentMimeType = (typeof ALLOWED_ATTACHMENT_MIME_TYPES)[number];

const STORE_DIR = 'attachments-v1';
const SESSION_ID_PATTERN = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
const ATTACHMENT_ID_PATTERN = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

export interface AttachmentMetadata {
  id: string;
  sessionId: string;
  mimeType: AllowedAttachmentMimeType;
  bytes: number;
  sha256: string;
  /** ISO-8601. The single source of truth for this attachment's age -- see the class doc comment. */
  createdAt: string;
}

export interface AttachmentContent {
  metadata: AttachmentMetadata;
  content: string;
}

/** The on-disk record. Never constructed by a caller directly -- `put()` is the only writer. */
interface AttachmentRecord extends AttachmentMetadata {
  v: 1;
  content: string;
}

export class InvalidSessionIdError extends Error {
  constructor(sessionId: string) {
    super(`"${sessionId}" is not a valid session id`);
    this.name = 'InvalidSessionIdError';
  }
}

export class AttachmentTooLargeError extends Error {
  constructor(bytes: number) {
    super(`attachment is ${bytes} bytes, over the ${MAX_ATTACHMENT_BYTES}-byte limit`);
    this.name = 'AttachmentTooLargeError';
  }
}

export class AttachmentMimeTypeRejectedError extends Error {
  constructor(mimeType: string) {
    super(`"${mimeType}" is not an accepted attachment MIME type`);
    this.name = 'AttachmentMimeTypeRejectedError';
  }
}

export class AttachmentQuotaExceededError extends Error {
  constructor(public readonly scope: 'session' | 'store') {
    super(scope === 'session' ? 'this session has reached its attachment limit' : 'the attachment store is full');
    this.name = 'AttachmentQuotaExceededError';
  }
}

export interface AttachmentStoreOptions {
  stateRoot: string;
  now?: () => Date;
  logger?: Logger;
}

function isAllowedMimeType(value: string): value is AllowedAttachmentMimeType {
  return (ALLOWED_ATTACHMENT_MIME_TYPES as readonly string[]).includes(value);
}

function assertValidSessionId(sessionId: string): void {
  if (!SESSION_ID_PATTERN.test(sessionId)) throw new InvalidSessionIdError(sessionId);
}

/** True only for a genuine, followable regular file/directory -- never a symlink. Every internal
 * walk in this store calls this before recursing into or reading a directory entry it read back off
 * disk, rather than a path it just built itself, so a symlink planted under the store root (by a
 * bug, or by anything else able to write there) is refused rather than followed. */
function isRealEntry(path: string): boolean {
  try {
    return !lstatSync(path).isSymbolicLink();
  } catch {
    return false;
  }
}

export class AttachmentStore {
  readonly #root: string;
  readonly #now: () => Date;
  readonly #logger: Logger;

  constructor(options: AttachmentStoreOptions) {
    this.#now = options.now ?? (() => new Date());
    this.#logger = options.logger ?? noopLogger;
    this.#root = join(options.stateRoot, STORE_DIR);
    mkdirSync(this.#root, { recursive: true, mode: 0o700 });
    this.pruneExpired();
  }

  #sessionDir(sessionId: string): string {
    return join(this.#root, sessionId);
  }

  #attachmentPath(sessionId: string, attachmentId: string): string {
    return join(this.#sessionDir(sessionId), `${attachmentId}.json`);
  }

  /** Reads and validates one attachment record from disk, or `undefined` for anything this build
   * cannot trust: a symlink, an unreadable file, invalid JSON, or a shape that isn't a real `v: 1`
   * record. Every internal reader in this class goes through this one function so "what counts as a
   * real attachment" is decided in exactly one place. */
  #readRecord(filePath: string): AttachmentRecord | undefined {
    if (!isRealEntry(filePath)) return undefined;
    let stat;
    try {
      stat = statSync(filePath);
    } catch {
      return undefined;
    }
    if (!stat.isFile()) return undefined;
    try {
      const record = JSON.parse(readFileSync(filePath, 'utf8')) as AttachmentRecord;
      if (
        record.v === 1 &&
        typeof record.id === 'string' &&
        ATTACHMENT_ID_PATTERN.test(record.id) &&
        typeof record.sessionId === 'string' &&
        SESSION_ID_PATTERN.test(record.sessionId) &&
        typeof record.createdAt === 'string' &&
        typeof record.content === 'string'
      ) {
        return record;
      }
      return undefined;
    } catch {
      // A record this build cannot parse or does not recognize the shape of is skipped, not fatal --
      // and, per this function's doc comment, never touched by the retention sweep either.
      return undefined;
    }
  }

  /** Every valid attachment record currently on disk for one session. */
  #listSession(sessionId: string): AttachmentRecord[] {
    const dir = this.#sessionDir(sessionId);
    if (!existsSync(dir) || !isRealEntry(dir)) return [];
    const records: AttachmentRecord[] = [];
    for (const name of readdirSync(dir)) {
      if (!name.endsWith('.json')) continue;
      const record = this.#readRecord(join(dir, name));
      if (record) records.push(record);
    }
    return records;
  }

  /**
   * A cheap upper-bound count of one session's attachments, for the per-session quota check in
   * `put()`. Deliberately a `readdir` name count, not a full parse of every record the way
   * `#listSession` needs for `listMetadata()`/`get()`: every `.json` file under a session directory
   * was created by this store's own `put()` with a random UUID name, so counting names is exact in
   * the absence of external tampering, and `put()`'s quota is a usage limit, not a security boundary
   * that needs to survive an adversary planting files here (the filesystem-level defenses above
   * already cover that threat).
   */
  #sessionAttachmentCount(sessionId: string): number {
    const dir = this.#sessionDir(sessionId);
    if (!existsSync(dir) || !isRealEntry(dir)) return 0;
    return readdirSync(dir).filter((name) => name.endsWith('.json')).length;
  }

  /**
   * The store's real on-disk footprint, walked fresh every time rather than tracked as a running
   * total updated incrementally by `put()`/`deleteForSession()`/`pruneExpired()`. That is a
   * deliberate simplicity choice for this first slice, not an oversight: an incremental counter is
   * one more piece of state that can drift from what is actually on disk (a crash between a write
   * and a counter update, a file removed by hand, a future bug in one of the three mutation paths),
   * and this store's whole design already trades some throughput for exactly that kind of
   * safety-over-cleverness elsewhere. The cost is real -- this walk runs on every `put()`, so it
   * grows with the number of sessions and attachments the store currently holds -- but stays bounded
   * by `MAX_TOTAL_ATTACHMENT_BYTES`/`MAX_ATTACHMENTS_PER_SESSION` in the number of *files* it ever
   * has to walk, and this store's own `pruneExpired()` keeps that bounded further over time. Revisit
   * with a real running total, backed by measurements, if this ever becomes the bottleneck it isn't
   * yet -- nothing calls `put()` in production today (see the class doc comment).
   */
  #totalBytes(): number {
    if (!existsSync(this.#root)) return 0;
    let total = 0;
    for (const sessionId of readdirSync(this.#root)) {
      const dir = join(this.#root, sessionId);
      if (!isRealEntry(dir)) continue;
      let stat;
      try {
        stat = statSync(dir);
      } catch {
        continue;
      }
      if (!stat.isDirectory()) continue;
      for (const name of readdirSync(dir)) {
        const filePath = join(dir, name);
        if (!isRealEntry(filePath)) continue;
        try {
          total += statSync(filePath).size;
        } catch (err) {
          const code = (err as NodeJS.ErrnoException).code;
          if (code !== 'ENOENT') {
            // Anything other than "it's gone" (e.g. a permission error on a file that still exists
            // and still occupies disk space) is worth an operator's attention: silently dropping it
            // from the total would let the global budget be exceeded in practice while this check
            // nominally passes.
            this.#logger.warn('attachment-store: could not measure an attachment file', { sessionId, code });
          }
        }
      }
    }
    return total;
  }

  /**
   * Deletes any attachment whose recorded `createdAt` is older than `ATTACHMENT_TTL_MS` (compared
   * against this store's own clock -- never a filesystem timestamp, see the class doc comment), and
   * any session directory left completely empty afterward. Runs once at construction, the same point
   * `SessionLineageStore`'s own retention sweep runs, so a daemon that is merely restarted regularly
   * stays bounded without needing anything else to remember to call this. Also callable directly --
   * the store's documented escape hatch for reclaiming space before the next restart.
   */
  pruneExpired(): void {
    if (!existsSync(this.#root)) return;
    const cutoffMs = this.#now().getTime() - ATTACHMENT_TTL_MS;

    for (const sessionId of readdirSync(this.#root)) {
      const dir = join(this.#root, sessionId);
      if (!isRealEntry(dir)) continue;
      let stat;
      try {
        stat = statSync(dir);
      } catch {
        continue;
      }
      if (!stat.isDirectory()) continue;

      for (const name of readdirSync(dir)) {
        const filePath = join(dir, name);
        const record = this.#readRecord(filePath);
        if (!record) continue; // Not a record this build recognizes -- left alone, not swept.

        const createdAtMs = Date.parse(record.createdAt);
        if (!Number.isFinite(createdAtMs) || createdAtMs >= cutoffMs) continue;

        try {
          assertContainedIn(this.#root, filePath);
          unlinkSync(filePath);
          this.#logger.debug('attachment-store: expired attachment removed', { sessionId });
        } catch {
          this.#logger.warn('attachment-store: failed to remove expired attachment', { sessionId });
        }
      }

      // Removed only once truly empty -- a stray or unrecognized file left behind (never swept
      // above) correctly keeps the directory, and therefore that evidence, in place.
      if (readdirSync(dir).length === 0) {
        try {
          assertContainedIn(this.#root, dir);
          rmSync(dir, { recursive: true, force: true });
        } catch {
          // Leaving an empty directory behind costs nothing; the next sweep tries again.
        }
      }
    }
  }

  /**
   * Retains one tool result's complete content under `sessionId`. Throws `AttachmentTooLargeError`,
   * `AttachmentMimeTypeRejectedError`, or `AttachmentQuotaExceededError` rather than truncating or
   * evicting an older attachment to make room -- refusing is the same choice
   * `workspace-audit/audit.jsonl` already makes at its own capacity limit.
   */
  put(sessionId: string, mimeType: string, content: string): AttachmentMetadata {
    assertValidSessionId(sessionId);
    if (!isAllowedMimeType(mimeType)) throw new AttachmentMimeTypeRejectedError(mimeType);

    const bytes = Buffer.byteLength(content, 'utf8');
    if (bytes > MAX_ATTACHMENT_BYTES) throw new AttachmentTooLargeError(bytes);

    if (this.#sessionAttachmentCount(sessionId) >= MAX_ATTACHMENTS_PER_SESSION) {
      throw new AttachmentQuotaExceededError('session');
    }
    if (this.#totalBytes() + bytes > MAX_TOTAL_ATTACHMENT_BYTES) throw new AttachmentQuotaExceededError('store');

    const id = randomUUID();
    const metadata: AttachmentMetadata = {
      id,
      sessionId,
      mimeType,
      bytes,
      sha256: createHash('sha256').update(content, 'utf8').digest('hex'),
      createdAt: this.#now().toISOString(),
    };
    const record: AttachmentRecord = { v: 1, ...metadata, content };

    const dir = this.#sessionDir(sessionId);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    atomicWriteJson(this.#attachmentPath(sessionId, id), record);

    return metadata;
  }

  /**
   * Reads one attachment back, only when `attachmentId` was actually recorded under `sessionId` --
   * a caller cannot retrieve another session's attachment by guessing or reusing an id, even a valid
   * one for a different session.
   */
  get(sessionId: string, attachmentId: string): AttachmentContent | undefined {
    assertValidSessionId(sessionId);
    if (!ATTACHMENT_ID_PATTERN.test(attachmentId)) return undefined;

    const record = this.#readRecord(this.#attachmentPath(sessionId, attachmentId));
    if (!record || record.sessionId !== sessionId || record.id !== attachmentId) return undefined;

    const { content, v: _v, ...metadata } = record;
    void _v;
    return { metadata, content };
  }

  /** Every attachment's metadata for one session, newest first. Never returns `content`. */
  listMetadata(sessionId: string): AttachmentMetadata[] {
    assertValidSessionId(sessionId);
    return this.#listSession(sessionId)
      .map(({ content: _content, v: _v, ...metadata }) => {
        void _content;
        void _v;
        return metadata;
      })
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  /**
   * Deletes every attachment recorded under `sessionId`. Ready for `SessionLineageStore` to call
   * when a lineage is evicted (ADI-29's follow-up wiring); exercised directly by this module's own
   * tests until that caller exists.
   */
  deleteForSession(sessionId: string): void {
    assertValidSessionId(sessionId);
    const dir = this.#sessionDir(sessionId);
    if (!existsSync(dir)) return;
    assertContainedIn(this.#root, dir);
    rmSync(dir, { recursive: true, force: true });
  }
}
