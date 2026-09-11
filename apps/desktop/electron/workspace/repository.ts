/**
 * All reads and writes against `workspace.db`, expressed as plain functions over a `WorkspaceDb`.
 *
 * Deliberately free of Electron and of `ipcMain`: main.ts's handlers are a thin layer that
 * validates (validate.ts) and then calls exactly one function from here, which keeps every
 * behavior worth arguing about (default-CV promotion, archive filtering, duplication) testable
 * against a real SQLite file with no Electron process in sight (test/workspace-repository.test.ts).
 *
 * better-sqlite3 is synchronous, so is everything here. The handlers are still `async` because
 * `ipcMain.handle` is, and because `ensureWorkspaceDb()` is.
 */

import { and, asc, desc, eq, inArray, ne } from 'drizzle-orm';
import type { WorkspaceDb } from './client.js';
import { deriveApplicationIdentity, type ApplicationIdentity } from './application-identity.js';
import { appSettings, applicationArtifacts, applicationAttempts, applications, automationGrants, cvDocuments, letters, savedJobs } from './schema.js';
import {
  COMPLETED_ATTEMPT_CHECKPOINTS,
  NON_TERMINAL_ATTEMPT_CHECKPOINTS,
  type ApplicationArtifactInput,
  type ApplicationArtifactRecord,
  type ApplicationAttemptCheckpoint,
  type ApplicationAttemptInput,
  type ApplicationAttemptPatch,
  type ApplicationAttemptRecord,
  type ApplicationFilter,
  type ApplicationInput,
  type ApplicationPatch,
  type ApplicationRecord,
  type AppSettingsPatch,
  type AppSettingsRecord,
  type AutomationGrantInput,
  type AutomationGrantRecord,
  type CompletedApplicationMatch,
  type CvDocumentInput,
  type CvDocumentPatch,
  type CvDocumentRecord,
  type CvProfile,
  type DeleteResult,
  type LetterInput,
  type LetterPatch,
  type LetterRecord,
  type SavedJobInput,
  type SavedJobPatch,
  type SavedJobRecord,
  type WorkspaceCounts,
} from './types.js';

/** The one fixed row in `app_settings`. */
const SETTINGS_ROW_ID = 1;

export class WorkspaceNotFoundError extends Error {
  constructor(entity: string, id: string) {
    super(`no ${entity} with id "${id}"`);
    this.name = 'WorkspaceNotFoundError';
  }
}

/** #198's dedup rule: refuses a second concurrent attempt at the same vacancy. Distinguishable by
 * name/class (mirroring `WorkspaceNotFoundError`), not just message text, so a caller can recover
 * from this specific case (e.g. offer "start a new attempt anyway?") without string-matching. */
export class ApplicationAttemptDuplicateError extends Error {
  constructor(public readonly existingAttemptId: string) {
    super(`an attempt for this vacancy is already in progress (attempt "${existingAttemptId}")`);
    this.name = 'ApplicationAttemptDuplicateError';
  }
}

/**
 * #275's completed-application refusal, separate from the concurrency one above because the fix is
 * different: a concurrent attempt can be forced past once the user decides they want a second
 * *try*, whereas this one means an application already reached the employer and the only honest way
 * forward is an explicit, recorded reapply.
 *
 * The message carries ids and classifications only -- never the company, the role, or the URL. It
 * is surfaced through IPC and may be logged, and #275 is explicit that discussion of these cases
 * must not carry candidate or posting data.
 */
export class ApplicationAlreadyCompletedError extends Error {
  constructor(public readonly match: CompletedApplicationMatch) {
    super(
      match.checkpoint === 'submission_unknown'
        ? `a prior attempt at this requisition may already have been submitted and has not been reconciled ` +
          `(attempt "${match.attemptId}", matched on ${match.matchedOn}); reconcile it or record an explicit reapply`
        : `this requisition already has a completed application ` +
          `(attempt "${match.attemptId}", matched on ${match.matchedOn}, evidence ${match.completionEvidence ?? 'unrecorded'}); ` +
          `record an explicit reapply to send another`,
    );
    this.name = 'ApplicationAlreadyCompletedError';
  }
}

/**
 * Refuses to un-protect a completed (or possibly-completed) attempt without saying why. Thrown by
 * `updateApplicationAttempt`; see its comment for the reconciliation rule this enforces. Carries
 * the checkpoints rather than a free-text summary so a caller can branch on them.
 */
export class ApplicationCompletionDecisionError extends Error {
  constructor(
    public readonly attemptId: string,
    public readonly from: ApplicationAttemptCheckpoint,
    public readonly to: ApplicationAttemptCheckpoint,
  ) {
    super(
      `moving attempt "${attemptId}" from "${from}" to "${to}" removes this requisition's ` +
        `duplicate protection, so the patch must record why in "checkpointDetail"`,
    );
    this.name = 'ApplicationCompletionDecisionError';
  }
}

/** A reapply that does not actually describe a reapply: no completed application at this identity,
 * a predecessor that belongs to some other requisition, or a missing reason. Refused rather than
 * recorded, because a reapply record nobody can trust is worse than no reapply path at all. */
export class ApplicationReapplyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ApplicationReapplyError';
  }
}

const EMPTY_PROFILE: CvProfile = {
  title: '',
  years: '',
  location: '',
  languages: '',
  skills: [],
  summary: '',
  auth: '',
};

function iso(value: Date): string {
  return value.toISOString();
}

// ---------------------------------------------------------------------------- saved jobs

type SavedJobRow = typeof savedJobs.$inferSelect;

function toSavedJob(row: SavedJobRow): SavedJobRecord {
  return {
    id: row.id,
    vacancyKey: row.vacancyKey,
    role: row.role,
    company: row.company,
    location: row.location,
    salary: row.salary,
    arrangement: row.arrangement,
    verification: row.verification,
    matchPercent: row.matchPercent,
    sourceUrl: row.sourceUrl,
    notes: row.notes,
    status: row.status,
    savedAt: iso(row.savedAt),
    // Both null on every row written before migration 0004, and on every job whose analysis was
    // never kept. `?? null` rather than a bare read because better-sqlite3 hands back `undefined`
    // for a column an older row has no value in, and the wire contract says `null`.
    gapAnalysis: row.gapAnalysis ?? null,
    gapAnalysisAt: row.gapAnalysisAt ? iso(row.gapAnalysisAt) : null,
  };
}

export function listSavedJobs(db: WorkspaceDb): SavedJobRecord[] {
  return db.select().from(savedJobs).orderBy(desc(savedJobs.savedAt)).all().map(toSavedJob);
}

export function createSavedJob(db: WorkspaceDb, input: SavedJobInput): SavedJobRecord {
  const [row] = db
    .insert(savedJobs)
    .values({
      role: input.role,
      company: input.company,
      location: input.location ?? '',
      vacancyKey: input.vacancyKey ?? null,
      salary: input.salary ?? null,
      arrangement: input.arrangement ?? null,
      verification: input.verification ?? null,
      matchPercent: input.matchPercent ?? null,
      sourceUrl: input.sourceUrl ?? null,
      notes: input.notes ?? '',
      status: input.status ?? 'considering',
      ...gapAnalysisColumns(input.gapAnalysis),
    })
    .returning()
    .all();
  if (!row) throw new Error('failed to insert saved job');
  return toSavedJob(row);
}

/**
 * The `gap_analysis` / `gap_analysis_at` pair, derived together from the one field the caller may
 * set. The timestamp is this process's clock, never the renderer's (see `SavedJobInput`), and the
 * two columns are written as a unit so "null exactly when the other is null" cannot drift: clearing
 * an analysis clears its date rather than leaving a date for text that is gone.
 *
 * `undefined` in, `{}` out: the caller did not mention the field, so neither column is touched.
 */
function gapAnalysisColumns(
  value: string | null | undefined,
): { gapAnalysis: string | null; gapAnalysisAt: Date | null } | Record<string, never> {
  if (value === undefined) return {};
  return value === null
    ? { gapAnalysis: null, gapAnalysisAt: null }
    : { gapAnalysis: value, gapAnalysisAt: new Date() };
}

export function updateSavedJob(db: WorkspaceDb, id: string, values: SavedJobPatch): SavedJobRecord {
  const { gapAnalysis, ...rest } = values;
  const set = { ...rest, ...gapAnalysisColumns(gapAnalysis) };

  // An empty patch is a no-op read rather than an invalid `set {}` statement. The renderer
  // sending "nothing changed" should not be an error. Measured after the columns above are
  // derived, so a patch carrying only an untouched `gapAnalysis` still counts as empty.
  if (Object.keys(set).length === 0) {
    const existing = db.select().from(savedJobs).where(eq(savedJobs.id, id)).get();
    if (!existing) throw new WorkspaceNotFoundError('saved job', id);
    return toSavedJob(existing);
  }
  const [row] = db.update(savedJobs).set(set).where(eq(savedJobs.id, id)).returning().all();
  if (!row) throw new WorkspaceNotFoundError('saved job', id);
  return toSavedJob(row);
}

export function deleteSavedJob(db: WorkspaceDb, id: string): DeleteResult {
  // `applications.saved_job_id` is `on delete set null`, so any application created from this
  // saved job survives as a standalone row. The prototype's "deleting a saved job detaches
  // applications" behavior falls straight out of the schema.
  const removed = db.delete(savedJobs).where(eq(savedJobs.id, id)).returning({ id: savedJobs.id }).all();
  return { deleted: removed.length > 0 };
}

// -------------------------------------------------------------------------- applications

type ApplicationRow = typeof applications.$inferSelect;

function toApplication(row: ApplicationRow): ApplicationRecord {
  return {
    id: row.id,
    savedJobId: row.savedJobId,
    role: row.role,
    company: row.company,
    location: row.location,
    verification: row.verification,
    status: row.status,
    appliedAt: row.appliedAt ? iso(row.appliedAt) : null,
    nextStep: row.nextStep,
    contact: row.contact,
    cvId: row.cvId,
    letterId: row.letterId,
    notes: row.notes,
    archived: row.archived,
  };
}

export function listApplications(db: WorkspaceDb, filter: ApplicationFilter = 'all'): ApplicationRecord[] {
  const query = db.select().from(applications);
  const rows =
    filter === 'all'
      ? query.all()
      : query.where(eq(applications.archived, filter === 'archived')).all();
  return rows.map(toApplication);
}

export function createApplication(db: WorkspaceDb, input: ApplicationInput): ApplicationRecord {
  const [row] = db
    .insert(applications)
    .values({
      role: input.role,
      company: input.company,
      location: input.location ?? '',
      savedJobId: input.savedJobId ?? null,
      verification: input.verification ?? null,
      status: input.status ?? 'preparing',
      appliedAt: input.appliedAt ? new Date(input.appliedAt) : null,
      nextStep: input.nextStep ?? '',
      contact: input.contact ?? '',
      cvId: input.cvId ?? null,
      letterId: input.letterId ?? null,
      notes: input.notes ?? '',
      archived: input.archived ?? false,
    })
    .returning()
    .all();
  if (!row) throw new Error('failed to insert application');
  return toApplication(row);
}

export function updateApplication(db: WorkspaceDb, id: string, values: ApplicationPatch): ApplicationRecord {
  const { appliedAt, ...rest } = values;
  const set: Partial<ApplicationRow> = { ...rest };
  if ('appliedAt' in values) set.appliedAt = appliedAt ? new Date(appliedAt) : null;

  if (Object.keys(set).length === 0) {
    const existing = db.select().from(applications).where(eq(applications.id, id)).get();
    if (!existing) throw new WorkspaceNotFoundError('application', id);
    return toApplication(existing);
  }
  const [row] = db.update(applications).set(set).where(eq(applications.id, id)).returning().all();
  if (!row) throw new WorkspaceNotFoundError('application', id);
  return toApplication(row);
}

export function deleteApplication(db: WorkspaceDb, id: string): DeleteResult {
  const removed = db
    .delete(applications)
    .where(eq(applications.id, id))
    .returning({ id: applications.id })
    .all();
  return { deleted: removed.length > 0 };
}

// -------------------------------------------------------------------------- cv documents

type CvDocumentRow = typeof cvDocuments.$inferSelect;

function toCvDocument(row: CvDocumentRow): CvDocumentRecord {
  return {
    id: row.id,
    name: row.name,
    kind: row.kind,
    targetRole: row.targetRole,
    text: row.text,
    // `profile` is a JSON column: an older row (or a hand-edited database) could be missing
    // fields the renderer treats as required, so it is filled in rather than trusted.
    profile: { ...EMPTY_PROFILE, ...(row.profile ?? {}) },
    isDefault: row.isDefault,
    uploadedAt: iso(row.uploadedAt),
    updatedAt: iso(row.updatedAt),
  };
}

export function listCvDocuments(db: WorkspaceDb): CvDocumentRecord[] {
  return db
    .select()
    .from(cvDocuments)
    .orderBy(desc(cvDocuments.isDefault), asc(cvDocuments.uploadedAt))
    .all()
    .map(toCvDocument);
}

/** Single-row lookup (#156's export action): every other CV verb so far only ever needed the
 * whole list or an id-plus-patch, so this is the first one-row read. Throws the same
 * `WorkspaceNotFoundError` `updateCvDocument`/`deleteCvDocument` throw for a missing id, rather
 * than returning `undefined`, so the export handler does not need its own "no such CV" branch. */
export function getCvDocument(db: WorkspaceDb, id: string): CvDocumentRecord {
  const row = db.select().from(cvDocuments).where(eq(cvDocuments.id, id)).get();
  if (!row) throw new WorkspaceNotFoundError('CV document', id);
  return toCvDocument(row);
}

export function createCvDocument(db: WorkspaceDb, input: CvDocumentInput): CvDocumentRecord {
  return db.transaction((tx) => {
    const existingCount = tx.select({ id: cvDocuments.id }).from(cvDocuments).all().length;
    // The library must always have exactly one default while it is non-empty, so the very first
    // CV becomes the default whether or not the caller asked for it.
    const shouldBeDefault = input.isDefault === true || existingCount === 0;
    if (shouldBeDefault) {
      tx.update(cvDocuments).set({ isDefault: false }).run();
    }
    const [row] = tx
      .insert(cvDocuments)
      .values({
        name: input.name,
        kind: input.kind,
        targetRole: input.targetRole ?? '',
        text: input.text ?? '',
        profile: { ...EMPTY_PROFILE, ...(input.profile ?? {}) },
        isDefault: shouldBeDefault,
      })
      .returning()
      .all();
    if (!row) throw new Error('failed to insert CV document');
    return toCvDocument(row);
  });
}

export function updateCvDocument(db: WorkspaceDb, id: string, values: CvDocumentPatch): CvDocumentRecord {
  const existing = db.select().from(cvDocuments).where(eq(cvDocuments.id, id)).get();
  if (!existing) throw new WorkspaceNotFoundError('CV document', id);

  const set: Partial<CvDocumentRow> = { updatedAt: new Date() };
  if (values.name !== undefined) set.name = values.name;
  if (values.targetRole !== undefined) set.targetRole = values.targetRole;
  if (values.text !== undefined) set.text = values.text;
  // The profile patch merges into the stored object rather than replacing it, so editing one
  // field in the CV drawer cannot silently wipe the others.
  if (values.profile !== undefined) {
    set.profile = { ...EMPTY_PROFILE, ...(existing.profile ?? {}), ...values.profile };
  }

  const [row] = db.update(cvDocuments).set(set).where(eq(cvDocuments.id, id)).returning().all();
  if (!row) throw new WorkspaceNotFoundError('CV document', id);
  return toCvDocument(row);
}

/**
 * Promotes one CV to default and demotes every other in a single transaction, so the library
 * is never observably in a two-defaults or no-defaults state.
 */
export function setDefaultCvDocument(db: WorkspaceDb, id: string): CvDocumentRecord[] {
  return db.transaction((tx) => {
    const existing = tx.select({ id: cvDocuments.id }).from(cvDocuments).where(eq(cvDocuments.id, id)).get();
    if (!existing) throw new WorkspaceNotFoundError('CV document', id);
    tx.update(cvDocuments).set({ isDefault: false }).where(ne(cvDocuments.id, id)).run();
    tx.update(cvDocuments).set({ isDefault: true }).where(eq(cvDocuments.id, id)).run();
    return tx
      .select()
      .from(cvDocuments)
      .orderBy(desc(cvDocuments.isDefault), asc(cvDocuments.uploadedAt))
      .all()
      .map(toCvDocument);
  });
}

export function deleteCvDocument(db: WorkspaceDb, id: string): DeleteResult {
  return db.transaction((tx) => {
    const existing = tx.select().from(cvDocuments).where(eq(cvDocuments.id, id)).get();
    if (!existing) return { deleted: false };

    // Foreign keys (`on delete set null`) detach letters, applications and `app_settings`
    // .default_cv_id by themselves. The client opens the connection with `foreign_keys = ON`.
    tx.delete(cvDocuments).where(eq(cvDocuments.id, id)).run();

    if (existing.isDefault) {
      // "Deleting the default CV promotes another" (HANDOFF.md). Oldest remaining wins: it is
      // deterministic, and it is the one the user has had longest.
      const next = tx.select({ id: cvDocuments.id }).from(cvDocuments).orderBy(asc(cvDocuments.uploadedAt)).get();
      if (next) tx.update(cvDocuments).set({ isDefault: true }).where(eq(cvDocuments.id, next.id)).run();
    }
    return { deleted: true };
  });
}

// ------------------------------------------------------------------------------- letters

type LetterRow = typeof letters.$inferSelect;

function toLetter(row: LetterRow): LetterRecord {
  return {
    id: row.id,
    title: row.title,
    company: row.company,
    role: row.role,
    type: row.type,
    tone: row.tone,
    length: row.length,
    status: row.status,
    vacancyKey: row.vacancyKey,
    cvId: row.cvId,
    body: row.body,
    updatedAt: iso(row.updatedAt),
  };
}

export function listLetters(db: WorkspaceDb): LetterRecord[] {
  return db.select().from(letters).orderBy(desc(letters.updatedAt)).all().map(toLetter);
}

export function createLetter(db: WorkspaceDb, input: LetterInput): LetterRecord {
  const [row] = db
    .insert(letters)
    .values({
      title: input.title,
      company: input.company ?? '',
      role: input.role ?? '',
      type: input.type ?? 'motivation_letter',
      tone: input.tone ?? 'natural',
      length: input.length ?? 'standard',
      status: input.status ?? 'draft',
      vacancyKey: input.vacancyKey ?? null,
      cvId: input.cvId ?? null,
      body: input.body ?? '',
    })
    .returning()
    .all();
  if (!row) throw new Error('failed to insert letter');
  return toLetter(row);
}

export function updateLetter(db: WorkspaceDb, id: string, values: LetterPatch): LetterRecord {
  const [row] = db
    .update(letters)
    .set({ ...values, updatedAt: new Date() })
    .where(eq(letters.id, id))
    .returning()
    .all();
  if (!row) throw new WorkspaceNotFoundError('letter', id);
  return toLetter(row);
}

export function deleteLetter(db: WorkspaceDb, id: string): DeleteResult {
  const removed = db.delete(letters).where(eq(letters.id, id)).returning({ id: letters.id }).all();
  return { deleted: removed.length > 0 };
}

/**
 * Copies a letter into a new draft. The copy is always a `draft` regardless of the original's
 * status. Duplicating a letter you already sent must not produce a second row claiming to have
 * been sent.
 */
export function duplicateLetter(db: WorkspaceDb, id: string): LetterRecord {
  const source = db.select().from(letters).where(eq(letters.id, id)).get();
  if (!source) throw new WorkspaceNotFoundError('letter', id);
  return createLetter(db, {
    title: `${source.title} (copy)`.slice(0, 512),
    company: source.company,
    role: source.role,
    type: source.type,
    tone: source.tone,
    length: source.length,
    status: 'draft',
    vacancyKey: source.vacancyKey,
    cvId: source.cvId,
    body: source.body,
  });
}

// ------------------------------------------------------------- application attempts (#198)

type ApplicationAttemptRow = typeof applicationAttempts.$inferSelect;

function toApplicationAttempt(row: ApplicationAttemptRow): ApplicationAttemptRecord {
  return {
    id: row.id,
    applicationId: row.applicationId,
    vacancyKey: row.vacancyKey,
    canonicalUrl: row.canonicalUrl,
    // Migration 0012 backfills these three to '' / null on every pre-existing row, so an attempt
    // created before #275 has an empty identity rather than a missing one -- and an empty identity
    // never matches anything, which is the right answer for a row nothing derived an identity for.
    employerKey: row.employerKey,
    requisitionId: row.requisitionId,
    canonicalUrlKey: row.canonicalUrlKey,
    company: row.company,
    role: row.role,
    sourceCvId: row.sourceCvId,
    sourceCvContentHash: row.sourceCvContentHash,
    jdSnapshot: row.jdSnapshot,
    jdSnapshotHash: row.jdSnapshotHash,
    jdComplete: row.jdComplete,
    workflowVersion: row.workflowVersion,
    checkpoint: row.checkpoint,
    checkpointDetail: row.checkpointDetail,
    createdAt: iso(row.createdAt),
    updatedAt: iso(row.updatedAt),
    submittedAt: row.submittedAt ? iso(row.submittedAt) : null,
    formStructureHash: row.formStructureHash,
    scheduledAutomaticSubmitAt: row.scheduledAutomaticSubmitAt ? iso(row.scheduledAutomaticSubmitAt) : null,
    submissionMode: row.submissionMode,
    completionEvidence: row.completionEvidence,
    supersedesAttemptId: row.supersedesAttemptId,
    reapplyReason: row.reapplyReason,
    reapplyPreviousCvContentHash: row.reapplyPreviousCvContentHash,
  };
}

export function listApplicationAttempts(db: WorkspaceDb): ApplicationAttemptRecord[] {
  return db.select().from(applicationAttempts).orderBy(desc(applicationAttempts.createdAt)).all().map(toApplicationAttempt);
}

export function getApplicationAttempt(db: WorkspaceDb, id: string): ApplicationAttemptRecord {
  const row = db.select().from(applicationAttempts).where(eq(applicationAttempts.id, id)).get();
  if (!row) throw new WorkspaceNotFoundError('application attempt', id);
  return toApplicationAttempt(row);
}

// ------------------------------------------------- completed-application lookup (#275)

/** The columns the completed-application lookup reads. Narrow on purpose: this query runs on every
 * attempt creation, and nothing here needs the JD snapshot. */
const COMPLETED_MATCH_COLUMNS = {
  id: applicationAttempts.id,
  checkpoint: applicationAttempts.checkpoint,
  completionEvidence: applicationAttempts.completionEvidence,
  submittedAt: applicationAttempts.submittedAt,
  createdAt: applicationAttempts.createdAt,
  employerKey: applicationAttempts.employerKey,
  requisitionId: applicationAttempts.requisitionId,
  canonicalUrlKey: applicationAttempts.canonicalUrlKey,
  vacancyKey: applicationAttempts.vacancyKey,
  sourceCvContentHash: applicationAttempts.sourceCvContentHash,
} as const;

type CompletedCandidateRow = Pick<ApplicationAttemptRow, keyof typeof COMPLETED_MATCH_COLUMNS>;

/** What the lookup compares against: the derived requisition identity plus the source key #198's
 * guard already used, kept as a last fallback so an attempt with no URL at all is not unprotected. */
interface CompletedLookupIdentity extends ApplicationIdentity {
  vacancyKey: string | null;
}

/**
 * Everything the completed-application lookup needs, and nothing else. Deliberately narrower than
 * `ApplicationAttemptInput`: the whole value of asking *before* building an attempt is that you
 * have not tailored a CV or captured a JD yet, so demanding their hashes to run the query would
 * defeat the point. An `ApplicationAttemptInput` satisfies it.
 */
export interface ApplicationIdentityQuery {
  company: string;
  canonicalUrl?: string;
  requisitionId?: string | null;
  vacancyKey?: string | null;
}

/**
 * Decides which already-completed attempts count as the same application as `identity`, in
 * descending confidence order. Pure, so the precedence rule is readable in one place and testable
 * without a database.
 *
 * The precedence matters more than it looks. A requisition match is an assertion by the receiving
 * ATS that these are the same opening, and it holds across sources, spreadsheets and re-listings.
 * The URL fallback only holds when both attempts came in through the same link. The vacancy-key
 * fallback is weaker still -- it is a discovery-report row id, which is exactly the thing that
 * changes when the same posting is re-imported -- so it is consulted last.
 *
 * Tiers are tried in order and the first one to find anything answers, including *which* identity
 * answered. A stronger tier finding nothing falls through to the weaker ones rather than concluding
 * there is no match: an attempt written before migration 0012 has no derived identity at all, and
 * one whose apply link this app does not recognise as an ATS has no requisition id, so those can
 * only ever be caught by a weaker key. Falling through can only ever add protection -- every tier
 * is exact equality on a stored key, never a fuzzy or partial comparison.
 *
 * `employerKey` never matches on its own. Two openings at one employer share it, and #275 requires
 * the second one to stay eligible.
 */
function completedMatches(
  rows: readonly CompletedCandidateRow[],
  identity: CompletedLookupIdentity,
): { row: CompletedCandidateRow; matchedOn: CompletedApplicationMatch['matchedOn'] }[] {
  const tiers: { matchedOn: CompletedApplicationMatch['matchedOn']; hit: (row: CompletedCandidateRow) => boolean }[] = [];
  if (identity.employerKey !== '' && identity.requisitionId !== null) {
    tiers.push({
      matchedOn: 'requisition',
      hit: (row) => row.employerKey === identity.employerKey && row.requisitionId === identity.requisitionId,
    });
  }
  if (identity.canonicalUrlKey !== '') {
    tiers.push({ matchedOn: 'canonical_url', hit: (row) => row.canonicalUrlKey === identity.canonicalUrlKey });
  }
  if (identity.vacancyKey !== null && identity.vacancyKey !== '') {
    tiers.push({ matchedOn: 'vacancy_key', hit: (row) => row.vacancyKey === identity.vacancyKey });
  }

  for (const tier of tiers) {
    const hits = rows.filter(tier.hit);
    if (hits.length > 0) return hits.map((row) => ({ row, matchedOn: tier.matchedOn }));
  }
  return [];
}

function toCompletedMatch(entry: { row: CompletedCandidateRow; matchedOn: CompletedApplicationMatch['matchedOn'] }): CompletedApplicationMatch {
  return {
    attemptId: entry.row.id,
    checkpoint: entry.row.checkpoint,
    completionEvidence: entry.row.completionEvidence,
    matchedOn: entry.matchedOn,
    submittedAt: entry.row.submittedAt ? iso(entry.row.submittedAt) : null,
  };
}

/**
 * #275's completed-application lookup, exposed on its own so a caller can ask "have I already
 * applied here?" *before* building an attempt -- the import path wants to skip a row quietly, not
 * catch a refusal thrown halfway through generating documents for it.
 *
 * Returns every completed attempt at this identity, newest first. Empty means nothing was found,
 * which is a real answer and not an error.
 */
export function findCompletedApplications(
  db: WorkspaceDb,
  input: ApplicationIdentityQuery,
): CompletedApplicationMatch[] {
  const rows = db
    .select(COMPLETED_MATCH_COLUMNS)
    .from(applicationAttempts)
    .where(inArray(applicationAttempts.checkpoint, COMPLETED_ATTEMPT_CHECKPOINTS))
    .orderBy(desc(applicationAttempts.createdAt))
    .all();
  return completedMatches(rows, lookupIdentity(input)).map(toCompletedMatch);
}

/** The newest completed application at this identity, or undefined when there is none. */
export function findCompletedApplication(
  db: WorkspaceDb,
  input: ApplicationIdentityQuery,
): CompletedApplicationMatch | undefined {
  return findCompletedApplications(db, input)[0];
}

function lookupIdentity(input: ApplicationIdentityQuery): CompletedLookupIdentity {
  return {
    ...deriveApplicationIdentity({
      company: input.company,
      canonicalUrl: input.canonicalUrl,
      requisitionId: input.requisitionId,
    }),
    vacancyKey: input.vacancyKey ?? null,
  };
}

/**
 * Creates a new attempt, enforcing two independent refusals first.
 *
 * **#198's concurrency guard.** Refuses a second *concurrent* attempt for the same vacancy while an
 * existing one is still in a non-terminal checkpoint (see `NON_TERMINAL_ATTEMPT_CHECKPOINTS`),
 * unless `input.force` is set. "Same vacancy" is `vacancyKey` when the attempt has one (the normal
 * case, a real discovery-report row); `canonicalUrl` is the fallback for a manually-entered target
 * with no report key. Unchanged by #275, and still the only thing `force` gets past.
 *
 * **#275's completed-application guard.** Refuses an ordinary new attempt when an earlier attempt
 * at the same *requisition* already reached the employer -- `submitted`, or `submission_unknown`
 * where it may have. This is a separate check on a separate identity for a separate reason: the
 * concurrency guard protects against doing the same work twice, this one protects a real person
 * from sending a second application to a job they already applied for, which is not undoable.
 * `force` does not reach it. The only way past is `input.reapply`, which records the predecessor,
 * the reason and the document version that changed.
 *
 * Both are deliberately plain existence checks rather than database unique constraints: a vacancy
 * can legitimately have more than one historical attempt -- a failed attempt retried, a recorded
 * reapply -- so the row shape itself must allow duplicates; only the business rules live here.
 */
export function createApplicationAttempt(db: WorkspaceDb, input: ApplicationAttemptInput): ApplicationAttemptRecord {
  const identity = lookupIdentity(input);
  return db.transaction((tx) => {
    if (!input.force) {
      const vacancyIdentity =
        input.vacancyKey !== null && input.vacancyKey !== undefined
          ? eq(applicationAttempts.vacancyKey, input.vacancyKey)
          : input.canonicalUrl
            ? eq(applicationAttempts.canonicalUrl, input.canonicalUrl)
            : undefined;
      if (vacancyIdentity) {
        const existing = tx
          .select({ id: applicationAttempts.id })
          .from(applicationAttempts)
          .where(and(vacancyIdentity, inArray(applicationAttempts.checkpoint, NON_TERMINAL_ATTEMPT_CHECKPOINTS)))
          .get();
        if (existing) throw new ApplicationAttemptDuplicateError(existing.id);
      }
    }

    const completed = completedMatches(
      tx
        .select(COMPLETED_MATCH_COLUMNS)
        .from(applicationAttempts)
        .where(inArray(applicationAttempts.checkpoint, COMPLETED_ATTEMPT_CHECKPOINTS))
        .orderBy(desc(applicationAttempts.createdAt))
        .all(),
      identity,
    );
    const reapply = resolveReapply(input, completed);
    if (!reapply && completed[0]) throw new ApplicationAlreadyCompletedError(toCompletedMatch(completed[0]));

    const [row] = tx
      .insert(applicationAttempts)
      .values({
        applicationId: input.applicationId ?? null,
        vacancyKey: input.vacancyKey ?? null,
        canonicalUrl: input.canonicalUrl ?? '',
        employerKey: identity.employerKey,
        requisitionId: identity.requisitionId,
        canonicalUrlKey: identity.canonicalUrlKey,
        company: input.company,
        role: input.role,
        sourceCvId: input.sourceCvId ?? null,
        sourceCvContentHash: input.sourceCvContentHash,
        jdSnapshot: input.jdSnapshot ?? '',
        jdSnapshotHash: input.jdSnapshotHash,
        jdComplete: input.jdComplete ?? true,
        workflowVersion: input.workflowVersion ?? '',
        checkpoint: input.checkpoint ?? 'queued',
        checkpointDetail: input.checkpointDetail ?? '',
        supersedesAttemptId: reapply?.supersedesAttemptId ?? null,
        reapplyReason: reapply?.reason ?? '',
        reapplyPreviousCvContentHash: reapply?.previousCvContentHash ?? null,
      })
      .returning()
      .all();
    if (!row) throw new Error('failed to insert application attempt');
    return toApplicationAttempt(row);
  });
}

/**
 * Validates `input.reapply` against the completed attempts actually found at this identity, and
 * returns the record to write, or undefined when the caller is not reapplying at all.
 *
 * The predecessor has to be one of *these* matches, not merely an attempt that exists. Accepting
 * any attempt id would turn the reapply path into the unconditional bypass `force` deliberately is
 * not: a caller could name some unrelated finished attempt and send a second application to a job
 * the user already applied for, which is the exact outcome #275 exists to prevent.
 */
function resolveReapply(
  input: ApplicationAttemptInput,
  completed: readonly { row: CompletedCandidateRow; matchedOn: CompletedApplicationMatch['matchedOn'] }[],
): { supersedesAttemptId: string; reason: string; previousCvContentHash: string } | undefined {
  const request = input.reapply;
  if (!request) return undefined;

  const reason = request.reason.trim();
  if (reason === '') throw new ApplicationReapplyError('a reapply must record a non-empty reason');
  if (completed.length === 0) {
    throw new ApplicationReapplyError('there is no completed application at this requisition to reapply against');
  }
  const predecessor = completed.find((entry) => entry.row.id === request.supersedesAttemptId);
  if (!predecessor) {
    throw new ApplicationReapplyError(
      `attempt "${request.supersedesAttemptId}" is not a completed application at this requisition`,
    );
  }
  return {
    supersedesAttemptId: predecessor.row.id,
    reason,
    previousCvContentHash: predecessor.row.sourceCvContentHash,
  };
}

/**
 * Patches an attempt's progress.
 *
 * One #275 rule sits on top of the plain column write: moving an attempt *out of* a completed
 * checkpoint (`submitted`, or an unreconciled `submission_unknown`) and into one that no longer
 * protects the requisition requires a non-empty `checkpointDetail` in the same patch.
 *
 * That is the "reconciliation or an explicit, recorded user decision" #275 asks for, and it is the
 * whole resolution path for `submission_unknown`: a receipt turning up later moves it to
 * `submitted` (still protected, no reason needed, nothing was un-protected); establishing that
 * nothing was ever sent moves it to `failed` or `skipped`, which frees the requisition for an
 * ordinary new attempt and therefore has to say on what basis. An unexplained patch that quietly
 * clears the protection is refused -- it is indistinguishable from the bug #275 fixes.
 */
export function updateApplicationAttempt(
  db: WorkspaceDb,
  id: string,
  values: ApplicationAttemptPatch,
): ApplicationAttemptRecord {
  const { submittedAt, scheduledAutomaticSubmitAt, ...rest } = values;
  const set: Partial<ApplicationAttemptRow> = { ...rest, updatedAt: new Date() };
  if ('submittedAt' in values) set.submittedAt = submittedAt ? new Date(submittedAt) : null;
  if ('scheduledAutomaticSubmitAt' in values) {
    set.scheduledAutomaticSubmitAt = scheduledAutomaticSubmitAt ? new Date(scheduledAutomaticSubmitAt) : null;
  }

  return db.transaction((tx) => {
    const next = values.checkpoint;
    if (next !== undefined && !COMPLETED_ATTEMPT_CHECKPOINTS.includes(next)) {
      const existing = tx
        .select({ checkpoint: applicationAttempts.checkpoint })
        .from(applicationAttempts)
        .where(eq(applicationAttempts.id, id))
        .get();
      if (
        existing &&
        COMPLETED_ATTEMPT_CHECKPOINTS.includes(existing.checkpoint) &&
        (values.checkpointDetail ?? '').trim() === ''
      ) {
        throw new ApplicationCompletionDecisionError(id, existing.checkpoint, next);
      }
    }

    const [row] = tx.update(applicationAttempts).set(set).where(eq(applicationAttempts.id, id)).returning().all();
    if (!row) throw new WorkspaceNotFoundError('application attempt', id);
    return toApplicationAttempt(row);
  });
}

/** Cascades to the attempt's artifacts via the schema's `on delete cascade`. */
export function deleteApplicationAttempt(db: WorkspaceDb, id: string): DeleteResult {
  const removed = db
    .delete(applicationAttempts)
    .where(eq(applicationAttempts.id, id))
    .returning({ id: applicationAttempts.id })
    .all();
  return { deleted: removed.length > 0 };
}

// ------------------------------------------------------------ application artifacts (#198)

type ApplicationArtifactRow = typeof applicationArtifacts.$inferSelect;

/** A quota, not a product limit anyone should ever meet: bounds a hostile or malformed caller,
 * the same reasoning as `AGENT_WORKSPACE_PREF_LIMITS` in validate.ts. */
export const APPLICATION_ARTIFACT_QUOTA = {
  maxPerAttempt: 10,
  maxTotalBytesPerAttempt: 100_000_000,
} as const;

export class ApplicationArtifactQuotaError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ApplicationArtifactQuotaError';
  }
}

function toApplicationArtifact(row: ApplicationArtifactRow): ApplicationArtifactRecord {
  return {
    id: row.id,
    attemptId: row.attemptId,
    kind: row.kind,
    fileName: row.fileName,
    mimeType: row.mimeType,
    byteSize: row.byteSize,
    contentHash: row.contentHash,
    storagePath: row.storagePath,
    createdAt: iso(row.createdAt),
  };
}

export function listApplicationArtifacts(db: WorkspaceDb, attemptId: string): ApplicationArtifactRecord[] {
  return db
    .select()
    .from(applicationArtifacts)
    .where(eq(applicationArtifacts.attemptId, attemptId))
    .orderBy(asc(applicationArtifacts.createdAt))
    .all()
    .map(toApplicationArtifact);
}

export function createApplicationArtifact(db: WorkspaceDb, input: ApplicationArtifactInput): ApplicationArtifactRecord {
  return db.transaction((tx) => {
    const attempt = tx.select({ id: applicationAttempts.id }).from(applicationAttempts).where(eq(applicationAttempts.id, input.attemptId)).get();
    if (!attempt) throw new WorkspaceNotFoundError('application attempt', input.attemptId);

    const existing = tx
      .select({ byteSize: applicationArtifacts.byteSize })
      .from(applicationArtifacts)
      .where(eq(applicationArtifacts.attemptId, input.attemptId))
      .all();
    if (existing.length + 1 > APPLICATION_ARTIFACT_QUOTA.maxPerAttempt) {
      throw new ApplicationArtifactQuotaError(
        `an attempt may have at most ${APPLICATION_ARTIFACT_QUOTA.maxPerAttempt} artifacts`,
      );
    }
    const totalBytes = existing.reduce((sum, row) => sum + row.byteSize, input.byteSize);
    if (totalBytes > APPLICATION_ARTIFACT_QUOTA.maxTotalBytesPerAttempt) {
      throw new ApplicationArtifactQuotaError(
        `an attempt's artifacts may total at most ${APPLICATION_ARTIFACT_QUOTA.maxTotalBytesPerAttempt} bytes`,
      );
    }

    const [row] = tx
      .insert(applicationArtifacts)
      .values({
        attemptId: input.attemptId,
        kind: input.kind,
        fileName: input.fileName ?? '',
        mimeType: input.mimeType,
        byteSize: input.byteSize,
        contentHash: input.contentHash,
        storagePath: input.storagePath ?? '',
      })
      .returning()
      .all();
    if (!row) throw new Error('failed to insert application artifact');
    return toApplicationArtifact(row);
  });
}

export function deleteApplicationArtifact(db: WorkspaceDb, id: string): DeleteResult {
  const removed = db
    .delete(applicationArtifacts)
    .where(eq(applicationArtifacts.id, id))
    .returning({ id: applicationArtifacts.id })
    .all();
  return { deleted: removed.length > 0 };
}

/**
 * Startup reconciliation between the artifact manifest and whatever's actually on disk (#198's
 * scope item). Read-only and reporting-only in this slice: it identifies artifacts whose
 * `storagePath` no longer resolves to a real file, but does not delete or otherwise act on them --
 * deciding what an orphaned manifest row *means* (retry staging? mark the attempt failed?) belongs
 * to whichever later slice actually owns file staging (#199).
 *
 * `fileExists` is injected rather than imported from `node:fs` so this stays testable without a
 * real filesystem, the same pattern `resolve-window-icon.ts` uses for the same reason.
 */
export function reconcileApplicationArtifacts(
  db: WorkspaceDb,
  fileExists: (storagePath: string) => boolean,
): ApplicationArtifactRecord[] {
  return db
    .select()
    .from(applicationArtifacts)
    .where(ne(applicationArtifacts.storagePath, ''))
    .all()
    .map(toApplicationArtifact)
    .filter((artifact) => !fileExists(artifact.storagePath));
}

// ------------------------------------------------------------------------------ automation grants (#203)

type AutomationGrantRow = typeof automationGrants.$inferSelect;

function toAutomationGrant(row: AutomationGrantRow): AutomationGrantRecord {
  return {
    id: row.id,
    policyId: row.policyId,
    createdAt: iso(row.createdAt),
    expiresAt: iso(row.expiresAt),
    revokedAt: row.revokedAt ? iso(row.revokedAt) : null,
  };
}

export function listAutomationGrants(db: WorkspaceDb): AutomationGrantRecord[] {
  return db.select().from(automationGrants).orderBy(desc(automationGrants.createdAt)).all().map(toAutomationGrant);
}

/** Deliberately not exposed on `WorkspaceBridge` -- see that interface's own comment on why
 * creating a grant requires a real native confirmation dialog (`applicationExecutor.requestAutomationGrant`)
 * rather than being reachable as a plain IPC call the way every other create/update here is. */
export function createAutomationGrant(db: WorkspaceDb, input: AutomationGrantInput): AutomationGrantRecord {
  const [row] = db
    .insert(automationGrants)
    .values({ policyId: input.policyId, expiresAt: new Date(input.expiresAt) })
    .returning()
    .all();
  if (!row) throw new Error('failed to insert automation grant');
  return toAutomationGrant(row);
}

export function revokeAutomationGrant(db: WorkspaceDb, id: string): AutomationGrantRecord {
  const [row] = db
    .update(automationGrants)
    .set({ revokedAt: new Date() })
    .where(eq(automationGrants.id, id))
    .returning()
    .all();
  if (!row) throw new WorkspaceNotFoundError('automation grant', id);
  return toAutomationGrant(row);
}

/**
 * The one automation-grant read the submit orchestration itself needs (#203 scope item 2):
 * whether `policyId` has a grant that is both unexpired and unrevoked *right now* -- re-checked
 * immediately before every automatic send, never cached from an earlier check. Returns the grant
 * so the caller can log which one authorized a given automatic submission, or `undefined` when
 * none applies (including when the only grants that exist for this policy have expired or been
 * revoked -- this is not a "no grants ever existed" signal, just "none currently authorize this").
 */
export function findActiveAutomationGrant(db: WorkspaceDb, policyId: string): AutomationGrantRecord | undefined {
  const rows = db.select().from(automationGrants).where(eq(automationGrants.policyId, policyId)).all().map(toAutomationGrant);
  const now = Date.now();
  return rows.find((grant) => grant.revokedAt === null && Date.parse(grant.expiresAt) > now);
}

// ------------------------------------------------------------------------------ settings

type AppSettingsRow = typeof appSettings.$inferSelect;

function toSettings(row: AppSettingsRow): AppSettingsRecord {
  return {
    launchAtLogin: row.launchAtLogin,
    startPage: row.startPage,
    theme: row.theme,
    density: row.density,
    sidebarStart: row.sidebarStart,
    sidebarCollapsed: row.sidebarCollapsed,
    lastOpenedPage: row.lastOpenedPage,
    minimizeToTrayOnClose: row.minimizeToTrayOnClose,
    autoScanEnabled: row.autoScanEnabled,
    defaultLocation: row.defaultLocation,
    defaultCvId: row.defaultCvId,
    defaultLetterType: row.defaultLetterType,
    defaultLetterTone: row.defaultLetterTone,
    defaultLetterLength: row.defaultLetterLength,
    defaultApplicationStatus: row.defaultApplicationStatus,
    confirmApplicationDelete: row.confirmApplicationDelete,
    autoArchiveRejected: row.autoArchiveRejected,
    defaultProvider: row.defaultProvider,
    // ADI-07. Defended against a null/legacy JSON value rather than trusted: a row written before
    // migration 0003 has no column at all, and better-sqlite3 hands back whatever is there.
    agentSelectedSessionId: row.agentSelectedSessionId,
    agentArchivedSessionIds: Array.isArray(row.agentArchivedSessionIds) ? [...row.agentArchivedSessionIds] : [],
    agentUnreadCounts:
      row.agentUnreadCounts && typeof row.agentUnreadCounts === 'object' && !Array.isArray(row.agentUnreadCounts)
        ? { ...row.agentUnreadCounts }
        : {},
  };
}

/** Reads the single settings row, creating it from the schema's column defaults on first use. */
export function getSettings(db: WorkspaceDb): AppSettingsRecord {
  const existing = db.select().from(appSettings).where(eq(appSettings.id, SETTINGS_ROW_ID)).get();
  if (existing) return toSettings(existing);

  const [created] = db.insert(appSettings).values({ id: SETTINGS_ROW_ID }).returning().all();
  if (!created) throw new Error('failed to initialize app settings');
  return toSettings(created);
}

export function updateSettings(db: WorkspaceDb, values: AppSettingsPatch): AppSettingsRecord {
  getSettings(db); // guarantees the row exists before the update
  if (Object.keys(values).length === 0) return getSettings(db);

  const [row] = db
    .update(appSettings)
    .set(values)
    .where(eq(appSettings.id, SETTINGS_ROW_ID))
    .returning()
    .all();
  if (!row) throw new Error('failed to update app settings');
  return toSettings(row);
}

/** Convenience for the badge counts the sidebar shows; one round trip instead of three lists. */
export function getCounts(db: WorkspaceDb): WorkspaceCounts {
  return {
    savedJobs: db.select({ id: savedJobs.id }).from(savedJobs).all().length,
    activeApplications: db
      .select({ id: applications.id })
      .from(applications)
      .where(eq(applications.archived, false))
      .all().length,
    letters: db.select({ id: letters.id }).from(letters).all().length,
  };
}
