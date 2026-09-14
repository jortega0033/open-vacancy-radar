import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FIXTURE_REVIEW_POLICY } from '../electron/application-target-policies.js';
import { stagedArtifactPath } from '../electron/application-artifact-staging.js';
import { isStagedUnderAttempt, listOwnedArtifactIds, resolveUploadArtifact } from '../electron/application-artifact-upload.js';
import type { ApplicationArtifactRecord } from '../electron/workspace/types.js';

/**
 * Proves #273's artifact resolution against real bytes on a real (temporary) disk: the hash and
 * existence checks are the whole point of this module, and a mocked filesystem would only prove
 * that the mock was called. Only the workspace repository is mocked -- what it returns stands in
 * for #198's artifact table, whose own behavior `workspace-repository.test.ts` already covers.
 *
 * Every path here is created by this test under the OS temp directory; nothing reads or names a
 * real location on the machine running it.
 */
const workspaceMock = vi.hoisted(() => ({
  listApplicationArtifacts: vi.fn((_db: unknown, _attemptId: string) => [] as ApplicationArtifactRecord[]),
}));
vi.mock('../electron/workspace/repository.js', () => workspaceMock);

const FAKE_DB = {} as never;
const ATTEMPT_ID = '11111111-1111-4111-8111-111111111111';
const OTHER_ATTEMPT_ID = '22222222-2222-4222-8222-222222222222';

let storageRoot: string;

function sha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function artifactRecord(overrides: Partial<ApplicationArtifactRecord> = {}): ApplicationArtifactRecord {
  return {
    id: '33333333-3333-4333-8333-333333333333',
    attemptId: ATTEMPT_ID,
    kind: 'cv_pdf',
    fileName: 'resume.pdf',
    mimeType: 'application/pdf',
    byteSize: 0,
    contentHash: '',
    storagePath: '',
    createdAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

/** Writes real bytes into `attemptId`'s own staging folder and returns the record #198 would have
 * registered for them, so a test only has to say what it wants to be *wrong* about it. */
async function stageArtifact(
  bytes: Buffer,
  overrides: Partial<ApplicationArtifactRecord> = {},
  attemptId: string = ATTEMPT_ID,
): Promise<ApplicationArtifactRecord> {
  const fileName = overrides.fileName ?? 'resume.pdf';
  const contentHash = sha256(bytes);
  const storagePath = stagedArtifactPath(storageRoot, attemptId, contentHash, fileName);
  await mkdir(join(storageRoot, attemptId), { recursive: true });
  await writeFile(storagePath, bytes);
  return artifactRecord({ attemptId, fileName, byteSize: bytes.byteLength, contentHash, storagePath, ...overrides });
}

const CV_BYTES = Buffer.from('%PDF-1.4 synthetic fixture resume bytes');
const LETTER_BYTES = Buffer.from('%PDF-1.4 synthetic fixture cover letter bytes');

beforeEach(async () => {
  storageRoot = await mkdtemp(join(tmpdir(), 'ovr-artifact-upload-'));
  workspaceMock.listApplicationArtifacts.mockReset().mockReturnValue([]);
});

afterEach(async () => {
  await rm(storageRoot, { recursive: true, force: true });
});

describe('isStagedUnderAttempt', () => {
  it('accepts a path staging actually produced for that attempt', () => {
    expect(isStagedUnderAttempt(stagedArtifactPath('/data/artifacts', ATTEMPT_ID, 'abc', 'resume.pdf'), ATTEMPT_ID)).toBe(true);
  });

  it('rejects another attempt\'s staging folder and an ambient location like a downloads folder', () => {
    expect(isStagedUnderAttempt(stagedArtifactPath('/data/artifacts', OTHER_ATTEMPT_ID, 'abc', 'resume.pdf'), ATTEMPT_ID)).toBe(false);
    expect(isStagedUnderAttempt(join('/home/someone/Downloads', 'resume.pdf'), ATTEMPT_ID)).toBe(false);
  });
});

describe('listOwnedArtifactIds', () => {
  it('returns exactly the ids the artifact table holds for this attempt, and asks it only about this attempt', () => {
    workspaceMock.listApplicationArtifacts.mockReturnValue([
      artifactRecord({ id: 'artifact-a' }),
      artifactRecord({ id: 'artifact-b', kind: 'cover_letter_pdf' }),
    ]);

    expect(listOwnedArtifactIds(FAKE_DB, ATTEMPT_ID)).toEqual(['artifact-a', 'artifact-b']);
    expect(workspaceMock.listApplicationArtifacts).toHaveBeenCalledWith(FAKE_DB, ATTEMPT_ID);
  });

  it('reports an attempt with no artifacts as owning none, rather than throwing', () => {
    expect(listOwnedArtifactIds(FAKE_DB, ATTEMPT_ID)).toEqual([]);
  });
});

describe('resolveUploadArtifact', () => {
  it('resolves an attempt\'s own staged CV and letter to their real staged paths', async () => {
    const cv = await stageArtifact(CV_BYTES, { id: 'artifact-cv' });
    const letter = await stageArtifact(LETTER_BYTES, { id: 'artifact-letter', kind: 'cover_letter_pdf', fileName: 'cover-letter.pdf' });
    workspaceMock.listApplicationArtifacts.mockReturnValue([cv, letter]);

    const resolvedCv = await resolveUploadArtifact(FAKE_DB, ATTEMPT_ID, 'artifact-cv', FIXTURE_REVIEW_POLICY);
    const resolvedLetter = await resolveUploadArtifact(FAKE_DB, ATTEMPT_ID, 'artifact-letter', FIXTURE_REVIEW_POLICY);

    expect(resolvedCv).toMatchObject({
      ok: true,
      file: { artifactId: 'artifact-cv', fileName: 'resume.pdf', mimeType: 'application/pdf', byteSize: CV_BYTES.byteLength, localFilePath: cv.storagePath },
    });
    expect(resolvedLetter).toMatchObject({ ok: true, file: { artifactId: 'artifact-letter', fileName: 'cover-letter.pdf', localFilePath: letter.storagePath } });
  });

  it('refuses an artifact belonging to another attempt, even when its file is perfectly valid on disk', async () => {
    const theirs = await stageArtifact(CV_BYTES, { id: 'artifact-theirs' }, OTHER_ATTEMPT_ID);
    // The real repository query is scoped by attempt id in SQL, so this attempt's own list simply
    // never contains the other attempt's row.
    workspaceMock.listApplicationArtifacts.mockImplementation((_db: unknown, attemptId: string) =>
      attemptId === OTHER_ATTEMPT_ID ? [theirs] : [],
    );

    const result = await resolveUploadArtifact(FAKE_DB, ATTEMPT_ID, 'artifact-theirs', FIXTURE_REVIEW_POLICY);
    expect(result).toMatchObject({ ok: false, reason: 'artifact_not_owned' });
    expect(result.file).toBeUndefined();
  });

  it('refuses an artifact whose bytes changed on disk since it was staged', async () => {
    const cv = await stageArtifact(CV_BYTES, { id: 'artifact-cv' });
    workspaceMock.listApplicationArtifacts.mockReturnValue([cv]);
    // Same length, different bytes: only a real re-hash catches this, never a size or mtime check.
    await writeFile(cv.storagePath, Buffer.from('%PDF-1.4 synthetic fixture resume BYTES'));

    const result = await resolveUploadArtifact(FAKE_DB, ATTEMPT_ID, 'artifact-cv', FIXTURE_REVIEW_POLICY);
    expect(result).toMatchObject({ ok: false, reason: 'artifact_content_changed' });
  });

  it('refuses an artifact whose staged file grew or shrank since it was registered', async () => {
    const cv = await stageArtifact(CV_BYTES, { id: 'artifact-cv' });
    workspaceMock.listApplicationArtifacts.mockReturnValue([cv]);
    await writeFile(cv.storagePath, Buffer.concat([CV_BYTES, Buffer.from(' plus an appended paragraph')]));

    const result = await resolveUploadArtifact(FAKE_DB, ATTEMPT_ID, 'artifact-cv', FIXTURE_REVIEW_POLICY);
    expect(result).toMatchObject({ ok: false, reason: 'artifact_content_changed' });
  });

  it('refuses an artifact whose staged file is gone, rather than discovering it at upload time', async () => {
    const cv = await stageArtifact(CV_BYTES, { id: 'artifact-cv' });
    workspaceMock.listApplicationArtifacts.mockReturnValue([cv]);
    await rm(cv.storagePath);

    const result = await resolveUploadArtifact(FAKE_DB, ATTEMPT_ID, 'artifact-cv', FIXTURE_REVIEW_POLICY);
    expect(result).toMatchObject({ ok: false, reason: 'artifact_file_unreadable' });
  });

  it('refuses an oversized artifact before ever reading it -- the file does not even have to exist', async () => {
    workspaceMock.listApplicationArtifacts.mockReturnValue([
      artifactRecord({
        id: 'artifact-huge',
        byteSize: FIXTURE_REVIEW_POLICY.uploadConstraints.maxBytes + 1,
        contentHash: sha256(CV_BYTES),
        storagePath: stagedArtifactPath(storageRoot, ATTEMPT_ID, sha256(CV_BYTES), 'resume.pdf'),
      }),
    ]);

    const result = await resolveUploadArtifact(FAKE_DB, ATTEMPT_ID, 'artifact-huge', FIXTURE_REVIEW_POLICY);
    expect(result).toMatchObject({ ok: false, reason: 'artifact_too_large' });
  });

  it('refuses an artifact whose type this target does not accept', async () => {
    const doc = await stageArtifact(CV_BYTES, { id: 'artifact-docx', fileName: 'resume.docx', mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' });
    workspaceMock.listApplicationArtifacts.mockReturnValue([doc]);

    const result = await resolveUploadArtifact(FAKE_DB, ATTEMPT_ID, 'artifact-docx', FIXTURE_REVIEW_POLICY);
    expect(result).toMatchObject({ ok: false, reason: 'artifact_mime_not_allowed' });
  });

  it('refuses a registered artifact whose path points outside this attempt\'s staging folder, however valid the file itself is', async () => {
    // The ambient case #273 names explicitly: a real, readable, correctly-hashed PDF that simply
    // is not this attempt's staged artifact -- a file sitting in a downloads-style folder.
    const ambientDir = join(storageRoot, 'Downloads');
    await mkdir(ambientDir, { recursive: true });
    const ambientPath = join(ambientDir, 'resume.pdf');
    await writeFile(ambientPath, CV_BYTES);
    workspaceMock.listApplicationArtifacts.mockReturnValue([
      artifactRecord({ id: 'artifact-ambient', byteSize: CV_BYTES.byteLength, contentHash: sha256(CV_BYTES), storagePath: ambientPath }),
    ]);

    const result = await resolveUploadArtifact(FAKE_DB, ATTEMPT_ID, 'artifact-ambient', FIXTURE_REVIEW_POLICY);
    expect(result).toMatchObject({ ok: false, reason: 'artifact_outside_attempt_staging' });
  });

  it('refuses a manifest row that was never staged to a real file at all', async () => {
    workspaceMock.listApplicationArtifacts.mockReturnValue([artifactRecord({ id: 'artifact-bare' })]);

    const result = await resolveUploadArtifact(FAKE_DB, ATTEMPT_ID, 'artifact-bare', FIXTURE_REVIEW_POLICY);
    expect(result).toMatchObject({ ok: false, reason: 'artifact_not_staged' });
  });

  it('never puts a filesystem path in a refusal detail, whatever went wrong', async () => {
    const cv = await stageArtifact(CV_BYTES, { id: 'artifact-cv' });
    workspaceMock.listApplicationArtifacts.mockReturnValue([cv]);
    await rm(cv.storagePath);

    const missing = await resolveUploadArtifact(FAKE_DB, ATTEMPT_ID, 'artifact-cv', FIXTURE_REVIEW_POLICY);
    const foreign = await resolveUploadArtifact(FAKE_DB, ATTEMPT_ID, 'artifact-nobody-owns', FIXTURE_REVIEW_POLICY);

    for (const detail of [missing.detail, foreign.detail]) {
      expect(detail).toBeTruthy();
      expect(detail).not.toContain(storageRoot);
      expect(detail).not.toContain(tmpdir());
    }
  });
});
