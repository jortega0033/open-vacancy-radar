import { useCallback, useEffect, useState } from 'react';
import { CV_JD_UNWAIVABLE_REASONS } from '../../../electron/workspace/cv-evidence-schema.js';
import { assessJdCompleteness, jobDescriptionBody } from '../../../electron/generation-input.js';
import type { CvEvidenceOverlayRecord, CvJdOrigin, CvSourceDocument } from '../../window.js';
import { ConfirmDialog } from '../shell/ConfirmDialog.js';
import { sha256Hex, sha256HexOfSource } from './content-hash.js';
import type { VacancyLead } from './types.js';
import { describeError } from './useAgentRun.js';
import { caseKeyFor } from './vacancy-key.js';
import { ErrorBanner, WarningBanner } from '../shell/index.js';

export interface JdReviewProps {
  /** The CV Library record the case belongs to. Without one the JD can be read but not saved. */
  cvId: string | null;
  /** The vacancy as the workspace currently sees it, including any text the candidate pasted. */
  vacancy: VacancyLead;
  sourceCv?: CvSourceDocument | null;
  /** The candidate pasted or typed replacement text for this vacancy's job description. */
  onReplaceText(text: string, requisition: string): void;
  /** The saved case changed (new revision or confirmation), so panels that cached it should reload. */
  onSaved(): void;
}

const ORIGIN_LABEL: Record<CvJdOrigin, string> = {
  found: 'Posting text from the search result',
  pasted: 'Text you pasted',
  manual: 'Text you entered for this job',
};

interface PendingReplace {
  text: string;
  origin: CvJdOrigin;
  requisition: string;
  /** True when the text came from the paste box, which is emptied and closed once it is used. */
  fromPaste: boolean;
}

/** Reviewed requirements or an approval: what a new JD revision clears. */
function hasReviewsToLose(overlay: CvEvidenceOverlayRecord | null): boolean {
  if (!overlay) return false;
  return (
    overlay.state === 'candidate_approved' ||
    overlay.state === 'artifact_approved' ||
    overlay.requirements.some((requirement) => requirement.reviewed)
  );
}

function formatCapturedAt(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleString('en-GB');
}

/**
 * The job description step of a tailoring case (#419, step 4). Shows the full text the case works
 * from, where it came from, and what the completeness check found, lets the candidate paste or
 * replace it, and records each saved text as an immutable revision. It never fetches a URL and never
 * writes requirements of its own: the text is exactly what the discovery result carried or what the
 * candidate typed.
 */
export function JdReview({ cvId, vacancy, sourceCv, onReplaceText, onSaved }: JdReviewProps) {
  const [overlay, setOverlay] = useState<CvEvidenceOverlayRecord | null>(null);
  const [draft, setDraft] = useState('');
  const [draftRequisition, setDraftRequisition] = useState('');
  const [pasteOpen, setPasteOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  /** A replacement waiting for the candidate to confirm it will clear reviews (#450). */
  const [pendingReplace, setPendingReplace] = useState<PendingReplace | null>(null);

  const caseKey = caseKeyFor(vacancy);
  // The latest stored revision is the source of truth once the case has one (#419). The vacancy's own
  // text is only what a first save starts from: showing it over a newer stored revision would hide
  // what the case actually works from, and saving it would quietly replace the candidate's paste.
  const storedLatest = overlay?.jdRevisions.at(-1);
  const storedText = overlay && overlay.jdSnapshot.trim().length > 0 ? overlay.jdSnapshot : null;
  const text = storedText ?? jobDescriptionBody(vacancy);
  const origin: CvJdOrigin = (storedText !== null ? storedLatest?.origin : undefined) ?? vacancy.jdOrigin ?? 'found';
  const shownUrl = (storedText !== null ? storedLatest?.url : undefined) || vacancy.url;
  const shownRequisition = (storedText !== null ? storedLatest?.requisition : undefined) || vacancy.jdRequisition || '';
  const assessment = assessJdCompleteness({ ...vacancy, description: text, requirements: null });

  useEffect(() => {
    setError(undefined);
    if (!cvId) {
      setOverlay(null);
      return;
    }
    let cancelled = false;
    void window.workspace
      .getCvEvidenceOverlay(cvId, caseKey)
      .then((record) => {
        if (!cancelled) setOverlay(record);
      })
      .catch((err) => {
        if (!cancelled) setError(describeError(err, 'could not load the saved job description'));
      });
    return () => {
      cancelled = true;
    };
  }, [cvId, caseKey]);

  const save = useCallback(
    async (nextText: string, nextOrigin: CvJdOrigin, requisition: string) => {
      if (!cvId || nextText.trim().length === 0) return;
      setBusy(true);
      setError(undefined);
      try {
        const jdSnapshotHash = await sha256Hex(nextText);
        const existing = await window.workspace.getCvEvidenceOverlay(cvId, caseKey);
        const saved = existing
          ? await window.workspace.updateCvEvidenceOverlay(existing.id, {
              jdSnapshot: nextText,
              jdSnapshotHash,
              jdOrigin: nextOrigin,
              jdUrl: vacancy.url,
              ...(requisition ? { jdRequisition: requisition } : {}),
            })
          : await window.workspace.createCvEvidenceOverlay({
              cvId,
              vacancyKey: caseKey,
              caseTitle: vacancy.title,
              caseCompany: vacancy.company,
              sourceCvContentHash: await sha256HexOfSource(sourceCv ?? null),
              jdSnapshot: nextText,
              jdSnapshotHash,
              origin: caseKey.startsWith('manual:') ? 'manual' : 'vacancy',
              jdOrigin: nextOrigin,
              jdUrl: vacancy.url,
              ...(requisition ? { jdRequisition: requisition } : {}),
            });
        setOverlay(saved);
        onSaved();
      } catch (err) {
        setError(describeError(err, 'could not save the job description'));
      } finally {
        setBusy(false);
      }
    },
    [cvId, caseKey, vacancy.url, sourceCv, onSaved],
  );

  const commitReplace = useCallback(
    (change: PendingReplace) => {
      if (change.fromPaste) {
        onReplaceText(change.text, change.requisition);
        setDraft('');
        setPasteOpen(false);
      }
      void save(change.text, change.origin, change.requisition);
    },
    [onReplaceText, save],
  );

  // A new revision clears the requirement reviews and the approval (#419), so when there are any the
  // candidate confirms first. With nothing to lose, or text that matches what is saved, it goes straight through.
  const requestReplace = useCallback(
    (change: PendingReplace) => {
      if (overlay && hasReviewsToLose(overlay) && change.text.trim() !== overlay.jdSnapshot.trim()) {
        setPendingReplace(change);
        return;
      }
      commitReplace(change);
    },
    [overlay, commitReplace],
  );

  const handleUseDraft = useCallback(() => {
    const next = draft.trim();
    if (!next) return;
    const nextOrigin: CvJdOrigin = origin === 'manual' ? 'manual' : 'pasted';
    requestReplace({ text: next, origin: nextOrigin, requisition: draftRequisition.trim(), fromPaste: true });
  }, [draft, draftRequisition, origin, requestReplace]);

  const handleConfirm = useCallback(
    async (confirmed: boolean) => {
      if (!overlay) return;
      setError(undefined);
      try {
        setOverlay(await window.workspace.updateCvEvidenceOverlay(overlay.id, { jdConfirmedComplete: confirmed }));
        onSaved();
      } catch (err) {
        setError(describeError(err, 'could not record that confirmation'));
      }
    },
    [overlay, onSaved],
  );

  const revisions = overlay?.jdRevisions ?? [];
  const latest = revisions.at(-1);
  const savedMatchesText = overlay !== null && overlay.jdSnapshot === text;
  const canConfirm =
    overlay !== null &&
    savedMatchesText &&
    overlay.jdIncompleteReasons.length > 0 &&
    !CV_JD_UNWAIVABLE_REASONS.some((reason) => overlay.jdIncompleteReasons.includes(reason));
  const hasText = text.length > 0;

  return (
    <div className="card card-border rounded-box border-base-300 bg-base-100">
      <div className="card-body gap-3 p-5">
        <div className="card-title text-base font-bold">Job description</div>

        {!hasText && (
          <WarningBanner role="status">
            No job description came with this job. Paste it below.
          </WarningBanner>
        )}

        {hasText && (
          <>
            <details className="text-xs text-base-content/60">
              <summary className="cursor-pointer">Where this came from</summary>
              <p className="mt-1">
                {ORIGIN_LABEL[origin]}
                {shownUrl ? ` (${shownUrl})` : ''}
                {shownRequisition ? `, requisition ${shownRequisition}` : ''}
              </p>
            </details>
            <pre
              className="max-h-64 overflow-auto whitespace-pre-wrap break-words rounded-box border border-base-300 bg-base-200/40 p-3 text-xs"
              aria-label="Full job description text"
            >
              {text}
            </pre>
          </>
        )}

        {hasText && assessment.details.length > 0 && (
          <div className="alert alert-warning text-sm" role="status" aria-label="Job description completeness">
            <ul className="list-disc pl-4">
              {assessment.details.map((detail) => (
                <li key={detail}>{detail}</li>
              ))}
            </ul>
          </div>
        )}

        {canConfirm && (
          <label className="flex items-start gap-2 text-sm">
            <input
              type="checkbox"
              className="checkbox checkbox-sm mt-0.5"
              checked={overlay.jdConfirmedComplete}
              onChange={(event) => void handleConfirm(event.currentTarget.checked)}
            />
            <span>I read the whole job description and it is complete as it stands.</span>
          </label>
        )}

        {error && (
          <ErrorBanner>
            {error}
          </ErrorBanner>
        )}

        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            className="btn btn-primary btn-sm"
            disabled={!cvId || !hasText || busy || savedMatchesText}
            onClick={() => requestReplace({ text, origin, requisition: shownRequisition, fromPaste: false })}
          >
            {overlay ? 'Save changes' : 'Save job description'}
          </button>
          <button type="button" className="btn btn-outline btn-sm" onClick={() => setPasteOpen((open) => !open)}>
            {hasText ? 'Replace job description' : 'Paste job description'}
          </button>
        </div>
        {!cvId && (
          <p className="text-xs text-base-content/60">Select a saved CV above to keep this job description.</p>
        )}

        {savedMatchesText && latest && (
          <p className="text-xs text-base-content/60">
            Saved on {formatCapturedAt(latest.capturedAt)}.
          </p>
        )}
        {overlay && !savedMatchesText && hasText && (
          <p className="text-xs text-base-content/60">
            Saving clears your requirement reviews and approval.
          </p>
        )}

        {pasteOpen && (
          <div className="flex flex-col gap-2">
            <label className="block text-sm font-medium" htmlFor="jd-review-paste">
              Job description text
            </label>
            <textarea
              id="jd-review-paste"
              className="textarea min-h-40 w-full text-sm"
              value={draft}
              onChange={(event) => setDraft(event.currentTarget.value)}
            />
            <label className="block text-sm font-medium" htmlFor="jd-review-requisition">
              Requisition or reference number (optional)
            </label>
            <input
              id="jd-review-requisition"
              type="text"
              className="input input-sm w-full"
              value={draftRequisition}
              onChange={(event) => setDraftRequisition(event.currentTarget.value)}
            />
            <div className="flex gap-2">
              <button
                type="button"
                className="btn btn-primary btn-sm"
                disabled={draft.trim().length === 0}
                onClick={handleUseDraft}
              >
                Use this text
              </button>
              <button type="button" className="btn btn-ghost btn-sm" onClick={() => setPasteOpen(false)}>
                Cancel
              </button>
            </div>
          </div>
        )}
      </div>
      {pendingReplace && (
        <ConfirmDialog
          title="Replace the job description?"
          message={
            <>
              <p className="font-medium text-base-content">
                {[vacancy.title, vacancy.company].filter(Boolean).join(' at ') || 'This job'}
              </p>
              <p className="mt-1">
                Your requirement reviews and the CV approval for this job are cleared. You will review the
                requirements again.
              </p>
            </>
          }
          confirmLabel="Replace and clear reviews"
          cancelLabel="Keep current text"
          onConfirm={() => {
            const change = pendingReplace;
            setPendingReplace(null);
            commitReplace(change);
          }}
          onCancel={() => setPendingReplace(null)}
        />
      )}
    </div>
  );
}
