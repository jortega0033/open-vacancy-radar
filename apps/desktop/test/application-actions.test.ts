// @vitest-environment node
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApplicationActionsHandlers } from '../electron/application-actions-ipc.js';
import { parseActionsResult, parseOverviewResult, type ActionsResult, type ActionsView } from '../electron/application-actions-types.js';
import { ApplicationDataResetGate } from '../electron/application-data-reset-gate.js';
import { createWorkspaceDb, type WorkspaceDb } from '../electron/workspace/client.js';
import * as workspace from '../electron/workspace/repository.js';
import { applicationActions, applications } from '../electron/workspace/schema.js';
import { recordUserReportedSubmission } from '../electron/application-review-session.js';

/**
 * #692 at the boundaries a person's data crosses: the REAL IPC handlers (strict input parsing, the
 * preload's result rebuild) in front of the real service and a real MIGRATED SQLite file that is closed
 * and reopened to prove restart. Synthetic applications only; nothing here can reach a model or a network.
 */

let dir: string;
let db: WorkspaceDb;
let closeDb: () => void;
let nowMs: number;
const gate = new ApplicationDataResetGate();
let n = 0;
const rid = (): string => `request-${String(++n).padStart(6, '0')}`;

function open(): void {
  ({ db, close: closeDb } = createWorkspaceDb(dir));
}

function handlers() {
  return createApplicationActionsHandlers(async () => ({ db, now: () => new Date(nowMs), mutate: (task) => gate.runMutation(task) }));
}

/** Runs a channel exactly as the renderer does: JSON in, the preload's rebuild out. */
async function call(channel: string, payload: unknown): Promise<ActionsResult> {
  const raw = await handlers()[channel]!(JSON.parse(JSON.stringify(payload)));
  return parseActionsResult(JSON.parse(JSON.stringify(raw)));
}

const okView = (result: ActionsResult): ActionsView => {
  if (!result.ok) throw new Error(`expected ok, got ${result.code}: ${result.message}`);
  return result.view;
};

const DUE_DAY = { kind: 'date' as const, date: '2026-11-06', timeZone: 'Europe/Amsterdam' };
const DUE_TIME = { kind: 'datetime' as const, local: '2026-11-06T09:30', timeZone: 'Europe/Amsterdam' };
const FIELDS = { kind: 'follow_up' as const, title: 'Ask about timing', note: 'Mention the portfolio link', channel: 'email' as const, contactDetail: 'recruiter@example.test' };

function create(applicationId: string, over: Record<string, unknown> = {}) {
  return call('application-actions:create', { applicationId, requestId: rid(), fields: FIELDS, due: DUE_DAY, origin: 'user', ...over });
}

const NEXT_STEP = '  Call Priya on Tuesday – bring the Q3 numbers\n(and the café receipt)  ';
const NOTES = 'Line one\r\nLine two with trailing spaces   \n\n\tTabbed \u{1F680} unicode — done.\n';

function handTracked(over: Partial<Parameters<typeof workspace.createApplication>[1]> = {}): string {
  return workspace.createApplication(db, {
    role: 'Platform Engineer',
    company: 'Fabrikam',
    status: 'applied',
    appliedAt: '2026-10-12T09:00:00.000Z',
    nextStep: NEXT_STEP,
    notes: NOTES,
    ...over,
  }).id;
}

/** A row made by the real pipeline tables: an attempt moved to a checkpoint, linked to its Applications row. */
function viaAttempt(checkpoint: Parameters<typeof workspace.updateApplicationAttempt>[2]['checkpoint'], extra: Record<string, unknown> = {}): string {
  n += 1;
  const attempt = workspace.createApplicationAttempt(db, {
    vacancyKey: `vac-${n}`,
    canonicalUrl: `https://jobs.example.test/${n}`,
    company: 'Contoso',
    role: `Engineer ${n}`,
    sourceCvContentHash: 'a'.repeat(64),
    jdSnapshotHash: 'b'.repeat(64),
    checkpoint: 'queued',
  });
  workspace.updateApplicationAttempt(db, attempt.id, { checkpoint, ...extra });
  const linked = workspace.getApplicationAttempt(db, attempt.id).applicationId;
  if (!linked) throw new Error('the attempt did not link an Applications row');
  return linked;
}

const rawRow = (id: string) => db.select().from(applications).all().find((row) => row.id === id)!;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ovr-application-actions-'));
  nowMs = Date.parse('2026-11-02T10:00:00Z');
  open();
});

afterEach(() => {
  closeDb();
  rmSync(dir, { recursive: true, force: true });
});

describe('lifecycle through the real handlers and a migrated database', () => {
  it('creates a date action and a timed action with explicit zone semantics, open and ordered by due', async () => {
    const id = handTracked();
    const day = okView(await create(id));
    const timed = okView(await create(id, { due: { kind: 'datetime', local: '2026-11-03T09:30', timeZone: 'America/New_York' }, fields: { ...FIELDS, title: 'Call', channel: 'phone' } }));
    expect(day.actions).toHaveLength(1);
    expect(timed.actions.map((action) => action.title)).toEqual(['Call', 'Ask about timing']);
    const [call1, call2] = timed.actions;
    expect(call1).toMatchObject({
      state: 'open',
      origin: 'user',
      channel: 'phone',
      dueKind: 'datetime',
      dueLocal: '2026-11-03T09:30',
      dueTimeZone: 'America/New_York',
      dueUtcOffsetMinutes: -300,
      dueAt: '2026-11-03T14:30:00.000Z',
      version: 1,
      rescheduleCount: 0,
      completedAt: null,
      dismissedAt: null,
      basisClass: 'user_stated',
    });
    expect(call2).toMatchObject({ dueKind: 'date', dueDate: '2026-11-06', dueLocal: null, dueUtcOffsetMinutes: null, dueAt: '2026-11-06T23:00:00.000Z' });
    expect(call2!.createdAt).toBe('2026-11-02T10:00:00.000Z');
  });

  it('reschedules, completes and dismisses, keeping history and counting reschedules', async () => {
    const id = handTracked();
    const created = okView(await create(id));
    const action = created.actions[0]!;

    nowMs += 60_000;
    const moved = okView(await call('application-actions:reschedule', { applicationId: id, actionId: action.id, expectedVersion: 1, due: DUE_TIME }));
    expect(moved.actions[0]).toMatchObject({ version: 2, rescheduleCount: 1, dueKind: 'datetime', dueAt: '2026-11-06T08:30:00.000Z', firstDueAt: action.firstDueAt });
    // Rescheduling moves the due moment only; the action's own fields stay as they were.
    expect(moved.actions[0]).toMatchObject({ title: 'Ask about timing', channel: 'email', contactDetail: 'recruiter@example.test' });

    nowMs += 60_000;
    const done = okView(await call('application-actions:complete', { applicationId: id, actionId: action.id, expectedVersion: 2 }));
    expect(done.actions[0]).toMatchObject({ state: 'completed', completedAt: '2026-11-02T10:02:00.000Z', dismissedAt: null, version: 3 });

    const second = okView(await create(id, { fields: { ...FIELDS, title: 'Thank them' } }));
    const open = second.actions.find((entry) => entry.title === 'Thank them')!;
    nowMs += 60_000;
    const dismissed = okView(await call('application-actions:dismiss', { applicationId: id, actionId: open.id, expectedVersion: 1 }));
    expect(dismissed.actions.map((entry) => [entry.title, entry.state])).toEqual([
      ['Thank them', 'dismissed'],
      ['Ask about timing', 'completed'],
    ]);
    expect(dismissed.actions[0]!.dismissedAt).toBe('2026-11-02T10:03:00.000Z');
  });

  it('edits the fields of an open action', async () => {
    const id = handTracked();
    const action = okView(await create(id)).actions[0]!;
    nowMs += 1000;
    const edited = okView(
      await call('application-actions:update', {
        applicationId: id,
        actionId: action.id,
        expectedVersion: 1,
        fields: { ...FIELDS, title: 'Ask about the next step', channel: 'linkedin', note: '' },
      }),
    );
    expect(edited.actions[0]).toMatchObject({ title: 'Ask about the next step', channel: 'linkedin', note: '', version: 2, rescheduleCount: 0 });
  });

  it('survives closing and reopening the database, and judges overdue from stored UTC only', async () => {
    const id = handTracked();
    await create(id, { due: { kind: 'datetime', local: '2026-11-03T09:30', timeZone: 'Europe/Amsterdam' } });
    const before = okView(await call('application-actions:get', { applicationId: id })).actions[0]!;
    closeDb();
    open();
    nowMs = Date.parse('2026-12-01T00:00:00Z');
    const after = okView(await call('application-actions:get', { applicationId: id })).actions[0]!;
    expect(after).toEqual(before);
    expect(after).toMatchObject({ dueTimeZone: 'Europe/Amsterdam', dueAt: '2026-11-03T08:30:00.000Z' });
    const overview = parseOverviewResult(await handlers()['application-actions:overview']!({}));
    expect(overview.ok && overview.items.find((item) => item.applicationId === id)?.openActions).toHaveLength(1);
  });
});

describe('free-text next step and notes are never touched', () => {
  it('every kind of action change leaves nextStep, notes, status and applied date byte-identical', async () => {
    const id = handTracked();
    const before = { ...rawRow(id) };
    const created = okView(await create(id)).actions[0]!;
    await call('application-actions:update', { applicationId: id, actionId: created.id, expectedVersion: 1, fields: { ...FIELDS, title: 'x' } });
    await call('application-actions:reschedule', { applicationId: id, actionId: created.id, expectedVersion: 2, due: DUE_TIME });
    await call('application-actions:set-suppressed', { applicationId: id, suppressed: true });
    await call('application-actions:complete', { applicationId: id, actionId: created.id, expectedVersion: 3 });
    const second = okView(await create(id)).actions.find((action) => action.state === 'open')!;
    await call('application-actions:dismiss', { applicationId: id, actionId: second.id, expectedVersion: 1 });

    const after = rawRow(id);
    expect(after).toEqual(before);
    expect(after.nextStep).toBe(NEXT_STEP);
    expect(after.notes).toBe(NOTES);
    expect(workspace.listApplications(db, 'all').find((row) => row.id === id)).toMatchObject({ status: 'applied', nextStep: NEXT_STEP, notes: NOTES });
  });

  it('a row with no actions is still a plain row: nothing is invented for legacy data', async () => {
    const id = handTracked();
    const view = okView(await call('application-actions:get', { applicationId: id }));
    expect(view.actions).toEqual([]);
    expect(db.select().from(applicationActions).all()).toEqual([]);
    expect(rawRow(id).nextStep).toBe(NEXT_STEP);
  });
});

describe('retries, stale forms and concurrency', () => {
  it('a retried create (same request id) returns the same action and writes no second row', async () => {
    const id = handTracked();
    const requestId = rid();
    const first = await create(id, { requestId });
    const retry = await create(id, { requestId });
    expect(first.ok && retry.ok).toBe(true);
    if (!first.ok || !retry.ok) return;
    expect(first.unchanged).toBe(false);
    expect(retry.unchanged).toBe(true);
    expect(retry.actionId).toBe(first.actionId);
    expect(db.select().from(applicationActions).all()).toHaveLength(1);
  });

  it('a NEW request with identical content is a new intent and honestly creates a second action', async () => {
    const id = handTracked();
    await create(id);
    await create(id);
    expect(db.select().from(applicationActions).all()).toHaveLength(2);
  });

  it('repeating complete or dismiss changes nothing and keeps the first timestamps; the opposite is refused', async () => {
    const id = handTracked();
    const action = okView(await create(id)).actions[0]!;
    nowMs += 1000;
    await call('application-actions:complete', { applicationId: id, actionId: action.id, expectedVersion: 1 });
    nowMs += 5000;
    const retry = await call('application-actions:complete', { applicationId: id, actionId: action.id, expectedVersion: 1 });
    expect(retry.ok && retry.unchanged).toBe(true);
    expect(okView(retry).actions[0]).toMatchObject({ state: 'completed', completedAt: '2026-11-02T10:00:01.000Z', version: 2 });
    const opposite = await call('application-actions:dismiss', { applicationId: id, actionId: action.id, expectedVersion: 2 });
    expect(opposite).toMatchObject({ ok: false, code: 'not_open' });
    expect(!opposite.ok && opposite.view?.actions[0]?.state).toBe('completed');
  });

  it('a retried reschedule is a no-op, even from a stale form, and is not counted twice', async () => {
    const id = handTracked();
    const action = okView(await create(id)).actions[0]!;
    const payload = { applicationId: id, actionId: action.id, expectedVersion: 1, due: DUE_TIME };
    const first = await call('application-actions:reschedule', payload);
    const retry = await call('application-actions:reschedule', payload);
    expect(first.ok && !first.unchanged).toBe(true);
    expect(retry.ok && retry.unchanged).toBe(true);
    expect(okView(retry).actions[0]).toMatchObject({ version: 2, rescheduleCount: 1 });
  });

  it('a stale edit never overwrites a newer one', async () => {
    const id = handTracked();
    const action = okView(await create(id)).actions[0]!;
    await call('application-actions:update', { applicationId: id, actionId: action.id, expectedVersion: 1, fields: { ...FIELDS, title: 'Newer title' } });
    const stale = await call('application-actions:update', { applicationId: id, actionId: action.id, expectedVersion: 1, fields: { ...FIELDS, title: 'Older form' } });
    expect(stale).toMatchObject({ ok: false, code: 'outdated' });
    expect(!stale.ok && stale.view?.actions[0]?.title).toBe('Newer title');
    const staleMove = await call('application-actions:reschedule', { applicationId: id, actionId: action.id, expectedVersion: 1, due: DUE_TIME });
    expect(staleMove).toMatchObject({ ok: false, code: 'outdated' });
  });

  it('concurrent complete and dismiss: exactly one wins, the other sees the real state', async () => {
    const id = handTracked();
    const action = okView(await create(id)).actions[0]!;
    const target = { applicationId: id, actionId: action.id, expectedVersion: 1 };
    const [complete, dismiss] = await Promise.all([call('application-actions:complete', target), call('application-actions:dismiss', target)]);
    expect([complete.ok, dismiss.ok].filter(Boolean)).toHaveLength(1);
    const final = db.select().from(applicationActions).all();
    expect(final).toHaveLength(1);
    expect(['completed', 'dismissed']).toContain(final[0]!.state);
    expect((final[0]!.completedAt === null) !== (final[0]!.dismissedAt === null)).toBe(true);
  });

  it('an action id from another application is not found, and cannot be moved', async () => {
    const a = handTracked();
    const b = handTracked({ company: 'Other' });
    const action = okView(await create(a)).actions[0]!;
    const crossed = await call('application-actions:complete', { applicationId: b, actionId: action.id, expectedVersion: 1 });
    expect(crossed).toMatchObject({ ok: false, code: 'not_found' });
    expect(db.select().from(applicationActions).all()[0]!.state).toBe('open');
  });
});

describe('invalid dates and times are refused at the boundary and nothing is written', () => {
  it('names the problem for a nonexistent local time and for an ambiguous one, and takes the person’s choice', async () => {
    const id = handTracked();
    const gap = await create(id, { due: { kind: 'datetime', local: '2026-03-29T02:30', timeZone: 'Europe/Amsterdam' } });
    expect(gap).toMatchObject({ ok: false, code: 'invalid_due', dueIssue: 'nonexistent_local_time', dueOptions: [] });

    const fold = await create(id, { due: { kind: 'datetime', local: '2026-10-25T02:30', timeZone: 'Europe/Amsterdam' } });
    expect(fold).toMatchObject({ ok: false, code: 'invalid_due', dueIssue: 'ambiguous_local_time' });
    expect(!fold.ok && fold.dueOptions).toEqual([
      { choice: 'earlier', instant: '2026-10-25T00:30:00.000Z', offsetMinutes: 120 },
      { choice: 'later', instant: '2026-10-25T01:30:00.000Z', offsetMinutes: 60 },
    ]);
    expect(db.select().from(applicationActions).all()).toEqual([]);

    const chosen = okView(await create(id, { due: { kind: 'datetime', local: '2026-10-25T02:30', timeZone: 'Europe/Amsterdam', ambiguity: 'later' } })).actions[0]!;
    expect(chosen).toMatchObject({ dueAt: '2026-10-25T01:30:00.000Z', dueUtcOffsetMinutes: 60, dueResolution: 'later' });
  });

  it('rejects impossible dates, bad zones and malformed or hostile requests without a write', async () => {
    const id = handTracked();
    const bad = [
      { due: { kind: 'date', date: '2026-02-30', timeZone: 'UTC' } },
      { due: { kind: 'date', date: '2026-11-06', timeZone: 'CET' } },
      { due: { kind: 'date', date: '2026-11-06', timeZone: '+02:00' } },
      { due: { kind: 'datetime', local: '2026-11-06T09:30:00Z', timeZone: 'UTC' } },
      { due: { kind: 'datetime', local: '2026-11-06T09:30', timeZone: 'UTC', extra: 1 } },
      { due: { kind: 'date', date: '1999-01-01', timeZone: 'UTC' } },
      { fields: { ...FIELDS, title: 'x'.repeat(121) } },
      { fields: { ...FIELDS, kind: 'send_email' } },
      { fields: { ...FIELDS, channel: 'smoke_signal' } },
      { origin: 'automatic' },
      { requestId: 'short' },
      { applicationId: '' },
      { unexpected: true },
    ];
    for (const patch of bad) {
      const result = await create(id, patch);
      expect(result.ok, JSON.stringify(patch)).toBe(false);
    }
    expect(db.select().from(applicationActions).all()).toEqual([]);
    expect(await call('application-actions:complete', { applicationId: id, actionId: 'a', expectedVersion: 0 })).toMatchObject({ ok: false, code: 'invalid_request' });
    expect(await call('application-actions:get', 'nope')).toMatchObject({ ok: false, code: 'invalid_request' });
  });

  it('an application that is gone is reported plainly', async () => {
    expect(await create('missing-application')).toMatchObject({ ok: false, code: 'not_found' });
    expect(await call('application-actions:get', { applicationId: 'missing-application' })).toMatchObject({ ok: false, code: 'not_found' });
  });

  it('keeps at most 100 actions per application', async () => {
    const id = handTracked();
    for (let i = 0; i < 100; i += 1) expect((await create(id)).ok).toBe(true);
    expect(await create(id)).toMatchObject({ ok: false, code: 'limit' });
  });
});

describe('suggestions follow what is actually recorded', () => {
  async function suggestion(id: string) {
    return okView(await call('application-actions:get', { applicationId: id })).suggestion;
  }

  it('offers a follow-up only for a recorded-sent, still-applied, live application', async () => {
    expect(await suggestion(handTracked())).toMatchObject({ eligible: true, reason: 'eligible' });

    const reported = viaAttempt('ready');
    expect(recordUserReportedSubmission(db, workspace.getApplicationAttempt(db, workspace.listApplicationAttempts(db).find((a) => a.applicationId === reported)!.id).id)).toEqual({ ok: true });
    const reportedView = okView(await call('application-actions:get', { applicationId: reported }));
    expect(reportedView.application.submissionClass).toBe('user_reported');
    expect(reportedView.suggestion.eligible).toBe(true);
  });

  it('draft, preparing, ready, failed and unconfirmed rows are not unanswered submissions', async () => {
    for (const checkpoint of ['queued', 'tailoring', 'ready', 'needs_user', 'failed'] as const) {
      const view = okView(await call('application-actions:get', { applicationId: viaAttempt(checkpoint) }));
      expect(view.suggestion, checkpoint).toMatchObject({ eligible: false, reason: 'not_submitted' });
      expect(view.application.submissionClass, checkpoint).toBe('prepared');
    }
    const unknown = okView(await call('application-actions:get', { applicationId: viaAttempt('submission_unknown', { submittedAt: '2026-10-12T09:00:00.000Z' }) }));
    expect(unknown.suggestion).toMatchObject({ eligible: false, reason: 'unknown_submission' });
    const manualDraft = okView(await call('application-actions:get', { applicationId: handTracked({ status: 'preparing', appliedAt: null }) }));
    expect(manualDraft.suggestion).toMatchObject({ eligible: false, reason: 'not_submitted' });
    expect(manualDraft.application.submissionClass).toBe('not_recorded');
  });

  it('quiet is not rejection: no status, summary or line ever claims it, and the status is left alone', async () => {
    const id = handTracked({ appliedAt: '2025-01-01T09:00:00.000Z' });
    const view = okView(await call('application-actions:get', { applicationId: id }));
    expect(view.suggestion.line).toContain('no record of a reply');
    expect(view.suggestion.line).not.toMatch(/reject|ghost|no response from|declin/i);
    expect(rawRow(id).status).toBe('applied');
  });

  it('terminal outcomes stop suggestions but keep every action and record', async () => {
    const id = handTracked();
    const action = okView(await create(id)).actions[0]!;
    workspace.updateApplication(db, id, { status: 'rejected' });
    const view = okView(await call('application-actions:get', { applicationId: id }));
    expect(view.suggestion).toMatchObject({ eligible: false, reason: 'terminal' });
    expect(view.actions.map((entry) => entry.id)).toEqual([action.id]);
    // The person can still record an intentional action on a finished application.
    expect((await create(id, { fields: { ...FIELDS, kind: 'thank_you', title: 'Thank the panel' } })).ok).toBe(true);
    for (const status of ['offer', 'withdrawn'] as const) {
      workspace.updateApplication(db, id, { status });
      expect(okView(await call('application-actions:get', { applicationId: id })).suggestion.reason).toBe('terminal');
    }
  });

  it('a conversation in progress is not "no reply", and an open action already covers the follow-up', async () => {
    const interview = handTracked({ status: 'interview' });
    expect((await suggestion(interview)).reason).toBe('in_conversation');
    const id = handTracked();
    await create(id);
    expect((await suggestion(id)).reason).toBe('has_open_action');
  });

  it('the person can switch suggestions off and on; the switch is idempotent and kept across restart', async () => {
    const id = handTracked();
    const off = await call('application-actions:set-suppressed', { applicationId: id, suppressed: true });
    expect(okView(off).suppressed).toBe(true);
    expect((await call('application-actions:set-suppressed', { applicationId: id, suppressed: true })).ok).toBe(true);
    expect((await suggestion(id)).reason).toBe('suppressed');
    closeDb();
    open();
    expect((await suggestion(id)).reason).toBe('suppressed');
    // Suppressing hides the prompt only; a plan the person makes themselves still works.
    expect((await create(id)).ok).toBe(true);
    okView(await call('application-actions:set-suppressed', { applicationId: id, suppressed: false }));
    expect((await suggestion(id)).reason).toBe('has_open_action');
    expect(await call('application-actions:set-suppressed', { applicationId: 'missing', suppressed: true })).toMatchObject({ ok: false, code: 'not_found' });
  });

  it('records "suggestion accepted" only when the app really offered one', async () => {
    const eligible = handTracked();
    const accepted = okView(await create(eligible, { origin: 'suggestion_accepted' })).actions[0]!;
    expect(accepted.origin).toBe('suggestion_accepted');
    const finished = handTracked({ status: 'rejected' });
    const claimed = okView(await create(finished, { origin: 'suggestion_accepted' })).actions[0]!;
    expect(claimed.origin).toBe('user');
    const draftRow = handTracked({ status: 'preparing', appliedAt: null });
    expect(okView(await create(draftRow, { origin: 'suggestion_accepted' })).actions[0]!.origin).toBe('user');
  });
});

describe('overview', () => {
  it('lists every row with its open actions and whether a suggestion may be offered', async () => {
    const sent = handTracked();
    const prepared = viaAttempt('ready');
    await create(sent, { fields: { ...FIELDS, title: 'Done soon' } });
    const doneRow = handTracked({ company: 'Done Co' });
    const doneAction = okView(await create(doneRow)).actions[0]!;
    await call('application-actions:complete', { applicationId: doneRow, actionId: doneAction.id, expectedVersion: 1 });

    const overview = parseOverviewResult(await handlers()['application-actions:overview']!({}));
    if (!overview.ok) throw new Error('expected ok');
    const by = (id: string) => overview.items.find((item) => item.applicationId === id)!;
    expect(by(sent).openActions.map((action) => action.title)).toEqual(['Done soon']);
    expect(by(sent).suggestion.reason).toBe('has_open_action');
    expect(by(prepared)).toMatchObject({ openActions: [], suggestion: { eligible: false, reason: 'not_submitted' } });
    expect(by(doneRow).openActions).toEqual([]);
    expect(by(doneRow).suggestion.eligible).toBe(true);
  });
});

describe('deletion, retention and reset', () => {
  it('deleting an application removes its actions and switches; other applications keep theirs', async () => {
    const a = handTracked();
    const b = handTracked({ company: 'Keep Co' });
    await create(a);
    await create(b);
    await call('application-actions:set-suppressed', { applicationId: a, suppressed: true });
    workspace.deleteApplication(db, a);
    expect(db.select().from(applicationActions).all().map((row) => row.applicationId)).toEqual([b]);
    expect(await call('application-actions:get', { applicationId: a })).toMatchObject({ ok: false, code: 'not_found' });
  });

  it('the application data reset counts and removes every action and switch', async () => {
    const a = handTracked();
    await create(a);
    await create(a);
    await call('application-actions:set-suppressed', { applicationId: a, suppressed: true });
    const result = workspace.resetApplicationData(db);
    expect(result.deleted).toMatchObject({ applicationActions: 2, applicationActionPrefs: 1, followUpDrafts: 0 });
    expect(db.select().from(applicationActions).all()).toEqual([]);
  });

  it('writes are refused while a reset is running', async () => {
    const a = handTracked();
    let release!: () => void;
    const reset = gate.runReset(() => new Promise<void>((resolve) => (release = resolve)));
    await expect(create(a)).resolves.toMatchObject({ ok: false, code: 'failed' });
    release();
    await reset;
    expect((await create(a)).ok).toBe(true);
  });
});

describe('this feature stays local', () => {
  it('the action modules import no model, network, mailbox, calendar, notification or scheduler code', () => {
    for (const file of [
      'application-actions-core.ts',
      'application-actions-types.ts',
      'application-actions-service.ts',
      'application-actions-ipc.ts',
      'workspace/application-action-store.ts',
    ]) {
      const source = readFileSync(join(__dirname, '..', 'electron', file), 'utf8');
      expect(source, file).not.toMatch(/runTextGeneration|agent-dock|node:https?|node:net|\bfetch\(|XMLHttpRequest|googleapis|nodemailer|Notification|setInterval|node-cron|powerMonitor|autoLaunch|setLoginItemSettings/);
    }
  });
});
