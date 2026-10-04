import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sql } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createWorkspaceDb, type WorkspaceDb } from '../electron/workspace/client.js';
import * as workspace from '../electron/workspace/repository.js';

/**
 * #444: one attempt, one Applications row, one saved-job status, derived from the attempt's state.
 * Real SQLite, no mocks, because the property under test is a set of rows staying consistent
 * across repeated events and restarts.
 */

let dir: string;
let db: WorkspaceDb;
let close: () => void;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ovr-attempt-sync-'));
  ({ db, close } = createWorkspaceDb(dir));
});
afterEach(() => {
  close();
  rmSync(dir, { recursive: true, force: true });
});

function seedSavedJob(vacancyKey = 'vac-1') {
  return workspace.createSavedJob(db, {
    vacancyKey,
    role: 'Platform Engineer',
    company: 'Northwind',
    location: 'Remote',
    status: 'considering',
  });
}

function startAttempt(vacancyKey = 'vac-1', url = 'https://jobs.example.invalid/apply/1') {
  return workspace.createApplicationAttempt(db, {
    vacancyKey,
    canonicalUrl: url,
    company: 'Northwind',
    role: 'Platform Engineer',
    sourceCvContentHash: 'hash',
    jdSnapshotHash: 'jd',
  });
}

describe('attempt to Applications row (#444)', () => {
  it('creates one Preparing row and marks the saved job Preparing when an attempt starts', () => {
    const job = seedSavedJob();
    const attempt = startAttempt();

    expect(attempt.applicationId).not.toBeNull();
    const rows = workspace.listApplications(db);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: attempt.applicationId,
      status: 'preparing',
      appliedAt: null,
      savedJobId: job.id,
      role: 'Platform Engineer',
      company: 'Northwind',
      attempt: { attemptId: attempt.id, checkpoint: 'queued' },
    });
    expect(workspace.listSavedJobs(db)[0]?.status).toBe('preparing');
  });

  it('moves the same row to Applied with the sent date when a receipt is observed', () => {
    seedSavedJob();
    const attempt = startAttempt();
    workspace.updateApplicationAttempt(db, attempt.id, { checkpoint: 'ready' });
    workspace.updateApplicationAttempt(db, attempt.id, {
      checkpoint: 'submitted',
      submittedAt: '2026-10-02T14:05:00.000Z',
      completionEvidence: 'receipt_confirmed',
    });

    const rows = workspace.listApplications(db);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ status: 'applied', appliedAt: '2026-10-02T14:05:00.000Z' });
    expect(rows[0]?.nextStep).toContain('2026-10-02');
    expect(rows[0]?.nextStep).toMatch(/employer page confirmed it/);
    expect(rows[0]?.attempt).toMatchObject({ checkpoint: 'submitted', evidence: 'receipt_confirmed' });
    expect(workspace.listSavedJobs(db)[0]?.status).toBe('applied');
    expect(workspace.getCounts(db).activeApplications).toBe(1);
  });

  it('keeps a person\'s own report distinct from an observed receipt', () => {
    seedSavedJob();
    const attempt = startAttempt();
    workspace.updateApplicationAttempt(db, attempt.id, {
      checkpoint: 'user_reported',
      checkpointDetail: 'I applied on their site',
      submittedAt: '2026-10-03T09:00:00.000Z',
      completionEvidence: 'user_reported',
    });
    const [row] = workspace.listApplications(db);
    expect(row).toMatchObject({ status: 'applied' });
    const day = new Date('2026-10-03T09:00:00.000Z').toLocaleDateString(undefined, {
      day: 'numeric',
      month: 'short',
      year: 'numeric',
    });
    expect(row?.nextStep).toBe(`You said you applied on ${day}. The app did not see a confirmation.`);
    expect(row?.nextStep).not.toMatch(/\d{4}-\d{2}-\d{2}/);
    expect(row?.attempt?.evidence).toBe('user_reported');
  });

  it('never turns prepared, failed or uncertain attempts into Applied', () => {
    seedSavedJob();
    const attempt = startAttempt();
    for (const checkpoint of ['ready', 'needs_user', 'failed', 'submission_unknown'] as const) {
      workspace.updateApplicationAttempt(db, attempt.id, { checkpoint, checkpointDetail: 'because' });
      const [row] = workspace.listApplications(db);
      expect(row?.status, checkpoint).toBe('preparing');
      expect(row?.appliedAt, checkpoint).toBeNull();
    }
    expect(workspace.listSavedJobs(db)[0]?.status).toBe('preparing');
    expect(workspace.listApplications(db)[0]?.nextStep).toMatch(/no confirmation was seen/i);
  });

  it('archives the row of a skipped attempt and restores the saved job, then reuses the row on a retry', () => {
    seedSavedJob();
    const first = startAttempt();
    workspace.updateApplicationAttempt(db, first.id, { checkpoint: 'skipped' });
    expect(workspace.listApplications(db)[0]).toMatchObject({ archived: true });
    expect(workspace.listSavedJobs(db)[0]?.status).toBe('considering');

    const second = startAttempt();
    const rows = workspace.listApplications(db);
    expect(rows).toHaveLength(1);
    expect(second.applicationId).toBe(first.applicationId);
    expect(rows[0]).toMatchObject({ archived: false, status: 'preparing' });
  });

  it('is idempotent: repeated events and a restart reconcile never duplicate or regress a row', () => {
    seedSavedJob();
    const attempt = startAttempt();
    workspace.updateApplicationAttempt(db, attempt.id, {
      checkpoint: 'submitted',
      submittedAt: '2026-10-02T14:05:00.000Z',
      completionEvidence: 'receipt_confirmed',
    });
    // The person moves the application on; later syncs must not pull it back to Applied.
    const [row] = workspace.listApplications(db);
    workspace.updateApplication(db, row!.id, { status: 'interview', nextStep: 'Prepare for Thursday' });

    workspace.updateApplicationAttempt(db, attempt.id, { checkpointDetail: 'noted again' });
    workspace.reconcileApplicationRows(db);
    workspace.reconcileApplicationRows(db);

    const rows = workspace.listApplications(db);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ status: 'interview', nextStep: 'Prepare for Thursday' });
  });

  it('gives an older sent attempt its row on start-up without touching failed history', () => {
    // Simulate attempts written before the tracker link existed.
    const sent = startAttempt('old-1', 'https://jobs.example.invalid/apply/old-1');
    workspace.updateApplicationAttempt(db, sent.id, {
      checkpoint: 'submitted',
      submittedAt: '2026-09-01T10:00:00.000Z',
      completionEvidence: 'receipt_confirmed',
    });
    const failed = startAttempt('old-2', 'https://jobs.example.invalid/apply/old-2');
    workspace.updateApplicationAttempt(db, failed.id, { checkpoint: 'failed', checkpointDetail: 'x' });
    db.run(sql`update application_attempts set application_id = null, application_detached = 0`);
    db.run(sql`delete from applications`);
    expect(workspace.listApplications(db)).toHaveLength(0);

    workspace.reconcileApplicationRows(db);

    const rows = workspace.listApplications(db);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ status: 'applied', appliedAt: '2026-09-01T10:00:00.000Z' });
  });

  it('does not bring back a row the person deleted', () => {
    seedSavedJob();
    const attempt = startAttempt();
    const [row] = workspace.listApplications(db);
    workspace.deleteApplication(db, row!.id);

    workspace.updateApplicationAttempt(db, attempt.id, { checkpoint: 'ready' });
    workspace.reconcileApplicationRows(db);

    expect(workspace.listApplications(db)).toHaveLength(0);
  });

  it('counts review work and scheduled sends from the stored attempts (#445)', () => {
    const a = startAttempt('v-a', 'https://jobs.example.invalid/apply/a');
    const b = startAttempt('v-b', 'https://jobs.example.invalid/apply/b');
    const c = startAttempt('v-c', 'https://jobs.example.invalid/apply/c');
    expect(workspace.getCounts(db)).toMatchObject({ needsReview: 0, scheduledSubmissions: 0 });

    workspace.updateApplicationAttempt(db, a.id, { checkpoint: 'ready' });
    workspace.updateApplicationAttempt(db, b.id, { checkpoint: 'needs_user', checkpointDetail: 'a question' });
    workspace.updateApplicationAttempt(db, c.id, { checkpoint: 'ready', scheduledAutomaticSubmitAt: '2026-10-03T14:05:00.000Z' });
    expect(workspace.getCounts(db)).toMatchObject({ needsReview: 2, scheduledSubmissions: 1 });

    workspace.updateApplicationAttempt(db, c.id, { scheduledAutomaticSubmitAt: null });
    expect(workspace.getCounts(db)).toMatchObject({ needsReview: 3, scheduledSubmissions: 0 });
  });
});
