import { useState } from 'react';
import { renderResumePlainText } from '../../../electron/resume-text.js';
import {
  cvArtifactStatus,
  latestArtifactOfFormat,
} from '../../../electron/workspace/cv-artifact-status.js';
import type { CvArtifactRecord, CvEvidenceOverlayRecord, CvExportFormat } from '../../window.js';
import { formatCvDateTime } from '../cv-library/cv-profile.js';
import { CvPdfPageReview } from './CvPdfPageReview.js';
import { describeError } from './useAgentRun.js';
import { ErrorBanner } from '../shell/index.js';

export interface CvArtifactPanelProps {
  overlay: CvEvidenceOverlayRecord;
  onOverlayChange: (overlay: CvEvidenceOverlayRecord) => void;
  /** Why the CV's source cannot back an export right now (#419). Empty when it can. The main
   * process refuses the export for the same reasons; this explains it before the click. */
  sourceGaps?: readonly string[];
  /** Opens this CV's review (#447). */
  onReviewSource?: () => void;
}

const FORMATS: { format: CvExportFormat; label: string; exportLabel: string }[] = [
  { format: 'pdf', label: 'PDF', exportLabel: 'Export as PDF' },
  { format: 'docx', label: 'Word', exportLabel: 'Export as Word' },
];

const STATUS_TEXT = {
  not_exported: 'Not exported',
  awaiting_review: 'Exported, waiting for your review',
  qa_failed: 'Needs fixing',
  accepted: 'Accepted',
  stale: 'Out of date',
  legacy_unverified: 'Export again',
} as const;

const STATUS_NOTE = {
  not_exported: '',
  awaiting_review: 'Look at the file before you accept it.',
  qa_failed: 'This file was not saved. Fix the items below and export again. Your approved facts are unchanged.',
  accepted: 'You confirmed this file. If you change it later, it is not rechecked.',
  stale: 'Your CV or job details changed after this file was made, so it is out of date. Export again.',
  legacy_unverified: 'Export this file again to make sure it is up to date.',
} as const;

/** The saved file location, kept out of the default view. */
function FileLocation({ artifact }: { artifact: CvArtifactRecord }) {
  if (!artifact.savedPath) return null;
  return (
    <details className="mt-1">
      <summary className="cursor-pointer">Show file location</summary>
      <p>{artifact.savedPath}</p>
    </details>
  );
}

/**
 * Per-format export and acceptance for an approved tailoring case (#419 step 9). Shows what each
 * format is worth right now, from the artifact records the main process wrote, and offers the
 * candidate's own review steps: look at the saved file, then confirm it. A PDF's pages are shown in
 * the panel and accepting unlocks only after every page was displayed (#434), with the system viewer
 * as a second way to look; a Word file is looked at in the candidate's own editor, because
 * pagination depends on the editor and no page fit is claimed. Nothing here says the vacancy is ready to apply.
 */
export function CvArtifactPanel({ overlay, onOverlayChange, sourceGaps = [], onReviewSource }: CvArtifactPanelProps) {
  const exportBlocked = sourceGaps.length > 0;
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();

  async function run(key: string, action: () => Promise<void>, fallback: string) {
    setBusy(key);
    setError(undefined);
    setNotice(undefined);
    try {
      await action();
    } catch (err) {
      setError(describeError(err, fallback));
    } finally {
      setBusy(null);
    }
  }

  const exportFile = (format: CvExportFormat) =>
    run(
      `export-${format}`,
      async () => {
        const result = await window.workspace.exportCvEvidenceOverlay(overlay.id, format);
        onOverlayChange(result.overlay);
        if (result.saved && result.path) setNotice(`Saved to ${result.path}. It is waiting for your review.`);
      },
      'could not export this CV',
    );

  const openFile = (artifact: CvArtifactRecord) =>
    run(
      `open-${artifact.artifactId}`,
      async () => onOverlayChange(await window.workspace.openCvArtifact(overlay.id, artifact.artifactId)),
      'could not open this file',
    );

  const confirmFile = (artifact: CvArtifactRecord) =>
    run(
      `confirm-${artifact.artifactId}`,
      async () => onOverlayChange(await window.workspace.confirmCvArtifact(overlay.id, artifact.artifactId)),
      'could not record your confirmation',
    );

  const copyText = () =>
    run(
      'copy',
      async () => {
        const snapshot = overlay.approvedResumeSnapshot;
        if (!snapshot) throw new Error('this CV has no approved version to copy');
        await navigator.clipboard.writeText(renderResumePlainText(snapshot.resume));
        setNotice('Copied the approved CV as plain text.');
      },
      'could not copy the text',
    );

  const shownIds = new Set(
    FORMATS.flatMap(({ format }) => {
      const status = cvArtifactStatus(overlay, format);
      const latest = latestArtifactOfFormat(overlay, format);
      return latest && (status === 'awaiting_review' || status === 'accepted' || status === 'qa_failed') ? [latest.artifactId] : [];
    }),
  );
  const earlier = overlay.artifacts.filter((artifact) => !shownIds.has(artifact.artifactId));

  return (
    <section className="flex flex-col gap-3 rounded-box border border-base-300 p-4 text-sm" aria-label="Exported files">
      <h3 id="cv-step-files" tabIndex={-1} className="font-medium outline-none">Files</h3>
      <p className="text-base-content/70">Export your approved CV, open it, and confirm it looks right.</p>

      {exportBlocked && (
        <div className="alert alert-warning text-sm" role="alert" aria-label="Export blocked until your CV details are reviewed">
          <div>
            <div className="font-medium">These files cannot be exported until you check your CV details</div>
            <ul className="list-disc pl-4">
              {sourceGaps.map((gap) => (
                <li key={gap}>{gap}</li>
              ))}
            </ul>
            {onReviewSource ? (
              <>
                <p className="mt-1">Check your CV details first. Review what was read from it, and confirm.</p>
                <button type="button" className="btn btn-warning btn-sm mt-2" onClick={onReviewSource}>
                  Review this CV now
                </button>
              </>
            ) : (
              <p className="mt-1">Check your CV details first. Open this CV in the CV Library, review what was read from it, and confirm.</p>
            )}
          </div>
        </div>
      )}

      {FORMATS.map(({ format, label, exportLabel }) => {
        const status = cvArtifactStatus(overlay, format);
        const latest = latestArtifactOfFormat(overlay, format);
        const current = latest && (status === 'awaiting_review' || status === 'accepted' || status === 'qa_failed') ? latest : null;
        return (
          <div key={format} className="flex flex-col gap-2 rounded-box border border-base-300 p-3" aria-label={`${label} file`}>
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-medium">{label}</span>
              <span
                className={`badge ${status === 'accepted' ? 'badge-success' : status === 'qa_failed' ? 'badge-error' : status === 'not_exported' ? 'badge-ghost' : 'badge-warning'}`}
                role="status"
              >
                {STATUS_TEXT[status]}
              </span>
            </div>
            {STATUS_NOTE[status] && <p className="text-base-content/70">{STATUS_NOTE[status]}</p>}

            {status === 'stale' && latest && (
              <div className="text-xs text-base-content/60">
                Last file exported {formatCvDateTime(latest.exportedAt)}.
                <FileLocation artifact={latest} />
              </div>
            )}

            {current && (
              <div className="text-xs text-base-content/60">
                Exported {formatCvDateTime(current.exportedAt)}
                {current.validation.pageCount !== undefined
                  ? `, ${current.validation.pageCount} ${current.validation.pageCount === 1 ? 'page' : 'pages'}`
                  : ''}
                .
                <FileLocation artifact={current} />
              </div>
            )}

            {current && !current.validation.ok && (
              <ul className="list-disc pl-5 text-error" aria-label={`${label} problems`}>
                {current.validation.reasons.map((reason) => (
                  <li key={reason}>{reason}</li>
                ))}
              </ul>
            )}

            {format === 'pdf' && current && current.validation.ok && current.savedPath && status !== 'accepted' && (
              <CvPdfPageReview key={current.artifactId} overlayId={overlay.id} artifact={current} onOverlayChange={onOverlayChange} />
            )}

            <div className="flex flex-wrap items-center gap-2">
              <button type="button" className="btn btn-outline" onClick={() => void exportFile(format)} disabled={busy !== null || exportBlocked}>
                {busy === `export-${format}` && <span className="loading loading-spinner loading-xs" aria-hidden="true" />}
                {status === 'not_exported' || status === 'legacy_unverified' ? exportLabel : `Export ${label} again`}
              </button>
              {current && current.validation.ok && current.savedPath && status !== 'accepted' && (
                <>
                  <button type="button" className="btn btn-outline" onClick={() => void openFile(current)} disabled={busy !== null}>
                    {format === 'pdf' ? 'Open in my PDF viewer' : 'Open in my editor'}
                  </button>
                  <button
                    type="button"
                    className="btn btn-primary"
                    onClick={() => void confirmFile(current)}
                    disabled={busy !== null || (format === 'pdf' && !current.pagesViewedAt)}
                  >
                    {format === 'pdf' ? 'I read every page and it looks right' : 'I reviewed this in my editor'}
                  </button>
                </>
              )}
            </div>
            {format === 'pdf' && current && current.validation.ok && status === 'awaiting_review' && !current.pagesViewedAt && (
              <p className="text-xs text-base-content/60">Scroll through every page to unlock confirming.</p>
            )}
          </div>
        );
      })}

      <div className="flex flex-wrap items-center gap-2">
        <button type="button" className="btn btn-outline" onClick={() => void copyText()} disabled={busy !== null || !overlay.approvedResumeSnapshot}>
          Copy as plain text
        </button>
      </div>

      {earlier.length > 0 && (
        <details>
          <summary className="cursor-pointer text-base-content/70">Earlier files ({earlier.length})</summary>
          <ul className="mt-2 list-disc pl-5 text-xs text-base-content/60">
            {earlier.map((artifact) => (
              <li key={artifact.artifactId}>
                {artifact.format.toUpperCase()}, exported {formatCvDateTime(artifact.exportedAt)}
                {artifact.validation.ok ? '' : ', needs fixing'}
                <FileLocation artifact={artifact} />
              </li>
            ))}
          </ul>
        </details>
      )}

      {error && (
        <ErrorBanner>
          {error}
        </ErrorBanner>
      )}
      {notice && (
        <div className="text-sm font-medium" role="status">
          {notice}
        </div>
      )}
    </section>
  );
}
