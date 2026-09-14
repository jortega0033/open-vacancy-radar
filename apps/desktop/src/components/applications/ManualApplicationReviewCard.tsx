import { useRef, useState } from 'react';
import type { PointerEvent as ReactPointerEvent } from 'react';
import { ArrowLeft, ArrowRight, ArrowsLeftRight } from '@phosphor-icons/react';
import type { ApplicationArtifactSummary, ApplicationAttemptRecord } from '../../window.js';

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
}

const SWIPE_THRESHOLD_PX = 120;

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
}: ManualApplicationReviewCardProps) {
  const [dragX, setDragX] = useState(0);
  const originRef = useRef<number | null>(null);
  const dragXRef = useRef(0);
  const letterBlocked =
    !documents.some(
      (document) => document.kind === 'cover_letter_pdf' || document.kind === 'combined_pdf',
    ) && /\b(?:cover|motivation) letter\b/iu.test(attempt.checkpointDetail);

  function endDrag() {
    if (originRef.current === null) return;
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
        <div
          data-testid="manual-application-swipe-card"
          role="group"
          aria-label={`Application decision card for ${attempt.role} at ${attempt.company}`}
          title="Drag left to skip or right to continue"
          className={`relative z-10 col-start-1 row-start-1 mx-2 select-none overflow-hidden rounded-lg border border-base-300 bg-base-100 shadow-xl ${busy ? 'cursor-wait' : 'cursor-grab active:cursor-grabbing'}`}
          style={{
            transform: `translateX(${dragX}px) rotate(${Math.max(-12, Math.min(12, dragX / 10))}deg)`,
            transition: originRef.current === null ? 'transform 200ms ease-out' : 'none',
            touchAction: 'pan-y',
          }}
          onPointerDown={(event: ReactPointerEvent<HTMLDivElement>) => {
            if (busy) return;
            originRef.current = event.clientX;
            event.currentTarget.setPointerCapture?.(event.pointerId);
          }}
          onPointerMove={(event) => {
            if (originRef.current !== null) {
              dragXRef.current = event.clientX - originRef.current;
              setDragX(dragXRef.current);
            }
          }}
          onPointerUp={endDrag}
          onPointerCancel={endDrag}
        >
          <div
            aria-hidden="true"
            className="mx-auto mt-2 h-1 w-7 rounded-full bg-base-content/20"
          />
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

          <div className="border-b border-base-300 px-5 py-3.5">
            <div className="badge badge-outline badge-sm mb-2">Manual application</div>
            <h2 className="text-sm font-semibold">
              {attempt.role} <span className="text-base-content/60">at</span> {attempt.company}
            </h2>
            <p className="mt-1 text-xs text-base-content/60">
              {letterBlocked
                ? 'This site is not approved for automated submission. Your tailored CV is ready, but the letter still needs attention.'
                : 'This site is not approved for automated submission. Your documents are ready for you to use on the employer site.'}
            </p>
          </div>

          {attempt.checkpointDetail && (
            <div className="border-b border-base-300 bg-warning/10 px-5 py-3 text-xs text-base-content/70">
              {attempt.checkpointDetail}
            </div>
          )}

          <div className="space-y-2 px-5 py-4">
            <p className="text-xs font-semibold uppercase text-base-content/60">
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
                    <p className="truncate text-xs text-base-content/60">{document.fileName}</p>
                  </div>
                  <div className="flex gap-1">
                    <button
                      type="button"
                      className="btn btn-ghost btn-xs"
                      onClick={() => onOpenArtifact(document.id)}
                    >
                      Review
                    </button>
                    <button
                      type="button"
                      className="btn btn-outline btn-xs"
                      onClick={() => onSaveArtifact(document.id)}
                    >
                      Save copy
                    </button>
                  </div>
                </div>
              ))
            )}
          </div>

          <div
            data-testid="manual-swipe-guidance"
            className="grid grid-cols-[1fr_auto_1fr] items-center border-t border-base-300 bg-base-100 px-4 py-2 text-xs font-semibold"
          >
            <span className="flex items-center gap-1 text-base-content/60">
              <ArrowLeft size={15} weight="bold" aria-hidden="true" />
              Skip
            </span>
            <ArrowsLeftRight
              size={20}
              weight="bold"
              className="text-base-content/45"
              aria-hidden="true"
            />
            <span className="flex items-center justify-self-end gap-1 text-success">
              Continue
              <ArrowRight size={15} weight="bold" aria-hidden="true" />
            </span>
          </div>
        </div>
      </div>

      {letterBlocked && onGenerateLetter && (
        <button
          type="button"
          className="btn btn-primary w-full"
          disabled={busy}
          onClick={onGenerateLetter}
        >
          Generate letter
        </button>
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
            Continue on employer site
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
            Still in progress
          </button>
          <button
            type="button"
            className="btn btn-success flex-1"
            disabled={busy}
            onClick={onMarkApplied}
          >
            Mark as applied externally
          </button>
        </div>
      )}
    </div>
  );
}
