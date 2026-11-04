// @vitest-environment node
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sql } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createWorkspaceDb, type WorkspaceDb } from '../electron/workspace/client.js';
import * as store from '../electron/workspace/blind-apply-store.js';
import { blindApplyEvents } from '../electron/workspace/schema.js';
import * as workspace from '../electron/workspace/repository.js';

let dir: string;
let db: WorkspaceDb;
let close: () => void;

const GATE = {
  family: 'frontend',
  filters: 'eligible',
  linkStatus: 'verified',
  policyId: 'ashby-fixture-test-only',
  livenessStatus: 'open',
  livenessVerificationId: null,
  duplicateCheck: 'clear',
} as const;

function authorize() {
  return store.createBlindApplyAuthorization(db, {
    roleFamilies: ['frontend'],
    filtersSnapshot: { remote: 'global' },
    filtersHash: 'f-hash',
    profileVersion: 'candidate-profile-v1',
    sourceCvId: null,
    sourceCvContentHash: 'cv-hash',
    useSavedAnswers: true,
    policyIds: ['ashby-fixture-test-only'],
    confirmTextHash: 'text-hash',
  });
}

function item(authorizationId: string, vacancyKey: string, identityKey = `id-${vacancyKey}`, state: store.BlindApplyItemState = 'queued') {
  return store.insertBlindApplyItem(db, {
    authorizationId,
    vacancyKey,
    identityKey,
    company: 'Northwind',
    role: 'Frontend Engineer',
    applyUrl: `https://example.invalid/${vacancyKey}`,
    policyId: 'ashby-fixture-test-only',
    state,
    gateEvidence: GATE,
  });
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ovr-blind-store-'));
  ({ db, close } = createWorkspaceDb(dir));
});

afterEach(() => {
  close();
  rmSync(dir, { recursive: true, force: true });
});

describe('Blind Apply authorizations', () => {
  it('has one active authorization, and a stop is idempotent and never rewrites the first stop', () => {
    const first = authorize();
    expect(store.getActiveBlindApplyAuthorization(db)?.id).toBe(first.id);
    expect(store.isBlindApplyAuthorizationActive(db, first.id)).toBe(true);

    expect(store.stopBlindApplyAuthorization(db, first.id, 'you pressed Stop', new Date('2026-11-04T10:00:00Z'))).toBe(true);
    expect(store.stopBlindApplyAuthorization(db, first.id, 'a later reason', new Date('2026-11-04T11:00:00Z'))).toBe(false);

    const stopped = store.getBlindApplyAuthorization(db, first.id)!;
    expect(stopped.stoppedAt).toBe('2026-11-04T10:00:00.000Z');
    expect(stopped.stopReason).toBe('you pressed Stop');
    expect(store.getActiveBlindApplyAuthorization(db)).toBeNull();
    expect(store.isBlindApplyAuthorizationActive(db, first.id)).toBe(false);
  });

  it('a newer confirmation supersedes the old one without deleting it', () => {
    const first = authorize();
    const second = authorize();
    expect(store.getActiveBlindApplyAuthorization(db)?.id).toBe(second.id);
    expect(store.getBlindApplyAuthorization(db, first.id)?.stopReason).toBe('replaced by a newer confirmation');
  });

  it('has no cap, quota or counter column anywhere in the Blind Apply tables', () => {
    const tables = db.all<{ name: string }>(sql.raw(`SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'blind_apply_%'`));
    expect(tables.length).toBe(4);
    for (const table of tables) {
      const columns = db.all<{ name: string }>(sql.raw(`SELECT name FROM pragma_table_info('${table.name}')`)).map((c) => c.name);
      expect(columns.filter((name) => /cap|limit|quota|per_day|daily|max_/.test(name)), table.name).toEqual([]);
    }
  });
});

describe('Blind Apply items', () => {
  it('evaluates a vacancy once per authorization, so selection is idempotent', () => {
    const auth = authorize();
    const first = item(auth.id, 'vac-1');
    const again = item(auth.id, 'vac-1');
    expect(first.created).toBe(true);
    expect(again.created).toBe(false);
    expect(again.item.id).toBe(first.item.id);
    expect(store.listBlindApplyItems(db, { authorizationId: auth.id })).toHaveLength(1);
    expect(store.listBlindApplyEvents(db, first.item.id)).toHaveLength(1);
  });

  it('refuses a second live item for the same employer-and-role identity', () => {
    const auth = authorize();
    item(auth.id, 'vac-1', 'same-identity');
    expect(() => item(auth.id, 'vac-2', 'same-identity')).toThrow(store.BlindApplyDuplicateItemError);
    // A skipped record for that identity is not a reason to refuse.
    expect(item(auth.id, 'vac-3', 'same-identity', 'skipped').created).toBe(true);
    expect(store.findIdentityBlockingBlindApplyItem(db, 'same-identity')?.vacancyKey).toBe('vac-1');
  });

  it('compare-and-set: the loser of a race writes nothing', () => {
    const auth = authorize();
    const { item: created } = item(auth.id, 'vac-1');

    const winner = store.transitionBlindApplyItem(db, created.id, ['queued'], 'preparing', {}, { kind: 'prepare', detail: 'started' });
    expect(winner?.state).toBe('preparing');

    // A second writer that still believes the item is queued.
    const loser = store.transitionBlindApplyItem(db, created.id, ['queued'], 'stopped', {}, { kind: 'stop', detail: 'late' });
    expect(loser).toBeNull();
    expect(store.getBlindApplyItem(db, created.id)?.state).toBe('preparing');
    expect(store.listBlindApplyEvents(db, created.id).map((event) => event.toState)).toEqual(['queued', 'preparing']);
  });

  it('a terminal item can never be moved again, even by naming its own state as expected', () => {
    const auth = authorize();
    const { item: created } = item(auth.id, 'vac-1');
    store.transitionBlindApplyItem(db, created.id, ['queued'], 'preparing', {}, { kind: 'prepare' });
    store.transitionBlindApplyItem(db, created.id, ['preparing'], 'submitted', {}, { kind: 'receipt', receiptId: 'r1' });

    expect(store.transitionBlindApplyItem(db, created.id, ['submitted'], 'stopped', {}, { kind: 'stop' })).toBeNull();
    expect(store.transitionBlindApplyItem(db, created.id, ['preparing', 'submitted'], 'stopped', {}, { kind: 'stop' })).toBeNull();
    expect(store.getBlindApplyItem(db, created.id)?.state).toBe('submitted');
  });

  it('clears a stale intervention on the next transition and keeps the needs-an-answer fields as data', () => {
    const auth = authorize();
    const { item: created } = item(auth.id, 'vac-1');
    store.transitionBlindApplyItem(db, created.id, ['queued'], 'preparing', {}, { kind: 'prepare' });
    const waiting = store.transitionBlindApplyItem(
      db,
      created.id,
      ['preparing'],
      'needs_answer',
      { missingFields: [{ label: 'Preferred work arrangement', controlType: 'select', options: ['Remote', 'Hybrid'] }] },
      { kind: 'prepare', detail: 'one answer needed' },
    );
    expect(waiting?.missingFields?.[0]?.label).toBe('Preferred work arrangement');
    const queued = store.transitionBlindApplyItem(db, created.id, ['needs_answer'], 'queued', {}, { kind: 'user_action' });
    expect(queued?.missingFields).toBeNull();
    expect(queued?.intervention).toBeNull();
  });

  it('links an item to its attempt and a full reset removes the whole Blind Apply record', () => {
    const auth = authorize();
    const attempt = workspace.createApplicationAttempt(db, {
      vacancyKey: 'vac-1',
      canonicalUrl: 'https://example.invalid/vac-1',
      company: 'Northwind',
      role: 'Frontend Engineer',
      sourceCvContentHash: 'h',
      jdSnapshotHash: 'h',
      checkpoint: 'queued',
    });
    const { item: created } = item(auth.id, 'vac-1');
    store.transitionBlindApplyItem(db, created.id, ['queued'], 'preparing', { attemptId: attempt.id }, { kind: 'prepare' });
    expect(store.getBlindApplyItemByAttempt(db, attempt.id)?.id).toBe(created.id);

    const result = workspace.resetApplicationData(db);
    expect(result.deleted).toMatchObject({ blindApplyAuthorizations: 1, blindApplyItems: 1, blindApplyEvents: 2 });
    expect(store.listBlindApplyItems(db)).toEqual([]);
    expect(db.select().from(blindApplyEvents).all()).toEqual([]);
  });
});

describe('Blind Apply events', () => {
  it('are append-only: the store exposes no update or delete for events', () => {
    const exported = Object.keys(store);
    expect(exported.filter((name) => /Event/.test(name)).sort()).toEqual(['appendBlindApplyEvent', 'listBlindApplyEvents']);
  });

  it('appending an event records provenance without changing the item state', () => {
    const auth = authorize();
    const { item: created } = item(auth.id, 'vac-1');
    store.appendBlindApplyEvent(db, created.id, 'queued', {
      kind: 'answer_used',
      answers: [{ label: 'Full name', provenance: 'cv' }],
    });
    expect(store.getBlindApplyItem(db, created.id)?.state).toBe('queued');
    const events = store.listBlindApplyEvents(db, created.id);
    expect(events.at(-1)).toMatchObject({ kind: 'answer_used', answers: [{ label: 'Full name', provenance: 'cv' }] });
  });
});

describe('remembered Blind Apply answers', () => {
  it('matches a text answer by exact normalized label and control type only', () => {
    store.saveBlindApplyAnswer(db, { label: 'Current location', controlType: 'text', answer: 'Lisbon', optionSetHash: null });
    expect(store.findBlindApplyAnswer(db, store.blindAnswerKey('  current LOCATION ', 'text', null))?.answer).toBe('Lisbon');
    expect(store.findBlindApplyAnswer(db, store.blindAnswerKey('Where are you based?', 'text', null))).toBeNull();
    expect(store.findBlindApplyAnswer(db, store.blindAnswerKey('Current location', 'textarea', null))).toBeNull();
  });

  it('a select answer is tied to the exact option set, so changed choices ask again', () => {
    const before = store.optionSetHashOf(['Remote', 'Hybrid', 'On-site']);
    store.saveBlindApplyAnswer(db, { label: 'Preferred work arrangement', controlType: 'select', answer: 'Remote', optionSetHash: before });
    expect(store.optionSetHashOf(['On-site', 'Remote', 'Hybrid'])).toBe(before);
    expect(store.findBlindApplyAnswer(db, store.blindAnswerKey('Preferred work arrangement', 'select', before))?.answer).toBe('Remote');
    const changed = store.optionSetHashOf(['Remote', 'Hybrid', 'On-site', 'Anywhere']);
    expect(store.findBlindApplyAnswer(db, store.blindAnswerKey('Preferred work arrangement', 'select', changed))).toBeNull();
  });

  it('saving the same question again replaces its answer rather than adding a second row', () => {
    store.saveBlindApplyAnswer(db, { label: 'Notice period', controlType: 'text', answer: '1 month', optionSetHash: null });
    store.saveBlindApplyAnswer(db, { label: 'Notice  period', controlType: 'text', answer: '2 months', optionSetHash: null });
    expect(store.findBlindApplyAnswer(db, store.blindAnswerKey('notice period', 'text', null))?.answer).toBe('2 months');
  });
});
