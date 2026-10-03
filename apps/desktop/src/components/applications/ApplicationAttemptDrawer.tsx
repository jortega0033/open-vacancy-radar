import { X } from '@phosphor-icons/react';
import { useEffect, useState } from 'react';
import type { ApplicationArtifactSummary, ApplicationAttemptRecord } from '../../window.js';
import { Dialog } from '../shell/Dialog.js';
import { ATTEMPT_CHECKPOINT_BADGE_CLASS, ATTEMPT_CHECKPOINT_LABEL } from './attempt-status.js';

export interface ApplicationAttemptDrawerProps {
  attempt: ApplicationAttemptRecord;
  onClose: () => void;
  /** Fired after a recovery action changed the attempt, so the page can refresh its list and move
   * to wherever the attempt now lives (#468). */
  onChanged?: (kind: 'returned' | 'retried') => void;
}

const ARTIFACT_KIND_LABEL: Record<ApplicationArtifactSummary['kind'], string> = {
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
export function ApplicationAttemptDrawer({ attempt, onClose, onChanged }: ApplicationAttemptDrawerProps) {
  const [artifacts, setArtifacts] = useState<ApplicationArtifactSummary[] | null>(null);
  const [artifactsError, setArtifactsError] = useState<string>();
  const [recovering, setRecovering] = useState(false);
  const [recoveryError, setRecoveryError] = useState<string>();

  // Both actions only reverse a step that sent nothing: a skip, or a preparation that stopped. The
  // skipped one re-reads the attempt first, so it can never move a checkpoint that has since
  // advanced to a submission.
  async function returnToReview() {
    setRecovering(true);
    setRecoveryError(undefined);
    try {
      const current = await window.workspace.getApplicationAttempt(attempt.id);
      if (current.checkpoint !== 'skipped') throw new Error('This application is no longer skipped.');
      await window.workspace.updateApplicationAttempt(attempt.id, { checkpoint: 'ready', checkpointDetail: '' });
      onChanged?.('returned');
    } catch (err) {
      setRecoveryError(err instanceof Error ? err.message : 'We could not return this application to review.');
    } finally {
      setRecovering(false);
    }
  }

  async function tryAgain() {
    setRecovering(true);
    setRecoveryError(undefined);
    try {
      const result = await window.applicationPipeline.resume(attempt.id);
      if (!result.ok) throw new Error(result.detail ?? 'We could not start this application again.');
      onChanged?.('retried');
    } catch (err) {
      setRecoveryError(err instanceof Error ? err.message : 'We could not start this application again.');
    } finally {
      setRecovering(false);
    }
  }

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
    <Dialog
      aria-label={`Application attempt for ${attempt.role} at ${attempt.company}`}
      placement="end"
      boxClassName="flex max-w-md flex-col rounded-none p-0"
      onClose={onClose}
    >
        <div className="flex items-center justify-between border-b border-base-300 px-5 py-3.5">
          <h2 className="text-sm font-semibold">
            {attempt.role} <span className="text-base-content/60">at</span> {attempt.company}
          </h2>
          <button type="button" aria-label="Close" className="btn btn-ghost btn-sm btn-circle" onClick={onClose}>
            <X size={16} weight="bold" aria-hidden="true" />
          </button>
        </div>

        <div className="flex-1 space-y-4 overflow-y-auto px-5 py-4">
          <div className="flex items-center gap-2">
            <span className={ATTEMPT_CHECKPOINT_BADGE_CLASS[attempt.checkpoint]}>
              {ATTEMPT_CHECKPOINT_LABEL[attempt.checkpoint]}
            </span>
            <span className="text-xs text-base-content/60">Updated {formatDateTime(attempt.updatedAt)}</span>
          </div>

          {recoveryError && (
            <div className="alert alert-error text-sm" role="alert">
              {recoveryError}
            </div>
          )}

          {attempt.checkpointDetail && (
            <div className="rounded-box border border-base-300 bg-base-200 p-3 text-sm">{attempt.checkpointDetail}</div>
          )}

          {attempt.canonicalUrl && (
            <div>
              <span className="mb-1 block ovr-eyebrow">
                Application URL
              </span>
              <a href={attempt.canonicalUrl} target="_blank" rel="noreferrer" className="link link-hover break-all text-sm">
                {attempt.canonicalUrl}
              </a>
            </div>
          )}

          <div>
            <span className="mb-1 block ovr-eyebrow">
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
            <span className="mb-1 block ovr-eyebrow">
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

        <div className="flex flex-wrap justify-end gap-2 border-t border-base-300 px-5 py-3.5">
          {attempt.checkpoint === 'skipped' && (
            <button type="button" className="btn btn-primary" disabled={recovering} onClick={() => void returnToReview()}>
              Return to review
            </button>
          )}
          {attempt.checkpoint === 'failed' && (
            <button type="button" className="btn btn-primary" disabled={recovering} onClick={() => void tryAgain()}>
              Try again
            </button>
          )}
          <button type="button" className="btn btn-outline" onClick={onClose}>
            Close
          </button>
        </div>
    </Dialog>
  );
}
