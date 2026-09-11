import { createHash } from 'node:crypto';
import { basename } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ALLOWED_CDP_METHODS, type CdpDomNode } from '@agent-dock/application-executor';
import { stagedArtifactPath } from '../electron/application-artifact-staging.js';
import { FIXTURE_REVIEW_POLICY } from '../electron/application-target-policies.js';
import { HANDOFF_BANNER_HEIGHT_PX } from '../electron/application-view.js';

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
  createApplicationSubmissionReceipt: vi.fn((_db: unknown, input: Record<string, unknown>) => ({ id: 'receipt-1', ...input })),
  listApplicationSubmissionReceipts: vi.fn(() => [] as unknown[]),
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

// Only `createApplicationView` is faked. `HANDOFF_BANNER_HEIGHT_PX` is re-exported from the real
// module so the assertion below compares against the value the app actually sizes the view with,
// rather than one this test made up (which would pass for a build where the two disagreed).
vi.mock('../electron/application-view.js', async () => ({
  ...(await vi.importActual<typeof import('../electron/application-view.js')>('../electron/application-view.js')),
  createApplicationView,
}));
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
    // Arrives with a value already in it, the way a real page with a remembered/prefilled answer
    // does. `fakeBrowser` below seeds each control's committed state from its `value` attribute, so
    // this required field reads back non-empty without every test here having to fill it first --
    // which is what lets the tests about the *document* gate stay about the document gate. The
    // tests that care about an empty required field (#277) build a tree without this on purpose.
    { nodeName: 'INPUT', nodeType: 1, backendNodeId: 2, attributes: ['type', 'text', 'name', 'fullName', 'required', '', 'value', 'Ada Lovelace'] },
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

/** A confirmation page, with the application form gone and a receipt reference printed: the one
 * thing #271 accepts as evidence that a submission actually landed. */
const CONFIRMATION_TREE: CdpDomNode = {
  nodeName: 'BODY',
  nodeType: 1,
  backendNodeId: 1,
  children: [
    { nodeName: 'H1', nodeType: 1, backendNodeId: 20, children: [{ nodeName: '#text', nodeType: 3, backendNodeId: 21, nodeValue: 'Your application has been submitted' }] },
    { nodeName: 'P', nodeType: 1, backendNodeId: 22, children: [{ nodeName: '#text', nodeType: 3, backendNodeId: 23, nodeValue: 'Application reference: FIXTURE-2026-000123' }] },
  ],
};

/** The same form, re-rendered by the page's own handler with a required-field error still on it:
 * the exact shape of #271's bug, where the click resolves normally and nothing was submitted. */
const REQUIRED_ERROR_TREE: CdpDomNode = {
  nodeName: 'BODY',
  nodeType: 1,
  backendNodeId: 1,
  children: [
    { nodeName: 'DIV', nodeType: 1, backendNodeId: 30, attributes: ['class', 'field-error'], children: [{ nodeName: '#text', nodeType: 3, backendNodeId: 31, nodeValue: 'Full name is required' }] },
    ...SUBMIT_TREE.children!,
  ],
};

function attrOf(node: CdpDomNode, name: string): string | undefined {
  const list = node.attributes;
  if (!list) return undefined;
  for (let i = 0; i + 1 < list.length; i += 2) {
    if (list[i]?.toLowerCase() === name.toLowerCase()) return list[i + 1];
  }
  return undefined;
}

function walkTree(node: CdpDomNode, visit: (node: CdpDomNode) => void): void {
  visit(node);
  for (const child of node.children ?? []) walkTree(child, visit);
  if (node.contentDocument) walkTree(node.contentDocument, visit);
}

interface ControlState {
  kind: 'text' | 'checkbox' | 'radio' | 'select' | 'file' | 'other';
  value: string;
  checked: boolean;
  optionLabels: string[];
}

/**
 * A fake `CdpTransport` that behaves like a browser rather than like a recorder (#277).
 *
 * Before this ticket, this fake answered every write with `{}`: `Input.insertText` succeeded no
 * matter what, and nothing could be read back. That was fine while nothing read anything back, and
 * it is precisely the shape that made "we sent an insert command" look identical to "the field
 * holds this value" for as long as it did. Now it keeps per-control committed state, applies real
 * edits to it (select-all replaces, insertText appends into the selection, a click toggles a
 * checkbox, the arrow drive moves a select's selection), and publishes that state back through
 * `Accessibility.getPartialAXTree` exactly the way a real browser does.
 *
 * It keeps #273's file-input behaviour intact and generalizes it: a file input reports whatever is
 * currently selected on it as its own accessible value, `DOM.setFileInputFiles` *replaces* that
 * selection rather than adding to it, and an untouched one reports Chromium's own "No file chosen"
 * placeholder, which is what a silently failed attachment looks like from the outside.
 *
 * And it keeps #271's post-click observation: `afterSubmitTree`, when given, is what
 * `DOM.getDocument` starts returning once a real click has been dispatched, the fixture equivalent
 * of a page reacting to its own submit button. Without it the page never changes, which is itself
 * a case worth testing.
 *
 * The payoff is that the tests below assert against a thing that can actually disagree with the
 * executor: a fill that appended instead of replacing, or a select that never moved, fails here.
 */
function fakeBrowser(tree: CdpDomNode, options: { afterSubmitTree?: CdpDomNode; readFailsAfterSubmit?: boolean } = {}) {
  let clicked = false;
  const controls = new Map<number, ControlState>();
  walkTree(tree, (node) => {
    const inputType = (attrOf(node, 'type') ?? 'text').toLowerCase();
    const kind: ControlState['kind'] =
      node.nodeName === 'SELECT'
        ? 'select'
        : node.nodeName === 'TEXTAREA'
          ? 'text'
          : node.nodeName === 'INPUT'
            ? inputType === 'checkbox' || inputType === 'radio' || inputType === 'file'
              ? (inputType as 'checkbox' | 'radio' | 'file')
              : 'text'
            : 'other';
    if (kind === 'other') return;
    const optionLabels = (node.children ?? [])
      .filter((child) => child.nodeName === 'OPTION')
      .map((child) => (child.children ?? []).map((text) => text.nodeValue ?? '').join('') || (attrOf(child, 'value') ?? ''));
    controls.set(node.backendNodeId, {
      kind,
      // Seeded from the page's own markup, the way a real prefilled control arrives.
      value: kind === 'select' ? (optionLabels[0] ?? '') : (attrOf(node, 'value') ?? ''),
      checked: attrOf(node, 'checked') !== undefined,
      optionLabels,
    });
  });

  let focused: number | undefined;
  let lastBoxModelNode: number | undefined;
  let selectionIsWholeControl = false;
  let selectIndex = 0;

  /** What a real file input publishes as its accessible value: the selected file's base name, or
   * Chromium's own placeholder when nothing is selected. */
  function reportedFileValue(control: ControlState): string {
    return control.value === '' ? 'No file chosen' : control.value;
  }

  const sendCommand = vi.fn(async (method: string, params?: Record<string, unknown>) => {
    const backendNodeId = typeof params?.backendNodeId === 'number' ? params.backendNodeId : undefined;
    switch (method) {
      case 'Page.navigate':
        return {};
      case 'DOM.getDocument':
        if (clicked && options.readFailsAfterSubmit) throw new Error('the renderer went away');
        return { root: clicked && options.afterSubmitTree ? options.afterSubmitTree : tree };
      case 'Page.captureScreenshot':
        return { data: 'ZmFrZS1zY3JlZW5zaG90' };
      case 'DOM.getBoxModel':
        lastBoxModelNode = backendNodeId;
        return { model: { content: [0, 0, 10, 0, 10, 10, 0, 10] } };
      case 'DOM.getContentQuads':
        // Only reached for a page with more than one frame/form group; every fixture in this file
        // has one, so this simply answers "rendered" rather than modelling a hidden decoy (the
        // executor package's own suite covers that case against a fake that does).
        return { quads: [[0, 0, 10, 0, 10, 10, 0, 10]] };
      case 'DOM.focus': {
        focused = backendNodeId;
        selectionIsWholeControl = false;
        const control = focused !== undefined ? controls.get(focused) : undefined;
        selectIndex = control ? Math.max(0, control.optionLabels.indexOf(control.value)) : 0;
        return {};
      }
      case 'Input.insertText': {
        const control = focused !== undefined ? controls.get(focused) : undefined;
        if (control) {
          const text = typeof params?.text === 'string' ? params.text : '';
          // The whole point: without a preceding selectAll this APPENDS, which is what a repeated
          // fill used to do and what this fake now makes visible.
          control.value = selectionIsWholeControl ? text : control.value + text;
          selectionIsWholeControl = false;
        }
        return {};
      }
      case 'Input.dispatchKeyEvent': {
        const commands = Array.isArray(params?.commands) ? (params.commands as string[]) : [];
        const key = typeof params?.key === 'string' ? params.key : '';
        const isKeyDown = params?.type === 'keyDown';
        const control = focused !== undefined ? controls.get(focused) : undefined;
        if (commands.includes('selectAll')) selectionIsWholeControl = true;
        if (commands.includes('delete') && control) {
          control.value = '';
          selectionIsWholeControl = false;
        }
        if (isKeyDown && control?.kind === 'select') {
          if (key === 'ArrowUp') selectIndex = Math.max(0, selectIndex - 1);
          if (key === 'ArrowDown') selectIndex = Math.min(control.optionLabels.length - 1, selectIndex + 1);
          if (key === 'Enter') control.value = control.optionLabels[selectIndex] ?? '';
        }
        if (isKeyDown && key === 'Tab') focused = undefined; // a real blur
        return {};
      }
      case 'Input.dispatchMouseEvent': {
        // A dispatched click is what #271's `afterSubmitTree` keys off, and what toggles a
        // checkbox/radio (#277). Both, since a real click does both jobs on a real page.
        clicked = true;
        if (params?.type === 'mouseReleased' && lastBoxModelNode !== undefined) {
          const control = controls.get(lastBoxModelNode);
          if (control && (control.kind === 'checkbox' || control.kind === 'radio')) control.checked = !control.checked;
        }
        return {};
      }
      case 'DOM.setFileInputFiles': {
        const files = Array.isArray(params?.files) ? (params.files as string[]) : [];
        const control = backendNodeId !== undefined ? controls.get(backendNodeId) : undefined;
        if (control) control.value = (files[0] ?? '').split(/[\\/]/).pop() ?? '';
        return {};
      }
      case 'Accessibility.getFullAXTree':
        // What #273's `readBackAttachment` reads. Only file inputs are published here, matching the
        // narrower fake this replaced: it is the only control type that method is allowed to ask
        // about.
        return {
          nodes: [...controls.entries()]
            .filter(([, control]) => control.kind === 'file')
            .map(([nodeId, control]) => ({ backendDOMNodeId: nodeId, value: { type: 'string', value: reportedFileValue(control) } })),
        };
      case 'Accessibility.getPartialAXTree': {
        const control = backendNodeId !== undefined ? controls.get(backendNodeId) : undefined;
        if (!control) return { nodes: [] };
        return {
          nodes: [
            {
              backendDOMNodeId: backendNodeId,
              value: { type: 'string', value: control.kind === 'file' ? reportedFileValue(control) : control.value },
              name: { type: 'computedString', value: control.kind === 'file' ? reportedFileValue(control) : '' },
              properties:
                control.kind === 'checkbox' || control.kind === 'radio'
                  ? [{ name: 'checked', value: { type: 'tristate', value: control.checked ? 'true' : 'false' } }]
                  : [],
            },
          ],
        };
      }
      default:
        throw new Error(`unexpected CDP method in test: ${method} ${JSON.stringify(params)}`);
    }
  });

  return { controls, sendCommand };
}

function fakeView(tree: CdpDomNode = TREE, options: { afterSubmitTree?: CdpDomNode; readFailsAfterSubmit?: boolean } = {}) {
  const { sendCommand, controls } = fakeBrowser(tree, options);
  return {
    view: {},
    transport: { sendCommand },
    show: vi.fn(),
    hide: vi.fn(),
    shownIn: vi.fn(() => undefined),
    destroy: vi.fn(),
    /** Test-only: what the fake browser's controls hold, so a test can assert on committed state
     * rather than on which CDP calls happened to be issued. */
    controls,
  };
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
  workspaceMock.createApplicationSubmissionReceipt.mockReset().mockImplementation((_db: unknown, input: Record<string, unknown>) => ({ id: 'receipt-1', ...input }));
  workspaceMock.listApplicationSubmissionReceipts.mockReset().mockReturnValue([]);
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

  it('reopening the same attempt reuses its live review rather than building a second one (#277)', async () => {
    // Acceptance check 5: reopening the review view preserves the attempt. Before #277 this threw,
    // so the only way back into a review was close + open, which destroys the WebContentsView and
    // with it the authenticated session, the snapshot generation and every verified field.
    const { openApplicationReview, applyApplicationFieldMap } = await importSession();
    const view = fakeView();
    createApplicationView.mockImplementation(() => view);
    const first = await openApplicationReview({ attemptId: ATTEMPT_ID, policyId: 'ashby-fixture-test-only', targetUrl: FIXTURE_URL });

    const nameField = first.snapshot.fields.find((f) => f.label === 'fullName')!;
    await applyApplicationFieldMap(FAKE_DB, {
      attemptId: ATTEMPT_ID,
      valueTable: [{ valueRef: 'v0000000000000001', value: 'Grace Hopper', provenance: 'profile' }],
      fieldMap: {
        attemptId: ATTEMPT_ID,
        snapshotGeneration: first.snapshot.generation,
        assignments: [{ fieldRef: nameField.fieldRef, source: { kind: 'value', valueRef: 'v0000000000000001' } }],
        unmapped: [],
      },
    });

    const second = await openApplicationReview({ attemptId: ATTEMPT_ID, policyId: 'ashby-fixture-test-only', targetUrl: FIXTURE_URL });

    // Exactly one view was ever built, and it was never destroyed: no duplicate, nothing lost.
    expect(createApplicationView).toHaveBeenCalledTimes(1);
    expect(view.destroy).not.toHaveBeenCalled();
    // The same generation and the same field refs, so a field map bound to the first reading is
    // still valid against the second.
    expect(second.snapshot.generation).toBe(first.snapshot.generation);
    expect(second.snapshot.fields.map((f) => f.fieldRef)).toEqual(first.snapshot.fields.map((f) => f.fieldRef));
    // And the work done before the reopen is still there, read back off the live page.
    expect(second.readiness.verifiedFilledCount).toBe(1);
    expect(view.controls.get(2)?.value).toBe('Grace Hopper');
  });

  it('can refresh an existing live review into a new snapshot after a handoff changed the page', async () => {
    const { openApplicationReview } = await importSession();
    const view = fakeView();
    createApplicationView.mockImplementation(() => view);
    const first = await openApplicationReview({ attemptId: ATTEMPT_ID, policyId: 'ashby-fixture-test-only', targetUrl: FIXTURE_URL });

    const grownTree: CdpDomNode = {
      ...TREE,
      children: [
        ...TREE.children!,
        { nodeName: 'INPUT', nodeType: 1, backendNodeId: 30, attributes: ['type', 'text', 'name', 'salaryExpectation', 'required', ''] },
      ],
    };
    const realSendCommand = view.transport.sendCommand.getMockImplementation()!;
    view.transport.sendCommand.mockImplementation(async (method: string, params?: Record<string, unknown>) => {
      if (method === 'DOM.getDocument') return { root: grownTree };
      return realSendCommand(method, params);
    });

    const refreshed = await openApplicationReview({ attemptId: ATTEMPT_ID, policyId: 'ashby-fixture-test-only', targetUrl: FIXTURE_URL, refresh: true });

    expect(createApplicationView).toHaveBeenCalledTimes(1);
    expect(view.destroy).not.toHaveBeenCalled();
    expect(refreshed.snapshot.generation).toBe(first.snapshot.generation + 1);
    expect(refreshed.snapshot.fields.map((f) => f.label)).toContain('salaryExpectation');
    expect(refreshed.readiness.blockers).toContainEqual({ kind: 'required_field_empty', fieldRef: expect.any(String), label: 'salaryExpectation' });
  });

  it('refuses to reopen an attempt against a different target rather than answering from the wrong page', async () => {
    const { openApplicationReview } = await importSession();
    await openApplicationReview({ attemptId: ATTEMPT_ID, policyId: 'ashby-fixture-test-only', targetUrl: FIXTURE_URL });
    await expect(
      openApplicationReview({ attemptId: ATTEMPT_ID, policyId: 'ashby-fixture-test-only', targetUrl: 'https://elsewhere.example/apply' }),
    ).rejects.toThrow(/against a different target/);
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

    expect(result.ok).toBe(true);
    expect(result.appliedCount).toBe(3);
    // Every one of the three was read back and confirmed by the (browser-like) fake, which is a
    // much stronger claim than "three write commands were issued" (#277).
    expect(result.verifiedCount).toBe(3);
    expect(result.readiness?.verifiedFilledCount).toBe(3);
    const calledMethods = view.transport.sendCommand.mock.calls.map(([method]) => method as string);
    expect(calledMethods).toContain('Input.insertText'); // fullName
    expect(calledMethods).toContain('Input.dispatchKeyEvent'); // select's arrow/enter drive
    expect(calledMethods).toContain('Input.dispatchMouseEvent'); // checkbox click
    // The committed state of the real controls, not a record of what was sent to them.
    expect(view.controls.get(2)?.value).toBe('Ada Lovelace');
    expect(view.controls.get(3)?.value).toBe('Yes');
    expect(view.controls.get(8)?.checked).toBe(true);
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

      expect(result).toMatchObject({
        ok: true,
        appliedCount: 2,
        // #277: an attachment counts as verified only once the control itself reported holding the
        // staged file, which is the same bar every other write is held to.
        verifiedCount: 2,
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
      // And the control itself holds exactly that one file, not two appended selections.
      expect(view.controls.get(20)?.value).toBe(basename(cv.storagePath));
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
      workspaceMock.getApplicationAttempt.mockReturnValue(withRealJdHash(fakeAttempt()));
      expect(session.showApplicationReviewForHandoff(ATTEMPT_ID, mainWindow, FAKE_DB)).toBe(true);
      // Second argument is #277's Escape-to-exit callback.
      expect(view.show).toHaveBeenCalledWith(mainWindow, expect.any(Function));
      expect(session.showApplicationReviewForHandoff('99999999-9999-4999-8999-999999999999', mainWindow, FAKE_DB)).toBe(false);
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
      //
      // The confirmation page is #271's doing, not #276's: this test is about the *pre-submit gate*
      // letting a CV-only attempt through, and since #271 getting past the gate no longer implies
      // `ok: true` on its own -- a click onto a form that is still standing now resolves to
      // `submission_unknown` rather than to a submission nobody observed. Handing the fixture a
      // real confirmation keeps the assertion below testing the gate, which is what it is for.
      const { openApplicationReview, submitApplicationReview } = await importSession();
      createApplicationView.mockImplementation(() => fakeView(SUBMIT_TREE, { afterSubmitTree: CONFIRMATION_TREE }));
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

    it('fills, reviews, confirms, and submits for real against the fixture -- the happy path #202 exists for, now requiring a receipt (#271)', async () => {
      const { openApplicationReview, submitApplicationReview } = await importSession();
      const view = fakeView(SUBMIT_TREE, { afterSubmitTree: CONFIRMATION_TREE });
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
        // #271 + #275 reconciled: the observer established a real receipt, so this is the one path
        // entitled to assert #275's `receipt_confirmed`. See the write site in
        // `application-review-session.ts` for why no other caller may.
        completionEvidence: 'receipt_confirmed',
      });
      const calledMethods = view.transport.sendCommand.mock.calls.map(([method]) => method as string);
      expect(calledMethods).toContain('Input.dispatchMouseEvent'); // the real submit click
    });

    /**
     * #271's five acceptance cases, at the level that actually writes the checkpoint and the
     * durable evidence row. Every one of them runs against a hand-built fixture page; nothing in
     * this file can reach a real employer's form.
     */
    describe('submission receipts (#271)', () => {
      function readyToSubmit() {
        workspaceMock.getApplicationAttempt.mockReturnValue(withRealJdHash(fakeAttempt()));
        workspaceMock.listApplicationArtifacts.mockReturnValue([stagedArtifact('cv_pdf', '/fake/resume.pdf')]);
        extractPdfText.mockResolvedValue('Acme Corp Senior Engineer');
      }

      it('acceptance 1: a click that returns but leaves a required-field error never becomes submitted', async () => {
        const { openApplicationReview, submitApplicationReview } = await importSession();
        createApplicationView.mockImplementation(() => fakeView(SUBMIT_TREE, { afterSubmitTree: REQUIRED_ERROR_TREE }));
        await openApplicationReview({ attemptId: ATTEMPT_ID, policyId: 'ashby-fixture-test-only', targetUrl: FIXTURE_URL });
        readyToSubmit();

        const result = await submitApplicationReview(FAKE_DB, ATTEMPT_ID);

        expect(result).toMatchObject({ ok: false, reason: 'submission_rejected' });
        expect(result.detail).toContain('Full name is required');
        // The one assertion this whole ticket is about.
        expect(workspaceMock.updateApplicationAttempt).not.toHaveBeenCalledWith(FAKE_DB, ATTEMPT_ID, expect.objectContaining({ checkpoint: 'submitted' }));
        expect(workspaceMock.updateApplicationAttempt).toHaveBeenNthCalledWith(2, FAKE_DB, ATTEMPT_ID, {
          checkpoint: 'needs_user',
          checkpointDetail: expect.stringContaining('Full name is required'),
        });
        expect(workspaceMock.createApplicationSubmissionReceipt).toHaveBeenCalledWith(
          FAKE_DB,
          expect.objectContaining({ attemptId: ATTEMPT_ID, outcome: 'rejected', evidenceKind: 'none' }),
        );
      });

      it('acceptance 2: a matching confirmation page records submitted with attempt, destination, timestamp and evidence reference', async () => {
        const { openApplicationReview, submitApplicationReview } = await importSession();
        createApplicationView.mockImplementation(() => fakeView(SUBMIT_TREE, { afterSubmitTree: CONFIRMATION_TREE }));
        await openApplicationReview({ attemptId: ATTEMPT_ID, policyId: 'ashby-fixture-test-only', targetUrl: FIXTURE_URL });
        readyToSubmit();

        const result = await submitApplicationReview(FAKE_DB, ATTEMPT_ID);

        expect(result).toEqual({ ok: true });
        expect(workspaceMock.createApplicationSubmissionReceipt).toHaveBeenCalledWith(FAKE_DB, {
          attemptId: ATTEMPT_ID,
          outcome: 'submitted',
          source: 'page_observation',
          destination: FIXTURE_URL,
          evidenceKind: 'confirmation_page',
          evidenceReference: expect.stringContaining('Your application has been submitted'),
          detail: expect.any(String),
          observedAt: expect.any(String),
        });
        // The checkpoint's own submittedAt is the observation's timestamp, not a second clock read.
        const receipt = workspaceMock.createApplicationSubmissionReceipt.mock.calls[0]![1] as { observedAt: string };
        expect(workspaceMock.updateApplicationAttempt).toHaveBeenCalledWith(
          FAKE_DB,
          ATTEMPT_ID,
          expect.objectContaining({ checkpoint: 'submitted', submittedAt: receipt.observedAt }),
        );
      });

      it('acceptance 3: navigation loss after the click records submission_unknown, with the attempt kept out of a blind retry', async () => {
        const { openApplicationReview, submitApplicationReview } = await importSession();
        createApplicationView.mockImplementation(() => fakeView(SUBMIT_TREE, { readFailsAfterSubmit: true }));
        await openApplicationReview({ attemptId: ATTEMPT_ID, policyId: 'ashby-fixture-test-only', targetUrl: FIXTURE_URL });
        readyToSubmit();

        const result = await submitApplicationReview(FAKE_DB, ATTEMPT_ID);

        expect(result).toMatchObject({ ok: false, reason: 'submission_unknown' });
        expect(result.detail).toContain('the renderer went away');
        expect(workspaceMock.updateApplicationAttempt).toHaveBeenNthCalledWith(2, FAKE_DB, ATTEMPT_ID, {
          checkpoint: 'submission_unknown',
          checkpointDetail: expect.stringContaining('the renderer went away'),
          submittedAt: expect.any(String),
        });
        expect(workspaceMock.createApplicationSubmissionReceipt).toHaveBeenCalledWith(
          FAKE_DB,
          expect.objectContaining({ outcome: 'unknown', destination: FIXTURE_URL }),
        );
      });

      it('acceptance 3: a second submit on an attempt left at submission_unknown is refused, never blindly re-clicked', async () => {
        const { openApplicationReview, submitApplicationReview } = await importSession();
        const view = fakeView(SUBMIT_TREE, { afterSubmitTree: CONFIRMATION_TREE });
        createApplicationView.mockImplementation(() => view);
        await openApplicationReview({ attemptId: ATTEMPT_ID, policyId: 'ashby-fixture-test-only', targetUrl: FIXTURE_URL });
        workspaceMock.getApplicationAttempt.mockReturnValue(withRealJdHash(fakeAttempt({ checkpoint: 'submission_unknown' })));

        const result = await submitApplicationReview(FAKE_DB, ATTEMPT_ID);

        expect(result).toMatchObject({ ok: false, reason: 'submission_outcome_unresolved' });
        const clicks = view.transport.sendCommand.mock.calls.filter(([method]) => method === 'Input.dispatchMouseEvent');
        expect(clicks).toHaveLength(0); // nothing reached the page at all
        expect(workspaceMock.updateApplicationAttempt).not.toHaveBeenCalled();
      });

      it('acceptance 3: an automatic fire is refused for an attempt sitting on submission_unknown', async () => {
        const { openApplicationReview, fireDueAutomaticSubmissions } = await importSession();
        createApplicationView.mockImplementation(() => fakeView(SUBMIT_TREE, { afterSubmitTree: CONFIRMATION_TREE }));
        await openApplicationReview({ attemptId: ATTEMPT_ID, policyId: 'ashby-fixture-test-only', targetUrl: FIXTURE_URL });
        const scheduledAt = '2026-02-01T12:03:00.000Z';
        const unresolved = withRealJdHash(fakeAttempt({ checkpoint: 'submission_unknown', scheduledAutomaticSubmitAt: scheduledAt }));
        workspaceMock.getApplicationAttempt.mockReturnValue(unresolved);
        workspaceMock.listApplicationAttempts.mockReturnValue([unresolved]);

        const fired = await fireDueAutomaticSubmissions(FAKE_DB, '2026-02-01T12:05:00.000Z');

        expect(fired[0]?.result).toMatchObject({ ok: false, reason: 'already_submitted' });
        expect(workspaceMock.updateApplicationAttempt).not.toHaveBeenCalledWith(FAKE_DB, ATTEMPT_ID, expect.objectContaining({ checkpoint: 'submitting' }));
      });

      it('acceptance 4: a user-reported completion stays user_reported and never becomes submitted', async () => {
        const { recordUserReportedSubmission } = await importSession();
        workspaceMock.getApplicationAttempt.mockReturnValue(withRealJdHash(fakeAttempt({ checkpoint: 'submission_unknown' })));

        const result = recordUserReportedSubmission(FAKE_DB, ATTEMPT_ID, 'I finished this one in the browser myself.');

        expect(result).toEqual({ ok: true });
        expect(workspaceMock.updateApplicationAttempt).toHaveBeenCalledWith(FAKE_DB, ATTEMPT_ID, {
          checkpoint: 'user_reported',
          checkpointDetail: 'I finished this one in the browser myself.',
          // #275's evidence type, recorded alongside #271's checkpoint so the completed-application
          // lookup suppresses a duplicate for this attempt and can still say the completion came
          // from the person rather than from an observed receipt.
          completionEvidence: 'user_reported',
        });
        expect(workspaceMock.updateApplicationAttempt).not.toHaveBeenCalledWith(FAKE_DB, ATTEMPT_ID, expect.objectContaining({ checkpoint: 'submitted' }));
        // ...and never the value only a real observation may assert.
        expect(workspaceMock.updateApplicationAttempt).not.toHaveBeenCalledWith(
          FAKE_DB,
          ATTEMPT_ID,
          expect.objectContaining({ completionEvidence: 'receipt_confirmed' }),
        );
        expect(workspaceMock.createApplicationSubmissionReceipt).toHaveBeenCalledWith(
          FAKE_DB,
          expect.objectContaining({ outcome: 'user_reported', source: 'user_reported', evidenceKind: 'user_statement' }),
        );
      });

      it('acceptance 4: nothing downgrades a user-reported attempt on the absence of a confirmation', async () => {
        // The explicit statement of "no email does not mean failed": reconciliation is the only
        // thing that ever revisits an outcome, and it refuses to touch this state at all -- in
        // either direction.
        const { reconcileSubmissionOutcome } = await importSession();
        workspaceMock.getApplicationAttempt.mockReturnValue(withRealJdHash(fakeAttempt({ checkpoint: 'user_reported' })));

        const result = reconcileSubmissionOutcome(FAKE_DB, ATTEMPT_ID, { status: 404, body: 'no such application' });

        expect(result).toMatchObject({ ok: false, reason: 'outcome_already_resolved' });
        expect(workspaceMock.updateApplicationAttempt).not.toHaveBeenCalled();
      });

      it('acceptance 4: a person\'s report can never overwrite an already-observed submission', async () => {
        const { recordUserReportedSubmission } = await importSession();
        workspaceMock.getApplicationAttempt.mockReturnValue(withRealJdHash(fakeAttempt({ checkpoint: 'submitted' })));

        const result = recordUserReportedSubmission(FAKE_DB, ATTEMPT_ID);

        expect(result).toMatchObject({ ok: false, reason: 'already_observed' });
        expect(workspaceMock.updateApplicationAttempt).not.toHaveBeenCalled();
      });

      it('acceptance 5: an HTTP success carrying an application-error payload is not accepted as delivery', async () => {
        const { reconcileSubmissionOutcome } = await importSession();
        workspaceMock.getApplicationAttempt.mockReturnValue(withRealJdHash(fakeAttempt({ checkpoint: 'submission_unknown' })));

        const result = reconcileSubmissionOutcome(FAKE_DB, ATTEMPT_ID, {
          status: 200,
          body: JSON.stringify({ success: false, errors: [{ field: 'workAuthorization', message: 'unanswered' }] }),
        });

        expect(result).toMatchObject({ ok: false, reason: 'application_error_payload' });
        expect(workspaceMock.updateApplicationAttempt).not.toHaveBeenCalled();
        expect(workspaceMock.createApplicationSubmissionReceipt).toHaveBeenCalledWith(
          FAKE_DB,
          expect.objectContaining({ outcome: 'rejected', source: 'delayed_receipt' }),
        );
      });

      it('acceptance 5: a delayed receipt reconciles an unresolved outcome into submitted, with its own evidence row', async () => {
        const { reconcileSubmissionOutcome } = await importSession();
        workspaceMock.getApplicationAttempt.mockReturnValue(
          withRealJdHash(fakeAttempt({ checkpoint: 'submission_unknown', submittedAt: '2026-02-01T12:00:00.000Z' })),
        );

        const result = reconcileSubmissionOutcome(
          FAKE_DB,
          ATTEMPT_ID,
          { status: 202, body: JSON.stringify({ confirmationNumber: 'FIXTURE-9001' }) },
          '2026-02-02T09:00:00.000Z',
        );

        expect(result).toEqual({ ok: true });
        expect(workspaceMock.createApplicationSubmissionReceipt).toHaveBeenCalledWith(
          FAKE_DB,
          expect.objectContaining({
            outcome: 'submitted',
            source: 'delayed_receipt',
            evidenceKind: 'delivery_receipt',
            evidenceReference: expect.stringContaining('FIXTURE-9001'),
            observedAt: '2026-02-02T09:00:00.000Z',
          }),
        );
        // The original submit time is kept: the receipt confirms when it was *seen*, not when the
        // application was sent.
        expect(workspaceMock.updateApplicationAttempt).toHaveBeenCalledWith(
          FAKE_DB,
          ATTEMPT_ID,
          expect.objectContaining({ checkpoint: 'submitted', submittedAt: '2026-02-01T12:00:00.000Z' }),
        );
      });

      it('acceptance 5: a delayed acknowledgement with nothing conclusive in it leaves the attempt unresolved', async () => {
        const { reconcileSubmissionOutcome } = await importSession();
        workspaceMock.getApplicationAttempt.mockReturnValue(withRealJdHash(fakeAttempt({ checkpoint: 'submission_unknown' })));

        const result = reconcileSubmissionOutcome(FAKE_DB, ATTEMPT_ID, { status: 200, body: JSON.stringify({ queued: true }) });

        expect(result).toMatchObject({ ok: false, reason: 'no_delivery_evidence' });
        expect(workspaceMock.updateApplicationAttempt).not.toHaveBeenCalled();
      });

      it('reconciliation never overwrites an attempt whose outcome was already established', async () => {
        const { reconcileSubmissionOutcome } = await importSession();
        workspaceMock.getApplicationAttempt.mockReturnValue(withRealJdHash(fakeAttempt({ checkpoint: 'needs_user' })));

        const result = reconcileSubmissionOutcome(FAKE_DB, ATTEMPT_ID, { status: 200, body: JSON.stringify({ applicationId: 'fixture-1' }) });

        expect(result).toMatchObject({ ok: false, reason: 'outcome_already_resolved' });
        expect(workspaceMock.updateApplicationAttempt).not.toHaveBeenCalled();
      });

      it('a failed evidence write never takes down an established submission outcome', async () => {
        const { openApplicationReview, submitApplicationReview } = await importSession();
        createApplicationView.mockImplementation(() => fakeView(SUBMIT_TREE, { afterSubmitTree: CONFIRMATION_TREE }));
        await openApplicationReview({ attemptId: ATTEMPT_ID, policyId: 'ashby-fixture-test-only', targetUrl: FIXTURE_URL });
        readyToSubmit();
        workspaceMock.createApplicationSubmissionReceipt.mockImplementation(() => {
          throw new Error('database is locked');
        });

        const result = await submitApplicationReview(FAKE_DB, ATTEMPT_ID);

        expect(result).toEqual({ ok: true });
        expect(workspaceMock.updateApplicationAttempt).toHaveBeenCalledWith(FAKE_DB, ATTEMPT_ID, expect.objectContaining({ checkpoint: 'submitted' }));
      });
    });

    it('lands on submission_unknown, never a silent retry or drop, when the submit click itself fails ambiguously', async () => {
      const { openApplicationReview, submitApplicationReview } = await importSession();
      const view = fakeView(SUBMIT_TREE);
      // Fails only the one call the submit click itself makes, and otherwise delegates to the fake
      // browser: replacing the whole transport with a stub would also silence the read-back, and
      // this test would then be proving that an unfilled form refuses rather than that an
      // ambiguous click lands on `submission_unknown`.
      const realTransport = view.transport.sendCommand.getMockImplementation()!;
      view.transport.sendCommand.mockImplementation(async (method: string, params?: Record<string, unknown>) => {
        if (method === 'DOM.getBoxModel') throw new Error('CDP connection dropped');
        return realTransport(method, params);
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
      // The fixture page answers the automatic click with a real confirmation, so this end-to-end
      // path still reaches `submitted` under #271's receipt requirement.
      const view = fakeView(SUBMIT_TREE, { afterSubmitTree: CONFIRMATION_TREE });
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
        [ATTEMPT_A, fakeView(SUBMIT_TREE, { afterSubmitTree: CONFIRMATION_TREE })],
        [ATTEMPT_B, fakeView(SUBMIT_TREE, { afterSubmitTree: CONFIRMATION_TREE })],
        [ATTEMPT_C, fakeView(SUBMIT_TREE, { afterSubmitTree: CONFIRMATION_TREE })],
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

  /**
   * #277 acceptance 4: the live handoff. `application-view.ts`'s `show()` has existed since #201
   * with no production caller at all; these tests are about the caller, and above all about what
   * showing one attempt's page is not allowed to do to any other attempt's.
   */
  describe('the live handoff (#277 acceptance 4)', () => {
    const OTHER_ATTEMPT_ID = '22222222-2222-4222-8222-222222222222';
    const FAKE_WINDOW = { id: 'main-window' } as never;

    function attemptNamed(id: string, company: string, role: string) {
      return withRealJdHash(fakeAttempt({ id, company, role }));
    }

    it('shows the attempt\'s own view and reports the employer and role from the workspace record, not the page', async () => {
      const { openApplicationReview, showApplicationReviewHandoff } = await importSession();
      const view = fakeView();
      createApplicationView.mockImplementation(() => view);
      await openApplicationReview({ attemptId: ATTEMPT_ID, policyId: 'ashby-fixture-test-only', targetUrl: FIXTURE_URL });
      workspaceMock.getApplicationAttempt.mockReturnValue(attemptNamed(ATTEMPT_ID, 'Acme Corp', 'Senior Engineer'));

      const result = showApplicationReviewHandoff(FAKE_DB, FAKE_WINDOW, ATTEMPT_ID);

      expect(result).toMatchObject({ ok: true, company: 'Acme Corp', role: 'Senior Engineer' });
      expect(view.show).toHaveBeenCalledWith(FAKE_WINDOW, expect.any(Function));
    });

    it('showing a second attempt hides the first one\'s view without destroying or unregistering it', async () => {
      // The whole acceptance criterion: one window means one visible handoff, and it must cost
      // nothing anywhere else. A person switching between two pending applications must not find
      // that looking at one silently discarded the other.
      const { openApplicationReview, showApplicationReviewHandoff, applyApplicationFieldMap } = await importSession();
      const firstView = fakeView();
      const secondView = fakeView();
      createApplicationView.mockImplementationOnce(() => firstView).mockImplementationOnce(() => secondView);

      const first = await openApplicationReview({ attemptId: ATTEMPT_ID, policyId: 'ashby-fixture-test-only', targetUrl: FIXTURE_URL });
      await openApplicationReview({ attemptId: OTHER_ATTEMPT_ID, policyId: 'ashby-fixture-test-only', targetUrl: FIXTURE_URL });

      // Real work on the first attempt, so there is something that could be lost.
      const nameField = first.snapshot.fields.find((f) => f.label === 'fullName')!;
      await applyApplicationFieldMap(FAKE_DB, {
        attemptId: ATTEMPT_ID,
        valueTable: [{ valueRef: 'v0000000000000001', value: 'Grace Hopper', provenance: 'profile' }],
        fieldMap: {
          attemptId: ATTEMPT_ID,
          snapshotGeneration: first.snapshot.generation,
          assignments: [{ fieldRef: nameField.fieldRef, source: { kind: 'value', valueRef: 'v0000000000000001' } }],
          unmapped: [],
        },
      });

      workspaceMock.getApplicationAttempt.mockImplementation((_db: unknown, id: string) =>
        id === ATTEMPT_ID ? attemptNamed(ATTEMPT_ID, 'Acme Corp', 'Senior Engineer') : attemptNamed(OTHER_ATTEMPT_ID, 'Globex', 'Staff Engineer'),
      );

      expect(showApplicationReviewHandoff(FAKE_DB, FAKE_WINDOW, ATTEMPT_ID).ok).toBe(true);
      const second = showApplicationReviewHandoff(FAKE_DB, FAKE_WINDOW, OTHER_ATTEMPT_ID);

      expect(second).toMatchObject({ ok: true, company: 'Globex', role: 'Staff Engineer' });
      expect(firstView.hide).toHaveBeenCalledWith(FAKE_WINDOW);
      // Hidden, never destroyed, and never unregistered.
      expect(firstView.destroy).not.toHaveBeenCalled();
      expect(secondView.show).toHaveBeenCalledWith(FAKE_WINDOW, expect.any(Function));

      // The first attempt still has everything it had: the same view, the same snapshot
      // generation, the same refs, and the value that was committed to its page.
      const reopened = await openApplicationReview({ attemptId: ATTEMPT_ID, policyId: 'ashby-fixture-test-only', targetUrl: FIXTURE_URL });
      expect(reopened.snapshot.generation).toBe(first.snapshot.generation);
      expect(reopened.readiness.verifiedFilledCount).toBe(1);
      expect(firstView.controls.get(2)?.value).toBe('Grace Hopper');
    });

    it('closing the attempt that is NOT holding the handoff leaves the shown one exactly where it is', async () => {
      const { openApplicationReview, showApplicationReviewHandoff, closeApplicationReview, currentHandoffAttemptId } = await importSession();
      const shownView = fakeView();
      const otherView = fakeView();
      createApplicationView.mockImplementationOnce(() => shownView).mockImplementationOnce(() => otherView);
      await openApplicationReview({ attemptId: ATTEMPT_ID, policyId: 'ashby-fixture-test-only', targetUrl: FIXTURE_URL });
      await openApplicationReview({ attemptId: OTHER_ATTEMPT_ID, policyId: 'ashby-fixture-test-only', targetUrl: FIXTURE_URL });
      workspaceMock.getApplicationAttempt.mockReturnValue(attemptNamed(ATTEMPT_ID, 'Acme Corp', 'Senior Engineer'));
      showApplicationReviewHandoff(FAKE_DB, FAKE_WINDOW, ATTEMPT_ID);

      await closeApplicationReview(OTHER_ATTEMPT_ID);

      expect(otherView.destroy).toHaveBeenCalledTimes(1);
      expect(shownView.destroy).not.toHaveBeenCalled();
      expect(currentHandoffAttemptId()).toBe(ATTEMPT_ID);
    });

    it('hideHandoff for an attempt that is not the one showing is a no-op, never a hijack', async () => {
      const { openApplicationReview, showApplicationReviewHandoff, hideApplicationReviewHandoff, currentHandoffAttemptId } = await importSession();
      const shownView = fakeView();
      const otherView = fakeView();
      createApplicationView.mockImplementationOnce(() => shownView).mockImplementationOnce(() => otherView);
      await openApplicationReview({ attemptId: ATTEMPT_ID, policyId: 'ashby-fixture-test-only', targetUrl: FIXTURE_URL });
      await openApplicationReview({ attemptId: OTHER_ATTEMPT_ID, policyId: 'ashby-fixture-test-only', targetUrl: FIXTURE_URL });
      workspaceMock.getApplicationAttempt.mockReturnValue(attemptNamed(ATTEMPT_ID, 'Acme Corp', 'Senior Engineer'));
      showApplicationReviewHandoff(FAKE_DB, FAKE_WINDOW, ATTEMPT_ID);

      // A stale call from the other attempt's closing review.
      hideApplicationReviewHandoff(FAKE_WINDOW, OTHER_ATTEMPT_ID);
      expect(shownView.hide).not.toHaveBeenCalled();
      expect(currentHandoffAttemptId()).toBe(ATTEMPT_ID);

      hideApplicationReviewHandoff(FAKE_WINDOW, ATTEMPT_ID);
      expect(shownView.hide).toHaveBeenCalledWith(FAKE_WINDOW);
      expect(currentHandoffAttemptId()).toBeUndefined();
    });

    it('refuses a submit for an attempt whose live page a person currently has open', async () => {
      // The other half of the mutual exclusion: showing a handoff already refuses mid-submit, but
      // without this a submit could still fire under someone typing into the page. The automatic
      // path is where that matters most, since the timer has no idea anyone is looking.
      const { openApplicationReview, showApplicationReviewHandoff, submitApplicationReview } = await importSession();
      createApplicationView.mockImplementation(() => fakeView(SUBMIT_TREE));
      await openApplicationReview({ attemptId: ATTEMPT_ID, policyId: 'ashby-fixture-test-only', targetUrl: FIXTURE_URL });
      workspaceMock.getApplicationAttempt.mockReturnValue(attemptNamed(ATTEMPT_ID, 'Acme Corp', 'Senior Engineer'));
      showApplicationReviewHandoff(FAKE_DB, FAKE_WINDOW, ATTEMPT_ID);

      for (const mode of ['manual', 'automatic'] as const) {
        const result = await submitApplicationReview(FAKE_DB, ATTEMPT_ID, mode);
        expect(result, mode).toMatchObject({ ok: false, reason: 'handoff_in_progress' });
      }
      expect(workspaceMock.updateApplicationAttempt).not.toHaveBeenCalled();
    });

    it('tells the renderer how much of the window the live view leaves to the app', async () => {
      // One source of truth for the reserved strip: the main process sizes the view, so it is what
      // says how tall the banner is. A renderer that guessed would either be painted over by the
      // target page or leave a dead gap above it.
      const { openApplicationReview, showApplicationReviewHandoff } = await importSession();
      createApplicationView.mockImplementation(() => fakeView());
      await openApplicationReview({ attemptId: ATTEMPT_ID, policyId: 'ashby-fixture-test-only', targetUrl: FIXTURE_URL });
      workspaceMock.getApplicationAttempt.mockReturnValue(attemptNamed(ATTEMPT_ID, 'Acme Corp', 'Senior Engineer'));

      const result = showApplicationReviewHandoff(FAKE_DB, FAKE_WINDOW, ATTEMPT_ID);
      expect(result.bannerHeightPx).toBe(HANDOFF_BANNER_HEIGHT_PX);
    });

    it('gives the live view an Escape handler that ends the handoff without the page cooperating', async () => {
      const { openApplicationReview, showApplicationReviewHandoff, currentHandoffAttemptId } = await importSession();
      const view = fakeView();
      createApplicationView.mockImplementation(() => view);
      await openApplicationReview({ attemptId: ATTEMPT_ID, policyId: 'ashby-fixture-test-only', targetUrl: FIXTURE_URL });
      workspaceMock.getApplicationAttempt.mockReturnValue(attemptNamed(ATTEMPT_ID, 'Acme Corp', 'Senior Engineer'));
      showApplicationReviewHandoff(FAKE_DB, FAKE_WINDOW, ATTEMPT_ID);

      const [, onEscape] = view.show.mock.calls.at(-1) as [unknown, (() => void) | undefined];
      expect(onEscape).toBeTypeOf('function');
      onEscape!();

      expect(view.hide).toHaveBeenCalledWith(FAKE_WINDOW);
      expect(currentHandoffAttemptId()).toBeUndefined();
    });

    it('refuses, rather than throwing, when the attempt row is gone from under an open review', async () => {
      const { openApplicationReview, showApplicationReviewHandoff } = await importSession();
      createApplicationView.mockImplementation(() => fakeView());
      await openApplicationReview({ attemptId: ATTEMPT_ID, policyId: 'ashby-fixture-test-only', targetUrl: FIXTURE_URL });
      workspaceMock.getApplicationAttempt.mockImplementation(() => {
        throw new workspaceMock.WorkspaceNotFoundError('application attempt', ATTEMPT_ID);
      });

      expect(showApplicationReviewHandoff(FAKE_DB, FAKE_WINDOW, ATTEMPT_ID)).toMatchObject({ ok: false, reason: 'no_open_review' });
    });

    it('refuses for an attempt with no open review, rather than creating one', async () => {
      const { showApplicationReviewHandoff } = await importSession();
      const result = showApplicationReviewHandoff(FAKE_DB, FAKE_WINDOW, ATTEMPT_ID);
      expect(result).toMatchObject({ ok: false, reason: 'no_open_review' });
      expect(createApplicationView).not.toHaveBeenCalled();
    });

    it('refuses when the app has no main window to show it in', async () => {
      const { openApplicationReview, showApplicationReviewHandoff } = await importSession();
      await openApplicationReview({ attemptId: ATTEMPT_ID, policyId: 'ashby-fixture-test-only', targetUrl: FIXTURE_URL });
      expect(showApplicationReviewHandoff(FAKE_DB, undefined, ATTEMPT_ID)).toMatchObject({ ok: false, reason: 'no_window' });
    });
  });

  /**
   * #277 acceptance 3 and 5, at the orchestration layer: readiness is what stands between a filled
   * form and a real, irreversible click, and neither a screenshot nor a field inventory ever
   * contributes to a claim that a form is filled.
   */
  describe('readiness gates the real submit (#277 acceptance 3 and 5)', () => {
    /** The same application form, with nothing prefilled: `fullName` is required and empty. */
    const EMPTY_REQUIRED_TREE: CdpDomNode = {
      ...SUBMIT_TREE,
      children: [
        { nodeName: 'INPUT', nodeType: 1, backendNodeId: 2, attributes: ['type', 'text', 'name', 'fullName', 'required', ''] },
        { nodeName: 'BUTTON', nodeType: 1, backendNodeId: 9, children: [{ nodeName: '#text', nodeType: 3, backendNodeId: 10, nodeValue: 'Submit Application' }] },
      ],
    };

    it('an unattended submit refuses when the page changed during the cancel window (#277)', async () => {
      // The freshness gate needs a baseline that predates the automatic path's own re-read.
      // Comparing the fresh read against the snapshot taken one statement earlier would compare the
      // page to itself, so `stale_page_state` could never fire on the one path where nobody is
      // watching. The baseline is the fingerprint from before that re-read: what a person reviewed.
      const { openApplicationReview, submitApplicationReview } = await importSession();
      const view = fakeView(SUBMIT_TREE);
      createApplicationView.mockImplementation(() => view);
      await openApplicationReview({ attemptId: ATTEMPT_ID, policyId: 'ashby-fixture-test-only', targetUrl: FIXTURE_URL });

      workspaceMock.getApplicationAttempt.mockReturnValue(withRealJdHash(fakeAttempt()));
      workspaceMock.listApplicationArtifacts.mockReturnValue([stagedArtifact('cv_pdf', '/fake/resume.pdf')]);
      extractPdfText.mockResolvedValue('Acme Corp Senior Engineer');

      // The employer's form grows a new required question mid-window.
      const grownTree: CdpDomNode = {
        ...SUBMIT_TREE,
        children: [
          ...SUBMIT_TREE.children!,
          { nodeName: 'INPUT', nodeType: 1, backendNodeId: 30, attributes: ['type', 'text', 'name', 'salaryExpectation', 'required', ''] },
        ],
      };
      const realTransport = view.transport.sendCommand.getMockImplementation()!;
      view.transport.sendCommand.mockImplementation(async (method: string, params?: Record<string, unknown>) => {
        if (method === 'DOM.getDocument') return { root: grownTree };
        return realTransport(method, params);
      });

      const result = await submitApplicationReview(FAKE_DB, ATTEMPT_ID, 'automatic');

      expect(result).toMatchObject({ ok: false, reason: 'form_not_ready' });
      expect(result.detail).toContain('changed during the cancel window');
      expect(workspaceMock.updateApplicationAttempt).not.toHaveBeenCalled();
      expect(view.transport.sendCommand.mock.calls.filter(([method]) => method === 'Input.dispatchMouseEvent')).toHaveLength(0);
    });

    it('an unattended submit on an unchanged page still goes through, so the gate is not always-refusing', async () => {
      const { openApplicationReview, submitApplicationReview } = await importSession();
      // #271: the page has to produce a real receipt after the click, or the submit lands on
      // `submission_unknown` rather than succeeding.
      createApplicationView.mockImplementation(() => fakeView(SUBMIT_TREE, { afterSubmitTree: CONFIRMATION_TREE }));
      await openApplicationReview({ attemptId: ATTEMPT_ID, policyId: 'ashby-fixture-test-only', targetUrl: FIXTURE_URL });
      workspaceMock.getApplicationAttempt.mockReturnValue(withRealJdHash(fakeAttempt()));
      workspaceMock.listApplicationArtifacts.mockReturnValue([stagedArtifact('cv_pdf', '/fake/resume.pdf')]);
      extractPdfText.mockResolvedValue('Acme Corp Senior Engineer');

      expect(await submitApplicationReview(FAKE_DB, ATTEMPT_ID, 'automatic')).toEqual({ ok: true });
    });

    it('refuses to submit a form whose required field is empty, without ever touching the checkpoint', async () => {
      const { openApplicationReview, submitApplicationReview } = await importSession();
      const view = fakeView(EMPTY_REQUIRED_TREE);
      createApplicationView.mockImplementation(() => view);
      await openApplicationReview({ attemptId: ATTEMPT_ID, policyId: 'ashby-fixture-test-only', targetUrl: FIXTURE_URL });
      workspaceMock.getApplicationAttempt.mockReturnValue(withRealJdHash(fakeAttempt()));
      workspaceMock.listApplicationArtifacts.mockReturnValue([stagedArtifact('cv_pdf', '/fake/resume.pdf')]);
      extractPdfText.mockResolvedValue('Acme Corp Senior Engineer');

      const result = await submitApplicationReview(FAKE_DB, ATTEMPT_ID);

      expect(result).toMatchObject({ ok: false, reason: 'form_not_ready' });
      expect(result.detail).toContain('required field "fullName" is empty');
      expect(workspaceMock.updateApplicationAttempt).not.toHaveBeenCalled();
      // And nothing was clicked.
      expect(view.transport.sendCommand.mock.calls.filter(([method]) => method === 'Input.dispatchMouseEvent')).toHaveLength(0);
    });

    it('filling that same required field for real is what makes it submittable', async () => {
      const { openApplicationReview, applyApplicationFieldMap, submitApplicationReview } = await importSession();
      // #271: the page has to produce a real receipt after the click for the submit to succeed.
      const view = fakeView(EMPTY_REQUIRED_TREE, { afterSubmitTree: CONFIRMATION_TREE });
      createApplicationView.mockImplementation(() => view);
      const opened = await openApplicationReview({ attemptId: ATTEMPT_ID, policyId: 'ashby-fixture-test-only', targetUrl: FIXTURE_URL });

      // A screenshot was taken, and the snapshot found a field. Neither is worth anything yet.
      expect(opened.screenshotBase64).toBe('ZmFrZS1zY3JlZW5zaG90');
      expect(opened.snapshot.fields).toHaveLength(1);
      expect(opened.readiness.discoveredFieldCount).toBe(1);
      expect(opened.readiness.verifiedFilledCount).toBe(0);
      expect(opened.readiness.ready).toBe(false);

      const nameField = opened.snapshot.fields[0]!;
      const applied = await applyApplicationFieldMap(FAKE_DB, {
        attemptId: ATTEMPT_ID,
        valueTable: [{ valueRef: 'v0000000000000001', value: 'Ada Lovelace', provenance: 'profile' }],
        fieldMap: {
          attemptId: ATTEMPT_ID,
          snapshotGeneration: opened.snapshot.generation,
          assignments: [{ fieldRef: nameField.fieldRef, source: { kind: 'value', valueRef: 'v0000000000000001' } }],
          unmapped: [],
        },
      });
      expect(applied.readiness).toMatchObject({ ready: true, verifiedFilledCount: 1, discoveredFieldCount: 1 });

      workspaceMock.getApplicationAttempt.mockReturnValue(withRealJdHash(fakeAttempt()));
      workspaceMock.listApplicationArtifacts.mockReturnValue([stagedArtifact('cv_pdf', '/fake/resume.pdf')]);
      extractPdfText.mockResolvedValue('Acme Corp Senior Engineer');

      expect(await submitApplicationReview(FAKE_DB, ATTEMPT_ID)).toEqual({ ok: true });
    });
  });
});
