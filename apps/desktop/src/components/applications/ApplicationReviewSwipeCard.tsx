import { useEffect, useRef, useState } from 'react';
import type { PointerEvent as ReactPointerEvent } from 'react';
import type { FormReadiness, FormSnapshot, SnapshotField } from '@agent-dock/application-executor';
import type { ApplicationAnswerRecord, ApplicationArtifactSummary, ApplicationAttemptRecord, ConfirmApplicationAnswerResult } from '../../window.js';
import { usePrefersReducedMotion } from '../../use-prefers-reduced-motion.js';
import { ApplicationPreparedSummary } from './ApplicationPreparedSummary.js';
import { ReviewScreenshot } from './ReviewScreenshot.js';

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
  /** Two-pane layout (#469): the decision panel on the left and the form screenshot, always
   * visible and uncapped, on the right. The decorative card stack is dropped so the content being
   * approved is what takes the space. The compact layout is the default. */
  wide?: boolean;
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
      return `"${blocker.label}" did not save. Check it on the live page.`;
    case 'unverified_write':
      return `"${blocker.label}" may not have saved. Check it on the live page.`;
    case 'attachment_missing':
      return `"${blocker.label}" needs a file and has none attached.`;
    case 'stale_page_state':
      return 'The page changed. Reopen this review.';
    case 'challenge_detected':
      return 'The page asks you to prove you are human. Open the live page to do it.';
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
 * One plain line for the case where the form under review is itself inside an embed from another
 * site. The write path refuses to type into such a frame, so the person has to finish it on the
 * live page. A field in some other widget (a chat box, an ad) gets no notice at all.
 */
function describeCrossOriginField(): string {
  return 'Part of this form is hosted by another site, so the app left it blank. Use the live page to fill it in.';
}

/** The host a form will be sent to, read from the live page's own origin when the snapshot has one
 * and from the recorded application URL otherwise. Never the company name: this is the address. */
function destinationHost(attempt: ApplicationAttemptRecord, snapshot: FormSnapshot): string {
  for (const candidate of [snapshot.topFrameOrigin, attempt.canonicalUrl]) {
    if (!candidate) continue;
    try {
      return new URL(candidate).host;
    } catch {
      // Not a parseable URL: try the next source rather than showing a half-address.
    }
  }
  return 'the employer site';
}

/**
 * Everything the final confirmation shows, folded to one string. If any of it differs from what the
 * person was looking at when they opened the confirmation, that confirmation is withdrawn and a
 * fresh review is required (#443): the destination, the files, the answer values and the form
 * checks are exactly what "I reviewed this" has to mean.
 */
function reviewFingerprint(
  attempt: ApplicationAttemptRecord,
  snapshot: FormSnapshot,
  documents: readonly ApplicationArtifactSummary[],
  readiness: FormReadiness,
): string {
  return JSON.stringify({
    host: destinationHost(attempt, snapshot),
    url: attempt.canonicalUrl,
    files: documents.map((document) => [document.id, document.fileName, document.contentHash]),
    answers: (attempt.preparedFields?.fields ?? []).map((field) => [field.label, field.controlType, field.status, field.value ?? '']),
    ready: readiness.ready,
    verified: readiness.verifiedFilledCount,
    blockers: readiness.blockers.map((blocker) => describeBlocker(blocker)),
  });
}

/**
 * The one-attempt-at-a-time review card issue #202 needed a genuinely fast confirmation step for:
 * a real screenshot of the application page as it currently stands (see the image's own comment
 * below for what that screenshot does and doesn't prove) plus what the form actually holds, decided
 * with a drag left to skip or the same two actions as ordinary buttons underneath, since a desktop
 * app has no touch screen to assume and a button is the one interaction every input device and
 * screen reader can reach. Dragging can only ever skip (#443): sending a real application takes two
 * deliberate button actions, "Submit application" and then "Send application" on the final
 * confirmation. The drag never calls `onSkip` until released past
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
  wide = false,
}: ApplicationReviewSwipeCardProps) {
  const [dragX, setDragX] = useState(0);
  const reducedMotion = usePrefersReducedMotion();
  const dragXRef = useRef(0);
  const dragOriginRef = useRef<number | null>(null);
  const [dragging, setDragging] = useState(false);
  /** The fingerprint of what the open final confirmation showed, or null while it is closed (#443). */
  const [confirmation, setConfirmation] = useState<string | null>(null);
  const [reviewChanged, setReviewChanged] = useState(false);
  const confirmationHeadingRef = useRef<HTMLHeadingElement>(null);
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

  const fingerprint = reviewFingerprint(attempt, snapshot, documents, readiness);
  const confirming = confirmation !== null;
  useEffect(() => {
    if (confirmation !== null && confirmation !== fingerprint) {
      // The form, the files or the destination moved under an open confirmation: the person
      // confirmed something that is no longer what would be sent.
      setConfirmation(null);
      setReviewChanged(true);
    }
  }, [confirmation, fingerprint]);
  useEffect(() => {
    if (confirming) confirmationHeadingRef.current?.focus();
  }, [confirming]);

  const { verifiedFilledCount, blockers } = readiness;
  const canSubmit = readiness.ready && !busy;
  const otherFrameFields = crossOriginFields(snapshot);
  // The notice only matters when the form under review is itself inside an embed. A field in
  // some other widget (a chat box, an ad) is not worth the person's attention.
  const formIsEmbedded = otherFrameFields.some((field) => field.active);

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
    // Only a leftward drag decides anything. A rightward one used to submit (#443); it now does
    // nothing at all, however far it goes.
    if (!busy && dragXRef.current < -SWIPE_THRESHOLD_PX) onSkip();
    dragXRef.current = 0;
    setDragX(0);
  }

  const rotation = Math.max(-MAX_ROTATION_DEG, Math.min(MAX_ROTATION_DEG, dragX / 10));
  const skipOpacity = Math.min(1, Math.max(0, -dragX / SWIPE_THRESHOLD_PX));
  const screenshotAlt = `Live application page preview for ${attempt.role} at ${attempt.company}`;

  return (
    <div
      data-testid="review-layout"
      data-layout={wide ? 'wide' : 'compact'}
      className={wide ? 'grid w-full grid-cols-[minmax(0,26rem)_minmax(0,1fr)] items-start gap-6' : 'mx-auto w-full max-w-sm'}
    >
    <div className="flex min-w-0 flex-col gap-3">
      <div className="-mx-2 grid overflow-x-clip px-4 pb-2 pt-3">
      {wide ? null : (
        <>
          <div aria-hidden="true" data-testid="swipe-card-back" className="pointer-events-none col-start-1 row-start-1 mx-6 translate-y-2 rotate-[-2deg] rounded-lg border border-base-300 bg-base-300/70" />
          <div aria-hidden="true" data-testid="swipe-card-back" className="pointer-events-none col-start-1 row-start-1 mx-4 translate-y-1 rotate-[2deg] rounded-lg border border-base-300 bg-base-200" />
        </>
      )}
      <div
        data-testid="application-swipe-card"
        role="group"
        aria-label={`Application decision card for ${attempt.role} at ${attempt.company}`}
        className={`relative z-10 col-start-1 row-start-1 mx-2 select-none overflow-hidden rounded-lg border border-base-300 bg-base-100 shadow-xl ${busy ? 'cursor-wait' : 'cursor-grab active:cursor-grabbing'}`}
        style={{
          // Reduced motion keeps the card following the pointer, but drops the tilt and the
          // settle-back animation.
          transform: reducedMotion ? `translateX(${dragX}px)` : `translateX(${dragX}px) rotate(${rotation}deg)`,
          transition: reducedMotion || dragging ? 'none' : 'transform 200ms ease-out',
          touchAction: 'pan-y',
        }}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
      >
        <div aria-hidden="true" className="mx-auto mt-2 h-1 w-7 rounded-full bg-base-content/20" />
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
            <span className="text-xs text-base-content/60">Final submission is always yours</span>
          </div>
          <h2 className="text-base font-semibold leading-snug">
            {attempt.role} <span className="text-base-content/60">at</span> {attempt.company}
          </h2>
        </div>

        <div className={`px-4 py-3 ${readiness.ready ? 'bg-success/10' : 'bg-warning/10'}`}>
          {blockers.length > 0 ? (
            <>
              <p className="text-xs font-semibold">Some answers still need you.</p>
              {blockers.length === 1 ? (
                <p className="mt-1 text-xs text-base-content/70">{describeBlocker(blockers[0]!)}</p>
              ) : (
                <ul className="mt-1 list-disc space-y-1 pl-4 text-xs text-base-content/70">
                  {blockers.map((blocker, index) => (
                    <li key={`${blocker.kind}-${index}`}>{describeBlocker(blocker)}</li>
                  ))}
                </ul>
              )}
            </>
          ) : (
            <p className="text-xs font-semibold">Everything required is filled in.</p>
          )}
        </div>

        {formIsEmbedded ? (
          <div className="border-t border-base-300 bg-info/10 px-4 py-3">
            <p className="text-xs text-base-content/70">{describeCrossOriginField()}</p>
          </div>
        ) : null}
      </div>
      </div>

      {reviewChanged && !confirming ? (
        <p className="rounded-lg border border-warning/40 bg-warning/10 px-3 py-2 text-xs" role="status">
          The form or its files changed while you were confirming. Review the details again before sending.
        </p>
      ) : null}

      {confirming ? (
        <section
          aria-labelledby="send-confirmation-heading"
          data-testid="send-confirmation"
          className="flex flex-col gap-3 rounded-lg border border-warning/50 bg-base-100 p-4"
        >
          <h3 id="send-confirmation-heading" ref={confirmationHeadingRef} tabIndex={-1} className="text-sm font-semibold outline-none">
            Send this application to {attempt.company}?
          </h3>
          <p className="text-xs text-base-content/70">
            This sends the form on <strong>{destinationHost(attempt, snapshot)}</strong> with the files and answers below.
            You cannot undo this from the app.
          </p>
          <div>
            <p className="text-xs font-semibold">Files ({documents.length})</p>
            {documents.length > 0 ? (
              <ul className="mt-1 list-disc space-y-0.5 pl-4 text-xs text-base-content/70">
                {documents.map((document) => (
                  <li key={document.id}>{document.fileName}</li>
                ))}
              </ul>
            ) : (
              <p className="mt-1 text-xs text-base-content/60">No files are attached.</p>
            )}
          </div>
          <div>
            <p className="text-xs font-semibold">
              Answers ({(attempt.preparedFields?.fields ?? []).filter((field) => field.status === 'committed').length} filled, {verifiedFilledCount} verified on the page)
            </p>
            <ul className="mt-1 space-y-0.5 text-xs text-base-content/70">
              {(attempt.preparedFields?.fields ?? []).map((field, index) => (
                <li key={`${field.controlType}-${field.label}-${index}`}>
                  <span className="font-medium">{field.label || 'Unlabelled field'}:</span>{' '}
                  {field.status === 'committed'
                    ? field.value
                    : field.status === 'left_blank'
                      ? 'left blank'
                      : field.status === 'awaiting_you'
                        ? 'you answer this on the page'
                        : 'needs a file'}
                </li>
              ))}
            </ul>
          </div>
          {blockers.length > 0 ? (
            <div>
              <p className="text-xs font-semibold text-warning">Still unresolved</p>
              <ul className="mt-1 list-disc space-y-0.5 pl-4 text-xs text-base-content/70">
                {blockers.map((blocker, index) => (
                  <li key={`${blocker.kind}-${index}`}>{describeBlocker(blocker)}</li>
                ))}
              </ul>
            </div>
          ) : null}
          <div className="grid grid-cols-2 gap-3">
            <button type="button" className="btn btn-outline" disabled={busy} onClick={() => setConfirmation(null)}>
              Go back
            </button>
            <button type="button" className="btn btn-success" disabled={!canSubmit} onClick={onApprove}>
              {busy ? <span className="loading loading-spinner loading-sm" /> : 'Send application'}
            </button>
          </div>
        </section>
      ) : (
        <div className="grid grid-cols-2 gap-3">
          <button type="button" className="btn btn-outline flex-1" disabled={busy} onClick={onSkip}>
            Skip
          </button>
          <button
            type="button"
            className="btn btn-success flex-1"
            disabled={!canSubmit}
            onClick={() => {
              setReviewChanged(false);
              setConfirmation(fingerprint);
            }}
          >
            Submit application
          </button>
        </div>
      )}

      <details open className="rounded-lg border border-base-300 bg-base-100">
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

      {wide ? null : (
        <details className="rounded-lg border border-base-300 bg-base-100">
          <summary className="cursor-pointer px-4 py-2.5 text-sm font-medium">Review application form</summary>
          <div className="border-t border-base-300">
            <ReviewScreenshot screenshotBase64={screenshotBase64} alt={screenshotAlt} frameClassName="max-h-72 overflow-auto" />
          </div>
        </details>
      )}

      <button type="button" className="btn btn-ghost btn-sm" disabled={busy} onClick={onOpenLiveView}>
        Open the live page to finish it yourself
      </button>
    </div>
    {wide ? (
      <section
        data-testid="review-screenshot-pane"
        aria-labelledby="review-screenshot-heading"
        className="min-w-0 overflow-hidden rounded-lg border border-base-300 bg-base-100"
      >
        <h3 id="review-screenshot-heading" className="px-4 py-2.5 text-sm font-medium">Review application form</h3>
        <div className="border-t border-base-300">
          <ReviewScreenshot screenshotBase64={screenshotBase64} alt={screenshotAlt} />
        </div>
      </section>
    ) : null}
    </div>
  );
}
