import { createHash } from 'node:crypto';
import { postingContentHash } from '@open-vacancy-radar/vacancy-engine';
import { and, desc, eq, inArray, isNull, ne, sql } from 'drizzle-orm';
import { syncApplicationForAttempt } from './attempt-application-sync.js';
import type { WorkspaceDb } from './client.js';
import { applicationAttempts, applicationPostingVerifications } from './schema.js';
import type { ApplicationAttemptCheckpoint, PreparedApplicationFields } from './types.js';

/**
 * Persistence for #687's posting checks. Every write here is one transaction that re-reads the
 * attempt, so a check that finished after the attempt was cancelled, submitted, or moved on writes
 * nothing, and an observation older than the stored one never replaces it.
 *
 * `jdSnapshot` / `jdSnapshotHash` are changed by exactly one function in this file,
 * `adoptPostingChange`, and only for an attempt that has never been submitted. Submitted,
 * `user_reported`, `submitting` and `submission_unknown` attempts are refused by every function
 * here: a live posting changing or closing never reaches a historical package.
 *
 * A prepared package is never deleted or regenerated here. A closed/changed finding may HOLD one
 * (take it out of review while the person decides): the attempt's checkpoint, detail and prepared
 * answers are copied onto the finding row in the same transaction and put back unchanged by Keep /
 * Get ready anyway, or by a later check that finds the posting open and unchanged. Only the explicit
 * Refresh (`adoptPostingChange` + the existing restart) replaces the package.
 *
 * Retention: at most `POSTING_VERIFICATION_ROWS_PER_ATTEMPT` rows per attempt, plus every row that
 * carries a decision, a hold or the open finding; a changed posting's full text is kept only while
 * nobody has decided about it.
 */

export type PostingVerificationResult =
  | 'confirmed_open'
  | 'confirmed_closed'
  | 'materially_changed'
  | 'unable_to_verify';
export type PostingVerificationResolution = 'refreshed' | 'prepare_anyway' | 'keep_current' | 'superseded';
export type PostingVerificationOutcome = 'open' | 'closed' | 'unable';

/** Newest rows kept per attempt; older ones are pruned unless they carry a decision or a hold. */
export const POSTING_VERIFICATION_ROWS_PER_ATTEMPT = 12;

export interface PostingChangeSummary {
  added: string[];
  removed: string[];
  /** `requirements`: requirement-bearing lines changed; `text`: a large rewrite with no requirement signal. */
  kind?: 'requirements' | 'text';
  /** The comparison hit its fixed work budget (unpaired lines counted as changed). */
  bounded?: boolean;
}

export interface PostingVerificationRecord {
  id: string;
  attemptId: string;
  /** ISO-8601: when the authority was actually contacted, never the time of a later reuse. */
  observedAt: string;
  source: string;
  sourceRef: string;
  outcome: PostingVerificationOutcome;
  result: PostingVerificationResult;
  reason: string;
  httpStatus: number | null;
  contentHash: string | null;
  contentVersion: number;
  baselineHash: string;
  deadline: string | null;
  deadlineProvenance: { source: 'posting_text'; excerpt: string } | null;
  etag: string | null;
  lastModified: string | null;
  changeSummary: PostingChangeSummary | null;
  /** Whether the changed text is retained for a refresh (the text itself is never sent to the renderer). */
  hasObservedText: boolean;
  resolution: PostingVerificationResolution | null;
  resolvedAt: string | null;
  /** This finding currently holds a prepared package out of review. */
  held: boolean;
}

/** Attempts a posting check may never read or write: a submission was (or may have been) made. */
const HISTORICAL_CHECKPOINTS: readonly ApplicationAttemptCheckpoint[] = [
  'submitting',
  'submitted',
  'submission_unknown',
  'user_reported',
  'skipped',
];

export function isHistoricalAttempt(attempt: { checkpoint: ApplicationAttemptCheckpoint; submittedAt: unknown }): boolean {
  return attempt.submittedAt != null || HISTORICAL_CHECKPOINTS.includes(attempt.checkpoint);
}

type Row = typeof applicationPostingVerifications.$inferSelect;
type AttemptRow = typeof applicationAttempts.$inferSelect;
type Tx = Pick<WorkspaceDb, 'select' | 'update' | 'insert' | 'delete'>;

const FINDING_RESULTS: readonly PostingVerificationResult[] = ['confirmed_closed', 'materially_changed'];

function toRecord(row: Row): PostingVerificationRecord {
  return {
    id: row.id,
    attemptId: row.attemptId,
    observedAt: row.observedAt.toISOString(),
    source: row.source,
    sourceRef: row.sourceRef,
    outcome: row.outcome,
    result: row.result,
    reason: row.reason,
    httpStatus: row.httpStatus,
    contentHash: row.contentHash,
    contentVersion: row.contentVersion,
    baselineHash: row.baselineHash,
    deadline: row.deadline,
    deadlineProvenance: row.deadlineProvenance ?? null,
    etag: row.etag,
    lastModified: row.lastModified,
    changeSummary: row.changeSummary ?? null,
    hasObservedText: row.observedText !== null && row.observedText.length > 0,
    resolution: row.resolution,
    resolvedAt: row.resolvedAt ? row.resolvedAt.toISOString() : null,
    held: row.heldCheckpoint !== null,
  };
}

const NEWEST_FIRST = [desc(applicationPostingVerifications.observedAt), desc(sql`rowid`)] as const;

function latestRow(db: Pick<WorkspaceDb, 'select'>, attemptId: string): Row | undefined {
  return db
    .select()
    .from(applicationPostingVerifications)
    .where(eq(applicationPostingVerifications.attemptId, attemptId))
    .orderBy(...NEWEST_FIRST)
    .limit(1)
    .get();
}

/** The newest row that actually answered (open, closed or changed); "could not check" rows are skipped. */
function newestDefinitiveRow(db: Pick<WorkspaceDb, 'select'>, attemptId: string): Row | undefined {
  return db
    .select()
    .from(applicationPostingVerifications)
    .where(
      and(
        eq(applicationPostingVerifications.attemptId, attemptId),
        ne(applicationPostingVerifications.result, 'unable_to_verify'),
      ),
    )
    .orderBy(...NEWEST_FIRST)
    .limit(1)
    .get();
}

/**
 * The finding still waiting for the person: the newest definitive row, if it is a closure or a change
 * nobody has decided about. A later "could not check" never replaces it; a later answer does.
 */
function pendingRow(db: Pick<WorkspaceDb, 'select'>, attemptId: string): Row | undefined {
  const row = newestDefinitiveRow(db, attemptId);
  return row && row.resolution === null && FINDING_RESULTS.includes(row.result) ? row : undefined;
}

function heldRow(db: Pick<WorkspaceDb, 'select'>, attemptId: string): Row | undefined {
  return db
    .select()
    .from(applicationPostingVerifications)
    .where(
      and(
        eq(applicationPostingVerifications.attemptId, attemptId),
        sql`${applicationPostingVerifications.heldCheckpoint} is not null`,
      ),
    )
    .orderBy(...NEWEST_FIRST)
    .limit(1)
    .get();
}

export function getLatestPostingVerification(db: WorkspaceDb, attemptId: string): PostingVerificationRecord | null {
  const row = latestRow(db, attemptId);
  return row ? toRecord(row) : null;
}

export function getNewestDefinitivePostingVerification(db: WorkspaceDb, attemptId: string): PostingVerificationRecord | null {
  const row = newestDefinitiveRow(db, attemptId);
  return row ? toRecord(row) : null;
}

export function getPendingPostingFinding(db: WorkspaceDb, attemptId: string): PostingVerificationRecord | null {
  const row = pendingRow(db, attemptId);
  return row ? toRecord(row) : null;
}

export function listPostingVerifications(db: WorkspaceDb, attemptId: string): PostingVerificationRecord[] {
  return db
    .select()
    .from(applicationPostingVerifications)
    .where(eq(applicationPostingVerifications.attemptId, attemptId))
    .orderBy(...NEWEST_FIRST)
    .all()
    .map(toRecord);
}

/** Whether an attempt is a prepared package a closed/changed finding should take out of review. */
export type PreparedPackagePredicate = (attempt: { checkpoint: ApplicationAttemptCheckpoint; checkpointDetail: string }) => boolean;

export interface PostingHoldRequest {
  /** True for an attempt holding documents ready to use (a ready review or a manual hand-off). */
  isPreparedPackage: PreparedPackagePredicate;
  /** The sentence the held attempt shows while the person decides (one per finding kind). */
  detailFor: (result: 'confirmed_closed' | 'materially_changed') => string;
  /**
   * Whether a `needs_user` detail is a sentence this module wrote because PREPARATION stopped on a
   * posting finding (nothing was prepared, so there is no package to hold).
   */
  isPreparationStop: (detail: string) => boolean;
  /** What such a stop says once a definitive answer found the posting open again. */
  reopenedDetail: string;
}

export interface RecordPostingVerificationInput {
  attemptId: string;
  /** The write is refused unless the attempt is still at one of these checkpoints. */
  allowedCheckpoints: readonly ApplicationAttemptCheckpoint[];
  observedAt: Date;
  source: string;
  sourceRef: string;
  outcome: PostingVerificationOutcome;
  result: PostingVerificationResult;
  reason: string;
  httpStatus: number | null;
  contentHash: string | null;
  baselineHash: string;
  deadline: string | null;
  deadlineProvenance: { source: 'posting_text'; excerpt: string } | null;
  etag: string | null;
  lastModified: string | null;
  changeSummary: PostingChangeSummary | null;
  observedText: string | null;
  /**
   * When given, an open (undecided) closed/changed finding takes a prepared package out of review in
   * this same transaction, and a later open+unchanged answer releases a package held earlier.
   * Attempts waiting for any other reason are never touched.
   */
  hold?: PostingHoldRequest;
}

export type PostingHoldEffect =
  /** A prepared package was taken out of review by this finding. */
  | 'held'
  /** A newer finding took over a package an older finding held (it stays out of review). */
  | 'moved'
  /** The posting is open and unchanged again: the held package was put back exactly as it was. */
  | 'released'
  | null;

export type RecordPostingVerificationOutcome =
  | { written: 'inserted' | 'refreshed'; record: PostingVerificationRecord; hold: PostingHoldEffect }
  /** A newer observation already exists; the stored one is returned unchanged. */
  | { written: 'dropped_older'; record: PostingVerificationRecord; hold: null }
  /** The attempt is gone, historical, or no longer at an allowed checkpoint: nothing was written. */
  | { written: 'refused'; record: PostingVerificationRecord | null; hold: null };

function sameState(row: Row, input: RecordPostingVerificationInput): boolean {
  return (
    row.outcome === input.outcome &&
    row.result === input.result &&
    row.reason === input.reason &&
    row.contentHash === input.contentHash &&
    row.baselineHash === input.baselineHash
  );
}

function restoreFromHold(tx: Tx, attempt: AttemptRow, row: Row): boolean {
  if (row.heldCheckpoint === null) return false;
  // Only an attempt still waiting on this very decision gets its package back; one the person has
  // since re-prepared, skipped or sent is left exactly as it is now.
  if (isHistoricalAttempt(attempt) || attempt.checkpoint !== 'needs_user') return false;
  tx.update(applicationAttempts)
    .set({
      checkpoint: row.heldCheckpoint as ApplicationAttemptCheckpoint,
      checkpointDetail: row.heldCheckpointDetail ?? '',
      preparedFields: row.heldPreparedFields ?? null,
      updatedAt: new Date(),
    })
    .where(eq(applicationAttempts.id, attempt.id))
    .run();
  syncApplicationForAttempt(tx as WorkspaceDb, attempt.id);
  return true;
}

/**
 * Keeps the sentence of a preparation stop truthful after a definitive answer. Only the detail text of
 * an attempt that is `needs_user` at one of this module's own stop sentences is rewritten: checkpoint,
 * prepared answers, artifacts, snapshot and queue are never touched, and an attempt waiting for any
 * other reason (a question, a letter, a failure) or a package held by a finding is left exactly as it
 * is. An undecided finding keeps the attempt stopped, with the sentence for ITS kind; a posting that is
 * open again turns the stop into an invitation to prepare, which only the person's own action starts.
 */
function retargetPreparationStop(
  tx: Tx,
  attemptId: string,
  hold: PostingHoldRequest,
  result: PostingVerificationResult,
  written: Row,
): void {
  const current = tx.select().from(applicationAttempts).where(eq(applicationAttempts.id, attemptId)).get();
  if (!current || isHistoricalAttempt(current) || current.checkpoint !== 'needs_user') return;
  if (!hold.isPreparationStop(current.checkpointDetail)) return;
  const pending = pendingRow(tx, attemptId);
  let next: string | null = null;
  if (pending) {
    next = hold.detailFor(pending.result === 'confirmed_closed' ? 'confirmed_closed' : 'materially_changed');
  } else if (result === 'confirmed_open' && written.resolution === null) {
    next = hold.reopenedDetail;
  }
  if (next === null || next === current.checkpointDetail) return;
  tx.update(applicationAttempts)
    .set({ checkpointDetail: next, updatedAt: new Date() })
    .where(eq(applicationAttempts.id, attemptId))
    .run();
  syncApplicationForAttempt(tx as WorkspaceDb, attemptId);
}

const CLEARED_HOLD = { heldCheckpoint: null, heldCheckpointDetail: null, heldPreparedFields: null } as const;

/** Bounded retention: newest rows plus every row that carries a decision, a hold or the open finding. */
function prune(tx: Tx, attemptId: string): void {
  const rows = tx
    .select({
      id: applicationPostingVerifications.id,
      result: applicationPostingVerifications.result,
      resolution: applicationPostingVerifications.resolution,
      heldCheckpoint: applicationPostingVerifications.heldCheckpoint,
    })
    .from(applicationPostingVerifications)
    .where(eq(applicationPostingVerifications.attemptId, attemptId))
    .orderBy(...NEWEST_FIRST)
    .all();
  if (rows.length <= POSTING_VERIFICATION_ROWS_PER_ATTEMPT) return;
  const newestDefinitive = rows.find((row) => row.result !== 'unable_to_verify')?.id;
  const removable = rows
    .slice(POSTING_VERIFICATION_ROWS_PER_ATTEMPT)
    .filter(
      (row) =>
        row.id !== newestDefinitive &&
        row.heldCheckpoint === null &&
        (row.resolution === null || row.resolution === 'superseded'),
    )
    .map((row) => row.id);
  if (removable.length > 0) {
    tx.delete(applicationPostingVerifications).where(inArray(applicationPostingVerifications.id, removable)).run();
  }
}

export function recordPostingVerification(
  db: WorkspaceDb,
  input: RecordPostingVerificationInput,
): RecordPostingVerificationOutcome {
  return db.transaction((tx) => {
    const attempt = tx.select().from(applicationAttempts).where(eq(applicationAttempts.id, input.attemptId)).get();
    const latest = latestRow(tx, input.attemptId);
    if (!attempt || isHistoricalAttempt(attempt) || !input.allowedCheckpoints.includes(attempt.checkpoint)) {
      return { written: 'refused', record: latest ? toRecord(latest) : null, hold: null };
    }
    if (latest && latest.observedAt.getTime() > input.observedAt.getTime()) {
      return { written: 'dropped_older', record: toRecord(latest), hold: null };
    }
    const definitive = input.result !== 'unable_to_verify';
    let hold: PostingHoldEffect = null;
    let row: Row;
    let written: 'inserted' | 'refreshed';

    // A repeat of the same answer refreshes the row that gave it (the newest answer for definitive
    // results, so a "could not check" in between neither duplicates it nor resets a decision).
    const target = definitive ? newestDefinitiveRow(tx, input.attemptId) : latest;
    if (target && sameState(target, input)) {
      const [updated] = tx
        .update(applicationPostingVerifications)
        .set({
          observedAt: input.observedAt,
          httpStatus: input.httpStatus,
          deadline: input.deadline,
          deadlineProvenance: input.deadlineProvenance,
          etag: input.etag ?? target.etag,
          lastModified: input.lastModified ?? target.lastModified,
        })
        .where(eq(applicationPostingVerifications.id, target.id))
        .returning()
        .all();
      row = updated ?? target;
      written = 'refreshed';
    } else {
      const prior = tx
        .select({ contentHash: applicationPostingVerifications.contentHash, contentVersion: applicationPostingVerifications.contentVersion })
        .from(applicationPostingVerifications)
        .where(eq(applicationPostingVerifications.attemptId, input.attemptId))
        .all();
      const known = input.contentHash === null ? undefined : prior.find((entry) => entry.contentHash === input.contentHash);
      const highest = prior.reduce((max, entry) => Math.max(max, entry.contentVersion), 1);
      // The snapshot the work was prepared against is version 1; every other distinct text counts up.
      const contentVersion =
        input.contentHash === null
          ? (latest?.contentVersion ?? 1)
          : (known?.contentVersion ?? (input.contentHash === input.baselineHash && prior.length === 0 ? 1 : highest + 1));
      const [inserted] = tx
        .insert(applicationPostingVerifications)
        .values({
          attemptId: input.attemptId,
          observedAt: input.observedAt,
          source: input.source,
          sourceRef: input.sourceRef,
          outcome: input.outcome,
          result: input.result,
          reason: input.reason,
          httpStatus: input.httpStatus,
          contentHash: input.contentHash,
          contentVersion,
          baselineHash: input.baselineHash,
          deadline: input.deadline,
          deadlineProvenance: input.deadlineProvenance,
          etag: input.etag,
          lastModified: input.lastModified,
          changeSummary: input.changeSummary,
          observedText: FINDING_RESULTS.includes(input.result) ? input.observedText : null,
        })
        .returning()
        .all();
      if (!inserted) throw new Error('posting verification was not stored');
      row = inserted;
      written = 'inserted';

      if (definitive) {
        // A newer answer supersedes every older finding nobody decided about; their full text goes.
        const superseded = tx
          .select()
          .from(applicationPostingVerifications)
          .where(
            and(
              eq(applicationPostingVerifications.attemptId, input.attemptId),
              ne(applicationPostingVerifications.id, row.id),
              isNull(applicationPostingVerifications.resolution),
              inArray(applicationPostingVerifications.result, [...FINDING_RESULTS]),
            ),
          )
          .all();
        const previousHold = superseded.find((entry) => entry.heldCheckpoint !== null) ?? heldRow(tx, input.attemptId);
        if (superseded.length > 0) {
          tx.update(applicationPostingVerifications)
            .set({ resolution: 'superseded', resolvedAt: new Date(), observedText: null })
            .where(inArray(applicationPostingVerifications.id, superseded.map((entry) => entry.id)))
            .run();
        }
        if (previousHold && previousHold.id !== row.id) {
          tx.update(applicationPostingVerifications)
            .set(CLEARED_HOLD)
            .where(eq(applicationPostingVerifications.id, previousHold.id))
            .run();
          if (FINDING_RESULTS.includes(input.result)) {
            // Still closed / changed (differently): the package stays out of review under the new finding.
            const [moved] = tx
              .update(applicationPostingVerifications)
              .set({
                heldCheckpoint: previousHold.heldCheckpoint,
                heldCheckpointDetail: previousHold.heldCheckpointDetail,
                heldPreparedFields: previousHold.heldPreparedFields,
              })
              .where(eq(applicationPostingVerifications.id, row.id))
              .returning()
              .all();
            row = moved ?? row;
            hold = 'moved';
          } else if (input.result === 'confirmed_open') {
            // Open, and not materially different from what the package was prepared from: nothing is
            // left to decide, so the package goes back exactly as it was.
            hold = restoreFromHold(tx, attempt, previousHold) ? 'released' : null;
          }
        }
      }
      prune(tx, input.attemptId);
    }

    // Take a prepared package out of review while an undecided closure/change waits for the person.
    if (
      input.hold &&
      row.resolution === null &&
      row.heldCheckpoint === null &&
      (row.result === 'confirmed_closed' || row.result === 'materially_changed')
    ) {
      const current = tx.select().from(applicationAttempts).where(eq(applicationAttempts.id, input.attemptId)).get();
      if (current && !isHistoricalAttempt(current) && input.hold.isPreparedPackage(current)) {
        const [held] = tx
          .update(applicationPostingVerifications)
          .set({
            heldCheckpoint: current.checkpoint,
            heldCheckpointDetail: current.checkpointDetail,
            heldPreparedFields: current.preparedFields ?? null,
          })
          .where(eq(applicationPostingVerifications.id, row.id))
          .returning()
          .all();
        row = held ?? row;
        tx.update(applicationAttempts)
          .set({
            checkpoint: 'needs_user',
            checkpointDetail: input.hold.detailFor(row.result === 'confirmed_closed' ? 'confirmed_closed' : 'materially_changed'),
            preparedFields: null,
            updatedAt: new Date(),
          })
          .where(eq(applicationAttempts.id, input.attemptId))
          .run();
        syncApplicationForAttempt(tx as WorkspaceDb, input.attemptId);
        hold = 'held';
      }
    }

    // An application whose PREPARATION stopped on a finding has no package to hold, so nothing above
    // touches it. Its sentence must still follow the newest definitive answer, or it keeps saying
    // "looks closed" for a posting that is open and the person has no way to see they can prepare it.
    if (input.hold && definitive) {
      retargetPreparationStop(tx, input.attemptId, input.hold, input.result, row);
    }
    return { written, record: toRecord(row), hold };
  });
}

export function getPostingObservedText(db: WorkspaceDb, verificationId: string): string | null {
  const row = db
    .select({ observedText: applicationPostingVerifications.observedText })
    .from(applicationPostingVerifications)
    .where(eq(applicationPostingVerifications.id, verificationId))
    .get();
  return row?.observedText ?? null;
}

const ALLOWED_RESOLUTIONS: Record<'prepare_anyway' | 'keep_current', PostingVerificationResult> = {
  prepare_anyway: 'confirmed_closed',
  keep_current: 'materially_changed',
};

export interface ResolvePostingVerificationOutcome {
  record: PostingVerificationRecord;
  /** The held package was put back exactly as it was (no regeneration). */
  restored: boolean;
}

/**
 * Records the person's decision on the CURRENT open finding only; a decision about an older one is
 * ignored. A package this finding held is restored in the same transaction, byte for byte.
 */
export function resolvePostingVerification(
  db: WorkspaceDb,
  attemptId: string,
  resolution: 'prepare_anyway' | 'keep_current',
): ResolvePostingVerificationOutcome | null {
  return db.transaction((tx) => {
    const attempt = tx.select().from(applicationAttempts).where(eq(applicationAttempts.id, attemptId)).get();
    if (!attempt || isHistoricalAttempt(attempt)) return null;
    const pending = pendingRow(tx, attemptId);
    if (!pending || pending.result !== ALLOWED_RESOLUTIONS[resolution]) return null;
    const restored = restoreFromHold(tx, attempt, pending);
    const [row] = tx
      .update(applicationPostingVerifications)
      .set({ resolution, resolvedAt: new Date(), observedText: null, ...CLEARED_HOLD })
      .where(and(eq(applicationPostingVerifications.id, pending.id), isNull(applicationPostingVerifications.resolution)))
      .returning()
      .all();
    return row ? { record: toRecord(row), restored } : null;
  });
}

/**
 * The person chose to prepare this attempt again from scratch (a plain resume or a refresh): any held
 * package belongs to the old preparation and is not restored later.
 */
export function discardPostingHold(db: WorkspaceDb, attemptId: string): void {
  db.update(applicationPostingVerifications)
    .set(CLEARED_HOLD)
    .where(
      and(
        eq(applicationPostingVerifications.attemptId, attemptId),
        sql`${applicationPostingVerifications.heldCheckpoint} is not null`,
      ),
    )
    .run();
}

export type AdoptPostingChangeResult =
  | { ok: true; verificationId: string }
  | { ok: false; reason: 'not_found' | 'historical' | 'not_waiting' | 'no_pending_change' | 'baseline_moved' };

/**
 * Replaces an attempt's job description with the changed posting the person just chose to refresh to.
 * The only writer of `jdSnapshot` besides the first capture and the missing-description fill, and
 * the strictest: the attempt must be unsubmitted and waiting (`needs_user` / `failed`), the finding
 * must still be the open one, and the snapshot must still be the one the finding was compared against
 * (so a newer version, or a second refresh, cannot be overwritten by a stale click). The adopted text
 * leaves the finding row (it is the snapshot now); its hash and version stay as provenance.
 */
export function adoptPostingChange(db: WorkspaceDb, attemptId: string): AdoptPostingChangeResult {
  return db.transaction((tx) => {
    const attempt = tx.select().from(applicationAttempts).where(eq(applicationAttempts.id, attemptId)).get();
    if (!attempt) return { ok: false, reason: 'not_found' };
    if (isHistoricalAttempt(attempt)) return { ok: false, reason: 'historical' };
    if (attempt.checkpoint !== 'needs_user' && attempt.checkpoint !== 'failed') return { ok: false, reason: 'not_waiting' };
    const pending = pendingRow(tx, attemptId);
    if (!pending || pending.result !== 'materially_changed' || !pending.observedText) {
      return { ok: false, reason: 'no_pending_change' };
    }
    if (pending.baselineHash !== postingContentHash(attempt.jdSnapshot)) return { ok: false, reason: 'baseline_moved' };
    tx.update(applicationAttempts)
      .set({
        jdSnapshot: pending.observedText,
        jdSnapshotHash: createHash('sha256').update(pending.observedText).digest('hex'),
        jdComplete: true,
        updatedAt: new Date(),
      })
      .where(eq(applicationAttempts.id, attemptId))
      .run();
    tx.update(applicationPostingVerifications)
      .set({ resolution: 'refreshed', resolvedAt: new Date(), observedText: null, ...CLEARED_HOLD })
      .where(eq(applicationPostingVerifications.id, pending.id))
      .run();
    return { ok: true, verificationId: pending.id };
  });
}

export type { PreparedApplicationFields };
