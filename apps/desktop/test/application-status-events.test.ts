// @vitest-environment node
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sql } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { classifySubmission } from '../electron/application-actions-core.js';
import { createWorkspaceDb, type WorkspaceDb } from '../electron/workspace/client.js';
import * as workspace from '../electron/workspace/repository.js';
import {
  attemptSyncAssertion,
  localCalendarDate,
  STATUS_EVENT_VERSION,
} from '../electron/workspace/application-status-event-store.js';
import type { ApplicationStatusEventRecord } from '../electron/workspace/types.js';
import { parseApplicationAttemptPatch, parseApplicationInput, parseApplicationPatch } from '../electron/workspace/validate.js';

/**
 * #708: dated, sourced status-change events. Real SQLite, no mocks: the properties under test are
 * that an event exists exactly when the stored status changed, that it says who asserted it, and that
 * a date is present only when the person typed one.
 */

let dir: string;
let db: WorkspaceDb;
let close: () => void;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ovr-status-events-'));
  ({ db, close } = createWorkspaceDb(dir));
});
afterEach(() => {
  close();
  rmSync(dir, { recursive: true, force: true });
});

const NOW = new Date(2026, 10, 16, 15, 30);

function readable(applicationId: string): ApplicationStatusEventRecord[] {
  return workspace.listApplicationStatusEvents(db, applicationId).map((entry) => {
    if (!entry.readable) throw new Error('unexpected unreadable entry');
    return entry;
  });
}

function hand(status: Parameters<typeof workspace.createApplication>[1]['status'] = 'preparing') {
  return workspace.createApplication(db, { role: 'Platform Engineer', company: 'Northwind', status }, NOW);
}

function startAttempt(vacancyKey = 'vac-1') {
  workspace.createSavedJob(db, { vacancyKey, role: 'Platform Engineer', company: 'Northwind', location: 'Remote', status: 'considering' });
  return workspace.createApplicationAttempt(db, {
    vacancyKey,
    canonicalUrl: `https://jobs.example.invalid/apply/${vacancyKey}`,
    company: 'Northwind',
    role: 'Platform Engineer',
    sourceCvContentHash: 'hash',
    jdSnapshotHash: 'jd',
  });
}

describe('status events from the person (#708)', () => {
  it('writes one user_set event per real change, with no date unless one was typed', () => {
    const app = hand();
    expect(workspace.listApplicationStatusEvents(db, app.id)).toEqual([]);

    workspace.updateApplication(db, app.id, { status: 'applied' }, NOW);
    const [event] = readable(app.id);
    expect(event).toEqual({
      readable: true,
      id: expect.any(String),
      applicationId: app.id,
      eventVersion: 1,
      fromStatus: 'preparing',
      toStatus: 'applied',
      source: 'user_set',
      via: 'application_edit',
      attemptId: null,
      evidence: null,
      occurredOn: null,
      observedAt: null,
      recordedAt: NOW.toISOString(),
    });
  });

  it('writes nothing for a save that keeps the status (the drawer always sends it) or for a retry', () => {
    const app = hand();
    workspace.updateApplication(db, app.id, { status: 'applied' }, NOW);
    workspace.updateApplication(db, app.id, { status: 'applied', notes: 'Edited notes' }, NOW);
    workspace.updateApplication(db, app.id, { status: 'applied' }, NOW);
    workspace.updateApplication(db, app.id, { notes: 'Only notes' }, NOW);
    expect(readable(app.id)).toHaveLength(1);
  });

  it('records a real back-and-forth as two changes, newest first', () => {
    const app = hand('applied');
    workspace.updateApplication(db, app.id, { status: 'interview' }, new Date(NOW.getTime() + 1));
    workspace.updateApplication(db, app.id, { status: 'applied' }, new Date(NOW.getTime() + 2));
    expect(readable(app.id).map((e) => [e.fromStatus, e.toStatus])).toEqual([
      ['interview', 'applied'],
      ['applied', 'interview'],
      [null, 'applied'],
    ]);
  });

  it('keeps a typed date on the event only: never on applied_at, and dropped when the status does not change', () => {
    const app = hand();
    const updated = workspace.updateApplication(db, app.id, { status: 'applied', statusOccurredOn: '2026-11-03' }, NOW);
    expect(updated.appliedAt).toBeNull();
    expect(readable(app.id)[0]).toMatchObject({ occurredOn: '2026-11-03', recordedAt: NOW.toISOString() });

    workspace.updateApplication(db, app.id, { status: 'applied', statusOccurredOn: '2026-11-04' }, NOW);
    expect(readable(app.id)).toHaveLength(1);
    expect(readable(app.id)[0]?.occurredOn).toBe('2026-11-03');
  });

  it('never defaults the date from applied_at or the recording time', () => {
    const app = hand();
    workspace.updateApplication(db, app.id, { status: 'applied', appliedAt: '2026-11-01T09:00:00.000Z' }, NOW);
    const [event] = readable(app.id);
    expect(event?.occurredOn).toBeNull();
    expect(event?.observedAt).toBeNull();
  });

  it('refuses a date later than today or an impossible one, and then changes nothing', () => {
    const app = hand();
    const tomorrow = localCalendarDate(new Date(NOW.getTime() + 24 * 3600 * 1000));
    expect(() => workspace.updateApplication(db, app.id, { status: 'applied', statusOccurredOn: tomorrow }, NOW)).toThrow(
      /later than today/,
    );
    expect(() => workspace.updateApplication(db, app.id, { status: 'applied', statusOccurredOn: '2026-02-30' }, NOW)).toThrow(
      /calendar date/,
    );
    expect(workspace.listApplications(db)[0]?.status).toBe('preparing');
    expect(workspace.listApplicationStatusEvents(db, app.id)).toEqual([]);

    // Today itself is allowed.
    workspace.updateApplication(db, app.id, { status: 'applied', statusOccurredOn: localCalendarDate(NOW) }, NOW);
    expect(readable(app.id)[0]?.occurredOn).toBe(localCalendarDate(NOW));
  });

  it('validates the date at the IPC boundary', () => {
    expect(parseApplicationPatch({ statusOccurredOn: '2026-11-03' })).toEqual({ statusOccurredOn: '2026-11-03' });
    expect(parseApplicationPatch({ statusOccurredOn: null })).toEqual({ statusOccurredOn: null });
    expect(() => parseApplicationPatch({ statusOccurredOn: '3 Nov 2026' })).toThrow(/calendar date/);
    expect(() => parseApplicationPatch({ statusOccurredOn: '2026-13-01' })).toThrow(/calendar date/);
    expect(parseApplicationInput({ role: 'R', company: 'C' }).statusOccurredOn).toBeNull();
  });

  it('stores a rejection as the status the person set, with nothing else', () => {
    const app = hand('applied');
    workspace.updateApplication(db, app.id, { status: 'rejected' }, NOW);
    const raw = db.all<Record<string, unknown>>(sql`select * from application_status_events where to_status = 'rejected'`);
    expect(raw).toHaveLength(1);
    expect(Object.keys(raw[0]!).sort()).toEqual(
      [
        'application_id',
        'attempt_id',
        'event_version',
        'evidence',
        'from_status',
        'id',
        'observed_at',
        'occurred_on',
        'recorded_at',
        'source',
        'to_status',
        'via',
      ].sort(),
    );
    expect(raw[0]).toMatchObject({ source: 'user_set', evidence: null, occurred_on: null });
  });

  it('writes the status and its event together, or neither', () => {
    const app = hand();
    db.run(sql`drop table application_status_events`);
    expect(() => workspace.updateApplication(db, app.id, { status: 'applied' }, NOW)).toThrow();
    expect(workspace.listApplications(db)[0]?.status).toBe('preparing');
  });
});

describe('status events on create (#708)', () => {
  it('writes none for a default Preparing row', () => {
    const app = hand();
    expect(workspace.listApplicationStatusEvents(db, app.id)).toEqual([]);
  });

  it('writes one event from nothing when the person creates a row with a status', () => {
    const app = workspace.createApplication(
      db,
      { role: 'Platform Engineer', company: 'Northwind', status: 'interview', statusOccurredOn: '2026-11-10' },
      NOW,
    );
    expect(readable(app.id)).toEqual([
      expect.objectContaining({ fromStatus: null, toStatus: 'interview', source: 'user_set', via: 'application_create', occurredOn: '2026-11-10' }),
    ]);
  });
});

describe('status events from the attempt sync (#708)', () => {
  it('records an observed receipt as app_observed, with the app\'s own time and no person date', () => {
    const attempt = startAttempt();
    workspace.updateApplicationAttempt(db, attempt.id, {
      checkpoint: 'submitted',
      submittedAt: '2026-10-02T14:05:00.000Z',
      completionEvidence: 'receipt_confirmed',
    });
    expect(readable(attempt.applicationId!)).toEqual([
      expect.objectContaining({
        fromStatus: 'preparing',
        toStatus: 'applied',
        source: 'app_observed',
        via: 'attempt_sync',
        attemptId: attempt.id,
        evidence: 'receipt_confirmed',
        occurredOn: null,
        observedAt: '2026-10-02T14:05:00.000Z',
      }),
    ]);
  });

  it('records a submission with no recorded evidence as app_observed / not_recorded', () => {
    const attempt = startAttempt();
    workspace.updateApplicationAttempt(db, attempt.id, { checkpoint: 'submitted', submittedAt: '2026-10-02T14:05:00.000Z' });
    expect(readable(attempt.applicationId!)).toEqual([
      expect.objectContaining({ source: 'app_observed', evidence: 'not_recorded', occurredOn: null }),
    ]);
  });

  it('keeps a person\'s "I sent it" report user_set even though the sync writes it', () => {
    const attempt = startAttempt();
    workspace.updateApplicationAttempt(db, attempt.id, {
      checkpoint: 'user_reported',
      checkpointDetail: 'I applied on their site',
      submittedAt: '2026-10-03T09:00:00.000Z',
      completionEvidence: 'user_reported',
    });
    const [event] = readable(attempt.applicationId!);
    expect(event).toMatchObject({
      source: 'user_set',
      via: 'attempt_sync',
      evidence: 'user_statement',
      occurredOn: null,
      observedAt: null,
    });
  });

  it('keeps a person report user_set when only the stored evidence says so (checkpoint submitted)', () => {
    // The renderer is the person: its `submitted` patch, with evidence omitted or explicitly null,
    // goes through the real IPC boundary and the sync, and must never be recorded as app_observed.
    for (const [key, raw] of [
      ['omitted', { checkpoint: 'submitted', submittedAt: '2026-10-04T09:00:00.000Z' }],
      ['null', { checkpoint: 'submitted', submittedAt: '2026-10-04T09:00:00.000Z', completionEvidence: null }],
    ] as const) {
      const attempt = startAttempt(`ui-${key}`);
      workspace.updateApplicationAttempt(db, attempt.id, parseApplicationAttemptPatch(raw));
      expect(readable(attempt.applicationId!), key).toEqual([
        expect.objectContaining({ source: 'user_set', evidence: 'user_statement', occurredOn: null, observedAt: null }),
      ]);
    }
    // And when the main process writes that combination directly.
    const direct = startAttempt('direct');
    workspace.updateApplicationAttempt(db, direct.id, { checkpoint: 'submitted', completionEvidence: 'user_reported' });
    expect(readable(direct.applicationId!)[0]).toMatchObject({ source: 'user_set', evidence: 'user_statement' });
  });

  it('treats any person report behind a submission as user_set', () => {
    expect(attemptSyncAssertion({ checkpoint: 'submitted', completionEvidence: 'user_reported', submittedAt: new Date() })).toEqual({
      source: 'user_set',
      evidence: 'user_statement',
      observedAt: null,
    });
    expect(attemptSyncAssertion({ checkpoint: 'submitted', completionEvidence: null, submittedAt: null })).toEqual({
      source: 'app_observed',
      evidence: 'not_recorded',
      observedAt: null,
    });
  });

  it('writes nothing for checkpoint moves that leave the row Preparing', () => {
    const attempt = startAttempt();
    for (const checkpoint of ['ready', 'needs_user', 'failed', 'submission_unknown', 'skipped'] as const) {
      workspace.updateApplicationAttempt(db, attempt.id, { checkpoint, checkpointDetail: 'because' });
    }
    expect(workspace.listApplicationStatusEvents(db, attempt.applicationId!)).toEqual([]);
  });

  it('writes exactly one event across repeated events and restart reconciles', () => {
    const attempt = startAttempt();
    workspace.updateApplicationAttempt(db, attempt.id, {
      checkpoint: 'submitted',
      submittedAt: '2026-10-02T14:05:00.000Z',
      completionEvidence: 'receipt_confirmed',
    });
    workspace.updateApplicationAttempt(db, attempt.id, { checkpointDetail: 'noted again' });
    workspace.reconcileApplicationRows(db);
    workspace.reconcileApplicationRows(db);
    expect(readable(attempt.applicationId!)).toHaveLength(1);
  });

  it('records a person moving a sent row back and the sync moving it forward again, as what happened', () => {
    const attempt = startAttempt();
    workspace.updateApplicationAttempt(db, attempt.id, {
      checkpoint: 'submitted',
      submittedAt: '2026-10-02T14:05:00.000Z',
      completionEvidence: 'receipt_confirmed',
    });
    // The sync stamps events with the real clock, so this one change uses it too: an injected
    // past date would sort the person's change before the sync event it actually followed.
    workspace.updateApplication(db, attempt.applicationId!, { status: 'preparing' });
    workspace.reconcileApplicationRows(db);
    expect(readable(attempt.applicationId!).map((e) => [e.source, e.fromStatus, e.toStatus])).toEqual([
      ['app_observed', 'preparing', 'applied'],
      ['user_set', 'applied', 'preparing'],
      ['app_observed', 'preparing', 'applied'],
    ]);
  });

  it('agrees with classifySubmission: unconfirmed, prepared and not_recorded rows never get a sync Applied event', () => {
    const cases = [
      { key: 'receipt', patch: { checkpoint: 'submitted', submittedAt: '2026-10-02T14:05:00.000Z', completionEvidence: 'receipt_confirmed' }, cls: 'receipt_backed', source: 'app_observed' },
      { key: 'reported', patch: { checkpoint: 'user_reported', completionEvidence: 'user_reported' }, cls: 'user_reported', source: 'user_set' },
      { key: 'unknown', patch: { checkpoint: 'submission_unknown', submittedAt: '2026-10-02T14:05:00.000Z' }, cls: 'unconfirmed', source: null },
      { key: 'ready', patch: { checkpoint: 'ready' }, cls: 'prepared', source: null },
    ] as const;
    for (const c of cases) {
      const attempt = startAttempt(c.key);
      workspace.updateApplicationAttempt(db, attempt.id, c.patch);
      const row = workspace.listApplications(db).find((r) => r.id === attempt.applicationId)!;
      expect(classifySubmission({ ...row, attempt: row.attempt ?? null }), c.key).toBe(c.cls);
      const syncApplied = readable(row.id).filter((e) => e.via === 'attempt_sync' && e.toStatus === 'applied');
      expect(syncApplied.map((e) => e.source), c.key).toEqual(c.source ? [c.source] : []);
    }

    // A hand-entered Preparing row (not_recorded) and one the person moved on (user_stated).
    const manual = hand();
    expect(classifySubmission({ ...manual, attempt: null })).toBe('not_recorded');
    expect(workspace.listApplicationStatusEvents(db, manual.id)).toEqual([]);
    const stated = workspace.updateApplication(db, manual.id, { status: 'applied' }, NOW);
    expect(classifySubmission({ ...stated, attempt: null })).toBe('user_stated');
    expect(readable(manual.id).map((e) => [e.source, e.via])).toEqual([['user_set', 'application_edit']]);
  });
});

describe('retention, reset and versions (#708)', () => {
  it('deletes the history with its application', () => {
    const app = hand('applied');
    workspace.deleteApplication(db, app.id);
    expect(db.all(sql`select id from application_status_events`)).toEqual([]);
  });

  it('is deleted and counted by Reset application data', () => {
    const a = hand('applied');
    workspace.updateApplication(db, a.id, { status: 'interview' }, NOW);
    hand('offer');
    const result = workspace.resetApplicationData(db);
    expect(result.deleted.applicationStatusEvents).toBe(3);
    expect(db.all(sql`select id from application_status_events`)).toEqual([]);
  });

  it('returns an event from a newer version as unreadable, without reinterpreting it', () => {
    const app = hand('applied');
    db.run(sql`update application_status_events set event_version = ${STATUS_EVENT_VERSION + 1}, source = 'something_new'`);
    expect(workspace.listApplicationStatusEvents(db, app.id)).toEqual([
      { readable: false, id: expect.any(String), applicationId: app.id, eventVersion: 2, recordedAt: NOW.toISOString() },
    ]);
  });
});
