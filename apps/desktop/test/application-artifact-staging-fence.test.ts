// @vitest-environment node
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DocumentAcceptanceContract } from '../electron/document-acceptance.js';

/**
 * The trailing edge of the preparation fence, where `application-pipeline.ts` cannot reach.
 *
 * `application-pipeline.test.ts`'s "never lets a PDF render that was already in flight overwrite the
 * replacement run's documents" covers the case where the fence has *already* moved by the time an
 * abandoned run's render returns. This file covers the narrower one underneath it: the fence moves
 * while `writeAndRegisterArtifact` is running, after its own entry check has passed. Nothing in this
 * process can recall the `writeFile` that is by then in flight, so the guarantee has to come from
 * ordering (every irreversible row write happens after a second, trailing check, with no `await`
 * between them) plus a compensating delete of the file that did land.
 *
 * Driven against a real temp directory and a real workspace database rather than mocked `fs` and a
 * mocked repository, the same way `application-artifact-staging-permissions.test.ts` does it: the
 * whole claim here is about what is left on disk and in the artifact table afterwards, which a mock
 * would only be able to restate.
 */

const { pdfQueue } = vi.hoisted(() => ({ pdfQueue: [] as Buffer[] }));

vi.mock('electron', () => ({
  BrowserWindow: class {
    webContents = {
      printToPDF: async (): Promise<Buffer> => pdfQueue.shift() ?? Buffer.from('%PDF-1.4 unexpected extra render'),
    };
    async loadURL(): Promise<void> {}
    destroy(): void {}
  },
}));

// The acceptance contract itself is covered exhaustively by `document-acceptance.test.ts`; what
// matters here is only that each distinct set of bytes gets its own content hash, because the hash
// is what the staged file is named after -- and therefore what decides whether two runs collide on
// one path or land on two.
const { acceptRenderedDocument } = vi.hoisted(() => ({
  acceptRenderedDocument: vi.fn(async (bytes: Uint8Array) => ({
    ok: true,
    contentHash: createHash('sha256').update(bytes).digest('hex'),
    findings: [],
  })),
}));
vi.mock('../electron/document-acceptance.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  acceptRenderedDocument,
}));

const { createWorkspaceDb } = await import('../electron/workspace/client.js');
const { stageHtmlArtifact, StagingAbandonedError } = await import('../electron/application-artifact-staging.js');
const workspace = await import('../electron/workspace/repository.js');
import type { WorkspaceDb } from '../electron/workspace/client.js';

const FAKE_CONTRACT = {
  kind: 'cover_letter',
  identity: { candidateName: 'Test Candidate', documentKind: 'cover_letter' },
  requiredContent: [],
  requiredLinks: [],
  target: null,
  targetRule: 'none',
  employmentHistoryText: [],
  verifiedEmployers: [],
  pageBounds: { min: 1, max: 1 },
} as unknown as DocumentAcceptanceContract;

const FILE_NAME = 'cover-letter.pdf';

/**
 * A fence that is this run's when staging begins and somebody else's by the time the bytes are on
 * disk -- true for the check on entry, false for the trailing one.
 *
 * Not a contrived sequence: it is precisely the window the fence cannot close, since the entry check
 * and the write are separated by three `await`s during which the worker can hit its ceiling, hand
 * the lease back and let a replacement run take the attempt. Asking the real fence to move at that
 * exact instant would mean racing the event loop and hoping; saying it directly makes the same run
 * deterministic.
 */
function movesDuringTheWrite(): () => boolean {
  let checks = 0;
  return () => checks++ === 0;
}

let dir: string;
let storageRoot: string;
let db: WorkspaceDb;
let close: () => void;
let attemptId: string;

function stage(pdf: string, stillLive?: () => boolean) {
  pdfQueue.push(Buffer.from(pdf));
  return stageHtmlArtifact({
    db,
    attemptId,
    html: '<html><body>cover letter</body></html>',
    contract: FAKE_CONTRACT,
    fileName: FILE_NAME,
    storageRoot,
    ...(stillLive ? { stillLive } : {}),
  });
}

function stagedFiles(): string[] {
  const attemptDirectory = join(storageRoot, attemptId);
  return existsSync(attemptDirectory) ? readdirSync(attemptDirectory).sort() : [];
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ovr-artifact-fence-test-'));
  storageRoot = join(dir, 'application-artifacts');
  ({ db, close } = createWorkspaceDb(join(dir, 'userData')));
  pdfQueue.length = 0;
  // `createApplicationArtifact` insists on a real attempt row, so every test here stages against
  // one rather than a made-up id.
  attemptId = workspace.createApplicationAttempt(db, {
    company: 'Northwind Freight',
    role: 'Logistics Platform Engineer',
    sourceCvContentHash: 'a'.repeat(64),
    jdSnapshotHash: 'b'.repeat(64),
  }).id;
});

afterEach(() => {
  close();
  rmSync(dir, { recursive: true, force: true });
});

describe('writeAndRegisterArtifact: a fence that moves mid-write', () => {
  it('registers nothing and leaves no file behind when the run is abandoned after its PDF is written', async () => {
    await expect(stage('%PDF-1.4 abandoned run', movesDuringTheWrite())).rejects.toBeInstanceOf(StagingAbandonedError);

    expect(workspace.listApplicationArtifacts(db, attemptId)).toEqual([]);
    // The write really did happen -- that is the window this exists for -- and was then undone.
    expect(stagedFiles()).toEqual([]);
  });

  it('never takes the live run\'s registered document down with it', async () => {
    // The replacement run has already finished: its row is the attempt's current cover letter and
    // its file is what the pre-submit gate reads. Then the abandoned run wakes up inside staging.
    const live = await stage('%PDF-1.4 the replacement run\'s letter');
    const liveFiles = stagedFiles();

    await expect(stage('%PDF-1.4 the abandoned run\'s letter', movesDuringTheWrite())).rejects.toBeInstanceOf(StagingAbandonedError);

    // Before this ordering, the abandoned run deleted the superseded row and its file on the way in,
    // so the live attempt was left with no document at all while its form still held one.
    expect(workspace.listApplicationArtifacts(db, attemptId)).toEqual([live]);
    expect(stagedFiles()).toEqual(liveFiles);
    expect(existsSync(live.storagePath)).toBe(true);
  });

  it('leaves the file alone when the live run produced byte-identical content', async () => {
    // Staged files are named after their content hash, so a replacement run that rendered exactly
    // the same letter -- the likely outcome of re-preparing one attempt, not an exotic one -- owns
    // the very path the abandoned run just wrote. Compensating by path alone would delete it.
    const live = await stage('%PDF-1.4 identical letter');

    await expect(stage('%PDF-1.4 identical letter', movesDuringTheWrite())).rejects.toBeInstanceOf(StagingAbandonedError);

    expect(workspace.listApplicationArtifacts(db, attemptId)).toEqual([live]);
    expect(existsSync(live.storagePath)).toBe(true);
  });

  it('still replaces the previous artifact, row and file, on the ordinary path', async () => {
    // The other half of moving the supersede step after the write: a run that is genuinely live must
    // go on leaving exactly one current artifact behind, not an accumulating history.
    const first = await stage('%PDF-1.4 first letter');
    const second = await stage('%PDF-1.4 second letter');

    expect(workspace.listApplicationArtifacts(db, attemptId)).toEqual([second]);
    expect(existsSync(second.storagePath)).toBe(true);
    expect(existsSync(first.storagePath)).toBe(false);
    expect(stagedFiles()).toHaveLength(1);
  });

  it('re-staging identical content with no fence at all never deletes the file it just wrote', async () => {
    // No abandonment anywhere in this one -- both calls are genuinely live. The superseded-file
    // cleanup loop at the end of `writeAndRegisterArtifact` walks every artifact the new row just
    // replaced and deletes its file, skipping only the exact path the new row itself was just
    // written to. A re-stage of byte-identical content (the same CV re-tailored from the same
    // source against the same vacancy -- an ordinary retry, not an edge case) supersedes a row
    // whose file lives at that very path: without the skip, this loop would delete the file the
    // call itself just wrote and returned a record pointing at, immediately turning a normal
    // re-stage into a registered row with nothing on disk behind it.
    const first = await stage('%PDF-1.4 identical letter, no fence involved');
    const second = await stage('%PDF-1.4 identical letter, no fence involved');

    expect(second.storagePath).toBe(first.storagePath);
    expect(workspace.listApplicationArtifacts(db, attemptId)).toEqual([second]);
    expect(existsSync(second.storagePath)).toBe(true);
    expect(stagedFiles()).toHaveLength(1);
  });
});
