import { useEffect, useRef, useState } from 'react';
import type { PointerEvent as ReactPointerEvent } from 'react';
import { ArrowLeft, ArrowRight, ArrowsLeftRight } from '@phosphor-icons/react';
import type { FormReadiness, FormSnapshot, SnapshotField } from '@agent-dock/application-executor';
import type { ApplicationAnswerRecord, ApplicationArtifactSummary, ApplicationAttemptRecord, ConfirmApplicationAnswerResult } from '../../window.js';
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
  /** Commits one confirmed answer into a live `awaiting_you` text/textarea field (#372). Passed
   * straight through to `ApplicationPreparedSummary`; its absence keeps every such field read-only. */
  onConfirmAnswer?: (fieldIndex: number, fieldRef: string, value: string) => Promise<ConfirmApplicationAnswerResult>;
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
 * Every field the executor found in a document whose origin is not the page's own: a support-chat
 * widget, an ad slot, a vendor script, and equally the shape where the entire application form is
 * served by an applicant-tracking vendor inside an `<iframe>` (#277's follow-up). Keyed on
 * `frameOrigin !== topFrameOrigin`, the same comparison the write path itself makes
 * (`isFrameFillAllowed` in `application-executor`), and deliberately *not* on `!field.active`.
 *
 * Keying on `!active` is what the first version of this did, and it was blind in exactly the case
 * the notice exists for. `resolveActiveGroup` drops every group the policy will not authorize a
 * write into, but when that leaves no eligible group at all it keeps the count-based dominant group
 * anyway -- so a page whose only form lives inside a disallowed embed reports those fields with
 * `active: true`. The write is still refused at `fill()`, loudly; it was only this notice that
 * vanished, on the one page shape most in need of it. `active` therefore chooses the wording here,
 * never the filter: see `describeCrossOriginField`.
 *
 * Deliberately not a `FormReadiness` blocker: `form-readiness.ts` only ever looks at `active`
 * fields, so an excluded field contributes nothing to `blockers` at all, and a reviewer would see
 * no sign it existed. Computed here from `snapshot.fields`/`topFrameOrigin` rather than inside the
 * executor package -- purely additive visibility over data the snapshot already carries, not a new
 * refusal decision.
 */
function crossOriginFields(snapshot: FormSnapshot): SnapshotField[] {
  const { topFrameOrigin } = snapshot;
  if (!topFrameOrigin) return [];
  return snapshot.fields.filter((field) => field.frameOrigin !== undefined && field.frameOrigin !== topFrameOrigin);
}

/**
 * Plain-language text for one field `crossOriginFields` found, distinct from every
 * `describeBlocker` case above: this is not a form check that failed.
 *
 * Two genuinely different situations, told apart by `active`, because saying the wrong one is
 * worse than saying nothing:
 *  - `active: true` -- the form under review is itself inside the embed. Today the only way a
 *    snapshot reaches that state is the no-eligible-group fallback described on
 *    `crossOriginFields`, which means the policy refused every group, so nothing was typed here.
 *  - `active: false` -- the field is somewhere else on the page and is not part of the form under
 *    review. That covers an ordinary third-party widget and equally a vendor embed the policy
 *    *does* allowlist but which is not the winning group, so this wording says "not the form"
 *    rather than claiming a policy refusal the snapshot alone cannot establish.
 *
 * What this cannot see: neither a policy's `origins` allowlist nor its `allowedSubFrameOrigins`
 * crosses the IPC bridge, so "active plus a foreign origin" is read as not fillable. That is exact
 * for every policy this app ships today (`FIXTURE_REVIEW_POLICY` has `origins: []` and no
 * `allowedSubFrameOrigins`), and the day a real policy authorizes a sub-origin through either
 * mechanism, this needs that policy's allowed origins passed in rather than inferred.
 */
function describeCrossOriginField(field: SnapshotField, topFrameOrigin: string): string {
  const label = field.label || 'Unlabelled field';
  if (field.active) {
    return `"${label}" is part of a form embedded from ${field.frameOrigin}, which is not this page's own address (${topFrameOrigin}). This app does not type into a third-party embed, so nothing was entered here.`;
  }
  return `"${label}" was found in a different frame (${field.frameOrigin}) than this page (${topFrameOrigin}) and is not part of the form under review, so it was left untouched.`;
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
  onConfirmAnswer,
}: ApplicationReviewSwipeCardProps) {
  const [dragX, setDragX] = useState(0);
  const dragXRef = useRef(0);
  const dragOriginRef = useRef<number | null>(null);
  const [dragging, setDragging] = useState(false);
  /** The reusable answer library (#372), fetched once per card mount -- this is a small,
   * personal-scale list, so one plain fetch rather than a subscription. `undefined` (not `[]`)
   * while unloaded, so `ApplicationPreparedSummary` can tell "still loading" from "loaded, empty"
   * and never flashes "no saved answer" before the real list has even arrived. */
  const [savedAnswers, setSavedAnswers] = useState<ApplicationAnswerRecord[]>();

  useEffect(() => {
    let cancelled = false;
    if (!onConfirmAnswer) return;
    void window.workspace
      .listApplicationAnswers()
      .then((rows) => {
        if (!cancelled) setSavedAnswers(rows);
      })
      .catch(() => {
        // A failed read here only means suggestions stay unavailable for this review -- it must
        // never block filling the field manually, so this is silent rather than surfaced as an
        // error over the whole card.
        if (!cancelled) setSavedAnswers([]);
      });
    return () => {
      cancelled = true;
    };
  }, [onConfirmAnswer]);

  async function handleSaveAnswer(input: { label: string; controlType: 'text' | 'textarea'; answer: string }) {
    const saved = await window.workspace.saveApplicationAnswer({
      ...input,
      originCompany: attempt.company,
      originRole: attempt.role,
    });
    // Reflects the save immediately (an upsert may have replaced an existing row's text/timestamps
    // without changing its id), so a second awaiting-you field with the same normalized key -- or
    // this same one, if the person edits and saves again -- sees the fresh answer without a refetch.
    setSavedAnswers((current) => {
      const rest = (current ?? []).filter((row) => row.id !== saved.id);
      return [saved, ...rest];
    });
  }

  const { verifiedFilledCount, discoveredFieldCount, requiredFieldCount, requiredFieldsSatisfied, blockers } = readiness;
  const canSubmit = readiness.ready && !busy;
  const otherFrameFields = crossOriginFields(snapshot);
  // True on the page shape the whole notice exists for: the form under review is itself inside an
  // embed from somewhere else. The heading has to say that outright, because "also found in a
  // different frame" would read as an aside about something unimportant on exactly the page where
  // it is the form.
  const formIsEmbedded = otherFrameFields.some((field) => field.active);
  // The one field whose sentence the heading and the collapsed summary both speak about. Prefers an
  // active field over an inactive one -- not just "the first field in snapshot order" -- so a
  // page mixing an ordinary inactive widget (a chat box, say) with the actual embedded form never
  // shows the "third-party embed" heading next to a sentence that's really about the chat box.
  // Picked once and reused by identity (not by array index) everywhere below, so the field promoted
  // into the one-sentence summary is never also duplicated in the expanded list.
  const summarizedFrameField = otherFrameFields.find((field) => field.active) ?? otherFrameFields[0];

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
      if (dragXRef.current > SWIPE_THRESHOLD_PX && canSubmit) onApprove();
      else if (dragXRef.current < -SWIPE_THRESHOLD_PX) onSkip();
    }
    dragXRef.current = 0;
    setDragX(0);
  }

  const rotation = Math.max(-MAX_ROTATION_DEG, Math.min(MAX_ROTATION_DEG, dragX / 10));
  const approveOpacity = canSubmit ? Math.min(1, Math.max(0, dragX / SWIPE_THRESHOLD_PX)) : 0;
  const skipOpacity = Math.min(1, Math.max(0, -dragX / SWIPE_THRESHOLD_PX));
  const activeFields = snapshot.fields.filter((field) => field.active);

  return (
    <div className="mx-auto flex w-full max-w-sm flex-col gap-3">
      <div className="-mx-2 grid overflow-x-clip px-4 pb-2 pt-3">
      <div aria-hidden="true" data-testid="swipe-card-back" className="pointer-events-none col-start-1 row-start-1 mx-6 translate-y-2 rotate-[-2deg] rounded-lg border border-base-300 bg-base-300/70" />
      <div aria-hidden="true" data-testid="swipe-card-back" className="pointer-events-none col-start-1 row-start-1 mx-4 translate-y-1 rotate-[2deg] rounded-lg border border-base-300 bg-base-200" />
      <div
        data-testid="application-swipe-card"
        role="group"
        aria-label={`Application decision card for ${attempt.role} at ${attempt.company}`}
        title="Drag left to skip or right to submit"
        className={`relative z-10 col-start-1 row-start-1 mx-2 select-none overflow-hidden rounded-lg border border-base-300 bg-base-100 shadow-xl ${busy ? 'cursor-wait' : 'cursor-grab active:cursor-grabbing'}`}
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
        <div aria-hidden="true" className="mx-auto mt-2 h-1 w-7 rounded-full bg-base-content/20" />
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

        <div className="px-4 py-3">
          <div className="mb-2 flex items-center justify-between gap-3">
            <span className={`badge badge-sm ${readiness.ready ? 'badge-success' : 'badge-warning badge-soft'}`}>
              {readiness.ready ? 'Ready for review' : 'Needs your input'}
            </span>
            <span className="text-xs text-base-content/50">Final submission is always yours</span>
          </div>
          <h2 className="text-base font-semibold leading-snug">
            {attempt.role} <span className="text-base-content/60">at</span> {attempt.company}
          </h2>
          <p className="mt-1 text-xs text-base-content/60">
            {verifiedFilledCount} of {discoveredFieldCount} field{discoveredFieldCount === 1 ? '' : 's'} verified filled
          </p>
        </div>

        <div className="grid grid-cols-3 divide-x divide-base-300 border-y border-base-300 bg-base-200/60">
          <div className="px-3 py-2.5 text-center">
            <p className="text-lg font-semibold leading-none">{verifiedFilledCount}</p>
            <p className="mt-1 text-xs text-base-content/60">Verified</p>
          </div>
          <div className="px-3 py-2.5 text-center">
            <p className="text-lg font-semibold leading-none">{documents.length}</p>
            <p className="mt-1 text-xs text-base-content/60">Documents</p>
          </div>
          <div className="px-3 py-2.5 text-center">
            <p className="text-lg font-semibold leading-none">{blockers.length}</p>
            <p className="mt-1 text-xs text-base-content/60">Checks left</p>
          </div>
        </div>

        <div className={`px-4 py-3 ${readiness.ready ? 'bg-success/10' : 'bg-warning/10'}`}>
          {blockers.length > 0 ? (
            <>
              <p className="text-xs font-semibold">This form is not ready to submit</p>
              <p className="mt-1 text-xs text-base-content/70">{describeBlocker(blockers[0]!)}</p>
              {blockers.length > 1 ? <p className="mt-1 text-xs font-medium">+{blockers.length - 1} more in form checks</p> : null}
            </>
          ) : (
            <>
              <p className="text-xs font-semibold">Ready for your final confirmation</p>
              <p className="mt-1 text-xs text-base-content/70">
                {requiredFieldCount > 0
                  ? `${requiredFieldsSatisfied} of ${requiredFieldCount} required answers verified.`
                  : `${verifiedFilledCount} of ${discoveredFieldCount} fields verified filled.`}
              </p>
            </>
          )}
        </div>

        {otherFrameFields.length > 0 ? (
          <div className="border-t border-base-300 bg-info/10 px-4 py-3">
            <p className="text-xs font-semibold">
              {formIsEmbedded ? 'This form is inside a third-party embed' : 'Also found in a different frame, not filled automatically'}
            </p>
            <p className="mt-1 text-xs text-base-content/70">
              {describeCrossOriginField(summarizedFrameField!, snapshot.topFrameOrigin!)}
            </p>
            {otherFrameFields.length > 1 ? (
              <p className="mt-1 text-xs font-medium">+{otherFrameFields.length - 1} more in another frame</p>
            ) : null}
          </div>
        ) : null}

        <div className="grid grid-cols-[1fr_auto_1fr] items-center border-t border-base-300 bg-base-100 px-4 py-2 text-xs font-semibold">
          <span className="flex items-center gap-1 text-base-content/60"><ArrowLeft size={15} weight="bold" aria-hidden="true" />Skip</span>
          <ArrowsLeftRight size={20} weight="bold" className="text-base-content/45" aria-hidden="true" />
          <span className={`flex items-center justify-self-end gap-1 ${canSubmit ? 'text-success' : 'text-base-content/30'}`}>Submit<ArrowRight size={15} weight="bold" aria-hidden="true" /></span>
        </div>
      </div>
      </div>

      <div className="grid grid-cols-2 gap-3">
        <button type="button" className="btn btn-outline flex-1" disabled={busy} onClick={onSkip}>
          Skip
        </button>
        <button type="button" className="btn btn-success flex-1" disabled={!canSubmit} onClick={onApprove}>
          {busy ? <span className="loading loading-spinner loading-sm" /> : 'Submit application'}
        </button>
      </div>

      <details className="rounded-lg border border-base-300 bg-base-100">
        <summary className="cursor-pointer px-4 py-2.5 text-sm font-medium">Prepared application details</summary>
        <ApplicationPreparedSummary
          attempt={attempt}
          documents={documents}
          onOpenArtifact={onOpenArtifact}
          snapshot={snapshot}
          savedAnswers={savedAnswers}
          onConfirmAnswer={onConfirmAnswer}
          onSaveAnswer={onConfirmAnswer ? handleSaveAnswer : undefined}
        />
      </details>

      <details className="rounded-lg border border-base-300 bg-base-100">
        <summary className="cursor-pointer px-4 py-2.5 text-sm font-medium">
          Form checks ({blockers.length}) and fields ({activeFields.length})
          {otherFrameFields.length > 0 ? `, ${otherFrameFields.length} in another frame` : ''}
        </summary>
        <div className="border-t border-base-300 px-4 py-3">
          {blockers.length > 1 ? (
            <ul className="list-disc space-y-1 pl-4 text-xs text-base-content/70">
              {blockers.slice(1).map((blocker, index) => (
                <li key={`${blocker.kind}-${index + 1}`}>{describeBlocker(blocker)}</li>
              ))}
            </ul>
          ) : (
            <p className="text-xs text-base-content/60">
              {blockers.length === 1 ? 'The remaining check is shown on the card.' : 'No remaining form blockers.'}
            </p>
          )}
          {otherFrameFields.length > 1 ? (
            // `summarizedFrameField` is already shown on the card itself (above); listed here is
            // only what that summary omitted. Excluded by identity, not by array position: the
            // summarized field is not always index 0 (it prefers an active field over whichever
            // field happens to come first in snapshot order), so slicing off the front would risk
            // showing it twice, or dropping whichever field actually was first instead.
            <ul className="mt-3 list-disc space-y-1 border-t border-base-300 pt-3 pl-4 text-xs text-base-content/70">
              {otherFrameFields
                .filter((field) => field.fieldRef !== summarizedFrameField!.fieldRef)
                .map((field) => (
                  <li key={field.fieldRef}>{describeCrossOriginField(field, snapshot.topFrameOrigin!)}</li>
                ))}
            </ul>
          ) : null}
          <ul className="mt-3 list-disc space-y-1 border-t border-base-300 pt-3 pl-4 text-xs text-base-content/60">
            {activeFields.map((field) => (
              <li key={field.fieldRef}>
                {field.label || 'Unlabelled field'} ({field.controlType}
                {field.required ? ', required' : ''})
              </li>
            ))}
          </ul>
        </div>
      </details>

      <details className="rounded-lg border border-base-300 bg-base-100">
        <summary className="cursor-pointer px-4 py-2.5 text-sm font-medium">Review application form</summary>
        <div className="max-h-72 overflow-auto border-t border-base-300 bg-base-200">
          <img
            src={`data:image/png;base64,${screenshotBase64}`}
            alt={`Live application page preview for ${attempt.role} at ${attempt.company}`}
            className="w-full"
            draggable={false}
          />
        </div>
      </details>

      <button type="button" className="btn btn-ghost btn-sm" disabled={busy} onClick={onOpenLiveView}>
        Open the live page to finish it yourself
      </button>
    </div>
  );
}
