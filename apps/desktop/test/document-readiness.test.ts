import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { hashDocumentBytes } from '../electron/document-acceptance.js';
import {
  AcceptedBytesChangedError,
  checkDocumentReadiness,
  readAcceptedArtifactBytes,
  type DocumentReadinessInput,
} from '../electron/document-readiness.js';

/**
 * #276's third and fourth acceptance checks, at the level where "requested" and "accepted" are
 * still distinguishable from "whatever files happen to exist": a requested cover letter that never
 * got produced must refuse rather than reporting ready on the CV alone, and an output whose bytes
 * changed after validation must invalidate the earlier verdict rather than carrying it over.
 *
 * All hashes here are stand-in literals; `document-acceptance.test.ts` covers the real sha256.
 */

const TARGET = { company: 'Northwind Freight', role: 'Logistics Platform Engineer' };

function baseInput(overrides: Partial<DocumentReadinessInput> = {}): DocumentReadinessInput {
  return {
    requested: ['cv', 'cover_letter'],
    accepted: [
      { kind: 'cv', acceptedContentHash: 'cv-hash-1', acceptedTarget: TARGET },
      { kind: 'cover_letter', acceptedContentHash: 'letter-hash-1', acceptedTarget: TARGET },
    ],
    present: [
      { kind: 'cv', currentContentHash: 'cv-hash-1' },
      { kind: 'cover_letter', currentContentHash: 'letter-hash-1' },
    ],
    target: TARGET,
    ...overrides,
  };
}

describe('checkDocumentReadiness -- a requested document that is missing (#276 acceptance check 3)', () => {
  it('reports ready when every requested document is present, accepted and unchanged', () => {
    const result = checkDocumentReadiness(baseInput());
    expect(result.ok).toBe(true);
    expect(result.refusals).toEqual([]);
  });

  it('refuses when the requested cover letter was never produced, even though the CV is perfect', () => {
    const result = checkDocumentReadiness(
      baseInput({
        accepted: [{ kind: 'cv', acceptedContentHash: 'cv-hash-1', acceptedTarget: TARGET }],
        present: [{ kind: 'cv', currentContentHash: 'cv-hash-1' }],
      }),
    );
    expect(result.ok).toBe(false);
    expect(result.refusals).toEqual([{ reason: 'requested_document_missing', kind: 'cover_letter', detail: expect.stringContaining('cover letter') }]);
  });

  it('hands back no verified hashes at all when anything refused, so nothing partial can be attached', () => {
    const result = checkDocumentReadiness(baseInput({ present: [{ kind: 'cv', currentContentHash: 'cv-hash-1' }] }));
    expect(result.verifiedContentHashes).toEqual([]);
  });

  it('does not require a cover letter that was never requested', () => {
    const result = checkDocumentReadiness(
      baseInput({
        requested: ['cv'],
        accepted: [{ kind: 'cv', acceptedContentHash: 'cv-hash-1', acceptedTarget: TARGET }],
        present: [{ kind: 'cv', currentContentHash: 'cv-hash-1' }],
      }),
    );
    expect(result.ok).toBe(true);
  });

  it('refuses a file that exists but was never checked against the acceptance contract', () => {
    const result = checkDocumentReadiness(baseInput({ accepted: [{ kind: 'cv', acceptedContentHash: 'cv-hash-1', acceptedTarget: TARGET }] }));
    expect(result.refusals.map((refusal) => refusal.reason)).toEqual(['document_never_accepted']);
  });

  it('collects every refusal rather than stopping at the first', () => {
    const result = checkDocumentReadiness(
      baseInput({
        accepted: [],
        present: [
          { kind: 'cv', currentContentHash: 'cv-hash-1' },
          { kind: 'cover_letter', currentContentHash: 'letter-hash-1' },
        ],
      }),
    );
    expect(result.refusals).toHaveLength(2);
  });

  it('lets one combined pack answer a request for both the CV and the letter', () => {
    const result = checkDocumentReadiness(
      baseInput({
        accepted: [{ kind: 'combined', acceptedContentHash: 'combined-hash-1', acceptedTarget: TARGET }],
        present: [{ kind: 'combined', currentContentHash: 'combined-hash-1' }],
      }),
    );
    expect(result.ok).toBe(true);
    expect(result.verifiedContentHashes).toEqual([
      { kind: 'cv', contentHash: 'combined-hash-1' },
      { kind: 'cover_letter', contentHash: 'combined-hash-1' },
    ]);
  });

  it('does not let a cover letter stand in for a requested motivation letter', () => {
    const result = checkDocumentReadiness(
      baseInput({
        requested: ['motivation_letter'],
        accepted: [{ kind: 'cover_letter', acceptedContentHash: 'letter-hash-1', acceptedTarget: TARGET }],
        present: [{ kind: 'cover_letter', currentContentHash: 'letter-hash-1' }],
      }),
    );
    expect(result.refusals.map((refusal) => refusal.reason)).toEqual(['requested_document_missing']);
  });
});

describe('checkDocumentReadiness -- changed output invalidates the earlier verdict (#276 acceptance check 4)', () => {
  it('refuses when the CV on disk is no longer the CV that was validated', () => {
    const result = checkDocumentReadiness(baseInput({ present: [{ kind: 'cv', currentContentHash: 'cv-hash-2-rerendered' }, { kind: 'cover_letter', currentContentHash: 'letter-hash-1' }] }));
    expect(result.ok).toBe(false);
    expect(result.refusals).toEqual([{ reason: 'accepted_bytes_changed', kind: 'cv', detail: expect.stringContaining('no longer describes it') }]);
  });

  it('refuses when the letter changed, even though the CV is still exactly what was accepted', () => {
    const result = checkDocumentReadiness(baseInput({ present: [{ kind: 'cv', currentContentHash: 'cv-hash-1' }, { kind: 'cover_letter', currentContentHash: 'letter-hash-2-edited' }] }));
    expect(result.refusals.map((refusal) => refusal.kind)).toEqual(['cover_letter']);
  });

  it('hands the attachment step the accepted hash, never one re-derived from the file it is about to send', () => {
    const result = checkDocumentReadiness(baseInput());
    expect(result.verifiedContentHashes).toEqual([
      { kind: 'cv', contentHash: 'cv-hash-1' },
      { kind: 'cover_letter', contentHash: 'letter-hash-1' },
    ]);
  });

  it('refuses a document that was validated for a different vacancy than this application', () => {
    const result = checkDocumentReadiness(
      baseInput({
        accepted: [
          { kind: 'cv', acceptedContentHash: 'cv-hash-1', acceptedTarget: { company: 'Some Other Employer', role: 'Logistics Platform Engineer' } },
          { kind: 'cover_letter', acceptedContentHash: 'letter-hash-1', acceptedTarget: TARGET },
        ],
      }),
    );
    expect(result.refusals.map((refusal) => refusal.reason)).toEqual(['accepted_for_a_different_target']);
  });

  it('matches the target case-insensitively and ignoring surrounding whitespace', () => {
    const result = checkDocumentReadiness(
      baseInput({
        accepted: [
          { kind: 'cv', acceptedContentHash: 'cv-hash-1', acceptedTarget: { company: ' northwind freight ', role: 'LOGISTICS PLATFORM ENGINEER' } },
          { kind: 'cover_letter', acceptedContentHash: 'letter-hash-1', acceptedTarget: TARGET },
        ],
      }),
    );
    expect(result.ok).toBe(true);
  });

  it('refuses a targeted document when the application itself records no target, rather than passing it', () => {
    const result = checkDocumentReadiness(baseInput({ target: null }));
    expect(result.ok).toBe(false);
    expect(result.refusals.map((refusal) => refusal.reason)).toEqual(['accepted_for_a_different_target', 'accepted_for_a_different_target']);
  });
});

/**
 * The same acceptance check where it actually touches the filesystem. Real files in a real temp
 * directory rather than a mocked `fs` -- the whole behaviour under test is "what is on disk right
 * now versus what was accepted", which a mock would be free to agree with either way.
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
    return { fileName: 'resume.pdf', contentHash, storagePath };
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
    await expect(readAcceptedArtifactBytes(record('0'.repeat(64)))).rejects.toThrow(/no longer matches the bytes that were validated/);
  });

  it('still refuses a file swapped for a different, perfectly valid document', async () => {
    // The failure this exists for is not corruption: it is the right kind of file with the wrong
    // content, which every check short of a hash comparison would happily accept.
    const otherDocument = join(directory, 'someone-else.pdf');
    writeFileSync(otherDocument, Buffer.from('%PDF-1.7 a different, entirely well-formed document'));
    await expect(
      readAcceptedArtifactBytes({ fileName: 'someone-else.pdf', contentHash: hashDocumentBytes(ACCEPTED_BYTES), storagePath: otherDocument }),
    ).rejects.toBeInstanceOf(AcceptedBytesChangedError);
  });
});
