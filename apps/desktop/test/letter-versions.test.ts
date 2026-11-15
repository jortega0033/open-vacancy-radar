// @vitest-environment node
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createWorkspaceDb, type WorkspaceDb } from '../electron/workspace/client.js';
import * as workspace from '../electron/workspace/repository.js';
import { WorkspaceNotFoundError } from '../electron/workspace/repository.js';
import { letterContentHash } from '../electron/workspace/letter-version-store.js';
import { applyStatements, buildSubmissionManifest, manifestHash, type BindInput } from '../electron/submitted-package.js';

/** #738: insert-only letter versions, soft delete with undo, and the one-time backfill (migration 0042). */

const REAL_MIGRATIONS = join(dirname(fileURLToPath(import.meta.url)), '..', 'electron', 'workspace', 'drizzle');

type JournalEntry = { idx: number; tag: string };
type Journal = { entries: JournalEntry[] };

function seedPre0042MigrationsFolder(root: string): string {
  const journal = JSON.parse(readFileSync(join(REAL_MIGRATIONS, 'meta', '_journal.json'), 'utf8')) as Journal;
  const kept = journal.entries.filter((entry) => entry.idx < 42);
  expect(journal.entries[42]?.tag).toMatch(/^0042_/);
  const folder = join(root, 'drizzle-0041');
  mkdirSync(join(folder, 'meta'), { recursive: true });
  for (const entry of kept) cpSync(join(REAL_MIGRATIONS, `${entry.tag}.sql`), join(folder, `${entry.tag}.sql`));
  writeFileSync(join(folder, 'meta', '_journal.json'), JSON.stringify({ ...journal, entries: kept }, null, 2));
  return folder;
}

let dir: string;
let db: WorkspaceDb;
let close: () => void;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ovr-letter-versions-'));
});

afterEach(() => {
  close?.();
  rmSync(dir, { recursive: true, force: true });
});

function open(): void {
  ({ db, close } = createWorkspaceDb(dir));
}

describe('letter versions', () => {
  beforeEach(open);

  it('a new letter has version 1 and a created date', () => {
    const letter = workspace.createLetter(db, { title: 'Hello', type: 'cover_letter', body: 'Body one.' });
    expect(letter).toMatchObject({ currentVersion: 1 });
    expect(letter.createdAt).not.toBeNull();
    expect(workspace.listLetterVersions(db, letter.id)).toEqual([
      expect.objectContaining({ version: 1, title: 'Hello', body: 'Body one.', contentHash: letterContentHash({ title: 'Hello', type: 'cover_letter', body: 'Body one.' }) }),
    ]);
  });

  it('a changed title, type or body makes a new version; nothing else does', () => {
    const letter = workspace.createLetter(db, { title: 'Hello', type: 'cover_letter', body: 'Body one.' });
    expect(workspace.updateLetter(db, letter.id, { body: 'Body one.' }).currentVersion).toBe(1);
    expect(workspace.updateLetter(db, letter.id, { status: 'final' }).currentVersion).toBe(1);
    expect(workspace.updateLetter(db, letter.id, { tone: 'formal', length: 'short', vacancyKey: 'vac-1' }).currentVersion).toBe(1);
    expect(workspace.updateLetter(db, letter.id, { body: 'Body two.' }).currentVersion).toBe(2);
    expect(workspace.updateLetter(db, letter.id, { title: 'Hello again' }).currentVersion).toBe(3);
    expect(workspace.updateLetter(db, letter.id, { type: 'motivation_letter' }).currentVersion).toBe(4);
    const versions = workspace.listLetterVersions(db, letter.id);
    expect(versions.map((version) => version.version)).toEqual([1, 2, 3, 4]);
    expect(versions[0]).toMatchObject({ title: 'Hello', body: 'Body one.', type: 'cover_letter' });
  });

  it('restoring an older version appends it as the newest and leaves history untouched', () => {
    const letter = workspace.createLetter(db, { title: 'Hello', type: 'cover_letter', body: 'Body one.' });
    workspace.updateLetter(db, letter.id, { body: 'Body two.' });
    const [v1, v2] = workspace.listLetterVersions(db, letter.id);
    const restored = workspace.restoreLetterVersion(db, letter.id, v1!.id);
    expect(restored).toMatchObject({ body: 'Body one.', currentVersion: 3 });
    const after = workspace.listLetterVersions(db, letter.id);
    expect(after.slice(0, 2)).toEqual([v1, v2]);
    expect(after[2]).toMatchObject({ body: 'Body one.', contentHash: v1!.contentHash });

    const other = workspace.createLetter(db, { title: 'Other', body: 'x' });
    expect(() => workspace.restoreLetterVersion(db, other.id, v1!.id)).toThrow(WorkspaceNotFoundError);
  });

  it('duplicating starts a new letter at version 1 from the current text, as a draft', () => {
    const letter = workspace.createLetter(db, { title: 'Hello', type: 'cover_letter', body: 'Body one.', status: 'sent' });
    workspace.updateLetter(db, letter.id, { body: 'Body two.' });
    const copy = workspace.duplicateLetter(db, letter.id);
    expect(copy).toMatchObject({ status: 'draft', body: 'Body two.', currentVersion: 1 });
    expect(workspace.listLetterVersions(db, copy.id)).toHaveLength(1);
  });

  it('delete is soft until purged; undo brings back the same id, versions and application link', () => {
    const letter = workspace.createLetter(db, { title: 'Hello', body: 'Body one.' });
    workspace.updateLetter(db, letter.id, { body: 'Body two.' });
    const row = workspace.createApplication(db, { role: 'R', company: 'C', letterId: letter.id });

    expect(workspace.deleteLetter(db, letter.id)).toEqual({ deleted: true });
    expect(workspace.deleteLetter(db, letter.id)).toEqual({ deleted: false });
    expect(workspace.listLetters(db)).toEqual([]);
    expect(workspace.getCounts(db).letters).toBe(0);
    expect(workspace.listLetterVersions(db, letter.id)).toEqual([]);
    expect(() => workspace.updateLetter(db, letter.id, { body: 'x' })).toThrow(WorkspaceNotFoundError);
    expect(() => workspace.duplicateLetter(db, letter.id)).toThrow(WorkspaceNotFoundError);
    expect(workspace.purgeLetter(db, workspace.createLetter(db, { title: 'Live', body: '' }).id)).toEqual({ deleted: false });

    const restored = workspace.restoreLetter(db, letter.id);
    expect(restored).toMatchObject({ id: letter.id, body: 'Body two.', currentVersion: 2 });
    expect(workspace.listLetterVersions(db, letter.id)).toHaveLength(2);
    expect(workspace.listApplications(db).find((a) => a.id === row.id)!.letterId).toBe(letter.id);

    workspace.deleteLetter(db, letter.id);
    expect(workspace.purgeLetter(db, letter.id)).toEqual({ deleted: true });
    expect(() => workspace.restoreLetter(db, letter.id)).toThrow(WorkspaceNotFoundError);
    expect(workspace.listApplications(db).find((a) => a.id === row.id)!.letterId).toBeNull();
  });

  it('a letter still soft-deleted when the app closes is purged at the next start', () => {
    const letter = workspace.createLetter(db, { title: 'Hello', body: 'Body one.' });
    workspace.deleteLetter(db, letter.id);
    close();
    open();
    expect(() => workspace.restoreLetter(db, letter.id)).toThrow(WorkspaceNotFoundError);
  });
});

describe('migration 0042 gives existing letters their version 1', () => {
  it('backfills version 1 from the current text, dated at the last update, and leaves the created date unrecorded', () => {
    const seeded = new Database(join(dir, 'workspace.db'));
    try {
      migrate(drizzle(seeded), { migrationsFolder: seedPre0042MigrationsFolder(dir) });
      seeded
        .prepare(
          `INSERT INTO letters (id, title, company, role, type, tone, length, status, vacancy_key, cv_id, body, updated_at)
           VALUES ('legacy-1', 'Old letter', 'Contoso', 'Engineer', 'cover_letter', 'formal', 'standard', 'sent', NULL, NULL, ?, 1785000000000)`,
        )
        .run('Dear team,\n\nOld text.');
    } finally {
      seeded.close();
    }

    open();
    const [letter] = workspace.listLetters(db);
    expect(letter).toMatchObject({ id: 'legacy-1', body: 'Dear team,\n\nOld text.', status: 'sent', createdAt: null, currentVersion: 1 });
    const versions = workspace.listLetterVersions(db, 'legacy-1');
    expect(versions).toEqual([
      expect.objectContaining({
        version: 1,
        body: 'Dear team,\n\nOld text.',
        createdAt: new Date(1785000000000).toISOString(),
        contentHash: letterContentHash({ title: 'Old letter', type: 'cover_letter', body: 'Dear team,\n\nOld text.' }),
      }),
    ]);

    // Idempotent: reopening does not add a second version 1.
    close();
    open();
    expect(workspace.listLetterVersions(db, 'legacy-1')).toHaveLength(1);
  });
});

describe('manifest letter references are additive', () => {
  const bind: BindInput = {
    attempt: {
      employerKey: 'contoso',
      requisitionId: null,
      canonicalUrlKey: 'url',
      company: 'Contoso',
      role: 'Engineer',
      jdSnapshotHash: 'jd',
      jdComplete: true,
      sourceCvId: null,
      sourceCvContentHash: 'cv',
      completionEvidence: 'user_reported',
      preparedFields: null,
    },
    drafts: [{ id: 'd1', kind: 'cover_letter', version: 1, contentHash: 'c', artifactHash: 'a' }],
    artifacts: [],
    receipts: [],
    reviewedEvidence: null,
    previous: null,
  };

  it('a draft with no library letter produces exactly the pre-#738 document shape and hash', () => {
    const manifest = buildSubmissionManifest(bind);
    expect(manifest.schema).toBe(1);
    expect(Object.keys(manifest.documents[0]!)).not.toContain('libraryLetter');
    // Re-binding against a manifest written before #738 is still a no-op.
    expect(manifestHash(buildSubmissionManifest({ ...bind, previous: manifest }))).toBe(manifestHash(manifest));
  });

  it('carries the library letter of a draft, and of a linked-letter statement', () => {
    const ref = { letterId: 'l1', versionId: 'v1', version: 1 };
    const manifest = buildSubmissionManifest({ ...bind, drafts: [{ ...bind.drafts[0]!, libraryLetter: ref }] });
    expect(manifest.documents[0]!.libraryLetter).toEqual(ref);

    const stated = applyStatements(manifest, [{ slot: 'letter', choice: 'linked_document', text: 'Sent text', kind: 'cover_letter', libraryLetter: ref }], '2026-11-15T00:00:00.000Z');
    expect(stated.ok && stated.content.documents[0]).toMatchObject({ source: 'linked_copy', libraryLetter: ref });

    const pasted = applyStatements(manifest, [{ slot: 'letter', choice: 'supplied_text', text: 'Pasted', libraryLetter: ref }], '2026-11-15T00:00:00.000Z');
    expect(pasted.ok && Object.keys(pasted.content.documents[0]!)).not.toContain('libraryLetter');
  });
});
