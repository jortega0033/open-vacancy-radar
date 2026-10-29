// @vitest-environment node
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * #691 at the real boundaries: a real migrated SQLite workspace, packages prepared by the REAL pipeline
 * (so drafts and artifacts are exactly what preparation records, over real PDF bytes on disk), the real
 * submission recording paths (`recordUserReportedSubmission`, the receipt + checkpoint writes the submit
 * path makes), and the real `interview-context:*` IPC handlers over the real service. Stood in for:
 * Chromium's printToPDF (a text PDF renderer) and the drafting model (scripted, synthetic replies).
 * Nothing here reaches a network or a model.
 */

vi.mock('electron', async () => {
  const { htmlToPdf } = await import('./application-critique-fixtures.js');
  return {
    BrowserWindow: class {
      #html = '';
      webContents = { printToPDF: async (): Promise<Buffer> => Buffer.from(htmlToPdf(this.#html)) };
      async loadURL(url: string): Promise<void> {
        this.#html = decodeURIComponent(url.replace(/^data:text\/html;charset=utf-8,/u, ''));
      }
      destroy(): void {}
    },
  };
});
vi.mock('../electron/application-view.js', () => ({ createApplicationView: vi.fn() }));

vi.setConfig({ testTimeout: 30_000 });

const { createWorkspaceDb } = await import('../electron/workspace/client.js');
const workspace = await import('../electron/workspace/repository.js');
const pipeline = await import('../electron/application-pipeline.js');
const review = await import('../electron/application-review-session.js');
const { summarisePreparedFields } = await import('../electron/application-value-table.js');
const { stagedArtifactFileName } = await import('../electron/application-artifact-naming.js');
const packages = await import('../electron/workspace/submission-package-store.js');
const schema = await import('../electron/workspace/schema.js');
const { createInterviewContextHandlers } = await import('../electron/interview-context-ipc.js');
const { ApplicationDataResetGate } = await import('../electron/application-data-reset-gate.js');
const fx = await import('./application-critique-fixtures.js');
import type { FieldMap, FormSnapshot } from '@agent-dock/application-executor';
import type { WorkspaceDb } from '../electron/workspace/client.js';
import type { InterviewContextResult, InterviewContextView, InterviewPackageView } from '../electron/interview-context-types.js';

let dir: string;
let db: WorkspaceDb;
let closeDb: () => void;
let cvId: string;
let handlers: ReturnType<typeof createInterviewContextHandlers>;
const gate = new ApplicationDataResetGate();
const sha = (text: string): string => createHash('sha256').update(text).digest('hex');

const ROLE_A_BULLETS = [fx.SOURCE.experience[0]!.bullets[0]!, fx.SOURCE.experience[0]!.bullets[1]!];
const ROLE_B_BULLETS = [fx.SOURCE.experience[0]!.bullets[2]!];

function open(): void {
  ({ db, close: closeDb } = createWorkspaceDb(dir));
  handlers = createInterviewContextHandlers(async () => ({ db, now: () => new Date(), mutate: (task) => gate.runMutation(task) }));
}

async function call(channel: string, input: unknown): Promise<InterviewContextResult> {
  // Through a JSON round trip, as IPC structured cloning would.
  return JSON.parse(JSON.stringify(await handlers[channel]!(JSON.parse(JSON.stringify(input))))) as InterviewContextResult;
}

async function viewOf(applicationId: string): Promise<InterviewContextView> {
  const result = await call('interview-context:get', { applicationId });
  if (!result.ok) throw new Error(`get failed: ${result.code}`);
  return result.view;
}

interface PrepareOptions {
  vacancyKey?: string;
  url?: string;
  company?: string;
  bullets?: string[];
  userLetter?: boolean;
  reapply?: { supersedesAttemptId: string; reason: string };
}

/** One package through the real pipeline; returns the attempt id. */
async function prepare(options: PrepareOptions = {}): Promise<string> {
  const vacancyKey = options.vacancyKey ?? 'vac-1';
  if (options.userLetter) {
    workspace.createLetter(db, {
      title: fx.USER_LETTER_TITLE,
      company: options.company ?? fx.COMPANY,
      role: fx.ROLE,
      type: 'cover_letter',
      tone: 'formal',
      length: 'standard',
      status: 'final',
      vacancyKey,
      cvId,
      body: fx.USER_LETTER_BODY,
    });
  }
  const cv = workspace.getCvDocument(db, cvId);
  const attempt = workspace.createApplicationAttempt(db, {
    vacancyKey,
    canonicalUrl: options.url ?? fx.APPLY_URL,
    company: options.company ?? fx.COMPANY,
    role: fx.ROLE,
    sourceCvId: cvId,
    sourceCvContentHash: sha(cv.text),
    jdSnapshot: fx.JD,
    jdSnapshotHash: sha(fx.JD),
    jdComplete: true,
    workflowVersion: pipeline.APPLICATION_PIPELINE_WORKFLOW_VERSION,
    checkpoint: 'queued',
    ...(options.reapply ? { reapply: options.reapply } : {}),
  });
  const result = await pipeline.runApplicationAttempt(
    {
      db,
      storageRoot: join(dir, 'artifacts'),
      queue: { enqueue: async () => undefined, acquireLease: async () => null, release: async () => undefined, entryState: async () => 'active' },
      generateFieldMap: async () => {
        throw new Error('no form here');
      },
      generateTailoredResume: async () => ({ ok: true, text: fx.tailoredResumeReply({ bullets: options.bullets ?? ROLE_A_BULLETS }) }),
      generateCoverLetter: async () => ({ ok: true, text: fx.LETTER_SELECTION_REPLY }),
      loadProfile: async () => null,
      now: () => new Date(),
    },
    attempt.id,
  );
  expect(result.outcome).toBe('needs_user');
  return attempt.id;
}

const appOf = (attemptId: string): string => workspace.getApplicationAttempt(db, attemptId).applicationId!;
const artifactsOf = (attemptId: string) => workspace.listApplicationArtifacts(db, attemptId);
const pkgOf = (view: InterviewContextView, attemptId: string): InterviewPackageView =>
  view.packages.find((pkg) => pkg.attemptId === attemptId)!;
const docOf = (pkg: InterviewPackageView, slot: 'cv' | 'letter') => pkg.documents.find((doc) => doc.slot === slot)!;

/**
 * What the form fill records for the files it attached. Not hand-seeded: the committed file field is
 * produced by the real `summarisePreparedFields` from attachments shaped exactly as the review session's
 * `applyApplicationFieldMap` returns them -- `attachedFileName` is what the page reported after the
 * upload, which the session only accepts when it contains `basename(localFilePath)`, i.e. the STAGED
 * name `<contentHash>-<fileName>` of the real file the pipeline wrote. `report` decides what the page
 * said (the bare staged name, or behind `C:\fakepath\` or a directory).
 */
type Reported = (stagedName: string) => string;
const asReported: Reported = (name) => name;
const behindFakepath: Reported = (name) => `C:\\fakepath\\${name}`;
const behindPosixDir: Reported = (name) => `/var/tmp/uploads/${name}`;

function recordFormFillAttachments(
  attemptId: string,
  files: ReadonlyArray<{ artifact: { id: string; fileName: string; storagePath: string | null }; report?: Reported }>,
): string[] {
  const reported = files.map(({ artifact, report }) => (report ?? asReported)(basename(artifact.storagePath!)));
  const summary = summarisePreparedFields({
    snapshot: {
      fields: files.map((_, index) => ({ fieldRef: `file-${index}`, label: 'Resume', controlType: 'file', required: true })),
    } as unknown as FormSnapshot,
    fieldMap: { assignments: [] } as unknown as FieldMap,
    valueTable: [],
    uploadFieldRefs: files.map((_, index) => `file-${index}`),
    optionFieldRefs: [],
    attachments: files.map(({ artifact }, index) => ({ fieldRef: `file-${index}`, fileName: artifact.fileName, attachedFileName: reported[index]! })),
    company: fx.COMPANY,
    role: fx.ROLE,
    preparedAt: new Date().toISOString(),
  });
  workspace.recordPreparedApplicationFields(db, attemptId, summary.prepared);
  return reported;
}

/** Exactly the writes the submit path makes once the page observer reports a receipt. */
function recordObservedReceipt(attemptId: string): void {
  workspace.createApplicationSubmissionReceipt(db, {
    attemptId,
    outcome: 'submitted',
    source: 'page_observation',
    destination: fx.APPLY_URL,
    evidenceKind: 'confirmation_page',
    evidenceReference: 'Thank you for applying',
    detail: 'a confirmation page appeared',
    observedAt: '2026-08-01T10:00:00.000Z',
  });
  workspace.updateApplicationAttempt(db, attemptId, {
    checkpoint: 'submitted',
    submittedAt: '2026-08-01T10:00:00.000Z',
    submissionMode: 'manual',
    completionEvidence: 'receipt_confirmed',
  });
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ovr-interview-context-'));
  open();
  cvId = workspace.createCvDocument(db, {
    name: 'Main CV',
    kind: 'manual',
    text: 'Jamie Rivera, Senior Engineer at Redwood Software.',
    profile: { title: 'Senior Engineer', location: 'Amsterdam', skills: fx.PROFILE_SKILLS, summary: fx.SOURCE.summary, years: '8', languages: 'English' },
    source: fx.SOURCE,
    isDefault: true,
  }).id;
});

afterEach(() => {
  closeDb();
  rmSync(dir, { recursive: true, force: true });
});

describe('binding a manifest when a submission is recorded', () => {
  it('"I applied" binds what this app prepared, as prepared, with the version, hashes and evidence type', async () => {
    const attemptId = await prepare();
    expect(packages.listPackageVersions(db, packages.attemptSubject(attemptId))).toEqual([]);
    expect(review.recordUserReportedSubmission(db, attemptId, '', '2026-08-01T09:00:00.000Z')).toEqual({ ok: true });

    const versions = packages.listPackageVersions(db, packages.attemptSubject(attemptId));
    expect(versions).toHaveLength(1);
    const manifest = versions[0]!.manifest;
    expect(versions[0]).toMatchObject({ version: 1, boundBy: 'submission', status: 'current' });
    expect(manifest.submission).toMatchObject({ evidence: 'user_reported', receiptKind: 'user_statement', recordedAt: '2026-08-01T09:00:00.000Z' });
    expect(manifest.requisition).toMatchObject({ company: fx.COMPANY, role: fx.ROLE, canonicalUrlKey: expect.stringContaining('jobs.example') });
    expect(manifest.posting).toEqual({ jdHash: sha(fx.JD), jdComplete: true });
    expect(manifest.candidate).toMatchObject({ sourceCvId: cvId, sourceCvHash: sha('Jamie Rivera, Senior Engineer at Redwood Software.'), reviewedEvidenceFrom: 'submission' });
    expect(manifest.candidate.reviewedEvidenceHash).toMatch(/^[0-9a-f]{64}$/u);
    const files = artifactsOf(attemptId);
    expect(manifest.documents.map((doc) => [doc.slot, doc.provenance, doc.source, doc.draftVersion])).toEqual([
      ['cv', 'prepared', 'draft', 1],
      ['letter', 'prepared', 'draft', 1],
    ]);
    for (const doc of manifest.documents) expect(files.map((file) => file.contentHash)).toContain(doc.artifactHash);

    // A later write to the same checkpoint does not bind again.
    workspace.updateApplicationAttempt(db, attemptId, { checkpointDetail: 'still applied' });
    expect(packages.listPackageVersions(db, packages.attemptSubject(attemptId))).toHaveLength(1);
  });

  it('an observed receipt backs only the file this app recorded attaching, and never overwrites by a statement', async () => {
    const attemptId = await prepare();
    const cvFile = artifactsOf(attemptId).find((file) => file.kind === 'cv_pdf')!;
    // Production shape: the value the form fill committed is the STAGED name, not the logical file name.
    const [reportedName] = recordFormFillAttachments(attemptId, [{ artifact: cvFile }]);
    expect(reportedName).toBe(stagedArtifactFileName(cvFile.contentHash, cvFile.fileName));
    expect(reportedName).not.toBe(cvFile.fileName);
    recordObservedReceipt(attemptId);

    const view = await viewOf(appOf(attemptId));
    const pkg = pkgOf(view, attemptId);
    expect(pkg).toMatchObject({ kind: 'recorded', version: 1, submission: { evidence: 'receipt', receiptKind: 'confirmation_page' } });
    expect(docOf(pkg, 'cv')).toMatchObject({ provenance: 'receipt_backed', textState: 'available', fileState: 'present' });
    // The letter was prepared but nothing records attaching it: it stays prepared.
    expect(docOf(pkg, 'letter')).toMatchObject({ provenance: 'prepared' });

    const refused = await call('interview-context:state-documents', {
      applicationId: view.applicationId,
      packageId: pkg.id,
      expectedVersion: 1,
      statements: [{ slot: 'cv', choice: 'unknown' }],
    });
    expect(refused).toMatchObject({ ok: false, code: 'receipt_backed' });
    expect(packages.listPackageVersions(db, pkg.id)).toHaveLength(1);

    const confirmed = await call('interview-context:state-documents', {
      applicationId: view.applicationId,
      packageId: pkg.id,
      expectedVersion: 1,
      statements: [{ slot: 'letter', choice: 'prepared_file' }],
    });
    expect(confirmed.ok).toBe(true);
    const next = pkgOf((confirmed as { view: InterviewContextView }).view, attemptId);
    expect(next.version).toBe(2);
    expect(docOf(next, 'letter')).toMatchObject({ provenance: 'user_confirmed', version: 1, contentHash: docOf(pkg, 'letter').contentHash });
    expect(docOf(next, 'cv').provenance).toBe('receipt_backed');
    const versions = packages.listPackageVersions(db, pkg.id);
    expect(versions.map((row) => [row.version, row.status, row.boundBy])).toEqual([
      [1, 'superseded', 'submission'],
      [2, 'current', 'person'],
    ]);
    // The receipt itself is untouched.
    expect(workspace.listApplicationSubmissionReceipts(db, attemptId)).toHaveLength(1);
  });

  it('a receipt with no record of any attachment backs no document', async () => {
    const attemptId = await prepare();
    recordObservedReceipt(attemptId);
    const pkg = pkgOf(await viewOf(appOf(attemptId)), attemptId);
    expect(pkg.submission.evidence).toBe('receipt');
    expect(pkg.documents.map((doc) => doc.provenance)).toEqual(['prepared', 'prepared']);
  });

  it.each([
    ['behind a Windows C:\\fakepath\\ prefix', behindFakepath],
    ['behind a posix directory', behindPosixDir],
  ])('backs the file when the page reported the staged name %s', async (_label, report) => {
    const attemptId = await prepare();
    const cvFile = artifactsOf(attemptId).find((file) => file.kind === 'cv_pdf')!;
    const [reported] = recordFormFillAttachments(attemptId, [{ artifact: cvFile, report }]);
    expect(reported).not.toBe(basename(cvFile.storagePath!));
    recordObservedReceipt(attemptId);
    const pkg = pkgOf(await viewOf(appOf(attemptId)), attemptId);
    expect(docOf(pkg, 'cv').provenance).toBe('receipt_backed');
    expect(docOf(pkg, 'letter').provenance).toBe('prepared');
  });

  it('backs the CV and the letter independently when both staged files were attached', async () => {
    const attemptId = await prepare();
    const files = artifactsOf(attemptId);
    recordFormFillAttachments(attemptId, [
      { artifact: files.find((file) => file.kind === 'cv_pdf')! },
      { artifact: files.find((file) => file.kind === 'cover_letter_pdf')!, report: behindFakepath },
    ]);
    recordObservedReceipt(attemptId);
    const pkg = pkgOf(await viewOf(appOf(attemptId)), attemptId);
    expect(pkg.documents.map((doc) => doc.provenance)).toEqual(['receipt_backed', 'receipt_backed']);
  });

  it('does not back a document by the bare logical file name alone', async () => {
    const attemptId = await prepare();
    const cvFile = artifactsOf(attemptId).find((file) => file.kind === 'cv_pdf')!;
    recordFormFillAttachments(attemptId, [{ artifact: cvFile, report: () => cvFile.fileName }]);
    recordObservedReceipt(attemptId);
    expect(docOf(pkgOf(await viewOf(appOf(attemptId)), attemptId), 'cv').provenance).toBe('prepared');
  });

  it("does not back this CV with another artifact's staged name, nor with the right name under a wrong hash", async () => {
    const attemptId = await prepare();
    const otherAttemptId = await prepare({ vacancyKey: 'vac-other', url: `${fx.APPLY_URL}-other`, bullets: ROLE_B_BULLETS });
    const cvFile = artifactsOf(attemptId).find((file) => file.kind === 'cv_pdf')!;
    const otherCv = artifactsOf(otherAttemptId).find((file) => file.kind === 'cv_pdf')!;
    expect(otherCv.fileName).toBe(cvFile.fileName);
    expect(otherCv.contentHash).not.toBe(cvFile.contentHash);

    // The page reported a different attempt's file of the same logical name, behind a fakepath too.
    recordFormFillAttachments(attemptId, [{ artifact: cvFile, report: () => behindFakepath(basename(otherCv.storagePath!)) }]);
    recordObservedReceipt(attemptId);
    expect(docOf(pkgOf(await viewOf(appOf(attemptId)), attemptId), 'cv').provenance).toBe('prepared');
    // The other attempt, never submitted, gains nothing from this one's receipt.
    expect(pkgOf(await viewOf(appOf(otherAttemptId)), otherAttemptId).kind).toBe('prepared');
  });

  it('does not back this CV when the staged name carries a hash that is not its own', async () => {
    const attemptId = await prepare();
    const cvFile = artifactsOf(attemptId).find((file) => file.kind === 'cv_pdf')!;
    recordFormFillAttachments(attemptId, [{ artifact: cvFile, report: () => stagedArtifactFileName('f'.repeat(64), cvFile.fileName) }]);
    recordObservedReceipt(attemptId);
    expect(docOf(pkgOf(await viewOf(appOf(attemptId)), attemptId), 'cv').provenance).toBe('prepared');
  });

  it('never promotes a prepared file from an "I applied" statement, however it was attached', async () => {
    const attemptId = await prepare();
    const cvFile = artifactsOf(attemptId).find((file) => file.kind === 'cv_pdf')!;
    recordFormFillAttachments(attemptId, [{ artifact: cvFile }]);
    expect(review.recordUserReportedSubmission(db, attemptId)).toEqual({ ok: true });
    const pkg = pkgOf(await viewOf(appOf(attemptId)), attemptId);
    expect(pkg.submission.evidence).toBe('user_reported');
    expect(pkg.documents.map((doc) => doc.provenance)).toEqual(['prepared', 'prepared']);
  });

  it('a delayed receipt (reconcileSubmissionOutcome) backs the attached staged file, and only then', async () => {
    const attemptId = await prepare();
    const cvFile = artifactsOf(attemptId).find((file) => file.kind === 'cv_pdf')!;
    recordFormFillAttachments(attemptId, [{ artifact: cvFile, report: behindFakepath }]);
    // The click landed but nothing was observed: no submission is recorded, so no package is bound.
    workspace.updateApplicationAttempt(db, attemptId, { checkpoint: 'submission_unknown', submittedAt: '2026-08-01T10:00:00.000Z' });
    expect(packages.listPackageVersions(db, packages.attemptSubject(attemptId))).toEqual([]);

    const body = JSON.stringify({ confirmationNumber: 'FIXTURE-9001' });
    expect(review.reconcileSubmissionOutcome(db, attemptId, { status: 202, body }, '2026-08-01T11:00:00.000Z')).toEqual({ ok: true });
    const [bound] = packages.listPackageVersions(db, packages.attemptSubject(attemptId));
    expect(bound!.manifest.submission.evidence).toBe('receipt');
    expect(bound!.manifest.documents.map((doc) => [doc.slot, doc.provenance])).toEqual([
      ['cv', 'receipt_backed'],
      ['letter', 'prepared'],
    ]);
    const pkg = pkgOf(await viewOf(appOf(attemptId)), attemptId);
    expect(docOf(pkg, 'cv')).toMatchObject({ provenance: 'receipt_backed', fileState: 'present' });
  });
});

describe('the historical basis does not follow the library', () => {
  it('editing, replacing and deleting the library CV and letter after applying leaves the sent documents exactly as they were', async () => {
    const attemptId = await prepare({ userLetter: true });
    review.recordUserReportedSubmission(db, attemptId);
    const applicationId = appOf(attemptId);
    const before = pkgOf(await viewOf(applicationId), attemptId);
    expect(docOf(before, 'cv').text).toContain('Built TypeScript services handling 2 million requests per day.');
    expect(docOf(before, 'letter').text).toContain('I led a team of 40 engineers');

    const letterId = workspace.listLetters(db)[0]!.id;
    workspace.updateApplication(db, applicationId, { letterId });
    workspace.updateCvDocument(db, cvId, { text: 'Jamie Rivera. Rewritten CV mentioning Rust and Go.' });
    workspace.updateLetter(db, letterId, { body: 'A completely different letter.' });
    const replacement = workspace.createCvDocument(db, { name: 'New CV', kind: 'manual', text: 'Replacement CV text', isDefault: true });
    workspace.setDefaultCvDocument(db, replacement.id);
    workspace.deleteLetter(db, letterId);
    workspace.deleteCvDocument(db, cvId);

    const after = pkgOf(await viewOf(applicationId), attemptId);
    expect(after.documents).toEqual(before.documents);
    expect(after.manifestHash).toBe(before.manifestHash);
    expect(docOf(after, 'cv').text).not.toContain('Rust');
    expect(docOf(after, 'letter').text).not.toContain('completely different');
  });
});

describe('each application resolves its own package', () => {
  it('two roles at one employer never see each other, and nothing is chosen by company name', async () => {
    const a = await prepare({ vacancyKey: 'vac-a', url: `${fx.APPLY_URL}-a`, bullets: ROLE_A_BULLETS });
    const b = await prepare({ vacancyKey: 'vac-b', url: `${fx.APPLY_URL}-b`, bullets: ROLE_B_BULLETS });
    review.recordUserReportedSubmission(db, a);
    review.recordUserReportedSubmission(db, b);
    expect(appOf(a)).not.toBe(appOf(b));

    const viewA = await viewOf(appOf(a));
    const viewB = await viewOf(appOf(b));
    expect(viewA.packages.map((pkg) => pkg.attemptId)).toEqual([a]);
    expect(viewB.packages.map((pkg) => pkg.attemptId)).toEqual([b]);
    expect(viewA.defaultPackageId).toBe(packages.attemptSubject(a));
    expect(docOf(pkgOf(viewA, a), 'cv').text).toContain('2 million requests');
    expect(docOf(pkgOf(viewA, a), 'cv').text).not.toContain('Mentored four junior engineers');
    expect(docOf(pkgOf(viewB, b), 'cv').text).toContain('Mentored four junior engineers');
    expect(docOf(pkgOf(viewB, b), 'cv').text).not.toContain('2 million requests');

    // A statement naming the other application's package is refused, not applied across rows.
    const crossed = await call('interview-context:state-documents', {
      applicationId: appOf(a),
      packageId: packages.attemptSubject(b),
      expectedVersion: 1,
      statements: [{ slot: 'cv', choice: 'unknown' }],
    });
    expect(crossed).toMatchObject({ ok: false, code: 'not_found' });
    expect(packages.listPackageVersions(db, packages.attemptSubject(b))).toHaveLength(1);
  });

  it('a reapplication gets its own row and package; when one row holds both, the newer one in the chain is the default', async () => {
    const first = await prepare({ bullets: ROLE_A_BULLETS });
    review.recordUserReportedSubmission(db, first);
    const second = await prepare({ bullets: ROLE_B_BULLETS, reapply: { supersedesAttemptId: first, reason: 'corrected CV' } });
    review.recordUserReportedSubmission(db, second);
    expect(appOf(second)).not.toBe(appOf(first));
    expect((await viewOf(appOf(first))).packages.map((pkg) => pkg.attemptId)).toEqual([first]);
    const own = await viewOf(appOf(second));
    expect(own.packages.map((pkg) => pkg.attemptId)).toEqual([second]);
    expect(docOf(pkgOf(own, second), 'cv').text).toContain('Mentored four junior engineers');

    // Both on one row (an older install linked them): the reapplication is the head of the chain.
    db.update(schema.applicationAttempts).set({ applicationId: appOf(first) }).where(eq(schema.applicationAttempts.id, second)).run();
    const shared = await viewOf(appOf(first));
    expect(shared.selection).toBe('chain');
    expect(shared.defaultPackageId).toBe(packages.attemptSubject(second));
  });

  it('two unrelated sent packages on one row are never guessed between', async () => {
    const a = await prepare({ vacancyKey: 'vac-a', url: `${fx.APPLY_URL}-a` });
    const b = await prepare({ vacancyKey: 'vac-b', url: `${fx.APPLY_URL}-b`, bullets: ROLE_B_BULLETS });
    review.recordUserReportedSubmission(db, a);
    review.recordUserReportedSubmission(db, b);
    db.update(schema.applicationAttempts).set({ applicationId: appOf(a) }).where(eq(schema.applicationAttempts.id, b)).run();
    const view = await viewOf(appOf(a));
    expect(view.packages).toHaveLength(2);
    expect(view).toMatchObject({ selection: 'choose', defaultPackageId: null });
  });
});

describe('every provenance state stays distinct', () => {
  it('prepared, confirmed, supplied, linked copy and unknown are recorded as separate versions with honest sources', async () => {
    const attemptId = await prepare();
    const applicationId = appOf(attemptId);
    // Not recorded as sent: a prepared view, not persisted.
    let view = await viewOf(applicationId);
    expect(view).toMatchObject({ selection: 'prepared' });
    expect(pkgOf(view, attemptId)).toMatchObject({ kind: 'prepared', version: null, submission: { evidence: 'none' } });

    review.recordUserReportedSubmission(db, attemptId);
    view = await viewOf(applicationId);
    const pkg = pkgOf(view, attemptId);
    expect(pkg.documents.map((doc) => doc.provenance)).toEqual(['prepared', 'prepared']);

    const supplied = await call('interview-context:state-documents', {
      applicationId,
      packageId: pkg.id,
      expectedVersion: 1,
      statements: [
        { slot: 'cv', choice: 'supplied_text', text: 'The CV text I actually sent, with a synthetic line about Kubernetes.' },
        { slot: 'letter', choice: 'unknown' },
      ],
    });
    expect(supplied.ok).toBe(true);
    let next = pkgOf((supplied as { view: InterviewContextView }).view, attemptId);
    expect(docOf(next, 'cv')).toMatchObject({ provenance: 'user_confirmed', source: 'person_text', textState: 'available', text: 'The CV text I actually sent, with a synthetic line about Kubernetes.' });
    expect(docOf(next, 'letter')).toMatchObject({ provenance: 'unknown', source: 'none', text: null, textState: 'not_stored' });

    // A stale version is refused and nothing is appended.
    const stale = await call('interview-context:state-documents', {
      applicationId,
      packageId: pkg.id,
      expectedVersion: 1,
      statements: [{ slot: 'cv', choice: 'prepared_file' }],
    });
    expect(stale).toMatchObject({ ok: false, code: 'outdated' });

    // Back to "the file this app prepared": the original draft, even after the person said otherwise.
    const back = await call('interview-context:state-documents', {
      applicationId,
      packageId: pkg.id,
      expectedVersion: 2,
      statements: [{ slot: 'cv', choice: 'prepared_file' }, { slot: 'letter', choice: 'prepared_file' }],
    });
    next = pkgOf((back as { view: InterviewContextView }).view, attemptId);
    expect(docOf(next, 'cv')).toMatchObject({ provenance: 'user_confirmed', source: 'draft', version: 1, contentHash: docOf(pkg, 'cv').contentHash });
    expect(packages.listPackageVersions(db, pkg.id).map((row) => row.version)).toEqual([1, 2, 3]);

    // "My linked CV as it reads now" copies the library text at that moment; later edits do not follow.
    const linked = await call('interview-context:state-documents', {
      applicationId,
      packageId: pkg.id,
      expectedVersion: 3,
      statements: [{ slot: 'cv', choice: 'linked_document' }],
    });
    next = pkgOf((linked as { view: InterviewContextView }).view, attemptId);
    expect(docOf(next, 'cv')).toMatchObject({ source: 'linked_copy', text: 'Jamie Rivera, Senior Engineer at Redwood Software.' });
    workspace.updateCvDocument(db, cvId, { text: 'Edited afterwards' });
    expect(docOf(pkgOf(await viewOf(applicationId), attemptId), 'cv').text).toBe('Jamie Rivera, Senior Engineer at Redwood Software.');
  });

  it('a person statement made before sending is carried into the manifest the submission binds', async () => {
    const attemptId = await prepare();
    const applicationId = appOf(attemptId);
    const first = await call('interview-context:state-documents', {
      applicationId,
      packageId: packages.attemptSubject(attemptId),
      expectedVersion: null,
      statements: [{ slot: 'letter', choice: 'unknown' }],
    });
    expect(first.ok).toBe(true);
    review.recordUserReportedSubmission(db, attemptId);
    const pkg = pkgOf(await viewOf(applicationId), attemptId);
    expect(pkg).toMatchObject({ kind: 'recorded', version: 2, submission: { evidence: 'user_reported' } });
    expect(docOf(pkg, 'letter').provenance).toBe('unknown');
    expect(docOf(pkg, 'cv').provenance).toBe('prepared');
  });
});

describe('legacy and hand-tracked applications', () => {
  it('a submission recorded before manifests existed is shown as earlier, with what this app still holds', async () => {
    const attemptId = await prepare();
    review.recordUserReportedSubmission(db, attemptId);
    db.delete(schema.applicationSubmissionPackages).run();
    const view = await viewOf(appOf(attemptId));
    const pkg = pkgOf(view, attemptId);
    expect(pkg).toMatchObject({ kind: 'legacy', version: null, submission: { evidence: 'user_reported' } });
    expect(view.defaultPackageId).toBe(pkg.id);
    expect(docOf(pkg, 'cv')).toMatchObject({ provenance: 'prepared', textState: 'available' });

    // Older still: no drafts at all. The file's fingerprint is known, its text is not; nothing is decoded.
    db.delete(schema.applicationDocumentDrafts).run();
    const older = pkgOf(await viewOf(appOf(attemptId)), attemptId);
    expect(docOf(older, 'cv')).toMatchObject({ source: 'artifact_only', text: null, textState: 'not_stored', fileState: 'present' });
  });

  it('a row tracked by hand has no basis until the person states one, then keeps it through library changes', async () => {
    const row = workspace.createApplication(db, { role: 'Data Engineer', company: 'Fabrikam', status: 'interview', cvId });
    let view = await viewOf(row.id);
    expect(view).toMatchObject({ selection: 'none', defaultPackageId: `application:${row.id}` });
    expect(view.packages).toHaveLength(1);
    expect(view.packages[0]).toMatchObject({ kind: 'row', version: null, documents: [], heldSlots: [] });

    const nothingPrepared = await call('interview-context:state-documents', {
      applicationId: row.id,
      packageId: view.packages[0]!.id,
      expectedVersion: null,
      statements: [{ slot: 'cv', choice: 'prepared_file' }],
    });
    expect(nothingPrepared).toMatchObject({ ok: false, code: 'nothing_prepared' });
    const noLetter = await call('interview-context:state-documents', {
      applicationId: row.id,
      packageId: view.packages[0]!.id,
      expectedVersion: null,
      statements: [{ slot: 'letter', choice: 'linked_document' }],
    });
    expect(noLetter).toMatchObject({ ok: false, code: 'no_linked_document' });

    const stated = await call('interview-context:state-documents', {
      applicationId: row.id,
      packageId: view.packages[0]!.id,
      expectedVersion: null,
      statements: [{ slot: 'cv', choice: 'linked_document' }],
    });
    expect(stated.ok).toBe(true);
    workspace.updateCvDocument(db, cvId, { text: 'Changed later' });
    view = await viewOf(row.id);
    expect(view).toMatchObject({ selection: 'single', defaultPackageId: `application:${row.id}` });
    expect(docOf(view.packages[0]!, 'cv')).toMatchObject({ provenance: 'user_confirmed', source: 'linked_copy', text: 'Jamie Rivera, Senior Engineer at Redwood Software.' });
    expect(view.packages[0]!.submission.evidence).toBe('none');
  });
});

describe('stale files, changed records and missing data', () => {
  it('reports a missing or changed file and a changed stored text explicitly, and never substitutes another text', async () => {
    const attemptId = await prepare();
    review.recordUserReportedSubmission(db, attemptId);
    const applicationId = appOf(attemptId);
    const files = artifactsOf(attemptId);
    unlinkSync(files.find((file) => file.kind === 'cv_pdf')!.storagePath);
    writeFileSync(files.find((file) => file.kind === 'cover_letter_pdf')!.storagePath, 'different bytes');

    let pkg = pkgOf(await viewOf(applicationId), attemptId);
    expect(docOf(pkg, 'cv')).toMatchObject({ fileState: 'missing', textState: 'available' });
    expect(docOf(pkg, 'letter')).toMatchObject({ fileState: 'changed', textState: 'available' });

    // A draft row altered behind the store's back no longer matches the manifest hash: no text.
    const cvDraft = docOf(pkg, 'cv');
    const row = db.select().from(schema.applicationDocumentDrafts).where(eq(schema.applicationDocumentDrafts.contentHash, cvDraft.contentHash!)).get()!;
    db.update(schema.applicationDocumentDrafts)
      .set({ content: { ...(row.content as object), basis: 'revision' } as never })
      .where(eq(schema.applicationDocumentDrafts.id, row.id))
      .run();
    // An artifact row removed: the file is reported missing; the recorded hash stays in the manifest.
    workspace.deleteApplicationArtifact(db, files.find((file) => file.kind === 'cover_letter_pdf')!.id);
    pkg = pkgOf(await viewOf(applicationId), attemptId);
    expect(docOf(pkg, 'cv')).toMatchObject({ textState: 'changed', text: null });
    expect(docOf(pkg, 'letter')).toMatchObject({ fileState: 'missing', artifactHash: files.find((file) => file.kind === 'cover_letter_pdf')!.contentHash });
  });

  it('refuses malformed and partial input without writing anything', async () => {
    const attemptId = await prepare();
    review.recordUserReportedSubmission(db, attemptId);
    const applicationId = appOf(attemptId);
    const base = { applicationId, packageId: packages.attemptSubject(attemptId), expectedVersion: 1 };
    const bad: unknown[] = [
      { ...base, statements: [] },
      { ...base, statements: [{ slot: 'cv', choice: 'unknown' }, { slot: 'cv', choice: 'unknown' }] },
      { ...base, statements: [{ slot: 'cv', choice: 'promote' }] },
      { ...base, statements: [{ slot: 'cv', choice: 'unknown', draftId: 'x' }] },
      { ...base, statements: [{ slot: 'cv', choice: 'supplied_text', text: 'x'.repeat(60_001) }] },
      { ...base, extra: true, statements: [{ slot: 'cv', choice: 'unknown' }] },
    ];
    for (const input of bad) expect(await call('interview-context:state-documents', input)).toMatchObject({ ok: false, code: 'invalid_request' });
    expect(await call('interview-context:state-documents', { ...base, statements: [{ slot: 'cv', choice: 'supplied_text', text: '   ' }] })).toMatchObject({
      ok: false,
      code: 'text_required',
    });
    expect(await call('interview-context:get', { applicationId: 'missing' })).toMatchObject({ ok: false, code: 'not_found' });
    expect(packages.listPackageVersions(db, base.packageId)).toHaveLength(1);
  });
});

describe('interview rounds', () => {
  const round = (over: Record<string, unknown> = {}) => ({
    roundType: 'technical',
    scheduledOn: '2026-08-10',
    state: 'held',
    feedback: 'They asked a lot about Kubernetes upgrades. I could not answer the question on node draining.',
    openTopics: ['node draining', 'on-call rota'],
    ...over,
  });

  it('records, edits and deletes rounds without touching the status, notes, CV or the sent documents', async () => {
    const attemptId = await prepare();
    review.recordUserReportedSubmission(db, attemptId);
    const applicationId = appOf(attemptId);
    workspace.updateApplication(db, applicationId, { status: 'interview', notes: 'Free notes stay free.' });
    const cvBefore = workspace.getCvDocument(db, cvId);
    const manifestBefore = packages.listPackageVersions(db, packages.attemptSubject(attemptId));

    const created = await call('interview-context:save-round', { applicationId, roundId: null, expectedUpdatedAt: null, round: round() });
    expect(created.ok).toBe(true);
    const planned = await call('interview-context:save-round', {
      applicationId,
      roundId: null,
      expectedUpdatedAt: null,
      round: round({ roundType: 'final', scheduledOn: null, state: 'planned', feedback: '', openTopics: [] }),
    });
    const view = (planned as { view: InterviewContextView }).view;
    expect(view.rounds.map((r) => [r.roundType, r.scheduledOn, r.state])).toEqual([
      ['technical', '2026-08-10', 'held'],
      ['final', null, 'planned'],
    ]);

    const held = view.rounds[0]!;
    const edited = await call('interview-context:save-round', {
      applicationId,
      roundId: held.id,
      expectedUpdatedAt: held.updatedAt,
      round: round({ openTopics: ['node draining'] }),
    });
    expect((edited as { view: InterviewContextView }).view.rounds[0]!.openTopics).toEqual(['node draining']);
    // Saving from the form that was open before the edit is refused.
    expect(
      await call('interview-context:save-round', { applicationId, roundId: held.id, expectedUpdatedAt: held.updatedAt, round: round() }),
    ).toMatchObject({ ok: false, code: 'outdated' });

    const app = workspace.listApplications(db).find((row) => row.id === applicationId)!;
    expect(app).toMatchObject({ status: 'interview', notes: 'Free notes stay free.' });
    expect(workspace.getCvDocument(db, cvId)).toEqual(cvBefore);
    expect(packages.listPackageVersions(db, packages.attemptSubject(attemptId))).toEqual(manifestBefore);

    const removed = await call('interview-context:delete-round', { applicationId, roundId: view.rounds[1]!.id });
    expect((removed as { view: InterviewContextView }).view.rounds).toHaveLength(1);
    // A round of another application cannot be reached through this one.
    const other = workspace.createApplication(db, { role: 'Other', company: 'Other', status: 'interview' });
    expect(await call('interview-context:delete-round', { applicationId: other.id, roundId: held.id })).toMatchObject({ ok: false, code: 'not_found' });
  });

  it('rejects invalid rounds and keeps a bounded number', async () => {
    const row = workspace.createApplication(db, { role: 'Data Engineer', company: 'Fabrikam', status: 'interview' });
    const save = (r: unknown) => call('interview-context:save-round', { applicationId: row.id, roundId: null, expectedUpdatedAt: null, round: r });
    for (const r of [
      round({ scheduledOn: '2026-02-30' }),
      round({ scheduledOn: 'next week' }),
      round({ roundType: 'offer' }),
      round({ state: 'passed' }),
      round({ openTopics: ['x'.repeat(301)] }),
      round({ feedback: 'x'.repeat(4001) }),
      { ...round(), outcome: 'advanced' },
    ]) {
      expect(await save(r)).toMatchObject({ ok: false, code: 'invalid_request' });
    }
    for (let i = 0; i < 30; i += 1) expect((await save(round({ feedback: `round ${i}` }))).ok).toBe(true);
    expect(await save(round())).toMatchObject({ ok: false, code: 'limit' });
  });
});

describe('restart, deletion and reset', () => {
  it('survives a restart unchanged', async () => {
    const attemptId = await prepare();
    review.recordUserReportedSubmission(db, attemptId);
    const applicationId = appOf(attemptId);
    await call('interview-context:save-round', {
      applicationId,
      roundId: null,
      expectedUpdatedAt: null,
      round: { roundType: 'recruiter_screen', scheduledOn: '2026-08-05', state: 'held', feedback: 'Salary range discussed.', openTopics: [] },
    });
    const before = await viewOf(applicationId);
    closeDb();
    open();
    expect(await viewOf(applicationId)).toEqual(before);
  });

  it('deleting the row removes its rounds and its own statements; the sent package stays with its application record until that is deleted', async () => {
    const attemptId = await prepare();
    review.recordUserReportedSubmission(db, attemptId);
    const applicationId = appOf(attemptId);
    await call('interview-context:save-round', {
      applicationId,
      roundId: null,
      expectedUpdatedAt: null,
      round: { roundType: 'panel', scheduledOn: null, state: 'planned', feedback: '', openTopics: [] },
    });
    const manual = workspace.createApplication(db, { role: 'Data Engineer', company: 'Fabrikam', status: 'interview' });
    await call('interview-context:state-documents', {
      applicationId: manual.id,
      packageId: `application:${manual.id}`,
      expectedVersion: null,
      statements: [{ slot: 'cv', choice: 'supplied_text', text: 'What I sent' }],
    });

    workspace.deleteApplication(db, applicationId);
    workspace.deleteApplication(db, manual.id);
    expect(db.select().from(schema.applicationInterviewRounds).all()).toEqual([]);
    expect(packages.listPackageVersions(db, `application:${manual.id}`)).toEqual([]);
    expect(packages.listPackageVersions(db, packages.attemptSubject(attemptId))).toHaveLength(1);

    workspace.deleteApplicationAttempt(db, attemptId);
    expect(db.select().from(schema.applicationSubmissionPackages).all()).toEqual([]);
  });

  it('the application data reset counts and removes every manifest and round', async () => {
    const attemptId = await prepare();
    review.recordUserReportedSubmission(db, attemptId);
    await call('interview-context:save-round', {
      applicationId: appOf(attemptId),
      roundId: null,
      expectedUpdatedAt: null,
      round: { roundType: 'panel', scheduledOn: null, state: 'planned', feedback: '', openTopics: [] },
    });
    const result = workspace.resetApplicationData(db);
    expect(result.deleted).toMatchObject({ submissionPackages: 1, interviewRounds: 1 });
    expect(db.select().from(schema.applicationSubmissionPackages).all()).toEqual([]);
    expect(db.select().from(schema.applicationInterviewRounds).all()).toEqual([]);
  });
});
