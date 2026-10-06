import { useRef, useState } from 'react';
import type { PointerEvent as ReactPointerEvent } from 'react';
import type { ApplicationArtifactSummary, ApplicationAttemptRecord } from '../../window.js';
import { usePrefersReducedMotion } from '../../use-prefers-reduced-motion.js';
import { describeLetterBlocker } from './letter-blocker.js';
import { SWIPE_GESTURES_ENABLED } from './swipe-gestures.js';
import { retryLabel, useWaitingForReset } from './provider-reset.js';

export interface ManualApplicationReviewCardProps {
  attempt: ApplicationAttemptRecord;
  documents: readonly ApplicationArtifactSummary[];
  busy: boolean;
  continued: boolean;
  onContinue: () => void;
  onSkip: () => void;
  onMarkApplied: () => void;
  onStillInProgress: () => void;
  onSaveArtifact: (artifactId: string) => void;
  onOpenArtifact: (artifactId: string) => void;
  onGenerateLetter?: () => void;
  /** Runs preparation again so the cover letter is retried. Shown only when the letter is missing. */
  onRetryLetter?: () => void;
}

const SWIPE_THRESHOLD_PX = 120;
const INTERACTIVE_SELECTOR = 'button, a, input, select, textarea, summary, [role="button"]';

const DOCUMENT_LABEL: Record<ApplicationArtifactSummary['kind'], string> = {
  cv_pdf: 'Tailored CV',
  cover_letter_pdf: 'Cover letter',
  combined_pdf: 'Combined document',
  other: 'Application document',
};

export function ManualApplicationReviewCard({
  attempt,
  documents,
  busy,
  continued,
  onContinue,
  onSkip,
  onMarkApplied,
  onStillInProgress,
  onSaveArtifact,
  onOpenArtifact,
  onGenerateLetter,
  onRetryLetter,
}: ManualApplicationReviewCardProps) {
  const [dragX, setDragX] = useState(0);
  const reducedMotion = usePrefersReducedMotion();
  const originRef = useRef<number | null>(null);
  const dragXRef = useRef(0);
  const letterBlocked =
    !documents.some(
      (document) => document.kind === 'cover_letter_pdf' || document.kind === 'combined_pdf',
    ) && /\b(?:cover|motivation) letter\b/iu.test(attempt.checkpointDetail);
  const letterBlocker = letterBlocked ? describeLetterBlocker(attempt.checkpointDetail, attempt.updatedAt) : null;
  const waitingForReset = useWaitingForReset(letterBlocker?.limit?.resetAt);
  const letterReason = letterBlocker?.message ?? 'The cover letter still needs attention.';

  function endDrag() {
    if (!SWIPE_GESTURES_ENABLED || originRef.current === null) return;
    originRef.current = null;
    if (!busy) {
      if (dragXRef.current > SWIPE_THRESHOLD_PX) onContinue();
      else if (dragXRef.current < -SWIPE_THRESHOLD_PX) onSkip();
    }
    dragXRef.current = 0;
    setDragX(0);
  }

  return (
    <div className="mx-auto flex w-full max-w-sm flex-col gap-3">
      <div className="-mx-2 grid overflow-x-clip px-4 pb-2 pt-3">
        {SWIPE_GESTURES_ENABLED ? (
          <>
        <div
          aria-hidden="true"
          data-testid="manual-swipe-card-back"
          className="pointer-events-none col-start-1 row-start-1 mx-6 translate-y-2 rotate-[-2deg] rounded-lg border border-base-300 bg-base-300/70"
        />
        <div
          aria-hidden="true"
          data-testid="manual-swipe-card-back"
          className="pointer-events-none col-start-1 row-start-1 mx-4 translate-y-1 rotate-[2deg] rounded-lg border border-base-300 bg-base-200"
        />
          </>
        ) : null}
        <div
          data-testid="manual-application-swipe-card"
          role="group"
          aria-label={`Application decision card for ${attempt.role} at ${attempt.company}`}
          className={`relative z-10 col-start-1 row-start-1 mx-2 ${SWIPE_GESTURES_ENABLED ? 'select-none' : ''} overflow-hidden rounded-lg border border-base-300 bg-base-100 shadow-xl ${SWIPE_GESTURES_ENABLED ? (busy ? 'cursor-wait' : 'cursor-grab active:cursor-grabbing') : ''}`}
          style={SWIPE_GESTURES_ENABLED ? {
            transform: reducedMotion
              ? `translateX(${dragX}px)`
              : `translateX(${dragX}px) rotate(${Math.max(-12, Math.min(12, dragX / 10))}deg)`,
            transition: !reducedMotion && originRef.current === null ? 'transform 200ms ease-out' : 'none',
            touchAction: 'pan-y',
          } : undefined}
          onPointerDown={!SWIPE_GESTURES_ENABLED ? undefined : (event: ReactPointerEvent<HTMLDivElement>) => {
            // A press on a control inside the card is a click, not a drag. Capturing it would send
            // the click to the card instead, so Review and Save copy did nothing (#565).
            if (busy || (event.target as Element).closest?.(INTERACTIVE_SELECTOR)) return;
            originRef.current = event.clientX;
            event.currentTarget.setPointerCapture?.(event.pointerId);
          }}
          onPointerMove={!SWIPE_GESTURES_ENABLED ? undefined : (event) => {
            if (originRef.current !== null) {
              dragXRef.current = event.clientX - originRef.current;
              setDragX(dragXRef.current);
            }
          }}
          onPointerUp={SWIPE_GESTURES_ENABLED ? endDrag : undefined}
          onPointerCancel={SWIPE_GESTURES_ENABLED ? endDrag : undefined}
        >
          {SWIPE_GESTURES_ENABLED ? <div aria-hidden="true" className="mx-auto mt-2 h-1 w-7 rounded-full bg-base-content/20" /> : null}
          {SWIPE_GESTURES_ENABLED ? (
            <>
          <span
            className="badge badge-success absolute left-4 top-4 z-10 rotate-[-8deg] font-semibold"
            style={{ opacity: Math.min(1, Math.max(0, dragX / SWIPE_THRESHOLD_PX)) }}
            aria-hidden="true"
          >
            Continue
          </span>
          <span
            className="badge badge-neutral absolute right-4 top-4 z-10 rotate-[8deg] font-semibold"
            style={{ opacity: Math.min(1, Math.max(0, -dragX / SWIPE_THRESHOLD_PX)) }}
            aria-hidden="true"
          >
            Skip
          </span>
            </>
          ) : null}

          <div className="border-b border-base-300 px-5 py-3.5">
            <h2 className="text-sm font-semibold">
              {attempt.role} <span className="text-base-content/60">at</span> {attempt.company}
            </h2>
            <p className="mt-1 text-xs text-base-content/60">
              {letterBlocked
                ? attempt.checkpointDetail.includes('Your CV was prepared without any skills.')
                  ? `Your CV has no skills to match this vacancy. ${letterReason}`
                  : `Your CV is ready. ${letterReason}`
                : 'You send this one yourself. Your documents are ready.'}
            </p>
            {letterBlocker?.detail ? (
              <details className="mt-1 text-xs text-base-content/60">
                <summary className="cursor-pointer">Details</summary>
                <p className="mt-1 break-words">{letterBlocker.detail}</p>
              </details>
            ) : null}
          </div>

          <div className="space-y-2 px-5 py-4">
            <p className="ovr-eyebrow">
              Prepared documents
            </p>
            {documents.length === 0 ? (
              <p className="text-sm text-base-content/60">No document is ready yet.</p>
            ) : (
              documents.map((document) => (
                <div
                  key={document.id}
                  className="flex items-center justify-between gap-3 rounded-box border border-base-300 px-3 py-2"
                >
                  <div className="min-w-0">
                    <p className="text-sm font-medium">{DOCUMENT_LABEL[document.kind]}</p>
                  </div>
                  <div className="flex gap-1">
                    <button
                      type="button"
                      className="btn btn-ghost btn-sm"
                      onClick={() => onOpenArtifact(document.id)}
                    >
                      Review
                    </button>
                    <button
                      type="button"
                      className="btn btn-outline btn-sm"
                      onClick={() => onSaveArtifact(document.id)}
                    >
                      Save copy
                    </button>
                  </div>
                </div>
              ))
            )}
          </div>

        </div>
      </div>

      {letterBlocked && (onGenerateLetter || onRetryLetter) && (
        <div className="flex gap-3">
          {onRetryLetter && (
            <button
              type="button"
              className="btn btn-outline flex-1"
              disabled={busy || waitingForReset}
              onClick={onRetryLetter}
            >
              {retryLabel(letterBlocker?.limit, waitingForReset, 'Try again')}
            </button>
          )}
          {onGenerateLetter && (
            <button
              type="button"
              className="btn btn-primary flex-1"
              disabled={busy}
              onClick={onGenerateLetter}
            >
              Generate letter
            </button>
          )}
        </div>
      )}

      {!continued ? (
        <div className="flex gap-3">
          <button type="button" className="btn btn-outline flex-1" disabled={busy} onClick={onSkip}>
            Skip
          </button>
          <button
            type="button"
            className="btn btn-success flex-1"
            disabled={busy}
            onClick={onContinue}
          >
            Open the posting
          </button>
        </div>
      ) : (
        <div className="flex gap-3">
          <button
            type="button"
            className="btn btn-outline flex-1"
            disabled={busy}
            onClick={onStillInProgress}
          >
            Not yet
          </button>
          <button
            type="button"
            className="btn btn-success flex-1"
            disabled={busy}
            onClick={onMarkApplied}
          >
            I applied
          </button>
        </div>
      )}
    </div>
  );
}
