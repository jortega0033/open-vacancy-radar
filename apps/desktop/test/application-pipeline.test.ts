// @vitest-environment node
import { createHash } from 'node:crypto';
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { jsPDF } from 'jspdf';
import { sql } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CdpDomNode } from '@agent-dock/application-executor';
import { classifyProviderError } from '../src/provider-error.js';
import * as evidenceService from '../electron/company-evidence-service.js';
import * as evidenceStore from '../electron/workspace/company-evidence-store.js';

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

/**
 * A one-shot brake on the next PDF render, armed by `holdNextPdfRender()` below.
 *
 * `printToPDF` is the real step this pipeline can hang inside for minutes with nothing able to
 * cancel it -- an offscreen `BrowserWindow` loading a URL and printing it -- so it is where a test
 * about a *late* write has to hold a run. The hold is taken before the queued bytes are shifted, so
 * a run parked here does not hold on to the PDF a later run needs: the run that gets there next
 * takes the next queued render, and the held one takes whatever is still queued when it wakes up.
 */
/** #689: the HTML every offscreen window was asked to load, so a test can read the letter that was rendered. */
const { loadedHtml } = vi.hoisted(() => ({ loadedHtml: [] as string[] }));

const { printHold } = vi.hoisted(() => ({
  printHold: { pending: null as Promise<void> | null, entered: null as (() => void) | null },
}));

vi.mock('electron', () => ({
  BrowserWindow: class {
    webContents = {
      printToPDF: async (): Promise<Buffer> => {
        printToPDF();
        const held = printHold.pending;
        if (held) {
          printHold.pending = null;
          printHold.entered?.();
          printHold.entered = null;
          await held;
        }
        return Buffer.from(printQueue.shift() ?? new Uint8Array());
      },
    };
    async loadURL(url?: string): Promise<void> {
      loadedHtml.push(decodeURIComponent(String(url ?? '').replace(/^data:text\/html;charset=utf-8,/u, '')));
    }
    destroy(): void {}
  },
}));

const { createApplicationView } = vi.hoisted(() => ({ createApplicationView: vi.fn() }));
vi.mock('../electron/application-view.js', () => ({ createApplicationView }));

const { createWorkspaceDb } = await import('../electron/workspace/client.js');
const workspace = await import('../electron/workspace/repository.js');
const { FIXTURE_FORM_URLS, setAutoApplyEnabled } = await import('../electron/application-target-policies.js');
const pipeline = await import('../electron/application-pipeline.js');
const { closeAllApplicationReviews } = await import('../electron/application-review-session.js');
const { fetchWorkableJobDetail, workableJobReferenceFromUrl, createPostingVerifier, CrawlerHttpError } = await import(
  '@open-vacancy-radar/vacancy-engine'
);
const verification = await import('../electron/application-posting-verification.js');
const engineModule = await import('@open-vacancy-radar/vacancy-engine');
const store = await import('../electron/workspace/posting-verification-store.js');
import type { AtsHttpClient, AtsHttpRequestOptions, AtsHttpResponse } from '@open-vacancy-radar/vacancy-engine';
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

/**
 * A one-shot brake on the next CDP command of a given method, armed by `holdNextCdpCommand()`.
 *
 * The page half of what `printHold` does for renders: `Page.navigate` is where a real preparation
 * hangs when the target site stops answering, and it is the one place a run has already registered
 * its review but has no snapshot on it yet.
 */
const cdpHold: { method: string | null; pending: Promise<void> | null; entered: (() => void) | null } = {
  method: null,
  pending: null,
  entered: null,
};

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
    if (cdpHold.method === method && cdpHold.pending) {
      const held = cdpHold.pending;
      cdpHold.method = null;
      cdpHold.pending = null;
      cdpHold.entered?.();
      cdpHold.entered = null;
      await held;
    }
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
    { id: 'experience-1', company: 'Redwood Software', title: 'Senior Engineer', dates: '2021 - Present', engagement: 'employment', client: '', bullets: ['Built things.'] },
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

/** What the tailoring session answers on the happy path: the reviewed source CV, unchanged. Shared
 * rather than inlined so a test that makes that session *hang* can release it with exactly what a
 * real one would have returned, and the abandoned run genuinely carries on from where it was stuck
 * instead of failing out of the hang and proving nothing. */
function tailoredResumeResponse(): { ok: boolean; text: string } {
  return {
    ok: true,
    text: JSON.stringify({
      contact: SOURCE_CV.contact,
      summary: SOURCE_CV.summary,
      experience: SOURCE_CV.experience,
      projects: [],
      skills: ['TypeScript'],
      education: [],
    }),
  };
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
  // This whole suite is about the path an attempt takes once its target *is* an approved one, so it
  // has to run with the auto-apply kill switch on -- which is what `main.ts` does for a workspace
  // whose `autoApplyEnabled` setting is true, and is not how this release ships. With the switch in
  // its shipped (off) position every vacancy below would resolve to no policy and settle on the
  // manual review card, which is `application-auto-apply-flag.test.ts`'s subject, not this file's.
  setAutoApplyEnabled(true);
  dir = mkdtempSync(join(tmpdir(), 'ovr-pipeline-test-'));
  ({ db, close: closeDb } = createWorkspaceDb(dir));
  views.length = 0;
  loadedHtml.length = 0;
  printQueue.length = 0;
  printHold.pending = null;
  printHold.entered = null;
  cdpHold.method = null;
  cdpHold.pending = null;
  cdpHold.entered = null;
  printToPDF.mockClear();
  createApplicationView.mockReset().mockImplementation(() => fakeView(noUploadFormTree()));
  generateFieldMap = vi.fn(async (prompt: string) => ({ ok: true, text: deterministicFieldMapper(prompt) }));
  generateTailoredResume = vi.fn(async () => tailoredResumeResponse());
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
  // Back to the refusing default, so nothing this file turns on leaks into a later suite sharing
  // the same module instance.
  setAutoApplyEnabled(false);
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
    // Two distinct vacancies, deliberately at two distinct fixture URLs: since #331's identity fix,
    // the concurrency guard would (correctly) refuse the second `createApplicationAttempt` here as a
    // duplicate of the first if both shared one canonical URL, which is not what this test is about.
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
      canonicalUrl: FIXTURE_FORM_URLS.withUpload,
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

  it('links a letter saved from the hand-off to its attempt and clears the letter blocker (#552)', async () => {
    generateCoverLetter.mockResolvedValueOnce({ ok: true, text: '{"factIds":["experience-99"]}' });
    const started = await pipeline.startApplicationAttempt(deps, {
      vacancy: { ...VACANCY, vacancyKey: 'vac-handoff', applyUrl: 'https://jobs.example.invalid/apply/handoff' },
    });
    queueApplicationDocumentRenders();
    await pipeline.runNextApplicationAttempt(deps);
    const attemptId = started.attemptId!;
    expect(workspace.listApplicationArtifacts(db, attemptId).map((artifact) => artifact.kind)).toEqual(['cv_pdf']);

    // Nothing saved yet for this vacancy.
    await expect(pipeline.attachLetterToAttempt(deps, attemptId)).resolves.toMatchObject({ ok: false });

    workspace.createLetter(db, {
      title: 'Cover Letter',
      company: VACANCY.company,
      role: VACANCY.role,
      type: 'cover_letter',
      vacancyKey: 'vac-handoff',
      body: 'Dear Northwind Freight hiring team,\n\nI am applying for the Logistics Platform Engineer role.\n\nJamie Rivera',
    });
    printQueue.push(coverLetterPdf());

    const attached = await pipeline.attachLetterToAttempt(deps, attemptId);

    expect(attached.ok).toBe(true);
    expect(workspace.listApplicationArtifacts(db, attemptId).map((artifact) => artifact.kind))
      .toEqual(['cv_pdf', 'cover_letter_pdf']);
    const attempt = workspace.getApplicationAttempt(db, attemptId);
    expect(attempt.checkpoint).toBe('needs_user');
    expect(attempt.checkpointDetail).toContain('Your application documents are ready.');
    expect(attempt.checkpointDetail).not.toMatch(/cover letter/iu);

    // A second save does not stage the letter again: the blocker is gone.
    await expect(pipeline.attachLetterToAttempt(deps, attemptId)).resolves.toMatchObject({ ok: false });
    expect(workspace.listApplicationArtifacts(db, attemptId)).toHaveLength(2);
  });

  it('refuses to link a letter to an attempt that is not waiting on one (#552)', async () => {
    const attemptId = await prepareOneApplication();
    workspace.updateApplicationAttempt(db, attemptId, { checkpoint: 'ready', checkpointDetail: '' });
    await expect(pipeline.attachLetterToAttempt(deps, attemptId)).resolves.toMatchObject({ ok: false });
  });

  it('never replaces a different needs-user blocker with a letter (#552)', async () => {
    const attemptId = await prepareOneApplication();
    const detail = 'Automatic CV tailoring stopped: the session failed';
    workspace.updateApplicationAttempt(db, attemptId, { checkpoint: 'needs_user', checkpointDetail: detail });
    await expect(pipeline.attachLetterToAttempt(deps, attemptId)).resolves.toMatchObject({ ok: false });
    expect(workspace.getApplicationAttempt(db, attemptId).checkpointDetail).toBe(detail);
  });

  it('warns at start and never calls the CV ready when the profile has no skills (#521)', async () => {
    const cvId = workspace.listCvDocuments(db)[0]!.id;
    workspace.updateCvDocument(db, cvId, {
      profile: { title: 'Senior Engineer', location: 'Amsterdam', skills: [], summary: 'Synthetic summary.' },
    });
    generateCoverLetter.mockResolvedValueOnce({ ok: true, text: '{"factIds":["experience-99"]}' });

    const started = await pipeline.startApplicationAttempt(deps, {
      vacancy: { ...VACANCY, vacancyKey: 'vac-no-skills', applyUrl: 'https://jobs.example.invalid/apply/no-skills' },
    });
    expect(started.ok).toBe(true);
    expect(started.warning).toBe(pipeline.NO_PROFILE_SKILLS_WARNING);

    queueApplicationDocumentRenders();
    await pipeline.runNextApplicationAttempt(deps);

    const detail = workspace.getApplicationAttempt(db, started.attemptId!).checkpointDetail;
    expect(detail).toContain('Your CV profile has no skills');
    expect(detail).toContain('Your CV was prepared without any skills.');
    expect(detail).not.toContain('Your tailored CV is ready.');
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

  it('keeps a usage-limit reason intact so the review dialog can show the limit notice (#546)', async () => {
    const limitMessage = "You've hit your session limit · resets 10:10pm (Europe/Amsterdam)";
    generateTailoredResume.mockResolvedValueOnce({ ok: false, text: '', error: limitMessage });
    const started = await pipeline.startApplicationAttempt(deps, { vacancy: VACANCY });
    const first = await pipeline.runNextApplicationAttempt(deps);

    expect(first.result?.outcome).toBe('needs_user');
    const detail = workspace.getApplicationAttempt(db, started.attemptId!).checkpointDetail;
    expect(detail.startsWith('Automatic CV tailoring stopped:')).toBe(true);
    expect(detail).toContain(limitMessage);
    expect(classifyProviderError(detail)).toMatchObject({ kind: 'usage_limit', resetLabel: '10:10pm (Europe/Amsterdam)' });
    // Nothing else spent a Claude session after the limit.
    expect(generateCoverLetter).not.toHaveBeenCalled();
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

  it('queues a failed preparation again from the history drawer (#468)', async () => {
    const started = await pipeline.startApplicationAttempt(deps, {
      vacancy: { ...VACANCY, vacancyKey: 'vac-failed-retry', description: null, descriptionComplete: false },
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
    await expect(pipeline.resumeApplicationAttempt(unavailableDeps, started.attemptId!)).rejects.toThrow('queue unavailable');
    expect(workspace.getApplicationAttempt(db, started.attemptId!)).toMatchObject({ checkpoint: 'failed' });

    const retried = await pipeline.resumeApplicationAttempt(deps, started.attemptId!);

    expect(retried.ok).toBe(true);
    expect(workspace.getApplicationAttempt(db, started.attemptId!)).toMatchObject({ checkpoint: 'queued' });
    expect(await queue.port.entryState(started.attemptId!)).toBe('queued');
  });

  it('never requeues a failed attempt that carries a submission timestamp (#468)', async () => {
    const started = await pipeline.startApplicationAttempt(deps, {
      vacancy: { ...VACANCY, vacancyKey: 'vac-failed-submitted', description: null, descriptionComplete: false },
    });
    workspace.updateApplicationAttempt(db, started.attemptId!, {
      checkpoint: 'failed',
      checkpointDetail: 'synthetic failure after a send',
      submittedAt: '2026-08-20T10:00:00.000Z',
    });

    const result = await pipeline.resumeApplicationAttempt(deps, started.attemptId!);

    expect(result.ok).toBe(false);
    expect(workspace.getApplicationAttempt(db, started.attemptId!)).toMatchObject({ checkpoint: 'failed' });
  });

  it('refuses to resume an attempt that was skipped or submitted (#468)', async () => {
    const started = await pipeline.startApplicationAttempt(deps, {
      vacancy: { ...VACANCY, vacancyKey: 'vac-skipped-resume', description: null, descriptionComplete: false },
    });
    workspace.updateApplicationAttempt(db, started.attemptId!, { checkpoint: 'skipped' });
    expect((await pipeline.resumeApplicationAttempt(deps, started.attemptId!)).ok).toBe(false);
    expect(workspace.getApplicationAttempt(db, started.attemptId!)).toMatchObject({ checkpoint: 'skipped' });
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

  it('proceeds instead of refusing when fetchMissingJobDescription recovers one on demand', async () => {
    // Real-world regression: Himalayas and Jobgether scan results routinely carry no description at
    // all, even though the source itself has one -- see the vacancy-engine on-demand fetch this
    // hook exists to call. This only asserts the pipeline's own side of that contract: it must
    // actually use what the hook returns rather than refusing anyway.
    deps.fetchMissingJobDescription = vi.fn(async (canonicalUrl: string) => {
      expect(canonicalUrl).toBe(VACANCY.applyUrl);
      return { description: 'Fetched on demand: build great frontend software.', complete: true };
    });
    const started = await pipeline.startApplicationAttempt(deps, {
      vacancy: { ...VACANCY, vacancyKey: 'vac-fetch-jd', description: null, descriptionComplete: false },
    });
    queueApplicationDocumentRenders();

    const ticked = await pipeline.runNextApplicationAttempt(deps);

    expect(deps.fetchMissingJobDescription).toHaveBeenCalledTimes(1);
    expect(ticked.result?.outcome).toBe('ready');
    const attempt = workspace.getApplicationAttempt(db, started.attemptId!);
    expect(attempt.jdSnapshot).toBe('Fetched on demand: build great frontend software.');
    expect(attempt.jdSnapshotHash).toBe(
      createHash('sha256').update('Fetched on demand: build great frontend software.').digest('hex'),
    );
  });

  it('still refuses when fetchMissingJobDescription itself finds nothing, rather than looping or crashing', async () => {
    deps.fetchMissingJobDescription = vi.fn(async () => null);
    const started = await pipeline.startApplicationAttempt(deps, {
      vacancy: { ...VACANCY, vacancyKey: 'vac-fetch-jd-fails', description: null, descriptionComplete: false },
    });

    const ticked = await pipeline.runNextApplicationAttempt(deps);

    expect(deps.fetchMissingJobDescription).toHaveBeenCalledTimes(1);
    expect(ticked.result?.outcome).toBe('needs_user');
    expect(workspace.getApplicationAttempt(db, started.attemptId!).checkpointDetail).toContain('no job description');
    expect(printToPDF).not.toHaveBeenCalled();
  });

  it('still refuses, without throwing, when fetchMissingJobDescription itself rejects', async () => {
    deps.fetchMissingJobDescription = vi.fn(async () => {
      throw new Error('network unreachable');
    });
    const started = await pipeline.startApplicationAttempt(deps, {
      vacancy: { ...VACANCY, vacancyKey: 'vac-fetch-jd-throws', description: null, descriptionComplete: false },
    });

    const ticked = await pipeline.runNextApplicationAttempt(deps);

    expect(ticked.result?.outcome).toBe('needs_user');
    expect(workspace.getApplicationAttempt(db, started.attemptId!).checkpointDetail).toContain('no job description');
  });

  it('still refuses as incomplete when fetchMissingJobDescription itself reports the description is not complete', async () => {
    deps.fetchMissingJobDescription = vi.fn(async () => ({ description: 'A partial teaser only.', complete: false }));
    const started = await pipeline.startApplicationAttempt(deps, {
      vacancy: { ...VACANCY, vacancyKey: 'vac-fetch-jd-incomplete', description: null, descriptionComplete: false },
    });

    const ticked = await pipeline.runNextApplicationAttempt(deps);

    expect(ticked.result?.outcome).toBe('needs_user');
    const attempt = workspace.getApplicationAttempt(db, started.attemptId!);
    // Persisted (so a later retry doesn't refetch it) but still correctly refused as incomplete.
    expect(attempt.jdSnapshot).toBe('A partial teaser only.');
    expect(attempt.checkpointDetail).toContain('incomplete');
  });

  // --------------------------------------------------- the real workable_global on-demand fetch
  //
  // The tests above stand the hook itself in for; these three run the *real* vacancy-engine fetch
  // `main.ts` wires into it, over fixture HTTP responses shaped like the ones Workable's live
  // endpoints actually returned when this was built. `workable_global` is the highest-volume
  // discovery source in the app and its feed carries no description at all, so what matters is not
  // only that a recovered description is used, but that a failed recovery still lands on the same
  // honest refusal rather than anything invented.

  const WORKABLE_SHORT_URL = 'https://apply.workable.com/j/F587C0434B';
  const WORKABLE_CANONICAL_URL = 'https://apply.workable.com/heartstrings/j/F587C0434B';
  const WORKABLE_DETAIL_URL = 'https://apply.workable.com/api/v2/accounts/heartstrings/jobs/F587C0434B';

  /** The same two-step resolve-then-fetch `main.ts` performs, over canned responses instead of the
   * network: the short feed URL 301s to a canonical one naming the account, and only then is the
   * per-job detail endpoint reachable. */
  function workableJdFetcher(detail: { status: number; body: string }) {
    const http = {
      async get(url: string) {
        if (url === WORKABLE_SHORT_URL) {
          return { status: 200, finalUrl: WORKABLE_CANONICAL_URL, headers: {}, body: '<!doctype html>' };
        }
        if (url === WORKABLE_DETAIL_URL) {
          return { status: detail.status, finalUrl: url, headers: {}, body: detail.body };
        }
        throw new Error(`unexpected request: ${url}`);
      },
      async postJson() {
        throw new Error('the on-demand description fetch never POSTs');
      },
    };
    return vi.fn(async (canonicalUrl: string) => {
      const reference = workableJobReferenceFromUrl(canonicalUrl);
      if (reference === null) return null;
      const fetched = await fetchWorkableJobDetail(http, reference);
      return fetched.description === null ? null : { description: fetched.description, complete: true };
    });
  }

  it('recovers a workable_global description from the real per-job endpoint and tailors from it', async () => {
    deps.fetchMissingJobDescription = workableJdFetcher({
      status: 200,
      body: JSON.stringify({
        shortcode: 'F587C0434B',
        title: 'Logistics Platform Engineer',
        description: '<h3>About us</h3><p>Northwind Freight runs a routing platform.</p>',
        requirements: '<h3>Requirements</h3><ul><li>Five years of TypeScript</li></ul>',
        benefits: '<h3>Benefits</h3><ul><li>Paid time off</li></ul>',
      }),
    });
    const started = await pipeline.startApplicationAttempt(deps, {
      vacancy: { ...VACANCY, vacancyKey: 'vac-workable-jd', applyUrl: WORKABLE_SHORT_URL, description: null, descriptionComplete: false },
    });
    queueApplicationDocumentRenders();

    const ticked = await pipeline.runNextApplicationAttempt(deps);

    expect(deps.fetchMissingJobDescription).toHaveBeenCalledWith(WORKABLE_SHORT_URL);
    const attempt = workspace.getApplicationAttempt(db, started.attemptId!);
    // Requirements are joined in, not dropped: on a real Workable posting that is where the role's
    // must-haves live, and tailoring against the blurb alone would miss them.
    expect(attempt.jdSnapshot).toContain('Northwind Freight runs a routing platform.');
    expect(attempt.jdSnapshot).toContain('Five years of TypeScript');
    expect(attempt.jdSnapshotHash).toBe(createHash('sha256').update(attempt.jdSnapshot).digest('hex'));
    // It got all the way past the JD guard to the handoff every unsupported destination gets --
    // apply.workable.com is a real employer site, so it never inherits the fixture's trust.
    expect(ticked.result?.outcome).toBe('needs_user');
    expect(attempt.checkpointDetail).toContain('apply on the site yourself');
    expect(attempt.checkpointDetail).not.toContain('no job description');
  });

  it('falls back to the honest refusal when the listing is gone and the endpoint 404s', async () => {
    deps.fetchMissingJobDescription = workableJdFetcher({ status: 404, body: 'Job not found' });
    const started = await pipeline.startApplicationAttempt(deps, {
      vacancy: { ...VACANCY, vacancyKey: 'vac-workable-404', applyUrl: WORKABLE_SHORT_URL, description: null, descriptionComplete: false },
    });

    const ticked = await pipeline.runNextApplicationAttempt(deps);

    expect(ticked.result?.outcome).toBe('needs_user');
    const attempt = workspace.getApplicationAttempt(db, started.attemptId!);
    expect(attempt.checkpointDetail).toContain('no job description');
    expect(attempt.jdSnapshot.trim()).toBe('');
    expect(printToPDF).not.toHaveBeenCalled();
  });

  it('falls back to the honest refusal when the endpoint answers with something unparseable', async () => {
    // The fetch throws here rather than returning null -- a changed response shape must never be
    // read as "this listing has no description", and the pipeline must survive the throw either way.
    deps.fetchMissingJobDescription = workableJdFetcher({ status: 200, body: '<!doctype html><html>nope</html>' });
    const started = await pipeline.startApplicationAttempt(deps, {
      vacancy: { ...VACANCY, vacancyKey: 'vac-workable-malformed', applyUrl: WORKABLE_SHORT_URL, description: null, descriptionComplete: false },
    });

    const ticked = await pipeline.runNextApplicationAttempt(deps);

    expect(ticked.result?.outcome).toBe('needs_user');
    const attempt = workspace.getApplicationAttempt(db, started.attemptId!);
    expect(attempt.checkpointDetail).toContain('no job description');
    expect(attempt.jdSnapshot.trim()).toBe('');
    expect(printToPDF).not.toHaveBeenCalled();
  });

  it('discards a description fetched on demand if the attempt moved on while the fetch was in flight, rather than clobbering it', async () => {
    // Simulates the exact race the guard in `recordFetchedJobDescription` exists for: something else
    // (a cancel, a reset) changes this attempt's checkpoint away from 'reading_jd' between the fetch
    // starting and resolving. The fetch itself still "succeeds" from the caller's point of view, but
    // its result must never be written back onto a row that has since moved on.
    let attemptId = '';
    deps.fetchMissingJobDescription = vi.fn(async () => {
      workspace.updateApplicationAttempt(db, attemptId, { checkpoint: 'queued', checkpointDetail: 'raced' });
      return { description: 'Fetched too late to matter.', complete: true };
    });
    const started = await pipeline.startApplicationAttempt(deps, {
      vacancy: { ...VACANCY, vacancyKey: 'vac-fetch-jd-raced', description: null, descriptionComplete: false },
    });
    attemptId = started.attemptId!;

    const ticked = await pipeline.runNextApplicationAttempt(deps);

    expect(deps.fetchMissingJobDescription).toHaveBeenCalledTimes(1);
    expect(ticked.result?.outcome).toBe('needs_user');
    const attempt = workspace.getApplicationAttempt(db, attemptId);
    expect(attempt.checkpointDetail).toContain('no job description');
    // The fetched text was discarded, not silently persisted onto a row that moved on mid-fetch.
    expect(attempt.jdSnapshot.trim()).toBe('');
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

// ------------------------------------------------------- a preparation that stops making progress

/**
 * Makes the tailoring session hang until the test releases it, and then answer normally.
 *
 * The generation session is the honest place to simulate this: it is one of the two steps in a real
 * preparation with no timeout of its own (the other is the CDP page work), and it is what was
 * actually stuck in the incident this fence exists for. It is also mid-run -- after two checkpoint
 * writes, before any document is staged -- so a run held here has plenty left to write with when it
 * finally wakes up, which is exactly what has to be proven harmless.
 */
function holdTailoringSession(): { release: () => void } {
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  generateTailoredResume.mockImplementationOnce(async () => {
    await held;
    return tailoredResumeResponse();
  });
  return { release };
}

/**
 * Makes the *next* PDF render hang until the test releases it.
 *
 * Deliberately a later step than `holdTailoringSession`: a run parked in the tailoring session stops
 * at the explicit `isLivePreparation` checkpoint on its way out and never reaches a write at all,
 * which proves the checkpoint and nothing else. A run parked inside `printToPDF` is already *inside*
 * `stageApplicationDocuments` -- the fence for its staging write was checked and passed before the
 * render began -- so when it wakes up it is holding finished, contract-passing PDF bytes and is one
 * statement away from deleting the replacement run's artifact row, removing its file from disk, and
 * registering its own in their place. That is the write this suite has to prove cannot land.
 */
function holdNextPdfRender(): { entered: Promise<void>; release: () => void } {
  let release!: () => void;
  let markEntered!: () => void;
  const entered = new Promise<void>((resolve) => {
    markEntered = resolve;
  });
  printHold.pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  printHold.entered = markEntered;
  return { entered, release };
}

/** The same brake, one step further on: parks a run inside a single CDP command. */
function holdNextCdpCommand(method: string): { entered: Promise<void>; release: () => void } {
  let release!: () => void;
  let markEntered!: () => void;
  const entered = new Promise<void>((resolve) => {
    markEntered = resolve;
  });
  cdpHold.method = method;
  cdpHold.pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  cdpHold.entered = markEntered;
  return { entered, release };
}

/**
 * Resolves once a fenced-out run has actually stopped, so no test has to guess how many turns of the
 * event loop that takes or sleep for a made-up number of milliseconds. `runApplicationAttempt` logs
 * exactly once on that path, which is the only signal an abandoned run gives anyone -- by design,
 * since nothing is waiting on its result any more.
 */
function watchForAbandonedRun(): { log: (message: string) => void; stopped: Promise<void> } {
  let stop!: () => void;
  const stopped = new Promise<void>((resolve) => {
    stop = resolve;
  });
  return {
    log: (message: string) => {
      if (message.includes('its remaining writes were discarded')) stop();
    },
    stopped,
  };
}

/**
 * Waits for a released run to stop -- but never forever. A fenced-out run stops on its next
 * statement, so in the passing case this returns immediately. A run that was *not* fenced would
 * instead carry on writing, and these tests have to fail on what it wrote rather than by timing out
 * on a signal a broken fence would never send.
 */
async function abandonedRunSettled(stopped: Promise<void>): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([
    stopped,
    new Promise<void>((resolve) => {
      timer = setTimeout(resolve, 500);
    }),
  ]);
  if (timer) clearTimeout(timer);
}

/**
 * The lease-fencing half of the hard-timeout work: a preparation that stops making progress must
 * give the daemon's one global lease back (or the queue stays stopped until the app is restarted),
 * and the abandoned run must then be incapable of writing over the run that replaces it.
 *
 * Every other test in this file runs with no ceiling configured at all, which is the golden path's
 * own regression check: nothing here changes what a normal run does.
 */
describe('acceptance 6: an abandoned preparation frees the lease and cannot write afterwards', () => {
  it('gives the lease back at the ceiling and discards every write the abandoned run still tries', async () => {
    const { log, stopped } = watchForAbandonedRun();
    const started = await pipeline.startApplicationAttempt(deps, { vacancy: VACANCY });
    const attemptId = started.attemptId!;
    const stuck = holdTailoringSession();
    // Real PDFs are waiting for it: if the fence did not hold, this run would stage them
    // successfully rather than failing for some unrelated reason.
    queueApplicationDocumentRenders();

    const ticked = await pipeline.runNextApplicationAttempt({ ...deps, abandonPreparationAfterMs: 20, log });

    expect(ticked.abandoned).toBe(true);
    expect(ticked.result).toBeNull();

    // The lease is back, the entry is schedulable again, and the next tick really can take it --
    // which is the whole point of noticing the hang.
    expect(queue.lease).toBeNull();
    expect(queue.entries.get(attemptId)).toBe('queued');
    const reacquired = await queue.port.acquireLease();
    expect(reacquired).toMatchObject({ attemptId });
    await queue.port.release(reacquired!.leaseId, 'requeue');

    // Now let the abandoned run carry on from where it was stuck. It writes nothing.
    const frozen = workspace.getApplicationAttempt(db, attemptId);
    stuck.release();
    await abandonedRunSettled(stopped);

    expect(workspace.getApplicationAttempt(db, attemptId)).toEqual(frozen);
    expect(workspace.listApplicationArtifacts(db, attemptId)).toEqual([]);
    expect(printToPDF).not.toHaveBeenCalled();
    expect(createApplicationView).not.toHaveBeenCalled();
  });

  it('leaves a slow but healthy preparation alone: one generation, ordinary writes', async () => {
    const started = await pipeline.startApplicationAttempt(deps, { vacancy: VACANCY });
    const slow = holdTailoringSession();
    queueApplicationDocumentRenders();

    // Slow, not stuck: the session takes its time and then answers, well inside the ceiling. Getting
    // this wrong in the other direction -- discarding a run that was only being slow -- would throw
    // away a real application's documents, so it is asserted as explicitly as the hang is.
    setTimeout(slow.release, 30);
    const ticked = await pipeline.runNextApplicationAttempt({ ...deps, abandonPreparationAfterMs: 30_000 });

    expect(ticked.abandoned).toBeUndefined();
    expect(ticked.result?.outcome).toBe('ready');
    const attempt = workspace.getApplicationAttempt(db, started.attemptId!);
    expect(attempt.checkpoint).toBe('ready');
    expect(attempt.preparedFields?.fields.find((field) => field.label === 'fullName')?.value).toBe('Jamie Rivera');
    expect(workspace.listApplicationArtifacts(db, attempt.id).map((artifact) => artifact.kind))
      .toEqual(['cv_pdf', 'cover_letter_pdf']);
    expect(queue.entries.get(attempt.id)).toBe('done');
  });

  it('ends two lease cycles for one attempt in the fresh run\'s state, never a mix of both', async () => {
    const { log, stopped } = watchForAbandonedRun();
    const started = await pipeline.startApplicationAttempt(deps, { vacancy: VACANCY });
    const attemptId = started.attemptId!;

    // Cycle 1 hangs and is abandoned at the ceiling.
    const stuck = holdTailoringSession();
    queueApplicationDocumentRenders();
    const first = await pipeline.runNextApplicationAttempt({ ...deps, abandonPreparationAfterMs: 20, log });
    expect(first.abandoned).toBe(true);

    // Cycle 2 takes the freed lease and genuinely finishes, while cycle 1 is still out there
    // holding a resume it is about to want to write.
    queueApplicationDocumentRenders();
    const second = await pipeline.runNextApplicationAttempt({ ...deps, abandonPreparationAfterMs: 30_000 });
    expect(second.result?.outcome).toBe('ready');
    const afterFreshRun = workspace.getApplicationAttempt(db, attemptId);
    const freshArtifacts = workspace.listApplicationArtifacts(db, attemptId);

    stuck.release();
    await abandonedRunSettled(stopped);

    // Both runs really did generate a CV, and exactly one of them left a trace.
    expect(generateTailoredResume).toHaveBeenCalledTimes(2);
    expect(workspace.getApplicationAttempt(db, attemptId)).toEqual(afterFreshRun);
    expect(workspace.listApplicationArtifacts(db, attemptId)).toEqual(freshArtifacts);
    expect(views).toHaveLength(1);
  });

  it('never lets a PDF render that was already in flight overwrite the replacement run\'s documents', async () => {
    // The three tests above all park their run in the tailoring session, which is *before* the
    // explicit checkpoint on the way into staging -- so a fenced-out run there stops at a hand-placed
    // gate and never starts a durable write at all. This one parks it a step later, inside the CV's
    // own `printToPDF`, which is the case the leading-edge fence could not see: the fence for that
    // staging write was checked and passed before the render began, and every side effect it ends in
    // (writing the PDF, dropping the superseded row and its file, inserting the new row) happens
    // after it. Nothing about that write is benign -- it replaces the artifact row and the file the
    // *live* attempt's pre-submit gate reads, while the form still holds the other run's CV.
    //
    // What stops it here is `writeAndRegisterArtifact`'s trailing check, which by the time this run
    // wakes up has long since moved. The narrower case, where the fence moves *during* that
    // function's own writes, is `application-artifact-staging-fence.test.ts`'s.
    const { log, stopped } = watchForAbandonedRun();
    const started = await pipeline.startApplicationAttempt(deps, { vacancy: VACANCY });
    const attemptId = started.attemptId!;

    // Cycle 1 reaches staging and hangs inside the render of its tailored CV.
    const stuck = holdNextPdfRender();
    queueApplicationDocumentRenders();
    const first = await pipeline.runNextApplicationAttempt({ ...deps, abandonPreparationAfterMs: 50, log });
    expect(first.abandoned).toBe(true);
    // Not an assumption: the abandoned run really is inside the render, past its own fence check,
    // and therefore really will try to write when it wakes up.
    await stuck.entered;
    expect(printToPDF).toHaveBeenCalledTimes(1);
    expect(workspace.listApplicationArtifacts(db, attemptId)).toEqual([]);

    // Cycle 2 takes the freed lease and prepares the attempt properly, start to finish.
    queueApplicationDocumentRenders();
    const second = await pipeline.runNextApplicationAttempt({ ...deps, abandonPreparationAfterMs: 30_000 });
    expect(second.result?.outcome).toBe('ready');

    const afterFreshRun = workspace.getApplicationAttempt(db, attemptId);
    const freshArtifacts = workspace.listApplicationArtifacts(db, attemptId);
    expect(freshArtifacts.map((artifact) => artifact.kind)).toEqual(['cv_pdf', 'cover_letter_pdf']);
    const freshFiles = readdirSync(join(deps.storageRoot, attemptId)).sort();

    // Now the abandoned render finally returns. Its bytes are real and pass the real acceptance
    // contract, so nothing but the fence stands between them and the database.
    stuck.release();
    await abandonedRunSettled(stopped);

    expect(printToPDF).toHaveBeenCalledTimes(3); // cycle 1's CV, cycle 2's CV and letter
    // The fresh run's rows are the rows, byte for byte: no id was replaced, no hash moved.
    expect(workspace.listApplicationArtifacts(db, attemptId)).toEqual(freshArtifacts);
    expect(workspace.getApplicationAttempt(db, attemptId)).toEqual(afterFreshRun);
    // And its files are still on disk: the abandoned run never reached the point of dropping the
    // superseded CV, so the document the pre-submit gate reads is still the one the form was filled
    // from.
    expect(readdirSync(join(deps.storageRoot, attemptId)).sort()).toEqual(freshFiles);
    expect(views).toHaveLength(1);
  });

  it('closes the abandoned run\'s review, so a run that hung on the page does not lock out every replacement', async () => {
    // Giving the lease back is only half of letting go. `openApplicationReview` registers an
    // attempt *before* it awaits the navigation, so a run abandoned while still opening the page
    // leaves behind a registration with no snapshot on it -- and the abandoned run must not tear
    // that down itself, because by the time it notices, the view could already belong to the run
    // that replaced it. Left alone, the next run reopens, finds the snapshot-less registration and
    // throws, and the attempt durably lands on `needs_user` about a review that is nobody's.
    const { log, stopped } = watchForAbandonedRun();
    const started = await pipeline.startApplicationAttempt(deps, { vacancy: VACANCY });
    const attemptId = started.attemptId!;

    const stuckNavigation = holdNextCdpCommand('Page.navigate');
    queueApplicationDocumentRenders();

    // The 1s ceiling only has to fire once the run is genuinely parked on `Page.navigate`, not
    // whenever wall-clock time happens to reach 1s: the real tailoring, PDF rendering and SQLite
    // writes ahead of it can occasionally take longer than that on a loaded machine, and a real
    // timer racing against them would make this test flake without the pipeline being wrong. Fake
    // timers let this wait for `stuckNavigation.entered` -- an actual signal that the run reached
    // the hold -- before the ceiling's clock is ever allowed to move.
    vi.useFakeTimers();
    let first: Awaited<ReturnType<typeof pipeline.runNextApplicationAttempt>>;
    try {
      const pending = pipeline.runNextApplicationAttempt({ ...deps, abandonPreparationAfterMs: 1_000, log });
      await stuckNavigation.entered;
      // The run really did get as far as opening a page, which is what makes this the right case.
      expect(createApplicationView).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1_000);
      first = await pending;
    } finally {
      vi.useRealTimers();
    }

    expect(first.abandoned).toBe(true);
    expect(views[0]!.destroy).toHaveBeenCalledTimes(1);

    // The replacement run builds its own view and finishes normally.
    queueApplicationDocumentRenders();
    const second = await pipeline.runNextApplicationAttempt({ ...deps, abandonPreparationAfterMs: 30_000 });

    expect(second.result?.outcome).toBe('ready');
    expect(createApplicationView).toHaveBeenCalledTimes(2);
    const attempt = workspace.getApplicationAttempt(db, attemptId);
    expect(attempt.checkpoint).toBe('ready');
    expect(attempt.checkpointDetail).not.toContain('no snapshot yet');

    // And the run that was stuck on the navigation still writes nothing when it wakes up.
    stuckNavigation.release();
    await abandonedRunSettled(stopped);
    expect(workspace.getApplicationAttempt(db, attemptId)).toEqual(attempt);
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

// =================================================================================================
// #687: verify the live posting before preparing or resuming an application.
//
// What is real: `startApplicationAttempt` / `runNextApplicationAttempt` / `resumeApplicationAttempt` /
// `verifyPreparedApplicationAttempt` / `refreshApplicationFromPosting` themselves, the real SQLite
// workspace (migration 0034 included), the real store guards, and the real vacancy-engine verifier
// (probe recognition, authoritative-payload parsing, closure/inability classification, comparison,
// deadline parsing). What is stood in for: only the network, by an `AtsHttpClient` fixture that
// answers synthetic Greenhouse / Lever / Workable / Jobgether shapes (and throws the same
// `CrawlerHttpError` shapes the real SafeHttpClient throws). No live job site is contacted.
// =================================================================================================

type PostingStep = AtsHttpResponse | Error | (() => Promise<AtsHttpResponse | Error>);

/** Scripted per-URL responses; each URL plays its steps in order and then repeats the last one. */
class PostingHttp implements AtsHttpClient {
  readonly calls: Array<{ url: string; headers: Headers }> = [];
  readonly #routes = new Map<string, PostingStep[]>();

  route(url: string, ...steps: PostingStep[]): this {
    this.#routes.set(url, steps);
    return this;
  }

  async get(url: string, options?: AtsHttpRequestOptions): Promise<AtsHttpResponse> {
    this.calls.push({ url, headers: new Headers(options?.headers) });
    const steps = this.#routes.get(url);
    if (!steps || steps.length === 0) throw new Error(`unexpected request in test: ${url}`);
    const step = steps.length > 1 ? steps.shift()! : steps[0]!;
    const resolved = typeof step === 'function' ? await step() : step;
    if (resolved instanceof Error) throw resolved;
    return resolved;
  }

  async postJson(): Promise<AtsHttpResponse> {
    throw new Error('posting verification never POSTs');
  }
}

const GH_URL = 'https://boards.greenhouse.io/northwind/jobs/4012345';
const GH_API = 'https://boards-api.greenhouse.io/v1/boards/northwind/jobs/4012345';
const WORKABLE_URL_687 = 'https://apply.workable.com/northwind/j/F587C0434B/';
const WORKABLE_API_687 = 'https://apply.workable.com/api/v2/accounts/northwind/jobs/F587C0434B';

const SNAPSHOT_687 = [
  'Northwind Freight is hiring a Logistics Platform Engineer to work on our routing platform.',
  'Five years of TypeScript experience is required.',
  'Hybrid in Utrecht.',
  'Apply by 15 November 2026.',
].join('\n');

/** The same posting as the authority serves it: markup and entity-escaping instead of plain lines. */
const LIVE_SAME_687 =
  '&lt;p&gt;Northwind Freight is hiring a Logistics Platform Engineer to work on our routing platform.&lt;/p&gt;' +
  '&lt;ul&gt;&lt;li&gt;Five years of TypeScript experience is required.&lt;/li&gt;&lt;/ul&gt;' +
  '&lt;p&gt;Hybrid in Utrecht.&lt;/p&gt;&lt;p&gt;Apply by 15 November 2026.&lt;/p&gt;';
const LIVE_CHANGED_687 =
  '&lt;p&gt;Northwind Freight is hiring a Logistics Platform Engineer to work on our routing platform.&lt;/p&gt;' +
  '&lt;ul&gt;&lt;li&gt;Eight years of TypeScript experience is required.&lt;/li&gt;&lt;li&gt;Fluent Dutch is required.&lt;/li&gt;&lt;/ul&gt;' +
  '&lt;p&gt;Onsite in Eindhoven.&lt;/p&gt;&lt;p&gt;Apply by 15 November 2026.&lt;/p&gt;';

function greenhouseOk(content: string, headers: Record<string, string> = {}): AtsHttpResponse {
  return { status: 200, finalUrl: GH_API, headers, body: JSON.stringify({ id: 4012345, title: 'Engineer', content }) };
}

function httpError(category: 'timeout' | 'blocked' | 'rate_limited' | 'http_error' | 'network_error', status?: number): Error {
  const code =
    category === 'timeout'
      ? 'request_timeout'
      : category === 'blocked'
        ? 'blocked_status'
        : category === 'rate_limited'
          ? 'rate_limited_status'
          : category === 'http_error'
            ? 'http_status'
            : 'request_failed';
  return new CrawlerHttpError({ category, code, url: GH_API, detail: `synthetic ${category}`, ...(status === undefined ? {} : { status }) });
}

describe('#687 posting verification before preparation and on resumption', () => {
  const T0 = new Date('2026-09-11T12:00:00.000Z');
  let clock: Date;
  let http: PostingHttp;

  beforeEach(() => {
    clock = new Date(T0);
    http = new PostingHttp();
  });

  function verifyingDeps(client: PostingHttp = http): ApplicationPipelineDeps {
    return {
      ...deps,
      now: () => clock,
      verifyPosting: createPostingVerifier(client, { now: () => clock }).verify,
    };
  }

  const posting = (overrides: Partial<PipelineVacancy> = {}): PipelineVacancy => ({
    ...VACANCY,
    vacancyKey: 'vac-posting',
    applyUrl: GH_URL,
    description: SNAPSHOT_687,
    descriptionComplete: true,
    ...overrides,
  });

  async function startAndRun(vacancy: PipelineVacancy = posting(), runDeps: ApplicationPipelineDeps = verifyingDeps()) {
    const started = await pipeline.startApplicationAttempt(runDeps, { vacancy });
    queueApplicationDocumentRenders();
    const ticked = await pipeline.runNextApplicationAttempt(runDeps);
    return { attemptId: started.attemptId!, ticked };
  }

  const MANUAL_HANDOFF = 'apply on the site yourself';
  const latest = (attemptId: string) => store.getLatestPostingVerification(db, attemptId);

  describe('what a stored snapshot meets at preparation', () => {
    it('open and unchanged: one authoritative request, snapshot kept, preparation proceeds with all work', async () => {
      http.route(GH_API, greenhouseOk(LIVE_SAME_687, { etag: '"v1"' }));

      const { attemptId, ticked } = await startAndRun();

      expect(http.calls.map((call) => call.url)).toEqual([GH_API]);
      expect(generateTailoredResume).toHaveBeenCalledTimes(1);
      expect(ticked.result?.outcome).toBe('needs_user');
      expect(workspace.getApplicationAttempt(db, attemptId).checkpointDetail).toContain(MANUAL_HANDOFF);
      const attempt = workspace.getApplicationAttempt(db, attemptId);
      expect(attempt.jdSnapshot).toBe(SNAPSHOT_687);
      const row = latest(attemptId)!;
      expect(row).toMatchObject({
        result: 'confirmed_open',
        outcome: 'open',
        reason: 'verified_open',
        source: 'greenhouse',
        sourceRef: 'boards-api.greenhouse.io/v1/boards/{board}/jobs/{id}',
        observedAt: T0.toISOString(),
        contentVersion: 1,
        etag: '"v1"',
        deadline: '2026-11-15',
      });
      expect(row.deadlineProvenance?.excerpt).toContain('Apply by 15 November 2026');
      expect(row.baselineHash).toBe(row.contentHash);
      // Nothing about the displayed state asks the person for anything.
      const view = verification.readPostingVerification({ db, now: () => clock }, attemptId);
      expect(view).toMatchObject({ status: 'confirmed_open', checkedAt: T0.toISOString(), reused: false, stale: false });
      expect(view.actions).toEqual(['check_again']);
    });

    it('explicit closure: no AI work is spent, the warning explains why, and a person can prepare anyway', async () => {
      http.route(GH_API, httpError('http_error', 404));

      const { attemptId, ticked } = await startAndRun();

      expect(ticked.result?.outcome).toBe('needs_user');
      expect(generateTailoredResume).not.toHaveBeenCalled();
      expect(generateCoverLetter).not.toHaveBeenCalled();
      expect(printToPDF).not.toHaveBeenCalled();
      expect(workspace.listApplicationArtifacts(db, attemptId)).toEqual([]);
      const attempt = workspace.getApplicationAttempt(db, attemptId);
      expect(attempt.checkpointDetail).toBe(verification.POSTING_CLOSED_DETAIL);
      expect(latest(attemptId)).toMatchObject({ result: 'confirmed_closed', reason: 'not_found', httpStatus: 404 });
      const view = verification.readPostingVerification({ db, now: () => clock }, attemptId);
      expect(view.status).toBe('confirmed_closed');
      expect(view.actions).toEqual(['open_posting', 'prepare_anyway', 'check_again']);

      // The person decides: prepare anyway (a false closure is recoverable). No second request.
      const resumed = await pipeline.resumeApplicationAttempt(verifyingDeps(), attemptId, { resolution: 'prepare_anyway' });
      expect(resumed.ok).toBe(true);
      queueApplicationDocumentRenders();
      await pipeline.runNextApplicationAttempt(verifyingDeps());
      expect(http.calls).toHaveLength(1);
      expect(generateTailoredResume).toHaveBeenCalledTimes(1);
      expect(workspace.getApplicationAttempt(db, attemptId).checkpointDetail).toContain(MANUAL_HANDOFF);
      expect(latest(attemptId)).toMatchObject({ result: 'confirmed_closed', resolution: 'prepare_anyway' });
    });

    it('changed requirements are shown BEFORE regeneration; nothing is overwritten until the person refreshes', async () => {
      http.route(GH_API, greenhouseOk(LIVE_CHANGED_687));

      const { attemptId, ticked } = await startAndRun();

      expect(ticked.result?.outcome).toBe('needs_user');
      expect(generateTailoredResume).not.toHaveBeenCalled();
      expect(printToPDF).not.toHaveBeenCalled();
      const attempt = workspace.getApplicationAttempt(db, attemptId);
      expect(attempt.checkpointDetail).toBe(verification.POSTING_CHANGED_DETAIL);
      // The stored snapshot, and so everything derived from it, is untouched.
      expect(attempt.jdSnapshot).toBe(SNAPSHOT_687);
      expect(attempt.jdSnapshotHash).toBe(createHash('sha256').update(SNAPSHOT_687).digest('hex'));
      const view = verification.readPostingVerification({ db, now: () => clock }, attemptId);
      expect(view.status).toBe('materially_changed');
      expect(view.change?.removed).toContain('Five years of TypeScript experience is required.');
      expect(view.change?.added).toEqual(
        expect.arrayContaining(['Eight years of TypeScript experience is required.', 'Fluent Dutch is required.']),
      );
      expect(view.actions).toEqual(['refresh', 'keep_current', 'open_posting', 'check_again']);
      expect(view.changeKind).toBe('requirements');
      expect(latest(attemptId)).toMatchObject({ result: 'materially_changed', contentVersion: 2 });

      // Refresh goes through the existing restart flow: new text adopted, old package deleted, queued again.
      const refreshed = await pipeline.refreshApplicationFromPosting(verifyingDeps(), attemptId);
      expect(refreshed.ok).toBe(true);
      const requeued = workspace.getApplicationAttempt(db, attemptId);
      expect(requeued.checkpoint).toBe('queued');
      expect(requeued.jdSnapshot).toContain('Eight years of TypeScript experience is required.');
      expect(requeued.jdComplete).toBe(true);
      expect(requeued.jdSnapshotHash).toBe(createHash('sha256').update(requeued.jdSnapshot).digest('hex'));
      expect(queue.enqueued.filter((id) => id === attemptId)).toHaveLength(2);

      queueApplicationDocumentRenders();
      await pipeline.runNextApplicationAttempt(verifyingDeps());
      // The re-run reuses the finding it just acted on: still ONE request in total.
      expect(http.calls).toHaveLength(1);
      expect(generateTailoredResume).toHaveBeenCalledTimes(1);
      expect(verification.readPostingVerification({ db, now: () => clock }, attemptId)).toMatchObject({
        status: 'confirmed_open',
        resolution: 'refreshed',
      });
    });

    it('keep current: the person may continue with what they have; the finding stays on record', async () => {
      http.route(GH_API, greenhouseOk(LIVE_CHANGED_687));
      const { attemptId } = await startAndRun();

      const resumed = await pipeline.resumeApplicationAttempt(verifyingDeps(), attemptId, { resolution: 'keep_current' });
      expect(resumed.ok).toBe(true);
      queueApplicationDocumentRenders();
      await pipeline.runNextApplicationAttempt(verifyingDeps());

      expect(generateTailoredResume).toHaveBeenCalledTimes(1);
      expect(workspace.getApplicationAttempt(db, attemptId).jdSnapshot).toBe(SNAPSHOT_687);
      expect(latest(attemptId)).toMatchObject({ result: 'materially_changed', resolution: 'keep_current' });
      // A stale decision about a finding that is no longer current decides nothing.
      expect(store.resolvePostingVerification(db, attemptId, 'prepare_anyway')).toBeNull();
    });

    it.each([
      ['a timeout', httpError('timeout'), 'timeout'],
      ['a 403', httpError('blocked', 403), 'denied'],
      ['a 401', httpError('blocked', 401), 'denied'],
      ['a rate limit', httpError('rate_limited', 429), 'rate_limited'],
      ['a server error', httpError('http_error', 503), 'server_error'],
      ['a network failure', httpError('network_error'), 'network_error'],
    ] as Array<[string, Error, string]>)('%s is unable to verify, never closure: preparation proceeds on the stored snapshot', async (_label, error, reason) => {
      http.route(GH_API, error);

      const { attemptId, ticked } = await startAndRun();

      expect(ticked.result?.outcome).toBe('needs_user');
      expect(workspace.getApplicationAttempt(db, attemptId).checkpointDetail).toContain(MANUAL_HANDOFF);
      expect(generateTailoredResume).toHaveBeenCalledTimes(1);
      // One bounded request: no retry ladder, no second route around the denial.
      expect(http.calls).toHaveLength(1);
      expect(latest(attemptId)).toMatchObject({ result: 'unable_to_verify', outcome: 'unable', reason, contentHash: null });
      const view = verification.readPostingVerification({ db, now: () => clock }, attemptId);
      expect(view.status).toBe('unable_to_verify');
      expect(view.status).not.toBe('confirmed_closed');
      expect(view.actions).toEqual(['open_posting', 'check_again']);
    });

    it('a login wall is unable to verify, not closed', async () => {
      http.route(GH_API, { status: 200, finalUrl: 'https://boards-api.greenhouse.io/users/sign_in', headers: {}, body: '<html>Sign in</html>' });
      const { attemptId } = await startAndRun();
      expect(latest(attemptId)).toMatchObject({ result: 'unable_to_verify', reason: 'login_wall' });
      expect(generateTailoredResume).toHaveBeenCalledTimes(1);
    });

    it('a source with no authoritative route costs no request and says so', async () => {
      const { attemptId, ticked } = await startAndRun(posting({ applyUrl: 'https://careers.example.org/jobs/42' }));
      expect(http.calls).toHaveLength(0);
      expect(ticked.result?.outcome).toBe('needs_user');
      expect(latest(attemptId)).toMatchObject({ result: 'unable_to_verify', reason: 'no_authoritative_source', source: 'none' });
      const view = verification.readPostingVerification({ db, now: () => clock }, attemptId);
      expect(view.source).toBeNull();
    });

    it('unknown deadline stays unknown: shown as "none stated", never derived from when it was first seen', async () => {
      const noDeadline = SNAPSHOT_687.replace('\nApply by 15 November 2026.', '');
      http.route(GH_API, greenhouseOk(LIVE_SAME_687.replace('&lt;p&gt;Apply by 15 November 2026.&lt;/p&gt;', '')));

      const { attemptId } = await startAndRun(posting({ description: noDeadline }));

      const row = latest(attemptId)!;
      expect(row.result).toBe('confirmed_open');
      expect(row.deadline).toBeNull();
      expect(row.deadlineProvenance).toBeNull();
      const view = verification.readPostingVerification({ db, now: () => clock }, attemptId);
      expect(view).toMatchObject({ deadline: null, noDeadlineStated: true });
    });

    it('fills a missing description from the verification request itself instead of a second fetch', async () => {
      http.route(GH_API, greenhouseOk(LIVE_SAME_687));
      const fetchMissing = vi.fn(async () => ({ description: 'must not be used', complete: true }));

      const runDeps = { ...verifyingDeps(), fetchMissingJobDescription: fetchMissing };
      const { attemptId } = await startAndRun(posting({ description: null, descriptionComplete: false }), runDeps);

      expect(fetchMissing).not.toHaveBeenCalled();
      expect(http.calls).toHaveLength(1);
      const attempt = workspace.getApplicationAttempt(db, attemptId);
      expect(attempt.jdSnapshot).toContain('Five years of TypeScript experience is required.');
      expect(attempt.jdComplete).toBe(true);
      expect(latest(attemptId)).toMatchObject({ result: 'confirmed_open' });
      expect(generateTailoredResume).toHaveBeenCalledTimes(1);
      // The filled text is now the snapshot, and the finding is recorded against it: still a fresh,
      // open check (not "not checked"), so the next prepare or resume costs no second request.
      expect(verification.readPostingVerification({ db, now: () => clock }, attemptId)).toMatchObject({
        status: 'confirmed_open',
        stale: false,
      });
      clock = new Date(T0.getTime() + 60 * 60 * 1000);
      await pipeline.verifyPreparedApplicationAttempt(verifyingDeps(), attemptId);
      expect(http.calls).toHaveLength(1);
    });

    it('an incomplete stored description is compared like any other, never silently replaced', async () => {
      http.route(GH_API, greenhouseOk(LIVE_SAME_687));
      const truncated = SNAPSHOT_687.split('\n').slice(0, 2).join('\n');
      const { attemptId } = await startAndRun(posting({ description: truncated, descriptionComplete: false }));
      const attempt = workspace.getApplicationAttempt(db, attemptId);
      expect(attempt.jdSnapshot).toBe(truncated);
      expect(attempt.jdComplete).toBe(false);
      expect(latest(attemptId)).toMatchObject({ result: 'materially_changed' });
      expect(attempt.checkpointDetail).toBe(verification.POSTING_CHANGED_DETAIL);
      expect(generateTailoredResume).not.toHaveBeenCalled();
    });

    it('with no verifier configured nothing about preparation changes', async () => {
      const { attemptId, ticked } = await startAndRun(posting(), deps);
      expect(ticked.result?.outcome).toBe('needs_user');
      expect(generateTailoredResume).toHaveBeenCalledTimes(1);
      expect(latest(attemptId)).toBeNull();
    });
  });

  describe('freshness window, cached observation time and validators', () => {
    it('reuses a young finding with its ORIGINAL observation time and makes no request', async () => {
      http.route(GH_API, greenhouseOk(LIVE_SAME_687));
      const { attemptId } = await startAndRun();
      expect(http.calls).toHaveLength(1);

      clock = new Date(T0.getTime() + 60 * 60 * 1000); // one hour later
      const view = await pipeline.verifyPreparedApplicationAttempt(verifyingDeps(), attemptId);

      expect(http.calls).toHaveLength(1);
      expect(view).toMatchObject({ status: 'confirmed_open', reused: true, stale: false, checkedAt: T0.toISOString() });
      expect(latest(attemptId)?.observedAt).toBe(T0.toISOString());
    });

    it('past the window it asks again, and a changed posting takes a prepared package out of review without deleting it', async () => {
      http.route(GH_API, greenhouseOk(LIVE_SAME_687), greenhouseOk(LIVE_CHANGED_687));
      const { attemptId } = await startAndRun();
      const artifactsBefore = workspace.listApplicationArtifacts(db, attemptId);
      expect(artifactsBefore.length).toBeGreaterThan(0);
      // Stand-in for an attempt a person left prepared: ready, with committed answers.
      workspace.updateApplicationAttempt(db, attemptId, { checkpoint: 'ready', checkpointDetail: '' });
      workspace.recordPreparedApplicationFields(db, attemptId, {
        generation: 1,
        fields: [],
      } as unknown as Parameters<typeof workspace.recordPreparedApplicationFields>[2]);

      clock = new Date(T0.getTime() + 25 * 60 * 60 * 1000);
      const view = await pipeline.verifyPreparedApplicationAttempt(verifyingDeps(), attemptId);

      expect(http.calls).toHaveLength(2);
      expect(view).toMatchObject({ status: 'materially_changed', invalidated: true, reused: false, checkedAt: clock.toISOString() });
      const attempt = workspace.getApplicationAttempt(db, attemptId);
      expect(attempt.checkpoint).toBe('needs_user');
      expect(attempt.checkpointDetail).toBe(verification.POSTING_CHANGED_DETAIL);
      expect(attempt.preparedFields).toBeNull();
      // The stale package is kept as evidence until the person explicitly refreshes.
      expect(workspace.listApplicationArtifacts(db, attemptId).map((a) => a.id)).toEqual(artifactsBefore.map((a) => a.id));
      expect(attempt.jdSnapshot).toBe(SNAPSHOT_687);
    });

    it('unchanged valid work is reused: a later unchanged check leaves the package, the attempt and the queue alone', async () => {
      http.route(GH_API, greenhouseOk(LIVE_SAME_687, { etag: '"v1"' }), greenhouseOk(LIVE_SAME_687, { etag: '"v1"' }));
      const { attemptId } = await startAndRun();
      const before = workspace.getApplicationAttempt(db, attemptId);
      const artifactsBefore = workspace.listApplicationArtifacts(db, attemptId);
      const enqueuedBefore = queue.enqueued.length;

      clock = new Date(T0.getTime() + 30 * 60 * 60 * 1000);
      const view = await pipeline.verifyPreparedApplicationAttempt(verifyingDeps(), attemptId);

      expect(http.calls).toHaveLength(2);
      expect(view).toMatchObject({ status: 'confirmed_open', invalidated: false, checkedAt: clock.toISOString() });
      const after = workspace.getApplicationAttempt(db, attemptId);
      expect({ ...after, updatedAt: '' }).toEqual({ ...before, updatedAt: '' });
      expect(workspace.listApplicationArtifacts(db, attemptId)).toEqual(artifactsBefore);
      expect(queue.enqueued.length).toBe(enqueuedBefore);
      expect(generateTailoredResume).toHaveBeenCalledTimes(1);
      // Same state: one row refreshed in place, not a growing log.
      expect(store.listPostingVerifications(db, attemptId)).toHaveLength(1);
    });

    it('sends the stored validators for a no-store source and treats 304 as unchanged since the stored read', async () => {
      http.route(
        WORKABLE_API_687,
        {
          status: 200,
          finalUrl: WORKABLE_API_687,
          headers: { etag: '"w1"', 'last-modified': 'Fri, 11 Sep 2026 10:00:00 GMT' },
          body: JSON.stringify({ description: `<p>${SNAPSHOT_687.replace(/\n/gu, '</p><p>')}</p>` }),
        },
        { status: 304, finalUrl: WORKABLE_API_687, headers: {}, body: '' },
      );
      const { attemptId } = await startAndRun(posting({ applyUrl: WORKABLE_URL_687 }));
      expect(latest(attemptId)).toMatchObject({ etag: '"w1"', lastModified: 'Fri, 11 Sep 2026 10:00:00 GMT', result: 'confirmed_open' });

      clock = new Date(T0.getTime() + 26 * 60 * 60 * 1000);
      const view = await pipeline.verifyPreparedApplicationAttempt(verifyingDeps(), attemptId);

      expect(http.calls).toHaveLength(2);
      expect(http.calls[1]!.headers.get('if-none-match')).toBe('"w1"');
      expect(http.calls[1]!.headers.get('if-modified-since')).toBe('Fri, 11 Sep 2026 10:00:00 GMT');
      expect(view).toMatchObject({ status: 'confirmed_open', checkedAt: clock.toISOString() });
      // The origin's 304 is recorded as such (a distinct state), and the content hash carries over.
      expect(latest(attemptId)).toMatchObject({ reason: 'not_modified', contentHash: expect.any(String) });
      expect(store.listPostingVerifications(db, attemptId)).toHaveLength(2);
    });

    it('does not trust inability as fresh proof: a timeout is retried after the short window, not the day', async () => {
      http.route(GH_API, httpError('timeout'), greenhouseOk(LIVE_SAME_687));
      const { attemptId } = await startAndRun();
      expect(latest(attemptId)?.result).toBe('unable_to_verify');

      clock = new Date(T0.getTime() + 5 * 60 * 1000);
      const tooSoon = await pipeline.verifyPreparedApplicationAttempt(verifyingDeps(), attemptId);
      expect(http.calls).toHaveLength(1);
      expect(tooSoon).toMatchObject({ status: 'unable_to_verify', reused: true });

      clock = new Date(T0.getTime() + 20 * 60 * 1000);
      const later = await pipeline.verifyPreparedApplicationAttempt(verifyingDeps(), attemptId);
      expect(http.calls).toHaveLength(2);
      expect(later).toMatchObject({ status: 'confirmed_open', reused: false });
    });

    it('"Check again" forces a request even inside the window', async () => {
      http.route(GH_API, greenhouseOk(LIVE_SAME_687));
      const { attemptId } = await startAndRun();
      await pipeline.verifyPreparedApplicationAttempt(verifyingDeps(), attemptId, { force: true });
      expect(http.calls).toHaveLength(2);
    });

    it('a resumed failed attempt rechecks only when its finding is stale', async () => {
      http.route(GH_API, greenhouseOk(LIVE_SAME_687));
      const { attemptId } = await startAndRun();
      workspace.updateApplicationAttempt(db, attemptId, { checkpoint: 'failed', checkpointDetail: 'synthetic failure' });

      clock = new Date(T0.getTime() + 2 * 60 * 60 * 1000);
      await pipeline.resumeApplicationAttempt(verifyingDeps(), attemptId);
      queueApplicationDocumentRenders();
      await pipeline.runNextApplicationAttempt(verifyingDeps());
      expect(http.calls).toHaveLength(1); // young finding reused

      workspace.updateApplicationAttempt(db, attemptId, { checkpoint: 'failed', checkpointDetail: 'synthetic failure' });
      clock = new Date(T0.getTime() + 49 * 60 * 60 * 1000);
      await pipeline.resumeApplicationAttempt(verifyingDeps(), attemptId);
      queueApplicationDocumentRenders();
      await pipeline.runNextApplicationAttempt(verifyingDeps());
      expect(http.calls).toHaveLength(2); // stale finding checked once
    });
  });

  // -----------------------------------------------------------------------------------------------
  // #687 fix round 1 (review-687-1 P1-P5): a prepared package is held, never deleted, by a finding;
  // Keep / Get ready anyway put it back unchanged; other blockers are never overwritten; a failing
  // port and an overlapping check cannot stall or rob a preparation run.
  // -----------------------------------------------------------------------------------------------
  describe('held packages, decisions and overlapping callers (fix round 1)', () => {
    const PREPARED_FIELDS = {
      generation: 1,
      fields: [{ key: 'why_us', label: 'Why us?', value: 'Because routing matters.' }],
    } as unknown as Parameters<typeof workspace.recordPreparedApplicationFields>[2];

    /** A prepared package a person left in review: `ready`, with committed answers and staged files. */
    async function preparedPackage(...steps: PostingStep[]) {
      http.route(GH_API, greenhouseOk(LIVE_SAME_687), ...steps);
      const { attemptId } = await startAndRun();
      workspace.updateApplicationAttempt(db, attemptId, { checkpoint: 'ready', checkpointDetail: 'Ready for your review.' });
      workspace.recordPreparedApplicationFields(db, attemptId, PREPARED_FIELDS);
      const before = workspace.getApplicationAttempt(db, attemptId);
      const artifacts = workspace.listApplicationArtifacts(db, attemptId);
      expect(artifacts.length).toBeGreaterThan(0);
      clock = new Date(T0.getTime() + 25 * 60 * 60 * 1000);
      return { attemptId, before, artifacts };
    }

    it('the pipeline hand-off sentence is the one the hold recognises as a prepared package', async () => {
      http.route(GH_API, greenhouseOk(LIVE_SAME_687));
      const { attemptId } = await startAndRun();
      const attempt = workspace.getApplicationAttempt(db, attemptId);
      expect(attempt.checkpointDetail).toContain(verification.PREPARED_HANDOFF_PHRASE);
      expect(verification.isPreparedPackage(attempt)).toBe(true);
      expect(verification.isPreparedPackage({ checkpoint: 'needs_user', checkpointDetail: 'Question 7 needs your own answer.' })).toBe(false);
    });

    it('P1: Keep my application puts a held READY package back exactly as it was, with no AI work', async () => {
      const { attemptId, before, artifacts } = await preparedPackage(greenhouseOk(LIVE_CHANGED_687));
      const generations = generateTailoredResume.mock.calls.length;
      const enqueued = queue.enqueued.length;

      const view = await pipeline.verifyPreparedApplicationAttempt(verifyingDeps(), attemptId);
      expect(view).toMatchObject({ status: 'materially_changed', invalidated: true, held: true, changeKind: 'requirements' });
      expect(view.actions).toEqual(['refresh', 'keep_current', 'open_posting', 'check_again']);
      const held = workspace.getApplicationAttempt(db, attemptId);
      expect(held).toMatchObject({ checkpoint: 'needs_user', checkpointDetail: verification.POSTING_CHANGED_DETAIL, preparedFields: null });
      // Out of review, but nothing is deleted.
      expect(workspace.listApplicationArtifacts(db, attemptId)).toEqual(artifacts);

      const kept = await pipeline.resumeApplicationAttempt(verifyingDeps(), attemptId, { resolution: 'keep_current' });
      expect(kept).toMatchObject({ ok: true, continued: 'restored' });
      const after = workspace.getApplicationAttempt(db, attemptId);
      expect(after.checkpoint).toBe('ready');
      expect(after.checkpointDetail).toBe(before.checkpointDetail);
      expect(after.preparedFields).toEqual(before.preparedFields);
      expect(after.jdSnapshot).toBe(before.jdSnapshot);
      expect(workspace.listApplicationArtifacts(db, attemptId)).toEqual(artifacts);
      expect(queue.enqueued.length).toBe(enqueued);
      await pipeline.runNextApplicationAttempt(verifyingDeps());
      expect(generateTailoredResume.mock.calls.length).toBe(generations);
      expect(latest(attemptId)).toMatchObject({ result: 'materially_changed', resolution: 'keep_current', held: false, hasObservedText: false });
      // The decision is final for that text: the same change found again does not ask again.
      clock = new Date(clock.getTime() + 26 * 60 * 60 * 1000);
      const again = await pipeline.verifyPreparedApplicationAttempt(verifyingDeps(), attemptId);
      expect(again).toMatchObject({ status: 'materially_changed', resolution: 'keep_current', invalidated: false });
      expect(workspace.getApplicationAttempt(db, attemptId).checkpoint).toBe('ready');
    });

    it('P2: a closed posting holds a prepared package too; Get ready anyway restores it unchanged', async () => {
      const { attemptId, before, artifacts } = await preparedPackage(httpError('http_error', 404));
      const view = await pipeline.verifyPreparedApplicationAttempt(verifyingDeps(), attemptId);
      expect(view).toMatchObject({ status: 'confirmed_closed', invalidated: true, held: true });
      expect(view.actions).toEqual(['open_posting', 'prepare_anyway', 'check_again']);
      expect(workspace.getApplicationAttempt(db, attemptId)).toMatchObject({
        checkpoint: 'needs_user',
        checkpointDetail: verification.POSTING_CLOSED_DETAIL,
      });

      const anyway = await pipeline.resumeApplicationAttempt(verifyingDeps(), attemptId, { resolution: 'prepare_anyway' });
      expect(anyway).toMatchObject({ ok: true, continued: 'restored' });
      const after = workspace.getApplicationAttempt(db, attemptId);
      expect({ checkpoint: after.checkpoint, detail: after.checkpointDetail, fields: after.preparedFields }).toEqual({
        checkpoint: 'ready',
        detail: before.checkpointDetail,
        fields: before.preparedFields,
      });
      expect(workspace.listApplicationArtifacts(db, attemptId)).toEqual(artifacts);
      expect(verification.readPostingVerification({ db, now: () => clock }, attemptId)).toMatchObject({
        status: 'confirmed_closed',
        resolution: 'prepare_anyway',
        held: false,
      });
    });

    it('the manual hand-off (documents ready, apply yourself) is held and restored the same way', async () => {
      http.route(GH_API, greenhouseOk(LIVE_SAME_687), greenhouseOk(LIVE_CHANGED_687));
      const { attemptId } = await startAndRun();
      const before = workspace.getApplicationAttempt(db, attemptId);
      expect(before.checkpointDetail).toContain(MANUAL_HANDOFF);
      clock = new Date(T0.getTime() + 25 * 60 * 60 * 1000);
      expect((await pipeline.verifyPreparedApplicationAttempt(verifyingDeps(), attemptId)).held).toBe(true);
      expect(workspace.getApplicationAttempt(db, attemptId).checkpointDetail).toBe(verification.POSTING_CHANGED_DETAIL);
      await pipeline.resumeApplicationAttempt(verifyingDeps(), attemptId, { resolution: 'keep_current' });
      expect(workspace.getApplicationAttempt(db, attemptId)).toMatchObject({
        checkpoint: before.checkpoint,
        checkpointDetail: before.checkpointDetail,
      });
    });

    it.each([
      ['a changed posting', () => greenhouseOk(LIVE_CHANGED_687), 'materially_changed', 'keep_current'],
      ['a closed posting', () => httpError('http_error', 404), 'confirmed_closed', 'prepare_anyway'],
    ] as const)('P3: %s never overwrites another blocker, its detail or its prepared answers', async (_label, next, status, decision) => {
      http.route(GH_API, greenhouseOk(LIVE_SAME_687), next());
      const { attemptId } = await startAndRun();
      const blocker = 'Question 7 needs your own answer: Why us?';
      workspace.updateApplicationAttempt(db, attemptId, { checkpoint: 'needs_user', checkpointDetail: blocker });
      workspace.recordPreparedApplicationFields(db, attemptId, PREPARED_FIELDS);
      const before = workspace.getApplicationAttempt(db, attemptId);
      clock = new Date(T0.getTime() + 25 * 60 * 60 * 1000);

      const view = await pipeline.verifyPreparedApplicationAttempt(verifyingDeps(), attemptId);
      expect(view).toMatchObject({ status, invalidated: false, held: false });
      const after = workspace.getApplicationAttempt(db, attemptId);
      expect(after.checkpointDetail).toBe(blocker);
      expect(after.preparedFields).toEqual(before.preparedFields);
      expect(after.checkpoint).toBe('needs_user');

      // Deciding about the posting records the decision; the person's own blocker still stands.
      const enqueued = queue.enqueued.length;
      const decided = await pipeline.resumeApplicationAttempt(verifyingDeps(), attemptId, { resolution: decision });
      expect(decided).toMatchObject({ ok: true, continued: 'recorded' });
      expect(workspace.getApplicationAttempt(db, attemptId).checkpointDetail).toBe(blocker);
      expect(queue.enqueued.length).toBe(enqueued);
    });

    it('a failed preparation keeps its failure detail when a check finds the posting changed', async () => {
      http.route(GH_API, greenhouseOk(LIVE_SAME_687), greenhouseOk(LIVE_CHANGED_687));
      const { attemptId } = await startAndRun();
      workspace.updateApplicationAttempt(db, attemptId, { checkpoint: 'failed', checkpointDetail: 'synthetic failure' });
      clock = new Date(T0.getTime() + 25 * 60 * 60 * 1000);
      await pipeline.verifyPreparedApplicationAttempt(verifyingDeps(), attemptId);
      expect(workspace.getApplicationAttempt(db, attemptId)).toMatchObject({ checkpoint: 'failed', checkpointDetail: 'synthetic failure' });
    });

    it('Check again that finds the posting open and unchanged puts a held package back by itself', async () => {
      const { attemptId, before, artifacts } = await preparedPackage(greenhouseOk(LIVE_CHANGED_687), greenhouseOk(LIVE_SAME_687));
      await pipeline.verifyPreparedApplicationAttempt(verifyingDeps(), attemptId);
      expect(workspace.getApplicationAttempt(db, attemptId).checkpoint).toBe('needs_user');

      const view = await pipeline.verifyPreparedApplicationAttempt(verifyingDeps(), attemptId, { force: true });
      expect(view).toMatchObject({ status: 'confirmed_open', released: true, held: false });
      const after = workspace.getApplicationAttempt(db, attemptId);
      expect({ checkpoint: after.checkpoint, detail: after.checkpointDetail, fields: after.preparedFields }).toEqual({
        checkpoint: 'ready',
        detail: before.checkpointDetail,
        fields: before.preparedFields,
      });
      expect(workspace.listApplicationArtifacts(db, attemptId)).toEqual(artifacts);
      // The superseded finding no longer keeps the changed text.
      expect(store.listPostingVerifications(db, attemptId).every((row) => !row.hasObservedText)).toBe(true);
    });

    it('a later check that cannot reach the posting does not hide the open finding or release the hold', async () => {
      const { attemptId, before } = await preparedPackage(greenhouseOk(LIVE_CHANGED_687), httpError('timeout'));
      await pipeline.verifyPreparedApplicationAttempt(verifyingDeps(), attemptId);
      const view = await pipeline.verifyPreparedApplicationAttempt(verifyingDeps(), attemptId, { force: true });
      expect(view).toMatchObject({ status: 'materially_changed', held: true, recheck: { reason: 'timeout' } });
      expect(view.actions).toContain('keep_current');
      expect(workspace.getApplicationAttempt(db, attemptId).checkpoint).toBe('needs_user');
      const kept = await pipeline.resumeApplicationAttempt(verifyingDeps(), attemptId, { resolution: 'keep_current' });
      expect(kept.continued).toBe('restored');
      expect(workspace.getApplicationAttempt(db, attemptId).preparedFields).toEqual(before.preparedFields);
    });

    it('only the explicit Refresh replaces a held package, and the adopted text leaves the finding row', async () => {
      const { attemptId } = await preparedPackage(greenhouseOk(LIVE_CHANGED_687));
      await pipeline.verifyPreparedApplicationAttempt(verifyingDeps(), attemptId);
      const generations = generateTailoredResume.mock.calls.length;
      const refreshed = await pipeline.refreshApplicationFromPosting(verifyingDeps(), attemptId);
      expect(refreshed).toMatchObject({ ok: true, continued: 'queued' });
      expect(workspace.getApplicationAttempt(db, attemptId).jdSnapshot).toContain('Eight years of TypeScript experience is required.');
      queueApplicationDocumentRenders();
      await pipeline.runNextApplicationAttempt(verifyingDeps());
      expect(generateTailoredResume.mock.calls.length).toBe(generations + 1);
      const row = store.listPostingVerifications(db, attemptId).find((entry) => entry.resolution === 'refreshed');
      expect(row).toMatchObject({ hasObservedText: false, held: false, contentVersion: 2 });
      expect(row?.contentHash).toEqual(expect.any(String));
    });

    it('a plain resume of a held package prepares again and never restores the old package later', async () => {
      const { attemptId } = await preparedPackage(greenhouseOk(LIVE_CHANGED_687));
      await pipeline.verifyPreparedApplicationAttempt(verifyingDeps(), attemptId);
      await pipeline.resumeApplicationAttempt(verifyingDeps(), attemptId);
      expect(store.listPostingVerifications(db, attemptId).some((row) => row.held)).toBe(false);
    });

    it('P5: a verifier port that rejects is "could not check" and preparation continues on the stored text', async () => {
      const failing: ApplicationPipelineDeps = {
        ...deps,
        now: () => clock,
        verifyPosting: async () => {
          throw new Error('engine database unavailable');
        },
      };
      const { attemptId, ticked } = await startAndRun(posting(), failing);
      expect(ticked.result?.outcome).toBe('needs_user');
      const attempt = workspace.getApplicationAttempt(db, attemptId);
      expect(attempt.checkpoint).toBe('needs_user');
      expect(attempt.checkpointDetail).toContain(MANUAL_HANDOFF);
      expect(generateTailoredResume).toHaveBeenCalledTimes(1);
      expect(latest(attemptId)).toMatchObject({ result: 'unable_to_verify', reason: 'check_failed' });
      expect(verification.readPostingVerification({ db, now: () => clock }, attemptId).status).toBe('unable_to_verify');
    });

    it('P4: a renderer check in flight, then Resume: one request, the run proceeds in the same tick and records it', async () => {
      const held = (() => {
        let open!: (step: AtsHttpResponse) => void;
        let markEntered!: () => void;
        const entered = new Promise<void>((resolve) => {
          markEntered = resolve;
        });
        const pending = new Promise<AtsHttpResponse>((resolve) => {
          open = resolve;
        });
        return { open, entered, step: async () => (markEntered(), pending) };
      })();
      http.route(GH_API, greenhouseOk(LIVE_SAME_687), held.step);
      const { attemptId } = await startAndRun();
      workspace.updateApplicationAttempt(db, attemptId, { checkpoint: 'needs_user', checkpointDetail: 'synthetic blocker' });
      clock = new Date(T0.getTime() + 25 * 60 * 60 * 1000);
      const generations = generateTailoredResume.mock.calls.length;

      const manual = pipeline.verifyPreparedApplicationAttempt(verifyingDeps(), attemptId, { force: true });
      await held.entered;
      const resumed = await pipeline.resumeApplicationAttempt(verifyingDeps(), attemptId);
      expect(resumed.ok).toBe(true);
      queueApplicationDocumentRenders();
      const ticking = pipeline.runNextApplicationAttempt(verifyingDeps());
      await new Promise((resolve) => setTimeout(resolve, 10));
      held.open(greenhouseOk(LIVE_SAME_687));
      const [ticked] = await Promise.all([ticking, manual]);

      expect(http.calls).toHaveLength(2); // the original preparation + ONE shared live check
      expect(ticked.result?.outcome).toBe('needs_user');
      expect(workspace.getApplicationAttempt(db, attemptId).checkpointDetail).toContain(MANUAL_HANDOFF);
      expect(generateTailoredResume.mock.calls.length).toBe(generations + 1);
      expect(latest(attemptId)).toMatchObject({ result: 'confirmed_open', observedAt: clock.toISOString() });
      expect(workspace.listApplicationAttempts(db)).toHaveLength(1);
    });

    it('a forced check that joins a request in flight gets that live answer, never a stored reuse', async () => {
      const gateParts = (() => {
        let open!: (step: AtsHttpResponse) => void;
        let markEntered!: () => void;
        const entered = new Promise<void>((resolve) => {
          markEntered = resolve;
        });
        const pending = new Promise<AtsHttpResponse>((resolve) => {
          open = resolve;
        });
        return { open, entered, step: async () => (markEntered(), pending) };
      })();
      http.route(GH_API, greenhouseOk(LIVE_SAME_687), gateParts.step);
      const { attemptId } = await startAndRun();
      clock = new Date(T0.getTime() + 25 * 60 * 60 * 1000);
      const first = verification.verifyAttemptPosting(verifyingDeps(), attemptId, { trigger: 'manual' });
      await gateParts.entered;
      const forced = verification.verifyAttemptPosting(verifyingDeps(), attemptId, { trigger: 'manual', force: true });
      gateParts.open(greenhouseOk(LIVE_SAME_687));
      const [a, b] = await Promise.all([first, forced]);
      expect(a).toMatchObject({ kind: 'verified', requested: true, joined: false });
      expect(b).toMatchObject({ kind: 'verified', requested: true, joined: true });
      expect(http.calls).toHaveLength(2);
      expect(store.listPostingVerifications(db, attemptId)).toHaveLength(1);
    });

    it('a stale result for a caller that lost its claim is fenced: nothing is written for it', async () => {
      const gateParts = (() => {
        let open!: (step: AtsHttpResponse) => void;
        let markEntered!: () => void;
        const entered = new Promise<void>((resolve) => {
          markEntered = resolve;
        });
        const pending = new Promise<AtsHttpResponse>((resolve) => {
          open = resolve;
        });
        return { open, entered, step: async () => (markEntered(), pending) };
      })();
      http.route(GH_API, greenhouseOk(LIVE_SAME_687), gateParts.step);
      const { attemptId } = await startAndRun();
      const rows = store.listPostingVerifications(db, attemptId);
      clock = new Date(T0.getTime() + 25 * 60 * 60 * 1000);
      let live = true;
      const fenced = verification.verifyAttemptPosting(verifyingDeps(), attemptId, { trigger: 'manual', isLive: () => live });
      await gateParts.entered;
      live = false;
      gateParts.open(greenhouseOk(LIVE_CHANGED_687));
      expect((await fenced).kind).toBe('dropped');
      expect(store.listPostingVerifications(db, attemptId)).toEqual(rows);
      expect(workspace.getApplicationAttempt(db, attemptId).checkpointDetail).toContain(MANUAL_HANDOFF);
    });
  });

  describe('materiality and closure on the real pipeline (fix round 1)', () => {
    const LONG_SNAPSHOT = [
      'About us',
      'Northwind Freight builds routing software for logistics teams across Europe.',
      'We are a friendly team of forty people.',
      'Requirements',
      'Five years of TypeScript experience is required.',
      'Fluent English.',
      'Experience with PostgreSQL.',
      'Responsibilities',
      'Design and run the routing platform.',
      'Review code with your colleagues.',
      'Benefits',
      'Pension plan.',
      'Free lunch on Fridays.',
      'Apply by 15 November 2026.',
    ].join('\n');
    const asLive = (text: string) =>
      text
        .split('\n')
        .map((line) => `&lt;p&gt;${line}&lt;/p&gt;`)
        .join('');

    it.each([
      ['a company blurb that now says "lead"', LONG_SNAPSHOT.replace('Northwind Freight builds routing', 'Northwind Freight leads the market in routing')],
      ['"founded 12 years ago" in the blurb', LONG_SNAPSHOT.replace('We are a friendly team of forty people.', 'Founded 12 years ago, we are a friendly team of forty people.')],
      ['a rooftop office perk', LONG_SNAPSHOT.replace('Free lunch on Fridays.', 'Free lunch on Fridays.\nOur new office has a rooftop terrace.')],
    ])('%s is not a requirement change: preparation proceeds with all work', async (_label, live) => {
      http.route(GH_API, greenhouseOk(asLive(live)));
      const { attemptId, ticked } = await startAndRun(posting({ description: LONG_SNAPSHOT }));
      expect(ticked.result?.outcome).toBe('needs_user');
      expect(workspace.getApplicationAttempt(db, attemptId).checkpointDetail).toContain(MANUAL_HANDOFF);
      expect(latest(attemptId)?.result).toBe('confirmed_open');
      expect(generateTailoredResume).toHaveBeenCalledTimes(1);
    });

    it.each([
      ['visa sponsorship withdrawn', LONG_SNAPSHOT.replace('Fluent English.', 'Fluent English.\nWe cannot offer visa sponsorship.')],
      ['a new required skill', LONG_SNAPSHOT.replace('Experience with PostgreSQL.', 'Experience with PostgreSQL.\nKubernetes in production.')],
      ['onsite instead of remote-friendly', LONG_SNAPSHOT.replace('Review code with your colleagues.', 'Review code with your colleagues.\nThis role is onsite in Eindhoven.')],
    ])('%s stops before regeneration as a requirement change', async (_label, live) => {
      http.route(GH_API, greenhouseOk(asLive(live)));
      const { attemptId } = await startAndRun(posting({ description: LONG_SNAPSHOT }));
      expect(workspace.getApplicationAttempt(db, attemptId).checkpointDetail).toBe(verification.POSTING_CHANGED_DETAIL);
      expect(verification.readPostingVerification({ db, now: () => clock }, attemptId).changeKind).toBe('requirements');
      expect(generateTailoredResume).not.toHaveBeenCalled();
    });

    it('an open posting whose first line says it is "closed to applicants without EU work authorisation" is open', async () => {
      const text = `The job is closed to applicants without EU work authorisation. Apply if eligible.\n${LONG_SNAPSHOT}`;
      http.route(GH_API, greenhouseOk(asLive(text)));
      const { attemptId } = await startAndRun(posting({ description: text }));
      expect(latest(attemptId)?.result).toBe('confirmed_open');
      expect(generateTailoredResume).toHaveBeenCalledTimes(1);
    });

    it('a check on a source with no authoritative route offers no useless "Check again"', async () => {
      const { attemptId } = await startAndRun(posting({ applyUrl: 'https://careers.example.org/jobs/42' }));
      const view = verification.readPostingVerification({ db, now: () => clock }, attemptId);
      expect(view.status).toBe('unable_to_verify');
      expect(view.actions).toEqual(['open_posting']);
    });
  });

  describe('retention and lookup (fix round 1)', () => {
    it('the table is indexed by attempt and observation time', () => {
      const indexes = db.all<{ name: string }>(
        sql`SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'application_posting_verifications'`,
      );
      expect(indexes.map((index) => index.name)).toContain('application_posting_verifications_attempt_observed_idx');
    });

    it('flapping "could not check" reasons stay bounded and decisions are never pruned', async () => {
      http.route(GH_API, greenhouseOk(LIVE_CHANGED_687));
      const { attemptId } = await startAndRun();
      await pipeline.resumeApplicationAttempt(verifyingDeps(), attemptId, { resolution: 'keep_current' });
      workspace.updateApplicationAttempt(db, attemptId, { checkpoint: 'needs_user', checkpointDetail: 'synthetic blocker' });
      const reasons = ['timeout', 'denied', 'server_error'];
      for (let i = 0; i < 30; i += 1) {
        store.recordPostingVerification(db, {
          attemptId,
          allowedCheckpoints: ['needs_user'],
          observedAt: new Date(T0.getTime() + (i + 1) * 60_000),
          source: 'greenhouse',
          sourceRef: 'x',
          outcome: 'unable',
          result: 'unable_to_verify',
          reason: reasons[i % reasons.length]!,
          httpStatus: null,
          contentHash: null,
          baselineHash: latest(attemptId)!.baselineHash,
          deadline: null,
          deadlineProvenance: null,
          etag: null,
          lastModified: null,
          changeSummary: null,
          observedText: null,
        });
      }
      const rows = store.listPostingVerifications(db, attemptId);
      expect(rows.length).toBeLessThanOrEqual(store.POSTING_VERIFICATION_ROWS_PER_ATTEMPT + 1);
      expect(rows.some((row) => row.resolution === 'keep_current')).toBe(true);
      expect(rows.filter((row) => row.hasObservedText)).toEqual([]);
    });
  });

  describe('a preparation that stopped on a finding which a later answer settled (fix round 2)', () => {
    const DAY_25H = 25 * 60 * 60 * 1000;
    const TYPO_OF_SNAPSHOT = LIVE_SAME_687.replace('routing platform', 'routing platfrom');

    /** Prepare against `stop`: needs_user at the finding sentence, nothing generated, nothing held. */
    async function stoppedAt(stop: AtsHttpResponse | Error, ...later: PostingStep[]) {
      http.route(GH_API, stop, ...later);
      const { attemptId, ticked } = await startAndRun();
      const attempt = workspace.getApplicationAttempt(db, attemptId);
      expect(ticked.result?.outcome).toBe('needs_user');
      expect(verification.isPostingFindingDetail(attempt.checkpointDetail)).toBe(true);
      expect(generateTailoredResume).not.toHaveBeenCalled();
      expect(workspace.listApplicationArtifacts(db, attemptId)).toEqual([]);
      expect(store.listPostingVerifications(db, attemptId).some((row) => row.held)).toBe(false);
      clock = new Date(T0.getTime() + DAY_25H);
      return { attemptId, stopped: attempt };
    }

    const view = (attemptId: string) => verification.readPostingVerification({ db, now: () => clock }, attemptId);

    it.each([
      ['closed (404)', () => httpError('http_error', 404), 'dialog open (not forced)', false],
      ['closed (404)', () => httpError('http_error', 404), 'Check again (forced)', true],
      ['changed requirements', () => greenhouseOk(LIVE_CHANGED_687), 'dialog open (not forced)', false],
      ['changed requirements', () => greenhouseOk(LIVE_CHANGED_687), 'Check again (forced)', true],
    ] as const)(
      'stopped on %s, then %s finds it open and unchanged: the person can prepare it, once',
      async (_stop, stop, _path, force) => {
        const { attemptId, stopped } = await stoppedAt(stop(), greenhouseOk(LIVE_SAME_687));
        const enqueued = queue.enqueued.length;

        const checked = await pipeline.verifyPreparedApplicationAttempt(verifyingDeps(), attemptId, force ? { force: true } : {});
        expect(checked).toMatchObject({ status: 'confirmed_open', held: false, invalidated: false });
        expect(checked.actions).toEqual(['prepare_now', 'check_again']);

        // The stale sentence is gone, and nothing else about the application moved or started.
        const waiting = workspace.getApplicationAttempt(db, attemptId);
        expect(waiting).toMatchObject({
          checkpoint: 'needs_user',
          checkpointDetail: verification.POSTING_REOPENED_DETAIL,
          jdSnapshot: stopped.jdSnapshot,
          preparedFields: null,
        });
        expect(verification.isPostingFindingDetail(waiting.checkpointDetail)).toBe(false);
        expect(verification.isPreparedPackage(waiting)).toBe(false);
        expect(view(attemptId)).toMatchObject({ status: 'confirmed_open', actions: ['prepare_now', 'check_again'] });
        expect(queue.enqueued.length).toBe(enqueued);
        expect(generateTailoredResume).not.toHaveBeenCalled();
        expect(store.listPostingVerifications(db, attemptId).every((row) => !row.hasObservedText)).toBe(true);

        // The actual action ("Prepare now" = the ordinary resume, no decision to record).
        const resumed = await pipeline.resumeApplicationAttempt(verifyingDeps(), attemptId);
        expect(resumed).toMatchObject({ ok: true, continued: 'queued' });
        expect(queue.enqueued.length).toBe(enqueued + 1);
        queueApplicationDocumentRenders();
        await pipeline.runNextApplicationAttempt(verifyingDeps());
        expect(generateTailoredResume).toHaveBeenCalledTimes(1);
        expect(workspace.getApplicationAttempt(db, attemptId).checkpointDetail).toContain(MANUAL_HANDOFF);
        expect(workspace.listApplicationAttempts(db)).toHaveLength(1);
        // The open answer was still fresh for the preparation run: no extra request beyond the two checks.
        expect(http.calls).toHaveLength(2);
      },
    );

    it('a posting that reverted to the prepared text, or only gained a typo fix, is open too', async () => {
      const { attemptId } = await stoppedAt(greenhouseOk(LIVE_CHANGED_687), greenhouseOk(TYPO_OF_SNAPSHOT));
      const checked = await pipeline.verifyPreparedApplicationAttempt(verifyingDeps(), attemptId, { force: true });
      expect(checked).toMatchObject({ status: 'confirmed_open' });
      expect(checked.actions).toEqual(['prepare_now', 'check_again']);
      expect(workspace.getApplicationAttempt(db, attemptId).checkpointDetail).toBe(verification.POSTING_REOPENED_DETAIL);
      expect((await pipeline.resumeApplicationAttempt(verifyingDeps(), attemptId)).continued).toBe('queued');
      queueApplicationDocumentRenders();
      await pipeline.runNextApplicationAttempt(verifyingDeps());
      expect(generateTailoredResume).toHaveBeenCalledTimes(1);
    });

    it('still closed or still changed: the finding stands, no prepare action, and a stray resume stops again with no AI work', async () => {
      const { attemptId, stopped } = await stoppedAt(httpError('http_error', 404), httpError('http_error', 404));
      const view1 = await pipeline.verifyPreparedApplicationAttempt(verifyingDeps(), attemptId, { force: true });
      expect(view1).toMatchObject({ status: 'confirmed_closed', resolution: null });
      expect(view1.actions).toEqual(['open_posting', 'prepare_anyway', 'check_again']);
      expect(workspace.getApplicationAttempt(db, attemptId).checkpointDetail).toBe(stopped.checkpointDetail);

      // Even a resume that bypasses the UI cannot prepare against an undecided closure.
      await pipeline.resumeApplicationAttempt(verifyingDeps(), attemptId);
      clock = new Date(clock.getTime() + 60_000);
      await pipeline.runNextApplicationAttempt(verifyingDeps());
      expect(generateTailoredResume).not.toHaveBeenCalled();
      expect(workspace.getApplicationAttempt(db, attemptId)).toMatchObject({
        checkpoint: 'needs_user',
        checkpointDetail: verification.POSTING_CLOSED_DETAIL,
      });
    });

    it('a check that cannot reach the posting never releases the finding', async () => {
      const { attemptId, stopped } = await stoppedAt(httpError('http_error', 404), httpError('timeout'));
      const checked = await pipeline.verifyPreparedApplicationAttempt(verifyingDeps(), attemptId, { force: true });
      expect(checked).toMatchObject({ status: 'confirmed_closed', recheck: { reason: 'timeout' } });
      expect(checked.actions).not.toContain('prepare_now');
      expect(checked.actions).toContain('prepare_anyway');
      expect(workspace.getApplicationAttempt(db, attemptId).checkpointDetail).toBe(stopped.checkpointDetail);
    });

    it('an earlier open answer still stands after a later "could not check": the person is not stranded', async () => {
      const { attemptId } = await stoppedAt(httpError('http_error', 404), greenhouseOk(LIVE_SAME_687), httpError('timeout'));
      await pipeline.verifyPreparedApplicationAttempt(verifyingDeps(), attemptId, { force: true });
      clock = new Date(clock.getTime() + 60 * 60 * 1000);
      const later = await pipeline.verifyPreparedApplicationAttempt(verifyingDeps(), attemptId, { force: true });
      expect(later).toMatchObject({ status: 'unable_to_verify', reason: 'timeout' });
      expect(later.actions).toEqual(['prepare_now', 'open_posting', 'check_again']);
      expect((await pipeline.resumeApplicationAttempt(verifyingDeps(), attemptId)).continued).toBe('queued');
    });

    it('open, then closed again: the sentence follows the newest finding and the person must decide again', async () => {
      const { attemptId } = await stoppedAt(httpError('http_error', 404), greenhouseOk(LIVE_SAME_687), httpError('http_error', 404));
      await pipeline.verifyPreparedApplicationAttempt(verifyingDeps(), attemptId, { force: true });
      expect(workspace.getApplicationAttempt(db, attemptId).checkpointDetail).toBe(verification.POSTING_REOPENED_DETAIL);
      clock = new Date(clock.getTime() + 60_000);
      const again = await pipeline.verifyPreparedApplicationAttempt(verifyingDeps(), attemptId, { force: true });
      expect(again.actions).toEqual(['open_posting', 'prepare_anyway', 'check_again']);
      expect(workspace.getApplicationAttempt(db, attemptId).checkpointDetail).toBe(verification.POSTING_CLOSED_DETAIL);

      // And that decision still prepares exactly once.
      const decided = await pipeline.resumeApplicationAttempt(verifyingDeps(), attemptId, { resolution: 'prepare_anyway' });
      expect(decided).toMatchObject({ ok: true, continued: 'queued' });
      queueApplicationDocumentRenders();
      await pipeline.runNextApplicationAttempt(verifyingDeps());
      expect(generateTailoredResume).toHaveBeenCalledTimes(1);
    });

    it('closed, then changed: the stored sentence describes the changed finding and Keep still prepares once', async () => {
      const { attemptId } = await stoppedAt(httpError('http_error', 404), greenhouseOk(LIVE_CHANGED_687));
      const changed = await pipeline.verifyPreparedApplicationAttempt(verifyingDeps(), attemptId, { force: true });
      expect(changed.actions).toEqual(['refresh', 'keep_current', 'open_posting', 'check_again']);
      expect(workspace.getApplicationAttempt(db, attemptId).checkpointDetail).toBe(verification.POSTING_CHANGED_DETAIL);
      const kept = await pipeline.resumeApplicationAttempt(verifyingDeps(), attemptId, { resolution: 'keep_current' });
      expect(kept).toMatchObject({ ok: true, continued: 'queued' });
    });

    it('a stop that the person already resolved is unaffected: Get ready anyway prepares and a later open check changes nothing', async () => {
      const { attemptId } = await stoppedAt(httpError('http_error', 404), greenhouseOk(LIVE_SAME_687));
      await pipeline.resumeApplicationAttempt(verifyingDeps(), attemptId, { resolution: 'prepare_anyway' });
      queueApplicationDocumentRenders();
      await pipeline.runNextApplicationAttempt(verifyingDeps());
      const prepared = workspace.getApplicationAttempt(db, attemptId);
      expect(prepared.checkpointDetail).toContain(MANUAL_HANDOFF);
      const generations = generateTailoredResume.mock.calls.length;

      clock = new Date(clock.getTime() + DAY_25H);
      const later = await pipeline.verifyPreparedApplicationAttempt(verifyingDeps(), attemptId, { force: true });
      expect(later.actions).toEqual(['check_again']);
      expect(workspace.getApplicationAttempt(db, attemptId)).toMatchObject({
        checkpoint: prepared.checkpoint,
        checkpointDetail: prepared.checkpointDetail,
      });
      expect(generateTailoredResume.mock.calls.length).toBe(generations);
    });

    it('another blocker is never rewritten or offered a prepare action by an open answer', async () => {
      http.route(GH_API, greenhouseOk(LIVE_SAME_687), greenhouseOk(LIVE_SAME_687));
      const { attemptId } = await startAndRun();
      const blocker = 'Question 7 needs your own answer: Why us?';
      workspace.updateApplicationAttempt(db, attemptId, { checkpoint: 'needs_user', checkpointDetail: blocker });
      clock = new Date(T0.getTime() + DAY_25H);
      const checked = await pipeline.verifyPreparedApplicationAttempt(verifyingDeps(), attemptId, { force: true });
      expect(checked.actions).toEqual(['check_again']);
      expect(workspace.getApplicationAttempt(db, attemptId).checkpointDetail).toBe(blocker);
    });
  });

  describe('historical submitted packages are immutable', () => {
    it.each(['submitted', 'user_reported'] as const)('a %s attempt is never consulted, changed or refreshed', async (checkpoint) => {
      http.route(GH_API, greenhouseOk(LIVE_CHANGED_687));
      const { attemptId } = await startAndRun(posting(), verifyingDeps(new PostingHttp().route(GH_API, greenhouseOk(LIVE_SAME_687))));
      const sentAt = '2026-09-11T12:30:00.000Z';
      workspace.updateApplicationAttempt(db, attemptId, {
        checkpoint,
        checkpointDetail: 'sent',
        submittedAt: sentAt,
      });
      const frozen = workspace.getApplicationAttempt(db, attemptId);
      const frozenArtifacts = workspace.listApplicationArtifacts(db, attemptId);
      const rowsBefore = store.listPostingVerifications(db, attemptId);

      // The live posting changed AND closed since; the package that was sent does not move.
      clock = new Date(T0.getTime() + 72 * 60 * 60 * 1000);
      const view = await pipeline.verifyPreparedApplicationAttempt(verifyingDeps(), attemptId, { force: true });
      const refreshed = await pipeline.refreshApplicationFromPosting(verifyingDeps(), attemptId);
      const resumed = await pipeline.resumeApplicationAttempt(verifyingDeps(), attemptId);

      expect(http.calls).toHaveLength(0);
      expect(view).toMatchObject({ status: 'not_applicable', actions: [], checkedAt: null });
      expect(refreshed.ok).toBe(false);
      expect(resumed.ok).toBe(false);
      expect(workspace.getApplicationAttempt(db, attemptId)).toEqual(frozen);
      expect(workspace.listApplicationArtifacts(db, attemptId)).toEqual(frozenArtifacts);
      expect(store.listPostingVerifications(db, attemptId)).toEqual(rowsBefore);
      // And the store refuses to write for it even if a late check somehow landed.
      expect(
        store.recordPostingVerification(db, {
          attemptId,
          allowedCheckpoints: [checkpoint],
          observedAt: clock,
          source: 'greenhouse',
          sourceRef: 'x',
          outcome: 'closed',
          result: 'confirmed_closed',
          reason: 'not_found',
          httpStatus: 404,
          contentHash: null,
          baselineHash: '',
          deadline: null,
          deadlineProvenance: null,
          etag: null,
          lastModified: null,
          changeSummary: null,
          observedText: null,
        }).written,
      ).toBe('refused');
    });

    it('a pending change cannot be adopted once the attempt was sent', async () => {
      http.route(GH_API, greenhouseOk(LIVE_CHANGED_687));
      const { attemptId } = await startAndRun();
      expect(latest(attemptId)?.result).toBe('materially_changed');
      workspace.updateApplicationAttempt(db, attemptId, { checkpoint: 'user_reported', checkpointDetail: 'I applied myself' });
      const frozen = workspace.getApplicationAttempt(db, attemptId);

      expect(store.adoptPostingChange(db, attemptId)).toEqual({ ok: false, reason: 'historical' });
      expect((await pipeline.refreshApplicationFromPosting(verifyingDeps(), attemptId)).ok).toBe(false);
      expect(workspace.getApplicationAttempt(db, attemptId)).toEqual(frozen);
    });
  });

  describe('interruption, cancellation and overlapping requests', () => {
    function gate(): { open: (step: AtsHttpResponse | Error) => void; step: PostingStep; entered: Promise<void> } {
      let open!: (step: AtsHttpResponse | Error) => void;
      let markEntered!: () => void;
      const entered = new Promise<void>((resolve) => {
        markEntered = resolve;
      });
      const pending = new Promise<AtsHttpResponse | Error>((resolve) => {
        open = resolve;
      });
      return {
        open,
        entered,
        step: async () => {
          markEntered();
          return pending;
        },
      };
    }

    it('a check cancelled while in flight leaves no half-written state and spends no AI work', async () => {
      const held = gate();
      http.route(GH_API, held.step);
      const runDeps = verifyingDeps();
      const started = await pipeline.startApplicationAttempt(runDeps, { vacancy: posting() });
      const attemptId = started.attemptId!;
      queueApplicationDocumentRenders();

      const ticking = pipeline.runNextApplicationAttempt(runDeps);
      await held.entered;
      queue.cancel(attemptId); // the person cancels while the posting is being checked
      held.open(greenhouseOk(LIVE_CHANGED_687));
      const ticked = await ticking;

      expect(ticked.result?.outcome).toBe('halted');
      expect(generateTailoredResume).not.toHaveBeenCalled();
      expect(printToPDF).not.toHaveBeenCalled();
      expect(workspace.listApplicationArtifacts(db, attemptId)).toEqual([]);
      const attempt = workspace.getApplicationAttempt(db, attemptId);
      expect(attempt.jdSnapshot).toBe(SNAPSHOT_687);
      expect(store.listPostingVerifications(db, attemptId).length).toBeLessThanOrEqual(1);
    });

    it('an attempt that moved on during the request records nothing and is not touched', async () => {
      const held = gate();
      http.route(GH_API, held.step);
      const runDeps = verifyingDeps();
      const started = await pipeline.startApplicationAttempt(runDeps, { vacancy: posting() });
      const attemptId = started.attemptId!;

      const ticking = pipeline.runNextApplicationAttempt(runDeps);
      await held.entered;
      // Reset/skipped from elsewhere while the request is out.
      workspace.updateApplicationAttempt(db, attemptId, { checkpoint: 'skipped', checkpointDetail: 'skipped by the person' });
      held.open(greenhouseOk(LIVE_CHANGED_687));
      const ticked = await ticking;

      expect(ticked.result?.outcome).toBe('halted');
      expect(store.listPostingVerifications(db, attemptId)).toEqual([]);
      expect(workspace.getApplicationAttempt(db, attemptId)).toMatchObject({
        checkpoint: 'skipped',
        checkpointDetail: 'skipped by the person',
        jdSnapshot: SNAPSHOT_687,
      });
      expect(generateTailoredResume).not.toHaveBeenCalled();
    });

    it('an abandoned (fenced-out) preparation writes nothing when its slow check finally answers', async () => {
      const { log, stopped } = watchForAbandonedRun();
      const held = gate();
      http.route(GH_API, held.step);
      const runDeps = { ...verifyingDeps(), abandonPreparationAfterMs: 20, log };
      const started = await pipeline.startApplicationAttempt(runDeps, { vacancy: posting() });
      const attemptId = started.attemptId!;
      queueApplicationDocumentRenders();

      const ticked = await pipeline.runNextApplicationAttempt(runDeps);
      expect(ticked.abandoned).toBe(true);
      const frozen = workspace.getApplicationAttempt(db, attemptId);

      held.open(greenhouseOk(LIVE_CHANGED_687));
      await abandonedRunSettled(stopped);

      expect(workspace.getApplicationAttempt(db, attemptId)).toEqual(frozen);
      expect(generateTailoredResume).not.toHaveBeenCalled();
      expect(printToPDF).not.toHaveBeenCalled();
    });

    it('overlapping checks for one attempt share ONE request and ONE stored row', async () => {
      http.route(GH_API, greenhouseOk(LIVE_SAME_687));
      const { attemptId } = await startAndRun();
      const held = gate();
      http.route(GH_API, held.step);
      clock = new Date(T0.getTime() + 40 * 60 * 60 * 1000);

      const first = pipeline.verifyPreparedApplicationAttempt(verifyingDeps(), attemptId);
      await held.entered;
      const second = pipeline.verifyPreparedApplicationAttempt(verifyingDeps(), attemptId, { force: true });
      const third = pipeline.verifyPreparedApplicationAttempt(verifyingDeps(), attemptId);
      held.open(greenhouseOk(LIVE_SAME_687));
      const views = await Promise.all([first, second, third]);

      expect(http.calls).toHaveLength(2); // the original preparation + exactly one shared recheck
      expect(new Set(views.map((view) => view.checkedAt)).size).toBe(1);
      expect(store.listPostingVerifications(db, attemptId)).toHaveLength(1);
    });

    it('a prepare run and a renderer-triggered check overlap without a second request or a second attempt', async () => {
      const held = gate();
      http.route(GH_API, held.step);
      const runDeps = verifyingDeps();
      const started = await pipeline.startApplicationAttempt(runDeps, { vacancy: posting() });
      const attemptId = started.attemptId!;
      queueApplicationDocumentRenders();

      const ticking = pipeline.runNextApplicationAttempt(runDeps);
      await held.entered;
      const overlapping = pipeline.verifyPreparedApplicationAttempt(runDeps, attemptId, { force: true });
      held.open(greenhouseOk(LIVE_SAME_687));
      await Promise.all([ticking, overlapping]);

      expect(http.calls).toHaveLength(1);
      expect(workspace.listApplicationAttempts(db)).toHaveLength(1);
      expect(store.listPostingVerifications(db, attemptId)).toHaveLength(1);
      expect(generateTailoredResume).toHaveBeenCalledTimes(1);
    });

    it('never overwrites a newer observation with an older one', () => {
      const started = workspace.createApplicationAttempt(db, {
        vacancyKey: 'vac-order',
        canonicalUrl: GH_URL,
        company: 'Northwind Freight',
        role: 'Engineer',
        sourceCvId: workspace.listCvDocuments(db)[0]!.id,
        sourceCvContentHash: 'x',
        jdSnapshot: SNAPSHOT_687,
        jdSnapshotHash: 'y',
        jdComplete: true,
        workflowVersion: pipeline.APPLICATION_PIPELINE_WORKFLOW_VERSION,
        checkpoint: 'needs_user',
      });
      const base = {
        attemptId: started.id,
        allowedCheckpoints: ['needs_user'] as const,
        source: 'greenhouse',
        sourceRef: 'x',
        reason: 'verified_open',
        httpStatus: 200,
        contentHash: 'h1',
        baselineHash: 'h1',
        deadline: null,
        deadlineProvenance: null,
        etag: null,
        lastModified: null,
        changeSummary: null,
        observedText: null,
        outcome: 'open' as const,
        result: 'confirmed_open' as const,
      };
      const newer = store.recordPostingVerification(db, { ...base, observedAt: new Date(T0.getTime() + 1000) });
      const older = store.recordPostingVerification(db, { ...base, reason: 'not_modified', observedAt: T0 });
      expect(newer.written).toBe('inserted');
      expect(older.written).toBe('dropped_older');
      expect(store.listPostingVerifications(db, started.id)).toHaveLength(1);
      expect(store.getLatestPostingVerification(db, started.id)?.reason).toBe('verified_open');
    });
  });
});

// -------------------------------------------------------------------------------------------------
// #687 measurement (fix round 1): one fixed synthetic fixture set, the SAME real pipeline run twice --
// once as it behaved before (no verifier: a stored snapshot goes straight to preparation) and once
// with the live posting check. The "after" network is the PRODUCTION composition
// (`createDatabaseBackedAtsHttpClient`: real SafeHttpClient, real DatabaseHttpCache on a migrated
// in-memory engine database) with only `fetch` and DNS stubbed, so PHYSICAL requests (every redirect
// hop, counted at the client's own `onNetworkRequest`) are reported separately from LOGICAL client calls.
//
// The corpus deliberately contains hard negatives: open postings whose text sounds closed, ordinary
// employer-copy edits that are not requirement changes, a 600-line full rewrite, an adversarial
// deadline whitespace run, a same-origin redirect loop and an account-less Workable short link.
// "Truth" is the fixture AUTHOR's label; nothing here says how often real postings close, fail to
// answer or change. Latency is the in-process cost on this machine with an instant fixture network
// (timeouts use a 50 ms deadline instead of the production 20 s); real round trips are not measured.
// -------------------------------------------------------------------------------------------------
describe('#687 measurement on a fixed synthetic fixture set', () => {
  type Kind =
    | 'unchanged'
    | 'closed'
    | 'changed'
    | 'timeout'
    | 'denied'
    | 'login_wall'
    | 'unsupported'
    | 'closure_like_open'
    | 'employer_copy_edit'
    | 'requirement_edit'
    | 'full_rewrite_600_lines'
    | 'adversarial_deadline_text'
    | 'redirect_loop'
    | 'workable_short_link'
    | 'markup_bomb';
  interface Lead {
    n: number;
    kind: Kind;
    truth: 'open' | 'closed';
    source: 'greenhouse' | 'lever' | 'workable' | 'jobgether' | 'unsupported';
    url: string;
    api: string | null;
    snapshot: string;
    live: string;
    /** Expected to stop before AI work because the posting materially changed. */
    expectChangeStop: boolean;
  }

  const textFor = (n: number, changed: boolean) =>
    [
      `Lead ${n}: build and run the routing platform for customer ${n}.`,
      changed ? 'Eight years of experience is required.' : 'Five years of experience is required.',
      ...(changed ? ['Fluent Dutch is required.'] : []),
      changed ? 'Onsite in Eindhoven.' : 'Hybrid in Utrecht.',
    ].join('\n');
  const longText = (n: number) =>
    [
      'About us',
      `Customer ${n} builds routing software for logistics teams across Europe.`,
      'We are a friendly team of forty people.',
      'Requirements',
      'Five years of TypeScript experience is required.',
      'Fluent English.',
      'Experience with PostgreSQL.',
      'Responsibilities',
      'Design and run the routing platform.',
      'Review code with your colleagues.',
      'Benefits',
      'Pension plan.',
      'Free lunch on Fridays.',
    ].join('\n');
  const CLOSURE_LIKE = [
    'The job is closed to applicants without EU work authorisation. Apply if eligible.',
    'Hiring is closed in the US for this role but open in Canada.',
    'Applications for this role are closed to external candidates until Friday.',
    'This position has been filled internally in the past; we are hiring again.',
    'Applications for the 2025 intake are closed; this 2026 role is open.',
    'We are no longer accepting applications from recruitment agencies.',
  ];
  const EMPLOYER_EDITS: Array<(text: string) => string> = [
    (text) => text.replace('builds routing software', 'leads the market in routing software'),
    (text) => text.replace('We are a friendly team of forty people.', 'Founded 12 years ago, we are a friendly team of forty people.'),
    (text) => text.replace('Free lunch on Fridays.', 'Free lunch on Fridays.\nOur new office has a rooftop terrace.'),
  ];
  const REQUIREMENT_EDITS: Array<(text: string) => string> = [
    (text) => text.replace('Fluent English.', 'Fluent English.\nWe cannot offer visa sponsorship.'),
    (text) => text.replace('Experience with PostgreSQL.', 'Experience with PostgreSQL.\nKubernetes in production.'),
    (text) => text.replace('Review code with your colleagues.', 'Review code with your colleagues.\nThis role is onsite in Eindhoven.'),
  ];
  const rewriteLine = (prefix: string, i: number) =>
    `${prefix} paragraph id${i} describing the platform, the team rituals and the way we ship software every week.`;
  const html = (text: string) => `<p>${text.replace(/\n/gu, '</p><p>')}</p>`;
  const escaped = (text: string) => html(text).replace(/</gu, '&lt;').replace(/>/gu, '&gt;');

  function lead(n: number, source: Lead['source'], kind: Kind, truth: Lead['truth'], variant = 0): Lead {
    const code = `F5${n.toString(16).padStart(8, '0')}`.toUpperCase();
    const hex24 = `6a61448${n.toString(16).padStart(17, '0')}`;
    const uuid = `0a1b2c3d-1111-4222-8333-${n.toString(16).padStart(12, '0')}`;
    let snapshot = textFor(n, false);
    let live = textFor(n, kind === 'changed');
    let expectChangeStop = kind === 'changed';
    if (kind === 'closure_like_open') {
      snapshot = `${CLOSURE_LIKE[variant]!}\n${longText(n)}`;
      live = snapshot;
    } else if (kind === 'employer_copy_edit') {
      snapshot = longText(n);
      live = EMPLOYER_EDITS[variant]!(snapshot);
    } else if (kind === 'requirement_edit') {
      snapshot = longText(n);
      live = REQUIREMENT_EDITS[variant]!(snapshot);
      expectChangeStop = true;
    } else if (kind === 'full_rewrite_600_lines') {
      snapshot = Array.from({ length: 600 }, (_, i) => rewriteLine('Original', i)).join('\n');
      live = Array.from({ length: 600 }, (_, i) => rewriteLine('Rewritten', i)).join('\n');
      expectChangeStop = true;
    } else if (kind === 'adversarial_deadline_text') {
      snapshot = `${textFor(n, false)}\ndeadline${' \n'.repeat(20_000)}`;
      live = snapshot;
    }
    const base = { n, kind, truth, snapshot, live, expectChangeStop };
    switch (source) {
      case 'greenhouse':
        return { ...base, source, url: `https://boards.greenhouse.io/b${n}/jobs/${4_012_300 + n}`, api: `https://boards-api.greenhouse.io/v1/boards/b${n}/jobs/${4_012_300 + n}` };
      case 'lever':
        return { ...base, source, url: `https://jobs.lever.co/s${n}/${uuid}`, api: `https://api.lever.co/v0/postings/s${n}/${uuid}` };
      case 'workable':
        return kind === 'workable_short_link'
          ? { ...base, source, url: `https://apply.workable.com/j/${code}`, api: `https://apply.workable.com/api/v2/accounts/a${n}/jobs/${code}` }
          : { ...base, source, url: `https://apply.workable.com/a${n}/j/${code}/`, api: `https://apply.workable.com/api/v2/accounts/a${n}/jobs/${code}` };
      case 'jobgether':
        return { ...base, source, url: `https://jobgether.com/offer/${hex24}-role-${n}`, api: `https://jobgether.com/astroapi/offer/${hex24}.json` };
      case 'unsupported':
        return { ...base, source, url: `https://careers.example.org/jobs/${n}`, api: null };
    }
  }

  const LEADS: Lead[] = [
    lead(1, 'greenhouse', 'unchanged', 'open'), lead(2, 'greenhouse', 'unchanged', 'open'), lead(3, 'greenhouse', 'unchanged', 'open'),
    lead(4, 'lever', 'unchanged', 'open'), lead(5, 'lever', 'unchanged', 'open'),
    lead(6, 'workable', 'unchanged', 'open'), lead(7, 'workable', 'unchanged', 'open'),
    lead(8, 'jobgether', 'unchanged', 'open'),
    lead(9, 'greenhouse', 'closed', 'closed'), lead(10, 'lever', 'closed', 'closed'), lead(11, 'jobgether', 'closed', 'closed'),
    lead(12, 'greenhouse', 'changed', 'open'), lead(13, 'lever', 'changed', 'open'), lead(14, 'workable', 'changed', 'open'),
    lead(15, 'greenhouse', 'timeout', 'open'), lead(16, 'workable', 'timeout', 'open'),
    lead(17, 'lever', 'denied', 'open'), lead(18, 'jobgether', 'denied', 'open'),
    lead(19, 'greenhouse', 'login_wall', 'closed'),
    lead(20, 'unsupported', 'unsupported', 'closed'),
    // Hard negatives and stress cases added in fix round 1.
    ...CLOSURE_LIKE.map((_text, i) => lead(21 + i, i % 2 === 0 ? 'greenhouse' : 'lever', 'closure_like_open', 'open', i)),
    ...EMPLOYER_EDITS.map((_edit, i) => lead(27 + i, 'greenhouse', 'employer_copy_edit', 'open', i)),
    ...REQUIREMENT_EDITS.map((_edit, i) => lead(30 + i, 'greenhouse', 'requirement_edit', 'open', i)),
    lead(33, 'greenhouse', 'full_rewrite_600_lines', 'open'),
    // Lever's plain-text field: the deadline parser sees the whitespace run directly.
    lead(34, 'lever', 'adversarial_deadline_text', 'open'),
    lead(35, 'greenhouse', 'redirect_loop', 'open'),
    lead(36, 'workable', 'workable_short_link', 'open'),
    // 20,000 HTML elements: over the parsing budget, so "could not check", not parsed on the main process.
    lead(37, 'greenhouse', 'markup_bomb', 'open'),
  ];

  function payloadFor(entry: Lead): string {
    const live = entry.live;
    if (entry.kind === 'markup_bomb') {
      return JSON.stringify({ content: escaped(Array.from({ length: 20_000 }, (_, i) => `item ${i}`).join('\n')) });
    }
    return JSON.stringify(
      entry.source === 'greenhouse' ? { content: escaped(live) }
      : entry.source === 'lever' ? { descriptionPlain: live }
      : entry.source === 'workable' ? { description: html(live) }
      : { offer: { description: html(live) } },
    );
  }

  const LOGIN_TARGET = 'https://boards-api.greenhouse.io/users/sign_in';

  /** The stubbed `fetch` behind the real client: one synthetic answer per URL, nothing else reachable. */
  function fixtureFetch(fetched: string[]): typeof fetch {
    const byApi = new Map(LEADS.filter((entry) => entry.api !== null).map((entry) => [entry.api!, entry]));
    return (async (input: string | URL | Request, init?: RequestInit) => {
      const url = input instanceof Request ? input.url : input.toString();
      fetched.push(url);
      const short = LEADS.find((entry) => entry.kind === 'workable_short_link')!;
      if (url === short.url) {
        return new Response(null, { status: 301, headers: { location: `https://apply.workable.com/a${short.n}/j/${short.url.split('/').pop()}` } });
      }
      if (url.startsWith(`https://apply.workable.com/a${short.n}/j/`)) return new Response('<html>shell</html>');
      if (url === LOGIN_TARGET) return new Response('<html>Sign in</html>');
      const bare = url.split('?')[0]!;
      const entry = byApi.get(bare);
      if (!entry) throw new Error(`unexpected request in measurement: ${url}`);
      switch (entry.kind) {
        case 'closed':
          return new Response('{"error":"not found"}', { status: 404 });
        case 'denied':
          return new Response('', { status: 403 });
        case 'login_wall':
          return new Response(null, { status: 302, headers: { location: LOGIN_TARGET } });
        case 'redirect_loop': {
          const hop = Number(new URL(url).searchParams.get('hop') ?? '0');
          return new Response(null, { status: 302, headers: { location: `${bare}?hop=${hop + 1}` } });
        }
        case 'timeout':
          return new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
          });
        default:
          return new Response(payloadFor(entry), { headers: { etag: `"e${entry.n}"`, 'content-type': 'application/json' } });
      }
    }) as typeof fetch;
  }

  async function runPhase(database: WorkspaceDb, phaseDeps: ApplicationPipelineDeps) {
    const reached: number[] = [];
    const blocked: Record<string, number[]> = { closed: [], changed: [] };
    const attemptIds = new Map<number, string>();
    const overheadMs = new Map<number, number>();
    for (const entry of LEADS) {
      const before = generateTailoredResume.mock.calls.length;
      const started = await pipeline.startApplicationAttempt(phaseDeps, {
        vacancy: { ...VACANCY, vacancyKey: `lead-${entry.n}`, company: `Customer ${entry.n}`, applyUrl: entry.url, description: entry.snapshot, descriptionComplete: true },
      });
      attemptIds.set(entry.n, started.attemptId!);
      queueApplicationDocumentRenders();
      const t0 = performance.now();
      await pipeline.runNextApplicationAttempt(phaseDeps);
      overheadMs.set(entry.n, performance.now() - t0);
      if (generateTailoredResume.mock.calls.length > before) reached.push(entry.n);
      else {
        const detail = workspace.getApplicationAttempt(database, started.attemptId!).checkpointDetail;
        if (detail === verification.POSTING_CLOSED_DETAIL) blocked.closed!.push(entry.n);
        if (detail === verification.POSTING_CHANGED_DETAIL) blocked.changed!.push(entry.n);
      }
    }
    return { reached, blocked, attemptIds, overheadMs };
  }

  const median = (values: number[]) => {
    const sorted = [...values].sort((a, b) => a - b);
    return Number(sorted[Math.floor(sorted.length / 2)]!.toFixed(1));
  };

  it('measures closed leads reaching preparation, false closure, physical/logical requests and in-process cost', async () => {
    // BEFORE: this build's previous behaviour (no verifier configured), its own empty workspace.
    const beforeDir = mkdtempSync(join(tmpdir(), 'ovr-687-before-'));
    const beforeDb = createWorkspaceDb(beforeDir);
    seedCv(beforeDb.db);
    const beforeRun = await runPhase(beforeDb.db, { ...makeDeps(beforeDb.db), storageRoot: join(beforeDir, 'artifacts') });
    beforeDb.close();
    rmSync(beforeDir, { recursive: true, force: true });

    // AFTER: the same fixed leads through the same pipeline with the live check over the production
    // HTTP composition (real SafeHttpClient + DatabaseHttpCache), fetch and DNS stubbed.
    generateTailoredResume.mockClear();
    const engineDir = mkdtempSync(join(tmpdir(), 'ovr-687-engine-'));
    const engine = engineModule.createDatabaseClient(':memory:');
    await engineModule.migrateDatabase(engine.db, join(process.cwd(), '..', '..', 'packages', 'vacancy-engine', 'drizzle'));
    const config = engineModule.loadConfig({ DATABASE_PATH: 'vacancy-engine.db', HTTP_CACHE_DIR: '.cache/http' }, engineDir);
    // `physical` is the client's own per-fetch telemetry (redacted URLs); `fetched` is the same fetches
    // seen by the stub with full URLs, used only to attribute them to leads.
    const physical: string[] = [];
    const fetched: string[] = [];
    const atsClient = engineModule.createDatabaseBackedAtsHttpClient(config, engine.db, {
      fetchFn: fixtureFetch(fetched),
      resolver: async () => [{ address: '93.184.216.34', family: 4 }],
      sleep: async () => undefined,
      random: () => 0.5,
      onNetworkRequest: (url: string) => physical.push(url),
    });
    const logical: string[] = [];
    const countingClient: AtsHttpClient = {
      get: (url, options) => {
        logical.push(url);
        return atsClient.get(url, options);
      },
      postJson: (url, body, options) => atsClient.postJson(url, body, options),
    };
    const clock = new Date('2026-09-11T12:00:00.000Z');
    const afterDeps: ApplicationPipelineDeps = {
      ...deps,
      now: () => clock,
      verifyPosting: createPostingVerifier(countingClient, { now: () => clock, timeoutMs: 50 }).verify,
    };
    const physicalBefore = physical.length;
    const afterRun = await runPhase(db, afterDeps);
    const afterPhysical = physical.length - physicalBefore;
    const afterLogical = logical.length;
    // Attribution for the preparation pass only (later passes are reported separately below).
    const fetchedDuringPreparation = [...fetched];

    const rows = LEADS.map((entry) => ({ entry, row: store.getLatestPostingVerification(db, afterRun.attemptIds.get(entry.n)!) }));
    const truthOpen = LEADS.filter((entry) => entry.truth === 'open');
    const falseClosure = rows.filter(({ entry, row }) => entry.truth === 'open' && row?.result === 'confirmed_closed').map(({ entry }) => entry.n);
    const trueClosuresDetected = rows.filter(({ entry, row }) => entry.truth === 'closed' && row?.result === 'confirmed_closed').map(({ entry }) => entry.n);
    const closedTruth = LEADS.filter((entry) => entry.truth === 'closed').map((entry) => entry.n);
    const closedReachedAfter = closedTruth.filter((n) => afterRun.reached.includes(n));
    const unableRows = rows.filter(({ row }) => row?.result === 'unable_to_verify').map(({ entry }) => entry.n);
    const changeStopExpected = LEADS.filter((entry) => entry.expectChangeStop).map((entry) => entry.n);
    const falseChangeStops = afterRun.blocked.changed!.filter((n) => !changeStopExpected.includes(n));
    const missedChangeStops = changeStopExpected.filter((n) => !afterRun.blocked.changed!.includes(n));
    const perLeadPhysical = (entry: Lead) =>
      fetchedDuringPreparation.filter(
        (url) =>
          (entry.api !== null && url.startsWith(entry.api)) ||
          url.startsWith(entry.url) ||
          (entry.kind === 'workable_short_link' && url.startsWith(`https://apply.workable.com/a${entry.n}/j/`)) ||
          (entry.kind === 'login_wall' && url === LOGIN_TARGET),
      ).length;
    expect(fetchedDuringPreparation).toHaveLength(afterPhysical);

    // Second pass 10 minutes later: every finding is young (an "unable" one retries after 15 min).
    const physicalBeforeReuse = physical.length;
    const reuseClock = new Date(clock.getTime() + 10 * 60 * 1000);
    for (const entry of LEADS) {
      await pipeline.verifyPreparedApplicationAttempt({ ...afterDeps, now: () => reuseClock }, afterRun.attemptIds.get(entry.n)!);
    }
    const physicalOnReuse = physical.length - physicalBeforeReuse;
    // Third pass an hour after the first: only "could not check" leads with a route are asked again.
    const physicalBeforeLater = physical.length;
    const logicalBeforeLater = logical.length;
    const laterClock = new Date(clock.getTime() + 60 * 60 * 1000);
    for (const entry of LEADS) {
      await pipeline.verifyPreparedApplicationAttempt({ ...afterDeps, now: () => laterClock }, afterRun.attemptIds.get(entry.n)!);
    }
    const physicalOneHourLater = physical.length - physicalBeforeLater;
    const logicalOneHourLater = logical.length - logicalBeforeLater;
    engine.close();
    rmSync(engineDir, { recursive: true, force: true });

    const overheadFor = (run: typeof afterRun, kinds: Kind[]) =>
      LEADS.filter((entry) => kinds.includes(entry.kind)).map((entry) => run.overheadMs.get(entry.n)!);
    const ordinaryKinds: Kind[] = ['unchanged', 'closed', 'changed', 'denied', 'login_wall', 'unsupported', 'closure_like_open', 'employer_copy_edit', 'requirement_edit', 'redirect_loop', 'workable_short_link'];
    const leadOf = (kind: Kind) => LEADS.find((entry) => entry.kind === kind)!;
    const measurement = {
      issue: 687,
      round: 'fix-1',
      kind: "SYNTHETIC fixed-fixture measurement; truth labels are the fixture author's, not human labels of real postings",
      network: 'production composition createDatabaseBackedAtsHttpClient (real SafeHttpClient + DatabaseHttpCache on a migrated in-memory engine DB); fetch and DNS stubbed; no live site contacted',
      fixtureCount: LEADS.length,
      fixtureMix: Object.fromEntries(
        [...new Set(LEADS.map((entry) => entry.kind))].map((kind) => [kind, LEADS.filter((entry) => entry.kind === kind).length]),
      ),
      truthClosedLeads: closedTruth.length,
      truthOpenLeads: truthOpen.length,
      before: {
        behaviour: 'no live check: a stored snapshot goes straight to preparation',
        leadsReachingPreparation: beforeRun.reached.length,
        closedLeadsReachingPreparation: closedTruth.filter((n) => beforeRun.reached.includes(n)).length,
        requests: { logical: 0, physical: 0 },
      },
      after: {
        behaviour: 'one bounded authoritative check at preparation',
        leadsReachingPreparation: afterRun.reached.length,
        closedLeadsReachingPreparation: closedReachedAfter.length,
        closedLeadsReachingPreparationIds: closedReachedAfter,
        closedLeadsStoppedBeforePreparation: trueClosuresDetected.length,
        falseClosureCount: falseClosure.length,
        falseClosureDenominator: truthOpen.length,
        falseClosureDenominatorIncludesClosureLikeOpenPostings: LEADS.filter((entry) => entry.kind === 'closure_like_open').length,
        changedLeadsStoppedBeforeRegeneration: afterRun.blocked.changed!.length,
        changeStopsExpected: changeStopExpected.length,
        changeStopsMissed: missedChangeStops,
        falseChangeStops,
        employerCopyEditsReachingPreparation: LEADS.filter((entry) => entry.kind === 'employer_copy_edit' && afterRun.reached.includes(entry.n)).length,
        unableToVerifyLeads: unableRows.length,
        unableToVerifyLeadsThatStillReachedPreparation: unableRows.filter((n) => afterRun.reached.includes(n)).length,
        requests: {
          logical: afterLogical,
          physical: afterPhysical,
          logicalPerLead: Number((afterLogical / LEADS.length).toFixed(2)),
          physicalPerLead: Number((afterPhysical / LEADS.length).toFixed(2)),
          maxPhysicalForOneLead: Math.max(...LEADS.map(perLeadPhysical)),
          envelope: engineModule.POSTING_REQUEST_ENVELOPE,
        },
        leadsWithNoRequest: LEADS.filter((entry) => perLeadPhysical(entry) === 0).map((entry) => entry.n),
        physicalRequestsOnSecondPassTenMinutesLater: physicalOnReuse,
        requestsOnThirdPassOneHourLater: { logical: logicalOneHourLater, physical: physicalOneHourLater },
        requestsOneHourLaterAreOnly: 'could-not-check leads that have an authoritative route (retried after 15 minutes)',
      },
      inProcessCostMs: {
        note: 'in-process wall clock for start+prepare of one lead on this machine, instant fixture network; timeouts use a 50 ms deadline (production: 20 s, enforced by abort); real network round trips are NOT measured and no real-world latency improvement is claimed',
        beforeMedianOrdinary: median(overheadFor(beforeRun, ordinaryKinds)),
        afterMedianOrdinary: median(overheadFor(afterRun, ordinaryKinds)),
        afterTimeoutLeads: overheadFor(afterRun, ['timeout']).map((ms) => Number(ms.toFixed(1))),
        afterFullRewrite600Lines: Number(afterRun.overheadMs.get(33)!.toFixed(1)),
        beforeFullRewrite600Lines: Number(beforeRun.overheadMs.get(33)!.toFixed(1)),
        afterAdversarialDeadlineText: Number(afterRun.overheadMs.get(34)!.toFixed(1)),
        beforeAdversarialDeadlineText: Number(beforeRun.overheadMs.get(34)!.toFixed(1)),
        afterMarkupBomb20000Elements: Number(afterRun.overheadMs.get(37)!.toFixed(1)),
        beforeMarkupBomb20000Elements: Number(beforeRun.overheadMs.get(37)!.toFixed(1)),
        markupBudget: engineModule.POSTING_MARKUP_BUDGET,
        productionDeadlineMs: engineModule.POSTING_VERIFY_TIMEOUT_MS,
      },
      perLead: rows.map(({ entry, row }) => ({
        lead: entry.n,
        source: entry.source,
        kind: entry.kind,
        truth: entry.truth,
        result: row?.result ?? null,
        reason: row?.reason ?? null,
        changeKind: row?.changeSummary?.kind ?? null,
        physicalRequests: perLeadPhysical(entry),
        reachedPreparationBefore: beforeRun.reached.includes(entry.n),
        reachedPreparationAfter: afterRun.reached.includes(entry.n),
      })),
      limits: [
        'Fixture network answers instantly and the labels are written by the fixture author; no real posting, human label, closure rate, latency or quality is measured or implied.',
        'A closed posting hidden behind a login wall, a denial or an unsupported source is NOT detected: it is reported "could not check" and preparation proceeds (leads 19 and 20 here).',
        'Only Greenhouse, Lever, Workable and Jobgether links have an authoritative single-posting route; every other source costs no request and is "could not check".',
        'Closure is taken only from 404/410, Workable /oops, or a payload that is nothing but an unqualified closure notice; closure-like prose inside an open posting is open (leads 21-26).',
        'Requirement detection is a token/section heuristic; a requirement change worded without any requirement signal, outside a requirements section, and under a fifth of the posting is not flagged.',
        'Physical counts are the real client\'s network fetches (each redirect hop counts); the per-lead count attributes requests by URL prefix.',
      ],
    };

    // The headline guarantees, asserted rather than only written down.
    expect(beforeRun.reached).toHaveLength(LEADS.length);
    expect(measurement.before.closedLeadsReachingPreparation).toBe(5);
    expect(falseClosure).toEqual([]);
    expect(trueClosuresDetected).toEqual([9, 10, 11]);
    expect(closedReachedAfter).toEqual([19, 20]);
    expect(missedChangeStops).toEqual([]);
    expect(falseChangeStops).toEqual([]);
    expect(measurement.after.employerCopyEditsReachingPreparation).toBe(EMPLOYER_EDITS.length);
    expect(perLeadPhysical(LEADS.find((entry) => entry.kind === 'redirect_loop')!)).toBe(engineModule.POSTING_REQUEST_ENVELOPE.standard.physical);
    expect(perLeadPhysical(LEADS.find((entry) => entry.kind === 'workable_short_link')!)).toBeLessThanOrEqual(
      engineModule.POSTING_REQUEST_ENVELOPE.workableShortLink.physical,
    );
    expect(measurement.after.requests.maxPhysicalForOneLead).toBeLessThanOrEqual(engineModule.POSTING_REQUEST_ENVELOPE.workableShortLink.physical);
    expect(physicalOnReuse).toBe(0);
    expect(rows.find(({ entry }) => entry.kind === 'login_wall')?.row?.reason).toBe('login_wall');
    expect(rows.find(({ entry }) => entry.kind === 'markup_bomb')?.row?.reason).toBe('content_too_large');
    expect(rows.find(({ entry }) => entry.kind === 'workable_short_link')?.row?.result).toBe('confirmed_open');
    expect(perLeadPhysical(leadOf('workable_short_link'))).toBe(3); // short link 301 + account shell + detail route
    expect(perLeadPhysical(leadOf('login_wall'))).toBe(2);
    expect(measurement.inProcessCostMs.afterFullRewrite600Lines).toBeLessThan(2_000);
    expect(measurement.inProcessCostMs.afterAdversarialDeadlineText).toBeLessThan(2_000);
    expect(measurement.inProcessCostMs.afterMarkupBomb20000Elements).toBeLessThan(2_000);

    const target = process.env.OVR_687_MEASUREMENT_PATH;
    if (target) writeFileSync(target, `${JSON.stringify(measurement, null, 2)}\n`);
  }, 120_000);
});


// ============================================================================ #689 company evidence

describe('#689 company evidence in preparation', () => {
  const ABOUT_URL = 'https://northwind.example/about';
  const QUOTE = 'Northwind Freight operates 14 depots across the Netherlands and Belgium';
  const CLAIM = 'Northwind Freight operates 14 depots across the Netherlands and Belgium.';
  const NOW = new Date('2026-09-11T12:00:00.000Z');

  /** One public page behind the same seam the safe HTTP client implements; counts every request. */
  function evidenceWeb() {
    const calls: string[] = [];
    const client: AtsHttpClient = {
      get: async (url) => {
        calls.push(url);
        if (url !== ABOUT_URL) throw new Error('unexpected fetch');
        return { status: 200, finalUrl: url, headers: {}, body: `<html><body><p>${QUOTE}. Founded in 2009.</p></body></html>` };
      },
      postJson: async () => {
        throw new Error('never used');
      },
    };
    return { calls, client };
  }

  function evidenceDeps(web: ReturnType<typeof evidenceWeb>, extra: Partial<evidenceService.CompanyEvidenceDeps> = {}): evidenceService.CompanyEvidenceDeps {
    return { db, now: () => NOW, getHttp: async () => web.client, ...extra };
  }

  async function startConfirmedAttempt(web: ReturnType<typeof evidenceWeb>): Promise<{ attemptId: string; ev: evidenceService.CompanyEvidenceDeps }> {
    const started = await pipeline.startApplicationAttempt(deps, { vacancy: VACANCY });
    if (!started.ok || !started.attemptId) throw new Error('start refused');
    const ev = evidenceDeps(web);
    // The fixture apply URL carries no employer identity, so the person confirms the employer's own site.
    expect(evidenceService.confirmDomain(ev, { attemptId: started.attemptId }, { domain: 'northwind.example' }).ok).toBe(true);
    return { attemptId: started.attemptId, ev };
  }

  function coverLetterHtml(): string | undefined {
    return loadedHtml.find((html) => html.includes('Dear Northwind Freight hiring team'));
  }

  it('writes a supported, sourced company claim into the prepared letter and snapshots what it used; leads stay out', async () => {
    const web = evidenceWeb();
    const { attemptId, ev } = await startConfirmedAttempt(web);
    const added = await evidenceService.addFact(ev, { attemptId }, { claim: CLAIM, sourceUrl: ABOUT_URL, quote: QUOTE, scope: 'company', topic: 'general' });
    expect(added.ok && added.stats?.requests).toBe(1);
    await evidenceService.addFact(ev, { attemptId }, { claim: 'LEAD-UNCHECKED Northwind Freight is about to be sold.', sourceUrl: 'https://rumours.example/n', quote: '', scope: 'company', topic: 'other' });

    const prompts: string[] = [];
    generateCoverLetter.mockImplementation(async (prompt: string) => {
      prompts.push(prompt);
      return { ok: true, text: '{"factIds":["summary","experience-1","company-1"]}' };
    });
    const withEvidence: ApplicationPipelineDeps = { ...deps, loadCompanyEvidence: (attempt) => evidenceService.proseEvidence(ev, { attemptId: attempt.id }, 'letter') };
    queueApplicationDocumentRenders();
    const ticked = await pipeline.runNextApplicationAttempt(withEvidence);
    expect(ticked.result?.outcome).toBe('ready');

    // The drafting stage received the checked claim as an offered fact, and never the lead.
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain('company-1');
    expect(prompts[0]).toContain(CLAIM);
    expect(prompts[0]).not.toContain('LEAD-UNCHECKED');
    // It made no network request of its own: the only request ever made was the person's own source check.
    expect(web.calls).toEqual([ABOUT_URL]);

    const html = coverLetterHtml();
    expect(html).toContain(`Something I noted about Northwind Freight from public sources: ${CLAIM}`);
    expect(html).not.toContain('LEAD-UNCHECKED');

    const uses = evidenceStore.listEvidenceUses(db, attemptId);
    expect(uses).toMatchObject([{ claim: CLAIM, sourceUrl: ABOUT_URL, scope: 'company', verification: 'source_confirmed' }]);
    expect(evidenceService.getView(ev, { attemptId }).lettersUsed).toHaveLength(1);
    // The CV tailoring session never saw any company evidence.
    expect(generateTailoredResume.mock.calls[0]?.[0]).not.toContain(CLAIM);
  });

  it('prepares exactly as before when there is no evidence, or when reading it fails', async () => {
    const baseline: string[] = [];
    generateCoverLetter.mockImplementation(async (prompt: string) => {
      baseline.push(prompt);
      return { ok: true, text: '{"factIds":["summary","experience-1"]}' };
    });
    const first = await pipeline.startApplicationAttempt(deps, { vacancy: VACANCY });
    queueApplicationDocumentRenders();
    expect((await pipeline.runNextApplicationAttempt(deps)).result?.outcome).toBe('ready');
    expect(baseline[0]).not.toContain('company-');
    expect(evidenceStore.listEvidenceUses(db, first.attemptId!)).toEqual([]);

    // A throwing evidence reader is logged and skipped; it never blocks a letter that does not need it.
    const log = vi.fn();
    workspace.deleteApplicationAttempt(db, first.attemptId!);
    const broken: ApplicationPipelineDeps = {
      ...deps,
      log,
      loadCompanyEvidence: () => {
        throw new Error('store unavailable');
      },
    };
    await pipeline.startApplicationAttempt(broken, { vacancy: VACANCY });
    queueApplicationDocumentRenders();
    expect((await pipeline.runNextApplicationAttempt(broken)).result?.outcome).toBe('ready');
    expect(baseline[1]).toBe(baseline[0]);
    expect(log).toHaveBeenCalledWith(expect.stringContaining('company evidence unavailable'), expect.anything());
  });

  it('leaves a prepared attempt, its documents and its letter untouched when research fails, is cancelled, or the evidence is deleted', async () => {
    const web = evidenceWeb();
    const { attemptId, ev } = await startConfirmedAttempt(web);
    await evidenceService.addFact(ev, { attemptId }, { claim: CLAIM, sourceUrl: ABOUT_URL, quote: QUOTE, scope: 'company', topic: 'general' });
    generateCoverLetter.mockResolvedValue({ ok: true, text: '{"factIds":["summary","company-1"]}' });
    const withEvidence: ApplicationPipelineDeps = { ...deps, loadCompanyEvidence: (attempt) => evidenceService.proseEvidence(ev, { attemptId: attempt.id }, 'letter') };
    queueApplicationDocumentRenders();
    expect((await pipeline.runNextApplicationAttempt(withEvidence)).result?.outcome).toBe('ready');

    const snapshot = () =>
      JSON.stringify({
        attempt: workspace.getApplicationAttempt(db, attemptId),
        artifacts: workspace.listApplicationArtifacts(db, attemptId),
        uses: evidenceStore.listEvidenceUses(db, attemptId),
      });
    const prepared = snapshot();
    const runs = new evidenceService.CompanyEvidenceRuns();

    // Research that throws, is refused by the provider, or is cancelled mid-run.
    const failing = evidenceDeps(web, { runResearch: async () => ({ status: 'failed', reason: 'session_failed', candidates: [], queries: [], searches: 0, fetches: 0 }) });
    expect((await evidenceService.researchCompany(failing, { attemptId }, { topics: ['size'] }, runs)).ok).toBe(true);
    const cancelling = evidenceDeps(web, {
      runResearch: async (_input, signal) => {
        runs.cancelAll();
        expect(signal.aborted).toBe(true);
        return { status: 'cancelled', reason: 'cancelled_by_user', candidates: [], queries: [], searches: 1, fetches: 0 };
      },
    });
    expect((await evidenceService.researchCompany(cancelling, { attemptId }, { topics: ['size'] }, runs)).ok).toBe(true);
    const throwing = evidenceDeps(web, {
      runResearch: async () => {
        throw new Error('daemon exploded');
      },
    });
    // A research runner that throws is a failed run, never an unhandled rejection.
    expect((await evidenceService.researchCompany(throwing, { attemptId }, { topics: ['size'] }, runs)).ok).toBe(true);
    expect(runs.active).toBe(0);
    expect(snapshot()).toBe(prepared);

    // Correcting then deleting the evidence afterwards changes nothing that was prepared.
    const factId = evidenceService.getView(ev, { attemptId }).facts[0]!.id;
    await evidenceService.correctFact(ev, { attemptId }, factId, 'Northwind Freight operates 99 depots.');
    expect(evidenceService.deleteRecordFor(ev, { attemptId }).ok).toBe(true);
    expect(snapshot()).toBe(prepared);
    expect(evidenceService.getView(ev, { attemptId }).facts).toEqual([]);
    expect(evidenceService.getView(ev, { attemptId }).lettersUsed[0]?.claim).toBe(CLAIM);
  });

  /**
   * Fix round 1 (P5): the drafting session can run for a while. Whatever happens to the selected
   * evidence WHILE it runs must keep that claim out of the rendered letter and out of the "used"
   * snapshot, without failing the letter and without substituting a different fact.
   */
  describe('evidence that changes while the letter is being drafted', () => {
    const OTHER_URL = 'https://news.example/northwind';
    const LINKED_URL = 'https://northwind-freight-group.example/about';
    const LINKED_QUOTE = 'Northwind Freight Group runs a dispatch centre in Rotterdam for its fleet';

    function raceWeb() {
      const pages = new Map<string, string>([
        [ABOUT_URL, `${QUOTE}. Founded in 2009.`],
        [OTHER_URL, 'Northwind Freight operates 20 depots across the Netherlands and Belgium'],
        [LINKED_URL, LINKED_QUOTE],
      ]);
      const calls: string[] = [];
      const client: AtsHttpClient = {
        get: async (url) => {
          calls.push(url);
          const page = pages.get(url);
          if (page === undefined) throw new Error('unexpected fetch');
          return { status: 200, finalUrl: url, headers: {}, body: `<html><body><p>${page}.</p></body></html>` };
        },
        postJson: async () => {
          throw new Error('never used');
        },
      };
      return { calls, client };
    }

    type Mutation = (ctx: { ev: evidenceService.CompanyEvidenceDeps; attemptId: string; factId: string; advance: (ms: number) => void }) => Promise<void> | void;
    const mutations: [string, Mutation][] = [
      ['withdrawn', ({ ev, attemptId, factId }) => void evidenceService.withdrawFact(ev, { attemptId }, factId)],
      ['corrected', async ({ ev, attemptId, factId }) => void (await evidenceService.correctFact(ev, { attemptId }, factId, 'Northwind Freight operates 99 depots.'))],
      ['expired', ({ advance }) => advance(91 * 24 * 60 * 60 * 1000)],
      [
        'newly contradicted',
        async ({ ev, attemptId }) =>
          void (await evidenceService.addFact(ev, { attemptId }, {
            claim: 'Northwind Freight operates 20 depots across the Netherlands and Belgium.',
            sourceUrl: OTHER_URL,
            quote: 'Northwind Freight operates 20 depots across the Netherlands and Belgium',
            scope: 'company',
            topic: 'size',
          })),
      ],
      ['record deleted', ({ ev, attemptId }) => void evidenceService.deleteRecordFor(ev, { attemptId })],
    ];

    it.each(mutations)('a fact %s during drafting is not rendered and not snapshotted', async (_name, mutate) => {
      const web = raceWeb();
      let clockNow = NOW;
      const started = await pipeline.startApplicationAttempt(deps, { vacancy: VACANCY });
      const attemptId = started.attemptId!;
      const ev: evidenceService.CompanyEvidenceDeps = { db, now: () => clockNow, getHttp: async () => web.client };
      expect(evidenceService.confirmDomain(ev, { attemptId }, { domain: 'northwind.example' }).ok).toBe(true);
      await evidenceService.addFact(ev, { attemptId }, { claim: CLAIM, sourceUrl: ABOUT_URL, quote: QUOTE, scope: 'company', topic: 'size' });
      const factId = evidenceService.getView(ev, { attemptId }).facts[0]!.id;
      expect(evidenceService.proseEvidence(ev, { attemptId }, 'letter').map((fact) => fact.claim)).toEqual([CLAIM]);

      generateCoverLetter.mockImplementation(async () => {
        await mutate({ ev, attemptId, factId, advance: (ms) => (clockNow = new Date(clockNow.getTime() + ms)) });
        return { ok: true, text: '{"factIds":["summary","experience-1","company-1"]}' };
      });
      const withEvidence: ApplicationPipelineDeps = { ...deps, loadCompanyEvidence: (row) => evidenceService.proseEvidence(ev, { attemptId: row.id }, 'letter') };
      queueApplicationDocumentRenders();
      expect((await pipeline.runNextApplicationAttempt(withEvidence)).result?.outcome).toBe('ready');

      const html = coverLetterHtml();
      expect(html).toBeDefined();
      expect(html).not.toContain('Something I noted about');
      expect(html).not.toContain('depots');
      expect(evidenceStore.listEvidenceUses(db, attemptId)).toEqual([]);
    });

    it('a fact that arrived over an identity link that is revoked during drafting is not rendered or snapshotted', async () => {
      const web = raceWeb();
      const started = await pipeline.startApplicationAttempt(deps, { vacancy: VACANCY });
      const attemptId = started.attemptId!;
      const ev: evidenceService.CompanyEvidenceDeps = { db, now: () => NOW, getHttp: async () => web.client };
      expect(evidenceService.confirmDomain(ev, { attemptId }, { domain: 'northwind.example' }).ok).toBe(true);
      const { identityFromConfirmedDomain } = await import('../electron/company-evidence.js');
      const group = evidenceStore.ensureRecord(db, identityFromConfirmedDomain('Northwind Freight Group', 'northwind-freight-group.example')!, NOW).record;
      const inserted = evidenceStore.insertFact(
        db,
        {
          recordId: group.id,
          scope: 'company',
          roleKey: '',
          roleLabel: '',
          topic: 'general',
          claim: 'Northwind Freight Group runs a dispatch centre in Rotterdam.',
          sourceUrl: LINKED_URL,
          sourceKind: 'company_site',
          quote: LINKED_QUOTE,
          verification: 'unverified',
          origin: 'user',
          retrievedAt: null,
          observedAt: NOW,
          contentHash: null,
        },
        NOW,
      );
      if (!inserted || 'refused' in inserted) throw new Error('not inserted');
      evidenceStore.confirmFactFromFetch(
        db,
        inserted.id,
        { retrievedAt: NOW, contentHash: null, claim: 'Northwind Freight Group runs a dispatch centre in Rotterdam.', quote: LINKED_QUOTE, employerNames: ['Northwind Freight Group'] },
        NOW,
      );
      const link = evidenceService.getView(ev, { attemptId }).links[0]!;
      expect(evidenceService.decideLink(ev, { attemptId }, link.id, 'confirmed').ok).toBe(true);
      expect(evidenceService.proseEvidence(ev, { attemptId }, 'letter').map((fact) => fact.viaLink)).toEqual(['Northwind Freight Group']);

      generateCoverLetter.mockImplementation(async () => {
        evidenceService.decideLink(ev, { attemptId }, link.id, 'rejected');
        return { ok: true, text: '{"factIds":["summary","experience-1","company-1"]}' };
      });
      const withEvidence: ApplicationPipelineDeps = { ...deps, loadCompanyEvidence: (row) => evidenceService.proseEvidence(ev, { attemptId: row.id }, 'letter') };
      queueApplicationDocumentRenders();
      expect((await pipeline.runNextApplicationAttempt(withEvidence)).result?.outcome).toBe('ready');
      expect(coverLetterHtml()).not.toContain('dispatch centre');
      expect(evidenceStore.listEvidenceUses(db, attemptId)).toEqual([]);
    });

    it('an unrelated change during drafting keeps the selected, still-approved fact (no false drop, no substitution)', async () => {
      const web = raceWeb();
      const started = await pipeline.startApplicationAttempt(deps, { vacancy: VACANCY });
      const attemptId = started.attemptId!;
      const ev: evidenceService.CompanyEvidenceDeps = { db, now: () => NOW, getHttp: async () => web.client };
      evidenceService.confirmDomain(ev, { attemptId }, { domain: 'northwind.example' });
      await evidenceService.addFact(ev, { attemptId }, { claim: CLAIM, sourceUrl: ABOUT_URL, quote: QUOTE, scope: 'company', topic: 'general' });
      generateCoverLetter.mockImplementation(async () => {
        // A NEW approved fact appears first in the list while drafting: company-1 must still mean CLAIM.
        await evidenceService.addFact(ev, { attemptId }, {
          claim: 'Northwind Freight operates 20 depots across the Netherlands and Belgium.',
          sourceUrl: OTHER_URL,
          quote: 'Northwind Freight operates 20 depots across the Netherlands and Belgium',
          scope: 'company',
          topic: 'general',
        });
        return { ok: true, text: '{"factIds":["summary","experience-1","company-1"]}' };
      });
      const withEvidence: ApplicationPipelineDeps = { ...deps, loadCompanyEvidence: (row) => evidenceService.proseEvidence(ev, { attemptId: row.id }, 'letter') };
      queueApplicationDocumentRenders();
      expect((await pipeline.runNextApplicationAttempt(withEvidence)).result?.outcome).toBe('ready');
      const html = coverLetterHtml();
      expect(html).toContain(`Something I noted about Northwind Freight from public sources: ${CLAIM}`);
      expect(html).not.toContain('20 depots');
      expect(evidenceStore.listEvidenceUses(db, attemptId).map((use) => use.claim)).toEqual([CLAIM]);
    });
  });
});
