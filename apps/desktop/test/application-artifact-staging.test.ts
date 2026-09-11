import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  AcceptedBytesChangedError,
  documentKindForArtifact,
  readAcceptedArtifactBytes,
  stagedArtifactPath,
} from '../electron/application-artifact-staging.js';
import { hashDocumentBytes } from '../electron/document-acceptance.js';

describe('stagedArtifactPath', () => {
  it('namespaces the path under the attempt id and names the file by content hash', () => {
    const path = stagedArtifactPath('/data/application-artifacts', 'attempt-1', 'abc123', 'resume.pdf');
    expect(path).toBe(join('/data/application-artifacts', 'attempt-1', 'abc123-resume.pdf'));
  });

  it('gives two different attempts distinct paths even for identical content and file names', () => {
    const a = stagedArtifactPath('/data/application-artifacts', 'attempt-1', 'abc123', 'resume.pdf');
    const b = stagedArtifactPath('/data/application-artifacts', 'attempt-2', 'abc123', 'resume.pdf');
    expect(a).not.toBe(b);
  });

  it('gives identical (storageRoot, attempt, content) the same path, making re-staging idempotent on disk', () => {
    const first = stagedArtifactPath('/data/application-artifacts', 'attempt-1', 'abc123', 'resume.pdf');
    const second = stagedArtifactPath('/data/application-artifacts', 'attempt-1', 'abc123', 'resume.pdf');
    expect(first).toBe(second);
  });
});

describe('documentKindForArtifact', () => {
  it('maps every artifact kind that carries a real document, and nothing else', () => {
    expect(documentKindForArtifact('cv_pdf')).toBe('cv');
    expect(documentKindForArtifact('cover_letter_pdf')).toBe('cover_letter');
    expect(documentKindForArtifact('combined_pdf')).toBe('combined');
    expect(documentKindForArtifact('other')).toBeNull();
  });
});

/**
 * #276's fourth acceptance check, where it actually touches the filesystem: an artifact whose file
 * changed after it was validated must not keep its earlier "checked" status. Real files in a real
 * temp directory rather than a mocked `fs` -- the whole behaviour under test is "what is on disk
 * right now versus what was accepted", which a mock would be free to agree with either way.
 */
describe('readAcceptedArtifactBytes (#276 acceptance check 4)', () => {
  const ACCEPTED_BYTES = Buffer.from('%PDF-1.7 the document that passed the acceptance contract');
  let directory: string;
  let storagePath: string;

  beforeAll(() => {
    directory = mkdtempSync(join(tmpdir(), 'ovr-artifact-'));
    storagePath = join(directory, 'resume.pdf');
    writeFileSync(storagePath, ACCEPTED_BYTES);
  });

  afterAll(() => {
    rmSync(directory, { recursive: true, force: true });
  });

  function record(contentHash: string) {
    return { id: 'artifact-1', fileName: 'resume.pdf', contentHash, storagePath };
  }

  it('returns the bytes when the file still hashes to what was accepted', async () => {
    const bytes = await readAcceptedArtifactBytes(record(hashDocumentBytes(ACCEPTED_BYTES)));
    expect(bytes.equals(ACCEPTED_BYTES)).toBe(true);
  });

  it('refuses when the file has been re-rendered or edited since it was accepted', async () => {
    const stale = record(hashDocumentBytes(Buffer.from('%PDF-1.7 an earlier draft that was the one actually reviewed')));
    await expect(readAcceptedArtifactBytes(stale)).rejects.toBeInstanceOf(AcceptedBytesChangedError);
  });

  it('names both hashes in the refusal, so the cause is not guesswork', async () => {
    const stale = record('0'.repeat(64));
    await expect(readAcceptedArtifactBytes(stale)).rejects.toThrow(/no longer matches the bytes that were validated/);
  });

  it('still refuses a file swapped for a different, perfectly valid document', async () => {
    // The failure this exists for is not corruption: it is the right kind of file with the wrong
    // content, which every check short of a hash comparison would happily accept.
    const otherDocument = join(directory, 'someone-else.pdf');
    writeFileSync(otherDocument, Buffer.from('%PDF-1.7 a different, entirely well-formed document'));
    await expect(
      readAcceptedArtifactBytes({ id: 'artifact-2', fileName: 'someone-else.pdf', contentHash: hashDocumentBytes(ACCEPTED_BYTES), storagePath: otherDocument }),
    ).rejects.toBeInstanceOf(AcceptedBytesChangedError);
  });
});
