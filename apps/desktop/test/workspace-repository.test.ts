// @vitest-environment node
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createWorkspaceDb, type WorkspaceDb } from '../electron/workspace/client.js';
import * as workspace from '../electron/workspace/repository.js';
import { WorkspaceNotFoundError } from '../electron/workspace/repository.js';

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

  it('does not refuse a new attempt once the prior one reached a terminal checkpoint', () => {
    const first = workspace.createApplicationAttempt(db, { ...ATTEMPT, vacancyKey: 'vac-1' });
    workspace.updateApplicationAttempt(db, first.id, { checkpoint: 'submitted' });
    expect(() => workspace.createApplicationAttempt(db, { ...ATTEMPT, vacancyKey: 'vac-1' })).not.toThrow();
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
