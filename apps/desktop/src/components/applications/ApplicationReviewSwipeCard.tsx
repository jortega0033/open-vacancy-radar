import { useRef, useState } from 'react';
import type { PointerEvent as ReactPointerEvent } from 'react';
import type { FormReadiness, FormSnapshot } from '@agent-dock/application-executor';
import type { ApplicationArtifactSummary, ApplicationAttemptRecord } from '../../window.js';
import { ApplicationPreparedSummary } from './ApplicationPreparedSummary.js';

export interface ApplicationReviewSwipeCardProps {
  attempt: ApplicationAttemptRecord;
  snapshot: FormSnapshot;
  screenshotBase64: string;
  /** The documents staged against this exact attempt (#272). */
  documents?: readonly ApplicationArtifactSummary[];
  /**
   * What the live form actually holds, read back out of the browser (#277). This card reports
   * `readiness.verifiedFilledCount`, never `snapshot.fields.length` -- see the header comment.
   */
  readiness: FormReadiness;
  /** True while a previous decision on this same card is still being applied -- disables further
   * dragging/buttons so a second swipe can't fire against a request already in flight. */
  busy?: boolean;
  onApprove: () => void;
  onSkip: () => void;
  onOpenArtifact?: (artifactId: string) => void;
  /** Opens the real, focusable page over the app so the person can finish it themselves. */
  onOpenLiveView: () => void;
}

const SWIPE_THRESHOLD_PX = 120;
const MAX_ROTATION_DEG = 12;

/** Plain-language text for one readiness blocker. Field labels and validation messages come from
 * the employer's own page and are rendered as ordinary React children, so they are escaped text
 * rather than markup. */
function describeBlocker(blocker: FormReadiness['blockers'][number]): string {
  switch (blocker.kind) {
    case 'required_field_empty':
      return `"${blocker.label}" is required and still empty.`;
    case 'validation_error':
      return `"${blocker.label}": ${blocker.message}`;
    case 'value_mismatch':
      return `"${blocker.label}" did not keep the value that was entered.`;
    case 'unverified_write':
      return `"${blocker.label}" was filled in, but the page never confirmed what it kept.`;
    case 'attachment_missing':
      return `"${blocker.label}" needs a file and has none attached.`;
    case 'stale_page_state':
      return 'The page changed since this review opened. Reopen it to see the current form.';
    case 'challenge_detected':
      return 'The page is showing a CAPTCHA. Open the live page to complete it yourself.';
  }
}

/**
 * The one-attempt-at-a-time review card issue #202 needed a genuinely fast confirmation step for:
 * a real screenshot of the application page as it currently stands (see the image's own comment
 * below for what that screenshot does and doesn't prove) plus what the form actually holds, decided
 * with a single gesture -- drag right to submit, drag left to skip -- with the same
 * two actions always available as ordinary buttons underneath, since a desktop app has no touch
 * screen to assume and a button is the one interaction every input device and screen reader can
 * reach. The drag is presentation only: it never calls `onApprove`/`onSkip` until released past
 * `SWIPE_THRESHOLD_PX`, and it renders no live-updating text (`aria-live` noise on every pixel of
 * drag would be worse than no live region at all) -- the buttons carry the real accessible names.
 *
 * What this card says about the form comes from `readiness`, never from the snapshot's field count
 * (#277). It used to read "{snapshot.fields.length} fields filled", which was the number of fields
 * the page was *found to have*: it said "9 fields filled" for a form where nothing had been typed
 * at all, and it would have said the same for a page whose every write had been rejected. The
 * number shown now is `verifiedFilledCount` -- fields whose committed value was read back out of
 * the browser and matched -- and the discovered count is shown beside it as the denominator it
 * always was. A screenshot and a field inventory are both still here, and neither one is allowed
 * to contribute to that number.
 *
 * This component never calls `submitReview`/`closeReview` itself: the parent owns that (and the
 * confirmation those calls represent), so it can also own error/loading state shared across cards.
 */
export function ApplicationReviewSwipeCard({
  attempt,
  snapshot,
  screenshotBase64,
  documents = [],
  readiness,
  busy,
  onApprove,
  onSkip,
  onOpenArtifact,
  onOpenLiveView,
}: ApplicationReviewSwipeCardProps) {
  const [dragX, setDragX] = useState(0);
  const dragXRef = useRef(0);
  const dragOriginRef = useRef<number | null>(null);
  const [dragging, setDragging] = useState(false);

  const prepared = attempt.preparedFields;
  const preparedMatchesAttempt = prepared != null && prepared.company === attempt.company && prepared.role === attempt.role;
  const committedCount = preparedMatchesAttempt ? prepared.fields.filter((field) => field.status === 'committed').length : 0;
  const awaitingCount = preparedMatchesAttempt
    ? prepared.fields.filter((field) => field.status === 'awaiting_you' || field.status === 'pending_upload').length
    : 0;
  const { verifiedFilledCount, discoveredFieldCount, requiredFieldCount, requiredFieldsSatisfied, blockers } = readiness;

  function handlePointerDown(event: ReactPointerEvent<HTMLDivElement>) {
    if (busy) return;
    dragOriginRef.current = event.clientX;
    setDragging(true);
    event.currentTarget.setPointerCapture?.(event.pointerId);
  }

  function handlePointerMove(event: ReactPointerEvent<HTMLDivElement>) {
    if (dragOriginRef.current === null) return;
    dragXRef.current = event.clientX - dragOriginRef.current;
    setDragX(dragXRef.current);
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
      if (dragXRef.current > SWIPE_THRESHOLD_PX) onApprove();
      else if (dragXRef.current < -SWIPE_THRESHOLD_PX) onSkip();
    }
    dragXRef.current = 0;
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
              ? `${verifiedFilledCount} verified on page, ${committedCount} prepared by this app, ${awaitingCount} left for you`
              : `${verifiedFilledCount} of ${discoveredFieldCount} field${discoveredFieldCount === 1 ? '' : 's'} verified filled`}
            {requiredFieldCount > 0 ? `, ${requiredFieldsSatisfied} of ${requiredFieldCount} required answered` : ''}
          </p>
        </div>

        <ApplicationPreparedSummary attempt={attempt} documents={documents} onOpenArtifact={onOpenArtifact} />

        {blockers.length > 0 && (
          <div className="border-b border-base-300 bg-warning/10 px-5 py-3">
            <p className="text-xs font-semibold">This form is not ready to submit</p>
            <ul className="mt-1 list-disc pl-4 text-xs text-base-content/70">
              {blockers.map((blocker, index) => (
                // Blocker text includes labels and validation messages the page itself wrote.
                // Rendered as plain React children, so it is escaped text and never markup.
                <li key={`${blocker.kind}-${index}`}>{describeBlocker(blocker)}</li>
              ))}
            </ul>
          </div>
        )}

        {/* The field inventory, kept and shown, but presented for what it is: a list of the
          * controls found on the active form. It is deliberately separate from the verified count
          * above, and collapsed by default, so that reading it can never be mistaken for reading a
          * record of what was filled in (#277). */}
        <details className="border-b border-base-300 px-5 py-2">
          <summary className="cursor-pointer text-xs text-base-content/60">
            Fields found on this form ({snapshot.fields.filter((field) => field.active).length})
          </summary>
          <ul className="mt-2 list-disc pl-4 text-xs text-base-content/60">
            {snapshot.fields
              .filter((field) => field.active)
              .map((field) => (
                <li key={field.fieldRef}>
                  {field.label || 'Unlabelled field'} ({field.controlType}
                  {field.required ? ', required' : ''})
                </li>
              ))}
          </ul>
        </details>

        <div className="bg-base-200">
          {/* A live screenshot of the application page exactly as this review opened it -- not a
           * re-description of it. Note what this is NOT: a screenshot is evidence that the page
           * rendered, and nothing else. It is not evidence that any field holds a value, and since
           * #277 it contributes nothing at all to the verified-filled count above, which comes
           * only from committed values read back out of the browser. Use the live view button
           * below to see and finish the real page yourself whenever this picture is not enough. */}
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
        <button type="button" className="btn btn-success flex-1" disabled={busy || !readiness.ready} onClick={onApprove}>
          {busy ? <span className="loading loading-spinner loading-sm" /> : 'Submit application'}
        </button>
      </div>

      {/* The live handoff. Always offered, not only when something is blocking: signing in, solving
        * a CAPTCHA, or finishing a control this app cannot drive are all things a person may want
        * to do on a form that otherwise looks fine. */}
      <button type="button" className="btn btn-ghost btn-sm" disabled={busy} onClick={onOpenLiveView}>
        Open the live page to finish it yourself
      </button>
    </div>
  );
}
