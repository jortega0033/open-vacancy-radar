import { and, asc, desc, eq, inArray, or } from 'drizzle-orm';
import {
  SINGLE_VALUE_TOPICS,
  nameKeyOf,
  normalizeClaim,
  ttlFor,
  type CompanyEvidenceContradictionView,
  type CompanyEvidenceFactData,
  type CompanyEvidenceKeyKind,
  type CompanyEvidenceLinkView,
  type CompanyEvidenceOrigin,
  type CompanyEvidenceProseFact,
  type CompanyEvidenceRefreshOutcome,
  type CompanyEvidenceScope,
  type CompanyEvidenceSourceKind,
  type CompanyEvidenceTopic,
  type CompanyEvidenceVerification,
  type CompanyIdentity,
  type CompanyResearchDiagnostics,
} from '../company-evidence.js';
import type { WorkspaceDb } from './client.js';
import { isHistoricalAttempt } from './posting-verification-store.js';
import {
  applicationAttemptEvidenceUses,
  applicationAttempts,
  companyEvidenceContradictions,
  companyEvidenceFacts,
  companyEvidenceIdentityLinks,
  companyEvidenceRecords,
} from './schema.js';

/**
 * Persistence for #689's company-evidence record. Every write is one transaction that re-reads the
 * record it touches, so a research or refresh result that finishes after the record was deleted or
 * the workspace was reset writes nothing (and can never re-create a record).
 *
 * What this file never does, by construction:
 *  - extend `expiresAt` (only `renewFact`, called after a successful re-fetch, writes a new one);
 *  - key a record by a company name (the unique key is `(verifiedKey, entityRef)`);
 *  - copy a fact between records (a confirmed identity link only lets READS see the other record's
 *    company-scope facts, labelled with where they came from);
 *  - touch an attempt, an artifact or `application_attempt_evidence_uses` when evidence changes.
 *
 * Retention: at most `MAX_FACTS_PER_RECORD` facts per record. Pruning removes withdrawn and
 * superseded facts first, then the oldest expired leads, and never a current fact or one that is
 * part of an open contradiction. A record left with no facts and no reviewed link is deleted.
 */

export const MAX_FACTS_PER_RECORD = 80;

type RecordRow = typeof companyEvidenceRecords.$inferSelect;
type FactRow = typeof companyEvidenceFacts.$inferSelect;
type Tx = Pick<WorkspaceDb, 'select' | 'update' | 'insert' | 'delete'>;

export interface CompanyEvidenceRecord {
  id: string;
  verifiedKey: string;
  keyKind: CompanyEvidenceKeyKind;
  entityRef: string;
  displayName: string;
  nameKey: string;
  host: string | null;
  confirmedNameKeys: string[];
  createdAt: string;
  updatedAt: string;
  lastResearch: CompanyResearchDiagnostics | null;
}

function toRecord(row: RecordRow): CompanyEvidenceRecord {
  return {
    id: row.id,
    verifiedKey: row.verifiedKey,
    keyKind: row.keyKind,
    entityRef: row.entityRef,
    displayName: row.displayName,
    nameKey: row.nameKey,
    host: row.host,
    confirmedNameKeys: Array.isArray(row.confirmedNameKeys) ? [...row.confirmedNameKeys] : [],
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    lastResearch: row.lastResearch ?? null,
  };
}

function iso(value: Date | null): string | null {
  return value ? value.toISOString() : null;
}

function toFact(row: FactRow, contradictedBy: string[], viaLink: string | null): CompanyEvidenceFactData {
  return {
    id: row.id,
    recordId: row.recordId,
    scope: row.scope,
    roleKey: row.roleKey,
    roleLabel: row.roleLabel,
    topic: row.topic,
    claim: row.claim,
    sourceUrl: row.sourceUrl,
    sourceKind: row.sourceKind,
    quote: row.quote,
    retrievedAt: iso(row.retrievedAt),
    observedAt: row.observedAt.toISOString(),
    expiresAt: row.expiresAt.toISOString(),
    verification: row.verification,
    origin: row.origin,
    status: row.status,
    lastRefreshAt: iso(row.lastRefreshAt),
    lastRefreshOutcome: row.lastRefreshOutcome ?? null,
    lastRefreshReason: row.lastRefreshReason ?? null,
    correction: row.correction ?? null,
    contradictedBy,
    viaLink,
  };
}

/* ----------------------------------------------------------------------- records ------------- */

export function getRecord(db: Pick<WorkspaceDb, 'select'>, id: string): CompanyEvidenceRecord | null {
  const row = db.select().from(companyEvidenceRecords).where(eq(companyEvidenceRecords.id, id)).get();
  return row ? toRecord(row) : null;
}

export function findRecord(
  db: Pick<WorkspaceDb, 'select'>,
  verifiedKey: string,
  entityRef = '',
): CompanyEvidenceRecord | null {
  const row = db
    .select()
    .from(companyEvidenceRecords)
    .where(and(eq(companyEvidenceRecords.verifiedKey, verifiedKey), eq(companyEvidenceRecords.entityRef, entityRef)))
    .get();
  return row ? toRecord(row) : null;
}

/** Whether two normalised names are close enough that a person should be asked if they are one company. */
export function namesLookAlike(a: string, b: string): boolean {
  if (a === '' || b === '' || a === b) return a !== '' && a === b;
  const [short, long] = a.length <= b.length ? [a, b] : [b, a];
  return short.length >= 5 && (long.startsWith(`${short}-`) || long.endsWith(`-${short}`));
}

function orderedPair(a: string, b: string): [string, string] {
  return a < b ? [a, b] : [b, a];
}

/**
 * Finds or creates the record for a VERIFIED identity. Creating one proposes (never confirms) an
 * identity link to every existing record whose name looks alike but whose verified key differs.
 */
export function ensureRecord(
  db: WorkspaceDb,
  identity: CompanyIdentity,
  now: Date,
  entityRef = '',
): { record: CompanyEvidenceRecord; created: boolean } {
  if (identity.verifiedKey === null || identity.keyKind === null) {
    throw new Error('a company evidence record needs a verified identity');
  }
  const verifiedKey = identity.verifiedKey;
  const keyKind = identity.keyKind;
  return db.transaction((tx) => {
    const existing = tx
      .select()
      .from(companyEvidenceRecords)
      .where(and(eq(companyEvidenceRecords.verifiedKey, verifiedKey), eq(companyEvidenceRecords.entityRef, entityRef)))
      .get();
    if (existing) return { record: toRecord(existing), created: false };

    const [row] = tx
      .insert(companyEvidenceRecords)
      .values({
        verifiedKey,
        keyKind,
        entityRef,
        displayName: identity.displayName,
        nameKey: identity.nameKey || nameKeyOf(identity.displayName),
        host: identity.host,
        createdAt: now,
        updatedAt: now,
      })
      .returning()
      .all();
    if (!row) throw new Error('could not create the company evidence record');

    for (const other of tx.select().from(companyEvidenceRecords).all()) {
      if (other.id === row.id || other.verifiedKey === row.verifiedKey) continue;
      if (!namesLookAlike(row.nameKey, other.nameKey)) continue;
      const [recordAId, recordBId] = orderedPair(row.id, other.id);
      tx.insert(companyEvidenceIdentityLinks)
        .values({ recordAId, recordBId, reason: 'near_name', status: 'proposed', createdAt: now })
        .onConflictDoNothing()
        .run();
    }
    return { record: toRecord(row), created: true };
  });
}

/** The person confirmed that vacancies naming this company belong to this record's domain. */
export function addConfirmedNameKey(db: WorkspaceDb, recordId: string, nameKey: string, now: Date): boolean {
  if (nameKey === '') return false;
  return db.transaction((tx) => {
    const row = tx.select().from(companyEvidenceRecords).where(eq(companyEvidenceRecords.id, recordId)).get();
    if (!row) return false;
    const keys = Array.isArray(row.confirmedNameKeys) ? row.confirmedNameKeys : [];
    if (!keys.includes(nameKey)) {
      tx.update(companyEvidenceRecords)
        .set({ confirmedNameKeys: [...keys, nameKey].slice(-20), updatedAt: now })
        .where(eq(companyEvidenceRecords.id, recordId))
        .run();
    }
    return true;
  });
}

/** Records the person confirmed for this exact name. More than one means the name is ambiguous. */
export function findRecordsByConfirmedName(db: Pick<WorkspaceDb, 'select'>, nameKey: string): CompanyEvidenceRecord[] {
  if (nameKey === '') return [];
  return db
    .select()
    .from(companyEvidenceRecords)
    .all()
    .filter((row) => Array.isArray(row.confirmedNameKeys) && row.confirmedNameKeys.includes(nameKey))
    .map(toRecord);
}

/** Deletes one record with its facts, contradictions and links. Attempt evidence-use snapshots stay. */
export function deleteRecord(db: WorkspaceDb, recordId: string): { deleted: boolean; facts: number } {
  return db.transaction((tx) => {
    const facts = tx.select({ id: companyEvidenceFacts.id }).from(companyEvidenceFacts).where(eq(companyEvidenceFacts.recordId, recordId)).all().length;
    const removed = tx.delete(companyEvidenceRecords).where(eq(companyEvidenceRecords.id, recordId)).returning({ id: companyEvidenceRecords.id }).all();
    return { deleted: removed.length > 0, facts };
  });
}

/** Everything this module owns, for the Settings data reset. Explicit, so the counts are real. */
export function deleteAllCompanyEvidence(tx: Pick<WorkspaceDb, 'select' | 'delete'>): {
  companyEvidenceRecords: number;
  companyEvidenceFacts: number;
  companyEvidenceLinks: number;
  companyEvidenceUses: number;
} {
  const counts = {
    companyEvidenceRecords: tx.select({ id: companyEvidenceRecords.id }).from(companyEvidenceRecords).all().length,
    companyEvidenceFacts: tx.select({ id: companyEvidenceFacts.id }).from(companyEvidenceFacts).all().length,
    companyEvidenceLinks: tx.select({ id: companyEvidenceIdentityLinks.id }).from(companyEvidenceIdentityLinks).all().length,
    companyEvidenceUses: tx.select({ id: applicationAttemptEvidenceUses.id }).from(applicationAttemptEvidenceUses).all().length,
  };
  tx.delete(companyEvidenceContradictions).run();
  tx.delete(companyEvidenceIdentityLinks).run();
  tx.delete(companyEvidenceFacts).run();
  tx.delete(companyEvidenceRecords).run();
  tx.delete(applicationAttemptEvidenceUses).run();
  return counts;
}

export function recordResearchDiagnostics(
  db: WorkspaceDb,
  recordId: string,
  diagnostics: CompanyResearchDiagnostics,
  now: Date,
): boolean {
  return db.transaction((tx) => {
    const updated = tx
      .update(companyEvidenceRecords)
      .set({ lastResearch: diagnostics, updatedAt: now })
      .where(eq(companyEvidenceRecords.id, recordId))
      .returning({ id: companyEvidenceRecords.id })
      .all();
    return updated.length > 0;
  });
}

/* ------------------------------------------------------------------------- reads ------------- */

function openContradictionsFor(db: Pick<WorkspaceDb, 'select'>, recordIds: readonly string[]): Map<string, string[]> {
  const map = new Map<string, string[]>();
  if (recordIds.length === 0) return map;
  const rows = db
    .select()
    .from(companyEvidenceContradictions)
    .where(and(inArray(companyEvidenceContradictions.recordId, [...recordIds]), eq(companyEvidenceContradictions.status, 'open')))
    .all();
  for (const row of rows) {
    map.set(row.factAId, [...(map.get(row.factAId) ?? []), row.factBId]);
    map.set(row.factBId, [...(map.get(row.factBId) ?? []), row.factAId]);
  }
  return map;
}

export function listLinks(db: Pick<WorkspaceDb, 'select'>, recordId: string): CompanyEvidenceLinkView[] {
  const rows = db
    .select()
    .from(companyEvidenceIdentityLinks)
    .where(or(eq(companyEvidenceIdentityLinks.recordAId, recordId), eq(companyEvidenceIdentityLinks.recordBId, recordId)))
    .orderBy(asc(companyEvidenceIdentityLinks.createdAt))
    .all();
  const views: CompanyEvidenceLinkView[] = [];
  for (const row of rows) {
    const otherId = row.recordAId === recordId ? row.recordBId : row.recordAId;
    const other = getRecord(db, otherId);
    if (!other) continue;
    views.push({ id: row.id, otherRecordId: other.id, otherName: other.displayName, otherHost: other.host, status: row.status });
  }
  return views;
}

export function listOpenContradictions(db: Pick<WorkspaceDb, 'select'>, recordId: string): CompanyEvidenceContradictionView[] {
  return db
    .select()
    .from(companyEvidenceContradictions)
    .where(and(eq(companyEvidenceContradictions.recordId, recordId), eq(companyEvidenceContradictions.status, 'open')))
    .all()
    .map((row) => ({ id: row.id, factAId: row.factAId, factBId: row.factBId, topic: row.topic as CompanyEvidenceTopic }));
}

/**
 * The record's own facts plus the COMPANY-scope facts of every record it has a CONFIRMED link to.
 * Role facts never cross a link, and a proposed or rejected link shares nothing.
 */
export function listFactsForRecord(db: Pick<WorkspaceDb, 'select'>, recordId: string): CompanyEvidenceFactData[] {
  const linked = listLinks(db, recordId).filter((link) => link.status === 'confirmed');
  const ids = [recordId, ...linked.map((link) => link.otherRecordId)];
  const contradictions = openContradictionsFor(db, ids);
  const rows = db
    .select()
    .from(companyEvidenceFacts)
    .where(inArray(companyEvidenceFacts.recordId, ids))
    .orderBy(desc(companyEvidenceFacts.createdAt), asc(companyEvidenceFacts.id))
    .all();
  const nameOf = new Map(linked.map((link) => [link.otherRecordId, link.otherName]));
  return rows
    .filter((row) => row.recordId === recordId || row.scope === 'company')
    .map((row) => toFact(row, contradictions.get(row.id) ?? [], row.recordId === recordId ? null : (nameOf.get(row.recordId) ?? null)));
}

export function getFact(db: Pick<WorkspaceDb, 'select'>, factId: string): CompanyEvidenceFactData | null {
  const row = db.select().from(companyEvidenceFacts).where(eq(companyEvidenceFacts.id, factId)).get();
  if (!row) return null;
  return toFact(row, openContradictionsFor(db, [row.recordId]).get(row.id) ?? [], null);
}

/* ------------------------------------------------------------------------ writes ------------- */

export interface NewCompanyFact {
  recordId: string;
  scope: CompanyEvidenceScope;
  roleKey: string;
  roleLabel: string;
  topic: CompanyEvidenceTopic;
  claim: string;
  sourceUrl: string;
  sourceKind: CompanyEvidenceSourceKind;
  quote: string;
  verification: CompanyEvidenceVerification;
  origin: CompanyEvidenceOrigin;
  /** Set only when the source was actually fetched. */
  retrievedAt: Date | null;
  observedAt: Date;
  contentHash: string | null;
  refreshReason?: string | null;
}

function detectContradictions(tx: Tx, fact: FactRow, now: Date): void {
  if (!SINGLE_VALUE_TOPICS.includes(fact.topic) || fact.status !== 'active') return;
  const peers = tx
    .select()
    .from(companyEvidenceFacts)
    .where(
      and(
        eq(companyEvidenceFacts.recordId, fact.recordId),
        eq(companyEvidenceFacts.topic, fact.topic),
        eq(companyEvidenceFacts.scope, fact.scope),
        eq(companyEvidenceFacts.roleKey, fact.roleKey),
        eq(companyEvidenceFacts.status, 'active'),
      ),
    )
    .all();
  for (const peer of peers) {
    if (peer.id === fact.id) continue;
    if (normalizeClaim(peer.claim) === normalizeClaim(fact.claim)) continue;
    const [factAId, factBId] = orderedPair(fact.id, peer.id);
    tx.insert(companyEvidenceContradictions)
      .values({ recordId: fact.recordId, factAId, factBId, topic: fact.topic, status: 'open', createdAt: now })
      .onConflictDoNothing()
      .run();
  }
}

/** Removes every open contradiction a fact no longer takes part in (it was corrected to agree, withdrawn...). */
function reconcileContradictions(tx: Tx, factId: string, now: Date): void {
  const rows = tx
    .select()
    .from(companyEvidenceContradictions)
    .where(
      and(
        eq(companyEvidenceContradictions.status, 'open'),
        or(eq(companyEvidenceContradictions.factAId, factId), eq(companyEvidenceContradictions.factBId, factId)),
      ),
    )
    .all();
  for (const row of rows) {
    const a = tx.select().from(companyEvidenceFacts).where(eq(companyEvidenceFacts.id, row.factAId)).get();
    const b = tx.select().from(companyEvidenceFacts).where(eq(companyEvidenceFacts.id, row.factBId)).get();
    const stillConflicts =
      a && b && a.status === 'active' && b.status === 'active' && normalizeClaim(a.claim) !== normalizeClaim(b.claim);
    if (!stillConflicts) {
      tx.update(companyEvidenceContradictions)
        .set({ status: 'resolved', resolvedAt: now })
        .where(eq(companyEvidenceContradictions.id, row.id))
        .run();
    }
  }
}

/**
 * Inserts a fact, or returns the existing one for the same record, scope, role, claim and source
 * (so an overlapping add or a repeated research run never duplicates). Returns null when the
 * record is gone.
 */
export function insertFact(
  db: WorkspaceDb,
  input: NewCompanyFact,
  now: Date,
): { id: string; duplicate: boolean } | null {
  return db.transaction((tx) => {
    const record = tx.select({ id: companyEvidenceRecords.id }).from(companyEvidenceRecords).where(eq(companyEvidenceRecords.id, input.recordId)).get();
    if (!record) return null;
    // A company-scope claim has no role, whatever role the person happened to be looking at.
    const roleKey = input.scope === 'role' ? input.roleKey : '';

    const sameKey = tx
      .select()
      .from(companyEvidenceFacts)
      .where(
        and(
          eq(companyEvidenceFacts.recordId, input.recordId),
          eq(companyEvidenceFacts.scope, input.scope),
          eq(companyEvidenceFacts.roleKey, roleKey),
          eq(companyEvidenceFacts.sourceUrl, input.sourceUrl),
        ),
      )
      .all()
      .find((row) => normalizeClaim(row.claim) === normalizeClaim(input.claim) && row.status !== 'withdrawn');
    if (sameKey) return { id: sameKey.id, duplicate: true };

    const [row] = tx
      .insert(companyEvidenceFacts)
      .values({
        recordId: input.recordId,
        scope: input.scope,
        roleKey,
        roleLabel: input.scope === 'role' ? input.roleLabel : '',
        topic: input.topic,
        claim: input.claim,
        sourceUrl: input.sourceUrl,
        sourceKind: input.sourceKind,
        quote: input.quote,
        retrievedAt: input.retrievedAt,
        observedAt: input.observedAt,
        expiresAt: new Date(input.observedAt.getTime() + ttlFor(input.scope)),
        verification: input.verification,
        origin: input.origin,
        status: 'active',
        contentHash: input.contentHash,
        lastRefreshReason: input.refreshReason ?? null,
        createdAt: now,
      })
      .returning()
      .all();
    if (!row) throw new Error('could not store the company fact');
    detectContradictions(tx, row, now);
    tx.update(companyEvidenceRecords).set({ updatedAt: now }).where(eq(companyEvidenceRecords.id, input.recordId)).run();
    pruneRecordTx(tx, input.recordId, now);
    return { id: row.id, duplicate: false };
  });
}

function activeFact(tx: Tx, factId: string): FactRow | undefined {
  const row = tx.select().from(companyEvidenceFacts).where(eq(companyEvidenceFacts.id, factId)).get();
  return row && row.status === 'active' ? row : undefined;
}

/** A fetched source confirmed the claim: the only function (with `confirmFactByUser`) that moves `expiresAt`. */
export function renewFact(
  db: WorkspaceDb,
  factId: string,
  fetched: { retrievedAt: Date; contentHash: string | null },
  now: Date,
): boolean {
  return db.transaction((tx) => {
    const row = activeFact(tx, factId);
    if (!row) return false;
    tx.update(companyEvidenceFacts)
      .set({
        retrievedAt: fetched.retrievedAt,
        observedAt: fetched.retrievedAt,
        expiresAt: new Date(fetched.retrievedAt.getTime() + ttlFor(row.scope)),
        verification: row.verification === 'user_confirmed' ? 'user_confirmed' : 'source_confirmed',
        contentHash: fetched.contentHash,
        lastRefreshAt: now,
        lastRefreshOutcome: 'renewed',
        lastRefreshReason: null,
      })
      .where(eq(companyEvidenceFacts.id, factId))
      .run();
    return true;
  });
}

/**
 * Records a refresh that did NOT renew support: `retrievedAt`, `observedAt` and `expiresAt` are
 * left exactly as they were, so a failed or cancelled attempt can never make stale evidence look
 * fresh. A `source_changed` outcome demotes the claim to an unverified lead.
 */
export function recordRefreshAttempt(
  db: WorkspaceDb,
  factId: string,
  outcome: Exclude<CompanyEvidenceRefreshOutcome, 'renewed'>,
  reason: string,
  now: Date,
): boolean {
  return db.transaction((tx) => {
    const row = activeFact(tx, factId);
    if (!row) return false;
    tx.update(companyEvidenceFacts)
      .set({
        lastRefreshAt: now,
        lastRefreshOutcome: outcome,
        lastRefreshReason: reason,
        ...(outcome === 'source_changed' ? { verification: 'unverified' as const } : {}),
      })
      .where(eq(companyEvidenceFacts.id, factId))
      .run();
    return true;
  });
}

/** The person read the source and confirms it says this. An explicit, attributed observation. */
export function confirmFactByUser(db: WorkspaceDb, factId: string, now: Date): boolean {
  return db.transaction((tx) => {
    const row = activeFact(tx, factId);
    if (!row) return false;
    tx.update(companyEvidenceFacts)
      .set({
        verification: 'user_confirmed',
        observedAt: now,
        expiresAt: new Date(now.getTime() + ttlFor(row.scope)),
      })
      .where(eq(companyEvidenceFacts.id, factId))
      .run();
    return true;
  });
}

/** A source fetched for the first time confirmed a lead (user-supplied or researched). */
export function confirmFactFromFetch(
  db: WorkspaceDb,
  factId: string,
  fetched: { retrievedAt: Date; contentHash: string | null },
  now: Date,
): boolean {
  return db.transaction((tx) => {
    const row = activeFact(tx, factId);
    if (!row) return false;
    tx.update(companyEvidenceFacts)
      .set({
        verification: row.verification === 'user_confirmed' ? 'user_confirmed' : 'source_confirmed',
        retrievedAt: fetched.retrievedAt,
        observedAt: fetched.retrievedAt,
        expiresAt: new Date(fetched.retrievedAt.getTime() + ttlFor(row.scope)),
        contentHash: fetched.contentHash,
        lastRefreshAt: now,
        lastRefreshOutcome: 'renewed',
        lastRefreshReason: null,
      })
      .where(eq(companyEvidenceFacts.id, factId))
      .run();
    return true;
  });
}

/**
 * The person corrected the wording. The first wording is kept as provenance, support is withdrawn
 * until the corrected claim is confirmed against its source, and `expiresAt` is NOT moved.
 */
export function correctFact(db: WorkspaceDb, factId: string, claim: string, now: Date): boolean {
  return db.transaction((tx) => {
    const row = activeFact(tx, factId);
    if (!row) return false;
    const [updated] = tx
      .update(companyEvidenceFacts)
      .set({
        claim,
        verification: 'unverified',
        correction: row.correction ?? { originalClaim: row.claim, correctedAt: now.toISOString() },
      })
      .where(eq(companyEvidenceFacts.id, factId))
      .returning()
      .all();
    if (updated) {
      reconcileContradictions(tx, factId, now);
      detectContradictions(tx, updated, now);
    }
    return true;
  });
}

export function withdrawFact(db: WorkspaceDb, factId: string, now: Date): boolean {
  return db.transaction((tx) => {
    const row = tx.select().from(companyEvidenceFacts).where(eq(companyEvidenceFacts.id, factId)).get();
    if (!row) return false;
    tx.update(companyEvidenceFacts).set({ status: 'withdrawn' }).where(eq(companyEvidenceFacts.id, factId)).run();
    reconcileContradictions(tx, factId, now);
    pruneRecordTx(tx, row.recordId, now);
    return true;
  });
}

/** Keeps `keepFactId`, marks the other side `superseded` (kept as provenance, never supported again). */
export function resolveContradiction(db: WorkspaceDb, contradictionId: string, keepFactId: string, now: Date): boolean {
  return db.transaction((tx) => {
    const row = tx.select().from(companyEvidenceContradictions).where(eq(companyEvidenceContradictions.id, contradictionId)).get();
    if (!row || row.status !== 'open') return false;
    if (keepFactId !== row.factAId && keepFactId !== row.factBId) return false;
    const otherId = keepFactId === row.factAId ? row.factBId : row.factAId;
    tx.update(companyEvidenceFacts).set({ status: 'superseded' }).where(eq(companyEvidenceFacts.id, otherId)).run();
    tx.update(companyEvidenceContradictions)
      .set({ status: 'resolved', resolvedFactId: keepFactId, resolvedAt: now })
      .where(eq(companyEvidenceContradictions.id, contradictionId))
      .run();
    reconcileContradictions(tx, otherId, now);
    return true;
  });
}

export function decideLink(db: WorkspaceDb, linkId: string, decision: 'confirmed' | 'rejected', now: Date): boolean {
  return db.transaction((tx) => {
    const updated = tx
      .update(companyEvidenceIdentityLinks)
      .set({ status: decision, decidedAt: now })
      .where(eq(companyEvidenceIdentityLinks.id, linkId))
      .returning({ id: companyEvidenceIdentityLinks.id })
      .all();
    return updated.length > 0;
  });
}

/* ----------------------------------------------------------------------- retention ----------- */

function pruneRecordTx(tx: Tx, recordId: string, now: Date): void {
  const rows = tx.select().from(companyEvidenceFacts).where(eq(companyEvidenceFacts.recordId, recordId)).all();
  const inOpenContradiction = new Set<string>();
  for (const row of tx
    .select()
    .from(companyEvidenceContradictions)
    .where(and(eq(companyEvidenceContradictions.recordId, recordId), eq(companyEvidenceContradictions.status, 'open')))
    .all()) {
    inOpenContradiction.add(row.factAId);
    inOpenContradiction.add(row.factBId);
  }
  // Withdrawn facts carry nothing worth keeping once nothing references them.
  const withdrawn = rows.filter((row) => row.status === 'withdrawn' && !inOpenContradiction.has(row.id));
  if (withdrawn.length > 0) {
    tx.delete(companyEvidenceFacts).where(inArray(companyEvidenceFacts.id, withdrawn.map((row) => row.id))).run();
  }
  const remaining = rows.filter((row) => !withdrawn.includes(row));
  let excess = remaining.length - MAX_FACTS_PER_RECORD;
  if (excess <= 0) return;
  const droppable = remaining
    .filter((row) => !inOpenContradiction.has(row.id))
    .filter((row) => row.status !== 'active' || row.expiresAt.getTime() <= now.getTime() || row.verification === 'unverified')
    .sort((a, b) => Number(b.status !== 'active') - Number(a.status !== 'active') || a.createdAt.getTime() - b.createdAt.getTime());
  const victims: string[] = [];
  for (const row of droppable) {
    if (excess <= 0) break;
    victims.push(row.id);
    excess -= 1;
  }
  if (victims.length > 0) tx.delete(companyEvidenceFacts).where(inArray(companyEvidenceFacts.id, victims)).run();
}

/** Deletes a record left with no facts and no reviewed link, so nothing is orphaned. */
export function pruneEmptyRecord(db: WorkspaceDb, recordId: string): boolean {
  return db.transaction((tx) => {
    const facts = tx.select({ id: companyEvidenceFacts.id }).from(companyEvidenceFacts).where(eq(companyEvidenceFacts.recordId, recordId)).all();
    if (facts.length > 0) return false;
    const decided = tx
      .select({ id: companyEvidenceIdentityLinks.id, status: companyEvidenceIdentityLinks.status })
      .from(companyEvidenceIdentityLinks)
      .where(or(eq(companyEvidenceIdentityLinks.recordAId, recordId), eq(companyEvidenceIdentityLinks.recordBId, recordId)))
      .all()
      .some((link) => link.status !== 'proposed');
    if (decided) return false;
    return tx.delete(companyEvidenceRecords).where(eq(companyEvidenceRecords.id, recordId)).returning({ id: companyEvidenceRecords.id }).all().length > 0;
  });
}

/* ---------------------------------------------------------------- what a letter used ---------- */

export interface AttemptEvidenceUse {
  id: string;
  usedIn: 'cover_letter';
  claim: string;
  sourceUrl: string;
  scope: CompanyEvidenceScope;
  retrievedAt: string | null;
  observedAt: string;
  verification: 'source_confirmed' | 'user_confirmed';
  recordedAt: string;
}

/** Replaces this attempt's snapshot with exactly what the current letter used (a restart regenerates it). */
export function recordEvidenceUses(
  db: WorkspaceDb,
  attemptId: string,
  facts: readonly CompanyEvidenceProseFact[],
  now: Date,
): void {
  db.transaction((tx) => {
    // A submitted (or submitting / user-reported / skipped) attempt's history is never rewritten.
    const attempt = tx
      .select({ checkpoint: applicationAttempts.checkpoint, submittedAt: applicationAttempts.submittedAt })
      .from(applicationAttempts)
      .where(eq(applicationAttempts.id, attemptId))
      .get();
    if (!attempt || isHistoricalAttempt(attempt)) return;
    tx.delete(applicationAttemptEvidenceUses).where(eq(applicationAttemptEvidenceUses.attemptId, attemptId)).run();
    for (const fact of facts) {
      tx.insert(applicationAttemptEvidenceUses)
        .values({
          attemptId,
          usedIn: 'cover_letter',
          claim: fact.claim,
          sourceUrl: fact.sourceUrl,
          scope: fact.scope,
          retrievedAt: fact.retrievedAt ? new Date(fact.retrievedAt) : null,
          observedAt: new Date(fact.observedAt),
          verification: fact.verification,
          recordedAt: now,
        })
        .run();
    }
  });
}

export function listEvidenceUses(db: Pick<WorkspaceDb, 'select'>, attemptId: string): AttemptEvidenceUse[] {
  return db
    .select()
    .from(applicationAttemptEvidenceUses)
    .where(eq(applicationAttemptEvidenceUses.attemptId, attemptId))
    .orderBy(asc(applicationAttemptEvidenceUses.recordedAt), asc(applicationAttemptEvidenceUses.id))
    .all()
    .map((row) => ({
      id: row.id,
      usedIn: row.usedIn,
      claim: row.claim,
      sourceUrl: row.sourceUrl,
      scope: row.scope,
      retrievedAt: iso(row.retrievedAt),
      observedAt: row.observedAt.toISOString(),
      verification: row.verification,
      recordedAt: row.recordedAt.toISOString(),
    }));
}
