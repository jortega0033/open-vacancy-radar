import { useEffect, useState } from 'react';
import type { ApplicationArtifactRecord, ApplicationAttemptRecord } from '../../window.js';
import { ATTEMPT_CHECKPOINT_BADGE_CLASS, ATTEMPT_CHECKPOINT_LABEL } from './attempt-status.js';

export interface ApplicationAttemptDrawerProps {
  attempt: ApplicationAttemptRecord;
  onClose: () => void;
}

const ARTIFACT_KIND_LABEL: Record<ApplicationArtifactRecord['kind'], string> = {
  cv_pdf: 'Tailored CV',
  cover_letter_pdf: 'Cover letter',
  combined_pdf: 'Combined document',
  other: 'File',
};

function formatBytes(byteSize: number): string {
  if (byteSize < 1024) return `${byteSize} B`;
  const kb = byteSize / 1024;
  if (kb < 1024) return `${kb.toFixed(kb < 10 ? 1 : 0)} KB`;
  return `${(kb / 1024).toFixed((kb / 1024) < 10 ? 1 : 0)} MB`;
}

function formatDateTime(iso: string): string {
  return new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

/**
 * Read-only detail view for one application attempt (issue #202): what a review screen needs to
 * show before anything is confirmed, minus the confirm/submit action itself, which stays gated
 * behind an explicit go-ahead the pipeline this drawer reads from doesn't have yet. No edit
 * affordance anywhere -- `ApplicationAttemptPatch` only lets the main-process pipeline advance
 * `checkpoint`, never a person from this drawer.
 */
export function ApplicationAttemptDrawer({ attempt, onClose }: ApplicationAttemptDrawerProps) {
  const [artifacts, setArtifacts] = useState<ApplicationArtifactRecord[] | null>(null);
  const [artifactsError, setArtifactsError] = useState<string>();

  useEffect(() => {
    let cancelled = false;
    setArtifacts(null);
    setArtifactsError(undefined);
    async function load() {
      try {
        const rows = await window.workspace.listApplicationArtifacts(attempt.id);
        if (!cancelled) setArtifacts(rows);
      } catch (err) {
        if (!cancelled) setArtifactsError(err instanceof Error ? err.message : 'could not load documents for this attempt');
      }
    }
    void load();
    return () => {
      cancelled = true;
    };
  }, [attempt.id]);

  return (
    <div className="modal modal-open modal-end" role="dialog" aria-modal="true">
      <div className="modal-box flex max-w-md flex-col rounded-none p-0">
        <div className="flex items-center justify-between border-b border-base-300 px-5 py-3.5">
          <h2 className="text-sm font-semibold">
            {attempt.role} <span className="text-base-content/60">at</span> {attempt.company}
          </h2>
          <button type="button" aria-label="Close" className="btn btn-ghost btn-sm btn-circle" onClick={onClose}>
            ✕
          </button>
        </div>

        <div className="flex-1 space-y-4 overflow-y-auto px-5 py-4">
          <div className="flex items-center gap-2">
            <span className={ATTEMPT_CHECKPOINT_BADGE_CLASS[attempt.checkpoint]}>
              {ATTEMPT_CHECKPOINT_LABEL[attempt.checkpoint]}
            </span>
            <span className="text-xs text-base-content/60">Updated {formatDateTime(attempt.updatedAt)}</span>
          </div>

          {attempt.checkpointDetail && (
            <div className="rounded-box border border-base-300 bg-base-200 p-3 text-sm">{attempt.checkpointDetail}</div>
          )}

          {attempt.canonicalUrl && (
            <div>
              <span className="mb-1 block text-xs font-semibold uppercase tracking-wide text-base-content/60">
                Application URL
              </span>
              <a href={attempt.canonicalUrl} target="_blank" rel="noreferrer" className="link link-hover break-all text-sm">
                {attempt.canonicalUrl}
              </a>
            </div>
          )}

          <div>
            <span className="mb-1 block text-xs font-semibold uppercase tracking-wide text-base-content/60">
              Job description
            </span>
            {attempt.jdSnapshot ? (
              <details className="collapse-arrow collapse border border-base-300">
                <summary className="collapse-title text-sm">
                  {attempt.jdComplete ? 'Full text captured' : 'Partial text captured (source was truncated)'}
                </summary>
                <div className="collapse-content">
                  <p className="whitespace-pre-wrap text-sm text-base-content/80">{attempt.jdSnapshot}</p>
                </div>
              </details>
            ) : (
              <p className="text-sm text-base-content/60">Not captured yet.</p>
            )}
          </div>

          <div>
            <span className="mb-1 block text-xs font-semibold uppercase tracking-wide text-base-content/60">
              Documents
            </span>
            {artifactsError && <p className="text-sm text-error">{artifactsError}</p>}
            {!artifactsError && artifacts === null && <p className="text-sm text-base-content/60">Loading…</p>}
            {!artifactsError && artifacts !== null && artifacts.length === 0 && (
              <p className="text-sm text-base-content/60">No documents generated yet.</p>
            )}
            {!artifactsError && artifacts !== null && artifacts.length > 0 && (
              <ul className="divide-y divide-base-300 rounded-box border border-base-300">
                {artifacts.map((artifact) => (
                  <li key={artifact.id} className="flex items-center justify-between px-3 py-2 text-sm">
                    <span>{ARTIFACT_KIND_LABEL[artifact.kind]}</span>
                    <span className="text-base-content/60">{formatBytes(artifact.byteSize)}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>

        <div className="flex justify-end gap-2 border-t border-base-300 px-5 py-3.5">
          <button type="button" className="btn btn-outline" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
      <button type="button" className="modal-backdrop" aria-label="Close" onClick={onClose} />
    </div>
  );
}
