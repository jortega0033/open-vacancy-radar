// @vitest-environment node
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { applicationAnswerKey } from '../electron/workspace/application-answer-key.js';
import { createWorkspaceDb, type WorkspaceDb } from '../electron/workspace/client.js';
import * as workspace from '../electron/workspace/repository.js';
import { WorkspaceNotFoundError } from '../electron/workspace/repository.js';

/**
 * #372's reusable application-answer library. Runs against a real migrated SQLite file, matching
 * `workspace-repository.test.ts`'s own harness, since the behavior worth testing here (the
 * upsert-on-save "one answer per key" rule) is a behavior of the schema plus these functions
 * together.
 */
let dir: string;
let db: WorkspaceDb;
let close: () => void;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ovr-workspace-answers-test-'));
  ({ db, close } = createWorkspaceDb(dir));
});

afterEach(() => {
  close();
  rmSync(dir, { recursive: true, force: true });
});

const ANSWER = {
  label: 'Why do you want to work here?',
  controlType: 'textarea' as const,
  answer: 'Because the mission genuinely matches what I want to work on.',
  originCompany: 'Redwood Software',
  originRole: 'Frontend Engineer',
};

describe('saveApplicationAnswer', () => {
  it('inserts a new row with a derived normalizedKey and stamped timestamps', () => {
    const saved = workspace.saveApplicationAnswer(db, ANSWER);
    expect(saved.id).toBeTruthy();
    expect(saved.normalizedKey).toBe(applicationAnswerKey(ANSWER.label, ANSWER.controlType));
    expect(saved.label).toBe(ANSWER.label);
    expect(saved.answer).toBe(ANSWER.answer);
    expect(typeof saved.createdAt).toBe('string');
    expect(new Date(saved.createdAt).valueOf()).not.toBeNaN();
    expect(saved.updatedAt).toBe(saved.createdAt);
    expect(saved.lastConfirmedAt).toBe(saved.createdAt);
    expect(workspace.listApplicationAnswers(db)).toEqual([saved]);
  });

  it('upserts in place for the same label+controlType: same row id, updated answer/timestamps', async () => {
    const first = workspace.saveApplicationAnswer(db, ANSWER);
    // A real clock tick so updatedAt/lastConfirmedAt are distinguishable from createdAt.
    await new Promise((resolve) => setTimeout(resolve, 5));

    const second = workspace.saveApplicationAnswer(db, {
      ...ANSWER,
      answer: 'Updated answer: the team and the mission both fit what I want next.',
      originCompany: 'Different Co',
      originRole: 'Senior Frontend Engineer',
    });

    expect(second.id).toBe(first.id);
    expect(second.normalizedKey).toBe(first.normalizedKey);
    expect(second.createdAt).toBe(first.createdAt);
    expect(second.answer).toBe('Updated answer: the team and the mission both fit what I want next.');
    expect(second.originCompany).toBe('Different Co');
    expect(second.originRole).toBe('Senior Frontend Engineer');
    expect(new Date(second.updatedAt).valueOf()).toBeGreaterThan(new Date(first.updatedAt).valueOf());
    expect(new Date(second.lastConfirmedAt).valueOf()).toBeGreaterThan(new Date(first.lastConfirmedAt).valueOf());

    expect(workspace.listApplicationAnswers(db)).toHaveLength(1);
  });

  it('creates a second, distinct row for a different label', () => {
    workspace.saveApplicationAnswer(db, ANSWER);
    workspace.saveApplicationAnswer(db, { ...ANSWER, label: 'Why do you want to work with us?' });
    expect(workspace.listApplicationAnswers(db)).toHaveLength(2);
  });

  it('creates a second, distinct row for the same label under a different control type', () => {
    workspace.saveApplicationAnswer(db, ANSWER);
    workspace.saveApplicationAnswer(db, { ...ANSWER, controlType: 'text' });
    const rows = workspace.listApplicationAnswers(db);
    expect(rows).toHaveLength(2);
    expect(new Set(rows.map((row) => row.controlType))).toEqual(new Set(['text', 'textarea']));
  });
});

describe('findApplicationAnswerByKey', () => {
  it('finds an exact normalized-key match regardless of incidental label formatting', () => {
    const saved = workspace.saveApplicationAnswer(db, ANSWER);
    const key = applicationAnswerKey('  WHY DO YOU WANT TO WORK HERE?  ', 'textarea');
    expect(workspace.findApplicationAnswerByKey(db, key)).toEqual(saved);
  });

  it('returns null for a key with no saved answer', () => {
    workspace.saveApplicationAnswer(db, ANSWER);
    expect(workspace.findApplicationAnswerByKey(db, applicationAnswerKey('Something else entirely', 'text'))).toBeNull();
  });
});

describe('updateApplicationAnswer', () => {
  it('changes the answer body and bumps updatedAt without touching normalizedKey/createdAt', async () => {
    const saved = workspace.saveApplicationAnswer(db, ANSWER);
    await new Promise((resolve) => setTimeout(resolve, 5));

    const updated = workspace.updateApplicationAnswer(db, saved.id, { answer: 'A rewritten answer.' });

    expect(updated.answer).toBe('A rewritten answer.');
    expect(updated.normalizedKey).toBe(saved.normalizedKey);
    expect(updated.createdAt).toBe(saved.createdAt);
    expect(new Date(updated.updatedAt).valueOf()).toBeGreaterThan(new Date(saved.updatedAt).valueOf());
  });

  it('throws WorkspaceNotFoundError for a missing id', () => {
    expect(() => workspace.updateApplicationAnswer(db, 'not-a-real-id', { answer: 'x' })).toThrow(
      WorkspaceNotFoundError,
    );
  });
});

describe('recordApplicationAnswerUsed', () => {
  it('bumps only lastConfirmedAt, leaving the answer body, updatedAt, and origin untouched', async () => {
    const saved = workspace.saveApplicationAnswer(db, ANSWER);
    await new Promise((resolve) => setTimeout(resolve, 5));

    const used = workspace.recordApplicationAnswerUsed(db, saved.id);

    expect(new Date(used.lastConfirmedAt).valueOf()).toBeGreaterThan(new Date(saved.lastConfirmedAt).valueOf());
    expect(used.answer).toBe(saved.answer);
    expect(used.updatedAt).toBe(saved.updatedAt);
    expect(used.originCompany).toBe(saved.originCompany);
    expect(used.originRole).toBe(saved.originRole);
    expect(used.normalizedKey).toBe(saved.normalizedKey);
  });

  it('throws WorkspaceNotFoundError for a missing id', () => {
    expect(() => workspace.recordApplicationAnswerUsed(db, 'not-a-real-id')).toThrow(WorkspaceNotFoundError);
  });
});

describe('deleteApplicationAnswer', () => {
  it('removes the row and reports {deleted:true}', () => {
    const saved = workspace.saveApplicationAnswer(db, ANSWER);
    expect(workspace.deleteApplicationAnswer(db, saved.id)).toEqual({ deleted: true });
    expect(workspace.listApplicationAnswers(db)).toEqual([]);
  });

  it('reports {deleted:false} for an already-gone id, without throwing', () => {
    const saved = workspace.saveApplicationAnswer(db, ANSWER);
    workspace.deleteApplicationAnswer(db, saved.id);
    expect(workspace.deleteApplicationAnswer(db, saved.id)).toEqual({ deleted: false });
  });
});

describe('resetApplicationData', () => {
  it('wipes application_answers and reports its count alongside the other reset tables', () => {
    workspace.saveApplicationAnswer(db, ANSWER);
    workspace.saveApplicationAnswer(db, { ...ANSWER, label: 'A second question' });

    const result = workspace.resetApplicationData(db);

    expect(result.deleted).toMatchObject({ applicationAnswers: 2 });
    expect(workspace.listApplicationAnswers(db)).toEqual([]);
  });
});
