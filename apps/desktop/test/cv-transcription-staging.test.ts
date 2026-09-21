import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  cleanupStagedPath,
  consumeStagedCvAttachment,
  discardStagedCvAttachment,
  stageForTranscription,
  sweepStaleStagedAttachments,
} from '../electron/cv-transcription-staging.js';

/**
 * Real temp directories throughout (no filesystem mocking), matching cv-text-pdf.test.ts's own
 * `beforeAll`/`afterAll` pattern: this module's whole job is copying bytes onto disk and cleaning
 * them back up again, so a mock filesystem would only hide the thing being tested.
 */
let workspaceDir: string;

beforeAll(async () => {
  workspaceDir = await mkdtemp(join(tmpdir(), 'cv-transcription-staging-test-'));
});

afterAll(async () => {
  await rm(workspaceDir, { recursive: true, force: true });
});

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

describe('cv-transcription-staging', () => {
  it('stages the bytes to disk under the workspace dir and returns a usable candidate id', async () => {
    const bytes = Buffer.from('%PDF-1.4 fake scanned cv bytes');
    const candidateId = await stageForTranscription(workspaceDir, 'scan.pdf', bytes);

    expect(typeof candidateId).toBe('string');
    expect(candidateId.length).toBeGreaterThan(0);

    const entry = consumeStagedCvAttachment(candidateId);
    expect(entry).toBeDefined();
    expect(entry?.path.startsWith(workspaceDir)).toBe(true);
    expect(entry?.mimeType).toBe('application/pdf');

    const written = await readFile(entry!.path);
    expect(written.equals(bytes)).toBe(true);

    await cleanupStagedPath(entry!.dir);
  });

  it('consumeStagedCvAttachment is single-use: undefined on a second call with the same id', async () => {
    const candidateId = await stageForTranscription(workspaceDir, 'cv.pdf', Buffer.from('one-shot'));

    const first = consumeStagedCvAttachment(candidateId);
    expect(first).toBeDefined();
    const second = consumeStagedCvAttachment(candidateId);
    expect(second).toBeUndefined();

    await cleanupStagedPath(first!.dir);
  });

  it('consumeStagedCvAttachment returns undefined for a bogus id', () => {
    expect(consumeStagedCvAttachment('not-a-real-candidate-id')).toBeUndefined();
  });

  it('discardStagedCvAttachment removes the staged file from disk, and a later consume returns undefined', async () => {
    const candidateId = await stageForTranscription(workspaceDir, 'declined.pdf', Buffer.from('never used'));
    // Recover the path before discarding, purely to assert against the filesystem afterwards --
    // discarding must not require the caller to have consumed the entry first.
    const dirBeforeDiscard = join(workspaceDir, 'cv-transcription-staging', candidateId);
    expect(await exists(dirBeforeDiscard)).toBe(true);

    await discardStagedCvAttachment(candidateId);

    expect(await exists(dirBeforeDiscard)).toBe(false);
    expect(consumeStagedCvAttachment(candidateId)).toBeUndefined();
  });

  it('discardStagedCvAttachment on an unknown id does not throw', async () => {
    await expect(discardStagedCvAttachment('never-staged-id')).resolves.toBeUndefined();
  });

  it('two different candidate ids staged into the same workspace do not collide', async () => {
    const idA = await stageForTranscription(workspaceDir, 'cv.pdf', Buffer.from('candidate A'));
    const idB = await stageForTranscription(workspaceDir, 'cv.pdf', Buffer.from('candidate B'));
    expect(idA).not.toBe(idB);

    const entryA = consumeStagedCvAttachment(idA);
    const entryB = consumeStagedCvAttachment(idB);
    expect(entryA?.dir).not.toBe(entryB?.dir);

    expect((await readFile(entryA!.path)).toString()).toBe('candidate A');
    expect((await readFile(entryB!.path)).toString()).toBe('candidate B');

    await cleanupStagedPath(entryA!.dir);
    await cleanupStagedPath(entryB!.dir);
  });

  it('sweepStaleStagedAttachments with force:true removes a freshly-staged directory', async () => {
    const candidateId = await stageForTranscription(workspaceDir, 'fresh.pdf', Buffer.from('fresh bytes'));
    const dir = join(workspaceDir, 'cv-transcription-staging', candidateId);
    expect(await exists(dir)).toBe(true);

    await sweepStaleStagedAttachments(workspaceDir, { force: true });

    expect(await exists(dir)).toBe(false);
  });

  it('a sweep removes the in-memory entry along with the directory, so a swept candidate reads back as unknown', async () => {
    // A candidate the sweep deletes from disk must be indistinguishable from one this module never
    // heard of: consumeStagedCvAttachment must not hand back a `{path, mimeType, dir}` pointing at a
    // directory that no longer exists.
    const candidateId = await stageForTranscription(workspaceDir, 'swept.pdf', Buffer.from('will be swept'));
    const dir = join(workspaceDir, 'cv-transcription-staging', candidateId);

    await sweepStaleStagedAttachments(workspaceDir, { force: true });
    expect(await exists(dir)).toBe(false);

    expect(consumeStagedCvAttachment(candidateId)).toBeUndefined();
  });

  it('sweepStaleStagedAttachments without force does not remove a freshly-staged directory (age-based, not consumed-based)', async () => {
    const candidateId = await stageForTranscription(workspaceDir, 'fresh2.pdf', Buffer.from('fresh bytes 2'));
    const dir = join(workspaceDir, 'cv-transcription-staging', candidateId);

    await sweepStaleStagedAttachments(workspaceDir);

    expect(await exists(dir)).toBe(true);

    // Cleanup so this test doesn't leak into the next one's readdir of the staging root.
    await discardStagedCvAttachment(candidateId);
  });

  it('sweeping a workspace whose staging subdirectory was never created does not throw', async () => {
    const emptyWorkspace = await mkdtemp(join(tmpdir(), 'cv-transcription-staging-empty-'));
    try {
      await expect(sweepStaleStagedAttachments(emptyWorkspace)).resolves.toBeUndefined();
      await expect(sweepStaleStagedAttachments(emptyWorkspace, { force: true })).resolves.toBeUndefined();
      expect(await exists(join(emptyWorkspace, 'cv-transcription-staging'))).toBe(false);
    } finally {
      await rm(emptyWorkspace, { recursive: true, force: true });
    }
  });

  it('the staging root directory contains only the staged subdirectory, named by the candidate id', async () => {
    const scoped = await mkdtemp(join(tmpdir(), 'cv-transcription-staging-scoped-'));
    try {
      const candidateId = await stageForTranscription(scoped, 'named.pdf', Buffer.from('x'));
      const root = join(scoped, 'cv-transcription-staging');
      const names = await readdir(root);
      expect(names).toEqual([candidateId]);
      await discardStagedCvAttachment(candidateId);
    } finally {
      await rm(scoped, { recursive: true, force: true });
    }
  });
});
