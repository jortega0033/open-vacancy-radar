import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import type { AgentEventEnvelope, AgentSession, SessionStatusV2, TerminalReasonV2 } from '@agent-dock/shared';
import type { Logger, NormalizedUnknownFrame } from '@agent-dock/agent-runtime';
import { noopLogger } from '@agent-dock/agent-runtime';
import { appendDurably, assertContainedIn, atomicWriteJson, quarantine, syncDirectory } from './durable-store/atomic-fs.js';
import {
  interruptedEventRecord,
  persistedEventRecordV1Schema,
  persistedSessionRecordV1Schema,
  redactEnvelope,
  redactSessionForPersistence,
  type PersistedEventRecordV1,
  type PersistedLaunchScope,
  type PersistedSessionRecordV1,
} from './persisted-session-schema.js';

/**
 * The durable, crash-safe store behind the v2 read routes, and the thing that finally answers
 * ADI-04's open question: whether a session that was running when the daemon died had already
 * handed its prompt to a provider (see
 * docs/adr-agentdock-v2-provenance.md#limitation-accepted-work-state-is-in-memory-only).
 *
 * ## On-disk layout
 *
 * ```
 * <stateRoot>/sessions-v1/
 *   manifest.json                        {"schemaVersion":1}
 *   lineages/<rootSessionId>/
 *     records/<sessionId>.json           one PersistedSessionRecordV1, atomically replaced
 *     events/<sessionId>.jsonl           PersistedEventRecordV1 per line, append-only
 *   tombstones/<rootSessionId>.json      the commit record of an eviction
 *   quarantine/                          anything corrupt. NEVER auto-deleted.
 *   .trash/                              two-phase eviction staging only
 * ```
 *
 * A *lineage* is one root session plus every session resumed from it, transitively. It is the unit
 * of eviction because it is the unit of meaning: evicting a parent while keeping the child that
 * resumed it would leave a record whose `parentSessionId` points at nothing, and whose accepted-work
 * history -- the one fact this store exists to preserve -- would be half gone.
 *
 * ## Why the constructor does the work
 *
 * Recovery, corruption handling, and retention all run **synchronously inside the constructor**.
 * That is not a style choice: `apps/daemon/src/index.ts` constructs this before `buildServer()` and
 * `app.listen()`, so "recovery completes before the daemon accepts new work" is true *structurally*
 * -- there is no ordering for a future edit to get wrong, because the server literally cannot exist
 * until this returns.
 */

/** Retention defaults. Whichever bound is hit first wins; see `#enforceRetention`. */
export const DEFAULT_RETENTION = Object.freeze({
  maxAgeMs: 30 * 24 * 60 * 60 * 1000,
  maxRecords: 500,
  maxBytes: 64 * 1024 * 1024,
});

/**
 * Matches `MAX_STORED_EVENTS_PER_SESSION` in session-manager.ts deliberately, and the two numbers
 * are meant to stay equal: a session whose in-memory replay buffer stopped growing and whose
 * on-disk log kept growing (or the reverse) would make the v1 SSE replay and the v2 event page
 * disagree about what happened, for no benefit.
 */
export const MAX_PERSISTED_EVENTS_PER_SESSION = 5_000;

export interface RetentionPolicy {
  maxAgeMs?: number;
  maxRecords?: number;
  maxBytes?: number;
}

export interface SessionLineageStoreOptions {
  stateRoot: string;
  retention?: RetentionPolicy;
  now?: () => Date;
  logger?: Logger;
}

/**
 * Thrown by the constructor's read-only preflight when the store on disk was written by a newer
 * build of this daemon.
 *
 * The contract this error carries is as important as the error itself: **nothing on disk has been
 * touched** when it is thrown. Not quarantined, not renamed, not rewritten, not even created. A
 * newer version's state is not corruption, it is data belonging to software this build does not
 * understand, and the only safe action is to leave it exactly as found and run without it. See
 * `index.ts`, which catches this and falls back to memory-only v1 operation, and
 * docs/rollback-runbook-agentdock-v2.md.
 */
export class UnsupportedStateSchemaVersionError extends Error {
  readonly code = 'unsupported_state_schema_version' as const;

  constructor(
    readonly foundVersion: number,
    readonly path: string,
  ) {
    super(
      `agent-dock state at ${path} declares schemaVersion ${foundVersion}, which this build does ` +
        'not understand. Leaving it untouched.',
    );
    this.name = 'UnsupportedStateSchemaVersionError';
  }
}

/** Thrown by `create()` when retention cannot free room for another record. */
export class StorageFullError extends Error {
  readonly code = 'storage_full' as const;
  readonly statusCode = 507 as const;

  constructor(message: string) {
    super(message);
    this.name = 'StorageFullError';
  }
}

/** Thrown by the listing methods for a cursor that does not address anything. */
export class InvalidCursorError extends Error {
  readonly code = 'invalid_cursor' as const;

  constructor() {
    super('invalid cursor');
    this.name = 'InvalidCursorError';
  }
}

export interface CreateSessionRecordOptions {
  protocolVersion: 1 | 2;
  scope: PersistedLaunchScope;
  /** The provider-native thread id this session continues, if any. Drives lineage attachment. */
  resumeProviderSessionId?: string;
}

interface Lineage {
  rootId: string;
  /** sessionId -> record. Insertion order is not meaningful; ordering is always derived. */
  records: Map<string, PersistedSessionRecordV1>;
  /** Lines currently on disk per session log, which can be below `eventCount` once truncated. */
  linesOnDisk: Map<string, number>;
  /** Approximate on-disk footprint of this lineage, in bytes. See `#recomputeLineageBytes`. */
  bytes: number;
}

interface Tombstone {
  schemaVersion: 1;
  rootSessionId: string;
  evictedAt: string;
  reason: 'retention_age' | 'quota_records' | 'quota_bytes';
  sessionIds: string[];
  records: number;
  bytes: number;
}

export interface SessionPage {
  sessions: PersistedSessionRecordV1[];
  nextCursor?: string;
}

export interface EventPage {
  events: PersistedEventRecordV1[];
  nextCursor?: string;
}

export interface StoreStats {
  lineages: number;
  records: number;
  bytes: number;
}

const STORE_DIR = 'sessions-v1';
const MANIFEST_FILE = 'manifest.json';
const TRASH_PREFIX = 'evict--';

type TerminalLogType =
  | 'session.completed'
  | 'session.failed'
  | 'session.cancelled'
  | 'session.interrupted';

/**
 * How a terminal event already present in a log maps onto the record's terminal state.
 *
 * This exists because the metadata record is only checkpointed (see `appendEvent`), so a crash can
 * leave a record saying `running` over a log that already ends in `session.completed`. Recovery
 * must believe the log in that case: the log line was fsynced at the moment the event happened,
 * whereas the record is a snapshot that may simply never have been taken. Synthesizing an
 * `interrupted` event on top of a real terminal one would fabricate a restart that did not affect
 * this session at all.
 */
const TERMINAL_LOG_OUTCOME: Readonly<
  Record<TerminalLogType, { status: SessionStatusV2; reason: TerminalReasonV2 }>
> = Object.freeze({
  'session.completed': { status: 'completed', reason: 'provider_completed' },
  'session.failed': { status: 'failed', reason: 'provider_error' },
  'session.cancelled': { status: 'cancelled', reason: 'cancelled_by_client' },
  'session.interrupted': { status: 'interrupted', reason: 'daemon_restart' },
});

function isTerminalLogType(type: string): type is TerminalLogType {
  return Object.prototype.hasOwnProperty.call(TERMINAL_LOG_OUTCOME, type);
}

interface EventLogState {
  count: number;
  firstSequence?: number;
  terminalType?: TerminalLogType;
}

function encodeCursor(value: string): string {
  return Buffer.from(value, 'utf8').toString('base64url');
}

function decodeCursor(cursor: string): string {
  return Buffer.from(cursor, 'base64url').toString('utf8');
}

/** `readdirSync` that treats a missing directory as empty rather than throwing. */
function safeReaddir(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
}

function fileSize(path: string): number {
  try {
    return statSync(path).size;
  } catch {
    return 0;
  }
}

/**
 * Reads a file and returns its parsed JSON, or `undefined` if it is missing or not JSON at all.
 * Used only by the preflight, which must never throw for anything except a future schema version.
 */
function tryReadJson(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return undefined;
  }
}

/**
 * Parses one already-read JSONL line. Deliberately a separate function from `tryReadJson` above,
 * which takes a *path*: the two are one character apart at a call site and mixing them up produces
 * a silently empty event log rather than an error, so they are kept distinct rather than
 * overloaded.
 */
function tryParseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

export class SessionLineageStore {
  readonly root: string;
  readonly #lineagesDir: string;
  readonly #tombstonesDir: string;
  readonly #quarantineDir: string;
  readonly #trashDir: string;
  readonly #manifestPath: string;

  readonly #retention: Required<RetentionPolicy>;
  readonly #now: () => Date;
  readonly #logger: Logger;

  readonly #lineages = new Map<string, Lineage>();
  /** sessionId -> rootId. The only index that makes a bare session id addressable. */
  readonly #sessionIndex = new Map<string, string>();
  readonly #tombstones = new Map<string, Tombstone>();
  /** sessionId -> terminal event already present in its log at load time. Startup-only scratch. */
  readonly #logTerminals = new Map<string, TerminalLogType>();

  constructor(options: SessionLineageStoreOptions) {
    this.root = join(options.stateRoot, STORE_DIR);
    this.#lineagesDir = join(this.root, 'lineages');
    this.#tombstonesDir = join(this.root, 'tombstones');
    this.#quarantineDir = join(this.root, 'quarantine');
    this.#trashDir = join(this.root, '.trash');
    this.#manifestPath = join(this.root, MANIFEST_FILE);

    this.#retention = {
      maxAgeMs: options.retention?.maxAgeMs ?? DEFAULT_RETENTION.maxAgeMs,
      maxRecords: options.retention?.maxRecords ?? DEFAULT_RETENTION.maxRecords,
      maxBytes: options.retention?.maxBytes ?? DEFAULT_RETENTION.maxBytes,
    };
    this.#now = options.now ?? (() => new Date());
    this.#logger = options.logger ?? noopLogger;

    // STOP CONDITION #1, and it runs before literally anything else, including directory creation.
    // See `UnsupportedStateSchemaVersionError`: if this throws, the tree is byte-identical to how
    // it was found.
    this.#preflightSchemaVersions();

    this.#ensureSkeleton();
    this.#quarantineStrayTemps();
    this.#loadManifest();
    this.#recoverInterruptedEvictions();
    this.#loadTombstones();
    this.#loadLineages();
    this.#recoverNonTerminalSessions();
    this.#enforceRetention(undefined);

    // Manifest last: its presence and correctness is the marker that a full, successful startup
    // pass completed. Writing it first would leave a valid-looking manifest over a tree that a
    // crash mid-recovery had left half-processed.
    atomicWriteJson(this.#manifestPath, { schemaVersion: 1 });
  }

  // -------------------------------------------------------------------------------------------
  // Startup
  // -------------------------------------------------------------------------------------------

  /**
   * A strictly read-only sweep for any `schemaVersion` this build does not understand.
   *
   * Deliberately dumb: it JSON-parses every candidate file and looks at one numeric field, with no
   * schema validation, no quarantining, and no repair. A cleverer version that (say) quarantined
   * unparseable files as it went would violate the guarantee this function exists to provide -- and
   * the test that pins it (`session-lineage-store.schema.test.ts`) asserts exactly that by
   * snapshotting file contents and mtimes and by spying for zero write/rename/unlink calls.
   *
   * Scans, in order: the manifest, every lineage metadata record, every tombstone, and any stray
   * `.tmp` file. A stray temp is included because it is the one place a *future* version's
   * half-written record can be sitting, and quarantining it (which is what happens to strays a few
   * lines later) would be a mutation on a tree we must not touch.
   */
  #preflightSchemaVersions(): void {
    if (!existsSync(this.root)) return;

    const candidates: string[] = [];

    if (existsSync(this.#manifestPath)) candidates.push(this.#manifestPath);

    for (const name of safeReaddir(this.root)) {
      if (name.endsWith('.tmp')) candidates.push(join(this.root, name));
    }

    for (const rootId of safeReaddir(this.#lineagesDir)) {
      const recordsDir = join(this.#lineagesDir, rootId, 'records');
      for (const name of safeReaddir(recordsDir)) {
        if (name.endsWith('.json') || name.endsWith('.tmp')) candidates.push(join(recordsDir, name));
      }
    }

    for (const name of safeReaddir(this.#tombstonesDir)) {
      if (name.endsWith('.json') || name.endsWith('.tmp')) candidates.push(join(this.#tombstonesDir, name));
    }

    for (const path of candidates) {
      const parsed = tryReadJson(path);
      if (!parsed || typeof parsed !== 'object') continue;
      const version = (parsed as { schemaVersion?: unknown }).schemaVersion;
      if (typeof version === 'number' && Number.isFinite(version) && version > 1) {
        throw new UnsupportedStateSchemaVersionError(version, path);
      }
    }
  }

  #ensureSkeleton(): void {
    for (const dir of [this.root, this.#lineagesDir, this.#tombstonesDir, this.#quarantineDir, this.#trashDir]) {
      mkdirSync(dir, { recursive: true, mode: 0o700 });
    }
  }

  /**
   * A `.tmp` left at the store root or beside a record means a previous process died between
   * `open` and `rename` in `atomicWriteJson`. The real file it would have replaced is untouched
   * (that is the point of the rename), so the temp carries no committed state -- but it is still
   * evidence, so it is quarantined rather than removed.
   */
  #quarantineStrayTemps(): void {
    const dirs = [this.root, this.#tombstonesDir];
    for (const rootId of safeReaddir(this.#lineagesDir)) {
      dirs.push(join(this.#lineagesDir, rootId, 'records'));
      dirs.push(join(this.#lineagesDir, rootId, 'events'));
    }
    for (const dir of dirs) {
      for (const name of safeReaddir(dir)) {
        if (!name.endsWith('.tmp')) continue;
        const path = join(dir, name);
        assertContainedIn(this.root, path);
        quarantine(path, this.#quarantineDir, 'stray-temp');
        this.#logger.warn('quarantined a stray temp file from an interrupted write', { path });
      }
    }
  }

  #loadManifest(): void {
    if (!existsSync(this.#manifestPath)) return;
    const parsed = tryReadJson(this.#manifestPath);
    const version = (parsed as { schemaVersion?: unknown } | undefined)?.schemaVersion;
    if (version === 1) return;
    // Not a future version (the preflight already ruled that out), so it is corrupt or truncated.
    // The manifest holds no session state, so rebuilding it loses nothing -- but the corrupt one is
    // still quarantined, because "the manifest was unreadable" is a fact a bug report wants.
    assertContainedIn(this.root, this.#manifestPath);
    quarantine(this.#manifestPath, this.#quarantineDir, 'corrupt-manifest');
    this.#logger.warn('quarantined a corrupt store manifest and rebuilt it', { path: this.#manifestPath });
  }

  /**
   * Completes or rolls back an eviction that a crash interrupted.
   *
   * The eviction protocol is: rename the lineage into `.trash/`, write the tombstone, delete the
   * trashed copy. The **tombstone write is the commit point**, so the state on disk is
   * unambiguous at every instant:
   *
   * - trash directory, no tombstone -> the crash happened before the commit. The eviction never
   *   happened; move the lineage back. Losing a lineage we had not committed to losing is the one
   *   outcome that would be silent data loss.
   * - trash directory, valid tombstone -> the crash happened after the commit. The eviction did
   *   happen; finish the cleanup.
   */
  #recoverInterruptedEvictions(): void {
    for (const name of safeReaddir(this.#trashDir)) {
      if (!name.startsWith(TRASH_PREFIX)) continue;
      const trashPath = join(this.#trashDir, name);
      assertContainedIn(this.#trashDir, trashPath);

      const rootId = name.slice(TRASH_PREFIX.length).split('--')[0] ?? '';
      const tombstonePath = join(this.#tombstonesDir, `${rootId}.json`);
      const committed = existsSync(tombstonePath) && this.#readTombstone(tombstonePath) !== undefined;

      if (committed) {
        rmSync(trashPath, { recursive: true, force: true });
        this.#logger.info('completed an interrupted lineage eviction', { rootSessionId: rootId });
        continue;
      }

      const restorePath = join(this.#lineagesDir, rootId);
      if (rootId.length === 0 || existsSync(restorePath)) {
        // Nothing safe to restore onto: quarantine rather than merge two trees or delete one.
        quarantine(trashPath, this.#quarantineDir, 'unrestorable-eviction');
        continue;
      }
      assertContainedIn(this.#lineagesDir, restorePath);
      renameSync(trashPath, restorePath);
      syncDirectory(this.#lineagesDir);
      this.#logger.warn('rolled back an uncommitted lineage eviction', { rootSessionId: rootId });
    }
  }

  #readTombstone(path: string): Tombstone | undefined {
    const parsed = tryReadJson(path);
    if (!parsed || typeof parsed !== 'object') return undefined;
    const candidate = parsed as Partial<Tombstone>;
    if (candidate.schemaVersion !== 1 || typeof candidate.rootSessionId !== 'string') return undefined;
    return candidate as Tombstone;
  }

  #loadTombstones(): void {
    for (const name of safeReaddir(this.#tombstonesDir)) {
      if (!name.endsWith('.json')) continue;
      const path = join(this.#tombstonesDir, name);
      const tombstone = this.#readTombstone(path);
      if (!tombstone) {
        assertContainedIn(this.root, path);
        quarantine(path, this.#quarantineDir, 'corrupt-tombstone');
        continue;
      }
      this.#tombstones.set(tombstone.rootSessionId, tombstone);
    }
  }

  #loadLineages(): void {
    for (const rootId of safeReaddir(this.#lineagesDir)) {
      const lineageDir = join(this.#lineagesDir, rootId);
      if (!statSync(lineageDir).isDirectory()) continue;

      const lineage: Lineage = { rootId, records: new Map(), linesOnDisk: new Map(), bytes: 0 };
      const recordsDir = join(lineageDir, 'records');

      let corrupt = false;
      for (const name of safeReaddir(recordsDir)) {
        if (!name.endsWith('.json')) continue;
        const path = join(recordsDir, name);
        const parsed = persistedSessionRecordV1Schema.safeParse(tryReadJson(path));
        if (!parsed.success) {
          corrupt = true;
          break;
        }
        lineage.records.set(parsed.data.session.id, parsed.data as PersistedSessionRecordV1);
      }

      if (corrupt || lineage.records.size === 0) {
        // A corrupt *metadata* record takes the whole lineage with it, unlike a corrupt event-log
        // tail. The record is what states the session's status, its accepted-work state, and its
        // parent link; without it the remaining files are an event log for a session we can make no
        // safety claim about, and keeping half a lineage would mean serving a record whose
        // `parentSessionId` may point at a session we cannot describe.
        assertContainedIn(this.#lineagesDir, lineageDir);
        const target = quarantine(lineageDir, this.#quarantineDir, corrupt ? 'corrupt-record' : 'empty-lineage');
        this.#logger.warn('quarantined a lineage', { rootSessionId: rootId, quarantinedTo: target });
        continue;
      }

      for (const [sessionId, record] of lineage.records) {
        const lines = this.#repairEventLog(lineageDir, sessionId);
        lineage.linesOnDisk.set(sessionId, lines.count);
        if (lines.terminalType !== undefined) this.#logTerminals.set(sessionId, lines.terminalType);
        // `eventCount` on disk is only checkpointed (see `appendEvent`), so the log is allowed to
        // be ahead of it after a crash. Taking the max keeps the counter monotonic rather than
        // letting a restart appear to lose events that are demonstrably on disk.
        record.session.eventCount = Math.max(record.session.eventCount, lines.count);
        if (lines.firstSequence !== undefined) record.session.earliestSequence = lines.firstSequence;
        this.#sessionIndex.set(sessionId, rootId);
      }

      lineage.bytes = this.#measureLineage(lineageDir);
      this.#lineages.set(rootId, lineage);
    }
  }

  /**
   * Validates one session's event log and truncates a bad tail.
   *
   * A torn tail is the *expected* crash artifact for an append-only log: `appendDurably` fsyncs
   * every line, but a process killed mid-`writeSync` can still leave a partial final line. Unlike a
   * corrupt metadata record, that costs nothing structural -- every line before it is intact and
   * self-describing -- so the log is truncated to the last good line and the removed bytes are
   * quarantined on their own. Out-of-order sequences are treated the same way: the log's ordering
   * is what paging depends on, so the first line that breaks it starts the bad tail.
   */
  #repairEventLog(lineageDir: string, sessionId: string): EventLogState {
    const logPath = join(lineageDir, 'events', `${sessionId}.jsonl`);
    if (!existsSync(logPath)) return { count: 0 };

    const raw = readFileSync(logPath, 'utf8');
    if (raw.length === 0) return { count: 0 };

    const lines = raw.split('\n');
    // A well-formed log always ends with a newline, so the final split element is an empty string.
    const hasTrailingNewline = lines[lines.length - 1] === '';
    if (hasTrailingNewline) lines.pop();

    let good = 0;
    let firstSequence: number | undefined;
    let terminalType: TerminalLogType | undefined;
    let lastSequence = -1;
    for (const line of lines) {
      const parsed = persistedEventRecordV1Schema.safeParse(tryParseJson(line));
      if (!parsed.success || parsed.data.sequence <= lastSequence) break;
      lastSequence = parsed.data.sequence;
      if (firstSequence === undefined) firstSequence = parsed.data.sequence;
      if (isTerminalLogType(parsed.data.type)) terminalType = parsed.data.type;
      good += 1;
    }

    if (good === lines.length && hasTrailingNewline) {
      return { count: good, firstSequence, terminalType };
    }

    const badTail = lines.slice(good).join('\n');
    const quarantinePath = join(
      this.#quarantineDir,
      `${sessionId}.jsonl.${randomUUID()}.torn-event-tail`,
    );
    mkdirSync(this.#quarantineDir, { recursive: true, mode: 0o700 });
    assertContainedIn(this.#quarantineDir, quarantinePath);
    writeFileSync(quarantinePath, badTail.length > 0 ? `${badTail}\n` : '', { mode: 0o600 });

    const rewritten = good === 0 ? '' : `${lines.slice(0, good).join('\n')}\n`;
    const tmpPath = `${logPath}.${process.pid}.${randomUUID()}.tmp`;
    writeFileSync(tmpPath, rewritten, { mode: 0o600 });
    assertContainedIn(this.root, logPath);
    renameSync(tmpPath, logPath);
    syncDirectory(join(lineageDir, 'events'));

    this.#logger.warn('truncated a torn event log to its last good line', {
      sessionId,
      keptLines: good,
      discardedLines: lines.length - good,
      quarantinedTo: quarantinePath,
    });

    return { count: good, firstSequence, terminalType };
  }

  /**
   * Closes out every session that was still `starting`/`running` when the previous daemon stopped.
   *
   * The one rule that matters here is what is **not** rewritten: `acceptedWork` is carried across
   * verbatim. A recovery pass has strictly less information about what the provider received than
   * the process that was watching it did, so it can only ever preserve or (never) weaken that
   * claim. Downgrading an `'accepted'` record to `'unknown'` would look harmless and would in fact
   * be the exact bug this store was built to prevent, one step removed.
   */
  #recoverNonTerminalSessions(): void {
    for (const lineage of this.#lineages.values()) {
      for (const [sessionId, record] of lineage.records) {
        const status = record.session.status;
        if (status !== 'starting' && status !== 'running') continue;

        const timestamp = this.#now().toISOString();
        const alreadyTerminal = this.#logTerminals.get(sessionId);

        if (alreadyTerminal !== undefined) {
          // The log outran the record's last checkpoint. Believe the log; see TERMINAL_LOG_OUTCOME.
          const outcome = TERMINAL_LOG_OUTCOME[alreadyTerminal];
          record.session.status = outcome.status;
          record.session.terminalReason = outcome.reason;
          record.session.completedAt ??= timestamp;
          this.#writeRecord(lineage, record);
          continue;
        }

        const lines = lineage.linesOnDisk.get(sessionId) ?? 0;
        const sequence = Math.max(record.session.eventCount, lines);

        if (lines < MAX_PERSISTED_EVENTS_PER_SESSION) {
          this.#appendLine(lineage, sessionId, interruptedEventRecord(sequence, timestamp));
        }
        record.session.eventCount = sequence + 1;
        record.session.status = 'interrupted';
        record.session.terminalReason = 'daemon_restart';
        record.session.completedAt = timestamp;
        this.#writeRecord(lineage, record);

        this.#logger.warn('recovered a session interrupted by a daemon restart', {
          sessionId,
          acceptedWork: record.session.acceptedWork,
        });
      }
    }
    this.#logTerminals.clear();
  }

  // -------------------------------------------------------------------------------------------
  // Paths and low-level writes
  // -------------------------------------------------------------------------------------------

  #lineageDir(rootId: string): string {
    const dir = join(this.#lineagesDir, rootId);
    assertContainedIn(this.#lineagesDir, dir);
    return dir;
  }

  #recordPath(rootId: string, sessionId: string): string {
    const path = join(this.#lineageDir(rootId), 'records', `${sessionId}.json`);
    assertContainedIn(this.root, path);
    return path;
  }

  #eventLogPath(rootId: string, sessionId: string): string {
    const path = join(this.#lineageDir(rootId), 'events', `${sessionId}.jsonl`);
    assertContainedIn(this.root, path);
    return path;
  }

  #writeRecord(lineage: Lineage, record: PersistedSessionRecordV1): void {
    const path = this.#recordPath(lineage.rootId, record.session.id);
    const before = fileSize(path);
    atomicWriteJson(path, record);
    lineage.bytes += fileSize(path) - before;
  }

  #appendLine(lineage: Lineage, sessionId: string, entry: PersistedEventRecordV1): void {
    const path = this.#eventLogPath(lineage.rootId, sessionId);
    const line = JSON.stringify(entry);
    appendDurably(path, line);
    lineage.bytes += Buffer.byteLength(line, 'utf8') + 1;
    lineage.linesOnDisk.set(sessionId, (lineage.linesOnDisk.get(sessionId) ?? 0) + 1);
  }

  #measureLineage(lineageDir: string): number {
    let total = 0;
    for (const sub of ['records', 'events']) {
      const dir = join(lineageDir, sub);
      for (const name of safeReaddir(dir)) total += fileSize(join(dir, name));
    }
    return total;
  }

  // -------------------------------------------------------------------------------------------
  // Retention and eviction
  // -------------------------------------------------------------------------------------------

  /** A lineage with any non-terminal member is in use by a live session and is never evictable. */
  #isActive(lineage: Lineage): boolean {
    for (const record of lineage.records.values()) {
      if (record.session.status === 'starting' || record.session.status === 'running') return true;
    }
    return false;
  }

  /** The most recent moment anything happened in this lineage; the sort key for eviction order. */
  #lineageRecency(lineage: Lineage): number {
    let newest = 0;
    for (const record of lineage.records.values()) {
      const stamp = Date.parse(record.session.completedAt ?? record.session.startedAt);
      if (Number.isFinite(stamp) && stamp > newest) newest = stamp;
    }
    return newest;
  }

  #recordCount(): number {
    let total = 0;
    for (const lineage of this.#lineages.values()) total += lineage.records.size;
    return total;
  }

  #totalBytes(): number {
    let total = 0;
    for (const lineage of this.#lineages.values()) total += lineage.bytes;
    return total;
  }

  #evictionCandidates(excludedRootId: string | undefined): Lineage[] {
    return [...this.#lineages.values()]
      .filter((lineage) => lineage.rootId !== excludedRootId && !this.#isActive(lineage))
      .sort((a, b) => this.#lineageRecency(a) - this.#lineageRecency(b));
  }

  /**
   * Applies age first, then the record-count quota, then the byte quota -- in that order because
   * they answer different questions. Age is a *promise to the user* about how long anything is kept
   * (see docs/privacy.md); the quotas are protection against unbounded growth. Enforcing a quota
   * before age could evict something inside the retention window while something older, and
   * therefore due for deletion anyway, survived.
   */
  #enforceRetention(excludedRootId: string | undefined): void {
    const nowMs = this.#now().getTime();

    for (const lineage of this.#evictionCandidates(excludedRootId)) {
      const recency = this.#lineageRecency(lineage);
      if (recency > 0 && nowMs - recency > this.#retention.maxAgeMs) {
        this.#evictLineage(lineage, 'retention_age');
      }
    }

    while (this.#recordCount() > this.#retention.maxRecords) {
      const victim = this.#evictionCandidates(excludedRootId)[0];
      if (!victim) return;
      this.#evictLineage(victim, 'quota_records');
    }

    while (this.#totalBytes() > this.#retention.maxBytes) {
      const victim = this.#evictionCandidates(excludedRootId)[0];
      if (!victim) return;
      this.#evictLineage(victim, 'quota_bytes');
    }
  }

  /**
   * Frees room for exactly one more record, or throws `StorageFullError`.
   *
   * Called by `create()` *before* the provider process is started, which is the whole reason it is
   * a throw rather than a best-effort trim: a caller that has already spawned a CLI cannot
   * un-spawn it, so the only moment "there is no room to record this" can be reported safely is
   * before anything irreversible has happened.
   */
  #makeRoomForOneMore(excludedRootId: string): void {
    this.#enforceRetention(excludedRootId);

    while (this.#recordCount() + 1 > this.#retention.maxRecords) {
      const victim = this.#evictionCandidates(excludedRootId)[0];
      if (!victim) {
        throw new StorageFullError(
          `cannot record a new session: ${this.#recordCount()} of ${this.#retention.maxRecords} ` +
            'retained records are all active or excluded from eviction',
        );
      }
      this.#evictLineage(victim, 'quota_records');
    }

    while (this.#totalBytes() >= this.#retention.maxBytes) {
      const victim = this.#evictionCandidates(excludedRootId)[0];
      if (!victim) {
        throw new StorageFullError(
          `cannot record a new session: the store is at its ${this.#retention.maxBytes}-byte budget ` +
            'and every retained lineage is active or excluded from eviction',
        );
      }
      this.#evictLineage(victim, 'quota_bytes');
    }
  }

  /**
   * Two-phase eviction. See `#recoverInterruptedEvictions` for why the tombstone write, and not the
   * rename or the delete, is the commit point.
   */
  #evictLineage(lineage: Lineage, reason: Tombstone['reason']): void {
    const lineageDir = this.#lineageDir(lineage.rootId);
    const trashPath = join(this.#trashDir, `${TRASH_PREFIX}${lineage.rootId}--${randomUUID()}`);
    assertContainedIn(this.#trashDir, trashPath);

    if (existsSync(lineageDir)) {
      renameSync(lineageDir, trashPath);
      syncDirectory(this.#trashDir);
    }

    const tombstone: Tombstone = {
      schemaVersion: 1,
      rootSessionId: lineage.rootId,
      evictedAt: this.#now().toISOString(),
      reason,
      sessionIds: [...lineage.records.keys()],
      records: lineage.records.size,
      bytes: lineage.bytes,
    };
    atomicWriteJson(join(this.#tombstonesDir, `${lineage.rootId}.json`), tombstone);

    if (existsSync(trashPath)) rmSync(trashPath, { recursive: true, force: true });

    this.#tombstones.set(lineage.rootId, tombstone);
    for (const sessionId of lineage.records.keys()) this.#sessionIndex.delete(sessionId);
    this.#lineages.delete(lineage.rootId);

    this.#logger.info('evicted a session lineage', {
      rootSessionId: lineage.rootId,
      reason,
      records: tombstone.records,
    });
  }

  // -------------------------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------------------------

  /**
   * Records a new session, attaching it to an existing lineage when it resumes one.
   *
   * The initial `acceptedWork` is always `'unknown'`, never `'not_accepted'` -- see
   * `PersistedAcceptedWork` for the full reasoning. In short: `'not_accepted'` is a claim that
   * retrying is safe, and by the time this record exists the daemon is already committed to
   * launching a provider, so that claim can no longer be made.
   */
  create(session: AgentSession, options: CreateSessionRecordOptions): PersistedSessionRecordV1 {
    const parent = options.resumeProviderSessionId
      ? this.#findByProviderSessionId(options.resumeProviderSessionId)
      : undefined;

    const rootId = parent?.session.rootSessionId ?? session.id;
    this.#makeRoomForOneMore(rootId);

    const record = redactSessionForPersistence(session, {
      protocolVersion: options.protocolVersion,
      status: 'starting',
      acceptedWork: 'unknown',
      rootSessionId: rootId,
      ...(parent === undefined ? {} : { parentSessionId: parent.session.id }),
      continuationKind: parent === undefined ? 'fresh' : 'resume',
      earliestSequence: 0,
      eventCount: 0,
      eventsTruncated: false,
      scope: options.scope,
      unknownFrames: [],
    });

    let lineage = this.#lineages.get(rootId);
    if (!lineage) {
      lineage = { rootId, records: new Map(), linesOnDisk: new Map(), bytes: 0 };
      this.#lineages.set(rootId, lineage);
    }
    mkdirSync(join(this.#lineageDir(rootId), 'records'), { recursive: true, mode: 0o700 });
    mkdirSync(join(this.#lineageDir(rootId), 'events'), { recursive: true, mode: 0o700 });

    lineage.records.set(session.id, record);
    lineage.linesOnDisk.set(session.id, 0);
    this.#sessionIndex.set(session.id, rootId);
    this.#writeRecord(lineage, record);

    return record;
  }

  #findByProviderSessionId(providerSessionId: string): PersistedSessionRecordV1 | undefined {
    for (const lineage of this.#lineages.values()) {
      for (const record of lineage.records.values()) {
        if (record.session.providerSessionId === providerSessionId) return record;
      }
    }
    return undefined;
  }

  /**
   * Persists one event, redacted.
   *
   * Past `MAX_PERSISTED_EVENTS_PER_SESSION` no further lines are written, but `eventCount` keeps
   * incrementing and `eventsTruncated` flips to `true`. That combination is what lets a reader tell
   * "this session emitted 5,000 events" apart from "this session emitted 40,000 events and we kept
   * the first 5,000" -- a distinction a plain line count silently erases.
   *
   * The metadata record is rewritten only at checkpoints (the truncation flip, accepted-work,
   * finalization), not once per event: an atomic replace plus two fsyncs per event would dominate
   * the cost of running a session, and the log itself is already durable per line. Recovery takes
   * `max(persisted eventCount, lines on disk)`, so a crash between checkpoints under-reports
   * nothing.
   */
  appendEvent(sessionId: string, event: AgentEventEnvelope): void {
    const located = this.#locate(sessionId);
    if (!located) return;
    const { lineage, record } = located;

    const lines = lineage.linesOnDisk.get(sessionId) ?? 0;
    if (lines < MAX_PERSISTED_EVENTS_PER_SESSION) {
      this.#appendLine(lineage, sessionId, redactEnvelope(event));
    } else if (!record.session.eventsTruncated) {
      record.session.eventsTruncated = true;
      this.#writeRecord(lineage, record);
      this.#logger.warn('persisted event log is full; further events are counted but not stored', { sessionId });
    }

    record.session.eventCount += 1;
  }

  /**
   * The only permitted on-disk accepted-work transition: `unknown -> accepted`.
   *
   * Anything else is refused rather than applied. The signature only admits `'accepted'`, so a
   * downgrade is not expressible from TypeScript at all; the runtime guard covers a caller reaching
   * this through an untyped path, and a repeat call is a no-op rather than a redundant fsync.
   */
  markAcceptedWork(sessionId: string, state: 'accepted'): void {
    const located = this.#locate(sessionId);
    if (!located) return;
    const { lineage, record } = located;
    if ((state as string) !== 'accepted') return;
    if (record.session.acceptedWork === 'accepted') return;
    record.session.acceptedWork = 'accepted';
    this.#writeRecord(lineage, record);
  }

  /** Records a session's terminal state. Never touches `acceptedWork`. */
  finalize(sessionId: string, status: SessionStatusV2, terminalReason: TerminalReasonV2): void {
    const located = this.#locate(sessionId);
    if (!located) return;
    const { lineage, record } = located;
    record.session.status = status;
    record.session.terminalReason = terminalReason;
    record.session.completedAt = this.#now().toISOString();
    this.#writeRecord(lineage, record);
  }

  /** Records the provider-native thread id, which is what a later resume attaches a lineage by. */
  setProviderSessionId(sessionId: string, providerSessionId: string): void {
    const located = this.#locate(sessionId);
    if (!located) return;
    const { lineage, record } = located;
    if (record.session.providerSessionId === providerSessionId) return;
    record.session.providerSessionId = providerSessionId;
    this.#writeRecord(lineage, record);
  }

  /**
   * Replaces a session's frozen launch scope.
   *
   * Exists because `SessionManager.create()` is synchronous by design (see
   * `ActiveSessionLimiter`), while the executable path, CLI version, and auth state all come from
   * `provider.detect()`, which is not. The record is therefore written first with the
   * conservatively-unknown scope every synchronous caller can honestly assert, and refined once
   * detection resolves. A refinement that never arrives leaves `authenticated: 'unknown'`, which is
   * the correct fail-closed answer rather than an optimistic guess.
   */
  setScope(sessionId: string, scope: PersistedLaunchScope): void {
    const located = this.#locate(sessionId);
    if (!located) return;
    const { lineage, record } = located;
    record.session.scope = scope;
    this.#writeRecord(lineage, record);
  }

  /** Records the bounded, content-free unknown-frame ledger for a session. */
  setUnknownFrames(sessionId: string, frames: readonly NormalizedUnknownFrame[]): void {
    const located = this.#locate(sessionId);
    if (!located) return;
    const { lineage, record } = located;
    record.session.unknownFrames = [...frames];
    this.#writeRecord(lineage, record);
  }

  #locate(sessionId: string): { lineage: Lineage; record: PersistedSessionRecordV1 } | undefined {
    const rootId = this.#sessionIndex.get(sessionId);
    if (!rootId) return undefined;
    const lineage = this.#lineages.get(rootId);
    const record = lineage?.records.get(sessionId);
    if (!lineage || !record) return undefined;
    return { lineage, record };
  }

  get(sessionId: string): PersistedSessionRecordV1 | undefined {
    return this.#locate(sessionId)?.record;
  }

  /** Every retained record, newest-first. The ordering listing and paging both derive from. */
  #allRecordsNewestFirst(): PersistedSessionRecordV1[] {
    const all: PersistedSessionRecordV1[] = [];
    for (const lineage of this.#lineages.values()) all.push(...lineage.records.values());
    return all.sort((a, b) => {
      const delta = Date.parse(b.session.startedAt) - Date.parse(a.session.startedAt);
      // Ids break ties so the order is total and therefore stable across calls -- without that, a
      // cursor could skip or repeat a record whenever two sessions share a millisecond.
      return delta !== 0 ? delta : a.session.id.localeCompare(b.session.id);
    });
  }

  listSessions(options: { cursor?: string; limit?: number } = {}): SessionPage {
    const limit = options.limit ?? 50;
    const all = this.#allRecordsNewestFirst();

    let start = 0;
    if (options.cursor !== undefined) {
      const afterId = decodeCursor(options.cursor);
      const index = all.findIndex((record) => record.session.id === afterId);
      if (index === -1) throw new InvalidCursorError();
      start = index + 1;
    }

    const page = all.slice(start, start + limit);
    const hasMore = start + limit < all.length;
    const last = page[page.length - 1];
    return hasMore && last
      ? { sessions: page, nextCursor: encodeCursor(last.session.id) }
      : { sessions: page };
  }

  listEvents(sessionId: string, options: { cursor?: string; limit?: number } = {}): EventPage {
    const located = this.#locate(sessionId);
    if (!located) return { events: [] };
    const limit = options.limit ?? 50;

    const logPath = this.#eventLogPath(located.lineage.rootId, sessionId);
    if (!existsSync(logPath)) return { events: [] };

    const events: PersistedEventRecordV1[] = [];
    for (const line of readFileSync(logPath, 'utf8').split('\n')) {
      if (line.length === 0) continue;
      const parsed = persistedEventRecordV1Schema.safeParse(tryParseJson(line));
      if (!parsed.success) break;
      events.push(parsed.data as PersistedEventRecordV1);
    }

    let start = 0;
    if (options.cursor !== undefined) {
      const afterSequence = Number(decodeCursor(options.cursor));
      const index = events.findIndex((event) => event.sequence === afterSequence);
      if (!Number.isFinite(afterSequence) || index === -1) throw new InvalidCursorError();
      start = index + 1;
    }

    const page = events.slice(start, start + limit);
    const hasMore = start + limit < events.length;
    const last = page[page.length - 1];
    return hasMore && last
      ? { events: page, nextCursor: encodeCursor(String(last.sequence)) }
      : { events: page };
  }

  stats(): StoreStats {
    return { lineages: this.#lineages.size, records: this.#recordCount(), bytes: this.#totalBytes() };
  }

  /** Every retained record, for daemon startup to hydrate the v1 in-memory view from. */
  allRecords(): PersistedSessionRecordV1[] {
    return this.#allRecordsNewestFirst();
  }
}
