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
import { appSettings, applicationArtifacts, applicationAttempts, applications, cvDocuments, letters, savedJobs } from './schema.js';
import {
  NON_TERMINAL_ATTEMPT_CHECKPOINTS,
  type ApplicationArtifactInput,
  type ApplicationArtifactRecord,
  type ApplicationAttemptInput,
  type ApplicationAttemptPatch,
  type ApplicationAttemptRecord,
  type ApplicationFilter,
  type ApplicationInput,
  type ApplicationPatch,
  type ApplicationRecord,
  type AppSettingsPatch,
  type AppSettingsRecord,
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

/**
 * Creates a new attempt, enforcing #198's dedup rule first: refuses a second concurrent attempt
 * for the same vacancy while an existing one is still in a non-terminal checkpoint (see
 * `NON_TERMINAL_ATTEMPT_CHECKPOINTS`), unless `input.force` is set. "Same vacancy" is `vacancyKey`
 * when the attempt has one (the normal case, a real discovery-report row); `canonicalUrl` is the
 * fallback for a manually-entered target with no report key.
 *
 * Deliberately a plain existence check, not a database unique constraint: a vacancy can
 * legitimately have more than one *historical* (terminal) attempt -- a failed attempt retried, or
 * the user genuinely reapplying later -- so the row shape itself must allow duplicates; only the
 * business rule about *concurrent* ones lives here.
 */
export function createApplicationAttempt(db: WorkspaceDb, input: ApplicationAttemptInput): ApplicationAttemptRecord {
  return db.transaction((tx) => {
    if (!input.force) {
      const identity =
        input.vacancyKey !== null && input.vacancyKey !== undefined
          ? eq(applicationAttempts.vacancyKey, input.vacancyKey)
          : input.canonicalUrl
            ? eq(applicationAttempts.canonicalUrl, input.canonicalUrl)
            : undefined;
      if (identity) {
        const existing = tx
          .select({ id: applicationAttempts.id })
          .from(applicationAttempts)
          .where(and(identity, inArray(applicationAttempts.checkpoint, NON_TERMINAL_ATTEMPT_CHECKPOINTS)))
          .get();
        if (existing) throw new ApplicationAttemptDuplicateError(existing.id);
      }
    }

    const [row] = tx
      .insert(applicationAttempts)
      .values({
        applicationId: input.applicationId ?? null,
        vacancyKey: input.vacancyKey ?? null,
        canonicalUrl: input.canonicalUrl ?? '',
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
      })
      .returning()
      .all();
    if (!row) throw new Error('failed to insert application attempt');
    return toApplicationAttempt(row);
  });
}

export function updateApplicationAttempt(
  db: WorkspaceDb,
  id: string,
  values: ApplicationAttemptPatch,
): ApplicationAttemptRecord {
  const { submittedAt, ...rest } = values;
  const set: Partial<ApplicationAttemptRow> = { ...rest, updatedAt: new Date() };
  if ('submittedAt' in values) set.submittedAt = submittedAt ? new Date(submittedAt) : null;

  const [row] = db.update(applicationAttempts).set(set).where(eq(applicationAttempts.id, id)).returning().all();
  if (!row) throw new WorkspaceNotFoundError('application attempt', id);
  return toApplicationAttempt(row);
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
