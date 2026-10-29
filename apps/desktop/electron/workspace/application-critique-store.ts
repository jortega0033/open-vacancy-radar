import { randomUUID } from 'node:crypto';
import { and, asc, eq } from 'drizzle-orm';
import {
  draftContentHash,
  type DraftContent,
  type DraftKind,
  type DraftOrigin,
  type InputFence,
  type RefusedFinding,
  type StoredFinding,
  type StoredProposal,
} from '../application-critique.js';
import type { WorkspaceDb } from './client.js';
import { isHistoricalAttempt } from './posting-verification-store.js';
import { applicationAttempts, applicationCritiques, applicationDocumentDrafts } from './schema.js';

/**
 * Persistence for #690's drafts and critiques. Every write is one transaction that re-reads the
 * attempt first and REFUSES a historical (submitted / submitting / unconfirmed / user-reported /
 * skipped) attempt: what was sent, and the record of what it contained, never changes afterwards.
 */

type Tx = Pick<WorkspaceDb, 'select' | 'insert' | 'update' | 'delete'>;

export interface DraftRecord {
  id: string;
  attemptId: string;
  kind: DraftKind;
  version: number;
  origin: DraftOrigin;
  status: 'current' | 'superseded';
  content: DraftContent;
  contentHash: string;
  artifactHash: string;
  jdHash: string;
  sourceCvHash: string;
  critiqueRunId: string | null;
  createdAt: string;
  supersededAt: string | null;
}

type DraftRow = typeof applicationDocumentDrafts.$inferSelect;

function toDraft(row: DraftRow): DraftRecord {
  return {
    id: row.id,
    attemptId: row.attemptId,
    kind: row.kind,
    version: row.version,
    origin: row.origin,
    status: row.status,
    content: row.content,
    contentHash: row.contentHash,
    artifactHash: row.artifactHash,
    jdHash: row.jdHash,
    sourceCvHash: row.sourceCvHash,
    critiqueRunId: row.critiqueRunId,
    createdAt: row.createdAt.toISOString(),
    supersededAt: row.supersededAt ? row.supersededAt.toISOString() : null,
  };
}

function writableAttempt(tx: Tx, attemptId: string) {
  const attempt = tx.select().from(applicationAttempts).where(eq(applicationAttempts.id, attemptId)).get();
  if (!attempt || isHistoricalAttempt(attempt)) return null;
  return attempt;
}

export function listDrafts(db: Pick<WorkspaceDb, 'select'>, attemptId: string): DraftRecord[] {
  return db
    .select()
    .from(applicationDocumentDrafts)
    .where(eq(applicationDocumentDrafts.attemptId, attemptId))
    .orderBy(asc(applicationDocumentDrafts.kind), asc(applicationDocumentDrafts.version))
    .all()
    .map(toDraft);
}

export function currentDrafts(db: Pick<WorkspaceDb, 'select'>, attemptId: string): DraftRecord[] {
  return listDrafts(db, attemptId).filter((draft) => draft.status === 'current');
}

export interface RecordDraftInput {
  attemptId: string;
  kind: DraftKind;
  origin: DraftOrigin;
  content: DraftContent;
  artifactHash: string;
  jdHash: string;
  sourceCvHash: string;
  critiqueRunId?: string | null;
  now: Date;
}

function appendDraft(tx: Tx, input: RecordDraftInput): DraftRecord {
  const existing = tx
    .select()
    .from(applicationDocumentDrafts)
    .where(and(eq(applicationDocumentDrafts.attemptId, input.attemptId), eq(applicationDocumentDrafts.kind, input.kind)))
    .all();
  const next = existing.reduce((max, row) => Math.max(max, row.version), 0) + 1;
  tx.update(applicationDocumentDrafts)
    .set({ status: 'superseded', supersededAt: input.now })
    .where(
      and(
        eq(applicationDocumentDrafts.attemptId, input.attemptId),
        eq(applicationDocumentDrafts.kind, input.kind),
        eq(applicationDocumentDrafts.status, 'current'),
      ),
    )
    .run();
  const [row] = tx
    .insert(applicationDocumentDrafts)
    .values({
      id: randomUUID(),
      attemptId: input.attemptId,
      kind: input.kind,
      version: next,
      origin: input.origin,
      status: 'current',
      content: input.content,
      contentHash: draftContentHash(input.content),
      artifactHash: input.artifactHash,
      jdHash: input.jdHash,
      sourceCvHash: input.sourceCvHash,
      critiqueRunId: input.critiqueRunId ?? null,
      createdAt: input.now,
    })
    .returning()
    .all();
  if (!row) throw new Error('failed to insert application document draft');
  return toDraft(row);
}

/**
 * Records the draft a preparation just rendered. Idempotent: re-staging an UNCHANGED draft only
 * re-ties it to the PDF that was re-rendered (same version); changed content appends the next
 * version and supersedes the previous one. Returns null for a historical attempt.
 */
export function recordPreparedDraft(db: WorkspaceDb, input: RecordDraftInput): DraftRecord | null {
  return db.transaction((tx) => {
    if (!writableAttempt(tx, input.attemptId)) return null;
    const hash = draftContentHash(input.content);
    const current = tx
      .select()
      .from(applicationDocumentDrafts)
      .where(
        and(
          eq(applicationDocumentDrafts.attemptId, input.attemptId),
          eq(applicationDocumentDrafts.kind, input.kind),
          eq(applicationDocumentDrafts.status, 'current'),
        ),
      )
      .get();
    if (current && current.contentHash === hash && current.origin === input.origin) {
      const [row] = tx
        .update(applicationDocumentDrafts)
        .set({ artifactHash: input.artifactHash, jdHash: input.jdHash, sourceCvHash: input.sourceCvHash })
        .where(eq(applicationDocumentDrafts.id, current.id))
        .returning()
        .all();
      return row ? toDraft(row) : null;
    }
    return appendDraft(tx, input);
  });
}

/** Marks the draft of a kind as no longer current without replacing it (its package part is gone). */
export function retireDraft(db: WorkspaceDb, attemptId: string, kind: DraftKind, now: Date): void {
  db.transaction((tx) => {
    if (!writableAttempt(tx, attemptId)) return;
    tx.update(applicationDocumentDrafts)
      .set({ status: 'superseded', supersededAt: now })
      .where(
        and(
          eq(applicationDocumentDrafts.attemptId, attemptId),
          eq(applicationDocumentDrafts.kind, kind),
          eq(applicationDocumentDrafts.status, 'current'),
        ),
      )
      .run();
  });
}

/* ------------------------------------------------------------------------------ critiques ----- */

export type { LastRunOutcome } from '../application-critique-types.js';
import type { LastRunOutcome } from '../application-critique-types.js';

export interface CritiqueRecord {
  attemptId: string;
  runId: string;
  reviewedAt: string | null;
  fence: InputFence | null;
  findings: StoredFinding[];
  refused: RefusedFinding[];
  proposals: StoredProposal[];
  provider: string;
  model: string | null;
  callCount: number;
  usage: { inputTokens?: number; outputTokens?: number } | null;
  lastRunOutcome: LastRunOutcome | null;
  lastRunDetail: string;
  lastRunAt: string | null;
}

type CritiqueRow = typeof applicationCritiques.$inferSelect;

function toCritique(row: CritiqueRow): CritiqueRecord {
  return {
    attemptId: row.attemptId,
    runId: row.runId,
    reviewedAt: row.reviewedAt ? row.reviewedAt.toISOString() : null,
    fence: row.fence ?? null,
    findings: row.findings ?? [],
    refused: row.refused ?? [],
    proposals: row.proposals ?? [],
    provider: row.provider,
    model: row.model,
    callCount: row.callCount,
    usage: row.usage ?? null,
    lastRunOutcome: row.lastRunOutcome ?? null,
    lastRunDetail: row.lastRunDetail,
    lastRunAt: row.lastRunAt ? row.lastRunAt.toISOString() : null,
  };
}

export function getCritique(db: Pick<WorkspaceDb, 'select'>, attemptId: string): CritiqueRecord | null {
  const row = db.select().from(applicationCritiques).where(eq(applicationCritiques.attemptId, attemptId)).get();
  return row ? toCritique(row) : null;
}

export interface SaveReviewInput {
  attemptId: string;
  runId: string;
  fence: InputFence;
  findings: StoredFinding[];
  refused: RefusedFinding[];
  proposals: StoredProposal[];
  provider: string;
  model: string | null;
  usage: { inputTokens?: number; outputTokens?: number } | null;
  now: Date;
}

/** Replaces the attempt's review with a completed one (an explicit new review). False when refused. */
export function saveReview(db: WorkspaceDb, input: SaveReviewInput): boolean {
  return db.transaction((tx) => {
    if (!writableAttempt(tx, input.attemptId)) return false;
    const values = {
      runId: input.runId,
      reviewedAt: input.now,
      fence: input.fence,
      findings: input.findings,
      refused: input.refused,
      proposals: input.proposals,
      provider: input.provider,
      model: input.model,
      callCount: 1,
      usage: input.usage,
      lastRunOutcome: 'reviewed' as const,
      lastRunDetail: '',
      lastRunAt: input.now,
      updatedAt: input.now,
    };
    const existing = tx.select({ id: applicationCritiques.attemptId }).from(applicationCritiques).where(eq(applicationCritiques.attemptId, input.attemptId)).get();
    if (existing) tx.update(applicationCritiques).set(values).where(eq(applicationCritiques.attemptId, input.attemptId)).run();
    else tx.insert(applicationCritiques).values({ attemptId: input.attemptId, ...values }).run();
    return true;
  });
}

/**
 * Records how the latest run ended WITHOUT touching a previous review: a failed, cancelled, timed-out,
 * rate-limited or discarded run is a status, never a deletion.
 */
export function saveRunOutcome(
  db: WorkspaceDb,
  input: { attemptId: string; runId: string; outcome: Exclude<LastRunOutcome, 'reviewed'>; detail: string; provider: string; now: Date },
): boolean {
  return db.transaction((tx) => {
    if (!writableAttempt(tx, input.attemptId)) return false;
    const existing = tx.select({ id: applicationCritiques.attemptId }).from(applicationCritiques).where(eq(applicationCritiques.attemptId, input.attemptId)).get();
    const patch = { lastRunOutcome: input.outcome, lastRunDetail: input.detail.slice(0, 500), lastRunAt: input.now, updatedAt: input.now };
    if (existing) tx.update(applicationCritiques).set(patch).where(eq(applicationCritiques.attemptId, input.attemptId)).run();
    else {
      tx.insert(applicationCritiques)
        .values({ attemptId: input.attemptId, runId: input.runId, provider: input.provider, ...patch })
        .run();
    }
    return true;
  });
}

/** Writes the proposals array back (a decision on one proposal). False when refused. */
export function saveProposals(db: WorkspaceDb, attemptId: string, proposals: StoredProposal[], now: Date): boolean {
  return db.transaction((tx) => {
    if (!writableAttempt(tx, attemptId)) return false;
    tx.update(applicationCritiques).set({ proposals, updatedAt: now }).where(eq(applicationCritiques.attemptId, attemptId)).run();
    return true;
  });
}

/** Counted and deleted explicitly by the application data reset. */
export function deleteAllCritiques(tx: Pick<WorkspaceDb, 'select' | 'delete'>): {
  applicationCritiques: number;
  applicationDocumentDrafts: number;
} {
  const counts = {
    applicationCritiques: tx.select({ id: applicationCritiques.attemptId }).from(applicationCritiques).all().length,
    applicationDocumentDrafts: tx.select({ id: applicationDocumentDrafts.id }).from(applicationDocumentDrafts).all().length,
  };
  tx.delete(applicationCritiques).run();
  tx.delete(applicationDocumentDrafts).run();
  return counts;
}

/** Exposed for the service's single accept transaction. */
export const critiqueTx = { writableAttempt, appendDraft };
