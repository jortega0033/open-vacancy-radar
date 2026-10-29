import { createHash } from 'node:crypto';
import { postingContentHash } from '@open-vacancy-radar/vacancy-engine';
import { and, desc, eq, sql } from 'drizzle-orm';
import { syncApplicationForAttempt } from './attempt-application-sync.js';
import type { WorkspaceDb } from './client.js';
import { applicationAttempts, applicationPostingVerifications } from './schema.js';
import type { ApplicationAttemptCheckpoint } from './types.js';

/**
 * Persistence for #687's posting checks. Every write here is one transaction that re-reads the
 * attempt, so a check that finished after the attempt was cancelled, submitted, or moved on writes
 * nothing, and an observation older than the stored one never replaces it.
 *
 * `jdSnapshot` / `jdSnapshotHash` are changed by exactly one function in this file,
 * `adoptPostingChange`, and only for an attempt that has never been submitted. Submitted,
 * `user_reported`, `submitting` and `submission_unknown` attempts are refused by every function
 * here: a live posting changing or closing never reaches a historical package.
 */

export type PostingVerificationResult =
  | 'confirmed_open'
  | 'confirmed_closed'
  | 'materially_changed'
  | 'unable_to_verify';
export type PostingVerificationResolution = 'refreshed' | 'prepare_anyway' | 'keep_current';
export type PostingVerificationOutcome = 'open' | 'closed' | 'unable';

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
  changeSummary: { added: string[]; removed: string[] } | null;
  /** Whether the changed text is retained for a refresh (the text itself is never sent to the renderer). */
  hasObservedText: boolean;
  resolution: PostingVerificationResolution | null;
  resolvedAt: string | null;
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
  };
}

function latestRow(db: Pick<WorkspaceDb, 'select'>, attemptId: string): Row | undefined {
  return db
    .select()
    .from(applicationPostingVerifications)
    .where(eq(applicationPostingVerifications.attemptId, attemptId))
    .orderBy(desc(applicationPostingVerifications.observedAt), desc(sql`rowid`))
    .limit(1)
    .get();
}

export function getLatestPostingVerification(db: WorkspaceDb, attemptId: string): PostingVerificationRecord | null {
  const row = latestRow(db, attemptId);
  return row ? toRecord(row) : null;
}

export function listPostingVerifications(db: WorkspaceDb, attemptId: string): PostingVerificationRecord[] {
  return db
    .select()
    .from(applicationPostingVerifications)
    .where(eq(applicationPostingVerifications.attemptId, attemptId))
    .orderBy(desc(applicationPostingVerifications.observedAt), desc(sql`rowid`))
    .all()
    .map(toRecord);
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
  changeSummary: { added: string[]; removed: string[] } | null;
  observedText: string | null;
}

export type RecordPostingVerificationOutcome =
  | { written: 'inserted' | 'refreshed'; record: PostingVerificationRecord }
  /** A newer observation already exists; the stored one is returned unchanged. */
  | { written: 'dropped_older'; record: PostingVerificationRecord }
  /** The attempt is gone, historical, or no longer at an allowed checkpoint: nothing was written. */
  | { written: 'refused'; record: PostingVerificationRecord | null };

export function recordPostingVerification(
  db: WorkspaceDb,
  input: RecordPostingVerificationInput,
): RecordPostingVerificationOutcome {
  return db.transaction((tx) => {
    const attempt = tx
      .select({ checkpoint: applicationAttempts.checkpoint, submittedAt: applicationAttempts.submittedAt })
      .from(applicationAttempts)
      .where(eq(applicationAttempts.id, input.attemptId))
      .get();
    const latest = latestRow(tx, input.attemptId);
    if (!attempt || isHistoricalAttempt(attempt) || !input.allowedCheckpoints.includes(attempt.checkpoint)) {
      return { written: 'refused', record: latest ? toRecord(latest) : null };
    }
    if (latest && latest.observedAt.getTime() > input.observedAt.getTime()) {
      return { written: 'dropped_older', record: toRecord(latest) };
    }
    if (
      latest &&
      latest.outcome === input.outcome &&
      latest.result === input.result &&
      latest.reason === input.reason &&
      latest.contentHash === input.contentHash &&
      latest.baselineHash === input.baselineHash
    ) {
      const [row] = tx
        .update(applicationPostingVerifications)
        .set({
          observedAt: input.observedAt,
          httpStatus: input.httpStatus,
          deadline: input.deadline,
          deadlineProvenance: input.deadlineProvenance,
          etag: input.etag ?? latest.etag,
          lastModified: input.lastModified ?? latest.lastModified,
        })
        .where(eq(applicationPostingVerifications.id, latest.id))
        .returning()
        .all();
      return { written: 'refreshed', record: toRecord(row ?? latest) };
    }
    const prior = tx
      .select({ contentHash: applicationPostingVerifications.contentHash, contentVersion: applicationPostingVerifications.contentVersion })
      .from(applicationPostingVerifications)
      .where(eq(applicationPostingVerifications.attemptId, input.attemptId))
      .all();
    const known = input.contentHash === null ? undefined : prior.find((row) => row.contentHash === input.contentHash);
    const highest = prior.reduce((max, row) => Math.max(max, row.contentVersion), 1);
    // The snapshot the work was prepared against is version 1; every other distinct text counts up.
    const contentVersion =
      input.contentHash === null
        ? (latest?.contentVersion ?? 1)
        : (known?.contentVersion ?? (input.contentHash === input.baselineHash && prior.length === 0 ? 1 : highest + 1));
    const [row] = tx
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
        observedText: input.observedText,
      })
      .returning()
      .all();
    if (!row) throw new Error('posting verification was not stored');
    return { written: 'inserted', record: toRecord(row) };
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

const ALLOWED_RESOLUTIONS: Record<PostingVerificationResolution, PostingVerificationResult> = {
  refreshed: 'materially_changed',
  prepare_anyway: 'confirmed_closed',
  keep_current: 'materially_changed',
};

/** Records the person's decision on the CURRENT finding only; a decision about an older one is ignored. */
export function resolvePostingVerification(
  db: WorkspaceDb,
  attemptId: string,
  resolution: PostingVerificationResolution,
): PostingVerificationRecord | null {
  return db.transaction((tx) => {
    const attempt = tx
      .select({ checkpoint: applicationAttempts.checkpoint, submittedAt: applicationAttempts.submittedAt })
      .from(applicationAttempts)
      .where(eq(applicationAttempts.id, attemptId))
      .get();
    if (!attempt || isHistoricalAttempt(attempt)) return null;
    const latest = latestRow(tx, attemptId);
    if (!latest || latest.resolution !== null || latest.result !== ALLOWED_RESOLUTIONS[resolution]) return null;
    const [row] = tx
      .update(applicationPostingVerifications)
      .set({ resolution, resolvedAt: new Date() })
      .where(and(eq(applicationPostingVerifications.id, latest.id), sql`${applicationPostingVerifications.resolution} is null`))
      .returning()
      .all();
    return row ? toRecord(row) : null;
  });
}

export type AdoptPostingChangeResult =
  | { ok: true; verificationId: string }
  | { ok: false; reason: 'not_found' | 'historical' | 'not_waiting' | 'no_pending_change' | 'baseline_moved' };

/**
 * Replaces an attempt's job description with the changed posting the person just chose to refresh to.
 * The only writer of `jdSnapshot` besides the first capture and the missing-description fill, and
 * the strictest: the attempt must be unsubmitted and waiting (`needs_user` / `failed`), the finding
 * must still be the newest and unresolved, and the snapshot must still be the one the finding was
 * compared against (so a newer version, or a second refresh, cannot be overwritten by a stale click).
 */
export function adoptPostingChange(db: WorkspaceDb, attemptId: string): AdoptPostingChangeResult {
  return db.transaction((tx) => {
    const attempt = tx.select().from(applicationAttempts).where(eq(applicationAttempts.id, attemptId)).get();
    if (!attempt) return { ok: false, reason: 'not_found' };
    if (isHistoricalAttempt(attempt)) return { ok: false, reason: 'historical' };
    if (attempt.checkpoint !== 'needs_user' && attempt.checkpoint !== 'failed') return { ok: false, reason: 'not_waiting' };
    const latest = latestRow(tx, attemptId);
    if (!latest || latest.result !== 'materially_changed' || latest.resolution !== null || !latest.observedText) {
      return { ok: false, reason: 'no_pending_change' };
    }
    if (latest.baselineHash !== postingContentHash(attempt.jdSnapshot)) return { ok: false, reason: 'baseline_moved' };
    tx.update(applicationAttempts)
      .set({
        jdSnapshot: latest.observedText,
        jdSnapshotHash: createHash('sha256').update(latest.observedText).digest('hex'),
        jdComplete: true,
        updatedAt: new Date(),
      })
      .where(eq(applicationAttempts.id, attemptId))
      .run();
    tx.update(applicationPostingVerifications)
      .set({ resolution: 'refreshed', resolvedAt: new Date() })
      .where(eq(applicationPostingVerifications.id, latest.id))
      .run();
    return { ok: true, verificationId: latest.id };
  });
}

/**
 * Takes a prepared attempt out of `ready` / `needs_user` / `failed` and into `needs_user` with the
 * finding as its reason, so documents prepared against a posting that has since changed cannot be
 * sent. Compare-and-set on the checkpoint it was read at; clears the stale prepared answers. The
 * staged files stay until the person explicitly refreshes (`restartApplicationTailoring` removes them).
 */
export function invalidatePreparedAttempt(
  db: WorkspaceDb,
  attemptId: string,
  expectedCheckpoint: ApplicationAttemptCheckpoint,
  detail: string,
): boolean {
  return db.transaction((tx) => {
    const attempt = tx.select().from(applicationAttempts).where(eq(applicationAttempts.id, attemptId)).get();
    if (!attempt || isHistoricalAttempt(attempt) || attempt.checkpoint !== expectedCheckpoint) return false;
    tx.update(applicationAttempts)
      .set({ checkpoint: 'needs_user', checkpointDetail: detail, preparedFields: null, updatedAt: new Date() })
      .where(eq(applicationAttempts.id, attemptId))
      .run();
    syncApplicationForAttempt(tx, attemptId);
    return true;
  });
}
