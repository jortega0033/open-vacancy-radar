import { useRef, useState } from 'react';
import type { PointerEvent as ReactPointerEvent } from 'react';
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
}: ManualApplicationReviewCardProps) {
  const [dragX, setDragX] = useState(0);
  const originRef = useRef<number | null>(null);
  const dragXRef = useRef(0);

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
    <div className="mx-auto flex w-full max-w-md flex-col gap-4">
      <div
        className="relative select-none overflow-hidden rounded-box border border-base-300 bg-base-100 shadow-lg"
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
            This site is not approved for automated submission. Your documents are ready for you to use on the employer site.
          </p>
        </div>

        {attempt.checkpointDetail && (
          <div className="border-b border-base-300 bg-warning/10 px-5 py-3 text-xs text-base-content/70">
            {attempt.checkpointDetail}
          </div>
        )}

        <div className="space-y-2 px-5 py-4">
          <p className="text-xs font-semibold uppercase text-base-content/60">Prepared documents</p>
          {documents.length === 0 ? (
            <p className="text-sm text-base-content/60">No document is ready yet.</p>
          ) : (
            documents.map((document) => (
              <div key={document.id} className="flex items-center justify-between gap-3 rounded-box border border-base-300 px-3 py-2">
                <div className="min-w-0">
                  <p className="text-sm font-medium">{DOCUMENT_LABEL[document.kind]}</p>
                  <p className="truncate text-xs text-base-content/60">{document.fileName}</p>
                </div>
                <div className="flex gap-1">
                  <button type="button" className="btn btn-ghost btn-xs" onClick={() => onOpenArtifact(document.id)}>
                    Review
                  </button>
                  <button type="button" className="btn btn-outline btn-xs" onClick={() => onSaveArtifact(document.id)}>
                    Save copy
                  </button>
                </div>
              </div>
            ))
          )}
        </div>
      </div>

      {!continued ? (
        <div className="flex gap-3">
          <button type="button" className="btn btn-outline flex-1" disabled={busy} onClick={onSkip}>
            Skip
          </button>
          <button type="button" className="btn btn-success flex-1" disabled={busy} onClick={onContinue}>
            Continue on employer site
          </button>
        </div>
      ) : (
        <div className="flex gap-3">
          <button type="button" className="btn btn-outline flex-1" disabled={busy} onClick={onStillInProgress}>
            Still in progress
          </button>
          <button type="button" className="btn btn-success flex-1" disabled={busy} onClick={onMarkApplied}>
            Mark as applied externally
          </button>
        </div>
      )}
    </div>
  );
}
