import { randomUUID } from 'node:crypto';
import { and, asc, eq } from 'drizzle-orm';
import type { WorkspaceDb } from './client.js';
import { applicationInterviewRounds, applications } from './schema.js';

/**
 * #691: the interview rounds a person records for one Applications row. A local record of their own
 * report: nothing here writes to `applications` (status, notes, next step), the CV, the profile or any
 * evidence table, and a round never counts as an employer's decision.
 */

export const INTERVIEW_ROUND_TYPES = [
  'recruiter_screen',
  'phone_screen',
  'technical',
  'hiring_manager',
  'panel',
  'take_home',
  'onsite',
  'final',
  'other',
] as const;
export type InterviewRoundType = (typeof INTERVIEW_ROUND_TYPES)[number];
export const INTERVIEW_ROUND_STATES = ['planned', 'held'] as const;
export type InterviewRoundState = (typeof INTERVIEW_ROUND_STATES)[number];

export const ROUND_LIMITS = {
  perApplication: 30,
  feedbackChars: 4000,
  topics: 12,
  topicChars: 300,
} as const;

export interface InterviewRoundRecord {
  id: string;
  applicationId: string;
  roundType: InterviewRoundType;
  /** YYYY-MM-DD as the person entered it, or null when no date was recorded. */
  scheduledOn: string | null;
  state: InterviewRoundState;
  feedback: string;
  openTopics: string[];
  createdAt: string;
  updatedAt: string;
}

export interface InterviewRoundInput {
  roundType: InterviewRoundType;
  scheduledOn: string | null;
  state: InterviewRoundState;
  feedback: string;
  openTopics: string[];
}

type Row = typeof applicationInterviewRounds.$inferSelect;
type Tx = Pick<WorkspaceDb, 'select' | 'insert' | 'update' | 'delete'>;

function toRecord(row: Row): InterviewRoundRecord {
  return {
    id: row.id,
    applicationId: row.applicationId,
    roundType: row.roundType,
    scheduledOn: row.scheduledOn,
    state: row.state,
    feedback: row.feedback,
    openTopics: Array.isArray(row.openTopics) ? row.openTopics.filter((topic) => typeof topic === 'string') : [],
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** Rounds in the order they happened: dated rounds by date, undated ones after, then by when recorded. */
export function orderRounds(rounds: readonly InterviewRoundRecord[]): InterviewRoundRecord[] {
  return [...rounds].sort((a, b) => {
    if (a.scheduledOn && b.scheduledOn && a.scheduledOn !== b.scheduledOn) return a.scheduledOn < b.scheduledOn ? -1 : 1;
    if (a.scheduledOn && !b.scheduledOn) return -1;
    if (!a.scheduledOn && b.scheduledOn) return 1;
    return a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0;
  });
}

export function listRounds(db: Pick<WorkspaceDb, 'select'>, applicationId: string): InterviewRoundRecord[] {
  return orderRounds(
    db
      .select()
      .from(applicationInterviewRounds)
      .where(eq(applicationInterviewRounds.applicationId, applicationId))
      .orderBy(asc(applicationInterviewRounds.createdAt))
      .all()
      .map(toRecord),
  );
}

export type RoundWriteResult =
  | { ok: true; round: InterviewRoundRecord }
  | { ok: false; code: 'not_found' | 'limit' | 'outdated' };

export function createRound(tx: Tx, applicationId: string, input: InterviewRoundInput, now: Date): RoundWriteResult {
  const row = tx.select({ id: applications.id }).from(applications).where(eq(applications.id, applicationId)).get();
  if (!row) return { ok: false, code: 'not_found' };
  const count = tx
    .select({ id: applicationInterviewRounds.id })
    .from(applicationInterviewRounds)
    .where(eq(applicationInterviewRounds.applicationId, applicationId))
    .all().length;
  if (count >= ROUND_LIMITS.perApplication) return { ok: false, code: 'limit' };
  const [inserted] = tx
    .insert(applicationInterviewRounds)
    .values({ id: randomUUID(), applicationId, ...input, createdAt: now, updatedAt: now })
    .returning()
    .all();
  if (!inserted) throw new Error('failed to insert an interview round');
  return { ok: true, round: toRecord(inserted) };
}

/** Updates one round of one application. `expectedUpdatedAt` refuses a save made from an outdated form. */
export function updateRound(
  tx: Tx,
  applicationId: string,
  roundId: string,
  input: InterviewRoundInput,
  expectedUpdatedAt: string,
  now: Date,
): RoundWriteResult {
  const existing = tx
    .select()
    .from(applicationInterviewRounds)
    .where(and(eq(applicationInterviewRounds.id, roundId), eq(applicationInterviewRounds.applicationId, applicationId)))
    .get();
  if (!existing) return { ok: false, code: 'not_found' };
  if (existing.updatedAt.toISOString() !== expectedUpdatedAt) return { ok: false, code: 'outdated' };
  const stamp = now.getTime() > existing.updatedAt.getTime() ? now : new Date(existing.updatedAt.getTime() + 1);
  const [updated] = tx
    .update(applicationInterviewRounds)
    .set({ ...input, updatedAt: stamp })
    .where(eq(applicationInterviewRounds.id, roundId))
    .returning()
    .all();
  if (!updated) return { ok: false, code: 'not_found' };
  return { ok: true, round: toRecord(updated) };
}

export function deleteRound(tx: Tx, applicationId: string, roundId: string): boolean {
  const removed = tx
    .delete(applicationInterviewRounds)
    .where(and(eq(applicationInterviewRounds.id, roundId), eq(applicationInterviewRounds.applicationId, applicationId)))
    .returning({ id: applicationInterviewRounds.id })
    .all();
  return removed.length > 0;
}

/** Counted and deleted explicitly by the application data reset. */
export function deleteAllInterviewRounds(tx: Pick<WorkspaceDb, 'select' | 'delete'>): { interviewRounds: number } {
  const count = tx.select({ id: applicationInterviewRounds.id }).from(applicationInterviewRounds).all().length;
  tx.delete(applicationInterviewRounds).run();
  return { interviewRounds: count };
}
