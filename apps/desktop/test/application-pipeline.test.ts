// @vitest-environment node
import { createHash } from 'node:crypto';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { jsPDF } from 'jspdf';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CdpDomNode } from '@agent-dock/application-executor';

/**
 * The end-to-end proof for issue #272: one vacancy carried through the *production* entry point --
 * queue, JD/CV snapshots, document staging, field-map generation, filling -- to an attempt a person
 * can review.
 *
 * What is real here, and what is not, stated plainly because the ticket's own acceptance check
 * turns on it:
 *
 *  - **Real:** `startApplicationAttempt`/`runApplicationAttempt` themselves (the same functions
 *    `main.ts`'s IPC channel and timer call), a real migrated SQLite workspace, the real dedup rule,
 *    the real `stageApplicationDocuments` with the real document-acceptance contract over real PDF
 *    bytes, the real field-map prompt, the real `parseFieldMap` and the real `validateFieldMap`
 *    (Domain B), the real `ApplicationExecutor` issuing real CDP commands, and the real
 *    per-attempt review registry. Nothing pre-fills the page: every value that ends up in the form
 *    got there because the executor actually issued `DOM.focus` + `Input.insertText` for it, and
 *    the test asserts exactly that.
 *  - **Stood in for:** the two things that are genuinely other processes. Chromium is replaced by a
 *    fake `CdpTransport` serving a DOM tree that mirrors
 *    `e2e/fixtures/ashby-application-form-no-upload.html` (real Chromium extraction of that fixture
 *    is `e2e/application-executor.spec.ts`'s job), and `printToPDF` is replaced by a stand-in that
 *    hands back real, jsPDF-produced PDF bytes -- which then go through the real acceptance
 *    contract unchanged. The generation session is replaced by `deterministicFieldMapper`, which
 *    reads the *real* prompt this pipeline produces and answers it; the daemon's Claude process is
 *    not something a unit test can host.
 *  - **Not covered here at all:** that each committed value is genuinely committed on the live page
 *    (issue #277 / R06), that a document upload actually attached (issue #273 / R02b), and that a
 *    submission produced a receipt (issue #271 / R01). The pipeline refuses to claim any of those,
 *    and the tests below assert the refusals rather than working around them.
 */

// ------------------------------------------------------------------------------------ mocks

const { printQueue } = vi.hoisted(() => ({ printQueue: [] as Uint8Array[] }));
const { printToPDF } = vi.hoisted(() => ({ printToPDF: vi.fn() }));

vi.mock('electron', () => ({
  BrowserWindow: class {
    webContents = {
      printToPDF: async (): Promise<Buffer> => {
        printToPDF();
        return Buffer.from(printQueue.shift() ?? new Uint8Array());
      },
    };
    async loadURL(): Promise<void> {}
    destroy(): void {}
  },
}));

const { createApplicationView } = vi.hoisted(() => ({ createApplicationView: vi.fn() }));
vi.mock('../electron/application-view.js', () => ({ createApplicationView }));

const { createWorkspaceDb } = await import('../electron/workspace/client.js');
const workspace = await import('../electron/workspace/repository.js');
const { FIXTURE_FORM_URLS } = await import('../electron/application-target-policies.js');
const pipeline = await import('../electron/application-pipeline.js');
const { closeAllApplicationReviews } = await import('../electron/application-review-session.js');
import type { WorkspaceDb } from '../electron/workspace/client.js';
import type {
  ApplicationPipelineDeps,
  ApplicationQueueEntryState,
  ApplicationQueuePort,
  PipelineVacancy,
} from '../electron/application-pipeline.js';
import type { CvSourceDocument } from '../electron/workspace/cv-source-schema.js';

// ------------------------------------------------------------------------- the fixture form

/**
 * A DOM tree mirroring `e2e/fixtures/ashby-application-form-no-upload.html`, control for control.
 * Labels come out as the `name` attributes because that is what `dom-extract.ts`'s `resolveLabel`
 * actually resolves to for these shapes -- the same values `e2e/application-executor.spec.ts`
 * asserts against a real Chromium render of the sibling fixture.
 */
function noUploadFormTree(): CdpDomNode {
  return {
    nodeName: 'BODY',
    nodeType: 1,
    backendNodeId: 1,
    children: [
      { nodeName: 'INPUT', nodeType: 1, backendNodeId: 2, attributes: ['type', 'text', 'name', 'fullName', 'autocomplete', 'name', 'required', ''] },
      { nodeName: 'INPUT', nodeType: 1, backendNodeId: 3, attributes: ['type', 'email', 'name', 'email', 'autocomplete', 'email', 'required', ''] },
      { nodeName: 'INPUT', nodeType: 1, backendNodeId: 4, attributes: ['type', 'tel', 'name', 'phone', 'autocomplete', 'tel'] },
      { nodeName: 'INPUT', nodeType: 1, backendNodeId: 5, attributes: ['type', 'url', 'name', 'linkedInUrl'] },
      { nodeName: 'INPUT', nodeType: 1, backendNodeId: 6, attributes: ['type', 'text', 'name', 'currentLocation', 'required', ''] },
      {
        nodeName: 'SELECT',
        nodeType: 1,
        backendNodeId: 7,
        attributes: ['name', 'workArrangement', 'required', ''],
        children: [
          { nodeName: 'OPTION', nodeType: 1, backendNodeId: 8, attributes: ['value', ''], children: [{ nodeName: '#text', nodeType: 3, backendNodeId: 9, nodeValue: 'Select one' }] },
          { nodeName: 'OPTION', nodeType: 1, backendNodeId: 10, attributes: ['value', 'remote'], children: [{ nodeName: '#text', nodeType: 3, backendNodeId: 11, nodeValue: 'Remote' }] },
          { nodeName: 'OPTION', nodeType: 1, backendNodeId: 12, attributes: ['value', 'hybrid'], children: [{ nodeName: '#text', nodeType: 3, backendNodeId: 13, nodeValue: 'Hybrid' }] },
        ],
      },
      { nodeName: 'TEXTAREA', nodeType: 1, backendNodeId: 14, attributes: ['name', 'coverLetter'] },
      // The structurally hidden honeypot: must never be surfaced as a fillable field.
      { nodeName: 'INPUT', nodeType: 1, backendNodeId: 15, attributes: ['type', 'text', 'name', 'referralSource', 'hidden', ''] },
      { nodeName: 'INPUT', nodeType: 1, backendNodeId: 16, attributes: ['type', 'checkbox', 'name', 'agreeToTerms', 'required', ''] },
      { nodeName: 'BUTTON', nodeType: 1, backendNodeId: 17, children: [{ nodeName: '#text', nodeType: 3, backendNodeId: 18, nodeValue: 'Submit Application' }] },
    ],
  };
}

/** The sibling fixture, which does have a required document upload. */
function uploadFormTree(): CdpDomNode {
  const tree = noUploadFormTree();
  return {
    ...tree,
    children: [
      ...(tree.children ?? []),
      { nodeName: 'INPUT', nodeType: 1, backendNodeId: 19, attributes: ['type', 'file', 'name', 'resume', 'accept', '.pdf', 'required', ''] },
    ],
  };
}

function requiredCoverLetterFormTree(): CdpDomNode {
  const tree = uploadFormTree();
  return {
    ...tree,
    children: [
      ...(tree.children ?? []),
      { nodeName: 'INPUT', nodeType: 1, backendNodeId: 20, attributes: ['type', 'file', 'name', 'coverLetter', 'accept', '.pdf', 'required', ''] },
    ],
  };
}

interface FakeView {
  sendCommand: ReturnType<typeof vi.fn>;
  destroy: ReturnType<typeof vi.fn>;
}

const views: FakeView[] = [];

interface ControlState {
  kind: 'text' | 'checkbox' | 'radio' | 'select' | 'file';
  value: string;
  checked: boolean;
  optionLabels: string[];
}

function attrOf(node: CdpDomNode, name: string): string | undefined {
  const list = node.attributes ?? [];
  for (let index = 0; index + 1 < list.length; index += 2) {
    if (list[index]?.toLowerCase() === name.toLowerCase()) return list[index + 1];
  }
  return undefined;
}

function walkTree(node: CdpDomNode, visit: (node: CdpDomNode) => void): void {
  visit(node);
  for (const child of node.children ?? []) walkTree(child, visit);
  if (node.contentDocument) walkTree(node.contentDocument, visit);
}

/** Records every CDP command so a test can prove the executor really typed a value, rather than
 * a value merely appearing in a summary this pipeline wrote itself. */
function fakeView(tree: CdpDomNode) {
  const controls = new Map<number, ControlState>();
  walkTree(tree, (node) => {
    const inputType = (attrOf(node, 'type') ?? 'text').toLowerCase();
    const kind: ControlState['kind'] | undefined =
      node.nodeName === 'SELECT'
        ? 'select'
        : node.nodeName === 'TEXTAREA'
          ? 'text'
          : node.nodeName === 'INPUT'
            ? inputType === 'checkbox' || inputType === 'radio' || inputType === 'file'
              ? inputType
              : 'text'
            : undefined;
    if (!kind) return;
    const optionLabels = (node.children ?? [])
      .filter((child) => child.nodeName === 'OPTION')
      .map((child) => (child.children ?? []).map((text) => text.nodeValue ?? '').join('') || (attrOf(child, 'value') ?? ''));
    controls.set(node.backendNodeId, {
      kind,
      value: kind === 'select' ? (optionLabels[0] ?? '') : (attrOf(node, 'value') ?? ''),
      checked: attrOf(node, 'checked') !== undefined,
      optionLabels,
    });
  });

  let focused: number | undefined;
  let lastBoxModelNode: number | undefined;
  let selectionIsWholeControl = false;

  function reportedFileValue(control: ControlState): string {
    return control.value === '' ? 'No file chosen' : control.value;
  }

  const sendCommand = vi.fn(async (method: string, params?: Record<string, unknown>) => {
    const backendNodeId = typeof params?.backendNodeId === 'number' ? params.backendNodeId : undefined;
    switch (method) {
      case 'Page.navigate':
        return {};
      case 'DOM.getDocument':
        return { root: tree };
      case 'Page.captureScreenshot':
        return { data: 'ZmFrZS1zY3JlZW5zaG90' };
      case 'DOM.getBoxModel':
        lastBoxModelNode = backendNodeId;
        return { model: { content: [0, 0, 10, 0, 10, 10, 0, 10] } };
      case 'DOM.focus':
        focused = backendNodeId;
        selectionIsWholeControl = false;
        return {};
      case 'Input.insertText': {
        const control = focused !== undefined ? controls.get(focused) : undefined;
        if (control) {
          const text = typeof params?.text === 'string' ? params.text : '';
          control.value = selectionIsWholeControl ? text : control.value + text;
          selectionIsWholeControl = false;
        }
        return {};
      }
      case 'Input.dispatchKeyEvent': {
        const commands = Array.isArray(params?.commands) ? (params.commands as string[]) : [];
        const control = focused !== undefined ? controls.get(focused) : undefined;
        if (commands.includes('selectAll')) selectionIsWholeControl = true;
        if (commands.includes('delete') && control) {
          control.value = '';
          selectionIsWholeControl = false;
        }
        if (params?.key === 'Tab') focused = undefined;
        return {};
      }
      case 'Input.dispatchMouseEvent':
        if (params?.type === 'mouseReleased' && lastBoxModelNode !== undefined) {
          const control = controls.get(lastBoxModelNode);
          if (control && (control.kind === 'checkbox' || control.kind === 'radio')) control.checked = !control.checked;
        }
        return {};
      case 'DOM.setFileInputFiles': {
        const control = backendNodeId !== undefined ? controls.get(backendNodeId) : undefined;
        const files = Array.isArray(params?.files) ? (params.files as string[]) : [];
        if (control) control.value = (files[0] ?? '').split(/[\\/]/u).pop() ?? '';
        return {};
      }
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
      case 'Accessibility.getFullAXTree':
        return {
          nodes: [...controls.entries()]
            .filter(([, control]) => control.kind === 'file')
            .map(([nodeId, control]) => ({ backendDOMNodeId: nodeId, value: { type: 'string', value: reportedFileValue(control) } })),
        };
      case 'DOM.getContentQuads':
        return {};
      default:
        throw new Error(`unexpected CDP method in test: ${method}`);
    }
  });
  const view: FakeView = { sendCommand, destroy: vi.fn() };
  views.push(view);
  return { view: {}, transport: { sendCommand }, show: vi.fn(), hide: vi.fn(), destroy: view.destroy };
}

function insertedText(): string[] {
  return views.flatMap((view) =>
    view.sendCommand.mock.calls
      .filter((call) => call[0] === 'Input.insertText')
      .map((call) => String((call[1] as { text?: unknown } | undefined)?.text ?? '')),
  );
}

// --------------------------------------------------------------------------- the fake queue

/**
 * An in-memory stand-in for the daemon's durable queue, with the same transition semantics: one
 * lease at a time, only `queued` entries are schedulable, a `paused` entry is not, and releasing a
 * lease that has already moved on is a silent no-op.
 *
 * `apps/daemon/test/application-queue-store.test.ts` is what proves the real store's durability and
 * recovery; what these tests need is the contract, not a second copy of that proof.
 */
class FakeQueue {
  entries = new Map<string, ApplicationQueueEntryState>();
  lease: { leaseId: string; attemptId: string } | null = null;
  enqueued: string[] = [];
  #nextLeaseId = 0;

  port: ApplicationQueuePort = {
    enqueue: async (attemptId) => {
      this.enqueued.push(attemptId);
      const existing = this.entries.get(attemptId);
      if (existing && existing !== 'cancelled' && existing !== 'done' && existing !== 'failed') return;
      this.entries.set(attemptId, 'queued');
    },
    acquireLease: async () => {
      if (this.lease) return null;
      const next = [...this.entries.entries()].find(([, state]) => state === 'queued');
      if (!next) return null;
      this.entries.set(next[0], 'active');
      this.#nextLeaseId += 1;
      this.lease = { leaseId: `lease-${this.#nextLeaseId}`, attemptId: next[0] };
      return this.lease;
    },
    release: async (leaseId, outcome) => {
      if (!this.lease || this.lease.leaseId !== leaseId) return;
      const attemptId = this.lease.attemptId;
      this.lease = null;
      this.entries.set(attemptId, outcome === 'requeue' ? 'queued' : outcome === 'completed' ? 'done' : 'failed');
    },
    entryState: async (attemptId) => this.entries.get(attemptId) ?? null,
  };

  pause(attemptId: string): void {
    if (this.lease?.attemptId === attemptId) this.lease = null;
    this.entries.set(attemptId, 'paused');
  }

  resume(attemptId: string): void {
    this.entries.set(attemptId, 'queued');
  }

  cancel(attemptId: string): void {
    if (this.lease?.attemptId === attemptId) this.lease = null;
    this.entries.set(attemptId, 'cancelled');
  }
}

// ------------------------------------------------------------------ the fake Domain A session

interface PromptField {
  ref: string;
  label: string;
  type: string;
  excluded: boolean;
}

/**
 * Reads the *real* prompt this pipeline builds and answers it the way a cooperating generation
 * session would: match each form field to the one available value that is unmistakably what it
 * asks for, and list everything else as unmapped.
 *
 * Parsing the prompt rather than being handed the snapshot is deliberate. It means the prompt has
 * to actually contain the refs, labels and value descriptions it claims to, and it means the
 * pipeline's own value table is what the answer is drawn from -- an answer cannot name a value that
 * was never offered, exactly as Domain B will independently insist.
 */
function deterministicFieldMapper(prompt: string): string {
  const attemptId = /"attemptId" must be exactly "([^"]+)"/u.exec(prompt)?.[1] ?? '';
  const snapshotGeneration = Number(/"snapshotGeneration" exactly (\d+)/u.exec(prompt)?.[1] ?? '0');

  const fields: PromptField[] = [];
  for (const line of prompt.split('\n')) {
    const match = /^- ref: (f[0-9a-f]{16}), label: "([^"]*)", type: (\w+), required: (?:true|false)(.*)$/u.exec(line);
    if (match) fields.push({ ref: match[1]!, label: match[2]!, type: match[3]!, excluded: match[4]!.includes('excluded:') });
  }

  const values = new Map<string, string>();
  for (const line of prompt.split('\n')) {
    const match = /^- (v[0-9a-f]{16}): (.+)$/u.exec(line);
    if (match) values.set(match[2]!.trim(), match[1]!);
  }

  const WANTED: ReadonlyArray<[RegExp, string]> = [
    [/^fullName$/iu, 'Full name'],
    [/^email$/iu, 'Email address'],
    [/^phone$/iu, 'Phone number'],
    [/^currentLocation$/iu, 'Current location'],
    [/^linkedInUrl$/iu, 'LinkedIn profile URL'],
  ];

  const assignments: Array<{ fieldRef: string; source: { kind: 'value'; valueRef: string } }> = [];
  const unmapped: Array<{ fieldRef: string; reason: string }> = [];
  for (const field of fields) {
    if (field.excluded) {
      unmapped.push({ fieldRef: field.ref, reason: 'consent_field' });
      continue;
    }
    const wanted = WANTED.find(([pattern]) => pattern.test(field.label));
    const valueRef = wanted ? values.get(wanted[1]) : undefined;
    if (valueRef) assignments.push({ fieldRef: field.ref, source: { kind: 'value', valueRef } });
    else unmapped.push({ fieldRef: field.ref, reason: 'needs_user' });
  }

  // Wrapped in a markdown fence on purpose: a real session does this often enough that the
  // pipeline's own extraction has to cope with it, and a test that only ever sends bare JSON would
  // never exercise that.
  return ['```json', JSON.stringify({ attemptId, snapshotGeneration, assignments, unmapped }), '```'].join('\n');
}

// ------------------------------------------------------------------------------- test data

const SOURCE_CV: CvSourceDocument = {
  contact: {
    name: 'Jamie Rivera',
    title: 'Senior Engineer',
    location: 'Amsterdam',
    email: 'jamie@example.invalid',
    phone: '+31 6 1234 5678',
    // No links on purpose: a CV that carries one requires the finished PDF to carry a real link
    // annotation (see `resumeAcceptanceContract`), which a jsPDF text render does not produce. The
    // form's optional LinkedIn field is therefore left honestly blank, which is itself asserted.
    links: [],
  },
  summary: 'Synthetic summary for a synthetic candidate.',
  experience: [
    { company: 'Redwood Software', title: 'Senior Engineer', dates: '2021 - Present', engagement: 'employment', client: '', bullets: ['Built things.'] },
  ],
  education: [],
  projects: [],
  maxProjects: 0,
  complete: true,
  incompleteReason: '',
  coveredChars: 100,
  sourceChars: 100,
  reviewedAt: '2026-01-01T00:00:00.000Z',
};

const VACANCY: PipelineVacancy = {
  vacancyKey: 'v1',
  company: 'Northwind Freight',
  role: 'Logistics Platform Engineer',
  applyUrl: FIXTURE_FORM_URLS.withoutUpload,
  description: 'Northwind Freight is hiring a Logistics Platform Engineer to work on our routing platform.',
  descriptionComplete: true,
};

function resumePdf(): Uint8Array {
  const doc = new jsPDF({ unit: 'pt', format: 'a4' });
  doc.setProperties({ title: 'Jamie Rivera' });
  doc.setFontSize(11);
  ['Jamie Rivera', 'Senior Engineer', 'Amsterdam', 'Redwood Software', 'Built things.'].forEach((line, index) =>
    doc.text(line, 56, 60 + index * 18),
  );
  return new Uint8Array(doc.output('arraybuffer'));
}

function coverLetterPdf(): Uint8Array {
  const doc = new jsPDF({ unit: 'pt', format: 'a4' });
  doc.setProperties({ title: 'Cover Letter' });
  doc.setFontSize(11);
  ['Cover Letter', 'Dear Northwind Freight hiring team,', 'I am applying for the Logistics Platform Engineer role.', 'Jamie Rivera']
    .forEach((line, index) => doc.text(line, 56, 60 + index * 18));
  return new Uint8Array(doc.output('arraybuffer'));
}

let dir: string;
let db: WorkspaceDb;
let closeDb: () => void;
let queue: FakeQueue;
let deps: ApplicationPipelineDeps;
let generateFieldMap: ReturnType<typeof vi.fn>;
let generateTailoredResume: ReturnType<typeof vi.fn>;
let generateCoverLetter: ReturnType<typeof vi.fn>;

function makeDeps(database: WorkspaceDb): ApplicationPipelineDeps {
  return {
    db: database,
    storageRoot: join(dir, 'application-artifacts'),
    queue: queue.port,
    generateFieldMap: generateFieldMap as unknown as ApplicationPipelineDeps['generateFieldMap'],
    generateTailoredResume: generateTailoredResume as unknown as ApplicationPipelineDeps['generateTailoredResume'],
    generateCoverLetter: generateCoverLetter as unknown as ApplicationPipelineDeps['generateCoverLetter'],
    loadProfile: async () => ({
      candidateName: 'Jamie Rivera',
      currentRole: 'Senior Engineer',
      location: 'Amsterdam',
      professionalLanguage: 'English, Dutch',
    }),
    now: () => new Date('2026-09-11T12:00:00.000Z'),
  };
}

function seedCv(database: WorkspaceDb): string {
  return workspace.createCvDocument(database, {
    name: 'Main CV',
    kind: 'manual',
    text: 'Jamie Rivera, Senior Engineer at Redwood Software.',
    profile: { title: 'Senior Engineer', location: 'Amsterdam', skills: ['TypeScript'], summary: 'Synthetic summary.' },
    source: SOURCE_CV,
    isDefault: true,
  }).id;
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ovr-pipeline-test-'));
  ({ db, close: closeDb } = createWorkspaceDb(dir));
  views.length = 0;
  printQueue.length = 0;
  printToPDF.mockClear();
  createApplicationView.mockReset().mockImplementation(() => fakeView(noUploadFormTree()));
  generateFieldMap = vi.fn(async (prompt: string) => ({ ok: true, text: deterministicFieldMapper(prompt) }));
  generateTailoredResume = vi.fn(async () => ({
    ok: true,
    text: JSON.stringify({
      contact: SOURCE_CV.contact,
      summary: SOURCE_CV.summary,
      experience: SOURCE_CV.experience,
      projects: [],
      skills: ['TypeScript'],
      education: [],
    }),
  }));
  generateCoverLetter = vi.fn(async () => ({
    ok: true,
    text: '{"factIds":["summary","experience-1","skill-1"]}',
  }));
  queue = new FakeQueue();
  deps = makeDeps(db);
  seedCv(db);
});

afterEach(() => {
  closeAllApplicationReviews();
  closeDb();
  rmSync(dir, { recursive: true, force: true });
});

/** Every normal run stages the attempt's tailored CV and its generated or requested letter. */
function queueApplicationDocumentRenders(): void {
  printQueue.push(resumePdf(), coverLetterPdf());
}

async function prepareOneApplication(): Promise<string> {
  const started = await pipeline.startApplicationAttempt(deps, { vacancy: VACANCY });
  if (!started.ok || !started.attemptId) throw new Error(`start refused: ${started.reason ?? 'unknown'}`);
  queueApplicationDocumentRenders();
  await pipeline.runNextApplicationAttempt(deps);
  return started.attemptId;
}

// --------------------------------------------------------------------------------- the tests

describe('acceptance 1: the production entry point reaches ready-for-review', () => {
  it('carries one vacancy from the start channel through queue, staging, generation and filling to ready', async () => {
    const started = await pipeline.startApplicationAttempt(deps, { vacancy: VACANCY });
    expect(started.ok).toBe(true);
    expect(queue.enqueued).toEqual([started.attemptId]);

    // Nothing has been prepared yet: starting records and queues, it does not do the work.
    expect(workspace.getApplicationAttempt(db, started.attemptId!).checkpoint).toBe('queued');
    expect(createApplicationView).not.toHaveBeenCalled();

    queueApplicationDocumentRenders();
    const ticked = await pipeline.runNextApplicationAttempt(deps);
    expect(ticked.result?.outcome).toBe('ready');

    const attempt = workspace.getApplicationAttempt(db, started.attemptId!);
    expect(attempt.checkpoint).toBe('ready');
    expect(attempt.workflowVersion).toBe(pipeline.APPLICATION_PIPELINE_WORKFLOW_VERSION);
    expect(attempt.tailoringMode).toBe('ai');
    expect(generateTailoredResume).toHaveBeenCalledTimes(1);
    expect(generateTailoredResume.mock.calls[0]?.[0]).toContain(VACANCY.description);

    // The full JD text was snapshotted, and its hash is the one the pre-submit gate recomputes.
    expect(attempt.jdSnapshot).toBe(VACANCY.description);
    expect(attempt.jdSnapshotHash).toBe(createHash('sha256').update(VACANCY.description!).digest('hex'));

    // A real CV PDF was staged, accepted, and registered against this attempt.
    const artifacts = workspace.listApplicationArtifacts(db, attempt.id);
    expect(artifacts.map((artifact) => artifact.kind)).toEqual(['cv_pdf', 'cover_letter_pdf']);
    expect(artifacts[0]!.byteSize).toBeGreaterThan(0);

    // The queue lease was taken and given back.
    expect(queue.lease).toBeNull();
    expect(queue.entries.get(attempt.id)).toBe('done');
  });

  it('types the real values into the real page rather than reporting them filled', async () => {
    const attemptId = await prepareOneApplication();

    // The proof that nothing was shortcut: the executor actually issued Input.insertText for each
    // committed value, with the value that came out of the reviewed CV.
    expect(insertedText()).toEqual(
      expect.arrayContaining(['Jamie Rivera', 'jamie@example.invalid', '+31 6 1234 5678', 'Amsterdam']),
    );

    const prepared = workspace.getApplicationAttempt(db, attemptId).preparedFields;
    expect(prepared?.verification).toBe('applied');
    const byLabel = new Map(prepared!.fields.map((field) => [field.label, field]));
    expect(byLabel.get('fullName')).toMatchObject({ status: 'committed', value: 'Jamie Rivera', provenance: 'cv' });
    expect(byLabel.get('email')).toMatchObject({ status: 'committed', value: 'jamie@example.invalid', provenance: 'cv' });
    expect(byLabel.get('currentLocation')).toMatchObject({ status: 'committed', value: 'Amsterdam', provenance: 'cv' });
  });

  it('keeps the prepared view alive so the person reviews the filled page, not a fresh blank one', async () => {
    await prepareOneApplication();
    expect(views).toHaveLength(1);
    expect(views[0]!.destroy).not.toHaveBeenCalled();
  });

  it('never fabricates an answer: a detail no saved record holds is left for the person', async () => {
    const attemptId = await prepareOneApplication();
    const byLabel = new Map(workspace.getApplicationAttempt(db, attemptId).preparedFields!.fields.map((f) => [f.label, f]));

    // The CV carries no links, so the optional LinkedIn field stays empty rather than guessing one.
    expect(byLabel.get('linkedInUrl')).toMatchObject({ status: 'left_blank' });
    expect(insertedText()).not.toContain('');
    // A select is a claim about the candidate that no saved record answers.
    expect(byLabel.get('workArrangement')).toMatchObject({ status: 'awaiting_you' });
    // And the consent checkbox is never answered on someone's behalf -- the existing consent gate,
    // unchanged: it reaches the review as the person's own to tick.
    expect(byLabel.get('agreeToTerms')).toMatchObject({ status: 'awaiting_you' });
    expect(byLabel.get('agreeToTerms')?.detail).toContain('never answers');

    // The page's hidden honeypot never became a field at all.
    expect(byLabel.has('referralSource')).toBe(false);
  });

  it('stops at ready and never submits', async () => {
    await prepareOneApplication();
    const clicked = views.flatMap((view) => view.sendCommand.mock.calls.filter((call) => call[0] === 'Input.dispatchMouseEvent'));
    expect(clicked).toHaveLength(0);
  });
});

describe('acceptance 2: navigation and restarts never duplicate an attempt', () => {
  it('refuses a second attempt for the same vacancy and names the one already in progress', async () => {
    const first = await pipeline.startApplicationAttempt(deps, { vacancy: VACANCY });
    const second = await pipeline.startApplicationAttempt(deps, { vacancy: VACANCY });

    expect(second).toMatchObject({ ok: false, reason: 'attempt_already_in_progress', attemptId: first.attemptId });
    expect(workspace.listApplicationAttempts(db)).toHaveLength(1);
  });

  it('reconciles queue state before retrying a transient enqueue failure', async () => {
    let enqueueCalls = 0;
    const recoveringDeps: ApplicationPipelineDeps = {
      ...deps,
      queue: {
        ...queue.port,
        enqueue: async (attemptId) => {
          enqueueCalls += 1;
          if (enqueueCalls === 1) throw new Error('connection reset');
          await queue.port.enqueue(attemptId);
        },
      },
    };

    const result = await pipeline.startApplicationAttempt(recoveringDeps, { vacancy: VACANCY });

    expect(result.ok).toBe(true);
    expect(enqueueCalls).toBe(2);
    expect(await queue.port.entryState(result.attemptId!)).toBe('queued');
  });

  it('marks an unscheduled attempt failed so a queue outage cannot wedge future starts', async () => {
    const unavailableDeps: ApplicationPipelineDeps = {
      ...deps,
      queue: {
        ...queue.port,
        enqueue: async () => {
          throw new Error('queue unavailable');
        },
        entryState: async () => null,
      },
    };

    await expect(pipeline.startApplicationAttempt(unavailableDeps, { vacancy: VACANCY })).rejects.toThrow('queue unavailable');
    expect(workspace.listApplicationAttempts(db)[0]).toMatchObject({ checkpoint: 'failed' });

    await expect(pipeline.startApplicationAttempt(deps, { vacancy: VACANCY })).resolves.toMatchObject({ ok: true });
  });

  it('leaves an already-prepared attempt exactly as it is when the pipeline runs again', async () => {
    const attemptId = await prepareOneApplication();
    const before = workspace.getApplicationAttempt(db, attemptId);
    const rendersBefore = printToPDF.mock.calls.length;

    const again = await pipeline.runApplicationAttempt(deps, attemptId);

    expect(again.outcome).toBe('already_settled');
    expect(printToPDF.mock.calls.length).toBe(rendersBefore);
    expect(views).toHaveLength(1); // no second browser view was ever opened
    expect(workspace.getApplicationAttempt(db, attemptId)).toEqual(before);
  });

  it('survives an app restart: the checkpoint and the committed answers are read back from disk', async () => {
    const attemptId = await prepareOneApplication();

    // A real restart: close the database and open the same directory again, exactly as a relaunched
    // app does. Nothing about this attempt lives in the process that just went away.
    closeDb();
    const reopened = createWorkspaceDb(dir);
    try {
      const attempt = workspace.getApplicationAttempt(reopened.db, attemptId);
      expect(attempt.checkpoint).toBe('ready');
      expect(attempt.preparedFields?.company).toBe(VACANCY.company);
      expect(attempt.preparedFields?.fields.find((field) => field.label === 'fullName')?.value).toBe('Jamie Rivera');
      expect(workspace.listApplicationArtifacts(reopened.db, attemptId)).toHaveLength(2);
    } finally {
      reopened.close();
    }
    ({ db, close: closeDb } = createWorkspaceDb(dir));
  });

  it('holds a paused attempt without preparing it, and picks it up again on resume', async () => {
    const started = await pipeline.startApplicationAttempt(deps, { vacancy: VACANCY });
    queue.pause(started.attemptId!);

    const held = await pipeline.runApplicationAttempt(deps, started.attemptId!);
    expect(held.outcome).toBe('halted');
    expect(workspace.getApplicationAttempt(db, started.attemptId!).checkpoint).toBe('queued');
    expect(createApplicationView).not.toHaveBeenCalled();

    // A pause is durable across a restart in the same way everything else here is: it is the
    // daemon's own queue state plus this attempt's own checkpoint, both of them written down.
    queue.resume(started.attemptId!);
    queueApplicationDocumentRenders();
    const resumed = await pipeline.runNextApplicationAttempt(deps);
    expect(resumed.result?.outcome).toBe('ready');
  });

  it('records a cancelled attempt as skipped rather than preparing it', async () => {
    const started = await pipeline.startApplicationAttempt(deps, { vacancy: VACANCY });
    queue.cancel(started.attemptId!);

    const halted = await pipeline.runApplicationAttempt(deps, started.attemptId!);
    expect(halted.outcome).toBe('halted');
    expect(workspace.getApplicationAttempt(db, started.attemptId!).checkpoint).toBe('skipped');
    expect(createApplicationView).not.toHaveBeenCalled();
  });

  it('re-queues an attempt a previous run left mid-preparation, and leaves settled ones alone', async () => {
    const interrupted = workspace.createApplicationAttempt(db, {
      vacancyKey: 'vac-interrupted',
      canonicalUrl: FIXTURE_FORM_URLS.withoutUpload,
      company: 'Northwind Freight',
      role: 'Logistics Platform Engineer',
      sourceCvContentHash: 'hash',
      jdSnapshotHash: 'hash',
      checkpoint: 'filling',
    });
    const blocked = workspace.createApplicationAttempt(db, {
      vacancyKey: 'vac-blocked',
      canonicalUrl: 'https://jobs.example.invalid/apply/9',
      company: 'Other Co',
      role: 'Engineer',
      sourceCvContentHash: 'hash',
      jdSnapshotHash: 'hash',
      checkpoint: 'needs_user',
      checkpointDetail: 'apply on the site yourself',
    });

    const recovered = await pipeline.recoverInterruptedApplicationAttempts(deps);

    expect(recovered).toEqual([{ attemptId: interrupted.id, from: 'filling' }]);
    expect(workspace.getApplicationAttempt(db, interrupted.id).checkpoint).toBe('queued');
    expect(queue.enqueued).toContain(interrupted.id);

    // The blocked handoff is untouched, which is what makes it durable: nothing about restarting
    // the app clears a state that is waiting on a person.
    const afterRecovery = workspace.getApplicationAttempt(db, blocked.id);
    expect(afterRecovery.checkpoint).toBe('needs_user');
    expect(afterRecovery.checkpointDetail).toBe('apply on the site yourself');
    expect(queue.enqueued).not.toContain(blocked.id);
  });

  it('replaces staged documents after an interrupted run instead of duplicating them', async () => {
    const started = await pipeline.startApplicationAttempt(deps, { vacancy: VACANCY });
    let stateReads = 0;
    const interruptedDeps: ApplicationPipelineDeps = {
      ...deps,
      queue: {
        ...queue.port,
        entryState: async (attemptId) => {
          stateReads += 1;
          if (stateReads === 2) throw new Error('simulated interruption after staging');
          return queue.port.entryState(attemptId);
        },
      },
    };
    queueApplicationDocumentRenders();

    await expect(pipeline.runApplicationAttempt(interruptedDeps, started.attemptId!))
      .rejects.toThrow('simulated interruption after staging');
    const firstArtifacts = workspace.listApplicationArtifacts(db, started.attemptId!);
    expect(firstArtifacts.map((artifact) => artifact.kind)).toEqual(['cv_pdf', 'cover_letter_pdf']);
    expect(workspace.getApplicationAttempt(db, started.attemptId!).checkpoint).toBe('rendering');

    await pipeline.recoverInterruptedApplicationAttempts(deps);
    queueApplicationDocumentRenders();
    await expect(pipeline.runApplicationAttempt(deps, started.attemptId!)).resolves.toMatchObject({ outcome: 'ready' });

    const currentArtifacts = workspace.listApplicationArtifacts(db, started.attemptId!);
    expect(currentArtifacts.map((artifact) => artifact.kind)).toEqual(['cv_pdf', 'cover_letter_pdf']);
    expect(currentArtifacts.map((artifact) => artifact.id)).not.toEqual(firstArtifacts.map((artifact) => artifact.id));
    expect(readdirSync(join(dir, 'application-artifacts', started.attemptId!))).toHaveLength(2);
  });

  it('re-queues an attempt the daemon never heard about, without touching a paused one', async () => {
    // The state a start leaves behind when the daemon was unreachable: the attempt is recorded, the
    // queue knows nothing about it, and the dedup rule would refuse a fresh start for the vacancy.
    const stranded = workspace.createApplicationAttempt(db, {
      vacancyKey: 'vac-stranded',
      canonicalUrl: FIXTURE_FORM_URLS.withoutUpload,
      company: 'Northwind Freight',
      role: 'Logistics Platform Engineer',
      sourceCvContentHash: 'hash',
      jdSnapshotHash: 'hash',
      checkpoint: 'queued',
    });
    const paused = workspace.createApplicationAttempt(db, {
      vacancyKey: 'vac-paused',
      canonicalUrl: FIXTURE_FORM_URLS.withoutUpload,
      company: 'Northwind Freight',
      role: 'Logistics Platform Engineer',
      sourceCvContentHash: 'hash',
      jdSnapshotHash: 'hash',
      checkpoint: 'queued',
    });
    queue.pause(paused.id);

    const recovered = await pipeline.recoverInterruptedApplicationAttempts(deps);

    expect(recovered).toEqual([{ attemptId: stranded.id, from: 'queued' }]);
    expect(queue.enqueued).toEqual([stranded.id]);
    // A pause is a person's decision, and recovery never undoes it.
    expect(queue.entries.get(paused.id)).toBe('paused');
  });
});

describe('acceptance 3: the review shows this attempt\'s own documents and answers', () => {
  it('records the employer and role the answers were prepared for', async () => {
    const attemptId = await prepareOneApplication();
    const prepared = workspace.getApplicationAttempt(db, attemptId).preparedFields;
    expect(prepared).toMatchObject({ company: 'Northwind Freight', role: 'Logistics Platform Engineer' });
  });

  it('scopes artifacts to the attempt they belong to', async () => {
    const attemptId = await prepareOneApplication();
    const other = workspace.createApplicationAttempt(db, {
      vacancyKey: 'vac-other',
      canonicalUrl: 'https://jobs.example.invalid/apply/2',
      company: 'Other Co',
      role: 'Engineer',
      sourceCvContentHash: 'hash',
      jdSnapshotHash: 'hash',
    });

    expect(workspace.listApplicationArtifacts(db, attemptId)).toHaveLength(2);
    expect(workspace.listApplicationArtifacts(db, other.id)).toHaveLength(0);
    expect(other.preparedFields).toBeNull();
  });

  it('clears a previous run\'s answers before a fresh one starts, so nothing stale can be shown', async () => {
    const attemptId = await prepareOneApplication();
    expect(workspace.getApplicationAttempt(db, attemptId).preparedFields).not.toBeNull();

    // Force a re-run the way restart recovery would, then make generation fail: the attempt must be
    // left with no answers at all rather than the ones from the run before.
    workspace.updateApplicationAttempt(db, attemptId, { checkpoint: 'queued', checkpointDetail: '' });
    generateFieldMap.mockResolvedValueOnce({ ok: false, text: '', error: 'the session failed' });
    queueApplicationDocumentRenders();

    const rerun = await pipeline.runApplicationAttempt(deps, attemptId);
    expect(rerun.outcome).toBe('needs_user');
    expect(workspace.getApplicationAttempt(db, attemptId).preparedFields).toBeNull();
  });
});

describe('acceptance 4: an unsupported destination gets a handoff, not the fixture\'s trust', () => {
  it('refuses to prepare a real employer URL and explains what to do instead', async () => {
    const started = await pipeline.startApplicationAttempt(deps, {
      vacancy: { ...VACANCY, vacancyKey: 'vac-live', applyUrl: 'https://jobs.example.invalid/apply/123' },
    });
    queueApplicationDocumentRenders();
    const ticked = await pipeline.runNextApplicationAttempt(deps);

    expect(ticked.result?.outcome).toBe('needs_user');
    const attempt = workspace.getApplicationAttempt(db, started.attemptId!);
    expect(attempt.checkpoint).toBe('needs_user');
    expect(attempt.checkpointDetail).toContain('apply on the site yourself');
    expect(workspace.listApplicationArtifacts(db, attempt.id).map((artifact) => artifact.kind))
      .toEqual(['cv_pdf', 'cover_letter_pdf']);
    expect(generateCoverLetter).toHaveBeenCalledTimes(1);

    // Nothing was opened, nothing was typed, and no policy was resolved for it: an unsupported
    // destination does not inherit the fixture's allowlist, actions, or kill-switch settings.
    expect(createApplicationView).not.toHaveBeenCalled();
    expect(insertedText()).toEqual([]);
  });

  it('keeps the tailored CV and manual handoff when an unsupported target gets an unsafe generated letter', async () => {
    generateCoverLetter.mockResolvedValueOnce({
      ok: true,
      text: '{"factIds":["experience-99"]}',
    });
    const started = await pipeline.startApplicationAttempt(deps, {
      vacancy: { ...VACANCY, vacancyKey: 'vac-unsupported-claim', applyUrl: 'https://jobs.example.invalid/apply/claim' },
    });
    queueApplicationDocumentRenders();

    const ticked = await pipeline.runNextApplicationAttempt(deps);

    expect(ticked.result?.outcome).toBe('needs_user');
    expect(workspace.getApplicationAttempt(db, started.attemptId!).checkpointDetail)
      .toMatch(/unsupported source facts.*experience-99/iu);
    expect(workspace.getApplicationAttempt(db, started.attemptId!).checkpointDetail).toContain('Your tailored CV is ready.');
    expect(workspace.getApplicationAttempt(db, started.attemptId!).checkpointDetail).toContain('Use Generate letter');
    expect(workspace.listApplicationArtifacts(db, started.attemptId!).map((artifact) => artifact.kind)).toEqual(['cv_pdf']);
    expect(createApplicationView).not.toHaveBeenCalled();
  });

  it('stages a requested final letter without replacing it with automatic generation', async () => {
    workspace.createLetter(db, {
      title: 'Cover Letter',
      company: VACANCY.company,
      role: VACANCY.role,
      type: 'cover_letter',
      status: 'final',
      vacancyKey: VACANCY.vacancyKey,
      body: 'Dear Northwind Freight hiring team,\n\nI am applying for the Logistics Platform Engineer role.\n\nJamie Rivera',
    });
    const started = await pipeline.startApplicationAttempt(deps, {
      vacancy: { ...VACANCY, applyUrl: 'https://jobs.example.invalid/apply/requested-letter' },
    });
    queueApplicationDocumentRenders();

    const ticked = await pipeline.runNextApplicationAttempt(deps);

    expect(ticked.result?.outcome).toBe('needs_user');
    expect(generateCoverLetter).not.toHaveBeenCalled();
    expect(workspace.listApplicationArtifacts(db, started.attemptId!).map((artifact) => artifact.kind))
      .toEqual(['cv_pdf', 'cover_letter_pdf']);
  });

  it('offers a durable retry after tailoring fails', async () => {
    generateTailoredResume.mockResolvedValueOnce({ ok: false, text: '', error: 'provider unavailable' });
    const started = await pipeline.startApplicationAttempt(deps, { vacancy: VACANCY });
    const first = await pipeline.runNextApplicationAttempt(deps);

    expect(first.result?.outcome).toBe('needs_user');
    expect(workspace.getApplicationAttempt(db, started.attemptId!).checkpointDetail).toContain('provider unavailable');

    const restarted = await pipeline.restartApplicationTailoring(deps, started.attemptId!, 'ai');
    expect(restarted).toMatchObject({ ok: true, tailoringMode: 'ai' });
    expect(workspace.getApplicationAttempt(db, started.attemptId!)).toMatchObject({ checkpoint: 'queued', tailoringMode: 'ai' });

    queueApplicationDocumentRenders();
    const second = await pipeline.runNextApplicationAttempt(deps);
    expect(second.result?.outcome).toBe('ready');
    expect(generateTailoredResume).toHaveBeenCalledTimes(2);
  });

  it('requeues a preparation blocker after the person addresses it', async () => {
    const started = await pipeline.startApplicationAttempt(deps, {
      vacancy: { ...VACANCY, vacancyKey: 'vac-incomplete', description: null, descriptionComplete: false },
    });
    await pipeline.runNextApplicationAttempt(deps);
    expect(workspace.getApplicationAttempt(db, started.attemptId!)).toMatchObject({ checkpoint: 'needs_user' });

    const resumed = await pipeline.resumeApplicationAttempt(deps, started.attemptId!);

    expect(resumed.ok).toBe(true);
    expect(workspace.getApplicationAttempt(db, started.attemptId!)).toMatchObject({ checkpoint: 'queued' });
    expect(await queue.port.entryState(started.attemptId!)).toBe('queued');
  });

  it('marks a resumed attempt failed when it cannot be scheduled', async () => {
    const started = await pipeline.startApplicationAttempt(deps, {
      vacancy: { ...VACANCY, vacancyKey: 'vac-resume-outage', description: null, descriptionComplete: false },
    });
    await pipeline.runNextApplicationAttempt(deps);
    const unavailableDeps: ApplicationPipelineDeps = {
      ...deps,
      queue: {
        ...queue.port,
        enqueue: async () => {
          throw new Error('queue unavailable');
        },
        entryState: async () => null,
      },
    };

    await expect(pipeline.resumeApplicationAttempt(unavailableDeps, started.attemptId!)).rejects.toThrow(
      'queue unavailable',
    );
    expect(workspace.getApplicationAttempt(db, started.attemptId!)).toMatchObject({ checkpoint: 'failed' });
  });

  it('uses the original reviewed CV only after an explicit recovery choice', async () => {
    generateTailoredResume.mockResolvedValueOnce({ ok: false, text: '', error: 'invalid response' });
    const started = await pipeline.startApplicationAttempt(deps, { vacancy: VACANCY });
    await pipeline.runNextApplicationAttempt(deps);

    const restarted = await pipeline.restartApplicationTailoring(deps, started.attemptId!, 'original');
    expect(restarted).toMatchObject({ ok: true, tailoringMode: 'original' });
    expect(workspace.getApplicationAttempt(db, started.attemptId!).tailoringMode).toBe('original');

    queueApplicationDocumentRenders();
    const second = await pipeline.runNextApplicationAttempt(deps);
    expect(second.result?.outcome).toBe('ready');
    expect(generateTailoredResume).toHaveBeenCalledTimes(1);
    expect(workspace.getApplicationAttempt(db, started.attemptId!).checkpointDetail).toContain('Original reviewed CV used');
  });

  it('does not extend the fixture policy to any other local file', async () => {
    const targets = ['https://jobs.example.invalid/apply/1', 'file:///C:/Users/someone/Desktop/apply.html', 'file:///etc/passwd'];
    const { resolvePolicyIdForCanonicalUrl } = await import('../electron/application-target-policies.js');
    for (const target of targets) {
      expect(resolvePolicyIdForCanonicalUrl(target)).toBeUndefined();
    }
    expect(resolvePolicyIdForCanonicalUrl(FIXTURE_FORM_URLS.withoutUpload)).toBe('ashby-fixture-test-only');
  });

  it('hands a vacancy with no captured job description to the person instead of tailoring from nothing', async () => {
    const started = await pipeline.startApplicationAttempt(deps, {
      vacancy: { ...VACANCY, vacancyKey: 'vac-no-jd', description: null, descriptionComplete: false },
    });
    const ticked = await pipeline.runNextApplicationAttempt(deps);

    expect(ticked.result?.outcome).toBe('needs_user');
    expect(workspace.getApplicationAttempt(db, started.attemptId!).checkpointDetail).toContain('no job description');
    expect(printToPDF).not.toHaveBeenCalled();
  });
});

describe('acceptance 5: verified uploads and live readiness decide whether the attempt is ready', () => {
  it('attaches a required document upload and records the page-confirmed file', async () => {
    createApplicationView.mockReset().mockImplementation(() => fakeView(uploadFormTree()));
    const started = await pipeline.startApplicationAttempt(deps, {
      vacancy: { ...VACANCY, vacancyKey: 'vac-upload', applyUrl: FIXTURE_FORM_URLS.withUpload },
    });
    queueApplicationDocumentRenders();
    const ticked = await pipeline.runNextApplicationAttempt(deps);

    expect(ticked.result?.outcome).toBe('ready');
    const attempt = workspace.getApplicationAttempt(db, started.attemptId!);
    expect(attempt.checkpoint).toBe('ready');

    const byLabel = new Map(attempt.preparedFields!.fields.map((field) => [field.label, field]));
    expect(byLabel.get('fullName')).toMatchObject({ status: 'committed' });
    expect(byLabel.get('resume')).toMatchObject({ status: 'committed', required: true });
    expect(byLabel.get('resume')?.value).toContain('resume.pdf');
  });

  it('generates, validates, stages, and attaches a cover letter when the live form requires one', async () => {
    createApplicationView.mockReset().mockImplementation(() => fakeView(requiredCoverLetterFormTree()));
    const started = await pipeline.startApplicationAttempt(deps, {
      vacancy: { ...VACANCY, vacancyKey: 'vac-cover-letter', applyUrl: FIXTURE_FORM_URLS.withUpload },
    });
    queueApplicationDocumentRenders();

    const ticked = await pipeline.runNextApplicationAttempt(deps);

    expect(ticked.result?.outcome).toBe('ready');
    expect(generateCoverLetter).toHaveBeenCalledTimes(1);
    expect(generateCoverLetter.mock.calls[0]?.[0]).toContain(VACANCY.description);
    expect(workspace.listApplicationArtifacts(db, started.attemptId!).map((artifact) => artifact.kind))
      .toEqual(['cv_pdf', 'cover_letter_pdf']);
    expect(workspace.getApplicationAttempt(db, started.attemptId!).preparedFields?.fields.some(
      (field) => field.label === 'coverLetter' && field.status === 'committed' && field.required,
    )).toBe(true);
  });

  it('keeps the required-letter recovery path when automatic generation fails', async () => {
    createApplicationView.mockReset().mockImplementation(() => fakeView(requiredCoverLetterFormTree()));
    generateCoverLetter.mockResolvedValueOnce({ ok: false, text: '', error: 'provider unavailable' });
    const started = await pipeline.startApplicationAttempt(deps, {
      vacancy: { ...VACANCY, vacancyKey: 'vac-cover-letter-failed', applyUrl: FIXTURE_FORM_URLS.withUpload },
    });
    queueApplicationDocumentRenders();
    const ticked = await pipeline.runNextApplicationAttempt(deps);

    expect(ticked.result?.outcome).toBe('needs_user');
    expect(workspace.getApplicationAttempt(db, started.attemptId!).checkpointDetail).toContain('provider unavailable');
    expect(workspace.listApplicationArtifacts(db, started.attemptId!).map((artifact) => artifact.kind)).toEqual(['cv_pdf']);
    expect(generateFieldMap).not.toHaveBeenCalled();
  });

  it('hands a CAPTCHA to the person and never attempts to answer it', async () => {
    createApplicationView.mockReset().mockImplementation(() =>
      fakeView({
        ...noUploadFormTree(),
        children: [
          ...(noUploadFormTree().children ?? []),
          { nodeName: 'DIV', nodeType: 1, backendNodeId: 90, attributes: ['class', 'g-recaptcha'] },
        ],
      }),
    );
    const started = await pipeline.startApplicationAttempt(deps, { vacancy: { ...VACANCY, vacancyKey: 'vac-captcha' } });
    queueApplicationDocumentRenders();
    const ticked = await pipeline.runNextApplicationAttempt(deps);

    expect(ticked.result?.outcome).toBe('needs_user');
    expect(workspace.getApplicationAttempt(db, started.attemptId!).checkpointDetail).toContain('CAPTCHA');
    expect(generateFieldMap).not.toHaveBeenCalled();
    expect(insertedText()).toEqual([]);
  });

  it('reports a refused field map instead of typing part of it', async () => {
    // A map that names a value the pipeline never offered: Domain B refuses the whole thing, and
    // the attempt says so rather than half-filling the form.
    generateFieldMap.mockImplementationOnce(async (prompt: string) => {
      const attemptId = /"attemptId" must be exactly "([^"]+)"/u.exec(prompt)?.[1] ?? '';
      const snapshotGeneration = Number(/"snapshotGeneration" exactly (\d+)/u.exec(prompt)?.[1] ?? '0');
      const fieldRef = /^- ref: (f[0-9a-f]{16})/mu.exec(prompt)?.[1] ?? 'f0000000000000000';
      return {
        ok: true,
        text: JSON.stringify({
          attemptId,
          snapshotGeneration,
          assignments: [{ fieldRef, source: { kind: 'value', valueRef: 'v00000000deadbeef' } }],
          unmapped: [],
        }),
      };
    });

    const started = await pipeline.startApplicationAttempt(deps, { vacancy: VACANCY });
    queueApplicationDocumentRenders();
    const ticked = await pipeline.runNextApplicationAttempt(deps);

    expect(ticked.result?.outcome).toBe('needs_user');
    expect(workspace.getApplicationAttempt(db, started.attemptId!).checkpointDetail).toContain('unknown_ref');
    expect(insertedText()).toEqual([]);
  });

  it('refuses a document set the acceptance contract rejects rather than reporting it ready', async () => {
    // A blank PDF: real bytes, really rendered, and really refused by the real contract.
    const blank = new jsPDF({ unit: 'pt', format: 'a4' });
    printQueue.push(new Uint8Array(blank.output('arraybuffer')));

    const started = await pipeline.startApplicationAttempt(deps, { vacancy: VACANCY });
    const ticked = await pipeline.runNextApplicationAttempt(deps);

    expect(ticked.result?.outcome).toBe('needs_user');
    expect(workspace.getApplicationAttempt(db, started.attemptId!).checkpointDetail).toContain('could not be produced');
    expect(createApplicationView).not.toHaveBeenCalled();
  });
});

describe('start refusals', () => {
  it('refuses a vacancy with no application URL', async () => {
    const result = await pipeline.startApplicationAttempt(deps, { vacancy: { ...VACANCY, applyUrl: '' } });
    expect(result).toMatchObject({ ok: false, reason: 'no_apply_url' });
    expect(workspace.listApplicationAttempts(db)).toHaveLength(0);
  });

  it('refuses when the CV library is empty', async () => {
    for (const cv of workspace.listCvDocuments(db)) workspace.deleteCvDocument(db, cv.id);
    const result = await pipeline.startApplicationAttempt(deps, { vacancy: VACANCY });
    expect(result).toMatchObject({ ok: false, reason: 'no_cv_available' });
    expect(queue.enqueued).toEqual([]);
  });
});
