// @vitest-environment node
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import { jsPDF } from 'jspdf';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { exportCvCase, type CvCaseExportDeps } from '../electron/cv-case-export-handler.js';
import { renderApprovedSnapshot } from '../electron/cv-case-export.js';
import { resumeClaims } from '../electron/resume-claims.js';
import type { TailoredResume } from '../electron/resume-schema.js';
import { createWorkspaceDb, type WorkspaceDb } from '../electron/workspace/client.js';
import { cvArtifactStatus } from '../electron/workspace/cv-artifact-status.js';
import { CV_RENDER_CONTRACT_VERSION, type CvArtifactFormat } from '../electron/workspace/cv-evidence-schema.js';
import { EMPTY_CV_SOURCE, stableCvSourceJson, type CvSourceDocument } from '../electron/workspace/cv-source-schema.js';
import * as workspace from '../electron/workspace/repository.js';
import { cvDocuments, cvEvidenceOverlays } from '../electron/workspace/schema.js';
import { makeFact, makeVariant } from './fixtures/cv-evidence.js';
import { FULL_JD } from './fixtures/job-description.js';

/**
 * The export handler's decisions (#419 step 9, #435) against a real migrated database, with the
 * save dialog, the disk, the PDF printer and the window faked. Real repository functions decide
 * readiness and record artifacts, and the real renderers and validators check the files, so a
 * passing test means the same chain `main.ts` wires up behaves this way.
 */
let dir: string;
let db: WorkspaceDb;
let close: () => void;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ovr-export-handler-'));
  ({ db, close } = createWorkspaceDb(dir));
});

afterEach(() => {
  close();
  rmSync(dir, { recursive: true, force: true });
});

const SOURCE: CvSourceDocument = {
  ...EMPTY_CV_SOURCE,
  contact: { ...EMPTY_CV_SOURCE.contact, name: 'Jamie Rivera' },
  summary: 'Frontend engineer.',
  experience: [
    { id: 'experience-1', company: 'Redwood Software', title: 'Frontend Engineer', dates: '2021 - Present', engagement: 'employment', client: '', bullets: ['Built things.'] },
  ],
  projects: [],
  maxProjects: 2,
};

const hashOf = (source: CvSourceDocument) => createHash('sha256').update(stableCvSourceJson(source)).digest('hex');
const sha256 = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const read = (id: string) => workspace.getCvEvidenceOverlayById(db, id);

function approvedCase() {
  const cv = workspace.createCvDocument(db, {
    name: 'Jamie Resume',
    kind: 'manual',
    profile: { title: '', years: '', location: '', languages: '', skills: ['TypeScript'], summary: '', auth: '' },
    source: SOURCE,
  });
  const created = workspace.createCvEvidenceOverlay(db, {
    cvId: cv.id,
    vacancyKey: 'url:https://jobs.example.invalid/1',
    sourceCvContentHash: hashOf(workspace.getCvDocument(db, cv.id).source!),
    jdSnapshot: FULL_JD,
    jdSnapshotHash: 'b'.repeat(64),
  });
  workspace.updateCvEvidenceOverlay(db, created.id, {
    facts: [makeFact({ factId: 'fact-1', parentId: 'experience-1', activity: 'Built the booking screens', mechanism: 'Angular' })],
    requirementCoverage: { status: 'complete', batches: 1 },
  });
  workspace.updateCvEvidenceOverlay(db, created.id, {
    wordingVariants: [
      makeVariant({ variantId: 'v-1', targetField: 'experience_bullet', parentId: 'experience-1', factIds: ['fact-1'], text: 'Built the booking screens, using Angular', approvedAt: '', sourceRevision: '' }),
    ],
  });
  const approved = workspace.approveCvEvidenceOverlay(db, created.id, read(created.id).caseRevision);
  return { cv, overlay: approved };
}

/** Prints every approved claim of the snapshot into a real, extractable PDF. */
function printerFor(resume: () => TailoredResume | null, extra: string[] = []): (html: string) => Promise<Buffer> {
  return async () => {
    const source = resume();
    const lines = [...(source ? resumeClaims(source).map((claim) => claim.text) : []), ...extra].filter(Boolean);
    const doc = new jsPDF({ unit: 'pt', format: 'a4' });
    let y = 50;
    for (const line of lines) {
      doc.text(line, 50, y);
      y += 20;
    }
    return Buffer.from(doc.output('arraybuffer'));
  };
}

interface Harness {
  deps: CvCaseExportDeps;
  dialog: ReturnType<typeof vi.fn>;
  writes: { path: string; bytes: Buffer }[];
  render: ReturnType<typeof vi.fn>;
}

function harness(
  overlayId: string,
  options: { filePath?: string; canceled?: boolean; window?: boolean; printer?: (html: string) => Promise<Buffer> } = {},
): Harness {
  const writes: { path: string; bytes: Buffer }[] = [];
  const printer = options.printer ?? printerFor(() => read(overlayId).approvedResumeSnapshot?.resume ?? null);
  const render = vi.fn((resume: TailoredResume, format: CvArtifactFormat) => renderApprovedSnapshot(resume, format, printer));
  const dialog = vi.fn(async () => ({ canceled: options.canceled ?? false, filePath: options.canceled ? undefined : (options.filePath ?? join(dir, 'out.file')) }));
  const deps: CvCaseExportDeps = {
    checkReadiness: (id) => workspace.checkCvCaseExportReadiness(db, id),
    hasWindow: () => options.window ?? true,
    render,
    defaultFileBaseName: (overlay) => workspace.getCvDocument(db, overlay.cvId).name,
    showSaveDialog: dialog,
    writeFile: async (path, bytes) => {
      writes.push({ path, bytes });
    },
    recordArtifact: async (id, record) => workspace.recordCvArtifact(db, id, record),
  };
  return { deps, dialog, writes, render };
}

describe('exportCvCase: a pass', () => {
  it.each<CvArtifactFormat>(['docx', 'pdf'])('writes the %s once and records the sha256 of the bytes it wrote', async (format) => {
    const { overlay } = approvedCase();
    const h = harness(overlay.id, { filePath: join(dir, `cv.${format}`) });

    const result = await exportCvCase(h.deps, overlay.id, format);

    expect(h.writes).toHaveLength(1);
    expect(h.writes[0]?.path).toBe(join(dir, `cv.${format}`));
    expect(result).toMatchObject({ saved: true, path: join(dir, `cv.${format}`) });
    expect(result.artifact).toMatchObject({
      format,
      savedPath: join(dir, `cv.${format}`),
      contentHash: sha256(h.writes[0]!.bytes),
      snapshotDigest: overlay.approvedResumeSnapshot?.digest,
      renderContractVersion: CV_RENDER_CONTRACT_VERSION,
      validation: { ok: true },
      reviewOpenedAt: '',
      confirmedAt: '',
    });
    expect(read(overlay.id).artifacts).toHaveLength(1);
    expect(cvArtifactStatus(read(overlay.id), format)).toBe('awaiting_review');
  });

  it('offers the CV name and the right file filter in the save dialog', async () => {
    const { overlay } = approvedCase();
    const h = harness(overlay.id);
    await exportCvCase(h.deps, overlay.id, 'docx');
    expect(h.dialog).toHaveBeenCalledWith({
      title: 'Export approved CV',
      defaultPath: 'Jamie Resume.docx',
      filters: [{ name: 'Word document', extensions: ['docx'] }],
    });
  });
});

describe('exportCvCase: a cancelled save dialog', () => {
  it('writes nothing and changes no state', async () => {
    const { overlay } = approvedCase();
    const before = read(overlay.id);
    const h = harness(overlay.id, { canceled: true });

    const result = await exportCvCase(h.deps, overlay.id, 'docx');

    expect(result).toEqual({ saved: false, artifact: null, overlay: before });
    expect(h.dialog).toHaveBeenCalledTimes(1);
    expect(h.writes).toEqual([]);
    expect(read(overlay.id)).toEqual(before);
    expect(read(overlay.id).artifacts).toEqual([]);
  });

  it('treats a dialog that returns no path like a cancel', async () => {
    const { overlay } = approvedCase();
    const h = harness(overlay.id);
    h.dialog.mockResolvedValueOnce({ canceled: false, filePath: '' });
    const result = await exportCvCase(h.deps, overlay.id, 'docx');
    expect(result.saved).toBe(false);
    expect(result.artifact).toBeNull();
    expect(h.writes).toEqual([]);
    expect(read(overlay.id).artifacts).toEqual([]);
  });

  it('shows no dialog and renders nothing when there is no window', async () => {
    const { overlay } = approvedCase();
    const h = harness(overlay.id, { window: false });
    const result = await exportCvCase(h.deps, overlay.id, 'pdf');
    expect(result.saved).toBe(false);
    expect(h.render).not.toHaveBeenCalled();
    expect(h.dialog).not.toHaveBeenCalled();
    expect(h.writes).toEqual([]);
  });
});

describe('exportCvCase: a file that fails validation', () => {
  it('is recorded as failed and never reaches the save dialog or the disk', async () => {
    const { overlay } = approvedCase();
    const h = harness(overlay.id, { printer: printerFor(() => null, ['Someone Else Entirely']) });

    const result = await exportCvCase(h.deps, overlay.id, 'pdf');

    expect(result.saved).toBe(false);
    expect(result.path).toBeUndefined();
    expect(result.artifact?.validation.ok).toBe(false);
    expect(result.artifact?.validation.reasons.length).toBeGreaterThan(0);
    expect(result.artifact?.savedPath).toBe('');
    expect(h.dialog).not.toHaveBeenCalled();
    expect(h.writes).toEqual([]);
    expect(read(overlay.id).artifacts).toHaveLength(1);
    expect(cvArtifactStatus(read(overlay.id), 'pdf')).toBe('qa_failed');
    expect(cvArtifactStatus(read(overlay.id), 'docx')).toBe('not_exported');
  });

  it('can be exported again after the failure, and the later good file replaces the failed status', async () => {
    const { overlay } = approvedCase();
    const failing = harness(overlay.id, { printer: printerFor(() => null, ['Someone Else Entirely']) });
    await exportCvCase(failing.deps, overlay.id, 'pdf');

    const retry = harness(overlay.id, { filePath: join(dir, 'retry.pdf') });
    const result = await exportCvCase(retry.deps, overlay.id, 'pdf');

    expect(result.saved).toBe(true);
    expect(retry.writes).toHaveLength(1);
    expect(read(overlay.id).artifacts).toHaveLength(2);
    expect(cvArtifactStatus(read(overlay.id), 'pdf')).toBe('awaiting_review');
    expect(read(overlay.id).state).toBe('candidate_approved');
  });
});

describe('exportCvCase: readiness blockers refuse before any render', () => {
  async function expectRefused(overlayId: string, reason: RegExp) {
    const h = harness(overlayId);
    await expect(exportCvCase(h.deps, overlayId, 'pdf')).rejects.toThrow(reason);
    expect(h.render).not.toHaveBeenCalled();
    expect(h.dialog).not.toHaveBeenCalled();
    expect(h.writes).toEqual([]);
    expect(read(overlayId).artifacts).toEqual([]);
  }

  it('a snapshot whose content no longer matches its digest', async () => {
    const { overlay } = approvedCase();
    const snapshot = overlay.approvedResumeSnapshot!;
    db.update(cvEvidenceOverlays)
      .set({ approvedResumeSnapshot: { ...snapshot, resume: { ...snapshot.resume, summary: 'Forged summary.' } } })
      .where(eq(cvEvidenceOverlays.id, overlay.id))
      .run();
    await expectRefused(overlay.id, /cannot be exported yet.*does not match its own digest/);
  });

  it('a snapshot approved under an older render contract', async () => {
    const { overlay } = approvedCase();
    const snapshot = overlay.approvedResumeSnapshot!;
    db.update(cvEvidenceOverlays)
      .set({ approvedResumeSnapshot: { ...snapshot, renderContractVersion: CV_RENDER_CONTRACT_VERSION - 1 } })
      .where(eq(cvEvidenceOverlays.id, overlay.id))
      .run();
    await expectRefused(overlay.id, /approved before the current document format/);
  });

  it('a job description found cut off after approval', async () => {
    const { overlay } = approvedCase();
    db.update(cvEvidenceOverlays).set({ jdIncompleteReasons: ['truncated_at_source'] }).where(eq(cvEvidenceOverlays.id, overlay.id)).run();
    await expectRefused(overlay.id, /job description is cut off/);
  });

  it('a source that is no longer complete', async () => {
    const { cv, overlay } = approvedCase();
    const current = workspace.getCvDocument(db, cv.id).source!;
    db.update(cvDocuments)
      .set({ sourceCv: { ...current, complete: false, incompleteReason: 'the last page was never read' } })
      .where(eq(cvDocuments.id, cv.id))
      .run();
    await expectRefused(overlay.id, /only partly read/);
  });

  it('a source that is no longer reviewed', async () => {
    const { cv, overlay } = approvedCase();
    const current = workspace.getCvDocument(db, cv.id).source!;
    db.update(cvDocuments).set({ sourceCv: { ...current, reviewedAt: '' } }).where(eq(cvDocuments.id, cv.id)).run();
    await expectRefused(overlay.id, /have not been checked yet/);
  });

  it('a case that is not approved', async () => {
    const { overlay } = approvedCase();
    workspace.updateCvEvidenceOverlay(db, overlay.id, { requirementCoverage: { status: 'partial', batches: 1 } });
    await expectRefused(overlay.id, /not approved/);
  });
});

describe('exportCvCase: a render exception', () => {
  it('is recoverable: nothing is recorded, saved or approved, and a retry works', async () => {
    const { overlay } = approvedCase();
    const before = read(overlay.id);
    const broken = harness(overlay.id, {
      printer: async () => {
        throw new Error('the print window crashed');
      },
    });

    await expect(exportCvCase(broken.deps, overlay.id, 'pdf')).rejects.toThrow('the print window crashed');
    expect(broken.dialog).not.toHaveBeenCalled();
    expect(broken.writes).toEqual([]);
    expect(read(overlay.id)).toEqual(before);

    const retry = harness(overlay.id, { filePath: join(dir, 'retry.pdf') });
    const result = await exportCvCase(retry.deps, overlay.id, 'pdf');
    expect(result.saved).toBe(true);
    expect(retry.writes).toHaveLength(1);
    expect(read(overlay.id).artifacts).toHaveLength(1);
  });
});
