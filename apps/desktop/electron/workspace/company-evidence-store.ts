import { and, asc, desc, eq, inArray, or } from 'drizzle-orm';
import {
  SINGLE_VALUE_TOPICS,
  assessQuoteSupport,
  effectiveTopic,
  factQuoteSupport,
  nameKeyOf,
  normalizeClaim,
  ttlFor,
  unnamedSubjectAllowed,
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
 * Retention: ADMISSION is bounded -- a record holds at most `MAX_FACTS_PER_RECORD` active facts and
 * `MAX_ROWS_PER_RECORD` rows in total (superseded/withdrawn provenance included); a new fact beyond
 * either bound is refused with the stable `record_full` outcome, never silently kept. Withdrawn facts
 * no contradiction references are deleted; when the row bound is reached, the oldest expired or
 * unverified leads outside any open contradiction are pruned first. Current facts, facts in an open
 * contradiction and superseded decisions are never pruned. A record left with no facts and no
 * reviewed link is deleted.
 */

export const MAX_FACTS_PER_RECORD = 80;
export const MAX_ROWS_PER_RECORD = 160;

/** Why `insertFact` stored nothing although the record exists. */
export interface FactRefused {
  refused: 'record_full';
}

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
  /**
   * The concrete vacancies (`application:<id>`, `posting:<canonical url key>`) the person confirmed
   * this domain FOR. A name-only vacancy reaches this record only through its own binding.
   */
  confirmedTargets: string[];
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
    confirmedTargets: Array.isArray(row.confirmedTargets) ? [...row.confirmedTargets] : [],
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
        // The employer's own website only; an ATS tenant record has none.
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

/** Upper bound on remembered confirmation targets per record (oldest dropped first). */
const MAX_CONFIRMED_TARGETS = 500;

/**
 * The person confirmed this record's domain for these concrete vacancies (application / posting
 * keys). Never a bare name: another vacancy that merely shares the name is NOT bound by this.
 */
export function addConfirmedTargets(db: WorkspaceDb, recordId: string, targets: readonly string[], now: Date): boolean {
  const wanted = targets.filter((key) => key !== '');
  if (wanted.length === 0) return false;
  return db.transaction((tx) => {
    const row = tx.select().from(companyEvidenceRecords).where(eq(companyEvidenceRecords.id, recordId)).get();
    if (!row) return false;
    const keys = Array.isArray(row.confirmedTargets) ? row.confirmedTargets : [];
    const merged = [...keys.filter((key) => !wanted.includes(key)), ...wanted].slice(-MAX_CONFIRMED_TARGETS);
    tx.update(companyEvidenceRecords).set({ confirmedTargets: merged, updatedAt: now }).where(eq(companyEvidenceRecords.id, recordId)).run();
    return true;
  });
}

/** Records the person confirmed for any of these concrete vacancy keys. More than one = ambiguous. */
export function findRecordsByConfirmedTargets(db: Pick<WorkspaceDb, 'select'>, targets: readonly string[]): CompanyEvidenceRecord[] {
  const wanted = new Set(targets.filter((key) => key !== ''));
  if (wanted.size === 0) return [];
  return db
    .select()
    .from(companyEvidenceRecords)
    .all()
    .filter((row) => Array.isArray(row.confirmedTargets) && row.confirmedTargets.some((key) => wanted.has(key)))
    .map(toRecord);
}

/** Person-confirmed domains for the same normalised name: offered as SUGGESTIONS, never applied. */
export function findConfirmedDomainsByName(db: Pick<WorkspaceDb, 'select'>, nameKey: string): CompanyEvidenceRecord[] {
  if (nameKey === '') return [];
  return db
    .select()
    .from(companyEvidenceRecords)
    .where(and(eq(companyEvidenceRecords.nameKey, nameKey), eq(companyEvidenceRecords.keyKind, 'user_domain')))
    .all()
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

type ContradictionRow = typeof companyEvidenceContradictions.$inferSelect;

/**
 * Open contradictions among a set of VISIBLE facts: a row counts only when both of its facts are
 * visible. That is what makes a cross-record contradiction (two records joined by a confirmed link)
 * appear while the link is confirmed and disappear by itself when the link is revoked.
 */
function openContradictionsAmong(db: Pick<WorkspaceDb, 'select'>, factIds: readonly string[]): ContradictionRow[] {
  if (factIds.length === 0) return [];
  const visible = new Set(factIds);
  const ids = [...visible];
  return db
    .select()
    .from(companyEvidenceContradictions)
    .where(
      and(
        eq(companyEvidenceContradictions.status, 'open'),
        or(inArray(companyEvidenceContradictions.factAId, ids), inArray(companyEvidenceContradictions.factBId, ids)),
      ),
    )
    .all()
    .filter((row) => visible.has(row.factAId) && visible.has(row.factBId));
}

function contradictionMap(rows: readonly ContradictionRow[]): Map<string, string[]> {
  const map = new Map<string, string[]>();
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

/** Visible rows for a record: its own facts plus the COMPANY-scope facts of confirmed-link records. */
function visibleFactRows(db: Pick<WorkspaceDb, 'select'>, recordId: string): { rows: FactRow[]; nameOf: Map<string, string> } {
  const linked = listLinks(db, recordId).filter((link) => link.status === 'confirmed');
  const ids = [recordId, ...linked.map((link) => link.otherRecordId)];
  const rows = db
    .select()
    .from(companyEvidenceFacts)
    .where(inArray(companyEvidenceFacts.recordId, ids))
    .orderBy(desc(companyEvidenceFacts.createdAt), asc(companyEvidenceFacts.id))
    .all()
    .filter((row) => row.recordId === recordId || row.scope === 'company');
  return { rows, nameOf: new Map(linked.map((link) => [link.otherRecordId, link.otherName])) };
}

/** Open contradictions the person can see from this record, including across a confirmed link. */
export function listOpenContradictions(db: Pick<WorkspaceDb, 'select'>, recordId: string): CompanyEvidenceContradictionView[] {
  const { rows } = visibleFactRows(db, recordId);
  return openContradictionsAmong(db, rows.map((row) => row.id)).map((row) => ({
    id: row.id,
    factAId: row.factAId,
    factBId: row.factBId,
    topic: row.topic as CompanyEvidenceTopic,
  }));
}

/**
 * The record's own facts plus the COMPANY-scope facts of every record it has a CONFIRMED link to.
 * Role facts never cross a link, a proposed or rejected link shares nothing, and a disagreement
 * between this record and a linked one marks BOTH sides contradicted.
 */
export function listFactsForRecord(db: Pick<WorkspaceDb, 'select'>, recordId: string): CompanyEvidenceFactData[] {
  const { rows, nameOf } = visibleFactRows(db, recordId);
  const contradictions = contradictionMap(openContradictionsAmong(db, rows.map((row) => row.id)));
  return rows.map((row) =>
    toFact(row, contradictions.get(row.id) ?? [], row.recordId === recordId ? null : (nameOf.get(row.recordId) ?? null)),
  );
}

export function getFact(db: Pick<WorkspaceDb, 'select'>, factId: string): CompanyEvidenceFactData | null {
  const row = db.select().from(companyEvidenceFacts).where(eq(companyEvidenceFacts.id, factId)).get();
  if (!row) return null;
  const own = visibleFactRows(db, row.recordId).rows.map((fact) => fact.id);
  return toFact(row, contradictionMap(openContradictionsAmong(db, own)).get(row.id) ?? [], null);
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

function insertContradiction(tx: Tx, recordId: string, a: FactRow, b: FactRow, now: Date): void {
  const [factAId, factBId] = orderedPair(a.id, b.id);
  tx.insert(companyEvidenceContradictions)
    .values({ recordId, factAId, factBId, topic: a.topic, status: 'open', createdAt: now })
    .onConflictDoNothing()
    .run();
}

const conflicts = (a: FactRow, b: FactRow): boolean =>
  a.id !== b.id &&
  a.status === 'active' &&
  b.status === 'active' &&
  a.topic === b.topic &&
  SINGLE_VALUE_TOPICS.includes(a.topic) &&
  normalizeClaim(a.claim) !== normalizeClaim(b.claim);

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
  for (const peer of peers) if (conflicts(fact, peer)) insertContradiction(tx, fact.recordId, fact, peer, now);
  syncLinkedContradictionsTx(tx, fact.recordId, now);
}

function confirmedLinkPeers(tx: Tx, recordId: string): string[] {
  return tx
    .select()
    .from(companyEvidenceIdentityLinks)
    .where(
      and(
        eq(companyEvidenceIdentityLinks.status, 'confirmed'),
        or(eq(companyEvidenceIdentityLinks.recordAId, recordId), eq(companyEvidenceIdentityLinks.recordBId, recordId)),
      ),
    )
    .all()
    .map((link) => (link.recordAId === recordId ? link.recordBId : link.recordAId));
}

function activeCompanyFacts(tx: Tx, recordId: string): FactRow[] {
  return tx
    .select()
    .from(companyEvidenceFacts)
    .where(and(eq(companyEvidenceFacts.recordId, recordId), eq(companyEvidenceFacts.scope, 'company'), eq(companyEvidenceFacts.status, 'active')))
    .all()
    .filter((row) => SINGLE_VALUE_TOPICS.includes(row.topic));
}

/**
 * Records a contradiction for every pair of active COMPANY-scope facts, one on each side of a
 * CONFIRMED identity link, that answer the same single-value topic differently. Role facts never
 * take part (they never cross a link). Idempotent.
 */
function syncLinkedContradictionsTx(tx: Tx, recordId: string, now: Date): void {
  const own = activeCompanyFacts(tx, recordId);
  if (own.length === 0) return;
  for (const otherId of confirmedLinkPeers(tx, recordId)) {
    for (const theirs of activeCompanyFacts(tx, otherId)) {
      for (const mine of own) if (conflicts(mine, theirs)) insertContradiction(tx, recordId, mine, theirs, now);
    }
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
): { id: string; duplicate: boolean } | FactRefused | null {
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

    // Admission bound: make room only from what retention may drop, then refuse with a stable code.
    pruneRecordTx(tx, input.recordId, now, 1);
    const existing = tx.select().from(companyEvidenceFacts).where(eq(companyEvidenceFacts.recordId, input.recordId)).all();
    if (existing.length >= MAX_ROWS_PER_RECORD || existing.filter((row) => row.status === 'active').length >= MAX_FACTS_PER_RECORD) {
      return { refused: 'record_full' as const };
    }

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
    return { id: row.id, duplicate: false };
  });
}

function activeFact(tx: Tx, factId: string): FactRow | undefined {
  const row = tx.select().from(companyEvidenceFacts).where(eq(companyEvidenceFacts.id, factId)).get();
  return row && row.status === 'active' ? row : undefined;
}

/**
 * What a fetch actually checked. The store renews or confirms ONLY when the row still carries this
 * exact claim and quote (a correction that landed while the page was being fetched makes the check
 * stale) and the claim passes the quote floor (`factQuoteSupport`) against its saved passage AND
 * against the page text around that passage that the fetch actually saw (`context`). A claim the
 * person did not attest themselves is never confirmed or renewed without that page text (fail closed).
 */
export interface FetchedCheck {
  retrievedAt: Date;
  contentHash: string | null;
  claim: string;
  quote: string;
  /** Employer names for the floor's own-name rule. */
  employerNames: readonly string[];
  /** The verified identity, for the floor's rule on role claims without the employer as subject. */
  identity: Pick<CompanyIdentity, 'verifiedKey' | 'host'>;
  /** The page text around the found passage (`SourceCheck.context`); null only for a person-attested fact. */
  context: string | null;
}

export type FetchApplyOutcome = 'applied' | 'stale' | 'unsupported' | 'gone';

function applyFetchedCheck(tx: Tx, factId: string, fetched: FetchedCheck, now: Date): FetchApplyOutcome {
  const row = activeFact(tx, factId);
  if (!row) return 'gone';
  if (row.claim !== fetched.claim || row.quote !== fetched.quote) return 'stale';
  if (row.verification !== 'user_confirmed') {
    const fact = { claim: row.claim, quote: row.quote, viaLink: null, scope: row.scope, sourceUrl: row.sourceUrl };
    const saved = factQuoteSupport(fact, fetched.employerNames, fetched.identity);
    const onPage =
      saved.ok && fetched.context !== null
        ? assessQuoteSupport(row.claim, fetched.context, fetched.employerNames, {
            unnamedSubjectAllowed: unnamedSubjectAllowed(fact, fetched.identity),
          })
        : null;
    const reason = !saved.ok ? saved.reason : onPage?.ok ? null : 'quote_context_unsupported';
    if (reason !== null) {
      tx.update(companyEvidenceFacts)
        .set({ verification: 'unverified', lastRefreshAt: now, lastRefreshOutcome: 'failed', lastRefreshReason: reason })
        .where(eq(companyEvidenceFacts.id, factId))
        .run();
      return 'unsupported';
    }
  }
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
  return 'applied';
}

/** A re-fetched source still carries the passage: the only path (with `confirmFactByUser`) that moves `expiresAt`. */
export function renewFact(db: WorkspaceDb, factId: string, fetched: FetchedCheck, now: Date): FetchApplyOutcome {
  return db.transaction((tx) => applyFetchedCheck(tx, factId, fetched, now));
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

/** A source fetched for the first time carried the passage of a lead (user-supplied or researched). */
export function confirmFactFromFetch(db: WorkspaceDb, factId: string, fetched: FetchedCheck, now: Date): FetchApplyOutcome {
  return db.transaction((tx) => applyFetchedCheck(tx, factId, fetched, now));
}

/**
 * The person corrected the wording. Support is invalidated, not carried over: verification resets,
 * the content hash is cleared, and the passage the FIRST wording rested on moves into the correction
 * provenance (kept for the record, no longer the support). The active quote becomes the new passage
 * the person supplied, or nothing -- so a refresh cannot re-fetch the old passage and "renew" the
 * new wording. `retrievedAt`, `observedAt` and `expiresAt` are NOT moved.
 */
export function correctFact(db: WorkspaceDb, factId: string, claim: string, now: Date, newQuote = ''): boolean {
  return db.transaction((tx) => {
    const row = activeFact(tx, factId);
    if (!row) return false;
    const [updated] = tx
      .update(companyEvidenceFacts)
      .set({
        claim,
        quote: newQuote,
        // Sponsorship wording in the corrected claim makes it a sponsorship claim, whatever it was before.
        topic: effectiveTopic(row.topic, claim, newQuote),
        verification: 'unverified',
        contentHash: null,
        lastRefreshReason: newQuote === '' ? 'quote_missing' : null,
        correction: row.correction
          ? { ...row.correction, originalQuote: row.correction.originalQuote ?? row.quote }
          : { originalClaim: row.claim, correctedAt: now.toISOString(), originalQuote: row.quote },
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

/**
 * Records the person's decision on an identity link. Confirming records every cross-link
 * contradiction. Revoking (or rejecting) a link undoes what depended on it: a fact that was marked
 * superseded by choosing between the two records' claims becomes active again, and that
 * contradiction is reopened (it stays invisible while the records are not linked, and asks again if
 * they are re-linked).
 */
export function decideLink(db: WorkspaceDb, linkId: string, decision: 'confirmed' | 'rejected', now: Date): boolean {
  return db.transaction((tx) => {
    const link = tx.select().from(companyEvidenceIdentityLinks).where(eq(companyEvidenceIdentityLinks.id, linkId)).get();
    if (!link) return false;
    tx.update(companyEvidenceIdentityLinks).set({ status: decision, decidedAt: now }).where(eq(companyEvidenceIdentityLinks.id, linkId)).run();
    if (decision === 'confirmed') {
      syncLinkedContradictionsTx(tx, link.recordAId, now);
      return true;
    }
    const sides = new Set([link.recordAId, link.recordBId]);
    const crossIds = tx
      .select({ id: companyEvidenceFacts.id, recordId: companyEvidenceFacts.recordId })
      .from(companyEvidenceFacts)
      .where(inArray(companyEvidenceFacts.recordId, [...sides]))
      .all();
    const recordOf = new Map(crossIds.map((row) => [row.id, row.recordId]));
    const ids = [...recordOf.keys()];
    if (ids.length === 0) return true;
    const resolved = tx
      .select()
      .from(companyEvidenceContradictions)
      .where(and(eq(companyEvidenceContradictions.status, 'resolved'), inArray(companyEvidenceContradictions.factAId, ids)))
      .all()
      .filter((row) => recordOf.has(row.factBId) && recordOf.get(row.factAId) !== recordOf.get(row.factBId) && row.resolvedFactId);
    for (const row of resolved) {
      const loser = row.resolvedFactId === row.factAId ? row.factBId : row.factAId;
      tx.update(companyEvidenceFacts)
        .set({ status: 'active' })
        .where(and(eq(companyEvidenceFacts.id, loser), eq(companyEvidenceFacts.status, 'superseded')))
        .run();
      tx.update(companyEvidenceContradictions)
        .set({ status: 'open', resolvedFactId: null, resolvedAt: null })
        .where(eq(companyEvidenceContradictions.id, row.id))
        .run();
    }
    return true;
  });
}

/* ----------------------------------------------------------------------- retention ----------- */

/**
 * Retention for one record: deletes withdrawn facts no open contradiction references, then -- only
 * when fewer than `room` rows are free under `MAX_ROWS_PER_RECORD` -- the oldest expired or
 * unverified ACTIVE leads outside any open contradiction. Never a current confirmed fact, never a
 * fact in an open contradiction, never a superseded decision.
 */
function pruneRecordTx(tx: Tx, recordId: string, now: Date, room = 0): void {
  const rows = tx.select().from(companyEvidenceFacts).where(eq(companyEvidenceFacts.recordId, recordId)).all();
  if (rows.length === 0) return;
  const inOpenContradiction = new Set<string>();
  const ids = rows.map((row) => row.id);
  for (const row of tx
    .select()
    .from(companyEvidenceContradictions)
    .where(
      and(
        eq(companyEvidenceContradictions.status, 'open'),
        or(inArray(companyEvidenceContradictions.factAId, ids), inArray(companyEvidenceContradictions.factBId, ids)),
      ),
    )
    .all()) {
    inOpenContradiction.add(row.factAId);
    inOpenContradiction.add(row.factBId);
  }
  const withdrawn = rows.filter((row) => row.status === 'withdrawn' && !inOpenContradiction.has(row.id));
  if (withdrawn.length > 0) {
    tx.delete(companyEvidenceFacts).where(inArray(companyEvidenceFacts.id, withdrawn.map((row) => row.id))).run();
  }
  const remaining = rows.filter((row) => !withdrawn.includes(row));
  let excess = remaining.length + room - MAX_ROWS_PER_RECORD;
  if (excess <= 0) return;
  const droppable = remaining
    .filter((row) => row.status === 'active' && !inOpenContradiction.has(row.id))
    .filter((row) => row.expiresAt.getTime() <= now.getTime() || row.verification === 'unverified')
    .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
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
