import { randomUUID } from 'node:crypto';
import { and, asc, eq } from 'drizzle-orm';
import {
  ACTION_LIMITS,
  sameDue,
  type ActionChannel,
  type ActionKind,
  type ActionOrigin,
  type ActionState,
  type DueKind,
  type ResolvedDue,
} from '../application-actions-core.js';
import type { WorkspaceDb } from './client.js';
import {
  applicationActionPrefs,
  applicationActions,
  applicationFollowUpDrafts,
  applications,
} from './schema.js';

/**
 * #692: persistence for local due actions. Every write takes the caller's transaction. Nothing here
 * reads or writes `applications` beyond checking the row exists: `next_step`, `notes`, `status` and
 * `applied_at` are never touched by an action's life (complete, dismiss, reschedule, suggest).
 */

type Tx = Pick<WorkspaceDb, 'select' | 'insert' | 'update' | 'delete'>;
type Row = typeof applicationActions.$inferSelect;

export interface ActionFields {
  kind: ActionKind;
  title: string;
  note: string;
  channel: ActionChannel;
  contactDetail: string;
}

export interface ActionRecord extends ActionFields {
  id: string;
  applicationId: string;
  dueKind: DueKind;
  dueDate: string | null;
  dueLocal: string | null;
  dueTimeZone: string;
  dueUtcOffsetMinutes: number | null;
  dueResolution: 'unique' | 'earlier' | 'later' | null;
  /** ISO-8601 UTC. */
  dueAt: string;
  firstDueAt: string;
  rescheduleCount: number;
  state: ActionState;
  origin: ActionOrigin;
  basisClass: string;
  version: number;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
  dismissedAt: string | null;
}

function toRecord(row: Row): ActionRecord {
  return {
    id: row.id,
    applicationId: row.applicationId,
    kind: row.kind,
    title: row.title,
    note: row.note,
    channel: row.channel,
    contactDetail: row.contactDetail,
    dueKind: row.dueKind,
    dueDate: row.dueDate,
    dueLocal: row.dueLocal,
    dueTimeZone: row.dueTimeZone,
    dueUtcOffsetMinutes: row.dueUtcOffsetMinutes,
    dueResolution: row.dueResolution,
    dueAt: row.dueAt.toISOString(),
    firstDueAt: row.firstDueAt.toISOString(),
    rescheduleCount: row.rescheduleCount,
    state: row.state,
    origin: row.origin,
    basisClass: row.basisClass,
    version: row.version,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    completedAt: row.completedAt ? row.completedAt.toISOString() : null,
    dismissedAt: row.dismissedAt ? row.dismissedAt.toISOString() : null,
  };
}

const dueOf = (row: Row): ResolvedDue => ({
  dueKind: row.dueKind,
  dueDate: row.dueDate,
  dueLocal: row.dueLocal,
  dueTimeZone: row.dueTimeZone,
  dueUtcOffsetMinutes: row.dueUtcOffsetMinutes,
  dueResolution: row.dueResolution,
  dueAt: row.dueAt.getTime(),
});

/** Open actions first, soonest due first; then history, newest change first. */
export function listActions(db: Pick<WorkspaceDb, 'select'>, applicationId: string): ActionRecord[] {
  const rows = db
    .select()
    .from(applicationActions)
    .where(eq(applicationActions.applicationId, applicationId))
    .orderBy(asc(applicationActions.dueAt))
    .all();
  const open = rows.filter((row) => row.state === 'open').map(toRecord);
  const closed = rows
    .filter((row) => row.state !== 'open')
    .sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime())
    .map(toRecord);
  return [...open, ...closed];
}

/** Every open action on every row, for the Applications overview. */
export function listAllOpenActions(db: Pick<WorkspaceDb, 'select'>): ActionRecord[] {
  return db
    .select()
    .from(applicationActions)
    .where(eq(applicationActions.state, 'open'))
    .orderBy(asc(applicationActions.dueAt))
    .all()
    .map(toRecord);
}

export function getAction(db: Pick<WorkspaceDb, 'select'>, applicationId: string, actionId: string): ActionRecord | null {
  const row = db
    .select()
    .from(applicationActions)
    .where(and(eq(applicationActions.id, actionId), eq(applicationActions.applicationId, applicationId)))
    .get();
  return row ? toRecord(row) : null;
}

export type CreateResult =
  | { ok: true; action: ActionRecord; reused: boolean }
  | { ok: false; code: 'not_found' | 'limit' };

/**
 * Creates an action. The same `(application, requestId)` returns the row that request already made:
 * a retry after a lost reply never makes a second action. A NEW request id is a new intent and always
 * creates a new row, even when every field is identical.
 */
export function createAction(
  tx: Tx,
  input: {
    applicationId: string;
    requestId: string;
    fields: ActionFields;
    due: ResolvedDue;
    origin: ActionOrigin;
    basisClass: string;
  },
  now: Date,
): CreateResult {
  const application = tx.select({ id: applications.id }).from(applications).where(eq(applications.id, input.applicationId)).get();
  if (!application) return { ok: false, code: 'not_found' };
  const replay = tx
    .select()
    .from(applicationActions)
    .where(and(eq(applicationActions.applicationId, input.applicationId), eq(applicationActions.requestId, input.requestId)))
    .get();
  if (replay) return { ok: true, action: toRecord(replay), reused: true };
  const count = tx
    .select({ id: applicationActions.id })
    .from(applicationActions)
    .where(eq(applicationActions.applicationId, input.applicationId))
    .all().length;
  if (count >= ACTION_LIMITS.perApplication) return { ok: false, code: 'limit' };
  const [inserted] = tx
    .insert(applicationActions)
    .values({
      id: randomUUID(),
      applicationId: input.applicationId,
      requestId: input.requestId,
      ...input.fields,
      dueKind: input.due.dueKind,
      dueDate: input.due.dueDate,
      dueLocal: input.due.dueLocal,
      dueTimeZone: input.due.dueTimeZone,
      dueUtcOffsetMinutes: input.due.dueUtcOffsetMinutes,
      dueResolution: input.due.dueResolution,
      dueAt: new Date(input.due.dueAt),
      firstDueAt: new Date(input.due.dueAt),
      rescheduleCount: 0,
      state: 'open',
      origin: input.origin,
      basisClass: input.basisClass,
      version: 1,
      createdAt: now,
      updatedAt: now,
    })
    .returning()
    .all();
  if (!inserted) throw new Error('failed to insert an application action');
  return { ok: true, action: toRecord(inserted), reused: false };
}

export type ChangeResult =
  | { ok: true; action: ActionRecord; unchanged: boolean }
  | { ok: false; code: 'not_found' | 'outdated' | 'not_open' };

function stampAfter(existing: Date, now: Date): Date {
  return now.getTime() > existing.getTime() ? now : new Date(existing.getTime() + 1);
}

/**
 * Edits the fields and/or reschedules an OPEN action. A request that asks for what is already stored
 * is a success that changes nothing (a retried reschedule, even from a stale form, is not an error and
 * is not counted twice). Anything that would change a row needs the version the person was looking at.
 */
export function changeAction(
  tx: Tx,
  input: { applicationId: string; actionId: string; expectedVersion: number; fields?: ActionFields; due?: ResolvedDue },
  now: Date,
): ChangeResult {
  const existing = tx
    .select()
    .from(applicationActions)
    .where(and(eq(applicationActions.id, input.actionId), eq(applicationActions.applicationId, input.applicationId)))
    .get();
  if (!existing) return { ok: false, code: 'not_found' };
  if (existing.state !== 'open') return { ok: false, code: 'not_open' };

  const fields: ActionFields = input.fields ?? {
    kind: existing.kind,
    title: existing.title,
    note: existing.note,
    channel: existing.channel,
    contactDetail: existing.contactDetail,
  };
  const fieldsSame =
    fields.kind === existing.kind &&
    fields.title === existing.title &&
    fields.note === existing.note &&
    fields.channel === existing.channel &&
    fields.contactDetail === existing.contactDetail;
  const dueSame = !input.due || sameDue(input.due, dueOf(existing));
  if (fieldsSame && dueSame) return { ok: true, action: toRecord(existing), unchanged: true };
  if (existing.version !== input.expectedVersion) return { ok: false, code: 'outdated' };

  const [updated] = tx
    .update(applicationActions)
    .set({
      ...fields,
      ...(input.due && !dueSame
        ? {
            dueKind: input.due.dueKind,
            dueDate: input.due.dueDate,
            dueLocal: input.due.dueLocal,
            dueTimeZone: input.due.dueTimeZone,
            dueUtcOffsetMinutes: input.due.dueUtcOffsetMinutes,
            dueResolution: input.due.dueResolution,
            dueAt: new Date(input.due.dueAt),
            rescheduleCount: existing.rescheduleCount + 1,
          }
        : {}),
      version: existing.version + 1,
      updatedAt: stampAfter(existing.updatedAt, now),
    })
    .where(and(eq(applicationActions.id, existing.id), eq(applicationActions.version, existing.version)))
    .returning()
    .all();
  if (!updated) return { ok: false, code: 'outdated' };
  return { ok: true, action: toRecord(updated), unchanged: false };
}

/**
 * Moves an open action to `completed` or `dismissed`. Repeating the transition that already happened
 * returns the unchanged record (its timestamps stay as first recorded); the opposite transition is
 * refused because the person already decided otherwise. History is kept; nothing is deleted.
 */
export function transitionAction(
  tx: Tx,
  input: { applicationId: string; actionId: string; expectedVersion: number; to: 'completed' | 'dismissed' },
  now: Date,
): ChangeResult {
  const existing = tx
    .select()
    .from(applicationActions)
    .where(and(eq(applicationActions.id, input.actionId), eq(applicationActions.applicationId, input.applicationId)))
    .get();
  if (!existing) return { ok: false, code: 'not_found' };
  if (existing.state === input.to) return { ok: true, action: toRecord(existing), unchanged: true };
  if (existing.state !== 'open') return { ok: false, code: 'not_open' };
  if (existing.version !== input.expectedVersion) return { ok: false, code: 'outdated' };
  const stamp = stampAfter(existing.updatedAt, now);
  const [updated] = tx
    .update(applicationActions)
    .set({
      state: input.to,
      version: existing.version + 1,
      updatedAt: stamp,
      ...(input.to === 'completed' ? { completedAt: stamp } : { dismissedAt: stamp }),
    })
    .where(and(eq(applicationActions.id, existing.id), eq(applicationActions.version, existing.version)))
    .returning()
    .all();
  if (!updated) return { ok: false, code: 'outdated' };
  return { ok: true, action: toRecord(updated), unchanged: false };
}

export function isSuppressed(db: Pick<WorkspaceDb, 'select'>, applicationId: string): boolean {
  return (
    db
      .select({ suppressed: applicationActionPrefs.suggestionsSuppressed })
      .from(applicationActionPrefs)
      .where(eq(applicationActionPrefs.applicationId, applicationId))
      .get()?.suppressed === true
  );
}

export function suppressedApplicationIds(db: Pick<WorkspaceDb, 'select'>): Set<string> {
  return new Set(
    db
      .select({ id: applicationActionPrefs.applicationId, suppressed: applicationActionPrefs.suggestionsSuppressed })
      .from(applicationActionPrefs)
      .all()
      .filter((row) => row.suppressed)
      .map((row) => row.id),
  );
}

/** Sets the person's "stop suggesting" switch. Idempotent; false when the application is gone. */
export function setSuppressed(tx: Tx, applicationId: string, suppressed: boolean, now: Date): boolean {
  const application = tx.select({ id: applications.id }).from(applications).where(eq(applications.id, applicationId)).get();
  if (!application) return false;
  const values = { suggestionsSuppressed: suppressed, suppressedAt: suppressed ? now : null };
  const existing = tx.select().from(applicationActionPrefs).where(eq(applicationActionPrefs.applicationId, applicationId)).get();
  if (!existing) {
    tx.insert(applicationActionPrefs).values({ applicationId, ...values }).run();
  } else if (existing.suggestionsSuppressed !== suppressed) {
    tx.update(applicationActionPrefs).set(values).where(eq(applicationActionPrefs.applicationId, applicationId)).run();
  }
  return true;
}

/** Counted and deleted explicitly by the application data reset (drafts first: they reference actions). */
export function deleteAllApplicationActions(
  tx: Pick<WorkspaceDb, 'select' | 'delete'>,
): { applicationActions: number; applicationActionPrefs: number; followUpDrafts: number } {
  const followUpDrafts = tx.select({ id: applicationFollowUpDrafts.id }).from(applicationFollowUpDrafts).all().length;
  const actions = tx.select({ id: applicationActions.id }).from(applicationActions).all().length;
  const prefs = tx.select({ id: applicationActionPrefs.applicationId }).from(applicationActionPrefs).all().length;
  tx.delete(applicationFollowUpDrafts).run();
  tx.delete(applicationActions).run();
  tx.delete(applicationActionPrefs).run();
  return { applicationActions: actions, applicationActionPrefs: prefs, followUpDrafts };
}
