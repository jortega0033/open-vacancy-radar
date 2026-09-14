// @vitest-environment node
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createWorkspaceDb, type WorkspaceDb } from '../electron/workspace/client.js';
import * as workspace from '../electron/workspace/repository.js';
import { WorkspaceNotFoundError } from '../electron/workspace/repository.js';
import * as schema from '../electron/workspace/schema.js';
import { COMPLETED_ATTEMPT_CHECKPOINTS, NON_TERMINAL_ATTEMPT_CHECKPOINTS } from '../electron/workspace/types.js';

/**
 * Runs against a real migrated SQLite file in a temp directory, not a mock. The behaviors worth
 * testing here (default-CV promotion, foreign-key detachment, archive filtering) are behaviors
 * of the schema plus these functions together, and a stubbed Drizzle would assert nothing about
 * either.
 */
let dir: string;
let db: WorkspaceDb;
let close: () => void;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ovr-workspace-test-'));
  ({ db, close } = createWorkspaceDb(dir));
});

afterEach(() => {
  close();
  rmSync(dir, { recursive: true, force: true });
});

const JOB = { role: 'Frontend Engineer', company: 'Redwood Software' } as const;

describe('settings', () => {
  it('creates the single settings row on first read, with the schema defaults', () => {
    const settings = workspace.getSettings(db);
    expect(settings.startPage).toBe('search');
    expect(settings.theme).toBe('system');
    expect(settings.density).toBe('comfortable');
    expect(settings.sidebarCollapsed).toBe(false);
  });

  it('is idempotent: reading twice does not create a second row or reset the first', () => {
    workspace.updateSettings(db, { theme: 'dark' });
    expect(workspace.getSettings(db).theme).toBe('dark');
    expect(workspace.getSettings(db).theme).toBe('dark');
  });

  it('applies a partial patch without touching the other columns', () => {
    workspace.updateSettings(db, { theme: 'dark', density: 'compact' });
    const after = workspace.updateSettings(db, { sidebarCollapsed: true });
    expect(after).toMatchObject({ theme: 'dark', density: 'compact', sidebarCollapsed: true });
    expect(after.defaultLetterTone).toBe('natural');
  });

  it('updates cleanly even when the settings row does not exist yet', () => {
    // First write of the session can arrive before any read (e.g. the user collapses the
    // sidebar before anything has called getSettings).
    expect(workspace.updateSettings(db, { sidebarCollapsed: true }).sidebarCollapsed).toBe(true);
  });

  it('resets all personal records and recreates settings from schema defaults', () => {
    const job = workspace.createSavedJob(db, { ...JOB, location: 'Amsterdam' });
    const cv = workspace.createCvDocument(db, {
      name: 'Resume',
      kind: 'manual',
      isDefault: true,
      profile: { title: '', years: '', location: '', languages: '', skills: [], summary: '', auth: '' },
    });
    const letter = workspace.createLetter(db, {
      title: 'Letter',
      company: JOB.company,
      role: JOB.role,
      type: 'cover_letter',
      tone: 'natural',
      length: 'standard',
      cvId: cv.id,
    });
    workspace.createApplication(db, {
      savedJobId: job.id,
      role: JOB.role,
      company: JOB.company,
      cvId: cv.id,
      letterId: letter.id,
    });
    const attempt = workspace.createApplicationAttempt(db, {
      company: JOB.company,
      role: JOB.role,
      sourceCvContentHash: 'a'.repeat(64),
      jdSnapshotHash: 'b'.repeat(64),
    });
    workspace.createApplicationArtifact(db, {
      attemptId: attempt.id,
      kind: 'cv_pdf',
      mimeType: 'application/pdf',
      byteSize: 4,
      contentHash: 'c'.repeat(64),
    });
    workspace.createApplicationSubmissionReceipt(db, {
      attemptId: attempt.id,
      outcome: 'user_reported',
      source: 'user_reported',
      destination: 'https://example.invalid/apply',
      evidenceKind: 'user_statement',
      evidenceReference: 'submitted manually',
    });
    workspace.createAutomationGrant(db, {
      policyId: 'fixture-policy',
      expiresAt: '2026-12-01T00:00:00.000Z',
    });
    workspace.updateSettings(db, { theme: 'dark', defaultCvId: cv.id });

    const result = workspace.resetApplicationData(db);

    expect(result.deleted).toEqual({
      savedJobs: 1,
      applications: 1,
      cvDocuments: 1,
      letters: 1,
      applicationAttempts: 1,
      applicationArtifacts: 1,
      submissionReceipts: 1,
      automationGrants: 1,
    });
    expect(result.settings).toMatchObject({ theme: 'system', defaultCvId: null });
    expect(workspace.listSavedJobs(db)).toEqual([]);
    expect(workspace.listApplications(db)).toEqual([]);
    expect(workspace.listCvDocuments(db)).toEqual([]);
    expect(workspace.listLetters(db)).toEqual([]);
    expect(workspace.listApplicationAttempts(db)).toEqual([]);
    expect(workspace.listAutomationGrants(db)).toEqual([]);
    expect(db.select().from(schema.applicationArtifacts).all()).toEqual([]);
    expect(db.select().from(schema.applicationSubmissionReceipts).all()).toEqual([]);
  });
});

describe('saved jobs', () => {
  it('round-trips a create through list, with an ISO timestamp rather than a Date', () => {
    const created = workspace.createSavedJob(db, { ...JOB, location: 'Amsterdam', matchPercent: 99 });
    expect(created.id).toBeTruthy();
    expect(created.status).toBe('considering');
    expect(typeof created.savedAt).toBe('string');
    expect(new Date(created.savedAt).valueOf()).not.toBeNaN();

    expect(workspace.listSavedJobs(db)).toEqual([created]);
  });

  it('updates only the patched fields', () => {
    const created = workspace.createSavedJob(db, { ...JOB, notes: 'original' });
    const updated = workspace.updateSavedJob(db, created.id, { status: 'applied' });
    expect(updated.status).toBe('applied');
    expect(updated.notes).toBe('original');
    expect(updated.role).toBe(created.role);
  });

  it('treats an empty patch as a read rather than an invalid statement', () => {
    const created = workspace.createSavedJob(db, JOB);
    expect(workspace.updateSavedJob(db, created.id, {})).toEqual(created);
  });

  it('reports a missing row as not-found on update, and as deleted:false on delete', () => {
    expect(() => workspace.updateSavedJob(db, 'nope', { notes: 'x' })).toThrow(WorkspaceNotFoundError);
    expect(workspace.deleteSavedJob(db, 'nope')).toEqual({ deleted: false });
  });

  it('detaches applications instead of cascading when a saved job is deleted', () => {
    const job = workspace.createSavedJob(db, JOB);
    const application = workspace.createApplication(db, { ...JOB, savedJobId: job.id });

    expect(workspace.deleteSavedJob(db, job.id)).toEqual({ deleted: true });

    const [survivor] = workspace.listApplications(db);
    expect(survivor?.id).toBe(application.id);
    expect(survivor?.savedJobId).toBeNull();
  });
});

describe('applications', () => {
  it('filters active and archived separately, and "all" returns both', () => {
    workspace.createApplication(db, { ...JOB, role: 'Active one' });
    workspace.createApplication(db, { ...JOB, role: 'Archived one', archived: true });

    expect(workspace.listApplications(db, 'active').map((a) => a.role)).toEqual(['Active one']);
    expect(workspace.listApplications(db, 'archived').map((a) => a.role)).toEqual(['Archived one']);
    expect(workspace.listApplications(db, 'all')).toHaveLength(2);
    expect(workspace.listApplications(db)).toHaveLength(2);
  });

  it('stores appliedAt as a timestamp and hands it back as an ISO string', () => {
    const created = workspace.createApplication(db, { ...JOB, appliedAt: '2026-08-29T00:00:00.000Z' });
    expect(created.appliedAt).toBe('2026-08-29T00:00:00.000Z');
    expect(workspace.updateApplication(db, created.id, { appliedAt: null }).appliedAt).toBeNull();
  });
});

describe('CV documents', () => {
  const CV = { name: 'Jake: frontend', kind: 'uploaded' } as const;

  it('makes the first CV the default even when the caller did not ask', () => {
    const first = workspace.createCvDocument(db, CV);
    expect(first.isDefault).toBe(true);
  });

  it('does not make a later CV the default unless asked', () => {
    workspace.createCvDocument(db, CV);
    const second = workspace.createCvDocument(db, { ...CV, name: 'Jake: architect' });
    expect(second.isDefault).toBe(false);
  });

  it('demotes the previous default when a new CV is created as default', () => {
    const first = workspace.createCvDocument(db, CV);
    workspace.createCvDocument(db, { ...CV, name: 'Second', isDefault: true });

    const library = workspace.listCvDocuments(db);
    expect(library.filter((cv) => cv.isDefault)).toHaveLength(1);
    expect(library.find((cv) => cv.id === first.id)?.isDefault).toBe(false);
  });

  it('keeps exactly one default through set-default', () => {
    const first = workspace.createCvDocument(db, CV);
    const second = workspace.createCvDocument(db, { ...CV, name: 'Second' });

    const library = workspace.setDefaultCvDocument(db, second.id);
    expect(library.filter((cv) => cv.isDefault).map((cv) => cv.id)).toEqual([second.id]);
    expect(library.find((cv) => cv.id === first.id)?.isDefault).toBe(false);
  });

  it('promotes another CV when the default is deleted', () => {
    const first = workspace.createCvDocument(db, CV);
    const second = workspace.createCvDocument(db, { ...CV, name: 'Second' });
    expect(first.isDefault).toBe(true);

    workspace.deleteCvDocument(db, first.id);

    const library = workspace.listCvDocuments(db);
    expect(library.map((cv) => cv.id)).toEqual([second.id]);
    expect(library[0]?.isDefault).toBe(true);
  });

  it('leaves the library empty (not broken) when the last CV is deleted', () => {
    const only = workspace.createCvDocument(db, CV);
    expect(workspace.deleteCvDocument(db, only.id)).toEqual({ deleted: true });
    expect(workspace.listCvDocuments(db)).toEqual([]);
  });

  it('detaches letters and applications from a deleted CV rather than deleting them', () => {
    const cv = workspace.createCvDocument(db, CV);
    const letter = workspace.createLetter(db, { title: 'Motivation', cvId: cv.id });
    const application = workspace.createApplication(db, { ...JOB, cvId: cv.id });

    workspace.deleteCvDocument(db, cv.id);

    expect(workspace.listLetters(db).find((l) => l.id === letter.id)?.cvId).toBeNull();
    expect(workspace.listApplications(db).find((a) => a.id === application.id)?.cvId).toBeNull();
  });

  it('merges a profile patch into the stored profile instead of replacing it', () => {
    const cv = workspace.createCvDocument(db, {
      ...CV,
      profile: { title: 'Frontend Engineer', years: '8', skills: ['Angular', 'TypeScript'] },
    });
    const updated = workspace.updateCvDocument(db, cv.id, { profile: { title: 'Senior Frontend Engineer' } });

    expect(updated.profile.title).toBe('Senior Frontend Engineer');
    expect(updated.profile.years).toBe('8');
    expect(updated.profile.skills).toEqual(['Angular', 'TypeScript']);
  });

  it('fills in a complete profile shape even for a CV created without one', () => {
    const cv = workspace.createCvDocument(db, { ...CV, kind: 'manual' });
    expect(cv.profile).toEqual({ title: '', years: '', location: '', languages: '', skills: [], summary: '', auth: '' });
  });

  it('persists extracted CV text, which is the whole point of the save-to-library path', () => {
    const cv = workspace.createCvDocument(db, { ...CV, text: 'Angular. TypeScript. 8 years.' });
    expect(workspace.listCvDocuments(db)[0]?.text).toBe('Angular. TypeScript. 8 years.');
    expect(cv.kind).toBe('uploaded');
  });

  it('getCvDocument (#156) reads back a single row by id', () => {
    const cv = workspace.createCvDocument(db, { ...CV, targetRole: 'Frontend Engineer' });
    expect(workspace.getCvDocument(db, cv.id)).toEqual(cv);
  });

  it('getCvDocument throws WorkspaceNotFoundError for a missing id, the same as update/delete', () => {
    expect(() => workspace.getCvDocument(db, 'no-such-id')).toThrow(WorkspaceNotFoundError);
  });
});

describe('letters', () => {
  it('duplicates a letter as a fresh draft with a distinct id', () => {
    const original = workspace.createLetter(db, {
      title: 'Redwood motivation',
      company: 'Redwood Software',
      status: 'sent',
      body: 'Dear hiring manager',
    });

    const copy = workspace.duplicateLetter(db, original.id);

    expect(copy.id).not.toBe(original.id);
    expect(copy.title).toBe('Redwood motivation (copy)');
    expect(copy.body).toBe(original.body);
    expect(copy.company).toBe(original.company);
    // A duplicate of a sent letter has not itself been sent.
    expect(copy.status).toBe('draft');
    expect(workspace.listLetters(db)).toHaveLength(2);
  });

  it('refuses to duplicate a letter that does not exist', () => {
    expect(() => workspace.duplicateLetter(db, 'nope')).toThrow(WorkspaceNotFoundError);
  });

  it('bumps updatedAt on every update', async () => {
    const letter = workspace.createLetter(db, { title: 'Draft' });
    await new Promise((resolve) => setTimeout(resolve, 5));
    const updated = workspace.updateLetter(db, letter.id, { body: 'now with content' });
    expect(new Date(updated.updatedAt).valueOf()).toBeGreaterThanOrEqual(new Date(letter.updatedAt).valueOf());
  });
});

describe('counts', () => {
  it('counts saved jobs, ACTIVE applications only, and letters', () => {
    workspace.createSavedJob(db, JOB);
    workspace.createSavedJob(db, { ...JOB, role: 'Another' });
    workspace.createApplication(db, JOB);
    workspace.createApplication(db, { ...JOB, archived: true });
    workspace.createLetter(db, { title: 'L' });

    expect(workspace.getCounts(db)).toEqual({ savedJobs: 2, activeApplications: 1, letters: 1 });
  });

  it('is all zeros on a fresh database', () => {
    expect(workspace.getCounts(db)).toEqual({ savedJobs: 0, activeApplications: 0, letters: 0 });
  });
});

// A stand-in SHA-256 hex digest: the repository only checks shape at the validate.ts boundary,
// never here, so any 64-char hex string exercises these functions correctly.
const HASH_A = 'a'.repeat(64);
const HASH_B = 'b'.repeat(64);
const HASH_C = 'c'.repeat(64);

const ATTEMPT = {
  company: 'Redwood Software',
  role: 'Frontend Engineer',
  sourceCvContentHash: HASH_A,
  jdSnapshotHash: HASH_B,
} as const;

describe('application attempts (#198)', () => {
  it('creates and reads back an attempt with the queued default', () => {
    const created = workspace.createApplicationAttempt(db, { ...ATTEMPT, vacancyKey: 'vac-1' });
    expect(created.checkpoint).toBe('queued');
    expect(created.jdComplete).toBe(true);

    const fetched = workspace.getApplicationAttempt(db, created.id);
    expect(fetched).toEqual(created);
  });

  it('refuses a second concurrent attempt at the same vacancy (dedup by vacancyKey)', () => {
    const first = workspace.createApplicationAttempt(db, { ...ATTEMPT, vacancyKey: 'vac-1' });
    expect(() => workspace.createApplicationAttempt(db, { ...ATTEMPT, vacancyKey: 'vac-1' })).toThrow(
      workspace.ApplicationAttemptDuplicateError,
    );
    // The refusal names which attempt is already in progress, not just that one exists.
    try {
      workspace.createApplicationAttempt(db, { ...ATTEMPT, vacancyKey: 'vac-1' });
    } catch (error) {
      expect(error).toBeInstanceOf(workspace.ApplicationAttemptDuplicateError);
      expect((error as InstanceType<typeof workspace.ApplicationAttemptDuplicateError>).existingAttemptId).toBe(
        first.id,
      );
    }
  });

  it('dedups by canonicalUrl when there is no vacancyKey', () => {
    workspace.createApplicationAttempt(db, { ...ATTEMPT, canonicalUrl: 'https://example.invalid/jobs/1' });
    expect(() =>
      workspace.createApplicationAttempt(db, { ...ATTEMPT, canonicalUrl: 'https://example.invalid/jobs/1' }),
    ).toThrow(workspace.ApplicationAttemptDuplicateError);
  });

  it('allows an explicit force:true to bypass the dedup refusal', () => {
    workspace.createApplicationAttempt(db, { ...ATTEMPT, vacancyKey: 'vac-1' });
    const second = workspace.createApplicationAttempt(db, { ...ATTEMPT, vacancyKey: 'vac-1', force: true });
    expect(workspace.listApplicationAttempts(db)).toHaveLength(2);
    expect(second.checkpoint).toBe('queued');
  });

  it('does not refuse a new attempt once the prior one reached a terminal checkpoint that never submitted', () => {
    const first = workspace.createApplicationAttempt(db, { ...ATTEMPT, vacancyKey: 'vac-1' });
    workspace.updateApplicationAttempt(db, first.id, { checkpoint: 'failed' });
    expect(() => workspace.createApplicationAttempt(db, { ...ATTEMPT, vacancyKey: 'vac-1' })).not.toThrow();
  });

  it('DOES refuse a new attempt once the prior one reached submitted -- that is #275, not the concurrency guard', () => {
    // This test used to assert the opposite. A `submitted` attempt is terminal for the concurrency
    // guard (nothing is still running) but is exactly the case the completed-application lookup
    // exists to catch, so the refusal now comes from the other guard and names the other error.
    const first = workspace.createApplicationAttempt(db, { ...ATTEMPT, vacancyKey: 'vac-1' });
    workspace.updateApplicationAttempt(db, first.id, { checkpoint: 'submitted', completionEvidence: 'user_reported' });
    expect(() => workspace.createApplicationAttempt(db, { ...ATTEMPT, vacancyKey: 'vac-1' })).toThrow(
      workspace.ApplicationAlreadyCompletedError,
    );
  });

  it('still refuses while the prior attempt is submission_unknown -- a real submission may already have gone through', () => {
    const first = workspace.createApplicationAttempt(db, { ...ATTEMPT, vacancyKey: 'vac-1' });
    workspace.updateApplicationAttempt(db, first.id, { checkpoint: 'submission_unknown' });
    expect(() => workspace.createApplicationAttempt(db, { ...ATTEMPT, vacancyKey: 'vac-1' })).toThrow(
      workspace.ApplicationAttemptDuplicateError,
    );
  });

  it('updates the checkpoint and bumps updatedAt, leaving provenance fields untouched', () => {
    const created = workspace.createApplicationAttempt(db, { ...ATTEMPT, vacancyKey: 'vac-1' });
    const updated = workspace.updateApplicationAttempt(db, created.id, {
      checkpoint: 'needs_user',
      checkpointDetail: 'CAPTCHA on the application form',
    });
    expect(updated.checkpoint).toBe('needs_user');
    expect(updated.checkpointDetail).toBe('CAPTCHA on the application form');
    expect(updated.sourceCvContentHash).toBe(ATTEMPT.sourceCvContentHash);
    expect(new Date(updated.updatedAt).getTime()).toBeGreaterThanOrEqual(new Date(created.updatedAt).getTime());
  });

  it('records submittedAt only when the patch sets it, and clears it back to null on an explicit null', () => {
    const created = workspace.createApplicationAttempt(db, { ...ATTEMPT, vacancyKey: 'vac-1' });
    expect(created.submittedAt).toBeNull();

    const submitted = workspace.updateApplicationAttempt(db, created.id, {
      checkpoint: 'submitted',
      submittedAt: new Date('2026-01-01T00:00:00.000Z').toISOString(),
    });
    expect(submitted.submittedAt).toBe('2026-01-01T00:00:00.000Z');

    const cleared = workspace.updateApplicationAttempt(db, submitted.id, { submittedAt: null });
    expect(cleared.submittedAt).toBeNull();
  });

  it('throws WorkspaceNotFoundError for an unknown id', () => {
    expect(() => workspace.getApplicationAttempt(db, 'nope')).toThrow(WorkspaceNotFoundError);
    expect(() => workspace.updateApplicationAttempt(db, 'nope', { checkpoint: 'failed' })).toThrow(
      WorkspaceNotFoundError,
    );
  });

  it('survives a real close-and-reopen mid-checkpoint (crash recovery)', () => {
    const created = workspace.createApplicationAttempt(db, { ...ATTEMPT, vacancyKey: 'vac-1' });
    workspace.updateApplicationAttempt(db, created.id, { checkpoint: 'filling' });
    workspace.createApplicationArtifact(db, {
      attemptId: created.id,
      kind: 'cv_pdf',
      mimeType: 'application/pdf',
      byteSize: 2048,
      contentHash: HASH_C,
    });
    close();

    const reopened = createWorkspaceDb(dir);
    try {
      const attempt = workspace.getApplicationAttempt(reopened.db, created.id);
      expect(attempt.checkpoint).toBe('filling');
      expect(workspace.listApplicationArtifacts(reopened.db, created.id)).toHaveLength(1);
    } finally {
      reopened.close();
    }
    close = () => {};
  });
});

/**
 * #275: a completed application must not silently re-enter the queue.
 *
 * Every fixture here is synthetic. "Northwind Labs" is a made-up employer and the requisition ids
 * are invented; only the *host shapes* are real, because the whole point of the requisition
 * identity is that it is read out of a real ATS apply URL.
 */
const GREENHOUSE_JOB = 'https://boards.greenhouse.io/northwindlabs/jobs/4012345';
const GREENHOUSE_OTHER_JOB = 'https://boards.greenhouse.io/northwindlabs/jobs/4012999';

const NORTHWIND = {
  company: 'Northwind Labs',
  role: 'Platform Engineer',
  sourceCvContentHash: HASH_A,
  jdSnapshotHash: HASH_B,
} as const;

/** Takes an attempt all the way to a completed application with the given evidence. */
/**
 * Completes an attempt the way the app really completes one, which since #271 depends on *how* it
 * was completed:
 *
 *  - `receipt_confirmed` lands on `submitted`, which now means "this app observed a receipt" and is
 *    written only by the post-click observer in `application-review-session.ts`;
 *  - `user_reported` lands on the `user_reported` checkpoint, because a person's own statement is
 *    deliberately not `submitted` -- that is #271's fourth acceptance case.
 *
 * #275 was written against a codebase with no `user_reported` checkpoint, so this helper originally
 * put both on `submitted`. Keeping it that way would have made #275's third acceptance case pass
 * without ever exercising the checkpoint a user-reported completion actually lands on, hiding
 * whether `COMPLETED_ATTEMPT_CHECKPOINTS` covers it -- which is the one thing that case is for.
 */
function completeAttempt(
  attemptId: string,
  completionEvidence: 'user_reported' | 'receipt_confirmed',
): void {
  workspace.updateApplicationAttempt(db, attemptId, {
    checkpoint: completionEvidence === 'user_reported' ? 'user_reported' : 'submitted',
    submittedAt: '2026-09-01T09:00:00.000Z',
    submissionMode: 'manual',
    completionEvidence,
  });
}

function completedRefusal(input: Parameters<typeof workspace.createApplicationAttempt>[1]): workspace.ApplicationAlreadyCompletedError {
  try {
    workspace.createApplicationAttempt(db, input);
  } catch (error) {
    expect(error).toBeInstanceOf(workspace.ApplicationAlreadyCompletedError);
    return error as workspace.ApplicationAlreadyCompletedError;
  }
  throw new Error('expected the attempt to be refused as an already-completed application');
}

describe('completed-application dedup (#275)', () => {
  it('acceptance 1: re-importing an already-submitted vacancy from another source does not create an ordinary new attempt', () => {
    const first = workspace.createApplicationAttempt(db, {
      ...NORTHWIND,
      vacancyKey: 'scan-42',
      canonicalUrl: GREENHOUSE_JOB,
    });
    completeAttempt(first.id, 'receipt_confirmed');

    // A second import of the same real requisition: a different report key, a differently spelled
    // company, an http scheme, a trailing slash and a pile of tracking parameters. Every one of
    // those defeats #198's `vacancyKey`/raw-URL dedup; none of them changes the requisition.
    const refusal = completedRefusal({
      ...NORTHWIND,
      company: 'Northwind Labs B.V.',
      vacancyKey: 'sheet-import-77',
      canonicalUrl: 'http://www.boards.greenhouse.io/northwindlabs/jobs/4012345/?utm_source=weekly-digest&gh_src=abc123',
    });

    expect(refusal.match.attemptId).toBe(first.id);
    expect(refusal.match.matchedOn).toBe('requisition');
    expect(workspace.listApplicationAttempts(db)).toHaveLength(1);
  });

  it('acceptance 1 (fallback): the same posting with no recognisable ATS requisition is still caught by its canonical URL', () => {
    const first = workspace.createApplicationAttempt(db, {
      ...NORTHWIND,
      vacancyKey: 'scan-42',
      canonicalUrl: 'https://careers.northwind.invalid/openings/platform-engineer',
    });
    completeAttempt(first.id, 'user_reported');

    const refusal = completedRefusal({
      ...NORTHWIND,
      vacancyKey: 'sheet-import-77',
      canonicalUrl: 'https://careers.northwind.invalid/openings/platform-engineer?utm_campaign=jobboard#apply',
    });
    expect(refusal.match.matchedOn).toBe('canonical_url');
  });

  it('acceptance 2: another requisition at the same company stays eligible', () => {
    const first = workspace.createApplicationAttempt(db, {
      ...NORTHWIND,
      vacancyKey: 'scan-42',
      canonicalUrl: GREENHOUSE_JOB,
    });
    completeAttempt(first.id, 'receipt_confirmed');

    const second = workspace.createApplicationAttempt(db, {
      ...NORTHWIND,
      role: 'Staff Platform Engineer',
      vacancyKey: 'scan-43',
      canonicalUrl: GREENHOUSE_OTHER_JOB,
    });

    // Same employer, deliberately distinct requisitions -- exactly what must not be merged.
    expect(second.employerKey).toBe('greenhouse:northwindlabs');
    expect(first.employerKey).toBe(second.employerKey);
    expect(first.requisitionId).toBe('4012345');
    expect(second.requisitionId).toBe('4012999');
    expect(workspace.listApplicationAttempts(db)).toHaveLength(2);
  });

  it('acceptance 3: user-reported and receipt-confirmed completion both suppress duplicates, and each keeps its own evidence type', () => {
    const reported = workspace.createApplicationAttempt(db, { ...NORTHWIND, canonicalUrl: GREENHOUSE_JOB });
    completeAttempt(reported.id, 'user_reported');
    const confirmed = workspace.createApplicationAttempt(db, { ...NORTHWIND, canonicalUrl: GREENHOUSE_OTHER_JOB });
    completeAttempt(confirmed.id, 'receipt_confirmed');

    expect(completedRefusal({ ...NORTHWIND, canonicalUrl: GREENHOUSE_JOB }).match).toMatchObject({
      attemptId: reported.id,
      completionEvidence: 'user_reported',
    });
    expect(completedRefusal({ ...NORTHWIND, canonicalUrl: GREENHOUSE_OTHER_JOB }).match).toMatchObject({
      attemptId: confirmed.id,
      completionEvidence: 'receipt_confirmed',
    });

    // Stored, not merely reported through the error: the distinction survives on the row.
    expect(workspace.getApplicationAttempt(db, reported.id).completionEvidence).toBe('user_reported');
    expect(workspace.getApplicationAttempt(db, confirmed.id).completionEvidence).toBe('receipt_confirmed');

    // The two completions really do sit on different checkpoints since #271 -- which is the whole
    // reason this case needs `COMPLETED_ATTEMPT_CHECKPOINTS` to cover both.
    expect(workspace.getApplicationAttempt(db, reported.id).checkpoint).toBe('user_reported');
    expect(workspace.getApplicationAttempt(db, confirmed.id).checkpoint).toBe('submitted');
  });

  /**
   * The #271/#275 reconciliation invariant, pinned on its own rather than left implicit in the
   * cases above.
   *
   * #271 and #275 were built independently against the same master. #271 moved a person's
   * self-reported completion off `submitted` onto a new `user_reported` checkpoint; #275's
   * completed-application lookup keys off a set of checkpoints that, as written, listed only
   * `submitted` and `submission_unknown`. Merging the two without noticing leaves the single most
   * common completion path -- a person saying "I already applied to this one" -- matching neither
   * guard, and the vacancy silently re-queueable. That is precisely the bug #275 exists to fix,
   * reintroduced by the merge rather than by either change.
   *
   * `force` must not get past it either: #198's escape hatch is for work that did not land.
   */
  it('#271 + #275: a user_reported completion is a completed application, and force does not get past it', () => {
    const reported = workspace.createApplicationAttempt(db, { ...NORTHWIND, canonicalUrl: GREENHOUSE_JOB });
    completeAttempt(reported.id, 'user_reported');
    expect(workspace.getApplicationAttempt(db, reported.id).checkpoint).toBe('user_reported');

    // The set itself, so a future edit that drops the value fails here and says why.
    expect(COMPLETED_ATTEMPT_CHECKPOINTS).toContain('user_reported');
    // ...and it stays out of the concurrency guard, which is a different question (#271).
    expect(NON_TERMINAL_ATTEMPT_CHECKPOINTS).not.toContain('user_reported');

    // Re-importing the same posting is refused...
    expect(() => workspace.createApplicationAttempt(db, { ...NORTHWIND, canonicalUrl: GREENHOUSE_JOB })).toThrow(
      workspace.ApplicationAlreadyCompletedError,
    );
    // ...including from a different source, with different tracking parameters...
    expect(() =>
      workspace.createApplicationAttempt(db, {
        ...NORTHWIND,
        vacancyKey: 'a-different-scan-entirely',
        canonicalUrl: `${GREENHOUSE_JOB}?utm_source=newsletter`,
      }),
    ).toThrow(workspace.ApplicationAlreadyCompletedError);
    // ...and `force: true` is not the way past a completed application.
    expect(() => workspace.createApplicationAttempt(db, { ...NORTHWIND, canonicalUrl: GREENHOUSE_JOB, force: true })).toThrow(
      workspace.ApplicationAlreadyCompletedError,
    );

    // Only the explicit, recorded reapply path gets through.
    const reapplied = workspace.createApplicationAttempt(db, {
      ...NORTHWIND,
      canonicalUrl: GREENHOUSE_JOB,
      reapply: { supersedesAttemptId: reported.id, reason: 'The employer asked me to resend with a corrected CV' },
    });
    expect(reapplied.supersedesAttemptId).toBe(reported.id);

    // A different opening at the same employer was never in scope and stays eligible.
    expect(() => workspace.createApplicationAttempt(db, { ...NORTHWIND, canonicalUrl: GREENHOUSE_OTHER_JOB })).not.toThrow();
  });

  it('acceptance 4: an explicit reapply records its predecessor, its reason and both document versions', () => {
    const first = workspace.createApplicationAttempt(db, { ...NORTHWIND, canonicalUrl: GREENHOUSE_JOB });
    completeAttempt(first.id, 'user_reported');

    const reapplied = workspace.createApplicationAttempt(db, {
      ...NORTHWIND,
      canonicalUrl: GREENHOUSE_JOB,
      sourceCvContentHash: HASH_C,
      reapply: { supersedesAttemptId: first.id, reason: 'Corrected CV: the attached file was the wrong version' },
    });

    expect(reapplied.supersedesAttemptId).toBe(first.id);
    expect(reapplied.reapplyReason).toBe('Corrected CV: the attached file was the wrong version');
    // Both document versions readable off the one row: what the superseded attempt carried...
    expect(reapplied.reapplyPreviousCvContentHash).toBe(HASH_A);
    // ...and what this one carries.
    expect(reapplied.sourceCvContentHash).toBe(HASH_C);
    expect(workspace.listApplicationAttempts(db)).toHaveLength(2);
  });

  it('acceptance 4: a reapply is refused unless it names a real completed attempt at this requisition, with a reason', () => {
    const first = workspace.createApplicationAttempt(db, { ...NORTHWIND, canonicalUrl: GREENHOUSE_JOB });
    completeAttempt(first.id, 'user_reported');
    const elsewhere = workspace.createApplicationAttempt(db, { ...NORTHWIND, canonicalUrl: GREENHOUSE_OTHER_JOB });
    completeAttempt(elsewhere.id, 'user_reported');

    // An empty reason is not a record of anything.
    expect(() =>
      workspace.createApplicationAttempt(db, {
        ...NORTHWIND,
        canonicalUrl: GREENHOUSE_JOB,
        reapply: { supersedesAttemptId: first.id, reason: '   ' },
      }),
    ).toThrow(workspace.ApplicationReapplyError);

    // Naming some other completed attempt must not work as a generic bypass.
    expect(() =>
      workspace.createApplicationAttempt(db, {
        ...NORTHWIND,
        canonicalUrl: GREENHOUSE_JOB,
        reapply: { supersedesAttemptId: elsewhere.id, reason: 'Corrected CV' },
      }),
    ).toThrow(workspace.ApplicationReapplyError);

    // Neither must reapplying against a requisition that has no completed application at all.
    expect(() =>
      workspace.createApplicationAttempt(db, {
        ...NORTHWIND,
        canonicalUrl: 'https://boards.greenhouse.io/northwindlabs/jobs/4013111',
        reapply: { supersedesAttemptId: first.id, reason: 'Corrected CV' },
      }),
    ).toThrow(workspace.ApplicationReapplyError);

    expect(workspace.listApplicationAttempts(db)).toHaveLength(2);
  });

  it('acceptance 5: submission_unknown is not free to re-queue, and force:true does not get past it', () => {
    const first = workspace.createApplicationAttempt(db, { ...NORTHWIND, vacancyKey: 'scan-42', canonicalUrl: GREENHOUSE_JOB });
    workspace.updateApplicationAttempt(db, first.id, {
      checkpoint: 'submission_unknown',
      checkpointDetail: 'navigation lost after the submit click',
      submittedAt: '2026-09-01T09:00:00.000Z',
    });

    // The concurrency guard catches the plain case, as it did before #275.
    expect(() =>
      workspace.createApplicationAttempt(db, { ...NORTHWIND, vacancyKey: 'scan-42', canonicalUrl: GREENHOUSE_JOB }),
    ).toThrow(workspace.ApplicationAttemptDuplicateError);

    // ...and `force`, which exists to get past *that* guard, no longer walks straight into a
    // possible second real submission: the completed-application lookup refuses it separately.
    const forced = completedRefusal({
      ...NORTHWIND,
      vacancyKey: 'scan-42',
      canonicalUrl: GREENHOUSE_JOB,
      force: true,
    });
    expect(forced.match.checkpoint).toBe('submission_unknown');
    expect(forced.match.completionEvidence).toBeNull();
    expect(workspace.listApplicationAttempts(db)).toHaveLength(1);
  });

  it('acceptance 5: resolving submission_unknown takes reconciliation or a recorded decision, never a bare patch', () => {
    const first = workspace.createApplicationAttempt(db, { ...NORTHWIND, canonicalUrl: GREENHOUSE_JOB });
    workspace.updateApplicationAttempt(db, first.id, {
      checkpoint: 'submission_unknown',
      checkpointDetail: 'the tab closed before a receipt was seen',
    });

    // Silently downgrading it to `failed` would drop the protection with nothing on the record.
    expect(() => workspace.updateApplicationAttempt(db, first.id, { checkpoint: 'failed' })).toThrow(
      workspace.ApplicationCompletionDecisionError,
    );
    expect(workspace.getApplicationAttempt(db, first.id).checkpoint).toBe('submission_unknown');

    // The same move with the decision recorded is allowed, and only then is the requisition free.
    workspace.updateApplicationAttempt(db, first.id, {
      checkpoint: 'failed',
      checkpointDetail: 'user confirmed the employer has no record of an application',
    });
    expect(() =>
      workspace.createApplicationAttempt(db, { ...NORTHWIND, canonicalUrl: GREENHOUSE_JOB }),
    ).not.toThrow();
  });

  it('acceptance 5: reconciling submission_unknown INTO submitted needs no reason and keeps the protection', () => {
    const first = workspace.createApplicationAttempt(db, { ...NORTHWIND, canonicalUrl: GREENHOUSE_JOB });
    workspace.updateApplicationAttempt(db, first.id, { checkpoint: 'submission_unknown', checkpointDetail: 'timed out' });

    // A receipt turning up later resolves the ambiguity in the direction that protects nothing new.
    const reconciled = workspace.updateApplicationAttempt(db, first.id, {
      checkpoint: 'submitted',
      completionEvidence: 'receipt_confirmed',
    });
    expect(reconciled.checkpoint).toBe('submitted');
    expect(completedRefusal({ ...NORTHWIND, canonicalUrl: GREENHOUSE_JOB }).match.completionEvidence).toBe(
      'receipt_confirmed',
    );
  });

  it('exposes the lookup on its own, so a caller can skip a posting instead of catching a refusal', () => {
    expect(workspace.findCompletedApplication(db, { ...NORTHWIND, canonicalUrl: GREENHOUSE_JOB })).toBeUndefined();

    const first = workspace.createApplicationAttempt(db, { ...NORTHWIND, canonicalUrl: GREENHOUSE_JOB });
    completeAttempt(first.id, 'user_reported');

    expect(workspace.findCompletedApplication(db, { ...NORTHWIND, canonicalUrl: GREENHOUSE_JOB })).toMatchObject({
      attemptId: first.id,
      matchedOn: 'requisition',
      completionEvidence: 'user_reported',
      submittedAt: '2026-09-01T09:00:00.000Z',
    });
    // A different requisition at the same employer is not a match, through this entry point either.
    expect(
      workspace.findCompletedApplication(db, { ...NORTHWIND, canonicalUrl: GREENHOUSE_OTHER_JOB }),
    ).toBeUndefined();
  });

  it('keeps an attempt created before the identity columns existed from matching everything', () => {
    // Migration 0012 backfills '' / null, which is what a row with no derivable identity also
    // looks like. Neither may be treated as "matches any posting".
    const legacy = workspace.createApplicationAttempt(db, { ...NORTHWIND, canonicalUrl: GREENHOUSE_JOB });
    completeAttempt(legacy.id, 'user_reported');
    db.update(schema.applicationAttempts)
      .set({ employerKey: '', requisitionId: null, canonicalUrlKey: '' })
      .where(eq(schema.applicationAttempts.id, legacy.id))
      .run();

    expect(
      workspace.findCompletedApplication(db, { ...NORTHWIND, canonicalUrl: GREENHOUSE_OTHER_JOB }),
    ).toBeUndefined();
  });
});

describe('application artifacts (#198)', () => {
  it('creates and lists artifacts for an attempt, oldest first', () => {
    const attempt = workspace.createApplicationAttempt(db, { ...ATTEMPT, vacancyKey: 'vac-1' });
    workspace.createApplicationArtifact(db, {
      attemptId: attempt.id,
      kind: 'cv_pdf',
      mimeType: 'application/pdf',
      byteSize: 1000,
      contentHash: HASH_A,
    });
    workspace.createApplicationArtifact(db, {
      attemptId: attempt.id,
      kind: 'cover_letter_pdf',
      mimeType: 'application/pdf',
      byteSize: 500,
      contentHash: HASH_B,
    });

    const artifacts = workspace.listApplicationArtifacts(db, attempt.id);
    expect(artifacts.map((a) => a.kind)).toEqual(['cv_pdf', 'cover_letter_pdf']);
  });

  it('refuses an artifact for a nonexistent attempt', () => {
    expect(() =>
      workspace.createApplicationArtifact(db, {
        attemptId: 'nope',
        kind: 'cv_pdf',
        mimeType: 'application/pdf',
        byteSize: 1000,
        contentHash: HASH_A,
      }),
    ).toThrow(WorkspaceNotFoundError);
  });

  it('enforces the per-attempt artifact count quota', () => {
    const attempt = workspace.createApplicationAttempt(db, { ...ATTEMPT, vacancyKey: 'vac-1' });
    for (let i = 0; i < workspace.APPLICATION_ARTIFACT_QUOTA.maxPerAttempt; i++) {
      workspace.createApplicationArtifact(db, {
        attemptId: attempt.id,
        kind: 'other',
        mimeType: 'application/pdf',
        byteSize: 1,
        contentHash: HASH_A,
      });
    }
    expect(() =>
      workspace.createApplicationArtifact(db, {
        attemptId: attempt.id,
        kind: 'other',
        mimeType: 'application/pdf',
        byteSize: 1,
        contentHash: HASH_A,
      }),
    ).toThrow(workspace.ApplicationArtifactQuotaError);
  });

  it('enforces the per-attempt total byte-size quota', () => {
    const attempt = workspace.createApplicationAttempt(db, { ...ATTEMPT, vacancyKey: 'vac-1' });
    expect(() =>
      workspace.createApplicationArtifact(db, {
        attemptId: attempt.id,
        kind: 'other',
        mimeType: 'application/pdf',
        byteSize: workspace.APPLICATION_ARTIFACT_QUOTA.maxTotalBytesPerAttempt + 1,
        contentHash: HASH_A,
      }),
    ).toThrow(workspace.ApplicationArtifactQuotaError);
  });

  it('deletes an artifact independently of its attempt', () => {
    const attempt = workspace.createApplicationAttempt(db, { ...ATTEMPT, vacancyKey: 'vac-1' });
    const artifact = workspace.createApplicationArtifact(db, {
      attemptId: attempt.id,
      kind: 'cv_pdf',
      mimeType: 'application/pdf',
      byteSize: 1000,
      contentHash: HASH_A,
    });
    expect(workspace.deleteApplicationArtifact(db, artifact.id)).toEqual({ deleted: true });
    expect(workspace.listApplicationArtifacts(db, attempt.id)).toHaveLength(0);
  });

  it('cascades: deleting the attempt deletes its artifacts', () => {
    const attempt = workspace.createApplicationAttempt(db, { ...ATTEMPT, vacancyKey: 'vac-1' });
    workspace.createApplicationArtifact(db, {
      attemptId: attempt.id,
      kind: 'cv_pdf',
      mimeType: 'application/pdf',
      byteSize: 1000,
      contentHash: HASH_A,
    });
    workspace.deleteApplicationAttempt(db, attempt.id);
    expect(workspace.listApplicationArtifacts(db, attempt.id)).toHaveLength(0);
  });

  it('reconciles the manifest against disk, reporting only artifacts whose file is actually missing', () => {
    const attempt = workspace.createApplicationAttempt(db, { ...ATTEMPT, vacancyKey: 'vac-1' });
    // Never staged: empty storagePath, correctly excluded (there is nothing to check on disk yet).
    workspace.createApplicationArtifact(db, {
      attemptId: attempt.id,
      kind: 'cv_pdf',
      mimeType: 'application/pdf',
      byteSize: 1000,
      contentHash: HASH_A,
    });
    // Staged and present.
    const present = workspace.createApplicationArtifact(db, {
      attemptId: attempt.id,
      kind: 'cover_letter_pdf',
      mimeType: 'application/pdf',
      byteSize: 500,
      contentHash: HASH_B,
      storagePath: '/staged/present.pdf',
    });
    // Staged but missing -- the case reconciliation exists to catch.
    const missing = workspace.createApplicationArtifact(db, {
      attemptId: attempt.id,
      kind: 'other',
      mimeType: 'application/pdf',
      byteSize: 500,
      contentHash: HASH_C,
      storagePath: '/staged/missing.pdf',
    });

    const orphaned = workspace.reconcileApplicationArtifacts(db, (path) => path === present.storagePath);
    expect(orphaned.map((a) => a.id)).toEqual([missing.id]);
  });
});

describe('application submission receipts (#271)', () => {
  const DESTINATION = 'https://fixture.example.invalid/apply';

  it('records an observed submission with its attempt, destination, timestamp and evidence reference', () => {
    const attempt = workspace.createApplicationAttempt(db, { ...ATTEMPT, vacancyKey: 'vac-1' });
    const receipt = workspace.createApplicationSubmissionReceipt(db, {
      attemptId: attempt.id,
      outcome: 'submitted',
      source: 'page_observation',
      destination: DESTINATION,
      evidenceKind: 'confirmation_page',
      evidenceReference: 'Your application has been submitted',
      detail: 'the page replaced the form with a confirmation',
      observedAt: '2026-09-11T10:00:00.000Z',
    });

    expect(receipt).toMatchObject({
      attemptId: attempt.id,
      outcome: 'submitted',
      destination: DESTINATION,
      evidenceReference: 'Your application has been submitted',
      observedAt: '2026-09-11T10:00:00.000Z',
    });
    expect(workspace.listApplicationSubmissionReceipts(db, attempt.id)).toEqual([receipt]);
  });

  it('refuses a "submitted" receipt with no evidence behind it -- the whole point of the table', () => {
    const attempt = workspace.createApplicationAttempt(db, { ...ATTEMPT, vacancyKey: 'vac-1' });
    expect(() =>
      workspace.createApplicationSubmissionReceipt(db, {
        attemptId: attempt.id,
        outcome: 'submitted',
        source: 'page_observation',
        evidenceKind: 'none',
      }),
    ).toThrow(workspace.ApplicationSubmissionReceiptError);
    expect(() =>
      workspace.createApplicationSubmissionReceipt(db, {
        attemptId: attempt.id,
        outcome: 'submitted',
        source: 'page_observation',
        evidenceKind: 'confirmation_page',
        evidenceReference: '   ',
      }),
    ).toThrow(workspace.ApplicationSubmissionReceiptError);
    expect(workspace.listApplicationSubmissionReceipts(db, attempt.id)).toEqual([]);
  });

  it('never lets a person\'s own statement be recorded as an observed outcome', () => {
    const attempt = workspace.createApplicationAttempt(db, { ...ATTEMPT, vacancyKey: 'vac-1' });
    expect(() =>
      workspace.createApplicationSubmissionReceipt(db, {
        attemptId: attempt.id,
        outcome: 'submitted',
        source: 'user_reported',
        evidenceKind: 'user_statement',
        evidenceReference: 'I applied myself',
      }),
    ).toThrow(workspace.ApplicationSubmissionReceiptError);
  });

  it('keeps an unresolved observation and a later reconciliation as two rows, oldest first', () => {
    const attempt = workspace.createApplicationAttempt(db, { ...ATTEMPT, vacancyKey: 'vac-1' });
    workspace.createApplicationSubmissionReceipt(db, {
      attemptId: attempt.id,
      outcome: 'unknown',
      source: 'page_observation',
      destination: DESTINATION,
      evidenceKind: 'none',
      observedAt: '2026-09-11T10:00:00.000Z',
    });
    workspace.createApplicationSubmissionReceipt(db, {
      attemptId: attempt.id,
      outcome: 'submitted',
      source: 'delayed_receipt',
      destination: DESTINATION,
      evidenceKind: 'delivery_receipt',
      evidenceReference: 'confirmationNumber: FIXTURE-9001',
      observedAt: '2026-09-12T08:00:00.000Z',
    });

    const timeline = workspace.listApplicationSubmissionReceipts(db, attempt.id);
    expect(timeline.map((r) => r.outcome)).toEqual(['unknown', 'submitted']);
  });

  it('refuses a receipt for an attempt that does not exist', () => {
    expect(() =>
      workspace.createApplicationSubmissionReceipt(db, {
        attemptId: 'nope',
        outcome: 'unknown',
        source: 'page_observation',
        evidenceKind: 'none',
      }),
    ).toThrow(WorkspaceNotFoundError);
  });
});

describe('persistence across connections', () => {
  it('reopens the same database file and finds the data still there', () => {
    workspace.createSavedJob(db, JOB);
    close();

    const reopened = createWorkspaceDb(dir);
    try {
      expect(workspace.listSavedJobs(reopened.db)).toHaveLength(1);
    } finally {
      reopened.close();
    }
    // beforeEach/afterEach still own `close`; make the second close a no-op.
    close = () => {};
  });
});
