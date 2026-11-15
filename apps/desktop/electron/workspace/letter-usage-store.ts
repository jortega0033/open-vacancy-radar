import { and, eq, inArray, isNull } from 'drizzle-orm';
import type { WorkspaceDb } from './client.js';
import {
  applicationAttempts,
  applicationDocumentDrafts,
  applications,
  applicationSubmissionPackages,
  letters,
  letterVersions,
} from './schema.js';
import type { LetterUsageRecord, LetterUsageSummary } from './types.js';

/**
 * #738: which applications used a library letter, read from the records that already exist. Nothing
 * here writes, and nothing infers a use: a letter is only linked to an application where a record
 * names its exact version (a #691 submission record or a #690 attempt draft), or where the
 * Applications row links it (shown as "Linked only, no send recorded").
 *
 * Records from before #738 carry no letter reference and are never matched to a letter by text or
 * title, so they simply do not appear here.
 */

type Db = Pick<WorkspaceDb, 'select'>;

const SENT_PROVENANCES = new Set<LetterUsageRecord['provenance']>(['user_confirmed', 'receipt_backed']);

function collectUsage(db: Db, onlyLetterId?: string): Map<string, LetterUsageRecord[]> {
  const byLetter = new Map<string, LetterUsageRecord[]>();
  const add = (letterId: string, usage: LetterUsageRecord): void => {
    if (onlyLetterId && letterId !== onlyLetterId) return;
    const list = byLetter.get(letterId) ?? [];
    list.push(usage);
    byLetter.set(letterId, list);
  };
  const attemptRows = db
    .select({ id: applicationAttempts.id, applicationId: applicationAttempts.applicationId, company: applicationAttempts.company, role: applicationAttempts.role })
    .from(applicationAttempts)
    .all();
  const attempts = new Map(attemptRows.map((row) => [row.id, row]));
  /** `${letterId}|${attemptId}`: an attempt whose submission record already names this letter. */
  const recordedAttempts = new Set<string>();
  /** `${letterId}|${applicationId}`: an Applications row already covered by a record. */
  const coveredRows = new Set<string>();

  // 1. #691 submission records: only the CURRENT manifest of each subject says what is on record now.
  const packages = db
    .select()
    .from(applicationSubmissionPackages)
    .where(eq(applicationSubmissionPackages.status, 'current'))
    .all();
  for (const pkg of packages) {
    for (const doc of pkg.manifest.documents) {
      const ref = doc.libraryLetter;
      if (doc.slot !== 'letter' || !ref) continue;
      const attempt = pkg.attemptId ? attempts.get(pkg.attemptId) : undefined;
      const applicationId = pkg.applicationId ?? attempt?.applicationId ?? null;
      add(ref.letterId, {
        kind: 'recorded',
        applicationId,
        attemptId: pkg.attemptId,
        company: pkg.manifest.requisition.company,
        role: pkg.manifest.requisition.role,
        versionId: ref.versionId,
        version: ref.version,
        provenance: doc.provenance,
        at: doc.statedAt ?? pkg.createdAt.toISOString(),
      });
      if (pkg.attemptId) recordedAttempts.add(`${ref.letterId}|${pkg.attemptId}`);
      if (applicationId) coveredRows.add(`${ref.letterId}|${applicationId}`);
    }
  }

  // 2. #690 attempt drafts staged from a library letter, for attempts with no record naming it yet.
  const drafts = db
    .select()
    .from(applicationDocumentDrafts)
    .where(eq(applicationDocumentDrafts.status, 'current'))
    .all();
  for (const draft of drafts) {
    if (draft.content.type !== 'letter' || !draft.content.libraryLetter) continue;
    const ref = draft.content.libraryLetter;
    if (recordedAttempts.has(`${ref.letterId}|${draft.attemptId}`)) continue;
    const attempt = attempts.get(draft.attemptId);
    // The Applications row already has a record naming this letter: one entry per application.
    if (attempt?.applicationId && coveredRows.has(`${ref.letterId}|${attempt.applicationId}`)) continue;
    add(ref.letterId, {
      kind: 'prepared',
      applicationId: attempt?.applicationId ?? null,
      attemptId: draft.attemptId,
      company: attempt?.company ?? '',
      role: attempt?.role ?? '',
      versionId: ref.versionId,
      version: ref.version,
      provenance: 'prepared',
      at: draft.createdAt.toISOString(),
    });
    if (attempt?.applicationId) coveredRows.add(`${ref.letterId}|${attempt.applicationId}`);
  }

  // 3. Applications rows that link the letter with nothing recording it as sent.
  const linkedRows = db
    .select({ id: applications.id, letterId: applications.letterId, company: applications.company, role: applications.role })
    .from(applications)
    .all();
  for (const row of linkedRows) {
    if (!row.letterId || coveredRows.has(`${row.letterId}|${row.id}`)) continue;
    add(row.letterId, {
      kind: 'linked',
      applicationId: row.id,
      attemptId: null,
      company: row.company,
      role: row.role,
      versionId: null,
      version: null,
      provenance: null,
      at: null,
    });
  }

  for (const list of byLetter.values()) {
    list.sort((a, b) => (b.at ?? '').localeCompare(a.at ?? ''));
  }
  return byLetter;
}

function isLive(db: Db, letterId: string): boolean {
  return db.select({ id: letters.id }).from(letters).where(and(eq(letters.id, letterId), isNull(letters.deletedAt))).get() !== undefined;
}

function isSent(use: LetterUsageRecord): boolean {
  return use.kind === 'recorded' && SENT_PROVENANCES.has(use.provenance) && use.versionId !== null && use.version !== null;
}

/** Every recorded, prepared or linked use of one live letter, newest first. */
export function listLetterUsage(db: Db, letterId: string): LetterUsageRecord[] {
  if (!isLive(db, letterId)) return [];
  return collectUsage(db, letterId).get(letterId) ?? [];
}

/** The library table's per-letter numbers, for live letters with at least one use. */
export function listLetterUsageSummaries(db: Db): LetterUsageSummary[] {
  const live = new Set(
    db.select({ id: letters.id }).from(letters).where(isNull(letters.deletedAt)).all().map((row) => row.id),
  );
  const usage = [...collectUsage(db)].filter(([letterId]) => live.has(letterId));
  // Content hashes of every version a sent record names, and of each letter's current version, so
  // "edited since sent" compares text, not version numbers (restoring the sent text clears it).
  const sentVersionIds = usage.flatMap(([, uses]) => uses.filter(isSent).map((use) => use.versionId as string));
  const hashes = new Map(
    (sentVersionIds.length > 0
      ? db.select({ id: letterVersions.id, hash: letterVersions.contentHash }).from(letterVersions).where(inArray(letterVersions.id, sentVersionIds)).all()
      : []
    ).map((row) => [row.id, row.hash]),
  );
  const currentHashes = new Map(
    db
      .select({ letterId: letters.id, hash: letterVersions.contentHash })
      .from(letters)
      .innerJoin(letterVersions, eq(letters.currentVersionId, letterVersions.id))
      .all()
      .map((row) => [row.letterId, row.hash]),
  );
  return usage.map(([letterId, usages]) => {
    const applicationsUsed = new Set(usages.map((use) => use.applicationId ?? `attempt:${use.attemptId}`));
    const sent = usages.filter(isSent);
    const latest = sent.reduce<LetterUsageRecord | null>((best, use) => (best && (best.version ?? 0) >= (use.version ?? 0) ? best : use), null);
    const sentHash = latest?.versionId ? hashes.get(latest.versionId) : undefined;
    const currentHash = currentHashes.get(letterId);
    return {
      letterId,
      usedIn: applicationsUsed.size,
      latestSentVersion: latest?.version ?? null,
      editedSinceSent: latest !== null && sentHash !== undefined && currentHash !== undefined && sentHash !== currentHash,
    };
  });
}
