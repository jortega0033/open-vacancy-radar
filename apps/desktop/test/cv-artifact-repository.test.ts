// @vitest-environment node
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createWorkspaceDb, type WorkspaceDb } from '../electron/workspace/client.js';
import { cvArtifactStatus } from '../electron/workspace/cv-artifact-status.js';
import { CV_RENDER_CONTRACT_VERSION, type CvArtifactFormat } from '../electron/workspace/cv-evidence-schema.js';
import { EMPTY_CV_SOURCE, stableCvSourceJson, type CvSourceDocument } from '../electron/workspace/cv-source-schema.js';
import * as workspace from '../electron/workspace/repository.js';
import { cvDocuments, cvEvidenceOverlays } from '../electron/workspace/schema.js';
import { makeFact, makeVariant } from './fixtures/cv-evidence.js';
import { FULL_JD } from './fixtures/job-description.js';

/**
 * Export and acceptance (#419 step 9) against a real migrated database: what is checked before an
 * approved case may be rendered, how saved files are recorded per format, when a recorded file stops
 * counting, and how a case an earlier version marked exported reads.
 */
let dir: string;
let db: WorkspaceDb;
let close: () => void;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ovr-artifacts-'));
  ({ db, close } = createWorkspaceDb(dir));
});

afterEach(() => {
  close();
  rmSync(dir, { recursive: true, force: true });
});

const SOURCE: CvSourceDocument = {
  ...EMPTY_CV_SOURCE,
  summary: 'Original summary.',
  experience: [
    { id: 'experience-1', company: 'Redwood Software', title: 'Frontend Engineer', dates: '2021 - Present', engagement: 'employment', client: '', bullets: ['Built things.'] },
  ],
  projects: [{ id: 'project-1', name: 'Toolkit', role: '', dates: '', organization: '', description: 'Toolkit text.', technologies: [], links: [], pinned: true }],
  maxProjects: 2,
};

const hashOf = (source: CvSourceDocument) => createHash('sha256').update(stableCvSourceJson(source)).digest('hex');
const read = (id: string) => workspace.getCvEvidenceOverlayById(db, id);

/** Rewrites the stored source behind the repository's back, as a legacy row or a failed extraction
 * would leave it: `createCvDocument` always stamps `reviewedAt`, so an unreviewed source needs this. */
function forceSource(cvId: string, patch: Partial<CvSourceDocument>) {
  const current = workspace.getCvDocument(db, cvId).source!;
  db.update(cvDocuments).set({ sourceCv: { ...current, ...patch } }).where(eq(cvDocuments.id, cvId)).run();
}

/** An approved case with facts, wording and an approved project selection. */
function approvedCase(source: CvSourceDocument = SOURCE) {
  return preparedCase(source, { approve: true }) as { cv: ReturnType<typeof workspace.createCvDocument>; overlay: ReturnType<typeof read> };
}

function preparedCase(source: CvSourceDocument = SOURCE, options: { approve: boolean; sourcePatch?: Partial<CvSourceDocument> } = { approve: true }) {
  const cv = workspace.createCvDocument(db, {
    name: 'Resume',
    kind: 'manual',
    profile: { title: '', years: '', location: '', languages: '', skills: ['TypeScript'], summary: '', auth: '' },
    source,
  });
  if (options.sourcePatch) forceSource(cv.id, options.sourcePatch);
  const overlay = workspace.createCvEvidenceOverlay(db, {
    cvId: cv.id,
    vacancyKey: 'url:https://jobs.example.invalid/1',
    sourceCvContentHash: hashOf(workspace.getCvDocument(db, cv.id).source!),
    jdSnapshot: FULL_JD,
    jdSnapshotHash: 'b'.repeat(64),
  });
  workspace.updateCvEvidenceOverlay(db, overlay.id, {
    facts: [makeFact({ factId: 'fact-1', parentId: 'experience-1', activity: 'Built the booking screens', mechanism: 'Angular' })],
    requirementCoverage: { status: 'complete', batches: 1 },
  });
  workspace.updateCvEvidenceOverlay(db, overlay.id, {
    wordingVariants: [
      makeVariant({ variantId: 'v-1', targetField: 'experience_bullet', parentId: 'experience-1', factIds: ['fact-1'], text: 'Built the booking screens, using Angular', approvedAt: '', sourceRevision: '' }),
    ],
  });
  if (!options.approve) return { cv, overlay: read(overlay.id) };
  if (source.projects.length > 0) workspace.approveCvProjectSelection(db, overlay.id, read(overlay.id).caseRevision);
  const approved = workspace.approveCvEvidenceOverlay(db, overlay.id, read(overlay.id).caseRevision);
  return { cv, overlay: approved };
}

function saveArtifact(id: string, format: CvArtifactFormat, overrides: { ok?: boolean; savedPath?: string; pageCount?: number } = {}) {
  const snapshot = read(id).approvedResumeSnapshot!;
  return workspace.recordCvArtifact(db, id, {
    format,
    contentHash: createHash('sha256').update(`${format}-bytes`).digest('hex'),
    snapshotDigest: snapshot.digest,
    snapshotApprovedAt: snapshot.approvedAt,
    renderContractVersion: snapshot.renderContractVersion,
    validation: { ok: overrides.ok ?? true, reasons: overrides.ok === false ? ['page 1: text is clipped'] : [], ...(format === 'pdf' ? { pageCount: overrides.pageCount ?? 1 } : {}) },
    savedPath: overrides.savedPath ?? (overrides.ok === false ? '' : `C:\\fake\\cv.${format}`),
  });
}

describe('what is checked before an approved case is rendered', () => {
  it('has no blockers for a freshly approved case and returns the stored snapshot', () => {
    const { overlay } = approvedCase();
    const readiness = workspace.checkCvCaseExportReadiness(db, overlay.id);
    expect(readiness.blockers).toEqual([]);
    expect(readiness.snapshot?.digest).toBe(overlay.approvedResumeSnapshot?.digest);
  });

  it('refuses a case that is not approved', () => {
    const { overlay } = approvedCase();
    workspace.updateCvEvidenceOverlay(db, overlay.id, { listingStatus: 'closed' });
    // A listing status change keeps approval; a requirement change drops it.
    workspace.updateCvEvidenceOverlay(db, overlay.id, { requirementCoverage: { status: 'partial', batches: 1 } });
    const readiness = workspace.checkCvCaseExportReadiness(db, overlay.id);
    expect(readiness.snapshot).toBeNull();
    expect(readiness.blockers[0]).toMatch(/not approved/);
  });

  it('refuses a snapshot whose content no longer matches its digest', () => {
    const { overlay } = approvedCase();
    const snapshot = overlay.approvedResumeSnapshot!;
    db.update(cvEvidenceOverlays)
      .set({ approvedResumeSnapshot: { ...snapshot, resume: { ...snapshot.resume, summary: 'Forged summary.' } } })
      .where(eq(cvEvidenceOverlays.id, overlay.id))
      .run();
    expect(workspace.checkCvCaseExportReadiness(db, overlay.id).blockers.join(' ')).toMatch(/does not match its own digest/);
  });

  it('refuses a snapshot approved under an older render contract, with factual approval intact', () => {
    const { overlay } = approvedCase();
    const snapshot = overlay.approvedResumeSnapshot!;
    db.update(cvEvidenceOverlays)
      .set({ approvedResumeSnapshot: { ...snapshot, renderContractVersion: CV_RENDER_CONTRACT_VERSION - 1 } })
      .where(eq(cvEvidenceOverlays.id, overlay.id))
      .run();
    const readiness = workspace.checkCvCaseExportReadiness(db, overlay.id);
    expect(readiness.blockers.join(' ')).toMatch(/approve it again to export it/);
    expect(read(overlay.id).state).toBe('candidate_approved');
    expect(read(overlay.id).facts).toHaveLength(1);
  });

  it('refuses when the stored job description no longer matches its digest', () => {
    const { overlay } = approvedCase();
    db.update(cvEvidenceOverlays).set({ jdSnapshotHash: 'c'.repeat(64) }).where(eq(cvEvidenceOverlays.id, overlay.id)).run();
    expect(workspace.checkCvCaseExportReadiness(db, overlay.id).blockers.join(' ')).toMatch(/job description on record/);
  });

  it('refuses when the source CV changed since approval', () => {
    const { cv, overlay } = approvedCase();
    // Approval is dropped by the change itself; force the approved state back to prove the digest check
    // stands on its own, not only on the state.
    workspace.updateCvDocument(db, cv.id, { source: { ...SOURCE, summary: 'A different summary.' } });
    db.update(cvEvidenceOverlays).set({ state: 'candidate_approved' }).where(eq(cvEvidenceOverlays.id, overlay.id)).run();
    expect(workspace.checkCvCaseExportReadiness(db, overlay.id).blockers.join(' ')).toMatch(/your CV changed/);
  });

  it('refuses when the approved project selection no longer matches the CV', () => {
    const { overlay } = approvedCase();
    db.update(cvEvidenceOverlays)
      .set({ projectSelection: { projectIds: ['project-9'], maxProjects: 2, approvedAt: '2026-10-01T00:00:00.000Z' } })
      .where(eq(cvEvidenceOverlays.id, overlay.id))
      .run();
    expect(workspace.checkCvCaseExportReadiness(db, overlay.id).blockers.join(' ')).toMatch(/projects on this CV changed/);
  });

  it('a case approved before project selection existed stays exportable only when the CV has no projects', () => {
    const noProjects = approvedCase({ ...SOURCE, projects: [] });
    expect(workspace.checkCvCaseExportReadiness(db, noProjects.overlay.id).blockers).toEqual([]);

    const withProjects = approvedCase();
    db.update(cvEvidenceOverlays).set({ projectSelection: null }).where(eq(cvEvidenceOverlays.id, withProjects.overlay.id)).run();
    expect(workspace.checkCvCaseExportReadiness(db, withProjects.overlay.id).blockers.join(' ')).toMatch(/projects on this CV were never approved/);
  });
});

describe('artifact records', () => {
  it('stores format, hash, time, snapshot digest, contract version and the checks for a saved file', () => {
    const { overlay } = approvedCase();
    const after = saveArtifact(overlay.id, 'pdf');
    const [artifact] = after.artifacts;
    expect(artifact).toMatchObject({
      format: 'pdf',
      snapshotDigest: overlay.approvedResumeSnapshot?.digest,
      renderContractVersion: CV_RENDER_CONTRACT_VERSION,
      validation: { ok: true, reasons: [], pageCount: 1 },
      savedPath: 'C:\\fake\\cv.pdf',
      reviewOpenedAt: '',
      pagesViewedAt: '',
      confirmedAt: '',
    });
    expect(artifact?.contentHash).toMatch(/^[0-9a-f]{64}$/);
    expect(artifact?.exportedAt).not.toBe('');
    // Factual approval and the case revision are untouched by a file being saved.
    expect(after.state).toBe('candidate_approved');
    expect(after.caseRevision).toBe(overlay.caseRevision);
  });

  it('keeps status per format: a PDF awaiting review does not say anything about the Word file', () => {
    const { overlay } = approvedCase();
    const after = saveArtifact(overlay.id, 'pdf');
    expect(cvArtifactStatus(after, 'pdf')).toBe('awaiting_review');
    expect(cvArtifactStatus(after, 'docx')).toBe('not_exported');
  });

  it('records a file that failed its checks without a saved path, as failed for that format only', () => {
    const { overlay } = approvedCase();
    const after = saveArtifact(overlay.id, 'docx', { ok: false });
    expect(after.artifacts[0]).toMatchObject({ savedPath: '', validation: { ok: false, reasons: ['page 1: text is clipped'] } });
    expect(cvArtifactStatus(after, 'docx')).toBe('qa_failed');
    expect(cvArtifactStatus(after, 'pdf')).toBe('not_exported');
    // Recoverable: facts are intact, and a later good export replaces the failed status.
    expect(after.facts).toHaveLength(1);
    expect(cvArtifactStatus(saveArtifact(overlay.id, 'docx'), 'docx')).toBe('awaiting_review');
  });

  it('a failed or never-saved file can never be accepted', () => {
    const { overlay } = approvedCase();
    const failed = saveArtifact(overlay.id, 'docx', { ok: false }).artifacts[0]!;
    expect(() => workspace.confirmCvArtifact(db, overlay.id, failed.artifactId)).toThrow(/failed its checks/);
  });

  it('a PDF needs every page shown in the app before it can be accepted, a Word file does not', () => {
    const { overlay } = approvedCase();
    const pdf = saveArtifact(overlay.id, 'pdf').artifacts[0]!;
    expect(() => workspace.confirmCvArtifact(db, overlay.id, pdf.artifactId)).toThrow(/read every page/);
    // Opening it in the system viewer only proves the app launched it (#434).
    workspace.markCvArtifactReviewOpened(db, overlay.id, pdf.artifactId);
    expect(() => workspace.confirmCvArtifact(db, overlay.id, pdf.artifactId)).toThrow(/read every page/);
    const viewed = workspace.markCvArtifactPagesViewed(db, overlay.id, pdf.artifactId, 1);
    expect(viewed.artifacts[0]?.pagesViewedAt).not.toBe('');
    expect(cvArtifactStatus(workspace.confirmCvArtifact(db, overlay.id, pdf.artifactId), 'pdf')).toBe('accepted');

    const docx = saveArtifact(overlay.id, 'docx').artifacts.at(-1)!;
    const accepted = workspace.confirmCvArtifact(db, overlay.id, docx.artifactId);
    expect(cvArtifactStatus(accepted, 'docx')).toBe('accepted');
    expect(accepted.artifacts.find((artifact) => artifact.artifactId === docx.artifactId)?.confirmedAt).not.toBe('');
  });

  it('refuses to mark a PDF as read when the renderer shows fewer pages than the file has', () => {
    const { overlay } = approvedCase();
    const pdf = saveArtifact(overlay.id, 'pdf', { pageCount: 3 }).artifacts[0]!;
    expect(() => workspace.markCvArtifactPagesViewed(db, overlay.id, pdf.artifactId, 2)).toThrow(/3 page\(s\) and 2 were shown/);
    expect(() => workspace.markCvArtifactPagesViewed(db, overlay.id, pdf.artifactId, 4)).toThrow(/were shown/);
    expect(() => workspace.confirmCvArtifact(db, overlay.id, pdf.artifactId)).toThrow(/read every page/);
    workspace.markCvArtifactPagesViewed(db, overlay.id, pdf.artifactId, 3);
    expect(cvArtifactStatus(workspace.confirmCvArtifact(db, overlay.id, pdf.artifactId), 'pdf')).toBe('accepted');
  });

  it('only a saved, current PDF can be marked as read in the app', () => {
    const { cv, overlay } = approvedCase();
    const docx = saveArtifact(overlay.id, 'docx').artifacts[0]!;
    expect(() => workspace.markCvArtifactPagesViewed(db, overlay.id, docx.artifactId, 1)).toThrow(/only a PDF/);
    const failed = saveArtifact(overlay.id, 'pdf', { ok: false }).artifacts.at(-1)!;
    expect(() => workspace.markCvArtifactPagesViewed(db, overlay.id, failed.artifactId, 1)).toThrow(/never saved/);
    const pdf = saveArtifact(overlay.id, 'pdf').artifacts.at(-1)!;
    workspace.updateCvDocument(db, cv.id, { source: { ...SOURCE, summary: 'A different summary.' } });
    expect(() => workspace.markCvArtifactPagesViewed(db, overlay.id, pdf.artifactId, 1)).toThrow(/earlier version/);
  });

  it('only the newest file of a format can be accepted', () => {
    const { overlay } = approvedCase();
    const first = saveArtifact(overlay.id, 'docx').artifacts[0]!;
    saveArtifact(overlay.id, 'docx');
    expect(() => workspace.confirmCvArtifact(db, overlay.id, first.artifactId)).toThrow(/newer export/);
  });

  it('refuses an unknown artifact id', () => {
    const { overlay } = approvedCase();
    expect(() => workspace.confirmCvArtifact(db, overlay.id, 'nope')).toThrow(workspace.WorkspaceNotFoundError);
  });

  it('deleting the parent CV deletes the case and its artifact records', () => {
    const { cv, overlay } = approvedCase();
    saveArtifact(overlay.id, 'pdf');
    workspace.deleteCvDocument(db, cv.id);
    expect(() => read(overlay.id)).toThrow(workspace.WorkspaceNotFoundError);
  });
});

describe('invalidation', () => {
  function acceptedBoth() {
    const { cv, overlay } = approvedCase();
    const pdf = saveArtifact(overlay.id, 'pdf').artifacts[0]!;
    workspace.markCvArtifactPagesViewed(db, overlay.id, pdf.artifactId, 1);
    workspace.confirmCvArtifact(db, overlay.id, pdf.artifactId);
    const docx = saveArtifact(overlay.id, 'docx').artifacts.at(-1)!;
    const accepted = workspace.confirmCvArtifact(db, overlay.id, docx.artifactId);
    expect(cvArtifactStatus(accepted, 'pdf')).toBe('accepted');
    expect(cvArtifactStatus(accepted, 'docx')).toBe('accepted');
    return { cv, overlay, pdf, docx };
  }

  it.each([
    ['a changed requirement list', (id: string) => workspace.updateCvEvidenceOverlay(db, id, { requirementCoverage: { status: 'partial', batches: 1 } })],
    ['a changed job description', (id: string) => workspace.updateCvEvidenceOverlay(db, id, { jdSnapshot: `${FULL_JD}\nAn extra requirement line.`, jdSnapshotHash: 'd'.repeat(64) })],
    ['a corrected fact', (id: string) => workspace.updateCvEvidenceOverlay(db, id, { facts: read(id).facts.map((fact) => ({ ...fact, activity: 'Built the booking and payment screens' })) })],
    ['a withdrawn wording variant', (id: string) => workspace.updateCvEvidenceOverlay(db, id, { wordingVariants: read(id).wordingVariants.map((variant) => ({ ...variant, status: 'rejected' as const })) })],
  ])('%s makes every file historical and keeps its recorded hash', (_name, change) => {
    const { overlay, pdf, docx } = acceptedBoth();
    const after = change(overlay.id);
    expect(after.state).toBe('draft');
    expect(cvArtifactStatus(after, 'pdf')).toBe('stale');
    expect(cvArtifactStatus(after, 'docx')).toBe('stale');
    expect(after.artifacts.find((artifact) => artifact.artifactId === pdf.artifactId)?.contentHash).toBe(pdf.contentHash);
    expect(after.artifacts.find((artifact) => artifact.artifactId === docx.artifactId)?.contentHash).toBe(docx.contentHash);
    expect(workspace.checkCvCaseExportReadiness(db, overlay.id).snapshot).toBeNull();
    expect(() => workspace.confirmCvArtifact(db, overlay.id, pdf.artifactId)).toThrow(/earlier version/);
  });

  it('a changed source CV or project selection makes the files historical', () => {
    const { cv, overlay } = acceptedBoth();
    workspace.updateCvDocument(db, cv.id, { source: { ...SOURCE, summary: 'Changed summary.' } });
    const after = read(overlay.id);
    expect(cvArtifactStatus(after, 'pdf')).toBe('stale');
    expect(cvArtifactStatus(after, 'docx')).toBe('stale');
  });

  it('a render contract change invalidates file verification but not factual approval', () => {
    const { overlay } = acceptedBoth();
    // The files were rendered under the current contract; pretend the contract moved on.
    const stored = read(overlay.id);
    const older = { ...stored, artifacts: stored.artifacts.map((artifact) => ({ ...artifact, renderContractVersion: CV_RENDER_CONTRACT_VERSION - 1 })) };
    expect(cvArtifactStatus(older, 'pdf')).toBe('stale');
    expect(cvArtifactStatus(older, 'docx')).toBe('stale');
    expect(older.state).toBe('candidate_approved');
    expect(older.facts).toHaveLength(1);
  });

  it('approving again, even with identical content, does not revive an earlier file', () => {
    const { overlay } = acceptedBoth();
    const again = workspace.approveCvEvidenceOverlay(db, overlay.id, read(overlay.id).caseRevision);
    expect(again.approvedResumeSnapshot?.digest).toBe(overlay.approvedResumeSnapshot?.digest);
    expect(cvArtifactStatus(again, 'pdf')).toBe('stale');
  });
});

describe('a case an earlier version marked artifact_approved', () => {
  it('reads as approved with an unverified export, never as an accepted file', () => {
    const { overlay } = approvedCase();
    db.update(cvEvidenceOverlays).set({ state: 'artifact_approved' }).where(eq(cvEvidenceOverlays.id, overlay.id)).run();
    const legacy = read(overlay.id);
    expect(legacy.state).toBe('candidate_approved');
    expect(legacy.legacyUnverifiedExport).toBe(true);
    expect(cvArtifactStatus(legacy, 'pdf')).toBe('legacy_unverified');
    expect(cvArtifactStatus(legacy, 'docx')).toBe('legacy_unverified');
  });

  it('is replaced by real records once a file is saved, and loses the flag when the case changes', () => {
    const { overlay } = approvedCase();
    db.update(cvEvidenceOverlays).set({ state: 'artifact_approved' }).where(eq(cvEvidenceOverlays.id, overlay.id)).run();
    const after = saveArtifact(overlay.id, 'pdf');
    expect(after.legacyUnverifiedExport).toBe(false);
    expect(after.state).toBe('candidate_approved');

    const { overlay: other } = approvedCase();
    db.update(cvEvidenceOverlays).set({ state: 'artifact_approved' }).where(eq(cvEvidenceOverlays.id, other.id)).run();
    const changed = workspace.updateCvEvidenceOverlay(db, other.id, { requirementCoverage: { status: 'partial', batches: 1 } });
    expect(changed.state).toBe('draft');
    expect(changed.legacyUnverifiedExport).toBe(false);
  });
});

describe('the reviewed-source gate in the main process', () => {
  it('refuses to approve the case or its projects against an unreviewed source', () => {
    const { overlay } = preparedCase(SOURCE, { approve: false, sourcePatch: { reviewedAt: '' } });
    const revision = read(overlay.id).caseRevision;
    expect(() => workspace.approveCvProjectSelection(db, overlay.id, revision)).toThrow(/have not been checked yet/);
    expect(() => workspace.approveCvEvidenceOverlay(db, overlay.id, revision)).toThrow(/have not been checked yet/);
    expect(() => workspace.approveCvEvidenceOverlay(db, overlay.id, revision)).toThrow(/CV Library/);
    expect(read(overlay.id).state).not.toBe('candidate_approved');
    expect(read(overlay.id).projectSelection).toBeNull();
  });

  it('refuses a source flagged as truncated', () => {
    const { overlay } = preparedCase(SOURCE, {
      approve: false,
      sourcePatch: { complete: false, incompleteReason: '', coveredChars: 4000, sourceChars: 9000 },
    });
    const revision = read(overlay.id).caseRevision;
    expect(() => workspace.approveCvEvidenceOverlay(db, overlay.id, revision)).toThrow(/only partly read/);
    expect(() => workspace.approveCvProjectSelection(db, overlay.id, revision)).toThrow(/only partly read/);
  });

  it('still approves and exports a reviewed, complete source', () => {
    const { overlay } = approvedCase();
    expect(overlay.state).toBe('candidate_approved');
    expect(workspace.checkCvCaseExportReadiness(db, overlay.id).blockers).toEqual([]);
  });

  it('blocks export of an already approved case whose source is now incomplete, without throwing', () => {
    const { cv, overlay } = approvedCase();
    forceSource(cv.id, { complete: false, incompleteReason: 'the last page was never read' });
    const readiness = workspace.checkCvCaseExportReadiness(db, overlay.id);
    expect(readiness.blockers.join(' ')).toMatch(/only partly read/);
    expect(readiness.blockers.join(' ')).toMatch(/Check your CV details in the CV Library/);
  });

  it('blocks export of an already approved case whose source is no longer reviewed', () => {
    const { cv, overlay } = approvedCase();
    forceSource(cv.id, { reviewedAt: '' });
    expect(workspace.checkCvCaseExportReadiness(db, overlay.id).blockers.join(' ')).toMatch(/have not been checked yet/);
  });
});
