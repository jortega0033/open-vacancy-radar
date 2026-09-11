import { useRef, useState } from 'react';
import type { PointerEvent as ReactPointerEvent } from 'react';
import type { FormSnapshot } from '@agent-dock/application-executor';
import type { ApplicationArtifactRecord, ApplicationAttemptRecord } from '../../window.js';
import { ApplicationPreparedSummary } from './ApplicationPreparedSummary.js';

export interface ApplicationReviewSwipeCardProps {
  attempt: ApplicationAttemptRecord;
  snapshot: FormSnapshot;
  screenshotBase64: string;
  /** The documents staged against this exact attempt (#272). */
  documents: readonly ApplicationArtifactRecord[];
  /** True while a previous decision on this same card is still being applied -- disables further
   * dragging/buttons so a second swipe can't fire against a request already in flight. */
  busy?: boolean;
  onApprove: () => void;
  onSkip: () => void;
}

const SWIPE_THRESHOLD_PX = 120;
const MAX_ROTATION_DEG = 12;

/**
 * The one-attempt-at-a-time review card issue #202 needed a genuinely fast confirmation step for:
 * a real screenshot of the application page as it currently stands (see the image's own comment
 * below for what that screenshot does and doesn't prove) plus a plain field count, decided with a
 * single gesture -- drag right to submit, drag left to skip -- with the same
 * two actions always available as ordinary buttons underneath, since a desktop app has no touch
 * screen to assume and a button is the one interaction every input device and screen reader can
 * reach. The drag is presentation only: it never calls `onApprove`/`onSkip` until released past
 * `SWIPE_THRESHOLD_PX`, and it renders no live-updating text (`aria-live` noise on every pixel of
 * drag would be worse than no live region at all) -- the buttons carry the real accessible names.
 *
 * This component never calls `submitReview`/`closeReview` itself: the parent owns that (and the
 * confirmation those calls represent), so it can also own error/loading state shared across cards.
 */
export function ApplicationReviewSwipeCard({
  attempt,
  snapshot,
  screenshotBase64,
  documents,
  busy,
  onApprove,
  onSkip,
}: ApplicationReviewSwipeCardProps) {
  const [dragX, setDragX] = useState(0);
  const dragOriginRef = useRef<number | null>(null);
  const [dragging, setDragging] = useState(false);

  // Deliberately counts what this app recorded committing, not how many fields the page happens to
  // have: the old "N fields filled" line counted *discovered* controls and called them filled,
  // which is the exact claim issue #277 flagged as unfounded. A field count with no prepared record
  // behind it says nothing, so nothing is said.
  const prepared = attempt.preparedFields;
  const preparedMatchesAttempt = prepared !== null && prepared.company === attempt.company && prepared.role === attempt.role;
  const committedCount = preparedMatchesAttempt ? prepared.fields.filter((field) => field.status === 'committed').length : 0;
  const awaitingCount = preparedMatchesAttempt
    ? prepared.fields.filter((field) => field.status === 'awaiting_you' || field.status === 'pending_upload').length
    : 0;
  const fieldCount = snapshot.fields.length;

  function handlePointerDown(event: ReactPointerEvent<HTMLDivElement>) {
    if (busy) return;
    dragOriginRef.current = event.clientX;
    setDragging(true);
    event.currentTarget.setPointerCapture(event.pointerId);
  }

  function handlePointerMove(event: ReactPointerEvent<HTMLDivElement>) {
    if (dragOriginRef.current === null) return;
    setDragX(event.clientX - dragOriginRef.current);
  }

  function endDrag() {
    if (dragOriginRef.current === null) return;
    dragOriginRef.current = null;
    setDragging(false);
    // Re-checked here, not just at drag start: a decision triggered elsewhere (the button click
    // this same card renders) could turn `busy` true while a drag begun before it is still in
    // progress. Without this, releasing that drag past the threshold would fire a second
    // approve/skip on top of the one already in flight.
    if (!busy) {
      if (dragX > SWIPE_THRESHOLD_PX) onApprove();
      else if (dragX < -SWIPE_THRESHOLD_PX) onSkip();
    }
    setDragX(0);
  }

  const rotation = Math.max(-MAX_ROTATION_DEG, Math.min(MAX_ROTATION_DEG, dragX / 10));
  const approveOpacity = Math.min(1, Math.max(0, dragX / SWIPE_THRESHOLD_PX));
  const skipOpacity = Math.min(1, Math.max(0, -dragX / SWIPE_THRESHOLD_PX));

  return (
    <div className="mx-auto flex w-full max-w-md flex-col gap-4">
      <div
        className="relative select-none overflow-hidden rounded-box border border-base-300 bg-base-100 shadow-lg"
        style={{
          transform: `translateX(${dragX}px) rotate(${rotation}deg)`,
          transition: dragging ? 'none' : 'transform 200ms ease-out',
          touchAction: 'pan-y',
        }}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
      >
        <div
          className="badge badge-success absolute left-4 top-4 z-10 rotate-[-8deg] text-sm font-semibold"
          style={{ opacity: approveOpacity }}
          aria-hidden="true"
        >
          Submit
        </div>
        <div
          className="badge badge-neutral absolute right-4 top-4 z-10 rotate-[8deg] text-sm font-semibold"
          style={{ opacity: skipOpacity }}
          aria-hidden="true"
        >
          Skip
        </div>

        <div className="border-b border-base-300 px-5 py-3.5">
          <h2 className="text-sm font-semibold">
            {attempt.role} <span className="text-base-content/60">at</span> {attempt.company}
          </h2>
          <p className="text-xs text-base-content/60">
            {preparedMatchesAttempt
              ? `${committedCount} answer${committedCount === 1 ? '' : 's'} filled by this app, ${awaitingCount} left for you`
              : `${fieldCount} field${fieldCount === 1 ? '' : 's'} on this page, none filled by this app`}
          </p>
        </div>

        <ApplicationPreparedSummary attempt={attempt} documents={documents} />

        <div className="bg-base-200">
          {/* A live screenshot of the application page exactly as this review opened it -- not a
           * re-description of it. Since #272 there IS a wired path that tailors the documents and
           * applies a validated field map before a review opens, and what it committed is listed
           * above, straight off this attempt's own record. What the screenshot still does not prove
           * is that each of those values is committed *on the page* right now: reading the live
           * form back to confirm that is issue #277's work, not something this image establishes.
           * Check the page itself against the list above before submitting. */}
          <img
            src={`data:image/png;base64,${screenshotBase64}`}
            alt={`Live application page preview for ${attempt.role} at ${attempt.company}`}
            className="w-full"
            draggable={false}
          />
        </div>
      </div>

      <div className="flex gap-3">
        <button type="button" className="btn btn-outline flex-1" disabled={busy} onClick={onSkip}>
          Skip
        </button>
        <button type="button" className="btn btn-success flex-1" disabled={busy} onClick={onApprove}>
          {busy ? <span className="loading loading-spinner loading-sm" /> : 'Submit application'}
        </button>
      </div>
    </div>
  );
}
