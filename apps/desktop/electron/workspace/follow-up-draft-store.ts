import { randomUUID } from 'node:crypto';
import { and, desc, eq } from 'drizzle-orm';
import type { ActionKind, FollowUpDraftBasis } from '../application-actions-core.js';
import { sha256 } from '../follow-up-draft.js';
import type { WorkspaceDb } from './client.js';
import { applicationFollowUpDrafts, applications } from './schema.js';

/**
 * #692: persistence for follow-up drafts. A draft is TEXT the person may send themselves. Its state has
 * two independent halves that never merge: preparation (`prepared` -> `approved` | `discarded`, the
 * person's review of the text) and `send_state` (`not_sent` until the person themselves reports sending).
 * Nothing here talks to a model, a mailbox or any other system.
 */

type Tx = Pick<WorkspaceDb, 'select' | 'insert' | 'update' | 'delete'>;
type Row = typeof applicationFollowUpDrafts.$inferSelect;

export const DRAFT_LIMIT_PER_APPLICATION = 50;

export interface DraftRecord {
  id: string;
  applicationId: string;
  actionId: string | null;
  kind: ActionKind;
  basis: FollowUpDraftBasis;
  subject: string;
  body: string;
  /** True once the person changed the model's text. */
  edited: boolean;
  status: 'prepared' | 'approved' | 'discarded';
  approvedAt: string | null;
  sendState: 'not_sent' | 'user_reported_sent';
  sentReportedAt: string | null;
  sentOn: string | null;
  provider: string;
  version: number;
  createdAt: string;
  updatedAt: string;
}

function toRecord(row: Row): DraftRecord {
  return {
    id: row.id,
    applicationId: row.applicationId,
    actionId: row.actionId,
    kind: row.kind,
    basis: row.basis,
    subject: row.subject,
    body: row.body,
    edited: row.bodyHash !== row.generatedHash,
    status: row.status,
    approvedAt: row.approvedAt ? row.approvedAt.toISOString() : null,
    sendState: row.sendState,
    sentReportedAt: row.sentReportedAt ? row.sentReportedAt.toISOString() : null,
    sentOn: row.sentOn,
    provider: row.provider,
    version: row.version,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export function listDrafts(db: Pick<WorkspaceDb, 'select'>, applicationId: string): DraftRecord[] {
  return db
    .select()
    .from(applicationFollowUpDrafts)
    .where(eq(applicationFollowUpDrafts.applicationId, applicationId))
    .orderBy(desc(applicationFollowUpDrafts.createdAt))
    .all()
    .map(toRecord);
}

export function getDraftByRequest(db: Pick<WorkspaceDb, 'select'>, applicationId: string, requestId: string): DraftRecord | null {
  const row = db
    .select()
    .from(applicationFollowUpDrafts)
    .where(and(eq(applicationFollowUpDrafts.applicationId, applicationId), eq(applicationFollowUpDrafts.requestId, requestId)))
    .get();
  return row ? toRecord(row) : null;
}

export type InsertDraftResult =
  | { ok: true; draft: DraftRecord; reused: boolean }
  | { ok: false; code: 'not_found' | 'limit' };

/**
 * Stores a generated draft. The same `(application, requestId)` returns the draft that request already
 * made (never a second durable draft); a new request id is a new intent and makes a new record.
 */
export function insertDraft(
  tx: Tx,
  input: {
    applicationId: string;
    actionId: string | null;
    requestId: string;
    kind: ActionKind;
    basis: FollowUpDraftBasis;
    subject: string;
    body: string;
    provider: string;
    usage: { inputTokens?: number; outputTokens?: number } | null;
  },
  now: Date,
): InsertDraftResult {
  const application = tx.select({ id: applications.id }).from(applications).where(eq(applications.id, input.applicationId)).get();
  if (!application) return { ok: false, code: 'not_found' };
  const replay = getDraftByRequest(tx, input.applicationId, input.requestId);
  if (replay) return { ok: true, draft: replay, reused: true };
  const count = tx
    .select({ id: applicationFollowUpDrafts.id })
    .from(applicationFollowUpDrafts)
    .where(eq(applicationFollowUpDrafts.applicationId, input.applicationId))
    .all().length;
  if (count >= DRAFT_LIMIT_PER_APPLICATION) return { ok: false, code: 'limit' };
  const [inserted] = tx
    .insert(applicationFollowUpDrafts)
    .values({
      id: randomUUID(),
      applicationId: input.applicationId,
      actionId: input.actionId,
      requestId: input.requestId,
      kind: input.kind,
      basis: input.basis,
      subject: input.subject,
      generatedBody: input.body,
      body: input.body,
      generatedHash: sha256(input.body),
      bodyHash: sha256(input.body),
      status: 'prepared',
      sendState: 'not_sent',
      provider: input.provider,
      usage: input.usage,
      version: 1,
      createdAt: now,
      updatedAt: now,
    })
    .returning()
    .all();
  if (!inserted) throw new Error('failed to insert a follow-up draft');
  return { ok: true, draft: toRecord(inserted), reused: false };
}

export type DraftChangeResult =
  | { ok: true; draft: DraftRecord; unchanged: boolean }
  | { ok: false; code: 'not_found' | 'outdated' | 'frozen' | 'discarded' };

function find(tx: Tx, applicationId: string, draftId: string): Row | undefined {
  return tx
    .select()
    .from(applicationFollowUpDrafts)
    .where(and(eq(applicationFollowUpDrafts.id, draftId), eq(applicationFollowUpDrafts.applicationId, applicationId)))
    .get();
}

function stampAfter(existing: Date, now: Date): Date {
  return now.getTime() > existing.getTime() ? now : new Date(existing.getTime() + 1);
}

/** The person edits the text. Approval described the OLD text, so it is cleared. A draft reported as sent is frozen. */
export function editDraft(
  tx: Tx,
  input: { applicationId: string; draftId: string; expectedVersion: number; subject: string; body: string },
  now: Date,
): DraftChangeResult {
  const existing = find(tx, input.applicationId, input.draftId);
  if (!existing) return { ok: false, code: 'not_found' };
  if (existing.sendState === 'user_reported_sent') return { ok: false, code: 'frozen' };
  if (existing.status === 'discarded') return { ok: false, code: 'discarded' };
  if (existing.subject === input.subject && existing.body === input.body) return { ok: true, draft: toRecord(existing), unchanged: true };
  if (existing.version !== input.expectedVersion) return { ok: false, code: 'outdated' };
  const [updated] = tx
    .update(applicationFollowUpDrafts)
    .set({
      subject: input.subject,
      body: input.body,
      bodyHash: sha256(input.body),
      status: 'prepared',
      approvedAt: null,
      version: existing.version + 1,
      updatedAt: stampAfter(existing.updatedAt, now),
    })
    .where(and(eq(applicationFollowUpDrafts.id, existing.id), eq(applicationFollowUpDrafts.version, existing.version)))
    .returning()
    .all();
  if (!updated) return { ok: false, code: 'outdated' };
  return { ok: true, draft: toRecord(updated), unchanged: false };
}

/** The person approves the exact text shown. Repeating it changes nothing. */
export function approveDraft(
  tx: Tx,
  input: { applicationId: string; draftId: string; expectedVersion: number },
  now: Date,
): DraftChangeResult {
  const existing = find(tx, input.applicationId, input.draftId);
  if (!existing) return { ok: false, code: 'not_found' };
  if (existing.status === 'approved') return { ok: true, draft: toRecord(existing), unchanged: true };
  if (existing.status === 'discarded') return { ok: false, code: 'discarded' };
  if (existing.version !== input.expectedVersion) return { ok: false, code: 'outdated' };
  const stamp = stampAfter(existing.updatedAt, now);
  const [updated] = tx
    .update(applicationFollowUpDrafts)
    .set({ status: 'approved', approvedAt: stamp, version: existing.version + 1, updatedAt: stamp })
    .where(and(eq(applicationFollowUpDrafts.id, existing.id), eq(applicationFollowUpDrafts.version, existing.version)))
    .returning()
    .all();
  if (!updated) return { ok: false, code: 'outdated' };
  return { ok: true, draft: toRecord(updated), unchanged: false };
}

/** Discards the draft from the working list. The record stays as history. A draft reported sent is not discarded. */
export function discardDraft(
  tx: Tx,
  input: { applicationId: string; draftId: string; expectedVersion: number },
  now: Date,
): DraftChangeResult {
  const existing = find(tx, input.applicationId, input.draftId);
  if (!existing) return { ok: false, code: 'not_found' };
  if (existing.status === 'discarded') return { ok: true, draft: toRecord(existing), unchanged: true };
  if (existing.sendState === 'user_reported_sent') return { ok: false, code: 'frozen' };
  if (existing.version !== input.expectedVersion) return { ok: false, code: 'outdated' };
  const stamp = stampAfter(existing.updatedAt, now);
  const [updated] = tx
    .update(applicationFollowUpDrafts)
    .set({ status: 'discarded', version: existing.version + 1, updatedAt: stamp })
    .where(and(eq(applicationFollowUpDrafts.id, existing.id), eq(applicationFollowUpDrafts.version, existing.version)))
    .returning()
    .all();
  if (!updated) return { ok: false, code: 'outdated' };
  return { ok: true, draft: toRecord(updated), unchanged: false };
}

/**
 * The person says they sent this message themselves. This is their statement and nothing else: it does not
 * come from, and does not cause, any message being sent. Repeating it keeps the first report.
 */
export function reportSent(
  tx: Tx,
  input: { applicationId: string; draftId: string; expectedVersion: number; sentOn: string | null },
  now: Date,
): DraftChangeResult {
  const existing = find(tx, input.applicationId, input.draftId);
  if (!existing) return { ok: false, code: 'not_found' };
  if (existing.sendState === 'user_reported_sent') return { ok: true, draft: toRecord(existing), unchanged: true };
  if (existing.status === 'discarded') return { ok: false, code: 'discarded' };
  if (existing.version !== input.expectedVersion) return { ok: false, code: 'outdated' };
  const stamp = stampAfter(existing.updatedAt, now);
  const [updated] = tx
    .update(applicationFollowUpDrafts)
    .set({ sendState: 'user_reported_sent', sentReportedAt: stamp, sentOn: input.sentOn, version: existing.version + 1, updatedAt: stamp })
    .where(and(eq(applicationFollowUpDrafts.id, existing.id), eq(applicationFollowUpDrafts.version, existing.version)))
    .returning()
    .all();
  if (!updated) return { ok: false, code: 'outdated' };
  return { ok: true, draft: toRecord(updated), unchanged: false };
}
