// @vitest-environment node
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getApplyCopyFields, normalizeLetterBody } from '../electron/apply-copy-fields.js';
import { createApplyCopyHandlers } from '../electron/apply-copy-ipc.js';
import { parseApplyCopyResult } from '../electron/apply-copy-types.js';
import type { DraftContent } from '../electron/application-critique.js';
import { recordPreparedDraft } from '../electron/workspace/application-critique-store.js';
import { createWorkspaceDb } from '../electron/workspace/client.js';
import * as workspace from '../electron/workspace/repository.js';
import type { WorkspaceDb } from '../electron/workspace/client.js';
import type { TailoredResume } from '../electron/resume-schema.js';

/**
 * #660 at the real boundaries: a real migrated SQLite workspace, real artifact and draft rows, and
 * real bytes on disk, so every verification hop (stored content hash, draft-to-artifact hash, file
 * bytes) is exercised exactly as the Apply page's read would. Any failing hop must hide the whole
 * document's values; nothing falls back to live letters or the live CV source.
 */

const sha = (value: string | Buffer): string => createHash('sha256').update(value).digest('hex');

const RESUME: TailoredResume = {
  contact: {
    name: '  Dana Doe ',
    title: 'Engineer',
    location: 'Rotterdam',
    email: 'dana@example.test',
    phone: '',
    links: [' https://example.test/dana ', '', 'https://git.example.test/dana'],
  },
  summary: 'Builds things.',
  experience: [],
  projects: [],
  skills: [],
  education: [],
};

const LETTER_BODY = 'Dear team,\n\n\nI would like   to apply.\n\nKind regards,\nDana Doe';

let dir: string;
let db: WorkspaceDb;
let closeDb: () => void;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ovr-apply-copy-'));
  ({ db, close: closeDb } = createWorkspaceDb(dir));
});

afterEach(() => {
  closeDb();
  rmSync(dir, { recursive: true, force: true });
});

function makeAttempt(): string {
  return workspace.createApplicationAttempt(db, {
    company: 'Acme',
    role: 'Engineer',
    sourceCvContentHash: sha('cv source'),
    jdSnapshotHash: sha('jd'),
  }).id;
}

/** One staged PDF: real bytes on disk, an artifact row hashing to them. Returns the content hash. */
function stageFile(attemptId: string, kind: 'cv_pdf' | 'cover_letter_pdf', name: string, bytes: string): { hash: string; path: string } {
  const path = join(dir, name);
  writeFileSync(path, bytes);
  const hash = sha(Buffer.from(bytes));
  workspace.createApplicationArtifact(db, {
    attemptId,
    kind,
    fileName: name,
    mimeType: 'application/pdf',
    byteSize: Buffer.byteLength(bytes),
    contentHash: hash,
    storagePath: path,
  });
  return { hash, path };
}

function recordDraft(attemptId: string, kind: 'cv' | 'cover_letter' | 'motivation_letter', content: DraftContent, artifactHash: string) {
  const draft = recordPreparedDraft(db, {
    attemptId,
    kind,
    origin: 'prepared',
    content,
    artifactHash,
    jdHash: sha('jd'),
    sourceCvHash: sha('cv source'),
    now: new Date(),
  });
  expect(draft).not.toBeNull();
  return draft!;
}

const letterContent = (body: string): DraftContent => ({ type: 'letter', title: 'Cover Letter', body, authored: 'user', factIds: [], companyClaims: [] });
const cvContent = (resume: TailoredResume = RESUME): DraftContent => ({ type: 'cv', resume, basis: 'tailored' });

describe('normalizeLetterBody', () => {
  it('matches the PDF paragraph layout: blank-line splits, trimmed, one blank line between', () => {
    expect(normalizeLetterBody('  a \n\n\n b\nstill b \n\n\n\nc  ')).toBe('a\n\nb\nstill b\n\nc');
  });
});

describe('getApplyCopyFields', () => {
  it('returns the letter body and contact only from verified current drafts', async () => {
    const attemptId = makeAttempt();
    const letter = stageFile(attemptId, 'cover_letter_pdf', 'cover-letter.pdf', 'letter pdf bytes');
    const cv = stageFile(attemptId, 'cv_pdf', 'resume.pdf', 'cv pdf bytes');
    recordDraft(attemptId, 'cover_letter', letterContent(LETTER_BODY), letter.hash);
    recordDraft(attemptId, 'cv', cvContent(), cv.hash);

    const view = await getApplyCopyFields(db, attemptId);
    expect(view.letters).toEqual([
      { kind: 'cover_letter', text: normalizeLetterBody(LETTER_BODY), version: 1, artifactHash: letter.hash },
    ]);
    expect(view.letterUnavailable).toBeNull();
    expect(view.contact).toEqual({
      name: 'Dana Doe',
      email: 'dana@example.test',
      phone: '',
      location: 'Rotterdam',
      links: ['https://example.test/dana', 'https://git.example.test/dana'],
      version: 1,
      artifactHash: cv.hash,
    });
    expect(view.contactUnavailable).toBeNull();
  });

  it('offers nothing and no unavailable note when no document was staged at all', async () => {
    const attemptId = makeAttempt();
    const view = await getApplyCopyFields(db, attemptId);
    expect(view).toEqual({ letters: [], letterUnavailable: null, contact: null, contactUnavailable: null });
  });

  it('reports no_draft when a staged PDF has no current draft', async () => {
    const attemptId = makeAttempt();
    stageFile(attemptId, 'cover_letter_pdf', 'cover-letter.pdf', 'letter pdf bytes');
    stageFile(attemptId, 'cv_pdf', 'resume.pdf', 'cv pdf bytes');
    const view = await getApplyCopyFields(db, attemptId);
    expect(view.letters).toEqual([]);
    expect(view.letterUnavailable).toBe('no_draft');
    expect(view.contact).toBeNull();
    expect(view.contactUnavailable).toBe('no_draft');
  });

  it('reports changed when the draft points at no artifact of this attempt', async () => {
    const attemptId = makeAttempt();
    stageFile(attemptId, 'cover_letter_pdf', 'cover-letter.pdf', 'letter pdf bytes');
    stageFile(attemptId, 'cv_pdf', 'resume.pdf', 'cv pdf bytes');
    recordDraft(attemptId, 'cover_letter', letterContent(LETTER_BODY), sha('some other artifact'));
    recordDraft(attemptId, 'cv', cvContent(), sha('another artifact'));
    const view = await getApplyCopyFields(db, attemptId);
    expect(view.letters).toEqual([]);
    expect(view.letterUnavailable).toBe('changed');
    expect(view.contact).toBeNull();
    expect(view.contactUnavailable).toBe('changed');
  });

  it('reports changed when file bytes no longer match the staged hash', async () => {
    const attemptId = makeAttempt();
    const letter = stageFile(attemptId, 'cover_letter_pdf', 'cover-letter.pdf', 'letter pdf bytes');
    recordDraft(attemptId, 'cover_letter', letterContent(LETTER_BODY), letter.hash);
    writeFileSync(letter.path, 'tampered bytes');
    const view = await getApplyCopyFields(db, attemptId);
    expect(view.letters).toEqual([]);
    expect(view.letterUnavailable).toBe('changed');
  });

  it('reports file_missing when the staged file is gone', async () => {
    const attemptId = makeAttempt();
    const cv = stageFile(attemptId, 'cv_pdf', 'resume.pdf', 'cv pdf bytes');
    recordDraft(attemptId, 'cv', cvContent(), cv.hash);
    unlinkSync(cv.path);
    const view = await getApplyCopyFields(db, attemptId);
    expect(view.contact).toBeNull();
    expect(view.contactUnavailable).toBe('file_missing');
  });

  it('ignores a superseded letter draft: only the current version is offered', async () => {
    const attemptId = makeAttempt();
    const old = stageFile(attemptId, 'cover_letter_pdf', 'cover-letter-v1.pdf', 'old letter pdf');
    const fresh = stageFile(attemptId, 'cover_letter_pdf', 'cover-letter-v2.pdf', 'new letter pdf');
    recordDraft(attemptId, 'cover_letter', letterContent('Old body.'), old.hash);
    recordDraft(attemptId, 'cover_letter', letterContent('New body.'), fresh.hash);
    const view = await getApplyCopyFields(db, attemptId);
    expect(view.letters).toEqual([{ kind: 'cover_letter', text: 'New body.', version: 2, artifactHash: fresh.hash }]);
    expect(view.letterUnavailable).toBeNull();
  });

  it('offers each letter kind independently, matched to its own artifact by hash', async () => {
    const attemptId = makeAttempt();
    const cover = stageFile(attemptId, 'cover_letter_pdf', 'cover-letter.pdf', 'cover pdf');
    const motivation = stageFile(attemptId, 'cover_letter_pdf', 'motivation-letter.pdf', 'motivation pdf');
    recordDraft(attemptId, 'cover_letter', letterContent('Cover body.'), cover.hash);
    recordDraft(attemptId, 'motivation_letter', { ...letterContent('Motivation body.'), title: 'Motivation Letter' } as DraftContent, motivation.hash);
    const view = await getApplyCopyFields(db, attemptId);
    expect(view.letters.map((entry) => [entry.kind, entry.text])).toEqual([
      ['cover_letter', 'Cover body.'],
      ['motivation_letter', 'Motivation body.'],
    ]);
  });

  it('never falls back to the live CV source when the CV draft fails verification', async () => {
    const attemptId = makeAttempt();
    const cv = stageFile(attemptId, 'cv_pdf', 'resume.pdf', 'cv pdf bytes');
    recordDraft(attemptId, 'cv', cvContent(), cv.hash);
    writeFileSync(cv.path, 'tampered');
    const view = await getApplyCopyFields(db, attemptId);
    expect(view.contact).toBeNull();
    expect(view.contactUnavailable).toBe('changed');
  });
});

describe('apply-copy-fields:get handler and parser', () => {
  it('serves a verified view through the handler and the preload parser', async () => {
    const attemptId = makeAttempt();
    const letter = stageFile(attemptId, 'cover_letter_pdf', 'cover-letter.pdf', 'letter pdf bytes');
    recordDraft(attemptId, 'cover_letter', letterContent(LETTER_BODY), letter.hash);
    const handlers = createApplyCopyHandlers(async () => ({ db }));
    const raw = await handlers['apply-copy-fields:get']!({ attemptId });
    const result = parseApplyCopyResult(JSON.parse(JSON.stringify(raw)));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.view.letters[0]!.text).toBe(normalizeLetterBody(LETTER_BODY));
  });

  it('refuses malformed input and unknown attempts', async () => {
    const handlers = createApplyCopyHandlers(async () => ({ db }));
    expect((await handlers['apply-copy-fields:get']!({ attemptId: '', extra: 1 })).ok).toBe(false);
    const gone = await handlers['apply-copy-fields:get']!({ attemptId: 'does-not-exist' });
    expect(gone).toMatchObject({ ok: false, code: 'not_found' });
  });

  it('fails closed on a malformed result', () => {
    expect(parseApplyCopyResult({ ok: true, view: { letters: 'nope' } })).toMatchObject({ ok: false, code: 'failed' });
    expect(parseApplyCopyResult(undefined)).toMatchObject({ ok: false, code: 'failed' });
  });
});
