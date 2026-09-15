// @vitest-environment node
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DocumentAcceptanceContract } from '../electron/document-acceptance.js';

/**
 * A staged CV/letter PDF carries the same sensitive CV text and contact info as `workspace.db`
 * itself, so it gets the same explicit 0700/0600 hardening -- see
 * `workspace-client-permissions.test.ts` for the `workspace.db` counterpart this mirrors.
 * POSIX-only: these assertions are skipped on win32, where POSIX mode bits are a no-op.
 *
 * `electron`'s `BrowserWindow` is mocked (as every other test in this suite that imports this
 * module does) so this can run in a plain Node test process; the acceptance contract check itself
 * is stubbed to always accept, since what's under test here is the write path's file modes, not
 * the acceptance logic already covered by `document-acceptance.test.ts` and
 * `application-pipeline.test.ts`'s end-to-end run.
 */
vi.mock('electron', () => ({
  BrowserWindow: class {
    webContents = {
      printToPDF: async (): Promise<Buffer> => Buffer.from('%PDF-1.4 fake pdf bytes'),
    };
    async loadURL(): Promise<void> {}
    destroy(): void {}
  },
}));

const { acceptRenderedDocument } = vi.hoisted(() => ({
  acceptRenderedDocument: vi.fn(async () => ({ ok: true, contentHash: 'test-content-hash', findings: [] })),
}));
vi.mock('../electron/document-acceptance.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  acceptRenderedDocument,
}));

const { createWorkspaceDb } = await import('../electron/workspace/client.js');
const { stageHtmlArtifact } = await import('../electron/application-artifact-staging.js');
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

let dir: string;
let db: WorkspaceDb;
let close: () => void;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ovr-artifact-perm-test-'));
  ({ db, close } = createWorkspaceDb(join(dir, 'userData')));
});

afterEach(() => {
  close();
  rmSync(dir, { recursive: true, force: true });
});

describe('stageHtmlArtifact: filesystem permissions (POSIX)', () => {
  it('writes the staged PDF and its attempt directory with restrictive modes', async () => {
    if (process.platform === 'win32') return;
    const storageRoot = join(dir, 'application-artifacts');
    const attemptId = 'attempt-1';

    const record = await stageHtmlArtifact({
      db,
      attemptId,
      html: '<html><body>cover letter</body></html>',
      contract: FAKE_CONTRACT,
      fileName: 'cover-letter.pdf',
      storageRoot,
    });

    expect(statSync(record.storagePath).mode & 0o777).toBe(0o600);
    expect(statSync(join(storageRoot, attemptId)).mode & 0o777).toBe(0o700);
  });
});
