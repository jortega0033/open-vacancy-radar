import { createHash } from 'node:crypto';
import { basename } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ALLOWED_CDP_METHODS, type CdpDomNode } from '@agent-dock/application-executor';
import { stagedArtifactPath } from '../electron/application-artifact-staging.js';
import { FIXTURE_REVIEW_POLICY } from '../electron/application-target-policies.js';

// The real fixture policy's own allowed URL, not an arbitrary literal -- since #201's review fix,
// `openTarget` refuses any file:// URL not in `exactFileUrls`, so this must be the exact one.
const FIXTURE_URL = FIXTURE_REVIEW_POLICY.exactFileUrls![0]!;

/**
 * Exercises `application-review-session.ts`'s registry/validate/apply orchestration against a
 * fake `CdpTransport` (via a mocked `application-view.js`), the same layering
 * `application-view.test.ts` uses one level down: that file proves the real `webContents.debugger`
 * wiring; this file proves what sits on top of it, without re-proving either half against the
 * other. `packages/application-executor`'s own suite already proves the executor/validator
 * mechanics in isolation -- this file is about the sequencing this module adds: duplicate-open
 * refusal, unknown-policy refusal, validate-then-apply, and cleanup on both the happy and the
 * failure path.
 */
const { createApplicationView } = vi.hoisted(() => ({ createApplicationView: vi.fn() }));
const workspaceMock = vi.hoisted(() => ({
  getApplicationAttempt: vi.fn(),
  listApplicationAttempts: vi.fn(() => [] as unknown[]),
  listCvDocuments: vi.fn(() => [] as Array<{ id: string; text: string }>),
  listApplicationArtifacts: vi.fn((_db: unknown, _attemptId: string) => [] as unknown[]),
  updateApplicationAttempt: vi.fn(),
  findActiveAutomationGrant: vi.fn(() => undefined as unknown),
  // Mirrors the real class's constructor: application-review-session.ts imports this from the
  // same mocked module and does `err instanceof WorkspaceNotFoundError`, which only works if both
  // sides resolve to the identical class reference.
  WorkspaceNotFoundError: class WorkspaceNotFoundError extends Error {
    constructor(entity: string, id: string) {
      super(`no ${entity} with id "${id}"`);
      this.name = 'WorkspaceNotFoundError';
    }
  },
}));
const { extractPdfText } = vi.hoisted(() => ({ extractPdfText: vi.fn(async () => '') }));
const { notifyAutomaticSubmission } = vi.hoisted(() => ({ notifyAutomaticSubmission: vi.fn() }));

vi.mock('../electron/application-view.js', () => ({ createApplicationView }));
vi.mock('../electron/workspace/repository.js', () => workspaceMock);
vi.mock('../electron/cv-text.js', () => ({ extractPdfText }));
vi.mock('../electron/automatic-submission-notify.js', () => ({ notifyAutomaticSubmission }));
const { readFile, mkdir, writeFile } = vi.hoisted(() => ({
  readFile: vi.fn(async (_path: string): Promise<Buffer> => Buffer.from('')),
  mkdir: vi.fn(async () => undefined),
  writeFile: vi.fn(async () => undefined),
}));
vi.mock('node:fs/promises', () => ({ readFile, mkdir, writeFile, default: { readFile, mkdir, writeFile } }));
// Nothing in this path may ever open a native file chooser: an attachment is resolved from the
// attempt's own registered artifacts, never picked. Mocked (rather than left unmocked) so the
// assertion that it stays untouched is a real one -- see the "no native file picker" test below.
const { dialog } = vi.hoisted(() => ({ dialog: { showOpenDialog: vi.fn(), showSaveDialog: vi.fn() } }));
vi.mock('electron', () => ({ dialog }));

/**
 * The hash of the bytes the mocked `readFile` hands back. #276 reads every staged artifact through
 * `readAcceptedArtifactBytes`, which refuses unless the file still hashes to what the artifact row
 * recorded at acceptance time -- so a mocked artifact has to carry the hash of its own mocked
 * content, exactly as a real staged one does.
 */
const STAGED_ARTIFACT_HASH = createHash('sha256').update(new Uint8Array()).digest('hex');

function stagedArtifact(kind: string, storagePath: string, contentHash: string = STAGED_ARTIFACT_HASH) {
  return { kind, storagePath, contentHash };
}

const TREE: CdpDomNode = {
  nodeName: 'BODY',
  nodeType: 1,
  backendNodeId: 1,
  children: [
    { nodeName: 'INPUT', nodeType: 1, backendNodeId: 2, attributes: ['type', 'text', 'name', 'fullName', 'required', ''] },
    {
      nodeName: 'SELECT',
      nodeType: 1,
      backendNodeId: 3,
      attributes: ['name', 'workAuthorization'],
      children: [
        { nodeName: 'OPTION', nodeType: 1, backendNodeId: 4, attributes: ['value', 'yes'], children: [{ nodeName: '#text', nodeType: 3, backendNodeId: 5, nodeValue: 'Yes' }] },
        { nodeName: 'OPTION', nodeType: 1, backendNodeId: 6, attributes: ['value', 'no'], children: [{ nodeName: '#text', nodeType: 3, backendNodeId: 7, nodeValue: 'No' }] },
      ],
    },
    { nodeName: 'INPUT', nodeType: 1, backendNodeId: 8, attributes: ['type', 'checkbox', 'name', 'hasDriversLicense'] },
  ],
};

const SUBMIT_TREE: CdpDomNode = {
  ...TREE,
  children: [...TREE.children!, { nodeName: 'BUTTON', nodeType: 1, backendNodeId: 9, children: [{ nodeName: '#text', nodeType: 3, backendNodeId: 10, nodeValue: 'Submit Application' }] }],
};

/** Every `backendNodeId` in `tree` that belongs to an `<input type="file">`, so the fake below can
 * answer an accessibility read-back for exactly the controls a real browser would have one for. */
function fileInputNodeIds(node: CdpDomNode): number[] {
  const attributes = node.attributes ?? [];
  const isFileInput =
    node.nodeName === 'INPUT' &&
    attributes.some((value, index) => index % 2 === 0 && value.toLowerCase() === 'type' && attributes[index + 1] === 'file');
  return [...(isFileInput ? [node.backendNodeId] : []), ...(node.children ?? []).flatMap(fileInputNodeIds)];
}

/**
 * A fake CDP transport that models the one browser behavior #273's read-back depends on: a file
 * input reports whatever file is currently selected on it as its own accessible value, and
 * `DOM.setFileInputFiles` *replaces* that selection rather than adding to it. An untouched file
 * input reports Chromium's own placeholder instead, which is what an attachment that silently
 * failed looks like from the outside.
 */
function fakeView(tree: CdpDomNode = TREE) {
  const selectedFiles = new Map<number, readonly string[]>();
  const sendCommand = vi.fn(async (method: string, params?: Record<string, unknown>) => {
    switch (method) {
      case 'Page.navigate':
        return {};
      case 'DOM.getDocument':
        return { root: tree };
      case 'Page.captureScreenshot':
        return { data: 'ZmFrZS1zY3JlZW5zaG90' };
      case 'DOM.getBoxModel':
        return { model: { content: [0, 0, 10, 0, 10, 10, 0, 10] } };
      case 'DOM.setFileInputFiles': {
        const { backendNodeId, files } = (params ?? {}) as { backendNodeId: number; files: readonly string[] };
        selectedFiles.set(backendNodeId, files);
        return {};
      }
      case 'Accessibility.getFullAXTree':
        return {
          nodes: fileInputNodeIds(tree).map((backendDOMNodeId) => {
            const files = selectedFiles.get(backendDOMNodeId) ?? [];
            const reported = files.length === 0 ? 'No file chosen' : files.map((file) => basename(file)).join(', ');
            return { backendDOMNodeId, value: { type: 'string', value: reported } };
          }),
        };
      case 'DOM.focus':
      case 'Input.insertText':
      case 'Input.dispatchKeyEvent':
      case 'Input.dispatchMouseEvent':
        return {};
      default:
        throw new Error(`unexpected CDP method in test: ${method} ${JSON.stringify(params)}`);
    }
  });
  return { view: {}, transport: { sendCommand }, show: vi.fn(), hide: vi.fn(), destroy: vi.fn(), selectedFiles };
}

const FAKE_DB = {} as never;

const ATTEMPT_ID = '11111111-1111-4111-8111-111111111111';

/**
 * A synthetic staging area: `path -> bytes`, served by the mocked `node:fs/promises.readFile`. All
 * paths are computed by `stagedArtifactPath` from a fake storage root, so nothing here names a real
 * location on the machine running the test.
 */
const STORAGE_ROOT = '/synthetic-staging-root';
const stagedFiles = new Map<string, Buffer>();

function sha256Hex(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/** Writes `bytes` into the synthetic staging area under `attemptId`'s own folder and returns the
 * artifact record #198 would have registered for them. */
function stageArtifact(
  id: string,
  fileName: string,
  bytes: Buffer,
  overrides: Partial<Record<string, unknown>> = {},
  attemptId: string = ATTEMPT_ID,
) {
  const contentHash = sha256Hex(bytes);
  const storagePath = stagedArtifactPath(STORAGE_ROOT, attemptId, contentHash, fileName);
  stagedFiles.set(storagePath, bytes);
  return {
    id,
    attemptId,
    kind: 'cv_pdf',
    fileName,
    mimeType: 'application/pdf',
    byteSize: bytes.byteLength,
    contentHash,
    storagePath,
    createdAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

/** Points the mocked `readFile` at the synthetic staging area, so an artifact whose bytes were
 * never staged (or were removed) fails the same way a real missing file does. */
function serveStagedFiles(): void {
  readFile.mockImplementation(async (path: string) => {
    const bytes = stagedFiles.get(path);
    if (bytes === undefined) throw new Error(`ENOENT: no such file or directory, open '${path}'`);
    return bytes;
  });
}

function fakeAttempt(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: ATTEMPT_ID,
    applicationId: null,
    vacancyKey: null,
    canonicalUrl: FIXTURE_URL,
    company: 'Acme Corp',
    role: 'Senior Engineer',
    sourceCvId: null,
    sourceCvContentHash: 'cv-hash-v1',
    jdSnapshot: 'We are hiring a Senior Engineer at Acme Corp.',
    jdSnapshotHash: '',
    jdComplete: true,
    workflowVersion: 'v1',
    checkpoint: 'ready',
    checkpointDetail: '',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    submittedAt: null,
    formStructureHash: null,
    scheduledAutomaticSubmitAt: null,
    submissionMode: null,
    ...overrides,
  };
}

function withRealJdHash<T extends { jdSnapshot: string }>(attempt: T): T & { jdSnapshotHash: string } {
  // submitApplicationReview recomputes the JD hash from jdSnapshot itself (sha256), so a fixture
  // attempt must carry the real hash of its own jdSnapshot text for the gate to pass, matching how
  // a genuinely-created attempt would have been hashed at creation time.
  return { ...attempt, jdSnapshotHash: createHash('sha256').update(attempt.jdSnapshot).digest('hex') };
}

/** Mirrors `application-review-session.ts`'s own `computeFormStructureHash` exactly, so a test can
 * fabricate a "prior submission with a matching structure" fixture. */
function computeExpectedFormStructureHash(fields: readonly { label: string; controlType: string; required: boolean }[]): string {
  const structure = fields.map((f) => JSON.stringify([f.label, f.controlType, f.required])).sort();
  return createHash('sha256').update(JSON.stringify(structure)).digest('hex');
}

beforeEach(() => {
  createApplicationView.mockReset();
  createApplicationView.mockImplementation(() => fakeView());
  workspaceMock.getApplicationAttempt.mockReset();
  workspaceMock.listApplicationAttempts.mockReset().mockReturnValue([]);
  workspaceMock.listCvDocuments.mockReset().mockReturnValue([]);
  workspaceMock.listApplicationArtifacts.mockReset().mockReturnValue([]);
  workspaceMock.updateApplicationAttempt.mockReset();
  workspaceMock.findActiveAutomationGrant.mockReset().mockReturnValue(undefined);
  notifyAutomaticSubmission.mockReset();
  extractPdfText.mockReset().mockResolvedValue('');
  dialog.showOpenDialog.mockReset();
  dialog.showSaveDialog.mockReset();
  // Reset rather than left standing: several tests below install a per-path implementation, and a
  // leaked one would silently change what a later test's artifact reads back as.
  readFile.mockReset().mockImplementation(async () => Buffer.from(''));
  stagedFiles.clear();
});

async function importSession() {
  vi.resetModules();
  return import('../electron/application-review-session.js');
}

describe('application-review-session', () => {
  it('opens a review, returning a real multi-field snapshot and a screenshot', async () => {
    const { openApplicationReview } = await importSession();
    const result = await openApplicationReview({
      attemptId: '11111111-1111-4111-8111-111111111111',
      policyId: 'ashby-fixture-test-only',
      targetUrl: FIXTURE_URL,
    });
    expect(result.screenshotBase64).toBe('ZmFrZS1zY3JlZW5zaG90');
    expect(result.snapshot.fields).toHaveLength(3);
    expect(result.snapshot.fields.map((f) => f.label)).toEqual(['fullName', 'workAuthorization', 'hasDriversLicense']);
  });

  it('refuses an unknown policy id before ever creating a view', async () => {
    const { openApplicationReview } = await importSession();
    await expect(
      openApplicationReview({ attemptId: '11111111-1111-4111-8111-111111111111', policyId: 'not-a-real-policy', targetUrl: FIXTURE_URL }),
    ).rejects.toThrow(/unknown application target policy/);
    expect(createApplicationView).not.toHaveBeenCalled();
  });

  it('refuses to open a second review for an attempt that already has one open', async () => {
    const { openApplicationReview } = await importSession();
    await openApplicationReview({ attemptId: '11111111-1111-4111-8111-111111111111', policyId: 'ashby-fixture-test-only', targetUrl: FIXTURE_URL });
    await expect(
      openApplicationReview({ attemptId: '11111111-1111-4111-8111-111111111111', policyId: 'ashby-fixture-test-only', targetUrl: FIXTURE_URL }),
    ).rejects.toThrow(/already has an open review/);
  });

  it('destroys the view when openTarget refuses an off-policy origin, leaving no leaked registration', async () => {
    const { openApplicationReview } = await importSession();
    const view = fakeView();
    createApplicationView.mockImplementation(() => view);
    await expect(
      openApplicationReview({ attemptId: '11111111-1111-4111-8111-111111111111', policyId: 'ashby-fixture-test-only', targetUrl: 'https://evil.example/apply' }),
    ).rejects.toThrow(/not allowed by policy/);
    expect(view.destroy).toHaveBeenCalledTimes(1);

    // The failed attempt's id is free to retry, proving nothing was left registered for it.
    await expect(
      openApplicationReview({ attemptId: '11111111-1111-4111-8111-111111111111', policyId: 'ashby-fixture-test-only', targetUrl: FIXTURE_URL }),
    ).resolves.toBeDefined();
  });

  it('applies a valid field map: fills the text field, selects the option, fills the checkbox', async () => {
    const { openApplicationReview, applyApplicationFieldMap } = await importSession();
    const view = fakeView();
    createApplicationView.mockImplementation(() => view);
    const opened = await openApplicationReview({ attemptId: '11111111-1111-4111-8111-111111111111', policyId: 'ashby-fixture-test-only', targetUrl: FIXTURE_URL });

    const nameField = opened.snapshot.fields.find((f) => f.label === 'fullName')!;
    const authField = opened.snapshot.fields.find((f) => f.label === 'workAuthorization')!;
    const licenseField = opened.snapshot.fields.find((f) => f.label === 'hasDriversLicense')!;
    const yesOption = authField.options!.find((o) => o.label === 'Yes')!;

    const result = await applyApplicationFieldMap(FAKE_DB, {
      attemptId: '11111111-1111-4111-8111-111111111111',
      valueTable: [{ valueRef: 'v0000000000000001', value: 'Ada Lovelace', provenance: 'profile' }, { valueRef: 'v0000000000000002', value: 'true', provenance: 'user_answer' }],
      fieldMap: {
        attemptId: '11111111-1111-4111-8111-111111111111',
        snapshotGeneration: opened.snapshot.generation,
        assignments: [
          { fieldRef: nameField.fieldRef, source: { kind: 'value', valueRef: 'v0000000000000001' } },
          { fieldRef: authField.fieldRef, source: { kind: 'option', optionRef: yesOption.optionRef } },
          { fieldRef: licenseField.fieldRef, source: { kind: 'value', valueRef: 'v0000000000000002' } },
        ],
        unmapped: [],
      },
    });

    expect(result).toEqual({ ok: true, appliedCount: 3 });
    const calledMethods = view.transport.sendCommand.mock.calls.map(([method]) => method as string);
    expect(calledMethods).toContain('Input.insertText'); // fullName
    expect(calledMethods).toContain('Input.dispatchKeyEvent'); // select's arrow/enter drive
    expect(calledMethods).toContain('Input.dispatchMouseEvent'); // checkbox click
  });

  it('refuses (never partially applies) a field map targeting a stale snapshot generation', async () => {
    const { openApplicationReview, applyApplicationFieldMap } = await importSession();
    const opened = await openApplicationReview({ attemptId: '11111111-1111-4111-8111-111111111111', policyId: 'ashby-fixture-test-only', targetUrl: FIXTURE_URL });
    const nameField = opened.snapshot.fields.find((f) => f.label === 'fullName')!;

    const result = await applyApplicationFieldMap(FAKE_DB, {
      attemptId: '11111111-1111-4111-8111-111111111111',
      valueTable: [{ valueRef: 'v0000000000000001', value: 'Ada Lovelace', provenance: 'profile' }],
      fieldMap: {
        attemptId: '11111111-1111-4111-8111-111111111111',
        snapshotGeneration: opened.snapshot.generation + 1, // stale
        assignments: [{ fieldRef: nameField.fieldRef, source: { kind: 'value', valueRef: 'v0000000000000001' } }],
        unmapped: [],
      },
    });

    expect(result.ok).toBe(false);
    expect(result.reason).toBe('stale_snapshot_generation');
  });

  it('refuses an artifact assignment naming an id this attempt does not own', async () => {
    const { openApplicationReview, applyApplicationFieldMap } = await importSession();
    const opened = await openApplicationReview({ attemptId: '11111111-1111-4111-8111-111111111111', policyId: 'ashby-fixture-test-only', targetUrl: FIXTURE_URL });
    const nameField = opened.snapshot.fields.find((f) => f.label === 'fullName')!;

    const result = await applyApplicationFieldMap(FAKE_DB, {
      attemptId: '11111111-1111-4111-8111-111111111111',
      valueTable: [],
      fieldMap: {
        attemptId: '11111111-1111-4111-8111-111111111111',
        snapshotGeneration: opened.snapshot.generation,
        assignments: [{ fieldRef: nameField.fieldRef, source: { kind: 'artifact', artifactId: '33333333-3333-4333-8333-333333333333' } }],
        unmapped: [],
      },
    });

    expect(result.ok).toBe(false);
    expect(result.reason).toBe('artifact_not_owned');
  });

  it('throws when applying a field map for an attempt with no open review', async () => {
    const { applyApplicationFieldMap } = await importSession();
    await expect(
      applyApplicationFieldMap(FAKE_DB, { attemptId: '22222222-2222-4222-8222-222222222222', valueTable: [], fieldMap: { attemptId: '22222222-2222-4222-8222-222222222222', snapshotGeneration: 1, assignments: [], unmapped: [] } }),
    ).rejects.toThrow(/no open review/);
  });

  /**
   * #273: the application bridge used to hand `validateFieldMap` a permanently empty owned-artifact
   * set, so every `artifact` assignment was refused by construction -- an attempt could not attach
   * even its own CV. These cover the fixed path end to end, and every way it must still refuse.
   */
  describe('artifact attachments (#273)', () => {
    const UPLOAD_TREE: CdpDomNode = {
      ...TREE,
      children: [
        ...TREE.children!,
        { nodeName: 'INPUT', nodeType: 1, backendNodeId: 20, attributes: ['type', 'file', 'name', 'resume', 'required', ''] },
        { nodeName: 'INPUT', nodeType: 1, backendNodeId: 21, attributes: ['type', 'file', 'name', 'coverLetterFile', 'required', ''] },
      ],
    };

    const CV_ARTIFACT_ID = '44444444-4444-4444-8444-444444444444';
    const LETTER_ARTIFACT_ID = '55555555-5555-4555-8555-555555555555';
    const FOREIGN_ARTIFACT_ID = '66666666-6666-4666-8666-666666666666';
    const OTHER_ATTEMPT_ID = '22222222-2222-4222-8222-222222222222';
    const CV_BYTES = Buffer.from('%PDF-1.4 synthetic fixture resume bytes');
    const LETTER_BYTES = Buffer.from('%PDF-1.4 synthetic fixture cover letter bytes');

    type Assignment = { fieldRef: string; source: Record<string, unknown> };

    async function openUploadReview() {
      const session = await importSession();
      const view = fakeView(UPLOAD_TREE);
      createApplicationView.mockImplementation(() => view);
      const opened = await session.openApplicationReview({ attemptId: ATTEMPT_ID, policyId: 'ashby-fixture-test-only', targetUrl: FIXTURE_URL });
      const field = (label: string) => {
        const found = opened.snapshot.fields.find((f) => f.label === label);
        if (!found) throw new Error(`fixture field "${label}" not in snapshot`);
        return found;
      };
      /** Rule 9 (completeness) still applies: any required field this map does not assign has to be
       * listed as unmapped, exactly as a real generation session would have to. */
      const fieldMap = (assignments: Assignment[]) => ({
        attemptId: ATTEMPT_ID,
        snapshotGeneration: opened.snapshot.generation,
        assignments,
        unmapped: opened.snapshot.fields
          .filter((f) => f.required && !assignments.some((a) => a.fieldRef === f.fieldRef))
          .map((f) => ({ fieldRef: f.fieldRef, reason: 'needs_user' as const })),
      });
      return { session, view, opened, field, fieldMap };
    }

    function cdpCalls(view: ReturnType<typeof fakeView>, method: string) {
      return view.transport.sendCommand.mock.calls.filter(([called]) => called === method);
    }

    function uploadedPaths(view: ReturnType<typeof fakeView>): string[][] {
      return cdpCalls(view, 'DOM.setFileInputFiles').map(([, params]) => [...((params as { files: readonly string[] }).files)]);
    }

    it('attaches an attempt\'s own CV and required letter through the real bridge, and reports what the page itself came back with', async () => {
      const { session, view, opened, field, fieldMap } = await openUploadReview();
      const cv = stageArtifact(CV_ARTIFACT_ID, 'resume.pdf', CV_BYTES);
      const letter = stageArtifact(LETTER_ARTIFACT_ID, 'cover-letter.pdf', LETTER_BYTES, { kind: 'cover_letter_pdf' });
      workspaceMock.listApplicationArtifacts.mockReturnValue([cv, letter]);
      serveStagedFiles();

      const result = await session.applyApplicationFieldMap(FAKE_DB, {
        attemptId: ATTEMPT_ID,
        valueTable: [],
        fieldMap: fieldMap([
          { fieldRef: field('resume').fieldRef, source: { kind: 'artifact', artifactId: CV_ARTIFACT_ID } },
          { fieldRef: field('coverLetterFile').fieldRef, source: { kind: 'artifact', artifactId: LETTER_ARTIFACT_ID } },
        ]),
      });

      expect(result).toEqual({
        ok: true,
        appliedCount: 2,
        attachments: [
          { artifactId: CV_ARTIFACT_ID, fieldRef: field('resume').fieldRef, fileName: 'resume.pdf', attachedFileName: basename(cv.storagePath) },
          { artifactId: LETTER_ARTIFACT_ID, fieldRef: field('coverLetterFile').fieldRef, fileName: 'cover-letter.pdf', attachedFileName: basename(letter.storagePath) },
        ],
      });
      // The real CDP call carried exactly the two registered staging paths, nothing else.
      expect(uploadedPaths(view)).toEqual([[cv.storagePath], [letter.storagePath]]);
      expect(workspaceMock.listApplicationArtifacts).toHaveBeenCalledWith(FAKE_DB, ATTEMPT_ID);
      void opened;
    });

    it('reads the control back after the upload, and only then reports the attachment as applied', async () => {
      const { session, view, field, fieldMap } = await openUploadReview();
      const cv = stageArtifact(CV_ARTIFACT_ID, 'resume.pdf', CV_BYTES);
      workspaceMock.listApplicationArtifacts.mockReturnValue([cv]);
      serveStagedFiles();

      const result = await session.applyApplicationFieldMap(FAKE_DB, {
        attemptId: ATTEMPT_ID,
        valueTable: [],
        fieldMap: fieldMap([{ fieldRef: field('resume').fieldRef, source: { kind: 'artifact', artifactId: CV_ARTIFACT_ID } }]),
      });

      expect(result.ok).toBe(true);
      const methods = view.transport.sendCommand.mock.calls.map(([method]) => method as string);
      // Never fire-and-forget: the confirming read is a real call, and it happens after the upload.
      expect(methods.indexOf('Accessibility.getFullAXTree')).toBeGreaterThan(methods.indexOf('DOM.setFileInputFiles'));
    });

    it('refuses, never reports ready, when the page does not report the file back on the control afterwards', async () => {
      const { session, view, field, fieldMap } = await openUploadReview();
      const cv = stageArtifact(CV_ARTIFACT_ID, 'resume.pdf', CV_BYTES);
      workspaceMock.listApplicationArtifacts.mockReturnValue([cv]);
      serveStagedFiles();
      const browser = view.transport.sendCommand.getMockImplementation()!;
      // The upload silently does not take -- the control still reports an empty selection.
      view.transport.sendCommand.mockImplementation(async (method: string, params?: Record<string, unknown>) => {
        if (method === 'Accessibility.getFullAXTree') {
          return { nodes: [{ backendDOMNodeId: 20, value: { type: 'string', value: 'No file chosen' } }] };
        }
        return browser(method, params);
      });

      const result = await session.applyApplicationFieldMap(FAKE_DB, {
        attemptId: ATTEMPT_ID,
        valueTable: [],
        fieldMap: fieldMap([{ fieldRef: field('resume').fieldRef, source: { kind: 'artifact', artifactId: CV_ARTIFACT_ID } }]),
      });

      expect(result).toMatchObject({ ok: false, reason: 'attachment_unconfirmed' });
      expect(result.attachments).toBeUndefined();
      expect(cdpCalls(view, 'DOM.setFileInputFiles')).toHaveLength(1); // it genuinely tried, then refused on the read-back
    });

    it('refuses a file belonging to another attempt before uploading or typing anything', async () => {
      const { session, view, field, fieldMap } = await openUploadReview();
      const theirs = stageArtifact(FOREIGN_ARTIFACT_ID, 'resume.pdf', CV_BYTES, {}, OTHER_ATTEMPT_ID);
      // The real repository query is scoped by attempt id in SQL: this attempt's list never
      // contains the other attempt's row, however valid that row's own file is.
      workspaceMock.listApplicationArtifacts.mockImplementation((_db: unknown, attemptId: string) => (attemptId === OTHER_ATTEMPT_ID ? [theirs] : []));
      serveStagedFiles();

      const result = await session.applyApplicationFieldMap(FAKE_DB, {
        attemptId: ATTEMPT_ID,
        valueTable: [{ valueRef: 'v0000000000000001', value: 'Ada Lovelace', provenance: 'profile' }],
        fieldMap: fieldMap([
          { fieldRef: field('fullName').fieldRef, source: { kind: 'value', valueRef: 'v0000000000000001' } },
          { fieldRef: field('resume').fieldRef, source: { kind: 'artifact', artifactId: FOREIGN_ARTIFACT_ID } },
        ]),
      });

      expect(result).toMatchObject({ ok: false, reason: 'artifact_not_owned' });
      expect(cdpCalls(view, 'DOM.setFileInputFiles')).toHaveLength(0);
      // Not even the unrelated text field was filled: a refused map applies nothing at all.
      expect(cdpCalls(view, 'Input.insertText')).toHaveLength(0);
      expect(readFile).not.toHaveBeenCalledWith(theirs.storagePath);
    });

    it('refuses an artifact whose bytes changed since staging, before any upload', async () => {
      const { session, view, field, fieldMap } = await openUploadReview();
      const cv = stageArtifact(CV_ARTIFACT_ID, 'resume.pdf', CV_BYTES);
      workspaceMock.listApplicationArtifacts.mockReturnValue([cv]);
      serveStagedFiles();
      // Same byte length, different content: only a real re-hash catches this.
      stagedFiles.set(cv.storagePath, Buffer.from('%PDF-1.4 synthetic fixture resume BYTES'));

      const result = await session.applyApplicationFieldMap(FAKE_DB, {
        attemptId: ATTEMPT_ID,
        valueTable: [],
        fieldMap: fieldMap([{ fieldRef: field('resume').fieldRef, source: { kind: 'artifact', artifactId: CV_ARTIFACT_ID } }]),
      });

      expect(result).toMatchObject({ ok: false, reason: 'artifact_content_changed' });
      expect(cdpCalls(view, 'DOM.setFileInputFiles')).toHaveLength(0);
    });

    it('refuses an artifact whose staged file is gone, before any upload', async () => {
      const { session, view, field, fieldMap } = await openUploadReview();
      const cv = stageArtifact(CV_ARTIFACT_ID, 'resume.pdf', CV_BYTES);
      workspaceMock.listApplicationArtifacts.mockReturnValue([cv]);
      serveStagedFiles();
      stagedFiles.delete(cv.storagePath);

      const result = await session.applyApplicationFieldMap(FAKE_DB, {
        attemptId: ATTEMPT_ID,
        valueTable: [],
        fieldMap: fieldMap([{ fieldRef: field('resume').fieldRef, source: { kind: 'artifact', artifactId: CV_ARTIFACT_ID } }]),
      });

      expect(result).toMatchObject({ ok: false, reason: 'artifact_file_unreadable' });
      expect(cdpCalls(view, 'DOM.setFileInputFiles')).toHaveLength(0);
    });

    it('refuses an oversized artifact before any upload', async () => {
      const { session, view, field, fieldMap } = await openUploadReview();
      const cv = stageArtifact(CV_ARTIFACT_ID, 'resume.pdf', CV_BYTES, {
        byteSize: FIXTURE_REVIEW_POLICY.uploadConstraints.maxBytes + 1,
      });
      workspaceMock.listApplicationArtifacts.mockReturnValue([cv]);
      serveStagedFiles();

      const result = await session.applyApplicationFieldMap(FAKE_DB, {
        attemptId: ATTEMPT_ID,
        valueTable: [],
        fieldMap: fieldMap([{ fieldRef: field('resume').fieldRef, source: { kind: 'artifact', artifactId: CV_ARTIFACT_ID } }]),
      });

      expect(result).toMatchObject({ ok: false, reason: 'artifact_too_large' });
      expect(cdpCalls(view, 'DOM.setFileInputFiles')).toHaveLength(0);
    });

    it('refuses an artifact whose type this target does not accept, before any upload', async () => {
      const { session, view, field, fieldMap } = await openUploadReview();
      const cv = stageArtifact(CV_ARTIFACT_ID, 'resume.docx', CV_BYTES, {
        mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      });
      workspaceMock.listApplicationArtifacts.mockReturnValue([cv]);
      serveStagedFiles();

      const result = await session.applyApplicationFieldMap(FAKE_DB, {
        attemptId: ATTEMPT_ID,
        valueTable: [],
        fieldMap: fieldMap([{ fieldRef: field('resume').fieldRef, source: { kind: 'artifact', artifactId: CV_ARTIFACT_ID } }]),
      });

      expect(result).toMatchObject({ ok: false, reason: 'artifact_mime_not_allowed' });
      expect(cdpCalls(view, 'DOM.setFileInputFiles')).toHaveLength(0);
    });

    it('refuses an artifact registered to a path outside this attempt\'s own staging folder, however readable that file is', async () => {
      const { session, view, field, fieldMap } = await openUploadReview();
      // A real, correctly-hashed PDF sitting somewhere ambient (a downloads-style folder) rather
      // than in this attempt's staging folder.
      const ambientPath = '/synthetic-downloads/resume.pdf';
      stagedFiles.set(ambientPath, CV_BYTES);
      workspaceMock.listApplicationArtifacts.mockReturnValue([
        { ...stageArtifact(CV_ARTIFACT_ID, 'resume.pdf', CV_BYTES), storagePath: ambientPath },
      ]);
      serveStagedFiles();

      const result = await session.applyApplicationFieldMap(FAKE_DB, {
        attemptId: ATTEMPT_ID,
        valueTable: [],
        fieldMap: fieldMap([{ fieldRef: field('resume').fieldRef, source: { kind: 'artifact', artifactId: CV_ARTIFACT_ID } }]),
      });

      expect(result).toMatchObject({ ok: false, reason: 'artifact_outside_attempt_staging' });
      expect(cdpCalls(view, 'DOM.setFileInputFiles')).toHaveLength(0);
    });

    it('a retry re-attaches the same registered file, never whatever is newest somewhere else', async () => {
      const { session, view, field, fieldMap } = await openUploadReview();
      const cv = stageArtifact(CV_ARTIFACT_ID, 'resume.pdf', CV_BYTES);
      workspaceMock.listApplicationArtifacts.mockReturnValue([cv]);
      // A newer, larger, plausibly-named file that appeared after staging, outside the attempt's
      // folder -- nothing in this path may ever notice it exists.
      const decoyPath = '/synthetic-downloads/resume (3).pdf';
      stagedFiles.set(decoyPath, Buffer.from('%PDF-1.4 a much newer unrelated download that must never be attached'));
      serveStagedFiles();

      const input = {
        attemptId: ATTEMPT_ID,
        valueTable: [],
        fieldMap: fieldMap([{ fieldRef: field('resume').fieldRef, source: { kind: 'artifact', artifactId: CV_ARTIFACT_ID } }]),
      };
      const first = await session.applyApplicationFieldMap(FAKE_DB, input);
      const retry = await session.applyApplicationFieldMap(FAKE_DB, input);

      expect(first.ok).toBe(true);
      expect(retry.ok).toBe(true);
      // Both runs set the identical single path -- `DOM.setFileInputFiles` replaces a selection
      // rather than appending to it, so a retry leaves exactly the intended file on the control.
      expect(uploadedPaths(view)).toEqual([[cv.storagePath], [cv.storagePath]]);
      expect(view.selectedFiles.get(20)).toEqual([cv.storagePath]);
      expect(readFile).not.toHaveBeenCalledWith(decoyPath);
    });

    it('needs no native file picker, and stays inside the frozen CDP allowlist, for the supported fixture path', async () => {
      const { session, view, field, fieldMap } = await openUploadReview();
      const cv = stageArtifact(CV_ARTIFACT_ID, 'resume.pdf', CV_BYTES);
      workspaceMock.listApplicationArtifacts.mockReturnValue([cv]);
      serveStagedFiles();

      const result = await session.applyApplicationFieldMap(FAKE_DB, {
        attemptId: ATTEMPT_ID,
        valueTable: [],
        fieldMap: fieldMap([{ fieldRef: field('resume').fieldRef, source: { kind: 'artifact', artifactId: CV_ARTIFACT_ID } }]),
      });

      expect(result.ok).toBe(true);
      expect(dialog.showOpenDialog).not.toHaveBeenCalled();
      expect(dialog.showSaveDialog).not.toHaveBeenCalled();
      const methods = new Set(view.transport.sendCommand.mock.calls.map(([method]) => method as string));
      for (const method of methods) expect(ALLOWED_CDP_METHODS).toContain(method);
    });

    it('hands an upload this target may not drive to the user as a visible manual handoff, never a silent drop', async () => {
      vi.doMock('../electron/application-target-policies.js', () => {
        const policy = { ...FIXTURE_REVIEW_POLICY, killSwitches: { ...FIXTURE_REVIEW_POLICY.killSwitches, upload: true } };
        return {
          FIXTURE_REVIEW_POLICY: policy,
          resolveApplicationTargetPolicy: (id: string) => (id === policy.id ? policy : undefined),
          resolvePolicyIdForCanonicalUrl: (url: string) => (url === FIXTURE_URL ? policy.id : undefined),
        };
      });
      const { session, view, field, fieldMap } = await openUploadReview();
      const cv = stageArtifact(CV_ARTIFACT_ID, 'resume.pdf', CV_BYTES);
      workspaceMock.listApplicationArtifacts.mockReturnValue([cv]);
      serveStagedFiles();

      const result = await session.applyApplicationFieldMap(FAKE_DB, {
        attemptId: ATTEMPT_ID,
        valueTable: [],
        fieldMap: fieldMap([{ fieldRef: field('resume').fieldRef, source: { kind: 'artifact', artifactId: CV_ARTIFACT_ID } }]),
      });

      expect(result).toMatchObject({
        ok: false,
        reason: 'attachment_requires_manual_handoff',
        manualHandoff: { fieldRef: field('resume').fieldRef, artifactId: CV_ARTIFACT_ID, fileName: 'resume.pdf', reason: 'unsupported_control' },
      });
      expect(cdpCalls(view, 'DOM.setFileInputFiles')).toHaveLength(0);
      expect(dialog.showOpenDialog).not.toHaveBeenCalled();

      // ...and the handoff is genuinely visible: the live page is surfaced on the app's own window.
      const mainWindow = {} as never;
      expect(session.showApplicationReviewForHandoff(ATTEMPT_ID, mainWindow)).toBe(true);
      expect(view.show).toHaveBeenCalledWith(mainWindow);
      expect(session.showApplicationReviewForHandoff('99999999-9999-4999-8999-999999999999', mainWindow)).toBe(false);
    });
  });

  describe('submitApplicationReview (#202)', () => {
    it('refuses when there is no open review for the attempt', async () => {
      const { submitApplicationReview } = await importSession();
      const result = await submitApplicationReview(FAKE_DB, ATTEMPT_ID);
      expect(result).toEqual({ ok: false, reason: 'no_open_review', detail: expect.any(String) });
    });

    it('refuses when the current snapshot has no unambiguously-resolvable submit control', async () => {
      const { openApplicationReview, submitApplicationReview } = await importSession();
      createApplicationView.mockImplementation(() => fakeView(TREE)); // no submit button at all
      await openApplicationReview({ attemptId: ATTEMPT_ID, policyId: 'ashby-fixture-test-only', targetUrl: FIXTURE_URL });

      const result = await submitApplicationReview(FAKE_DB, ATTEMPT_ID);
      expect(result).toEqual({ ok: false, reason: 'unresolved_submit_control', detail: expect.any(String) });
      expect(workspaceMock.updateApplicationAttempt).not.toHaveBeenCalled();
    });

    const CHALLENGE_SUBMIT_TREE: CdpDomNode = {
      ...SUBMIT_TREE,
      children: [...SUBMIT_TREE.children!, { nodeName: 'IFRAME', nodeType: 1, backendNodeId: 11, attributes: ['src', 'https://www.google.com/recaptcha/api2/anchor'] }],
    };

    it('refuses when the current snapshot has an active CAPTCHA challenge, before touching the checkpoint at all', async () => {
      const { openApplicationReview, submitApplicationReview } = await importSession();
      createApplicationView.mockImplementation(() => fakeView(CHALLENGE_SUBMIT_TREE));
      await openApplicationReview({ attemptId: ATTEMPT_ID, policyId: 'ashby-fixture-test-only', targetUrl: FIXTURE_URL });

      const result = await submitApplicationReview(FAKE_DB, ATTEMPT_ID);
      expect(result).toEqual({ ok: false, reason: 'captcha_detected', detail: expect.any(String) });
      expect(workspaceMock.updateApplicationAttempt).not.toHaveBeenCalled();
    });

    it('refuses via the pre-submit gate when the rendered CV does not name the attempt\'s own role -- a real tampered/stale-content case', async () => {
      const { openApplicationReview, submitApplicationReview } = await importSession();
      createApplicationView.mockImplementation(() => fakeView(SUBMIT_TREE));
      await openApplicationReview({ attemptId: ATTEMPT_ID, policyId: 'ashby-fixture-test-only', targetUrl: FIXTURE_URL });

      workspaceMock.getApplicationAttempt.mockReturnValue(withRealJdHash(fakeAttempt()));
      workspaceMock.listApplicationArtifacts.mockReturnValue([stagedArtifact('cv_pdf', '/fake/resume.pdf')]);
      extractPdfText.mockResolvedValue('A perfectly nice resume that never mentions the employer or role at all.');

      const result = await submitApplicationReview(FAKE_DB, ATTEMPT_ID);
      expect(result).toEqual({ ok: false, reason: 'role_not_found_in_documents', detail: expect.any(String) });
      expect(workspaceMock.updateApplicationAttempt).not.toHaveBeenCalled(); // gate refused before submitting ever began
    });

    it('does not require a CV-only attempt to name the employer being applied to (#276)', async () => {
      // Before #276 this attempt refused with `company_not_found_in_documents`, and the only way to
      // make it pass was for the CV to claim the prospective employer somewhere in its own history.
      const { openApplicationReview, submitApplicationReview } = await importSession();
      createApplicationView.mockImplementation(() => fakeView(SUBMIT_TREE));
      await openApplicationReview({ attemptId: ATTEMPT_ID, policyId: 'ashby-fixture-test-only', targetUrl: FIXTURE_URL });

      workspaceMock.getApplicationAttempt.mockReturnValue(withRealJdHash(fakeAttempt()));
      workspaceMock.listApplicationArtifacts.mockReturnValue([stagedArtifact('cv_pdf', '/fake/resume.pdf')]);
      extractPdfText.mockResolvedValue('Jamie Rivera, Senior Engineer. Previously at Redwood Software and Atlas Labs.');

      const result = await submitApplicationReview(FAKE_DB, ATTEMPT_ID);
      expect(result).toEqual({ ok: true });
    });

    it('refuses when a staged artifact no longer hashes to the bytes that were accepted (#276)', async () => {
      const { openApplicationReview, submitApplicationReview } = await importSession();
      createApplicationView.mockImplementation(() => fakeView(SUBMIT_TREE));
      await openApplicationReview({ attemptId: ATTEMPT_ID, policyId: 'ashby-fixture-test-only', targetUrl: FIXTURE_URL });

      workspaceMock.getApplicationAttempt.mockReturnValue(withRealJdHash(fakeAttempt()));
      // The row records the hash of what passed validation; the file on disk is now something else.
      workspaceMock.listApplicationArtifacts.mockReturnValue([stagedArtifact('cv_pdf', '/fake/resume.pdf', 'a'.repeat(64))]);
      extractPdfText.mockResolvedValue('Acme Corp Senior Engineer');

      const result = await submitApplicationReview(FAKE_DB, ATTEMPT_ID);
      expect(result).toEqual({ ok: false, reason: 'artifact_bytes_changed', detail: expect.stringContaining('no longer matches') });
      expect(workspaceMock.updateApplicationAttempt).not.toHaveBeenCalled();
      expect(extractPdfText).not.toHaveBeenCalled(); // never re-derives a verdict from the swapped file
    });

    it('refuses via the pre-submit gate when the live source CV in the library no longer matches the hash this attempt was created with', async () => {
      const { openApplicationReview, submitApplicationReview } = await importSession();
      createApplicationView.mockImplementation(() => fakeView(SUBMIT_TREE));
      await openApplicationReview({ attemptId: ATTEMPT_ID, policyId: 'ashby-fixture-test-only', targetUrl: FIXTURE_URL });

      workspaceMock.getApplicationAttempt.mockReturnValue(withRealJdHash(fakeAttempt({ sourceCvId: 'cv-1', sourceCvContentHash: 'hash-of-the-original-cv-text' })));
      workspaceMock.listCvDocuments.mockReturnValue([{ id: 'cv-1', text: 'the CV has since been edited by the user' }]);
      workspaceMock.listApplicationArtifacts.mockReturnValue([stagedArtifact('cv_pdf', '/fake/resume.pdf')]);
      extractPdfText.mockResolvedValue('Acme Corp Senior Engineer');

      const result = await submitApplicationReview(FAKE_DB, ATTEMPT_ID);
      expect(result).toEqual({ ok: false, reason: 'source_cv_changed', detail: expect.any(String) });
    });

    it('refuses when the attempt names a sourceCvId that no longer exists in the library', async () => {
      const { openApplicationReview, submitApplicationReview } = await importSession();
      createApplicationView.mockImplementation(() => fakeView(SUBMIT_TREE));
      await openApplicationReview({ attemptId: ATTEMPT_ID, policyId: 'ashby-fixture-test-only', targetUrl: FIXTURE_URL });

      workspaceMock.getApplicationAttempt.mockReturnValue(withRealJdHash(fakeAttempt({ sourceCvId: 'cv-deleted' })));
      workspaceMock.listCvDocuments.mockReturnValue([]);

      const result = await submitApplicationReview(FAKE_DB, ATTEMPT_ID);
      expect(result).toEqual({ ok: false, reason: 'source_cv_not_found', detail: expect.any(String) });
    });

    it('fills, reviews, confirms, and submits for real against the fixture -- the happy path #202 exists for', async () => {
      const { openApplicationReview, submitApplicationReview } = await importSession();
      const view = fakeView(SUBMIT_TREE);
      createApplicationView.mockImplementation(() => view);
      await openApplicationReview({ attemptId: ATTEMPT_ID, policyId: 'ashby-fixture-test-only', targetUrl: FIXTURE_URL });

      workspaceMock.getApplicationAttempt.mockReturnValue(withRealJdHash(fakeAttempt()));
      workspaceMock.listApplicationArtifacts.mockReturnValue([
        stagedArtifact('cv_pdf', '/fake/resume.pdf'),
        stagedArtifact('cover_letter_pdf', '/fake/letter.pdf'),
      ]);
      extractPdfText.mockResolvedValue('Dear Acme Corp, I am excited to apply for the Senior Engineer role.');

      const result = await submitApplicationReview(FAKE_DB, ATTEMPT_ID);

      expect(result).toEqual({ ok: true });
      expect(workspaceMock.updateApplicationAttempt).toHaveBeenNthCalledWith(1, FAKE_DB, ATTEMPT_ID, { checkpoint: 'submitting' });
      expect(workspaceMock.updateApplicationAttempt).toHaveBeenNthCalledWith(2, FAKE_DB, ATTEMPT_ID, {
        checkpoint: 'submitted',
        submittedAt: expect.any(String),
        submissionMode: 'manual',
        formStructureHash: expect.any(String),
      });
      const calledMethods = view.transport.sendCommand.mock.calls.map(([method]) => method as string);
      expect(calledMethods).toContain('Input.dispatchMouseEvent'); // the real submit click
    });

    it('lands on submission_unknown, never a silent retry or drop, when the submit click itself fails ambiguously', async () => {
      const { openApplicationReview, submitApplicationReview } = await importSession();
      const view = fakeView(SUBMIT_TREE);
      view.transport.sendCommand.mockImplementation(async (method: string) => {
        if (method === 'DOM.getBoxModel') throw new Error('CDP connection dropped');
        if (method === 'DOM.getDocument') return { root: SUBMIT_TREE };
        return {};
      });
      createApplicationView.mockImplementation(() => view);
      await openApplicationReview({ attemptId: ATTEMPT_ID, policyId: 'ashby-fixture-test-only', targetUrl: FIXTURE_URL });

      workspaceMock.getApplicationAttempt.mockReturnValue(withRealJdHash(fakeAttempt()));
      workspaceMock.listApplicationArtifacts.mockReturnValue([stagedArtifact('cv_pdf', '/fake/resume.pdf')]);
      extractPdfText.mockResolvedValue('Acme Corp Senior Engineer');

      const result = await submitApplicationReview(FAKE_DB, ATTEMPT_ID);

      expect(result).toEqual({ ok: false, reason: 'submission_unknown', detail: expect.stringContaining('CDP connection dropped') });
      expect(workspaceMock.updateApplicationAttempt).toHaveBeenNthCalledWith(1, FAKE_DB, ATTEMPT_ID, { checkpoint: 'submitting' });
      expect(workspaceMock.updateApplicationAttempt).toHaveBeenNthCalledWith(2, FAKE_DB, ATTEMPT_ID, {
        checkpoint: 'submission_unknown',
        checkpointDetail: expect.stringContaining('CDP connection dropped'),
      });
    });

    it('reverts to ready (never submission_unknown) when the policy itself refuses the submit action -- nothing ever reached the page', async () => {
      vi.doMock('../electron/application-target-policies.js', () => ({
        resolveApplicationTargetPolicy: () => ({
          ...FIXTURE_REVIEW_POLICY,
          killSwitches: { ...FIXTURE_REVIEW_POLICY.killSwitches, submit: true }, // the actual gate this test exercises
        }),
      }));
      const { openApplicationReview, submitApplicationReview } = await importSession();
      createApplicationView.mockImplementation(() => fakeView(SUBMIT_TREE));
      await openApplicationReview({ attemptId: ATTEMPT_ID, policyId: 'ashby-fixture-test-only', targetUrl: FIXTURE_URL });

      workspaceMock.getApplicationAttempt.mockReturnValue(withRealJdHash(fakeAttempt()));
      workspaceMock.listApplicationArtifacts.mockReturnValue([stagedArtifact('cv_pdf', '/fake/resume.pdf')]);
      extractPdfText.mockResolvedValue('Acme Corp Senior Engineer');

      const result = await submitApplicationReview(FAKE_DB, ATTEMPT_ID);

      expect(result.ok).toBe(false);
      expect(result.reason).toBe('submit_refused');
      expect(workspaceMock.updateApplicationAttempt).toHaveBeenNthCalledWith(1, FAKE_DB, ATTEMPT_ID, { checkpoint: 'submitting' });
      expect(workspaceMock.updateApplicationAttempt).toHaveBeenNthCalledWith(2, FAKE_DB, ATTEMPT_ID, { checkpoint: 'ready', checkpointDetail: expect.any(String) });
    });

    it('refuses a second concurrent submit for the same attempt instead of clicking submit twice', async () => {
      const { openApplicationReview, submitApplicationReview } = await importSession();
      createApplicationView.mockImplementation(() => fakeView(SUBMIT_TREE));
      await openApplicationReview({ attemptId: ATTEMPT_ID, policyId: 'ashby-fixture-test-only', targetUrl: FIXTURE_URL });
      workspaceMock.getApplicationAttempt.mockReturnValue(withRealJdHash(fakeAttempt()));
      workspaceMock.listApplicationArtifacts.mockReturnValue([stagedArtifact('cv_pdf', '/fake/resume.pdf')]);
      extractPdfText.mockResolvedValue('Acme Corp Senior Engineer');
      // Never resolves on its own -- holds the in-flight lock open long enough for a second call to
      // land while the first is still mid-submit, the same window a real CDP click occupies.
      readFile.mockImplementationOnce(() => new Promise(() => {}));

      const first = submitApplicationReview(FAKE_DB, ATTEMPT_ID);
      const second = await submitApplicationReview(FAKE_DB, ATTEMPT_ID);

      expect(second).toEqual({ ok: false, reason: 'already_submitting', detail: expect.any(String) });
      void first; // left pending deliberately; nothing else in this test awaits it
    });

    it('refuses to submit an attempt that already reached checkpoint "submitted" instead of resubmitting it', async () => {
      const { openApplicationReview, submitApplicationReview } = await importSession();
      createApplicationView.mockImplementation(() => fakeView(SUBMIT_TREE));
      await openApplicationReview({ attemptId: ATTEMPT_ID, policyId: 'ashby-fixture-test-only', targetUrl: FIXTURE_URL });
      workspaceMock.getApplicationAttempt.mockReturnValue(withRealJdHash(fakeAttempt({ checkpoint: 'submitted' })));

      const result = await submitApplicationReview(FAKE_DB, ATTEMPT_ID);

      expect(result).toEqual({ ok: false, reason: 'already_submitted', detail: expect.any(String) });
      expect(workspaceMock.updateApplicationAttempt).not.toHaveBeenCalledWith(FAKE_DB, ATTEMPT_ID, expect.objectContaining({ checkpoint: 'submitting' }));
    });

    it('returns a clean refusal, never a thrown error, when a scheduled artifact cannot be read from disk', async () => {
      const { openApplicationReview, submitApplicationReview } = await importSession();
      createApplicationView.mockImplementation(() => fakeView(SUBMIT_TREE));
      await openApplicationReview({ attemptId: ATTEMPT_ID, policyId: 'ashby-fixture-test-only', targetUrl: FIXTURE_URL });
      workspaceMock.getApplicationAttempt.mockReturnValue(withRealJdHash(fakeAttempt()));
      workspaceMock.listApplicationArtifacts.mockReturnValue([stagedArtifact('cv_pdf', '/fake/resume.pdf')]);
      readFile.mockRejectedValueOnce(new Error('ENOENT: no such file or directory'));

      await expect(submitApplicationReview(FAKE_DB, ATTEMPT_ID)).resolves.toEqual({
        ok: false,
        reason: 'artifact_read_failed',
        detail: expect.stringContaining('ENOENT'),
      });
    });
  });

  describe('automatic submission (#203)', () => {
    // A dedicated policy, isolated from the shared FIXTURE_REVIEW_POLICY, so rate limits can be
    // set tight enough to actually exercise (the real fixture's own perDay:1000 exists to never
    // get in #202's fixture tests' way, which would make it useless for testing a cap here).
    const AUTOMATION_POLICY_ID = 'ashby-fixture-test-only';
    function automationPolicy(overrides: Partial<Record<string, unknown>> = {}) {
      return {
        ...FIXTURE_REVIEW_POLICY,
        id: AUTOMATION_POLICY_ID,
        rateLimits: { perDay: 2, perEmployerPerDay: 1, minIntervalMs: 0 },
        termsEligibleForAutomation: true,
        ...overrides,
      };
    }
    function mockAutomationPolicy(overrides: Partial<Record<string, unknown>> = {}) {
      const policy = automationPolicy(overrides);
      vi.doMock('../electron/application-target-policies.js', () => ({
        FIXTURE_REVIEW_POLICY: policy,
        resolveApplicationTargetPolicy: (id: string) => (id === policy.id ? policy : undefined),
        resolvePolicyIdForCanonicalUrl: (url: string) => (url === FIXTURE_URL ? policy.id : undefined),
      }));
    }

    const NOW = '2026-02-01T12:00:00.000Z';
    const submittedAttempt = (overrides: Partial<Record<string, unknown>> = {}) =>
      withRealJdHash(fakeAttempt({ checkpoint: 'submitted', submittedAt: '2026-01-31T12:00:00.000Z', submissionMode: 'manual', ...overrides }));

    it('refuses to schedule when the target is not eligible for automation under the terms register, even with an active grant', async () => {
      mockAutomationPolicy({ termsEligibleForAutomation: false });
      const { openApplicationReview, evaluateAndScheduleAutomaticSubmission } = await importSession();
      createApplicationView.mockImplementation(() => fakeView(SUBMIT_TREE));
      await openApplicationReview({ attemptId: ATTEMPT_ID, policyId: AUTOMATION_POLICY_ID, targetUrl: FIXTURE_URL });
      workspaceMock.getApplicationAttempt.mockReturnValue(withRealJdHash(fakeAttempt()));
      workspaceMock.findActiveAutomationGrant.mockReturnValue({ id: 'grant-1', policyId: AUTOMATION_POLICY_ID, createdAt: NOW, expiresAt: '2026-03-01T00:00:00.000Z', revokedAt: null });

      const result = await evaluateAndScheduleAutomaticSubmission(FAKE_DB, ATTEMPT_ID, NOW);
      expect(result).toEqual({ ok: false, reason: 'not_eligible_for_automation' });
    });

    it('refuses to schedule when no active grant exists', async () => {
      mockAutomationPolicy();
      const { openApplicationReview, evaluateAndScheduleAutomaticSubmission } = await importSession();
      createApplicationView.mockImplementation(() => fakeView(SUBMIT_TREE));
      await openApplicationReview({ attemptId: ATTEMPT_ID, policyId: AUTOMATION_POLICY_ID, targetUrl: FIXTURE_URL });
      workspaceMock.getApplicationAttempt.mockReturnValue(withRealJdHash(fakeAttempt()));
      workspaceMock.findActiveAutomationGrant.mockReturnValue(undefined);

      const result = await evaluateAndScheduleAutomaticSubmission(FAKE_DB, ATTEMPT_ID, NOW);
      expect(result).toEqual({ ok: false, reason: 'no_active_grant' });
    });

    it('refuses the first attempt at any employer, even with an active grant -- it is always manually reviewed', async () => {
      mockAutomationPolicy();
      const { openApplicationReview, evaluateAndScheduleAutomaticSubmission } = await importSession();
      createApplicationView.mockImplementation(() => fakeView(SUBMIT_TREE));
      await openApplicationReview({ attemptId: ATTEMPT_ID, policyId: AUTOMATION_POLICY_ID, targetUrl: FIXTURE_URL });
      workspaceMock.getApplicationAttempt.mockReturnValue(withRealJdHash(fakeAttempt()));
      workspaceMock.findActiveAutomationGrant.mockReturnValue({ id: 'grant-1', policyId: AUTOMATION_POLICY_ID, createdAt: NOW, expiresAt: '2026-03-01T00:00:00.000Z', revokedAt: null });
      workspaceMock.listApplicationAttempts.mockReturnValue([]); // no prior submission for this employer at all

      const result = await evaluateAndScheduleAutomaticSubmission(FAKE_DB, ATTEMPT_ID, NOW);
      expect(result).toMatchObject({ ok: false, reason: 'no_prior_manual_submission_for_employer' });
    });

    it('refuses when the current form structure does not match the employer\'s most recent submission', async () => {
      mockAutomationPolicy();
      const { openApplicationReview, evaluateAndScheduleAutomaticSubmission } = await importSession();
      createApplicationView.mockImplementation(() => fakeView(SUBMIT_TREE));
      await openApplicationReview({ attemptId: ATTEMPT_ID, policyId: AUTOMATION_POLICY_ID, targetUrl: FIXTURE_URL });
      workspaceMock.getApplicationAttempt.mockReturnValue(withRealJdHash(fakeAttempt()));
      workspaceMock.findActiveAutomationGrant.mockReturnValue({ id: 'grant-1', policyId: AUTOMATION_POLICY_ID, createdAt: NOW, expiresAt: '2026-03-01T00:00:00.000Z', revokedAt: null });
      workspaceMock.listApplicationAttempts.mockReturnValue([submittedAttempt({ formStructureHash: 'a-completely-different-hash' })]);

      const result = await evaluateAndScheduleAutomaticSubmission(FAKE_DB, ATTEMPT_ID, NOW);
      expect(result).toMatchObject({ ok: false, reason: 'form_structure_changed_since_last_review' });
    });

    it('schedules a real automatic submit, exactly the cancel window out, once every guardrail passes', async () => {
      mockAutomationPolicy();
      const { openApplicationReview, evaluateAndScheduleAutomaticSubmission, AUTOMATIC_SUBMIT_CANCEL_WINDOW_MS } = await importSession();
      createApplicationView.mockImplementation(() => fakeView(SUBMIT_TREE));
      const opened = await openApplicationReview({ attemptId: ATTEMPT_ID, policyId: AUTOMATION_POLICY_ID, targetUrl: FIXTURE_URL });
      const matchingHash = computeExpectedFormStructureHash(opened.snapshot.fields);
      workspaceMock.getApplicationAttempt.mockReturnValue(withRealJdHash(fakeAttempt()));
      workspaceMock.findActiveAutomationGrant.mockReturnValue({ id: 'grant-1', policyId: AUTOMATION_POLICY_ID, createdAt: NOW, expiresAt: '2026-03-01T00:00:00.000Z', revokedAt: null });
      workspaceMock.listApplicationAttempts.mockReturnValue([submittedAttempt({ formStructureHash: matchingHash })]);

      const result = await evaluateAndScheduleAutomaticSubmission(FAKE_DB, ATTEMPT_ID, NOW);

      const expectedAt = new Date(Date.parse(NOW) + AUTOMATIC_SUBMIT_CANCEL_WINDOW_MS).toISOString();
      expect(result).toEqual({ ok: true, scheduledAutomaticSubmitAt: expectedAt });
      expect(workspaceMock.updateApplicationAttempt).toHaveBeenCalledWith(FAKE_DB, ATTEMPT_ID, { scheduledAutomaticSubmitAt: expectedAt });
    });

    it('the daily automatic-submission cap actually blocks scheduling a queue past it, not just a config value that goes unchecked', async () => {
      mockAutomationPolicy({ rateLimits: { perDay: 1, perEmployerPerDay: 10, minIntervalMs: 0 } });
      const { openApplicationReview, evaluateAndScheduleAutomaticSubmission } = await importSession();
      createApplicationView.mockImplementation(() => fakeView(SUBMIT_TREE));
      const opened = await openApplicationReview({ attemptId: ATTEMPT_ID, policyId: AUTOMATION_POLICY_ID, targetUrl: FIXTURE_URL });
      const matchingHash = computeExpectedFormStructureHash(opened.snapshot.fields);
      workspaceMock.getApplicationAttempt.mockReturnValue(withRealJdHash(fakeAttempt()));
      workspaceMock.findActiveAutomationGrant.mockReturnValue({ id: 'grant-1', policyId: AUTOMATION_POLICY_ID, createdAt: NOW, expiresAt: '2026-03-01T00:00:00.000Z', revokedAt: null });
      workspaceMock.listApplicationAttempts.mockReturnValue([
        submittedAttempt({ formStructureHash: matchingHash }),
        // Already one automatic submission in the last 24h -- the perDay:1 cap is already spent.
        submittedAttempt({ id: 'other-attempt', company: 'Beta Inc', submissionMode: 'automatic', submittedAt: '2026-02-01T06:00:00.000Z' }),
      ]);

      const result = await evaluateAndScheduleAutomaticSubmission(FAKE_DB, ATTEMPT_ID, NOW);
      expect(result).toEqual({ ok: false, reason: 'daily_cap_reached', detail: expect.any(String) });
    });

    it('cancelling a scheduled automatic submit within the window means it never fires', async () => {
      mockAutomationPolicy();
      const { openApplicationReview, cancelScheduledAutomaticSubmission, fireDueAutomaticSubmissions } = await importSession();
      createApplicationView.mockImplementation(() => fakeView(SUBMIT_TREE));
      await openApplicationReview({ attemptId: ATTEMPT_ID, policyId: AUTOMATION_POLICY_ID, targetUrl: FIXTURE_URL });
      const scheduledAt = '2026-02-01T12:03:00.000Z';
      workspaceMock.listApplicationAttempts.mockReturnValue([withRealJdHash(fakeAttempt({ scheduledAutomaticSubmitAt: scheduledAt }))]);

      cancelScheduledAutomaticSubmission(FAKE_DB, ATTEMPT_ID);
      expect(workspaceMock.updateApplicationAttempt).toHaveBeenCalledWith(FAKE_DB, ATTEMPT_ID, { scheduledAutomaticSubmitAt: null });

      // Once cancelled, this attempt must never be found "due", even asking well after the
      // original schedule would have elapsed.
      workspaceMock.listApplicationAttempts.mockReturnValue([withRealJdHash(fakeAttempt({ scheduledAutomaticSubmitAt: null }))]);
      const fired = await fireDueAutomaticSubmissions(FAKE_DB, '2026-02-01T13:00:00.000Z');
      expect(fired).toEqual([]);
    });

    it('does not fire a scheduled submit before its cancel window has actually elapsed', async () => {
      mockAutomationPolicy();
      const { fireDueAutomaticSubmissions } = await importSession();
      const scheduledAt = '2026-02-01T12:03:00.000Z';
      workspaceMock.listApplicationAttempts.mockReturnValue([withRealJdHash(fakeAttempt({ scheduledAutomaticSubmitAt: scheduledAt }))]);

      const fired = await fireDueAutomaticSubmissions(FAKE_DB, '2026-02-01T12:00:00.000Z'); // before scheduledAt
      expect(fired).toEqual([]);
      expect(workspaceMock.updateApplicationAttempt).not.toHaveBeenCalled();
    });

    it('end to end: schedules, then fires for real once the window elapses, re-validating every guardrail and notifying either way', async () => {
      mockAutomationPolicy();
      const {
        openApplicationReview,
        evaluateAndScheduleAutomaticSubmission,
        fireDueAutomaticSubmissions,
      } = await importSession();
      const view = fakeView(SUBMIT_TREE);
      createApplicationView.mockImplementation(() => view);
      const opened = await openApplicationReview({ attemptId: ATTEMPT_ID, policyId: AUTOMATION_POLICY_ID, targetUrl: FIXTURE_URL });
      const matchingHash = computeExpectedFormStructureHash(opened.snapshot.fields);

      const attemptNow = withRealJdHash(fakeAttempt());
      workspaceMock.getApplicationAttempt.mockReturnValue(attemptNow);
      workspaceMock.findActiveAutomationGrant.mockReturnValue({ id: 'grant-1', policyId: AUTOMATION_POLICY_ID, createdAt: NOW, expiresAt: '2026-03-01T00:00:00.000Z', revokedAt: null });
      workspaceMock.listApplicationArtifacts.mockReturnValue([stagedArtifact('cv_pdf', '/fake/resume.pdf')]);
      extractPdfText.mockResolvedValue('Acme Corp Senior Engineer');
      workspaceMock.listApplicationAttempts.mockReturnValue([submittedAttempt({ formStructureHash: matchingHash })]);

      const scheduled = await evaluateAndScheduleAutomaticSubmission(FAKE_DB, ATTEMPT_ID, NOW);
      expect(scheduled.ok).toBe(true);

      // Reflect the schedule for the "what's due" query fireDueAutomaticSubmissions runs, plus the
      // employer's prior submission still needed for the re-validated eligibility check.
      workspaceMock.listApplicationAttempts.mockReturnValue([
        { ...attemptNow, scheduledAutomaticSubmitAt: scheduled.scheduledAutomaticSubmitAt },
        submittedAttempt({ formStructureHash: matchingHash }),
      ]);

      const afterWindow = new Date(Date.parse(NOW) + 4 * 60 * 1000).toISOString(); // past the 3-minute window
      const fired = await fireDueAutomaticSubmissions(FAKE_DB, afterWindow);

      expect(fired).toHaveLength(1);
      expect(fired[0]).toMatchObject({ attemptId: ATTEMPT_ID, company: 'Acme Corp', role: 'Senior Engineer', result: { ok: true } });
      expect(notifyAutomaticSubmission).toHaveBeenCalledWith({ company: 'Acme Corp', role: 'Senior Engineer', ok: true, detail: undefined });
      const calledMethods = view.transport.sendCommand.mock.calls.map(([method]) => method as string);
      expect(calledMethods).toContain('Input.dispatchMouseEvent'); // the real automatic submit click
      expect(workspaceMock.updateApplicationAttempt).toHaveBeenCalledWith(FAKE_DB, ATTEMPT_ID, { scheduledAutomaticSubmitAt: null });
      expect(workspaceMock.updateApplicationAttempt).toHaveBeenCalledWith(
        FAKE_DB,
        ATTEMPT_ID,
        expect.objectContaining({ checkpoint: 'submitted', submissionMode: 'automatic' }),
      );
    });

    it('a guardrail that newly fails between scheduling and firing (grant revoked in the meantime) refuses at fire time and notifies, rather than submitting on stale authorization', async () => {
      mockAutomationPolicy();
      const { openApplicationReview, fireDueAutomaticSubmissions } = await importSession();
      createApplicationView.mockImplementation(() => fakeView(SUBMIT_TREE));
      await openApplicationReview({ attemptId: ATTEMPT_ID, policyId: AUTOMATION_POLICY_ID, targetUrl: FIXTURE_URL });

      const scheduledAt = '2026-02-01T12:03:00.000Z';
      workspaceMock.getApplicationAttempt.mockReturnValue(withRealJdHash(fakeAttempt()));
      workspaceMock.listApplicationAttempts.mockReturnValue([withRealJdHash(fakeAttempt({ scheduledAutomaticSubmitAt: scheduledAt }))]);
      // The grant was revoked sometime during the cancel window -- re-validation at fire time must
      // catch this even though it was presumably active when this attempt was first scheduled.
      workspaceMock.findActiveAutomationGrant.mockReturnValue(undefined);

      const fired = await fireDueAutomaticSubmissions(FAKE_DB, '2026-02-01T12:05:00.000Z');

      expect(fired).toEqual([{ attemptId: ATTEMPT_ID, company: 'Acme Corp', role: 'Senior Engineer', result: { ok: false, reason: 'no_active_grant', detail: undefined } }]);
      expect(notifyAutomaticSubmission).toHaveBeenCalledWith({ company: 'Acme Corp', role: 'Senior Engineer', ok: false, detail: 'no_active_grant' });
      expect(workspaceMock.updateApplicationAttempt).toHaveBeenCalledWith(FAKE_DB, ATTEMPT_ID, { scheduledAutomaticSubmitAt: null });
      // Never actually clicked anything -- the guardrail refused before any submit was attempted.
      expect(workspaceMock.updateApplicationAttempt).not.toHaveBeenCalledWith(FAKE_DB, ATTEMPT_ID, expect.objectContaining({ checkpoint: 'submitting' }));
    });

    it('a target the terms register has not cleared for automation can never run under automatic mode, even if every other guardrail would pass', async () => {
      mockAutomationPolicy({ termsEligibleForAutomation: false });
      const { openApplicationReview, evaluateAndScheduleAutomaticSubmission } = await importSession();
      createApplicationView.mockImplementation(() => fakeView(SUBMIT_TREE));
      await openApplicationReview({ attemptId: ATTEMPT_ID, policyId: AUTOMATION_POLICY_ID, targetUrl: FIXTURE_URL });
      workspaceMock.getApplicationAttempt.mockReturnValue(withRealJdHash(fakeAttempt()));
      workspaceMock.findActiveAutomationGrant.mockReturnValue({ id: 'grant-1', policyId: AUTOMATION_POLICY_ID, createdAt: NOW, expiresAt: '2026-03-01T00:00:00.000Z', revokedAt: null });
      workspaceMock.listApplicationAttempts.mockReturnValue([submittedAttempt()]);

      const result = await evaluateAndScheduleAutomaticSubmission(FAKE_DB, ATTEMPT_ID, NOW);
      expect(result).toEqual({ ok: false, reason: 'not_eligible_for_automation' });
    });

    it('a real, small queue run unattended: every guardrail exercised together, not just individually', async () => {
      // Three attempts, one fireDueAutomaticSubmissions call, a stateful mock so a fire earlier in
      // the same batch is actually visible to a later one's own guardrail checks -- the same way a
      // real database would behave, and the only way "per-employer cap" can mean anything within
      // one unattended run rather than only across separate ones.
      mockAutomationPolicy({ rateLimits: { perDay: 10, perEmployerPerDay: 1, minIntervalMs: 0 } });
      const { openApplicationReview, fireDueAutomaticSubmissions } = await importSession();

      // submitApplicationReview stamps submittedAt from the real wall clock (correct: a manual
      // submit has no injected "now" to use), so this batch's own injected times must be anchored
      // to the real clock too -- a fixed historical date would make A's real-time submission look
      // like it happened in the future relative to B/C's checks, tripping minIntervalMs for the
      // wrong reason.
      const REAL_NOW = Date.now();
      const QUEUE_NOW = new Date(REAL_NOW - 3 * 60 * 1000).toISOString(); // scheduled 3 minutes ago
      const FIRE_AT = new Date(REAL_NOW).toISOString();

      const ATTEMPT_A = ATTEMPT_ID; // Acme Corp -- eligible, should fire
      const ATTEMPT_B = '22222222-2222-4222-8222-222222222222'; // Beta Inc -- no prior submission at all
      const ATTEMPT_C = '33333333-3333-4333-8333-333333333333'; // Acme Corp again -- blocked by A's own fire in this batch

      const views = new Map([
        [ATTEMPT_A, fakeView(SUBMIT_TREE)],
        [ATTEMPT_B, fakeView(SUBMIT_TREE)],
        [ATTEMPT_C, fakeView(SUBMIT_TREE)],
      ]);
      createApplicationView.mockImplementation((attemptId: string) => views.get(attemptId)!);
      let matchingHash = '';
      for (const attemptId of views.keys()) {
        const opened = await openApplicationReview({ attemptId, policyId: AUTOMATION_POLICY_ID, targetUrl: FIXTURE_URL });
        matchingHash = computeExpectedFormStructureHash(opened.snapshot.fields); // identical for every attempt here -- they all open the same SUBMIT_TREE
      }

      const attemptRecords = new Map<string, ReturnType<typeof fakeAttempt>>([
        [ATTEMPT_A, withRealJdHash(fakeAttempt({ id: ATTEMPT_A, company: 'Acme Corp', scheduledAutomaticSubmitAt: QUEUE_NOW }))],
        [ATTEMPT_B, withRealJdHash(fakeAttempt({ id: ATTEMPT_B, company: 'Beta Inc', scheduledAutomaticSubmitAt: QUEUE_NOW }))],
        [ATTEMPT_C, withRealJdHash(fakeAttempt({ id: ATTEMPT_C, company: 'Acme Corp', scheduledAutomaticSubmitAt: QUEUE_NOW }))],
      ]);
      const priorSubmissions = [submittedAttempt({ id: 'prior-acme', company: 'Acme Corp', formStructureHash: matchingHash, submittedAt: QUEUE_NOW })]; // establishes Acme's template; Beta has none

      workspaceMock.getApplicationAttempt.mockImplementation((_db: unknown, id: string) => attemptRecords.get(id));
      workspaceMock.listApplicationAttempts.mockImplementation(() => [...attemptRecords.values(), ...priorSubmissions]);
      workspaceMock.updateApplicationAttempt.mockImplementation((_db: unknown, id: string, patch: Record<string, unknown>) => {
        const current = attemptRecords.get(id)!;
        const updated = { ...current, ...patch };
        attemptRecords.set(id, updated);
        return updated;
      });
      workspaceMock.findActiveAutomationGrant.mockReturnValue({ id: 'grant-1', policyId: AUTOMATION_POLICY_ID, createdAt: QUEUE_NOW, expiresAt: '2027-01-01T00:00:00.000Z', revokedAt: null });
      workspaceMock.listApplicationArtifacts.mockReturnValue([stagedArtifact('cv_pdf', '/fake/resume.pdf')]);
      extractPdfText.mockImplementation(async () => 'placeholder');

      // extractPdfText must name the right company/role per attempt for the gate to pass -- easier
      // to just return a superset string covering both employers' names/roles used above.
      extractPdfText.mockResolvedValue('Acme Corp Beta Inc Senior Engineer');

      const fired = await fireDueAutomaticSubmissions(FAKE_DB, FIRE_AT);

      const byAttempt = new Map(fired.map((f) => [f.attemptId, f]));
      expect(byAttempt.get(ATTEMPT_A)?.result.ok).toBe(true); // eligible, fires for real
      expect(byAttempt.get(ATTEMPT_B)?.result).toMatchObject({ ok: false, reason: 'no_prior_manual_submission_for_employer' });
      expect(byAttempt.get(ATTEMPT_C)?.result).toMatchObject({ ok: false, reason: 'per_employer_daily_cap_reached' });

      // Every one of the three was actually exercised (not silently skipped), and every one had
      // its schedule cleared regardless of outcome -- none is left dangling as "still scheduled".
      expect(fired).toHaveLength(3);
      for (const id of [ATTEMPT_A, ATTEMPT_B, ATTEMPT_C]) {
        expect(attemptRecords.get(id)!.scheduledAutomaticSubmitAt).toBeNull();
      }
      expect(notifyAutomaticSubmission).toHaveBeenCalledTimes(3);
    });

    it('refuses to fire an attempt that has already reached checkpoint "submitted" -- closes the manual/automatic double-submit race', async () => {
      mockAutomationPolicy();
      const { openApplicationReview, fireDueAutomaticSubmissions } = await importSession();
      createApplicationView.mockImplementation(() => fakeView(SUBMIT_TREE));
      await openApplicationReview({ attemptId: ATTEMPT_ID, policyId: AUTOMATION_POLICY_ID, targetUrl: FIXTURE_URL });
      const scheduledAt = '2026-02-01T12:03:00.000Z';
      // A manual submit reached the attempt first (checkpoint already "submitted") while it was
      // still scheduled for automatic firing too -- the exact race this guard exists to close.
      workspaceMock.getApplicationAttempt.mockReturnValue(withRealJdHash(fakeAttempt({ checkpoint: 'submitted', scheduledAutomaticSubmitAt: scheduledAt })));
      workspaceMock.listApplicationAttempts.mockReturnValue([withRealJdHash(fakeAttempt({ checkpoint: 'submitted', scheduledAutomaticSubmitAt: scheduledAt }))]);
      workspaceMock.findActiveAutomationGrant.mockReturnValue({ id: 'grant-1', policyId: AUTOMATION_POLICY_ID, createdAt: NOW, expiresAt: '2026-03-01T00:00:00.000Z', revokedAt: null });

      const fired = await fireDueAutomaticSubmissions(FAKE_DB, '2026-02-01T12:05:00.000Z');

      expect(fired).toEqual([{ attemptId: ATTEMPT_ID, company: 'Acme Corp', role: 'Senior Engineer', result: { ok: false, reason: 'already_submitted', detail: undefined } }]);
      // Never reached a second real click -- refused before the executor was ever touched again.
      expect(workspaceMock.updateApplicationAttempt).not.toHaveBeenCalledWith(FAKE_DB, ATTEMPT_ID, expect.objectContaining({ checkpoint: 'submitting' }));
    });

    it('refuses (and does not fire) a schedule found overdue by more than the cancel window -- the app was likely asleep or closed through it', async () => {
      mockAutomationPolicy();
      const { fireDueAutomaticSubmissions, AUTOMATIC_SUBMIT_CANCEL_WINDOW_MS } = await importSession();
      const scheduledAt = '2026-02-01T12:03:00.000Z';
      workspaceMock.listApplicationAttempts.mockReturnValue([withRealJdHash(fakeAttempt({ scheduledAutomaticSubmitAt: scheduledAt }))]);

      // Well past scheduledAt + the cancel window itself -- a real cancel window could not possibly
      // have elapsed while the app was actually running and visible to the user.
      const wayLater = new Date(Date.parse(scheduledAt) + AUTOMATIC_SUBMIT_CANCEL_WINDOW_MS + 60_000).toISOString();
      const fired = await fireDueAutomaticSubmissions(FAKE_DB, wayLater);

      expect(fired).toEqual([{ attemptId: ATTEMPT_ID, company: 'Acme Corp', role: 'Senior Engineer', result: { ok: false, reason: 'schedule_expired', detail: expect.any(String) } }]);
      expect(workspaceMock.updateApplicationAttempt).toHaveBeenCalledWith(FAKE_DB, ATTEMPT_ID, { scheduledAutomaticSubmitAt: null });
      expect(notifyAutomaticSubmission).toHaveBeenCalledWith(expect.objectContaining({ ok: false }));
    });
  });

  it('cancelScheduledAutomaticSubmission is a safe no-op for an attempt that no longer exists, never a thrown error', async () => {
    const { cancelScheduledAutomaticSubmission } = await importSession();
    workspaceMock.updateApplicationAttempt.mockImplementationOnce(() => {
      throw new workspaceMock.WorkspaceNotFoundError('application attempt', 'ghost-id');
    });

    expect(() => cancelScheduledAutomaticSubmission(FAKE_DB, 'ghost-id')).not.toThrow();
  });

  it('closeReview destroys the view and frees the attemptId for reuse; is a no-op if never opened', async () => {
    const { openApplicationReview, closeApplicationReview } = await importSession();
    const view = fakeView();
    createApplicationView.mockImplementation(() => view);
    await openApplicationReview({ attemptId: '11111111-1111-4111-8111-111111111111', policyId: 'ashby-fixture-test-only', targetUrl: FIXTURE_URL });

    await closeApplicationReview('22222222-2222-4222-8222-222222222222'); // no-op
    await closeApplicationReview('11111111-1111-4111-8111-111111111111');
    expect(view.destroy).toHaveBeenCalledTimes(1);

    await expect(
      openApplicationReview({ attemptId: '11111111-1111-4111-8111-111111111111', policyId: 'ashby-fixture-test-only', targetUrl: FIXTURE_URL }),
    ).resolves.toBeDefined();
  });
});
