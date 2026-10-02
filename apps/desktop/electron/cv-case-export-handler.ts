import type { TailoredResume } from './resume-schema.js';
import type { RenderedCaseArtifact } from './cv-case-export.js';
import type { CvApprovedResumeSnapshot, CvArtifactFormat, CvArtifactRecord } from './workspace/cv-evidence-schema.js';
import type { CvCaseExportResult, CvEvidenceOverlayRecord } from './workspace/types.js';

/**
 * The decision logic of `workspace:cv-evidence-overlays:export` (#419 step 9), with every side
 * effect injected so it can run without Electron: the readiness check, the renderer, the save
 * dialog, the disk write and the repository. `main.ts` wires the real ones and stays a thin
 * wrapper. The order here is the contract the tests pin: refuse on blockers before any render, never
 * show the save dialog for a file that failed its checks, write exactly once, record the hash of the
 * bytes written.
 */

export type CvCaseArtifactRecordInput = Pick<
  CvArtifactRecord,
  'format' | 'contentHash' | 'snapshotDigest' | 'snapshotApprovedAt' | 'renderContractVersion' | 'validation' | 'savedPath'
>;

export interface CvCaseExportDeps {
  /** `workspace.checkCvCaseExportReadiness`. */
  checkReadiness(overlayId: string): { overlay: CvEvidenceOverlayRecord; snapshot: CvApprovedResumeSnapshot | null; blockers: string[] };
  /** False when there is no window to show the save dialog on. */
  hasWindow(): boolean;
  render(resume: TailoredResume, format: CvArtifactFormat): Promise<RenderedCaseArtifact>;
  /** The CV Library name of the case's CV, used for the default file name. */
  defaultFileBaseName(overlay: CvEvidenceOverlayRecord): string;
  showSaveDialog(options: {
    title: string;
    defaultPath: string;
    filters: { name: string; extensions: string[] }[];
  }): Promise<{ canceled: boolean; filePath?: string }>;
  writeFile(path: string, buffer: Buffer): Promise<void>;
  /** `workspace.recordCvArtifact`, run under the application data reset gate. */
  recordArtifact(overlayId: string, record: CvCaseArtifactRecordInput): Promise<CvEvidenceOverlayRecord>;
}

export async function exportCvCase(
  deps: CvCaseExportDeps,
  overlayId: string,
  format: CvArtifactFormat,
): Promise<CvCaseExportResult> {
  const before = deps.checkReadiness(overlayId);
  if (before.blockers.length > 0 || !before.snapshot) {
    throw new Error(`this CV cannot be exported yet: ${before.blockers.join('; ')}`);
  }
  const snapshot = before.snapshot;
  if (!deps.hasWindow()) return { saved: false, artifact: null, overlay: before.overlay };

  const rendered = await deps.render(snapshot.resume, format);
  const recordBase = {
    format,
    contentHash: rendered.contentHash,
    snapshotDigest: snapshot.digest,
    snapshotApprovedAt: snapshot.approvedAt,
    renderContractVersion: snapshot.renderContractVersion,
    validation: rendered.validation,
  };

  if (!rendered.validation.ok) {
    const overlay = await deps.recordArtifact(overlayId, { ...recordBase, savedPath: '' });
    return { saved: false, artifact: overlay.artifacts.at(-1) ?? null, overlay };
  }

  const result = await deps.showSaveDialog({
    title: 'Export approved CV',
    defaultPath: `${deps.defaultFileBaseName(before.overlay)}.${format}`,
    filters: [format === 'pdf' ? { name: 'PDF document', extensions: ['pdf'] } : { name: 'Word document', extensions: ['docx'] }],
  });
  if (result.canceled || !result.filePath) return { saved: false, artifact: null, overlay: before.overlay };

  await deps.writeFile(result.filePath, rendered.buffer);
  // The dialog can stay open for a long time. If the case changed meanwhile, the file still exists
  // and is recorded as what it is: the status of a record is derived from the snapshot it was made
  // from, so it reads as historical rather than current.
  const overlay = await deps.recordArtifact(overlayId, { ...recordBase, savedPath: result.filePath });
  return { saved: true, path: result.filePath, artifact: overlay.artifacts.at(-1) ?? null, overlay };
}
