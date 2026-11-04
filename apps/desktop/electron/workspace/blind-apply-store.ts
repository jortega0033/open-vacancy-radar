import { createHash } from 'node:crypto';
import { and, asc, desc, eq, inArray, isNull } from 'drizzle-orm';
import type { WorkspaceDb } from './client.js';
import {
  blindApplyAnswers,
  blindApplyAuthorizations,
  blindApplyEvents,
  blindApplyItems,
  type BlindApplyAnswerUse,
  type BlindApplyEventKind,
  type BlindApplyGateEvidence,
  type BlindApplyIntervention,
  type BlindApplyItemState,
  type BlindApplyMissingField,
  type BlindApplySkipReason,
} from './blind-apply-schema.js';

/**
 * The local Blind Apply record (#722): authorizations, evaluated vacancies, an append-only event
 * trail, and remembered answers.
 *
 * What this module deliberately cannot do:
 *
 *  - It has no cap, quota or counter. A Blind Apply authorization has no daily limit by the user's
 *    explicit choice, so there is nothing here to count against.
 *  - It never updates or deletes an event. Events are inserted and read; a correction is a new event.
 *  - It never touches an attempt, a receipt or a submission. The attempt stays the source of truth
 *    for whether anything was sent; this only records what Blind Apply saw and decided.
 *  - It only moves an item with a compare-and-set on the state it expects, so two overlapping ticks
 *    (or a Stop racing a tick) cannot both win the same transition.
 */

export type { BlindApplyAnswerUse, BlindApplyEventKind, BlindApplyGateEvidence, BlindApplyIntervention, BlindApplyItemState, BlindApplyMissingField, BlindApplySkipReason };

/** States nothing leaves on its own. `outcome_unknown` is terminal for Blind Apply: it is never retried. */
export const BLIND_APPLY_TERMINAL_STATES: readonly BlindApplyItemState[] = [
  'submitted',
  'outcome_unknown',
  'could_not_submit',
  'apply_yourself',
  'skipped',
  'stopped',
];

/** States in which Blind Apply still has work, or is waiting on the person, for this item. */
export const BLIND_APPLY_LIVE_STATES: readonly BlindApplyItemState[] = [
  'queued',
  'preparing',
  'ready',
  'submitting',
  'needs_answer',
  'needs_you',
];

/** An item in one of these states means "this vacancy was or is being applied to": a second item for the
 * same identity would risk a second real application. */
const IDENTITY_BLOCKING_STATES: readonly BlindApplyItemState[] = [...BLIND_APPLY_LIVE_STATES, 'submitted', 'outcome_unknown'];

/** The states Stop cancels: work that has not been clicked yet. `submitting` is never in this list. */
export const BLIND_APPLY_STOPPABLE_STATES: readonly BlindApplyItemState[] = [
  'queued',
  'preparing',
  'ready',
  'needs_answer',
  'needs_you',
];

export interface BlindApplyAuthorizationRecord {
  id: string;
  createdAt: string;
  roleFamilies: string[];
  filtersSnapshot: Record<string, unknown>;
  filtersHash: string;
  profileVersion: string;
  sourceCvId: string | null;
  sourceCvContentHash: string;
  useSavedAnswers: boolean;
  policyIds: string[];
  confirmTextHash: string;
  stoppedAt: string | null;
  stopReason: string | null;
}

export interface BlindApplyAuthorizationInput {
  roleFamilies: string[];
  filtersSnapshot: Record<string, unknown>;
  filtersHash: string;
  profileVersion: string;
  sourceCvId: string | null;
  sourceCvContentHash: string;
  useSavedAnswers: boolean;
  policyIds: string[];
  confirmTextHash: string;
}

export interface BlindApplyItemRecord {
  id: string;
  authorizationId: string;
  vacancyKey: string;
  identityKey: string;
  company: string;
  role: string;
  applyUrl: string;
  policyId: string | null;
  attemptId: string | null;
  state: BlindApplyItemState;
  stateDetail: string;
  skipReason: BlindApplySkipReason | null;
  intervention: BlindApplyIntervention | null;
  missingFields: BlindApplyMissingField[] | null;
  gateEvidence: BlindApplyGateEvidence;
  prepRetries: number;
  createdAt: string;
  updatedAt: string;
}

export interface BlindApplyItemInput {
  authorizationId: string;
  vacancyKey: string;
  identityKey: string;
  company: string;
  role: string;
  applyUrl: string;
  policyId: string | null;
  state: BlindApplyItemState;
  stateDetail?: string;
  skipReason?: BlindApplySkipReason | null;
  gateEvidence: BlindApplyGateEvidence;
}

export interface BlindApplyEventRecord {
  id: string;
  itemId: string;
  at: string;
  fromState: string | null;
  toState: string;
  kind: BlindApplyEventKind;
  detail: string;
  cvArtifactHash: string | null;
  letterArtifactHash: string | null;
  answers: BlindApplyAnswerUse[] | null;
  receiptId: string | null;
  postingVerificationId: string | null;
}

export interface BlindApplyEventInput {
  kind: BlindApplyEventKind;
  detail?: string;
  cvArtifactHash?: string | null;
  letterArtifactHash?: string | null;
  answers?: BlindApplyAnswerUse[] | null;
  receiptId?: string | null;
  postingVerificationId?: string | null;
}

/** What a transition may change on the item besides its state. Anything not named is left alone. */
export interface BlindApplyItemPatch {
  stateDetail?: string;
  attemptId?: string | null;
  intervention?: BlindApplyIntervention | null;
  missingFields?: BlindApplyMissingField[] | null;
  prepRetries?: number;
}

type AuthorizationRow = typeof blindApplyAuthorizations.$inferSelect;
type ItemRow = typeof blindApplyItems.$inferSelect;
type EventRow = typeof blindApplyEvents.$inferSelect;

function toAuthorization(row: AuthorizationRow): BlindApplyAuthorizationRecord {
  return {
    id: row.id,
    createdAt: row.createdAt.toISOString(),
    roleFamilies: row.roleFamilies,
    filtersSnapshot: row.filtersSnapshot,
    filtersHash: row.filtersHash,
    profileVersion: row.profileVersion,
    sourceCvId: row.sourceCvId,
    sourceCvContentHash: row.sourceCvContentHash,
    useSavedAnswers: row.useSavedAnswers,
    policyIds: row.policyIds,
    confirmTextHash: row.confirmTextHash,
    stoppedAt: row.stoppedAt ? row.stoppedAt.toISOString() : null,
    stopReason: row.stopReason,
  };
}

function toItem(row: ItemRow): BlindApplyItemRecord {
  return {
    id: row.id,
    authorizationId: row.authorizationId,
    vacancyKey: row.vacancyKey,
    identityKey: row.identityKey,
    company: row.company,
    role: row.role,
    applyUrl: row.applyUrl,
    policyId: row.policyId,
    attemptId: row.attemptId,
    state: row.state,
    stateDetail: row.stateDetail,
    skipReason: row.skipReason,
    intervention: row.intervention,
    missingFields: row.missingFields ?? null,
    gateEvidence: row.gateEvidence,
    prepRetries: row.prepRetries,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function toEvent(row: EventRow): BlindApplyEventRecord {
  return {
    id: row.id,
    itemId: row.itemId,
    at: row.at.toISOString(),
    fromState: row.fromState,
    toState: row.toState,
    kind: row.kind,
    detail: row.detail,
    cvArtifactHash: row.cvArtifactHash,
    letterArtifactHash: row.letterArtifactHash,
    answers: row.answers ?? null,
    receiptId: row.receiptId,
    postingVerificationId: row.postingVerificationId,
  };
}

// ------------------------------------------------------------------------------- authorizations

export function createBlindApplyAuthorization(
  db: WorkspaceDb,
  input: BlindApplyAuthorizationInput,
  now: Date = new Date(),
): BlindApplyAuthorizationRecord {
  return db.transaction((tx) => {
    // One active authorization at a time: enabling again after a CV change supersedes the old one.
    tx.update(blindApplyAuthorizations)
      .set({ stoppedAt: now, stopReason: 'replaced by a newer confirmation' })
      .where(isNull(blindApplyAuthorizations.stoppedAt))
      .run();
    const [row] = tx.insert(blindApplyAuthorizations).values({ ...input, createdAt: now }).returning().all();
    if (!row) throw new Error('failed to record the Blind Apply authorization');
    return toAuthorization(row);
  });
}

/** The authorization that is currently allowed to act, or null. Read live, never cached, because the
 * pre-click boundary must see a Stop the instant it is written. */
export function getActiveBlindApplyAuthorization(db: WorkspaceDb): BlindApplyAuthorizationRecord | null {
  const row = db
    .select()
    .from(blindApplyAuthorizations)
    .where(isNull(blindApplyAuthorizations.stoppedAt))
    .orderBy(desc(blindApplyAuthorizations.createdAt))
    .get();
  return row ? toAuthorization(row) : null;
}

export function getBlindApplyAuthorization(db: WorkspaceDb, id: string): BlindApplyAuthorizationRecord | null {
  const row = db.select().from(blindApplyAuthorizations).where(eq(blindApplyAuthorizations.id, id)).get();
  return row ? toAuthorization(row) : null;
}

/** Whether this specific authorization may still act. The check the pre-click boundary makes. */
export function isBlindApplyAuthorizationActive(db: WorkspaceDb, id: string): boolean {
  const row = db
    .select({ stoppedAt: blindApplyAuthorizations.stoppedAt })
    .from(blindApplyAuthorizations)
    .where(eq(blindApplyAuthorizations.id, id))
    .get();
  return row !== undefined && row.stoppedAt === null;
}

/** Stops an authorization. Idempotent: stopping a stopped authorization changes nothing, so a second
 * Stop can never rewrite the time or reason of the first. Returns whether this call stopped it. */
export function stopBlindApplyAuthorization(db: WorkspaceDb, id: string, reason: string, now: Date = new Date()): boolean {
  const updated = db
    .update(blindApplyAuthorizations)
    .set({ stoppedAt: now, stopReason: reason })
    .where(and(eq(blindApplyAuthorizations.id, id), isNull(blindApplyAuthorizations.stoppedAt)))
    .returning({ id: blindApplyAuthorizations.id })
    .all();
  return updated.length > 0;
}

// -------------------------------------------------------------------------------------- items

/** Thrown when a live item for the same employer-and-role identity already exists. */
export class BlindApplyDuplicateItemError extends Error {
  constructor(readonly existingItemId: string) {
    super(`another Blind Apply item (${existingItemId}) already covers this role`);
    this.name = 'BlindApplyDuplicateItemError';
  }
}

export interface InsertBlindApplyItemResult {
  item: BlindApplyItemRecord;
  /** False when this vacancy had already been evaluated under the authorization; nothing was written. */
  created: boolean;
}

/**
 * Records one vacancy under one authorization, once. A vacancy already evaluated under the same
 * authorization returns the existing item unchanged, which is what makes candidate selection
 * idempotent: running the tick twice never evaluates (or applies to) the same vacancy twice.
 *
 * A live item for the same employer-and-role identity under any other authorization also refuses the
 * insert of another live item, in the same transaction as the write, so two ticks racing on two
 * postings of the same role cannot both proceed.
 */
export function insertBlindApplyItem(
  db: WorkspaceDb,
  input: BlindApplyItemInput,
  now: Date = new Date(),
): InsertBlindApplyItemResult {
  return db.transaction((tx) => {
    const existing = tx
      .select()
      .from(blindApplyItems)
      .where(and(eq(blindApplyItems.authorizationId, input.authorizationId), eq(blindApplyItems.vacancyKey, input.vacancyKey)))
      .get();
    if (existing) return { item: toItem(existing), created: false };

    if (BLIND_APPLY_LIVE_STATES.includes(input.state)) {
      const blocking = tx
        .select()
        .from(blindApplyItems)
        .where(and(eq(blindApplyItems.identityKey, input.identityKey), inArray(blindApplyItems.state, [...IDENTITY_BLOCKING_STATES])))
        .get();
      if (blocking) throw new BlindApplyDuplicateItemError(blocking.id);
    }

    const [row] = tx
      .insert(blindApplyItems)
      .values({
        authorizationId: input.authorizationId,
        vacancyKey: input.vacancyKey,
        identityKey: input.identityKey,
        company: input.company,
        role: input.role,
        applyUrl: input.applyUrl,
        policyId: input.policyId,
        state: input.state,
        stateDetail: input.stateDetail ?? '',
        skipReason: input.skipReason ?? null,
        gateEvidence: input.gateEvidence,
        createdAt: now,
        updatedAt: now,
      })
      .returning()
      .all();
    if (!row) throw new Error('failed to record the Blind Apply item');
    tx.insert(blindApplyEvents)
      .values({
        itemId: row.id,
        at: now,
        fromState: null,
        toState: input.state,
        kind: 'gate',
        detail: input.stateDetail ?? '',
      })
      .run();
    return { item: toItem(row), created: true };
  });
}

export function getBlindApplyItem(db: WorkspaceDb, id: string): BlindApplyItemRecord | null {
  const row = db.select().from(blindApplyItems).where(eq(blindApplyItems.id, id)).get();
  return row ? toItem(row) : null;
}

export function getBlindApplyItemByAttempt(db: WorkspaceDb, attemptId: string): BlindApplyItemRecord | null {
  const row = db.select().from(blindApplyItems).where(eq(blindApplyItems.attemptId, attemptId)).get();
  return row ? toItem(row) : null;
}

export function listBlindApplyItems(
  db: WorkspaceDb,
  filter: { authorizationId?: string; states?: readonly BlindApplyItemState[] } = {},
): BlindApplyItemRecord[] {
  const conditions = [];
  if (filter.authorizationId) conditions.push(eq(blindApplyItems.authorizationId, filter.authorizationId));
  if (filter.states) conditions.push(inArray(blindApplyItems.state, [...filter.states]));
  return db
    .select()
    .from(blindApplyItems)
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .orderBy(desc(blindApplyItems.updatedAt), desc(blindApplyItems.createdAt))
    .all()
    .map(toItem);
}

/** Whether another Blind item already covers this employer-and-role identity (live or already sent). */
export function findIdentityBlockingBlindApplyItem(
  db: WorkspaceDb,
  identityKey: string,
  exceptItemId?: string,
): BlindApplyItemRecord | null {
  const rows = db
    .select()
    .from(blindApplyItems)
    .where(and(eq(blindApplyItems.identityKey, identityKey), inArray(blindApplyItems.state, [...IDENTITY_BLOCKING_STATES])))
    .all();
  const row = rows.find((candidate) => candidate.id !== exceptItemId);
  return row ? toItem(row) : null;
}

/**
 * Moves one item from a state it is expected to be in to a new one, and appends the event for it, in a
 * single transaction. Returns the updated item, or `null` when the item was no longer in an expected
 * state (a Stop, a recovery or another tick got there first) -- in which case NOTHING is written, so a
 * losing writer can never overwrite the winner. A terminal state is never an expected state, so a
 * completed item can never be moved again.
 */
export function transitionBlindApplyItem(
  db: WorkspaceDb,
  itemId: string,
  expected: readonly BlindApplyItemState[],
  to: BlindApplyItemState,
  patch: BlindApplyItemPatch,
  event: BlindApplyEventInput,
  now: Date = new Date(),
): BlindApplyItemRecord | null {
  const allowed = expected.filter((state) => !BLIND_APPLY_TERMINAL_STATES.includes(state));
  if (allowed.length === 0) return null;
  return db.transaction((tx) => {
    const current = tx.select().from(blindApplyItems).where(eq(blindApplyItems.id, itemId)).get();
    if (!current || !allowed.includes(current.state)) return null;
    const [row] = tx
      .update(blindApplyItems)
      .set({
        state: to,
        updatedAt: now,
        ...(patch.stateDetail !== undefined ? { stateDetail: patch.stateDetail } : {}),
        ...(patch.attemptId !== undefined ? { attemptId: patch.attemptId } : {}),
        // Cleared on every transition unless the patch names it, so a stale "needs a captcha" never
        // survives into the state after the person dealt with it.
        intervention: patch.intervention ?? null,
        missingFields: patch.missingFields ?? null,
        ...(patch.prepRetries !== undefined ? { prepRetries: patch.prepRetries } : {}),
      })
      .where(and(eq(blindApplyItems.id, itemId), eq(blindApplyItems.state, current.state)))
      .returning()
      .all();
    if (!row) return null;
    tx.insert(blindApplyEvents)
      .values({
        itemId,
        at: now,
        fromState: current.state,
        toState: to,
        kind: event.kind,
        detail: event.detail ?? patch.stateDetail ?? '',
        cvArtifactHash: event.cvArtifactHash ?? null,
        letterArtifactHash: event.letterArtifactHash ?? null,
        answers: event.answers ?? null,
        receiptId: event.receiptId ?? null,
        postingVerificationId: event.postingVerificationId ?? null,
      })
      .run();
    return toItem(row);
  });
}

// ------------------------------------------------------------------------------------- events

/** Appends one event without changing the item's state. There is no update or delete counterpart. */
export function appendBlindApplyEvent(
  db: WorkspaceDb,
  itemId: string,
  state: BlindApplyItemState,
  event: BlindApplyEventInput,
  now: Date = new Date(),
): BlindApplyEventRecord {
  const [row] = db
    .insert(blindApplyEvents)
    .values({
      itemId,
      at: now,
      fromState: state,
      toState: state,
      kind: event.kind,
      detail: event.detail ?? '',
      cvArtifactHash: event.cvArtifactHash ?? null,
      letterArtifactHash: event.letterArtifactHash ?? null,
      answers: event.answers ?? null,
      receiptId: event.receiptId ?? null,
      postingVerificationId: event.postingVerificationId ?? null,
    })
    .returning()
    .all();
  if (!row) throw new Error('failed to append the Blind Apply event');
  return toEvent(row);
}

export function listBlindApplyEvents(db: WorkspaceDb, itemId: string): BlindApplyEventRecord[] {
  return db
    .select()
    .from(blindApplyEvents)
    .where(eq(blindApplyEvents.itemId, itemId))
    .orderBy(asc(blindApplyEvents.at), asc(blindApplyEvents.id))
    .all()
    .map(toEvent);
}

// ------------------------------------------------------------------------------------ answers

export interface BlindApplyAnswerRecord {
  id: string;
  matchKey: string;
  label: string;
  controlType: 'text' | 'textarea' | 'select';
  answer: string;
  optionSetHash: string | null;
  createdAt: string;
  lastUsedAt: string | null;
}

type AnswerRow = typeof blindApplyAnswers.$inferSelect;

function toAnswer(row: AnswerRow): BlindApplyAnswerRecord {
  return {
    id: row.id,
    matchKey: row.matchKey,
    label: row.label,
    controlType: row.controlType,
    answer: row.answer,
    optionSetHash: row.optionSetHash,
    createdAt: row.createdAt.toISOString(),
    lastUsedAt: row.lastUsedAt ? row.lastUsedAt.toISOString() : null,
  };
}

/** Folds incidental differences (accents, case, spacing) and nothing else. Same rule as the reviewed
 * flow's answer library, restated here so Blind Apply's match key cannot drift from its own tests. */
export function normalizeBlindLabel(label: string): string {
  return label
    .normalize('NFKD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

/** A hash of the exact set of option labels a select offered, order-insensitive. A changed option list
 * produces a different hash, so a remembered select answer is never replayed against different choices. */
export function optionSetHashOf(optionLabels: readonly string[]): string {
  const normalized = optionLabels.map(normalizeBlindLabel).sort();
  return createHash('sha256').update(JSON.stringify(normalized)).digest('hex');
}

export function blindAnswerKey(label: string, controlType: 'text' | 'textarea' | 'select', optionSetHash: string | null): string {
  return `${controlType}::${normalizeBlindLabel(label)}::${optionSetHash ?? ''}`;
}

export function findBlindApplyAnswer(db: WorkspaceDb, matchKey: string): BlindApplyAnswerRecord | null {
  const row = db.select().from(blindApplyAnswers).where(eq(blindApplyAnswers.matchKey, matchKey)).get();
  return row ? toAnswer(row) : null;
}

export interface BlindApplyAnswerInput {
  label: string;
  controlType: 'text' | 'textarea' | 'select';
  answer: string;
  optionSetHash: string | null;
}

/** Upserts the one remembered answer for a question. Only ever called from the person's own answer to a
 * `needs_answer` card with "remember" ticked. */
export function saveBlindApplyAnswer(db: WorkspaceDb, input: BlindApplyAnswerInput, now: Date = new Date()): BlindApplyAnswerRecord {
  const matchKey = blindAnswerKey(input.label, input.controlType, input.optionSetHash);
  const [row] = db
    .insert(blindApplyAnswers)
    .values({ matchKey, label: input.label, controlType: input.controlType, answer: input.answer, optionSetHash: input.optionSetHash, createdAt: now })
    .onConflictDoUpdate({ target: blindApplyAnswers.matchKey, set: { answer: input.answer, label: input.label } })
    .returning()
    .all();
  if (!row) throw new Error('failed to save the Blind Apply answer');
  return toAnswer(row);
}

export function recordBlindApplyAnswerUsed(db: WorkspaceDb, id: string, now: Date = new Date()): void {
  db.update(blindApplyAnswers).set({ lastUsedAt: now }).where(eq(blindApplyAnswers.id, id)).run();
}

// ------------------------------------------------------------------------------------- reset

/** Part of the full personal-data reset: removes every Blind Apply record, children first. */
export function deleteAllBlindApply(
  tx: Pick<WorkspaceDb, 'select' | 'delete'>,
): { blindApplyAuthorizations: number; blindApplyItems: number; blindApplyEvents: number; blindApplyAnswers: number } {
  const counts = {
    blindApplyEvents: tx.select({ id: blindApplyEvents.id }).from(blindApplyEvents).all().length,
    blindApplyItems: tx.select({ id: blindApplyItems.id }).from(blindApplyItems).all().length,
    blindApplyAuthorizations: tx.select({ id: blindApplyAuthorizations.id }).from(blindApplyAuthorizations).all().length,
    blindApplyAnswers: tx.select({ id: blindApplyAnswers.id }).from(blindApplyAnswers).all().length,
  };
  tx.delete(blindApplyEvents).run();
  tx.delete(blindApplyItems).run();
  tx.delete(blindApplyAuthorizations).run();
  tx.delete(blindApplyAnswers).run();
  return counts;
}
