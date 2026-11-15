import { createHash, randomUUID } from 'node:crypto';
import { and, asc, eq, isNotNull, isNull } from 'drizzle-orm';
import type { WorkspaceDb } from './client.js';
import { letters, letterVersions } from './schema.js';
import type { LetterType, LetterVersionRecord } from './types.js';

/**
 * #738: the insert-only version history of library letters.
 *
 * `letters` keeps its columns as a copy of the CURRENT version, so every existing reader (the library,
 * interview prep's fallback, the pipeline's "final letter for this vacancy") keeps working unchanged.
 * This module owns the rule for when a save becomes a new version, the one-time backfill of letters
 * that predate versions, and the purge of soft-deleted letters.
 */

type Tx = Pick<WorkspaceDb, 'select' | 'insert' | 'update' | 'delete'>;
type LetterRow = typeof letters.$inferSelect;
type VersionRow = typeof letterVersions.$inferSelect;

/** What makes two versions "the same letter text". Tone, length and the CV link are generation inputs,
 * kept on the version as context, but changing only them does not make a new version. */
export function letterContentHash(content: { title: string; type: LetterType; body: string }): string {
  return createHash('sha256')
    .update(JSON.stringify([content.title, content.type, content.body]))
    .digest('hex');
}

export function toLetterVersion(row: VersionRow): LetterVersionRecord {
  return {
    id: row.id,
    letterId: row.letterId,
    version: row.version,
    title: row.title,
    type: row.type,
    tone: row.tone,
    length: row.length,
    cvId: row.cvId,
    body: row.body,
    contentHash: row.contentHash,
    createdAt: row.createdAt.toISOString(),
  };
}

/** Appends the next version of a letter from its head columns and returns it. */
export function appendLetterVersion(tx: Tx, head: LetterRow, now: Date): VersionRow {
  const existing = tx
    .select({ version: letterVersions.version })
    .from(letterVersions)
    .where(eq(letterVersions.letterId, head.id))
    .all();
  const next = existing.reduce((max, row) => Math.max(max, row.version), 0) + 1;
  const [row] = tx
    .insert(letterVersions)
    .values({
      id: randomUUID(),
      letterId: head.id,
      version: next,
      title: head.title,
      type: head.type,
      tone: head.tone,
      length: head.length,
      cvId: head.cvId,
      body: head.body,
      contentHash: letterContentHash(head),
      createdAt: now,
    })
    .returning()
    .all();
  if (!row) throw new Error('failed to record a letter version');
  tx.update(letters).set({ currentVersionId: row.id }).where(eq(letters.id, head.id)).run();
  return row;
}

export function getLetterVersion(db: Pick<WorkspaceDb, 'select'>, versionId: string): VersionRow | undefined {
  return db.select().from(letterVersions).where(eq(letterVersions.id, versionId)).get();
}

/** Oldest first. Empty for a letter that does not exist or is soft-deleted. */
export function listLetterVersions(db: Pick<WorkspaceDb, 'select'>, letterId: string): LetterVersionRecord[] {
  const head = db
    .select({ id: letters.id })
    .from(letters)
    .where(and(eq(letters.id, letterId), isNull(letters.deletedAt)))
    .get();
  if (!head) return [];
  return db
    .select()
    .from(letterVersions)
    .where(eq(letterVersions.letterId, letterId))
    .orderBy(asc(letterVersions.version))
    .all()
    .map(toLetterVersion);
}

/** The current version's number per letter id (letters with no version yet are absent). */
export function currentVersionNumbers(db: Pick<WorkspaceDb, 'select'>): Map<string, number> {
  const rows = db
    .select({ letterId: letterVersions.letterId, version: letterVersions.version })
    .from(letterVersions)
    .innerJoin(letters, eq(letters.currentVersionId, letterVersions.id))
    .all();
  return new Map(rows.map((row) => [row.letterId, row.version]));
}

/**
 * Gives every letter that has no version yet its version 1, from its current content. Its
 * `created_at` is the letter's `updated_at`, the moment that content provably existed; the letter's
 * own `created_at` stays null because its real creation date was never recorded. Idempotent.
 */
export function backfillLetterVersions(db: WorkspaceDb): number {
  return db.transaction((tx) => {
    const pending = tx.select().from(letters).where(isNull(letters.currentVersionId)).all();
    for (const head of pending) appendLetterVersion(tx, head, head.updatedAt);
    return pending.length;
  });
}

/** Hard-deletes soft-deleted letters (one, or all of them) with their versions. */
export function purgeDeletedLetters(db: Pick<WorkspaceDb, 'delete'>, letterId?: string): number {
  const condition = letterId
    ? and(eq(letters.id, letterId), isNotNull(letters.deletedAt))
    : isNotNull(letters.deletedAt);
  return db.delete(letters).where(condition).returning({ id: letters.id }).all().length;
}
