import { createHash } from 'node:crypto';
import { eq, inArray, or } from 'drizzle-orm';
import {
  BRIEF_JD_MAX_CHARS,
  BRIEF_MAX_NOTICES,
  type BriefNotice,
  type BriefSourceFacts,
  type FrozenBrief,
  type StoredAssessment,
} from '../application-brief.js';
import type { WorkspaceDb } from './client.js';
import { applicationAttempts, applicationBriefAliases, applicationBriefPins, applicationBriefs, savedJobs } from './schema.js';

/**
 * Persistence for #688's application brief. One row per canonical job; every other way that job was
 * seen is an alias row. All writes are single transactions that re-read what they touch.
 *
 * What this file never does, by construction:
 *  - write a preference into `sourceFacts` (the only writer of `sourceFacts` is `upsertBrief`, and its
 *    caller passes scan data only);
 *  - update or delete a pin other than through the owning attempt's cascade or a full reset;
 *  - merge two briefs that carry different requisition identities;
 *  - keep CV text, notes or letters.
 */

export type AliasKind = 'requisition' | 'canonical_url' | 'semantic' | 'vacancy_key' | 'saved_job' | 'attempt';
export type IdentityKind = 'requisition' | 'canonical_url' | 'semantic';

export interface BriefAlias {
  key: string;
  kind: AliasKind;
  label?: string;
  provider?: string | null;
  url?: string | null;
}

export interface StoredBrief {
  id: string;
  identityKey: string;
  identityKind: IdentityKind;
  employerKey: string | null;
  requisitionId: string | null;
  company: string;
  role: string;
  location: string;
  facts: BriefSourceFacts | null;
  jdText: string | null;
  jdHash: string | null;
  jdComplete: boolean;
  jdCapturedAt: string | null;
  jdChangedAt: string | null;
  assessment: StoredAssessment | null;
  notices: BriefNotice[];
  factsVersion: number;
  createdAt: string;
  updatedAt: string;
}

export interface StoredAlias {
  aliasKey: string;
  briefId: string;
  kind: AliasKind;
  label: string;
  provider: string | null;
  url: string | null;
  firstSeenAt: string;
  lastSeenAt: string;
}

type BriefRow = typeof applicationBriefs.$inferSelect;
type AliasRow = typeof applicationBriefAliases.$inferSelect;

const STRENGTH: Record<IdentityKind, number> = { requisition: 3, canonical_url: 2, semantic: 1 };

export function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

function toStored(row: BriefRow): StoredBrief {
  return {
    id: row.id,
    identityKey: row.identityKey,
    identityKind: row.identityKind,
    employerKey: row.employerKey,
    requisitionId: row.requisitionId,
    company: row.company,
    role: row.role,
    location: row.location,
    facts: row.sourceFacts ?? null,
    jdText: row.jdText,
    jdHash: row.jdHash,
    jdComplete: row.jdComplete,
    jdCapturedAt: row.jdCapturedAt ? row.jdCapturedAt.toISOString() : null,
    jdChangedAt: row.jdChangedAt ? row.jdChangedAt.toISOString() : null,
    assessment: row.assessment ?? null,
    notices: row.notices ?? [],
    factsVersion: row.factsVersion,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function toAlias(row: AliasRow): StoredAlias {
  return {
    aliasKey: row.aliasKey,
    briefId: row.briefId,
    kind: row.kind,
    label: row.label,
    provider: row.provider,
    url: row.url,
    firstSeenAt: row.firstSeenAt.toISOString(),
    lastSeenAt: row.lastSeenAt.toISOString(),
  };
}

// --------------------------------------------------------------------------------------- reads

export function getBriefById(db: Pick<WorkspaceDb, 'select'>, id: string): StoredBrief | null {
  const row = db.select().from(applicationBriefs).where(eq(applicationBriefs.id, id)).get();
  return row ? toStored(row) : null;
}

/** The brief that owns the first of these aliases, in the order given (strongest first). */
export function findBriefByAliases(db: Pick<WorkspaceDb, 'select'>, keys: readonly string[]): StoredBrief | null {
  if (keys.length === 0) return null;
  const rows = db.select().from(applicationBriefAliases).where(inArray(applicationBriefAliases.aliasKey, [...keys])).all();
  for (const key of keys) {
    const hit = rows.find((row) => row.aliasKey === key);
    if (hit) return getBriefById(db, hit.briefId);
  }
  return null;
}

export function listAliases(db: Pick<WorkspaceDb, 'select'>, briefId: string): StoredAlias[] {
  return db
    .select()
    .from(applicationBriefAliases)
    .where(eq(applicationBriefAliases.briefId, briefId))
    .all()
    .map(toAlias)
    .sort((a, b) => a.firstSeenAt.localeCompare(b.firstSeenAt) || a.aliasKey.localeCompare(b.aliasKey));
}

export function listBriefs(db: Pick<WorkspaceDb, 'select'>): StoredBrief[] {
  return db.select().from(applicationBriefs).all().map(toStored);
}

// -------------------------------------------------------------------------------------- writes

export interface UpsertBriefInput {
  identity: { kind: IdentityKind; key: string; employerKey: string | null; requisitionId: string | null };
  /** Every way this ONE job is known. The first alias that already exists decides which brief is used. */
  aliases: readonly BriefAlias[];
  display: { company: string; role: string; location: string };
  /** Employer-side scan facts. Null leaves what is stored alone. */
  facts: BriefSourceFacts | null;
  /** The posting text (already reduced to the body the assessment reads). Null leaves it alone. */
  jd: { text: string; complete: boolean } | null;
  now: Date;
}

export interface UpsertBriefResult {
  brief: StoredBrief;
  created: boolean;
  /** Plain-English changes worth showing, already appended to the brief's notices. */
  jdChanged: boolean;
  merged: number;
}

function dateLabel(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function withNotice(notices: readonly BriefNotice[], notice: BriefNotice): BriefNotice[] {
  if (notices.some((existing) => existing.text === notice.text && existing.at.slice(0, 10) === notice.at.slice(0, 10))) {
    return [...notices];
  }
  return [notice, ...notices].slice(0, BRIEF_MAX_NOTICES);
}

/** Moves every alias of `drop` to `keep` and removes `drop`. Never called across two requisitions. */
function mergeInto(tx: Pick<WorkspaceDb, 'select' | 'update' | 'delete'>, keep: BriefRow, drop: BriefRow): BriefRow {
  tx.update(applicationBriefAliases).set({ briefId: keep.id }).where(eq(applicationBriefAliases.briefId, drop.id)).run();
  const keepGeneratedAt = keep.sourceFacts?.generatedAt ?? '';
  const dropGeneratedAt = drop.sourceFacts?.generatedAt ?? '';
  const newerFacts = dropGeneratedAt > keepGeneratedAt;
  const keepAssessedAt = keep.assessment?.inputs.derivedAt ?? '';
  const dropAssessedAt = drop.assessment?.inputs.derivedAt ?? '';
  const [updated] = tx
    .update(applicationBriefs)
    .set({
      sourceFacts: newerFacts ? drop.sourceFacts : keep.sourceFacts,
      assessment: dropAssessedAt > keepAssessedAt ? drop.assessment : keep.assessment,
      jdText: keep.jdText ?? drop.jdText,
      jdHash: keep.jdText !== null ? keep.jdHash : drop.jdHash,
      jdComplete: keep.jdText !== null ? keep.jdComplete : drop.jdComplete,
      jdCapturedAt: keep.jdCapturedAt ?? drop.jdCapturedAt,
      notices: [...(keep.notices ?? []), ...(drop.notices ?? [])].slice(0, BRIEF_MAX_NOTICES),
      factsVersion: keep.factsVersion + 1,
    })
    .where(eq(applicationBriefs.id, keep.id))
    .returning()
    .all();
  tx.delete(applicationBriefs).where(eq(applicationBriefs.id, drop.id)).run();
  return updated ?? keep;
}

export function upsertBrief(db: WorkspaceDb, input: UpsertBriefInput): UpsertBriefResult {
  return db.transaction((tx) => {
    const { now } = input;
    const aliasKeys = input.aliases.map((alias) => alias.key);
    const existingRows = aliasKeys.length
      ? tx.select().from(applicationBriefAliases).where(inArray(applicationBriefAliases.aliasKey, aliasKeys)).all()
      : [];
    // Briefs in the order their first matching alias appears (strongest alias first).
    const briefIds: string[] = [];
    for (const key of aliasKeys) {
      const hit = existingRows.find((row) => row.aliasKey === key);
      if (hit && !briefIds.includes(hit.briefId)) briefIds.push(hit.briefId);
    }
    const found = briefIds
      .map((id) => tx.select().from(applicationBriefs).where(eq(applicationBriefs.id, id)).get())
      .filter((row): row is BriefRow => row !== undefined);

    let created = false;
    let merged = 0;
    let row: BriefRow;
    if (found.length === 0) {
      created = true;
      const [inserted] = tx
        .insert(applicationBriefs)
        .values({
          identityKey: input.identity.key,
          identityKind: input.identity.kind,
          employerKey: input.identity.employerKey,
          requisitionId: input.identity.requisitionId,
          company: input.display.company,
          role: input.display.role,
          location: input.display.location,
          createdAt: now,
          updatedAt: now,
        })
        .returning()
        .all();
      if (!inserted) throw new Error('failed to insert application brief');
      row = inserted;
    } else {
      row = found[0]!;
      for (const other of found.slice(1)) {
        // Two requisitions are never one job, whatever a weak alias suggests.
        const bothRequisitions =
          row.identityKind === 'requisition' && other.identityKind === 'requisition' && row.identityKey !== other.identityKey;
        if (bothRequisitions) continue;
        // Keep the stronger identity as the surviving row.
        const keepOther = STRENGTH[other.identityKind] > STRENGTH[row.identityKind];
        row = keepOther ? mergeInto(tx, other, row) : mergeInto(tx, row, other);
        merged += 1;
      }
    }

    // Upgrade a weak identity to the strongest one now known, when that key is free.
    if (STRENGTH[input.identity.kind] > STRENGTH[row.identityKind]) {
      const taken = tx.select().from(applicationBriefs).where(eq(applicationBriefs.identityKey, input.identity.key)).get();
      if (!taken || taken.id === row.id) {
        const [upgraded] = tx
          .update(applicationBriefs)
          .set({
            identityKey: input.identity.key,
            identityKind: input.identity.kind,
            employerKey: input.identity.employerKey,
            requisitionId: input.identity.requisitionId,
          })
          .where(eq(applicationBriefs.id, row.id))
          .returning()
          .all();
        if (upgraded) row = upgraded;
      }
    }

    // Attach aliases that nobody else owns; refresh the ones this brief already owns.
    for (const alias of input.aliases) {
      const owner = tx.select().from(applicationBriefAliases).where(eq(applicationBriefAliases.aliasKey, alias.key)).get();
      if (owner && owner.briefId !== row.id) continue;
      if (owner) {
        tx.update(applicationBriefAliases)
          .set({
            lastSeenAt: now,
            label: alias.label ?? owner.label,
            provider: alias.provider ?? owner.provider,
            url: alias.url ?? owner.url,
          })
          .where(eq(applicationBriefAliases.aliasKey, alias.key))
          .run();
      } else {
        tx.insert(applicationBriefAliases)
          .values({
            aliasKey: alias.key,
            briefId: row.id,
            kind: alias.kind,
            label: alias.label ?? '',
            provider: alias.provider ?? null,
            url: alias.url ?? null,
            firstSeenAt: now,
            lastSeenAt: now,
          })
          .run();
      }
    }

    const patch: Partial<typeof applicationBriefs.$inferInsert> = {
      company: input.display.company,
      role: input.display.role,
      location: input.display.location,
    };
    let notices: BriefNotice[] = row.notices ?? [];
    let factsVersion = row.factsVersion;
    let jdChanged = false;
    if (merged > 0) {
      notices = withNotice(notices, {
        at: now.toISOString(),
        section: 'relevance',
        text: 'Two copies of this job turned out to be the same requisition, so they now share one brief.',
      });
      factsVersion += 1;
    }

    if (input.facts !== null) {
      const storedAt = row.sourceFacts?.generatedAt ?? null;
      const incomingAt = input.facts.generatedAt;
      // Only a STRICTLY newer scan replaces employer facts: re-reading the same scan never rewrites
      // what was captured when its preferences were known, and never moves the write fence.
      if (row.sourceFacts === null || storedAt === null || (incomingAt !== null && incomingAt > storedAt)) {
        patch.sourceFacts = input.facts;
        const strip = (facts: BriefSourceFacts | null): string => JSON.stringify(facts && { ...facts, capturedAt: '' });
        if (strip(row.sourceFacts) !== strip(input.facts)) factsVersion += 1;
      }
    }

    if (input.jd !== null && input.jd.text.trim().length > 0) {
      const clipped = input.jd.text.length > BRIEF_JD_MAX_CHARS;
      const text = clipped ? input.jd.text.slice(0, BRIEF_JD_MAX_CHARS) : input.jd.text;
      const hash = sha256(text);
      if (row.jdHash === null) {
        patch.jdText = text;
        patch.jdHash = hash;
        patch.jdComplete = input.jd.complete && !clipped;
        patch.jdCapturedAt = now;
        factsVersion += 1;
      } else if (row.jdHash !== hash) {
        patch.jdText = text;
        patch.jdHash = hash;
        patch.jdComplete = input.jd.complete && !clipped;
        patch.jdChangedAt = now;
        jdChanged = true;
        factsVersion += 1;
        notices = withNotice(notices, {
          at: now.toISOString(),
          section: 'assessment',
          text: `The job description changed on ${dateLabel(now)}. Anything judged against the earlier text is out of date.`,
        });
      }
    }

    const [saved] = tx
      .update(applicationBriefs)
      .set({ ...patch, notices, factsVersion, updatedAt: now })
      .where(eq(applicationBriefs.id, row.id))
      .returning()
      .all();
    return { brief: toStored(saved ?? row), created, jdChanged, merged };
  });
}

/**
 * Stores the derived assessment, but only if the brief's employer facts/posting text are still the
 * ones the caller derived it from. A caller that lost the race gets `false` and writes nothing.
 */
export function saveAssessment(
  db: WorkspaceDb,
  briefId: string,
  assessment: StoredAssessment | null,
  expected: { jdHash: string | null; factsVersion?: number },
  now: Date,
): boolean {
  return db.transaction((tx) => {
    const row = tx.select().from(applicationBriefs).where(eq(applicationBriefs.id, briefId)).get();
    if (!row) return false;
    if (row.jdHash !== expected.jdHash) return false;
    if (expected.factsVersion !== undefined && row.factsVersion !== expected.factsVersion) return false;
    tx.update(applicationBriefs).set({ assessment, updatedAt: now }).where(eq(applicationBriefs.id, briefId)).run();
    return true;
  });
}

export function addBriefNotice(db: WorkspaceDb, briefId: string, notice: BriefNotice, now: Date): void {
  db.transaction((tx) => {
    const row = tx.select().from(applicationBriefs).where(eq(applicationBriefs.id, briefId)).get();
    if (!row) return;
    const notices = withNotice(row.notices ?? [], notice);
    if (notices.length === (row.notices ?? []).length && notices[0] === (row.notices ?? [])[0]) return;
    tx.update(applicationBriefs).set({ notices, updatedAt: now }).where(eq(applicationBriefs.id, briefId)).run();
  });
}

// ----------------------------------------------------------------------------------------- pins

export function getPin(db: Pick<WorkspaceDb, 'select'>, attemptId: string): { snapshot: FrozenBrief; pinnedAt: string } | null {
  const row = db.select().from(applicationBriefPins).where(eq(applicationBriefPins.attemptId, attemptId)).get();
  return row ? { snapshot: row.snapshot, pinnedAt: row.pinnedAt.toISOString() } : null;
}

/** Insert-only. A second pin for the same attempt is ignored: the first one is the record. */
export function pinBriefForAttempt(db: WorkspaceDb, attemptId: string, snapshot: FrozenBrief, now: Date): boolean {
  const inserted = db
    .insert(applicationBriefPins)
    .values({ attemptId, snapshot, pinnedAt: now })
    .onConflictDoNothing()
    .returning({ attemptId: applicationBriefPins.attemptId })
    .all();
  return inserted.length > 0;
}

// -------------------------------------------------------------------------------------- retention

/**
 * Drops `saved:` / `attempt:` references whose row is gone, then every brief nobody references any
 * more. A brief with no saved job and no attempt has no reason to exist; pins survive on their own
 * (they follow the attempt, not the brief).
 */
export function pruneUnreferencedBriefs(db: WorkspaceDb): number {
  return db.transaction((tx) => {
    const savedIds = new Set(tx.select({ id: savedJobs.id }).from(savedJobs).all().map((row) => row.id));
    const attemptIds = new Set(tx.select({ id: applicationAttempts.id }).from(applicationAttempts).all().map((row) => row.id));
    const refs = tx
      .select()
      .from(applicationBriefAliases)
      .where(or(eq(applicationBriefAliases.kind, 'saved_job'), eq(applicationBriefAliases.kind, 'attempt')))
      .all();
    for (const ref of refs) {
      const id = ref.aliasKey.slice(ref.aliasKey.indexOf(':') + 1);
      const alive = ref.kind === 'saved_job' ? savedIds.has(id) : attemptIds.has(id);
      if (!alive) tx.delete(applicationBriefAliases).where(eq(applicationBriefAliases.aliasKey, ref.aliasKey)).run();
    }
    const kept = new Set(
      tx
        .select({ briefId: applicationBriefAliases.briefId })
        .from(applicationBriefAliases)
        .where(or(eq(applicationBriefAliases.kind, 'saved_job'), eq(applicationBriefAliases.kind, 'attempt')))
        .all()
        .map((row) => row.briefId),
    );
    let removed = 0;
    for (const brief of tx.select({ id: applicationBriefs.id }).from(applicationBriefs).all()) {
      if (kept.has(brief.id)) continue;
      tx.delete(applicationBriefs).where(eq(applicationBriefs.id, brief.id)).run();
      removed += 1;
    }
    return removed;
  });
}

/** Counted and deleted explicitly (not left to a cascade) so a reset reports them and none survive it. */
export function deleteAllApplicationBriefs(tx: Pick<WorkspaceDb, 'select' | 'delete'>): {
  applicationBriefs: number;
  applicationBriefAliases: number;
  applicationBriefPins: number;
} {
  const counts = {
    applicationBriefs: tx.select({ id: applicationBriefs.id }).from(applicationBriefs).all().length,
    applicationBriefAliases: tx.select({ key: applicationBriefAliases.aliasKey }).from(applicationBriefAliases).all().length,
    applicationBriefPins: tx.select({ id: applicationBriefPins.attemptId }).from(applicationBriefPins).all().length,
  };
  tx.delete(applicationBriefPins).run();
  tx.delete(applicationBriefAliases).run();
  tx.delete(applicationBriefs).run();
  return counts;
}

// Re-exported for callers that only need to look a saved job's reference up.
export const SAVED_JOB_ALIAS_PREFIX = 'saved:';
export const ATTEMPT_ALIAS_PREFIX = 'attempt:';

export function savedJobAlias(id: string): BriefAlias {
  return { key: `${SAVED_JOB_ALIAS_PREFIX}${id}`, kind: 'saved_job' };
}

export function attemptAlias(id: string): BriefAlias {
  return { key: `${ATTEMPT_ALIAS_PREFIX}${id}`, kind: 'attempt' };
}
