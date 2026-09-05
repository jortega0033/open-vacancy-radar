import { useCallback, useEffect, useRef, useState } from 'react';
import type { OpenApplicationReviewResult } from '../../../electron/application-executor-types.js';
import type { ApplicationAttemptRecord } from '../../window.js';
import { ApplicationReviewSwipeCard } from './ApplicationReviewSwipeCard.js';

export interface ApplicationReviewSessionProps {
  attempt: ApplicationAttemptRecord;
  /** Called once the session has ended for any reason -- submitted, skipped, or the person closed
   * it -- so the parent can drop back to the list and, on a real submit, refresh it. */
  onClose: () => void;
}

type SessionState =
  | { phase: 'resolving' | 'opening' }
  | { phase: 'ineligible' }
  | { phase: 'ready'; review: OpenApplicationReviewResult }
  | { phase: 'deciding'; review: OpenApplicationReviewResult }
  | { phase: 'error'; message: string };

function describeError(err: unknown, fallback: string): string {
  return err instanceof Error ? err.message : fallback;
}

/**
 * Owns one attempt's whole manual-review lifecycle (issue #202): resolve which compiled policy
 * governs its `canonicalUrl`, open a real browser review against it, show the swipe card, and act
 * on the person's decision -- `submitReview` on approve, a plain `skipped` checkpoint on skip.
 * Always closes the underlying browser view on unmount, whichever way the session ended, so a
 * dismissed or navigated-away-from card never leaks an open `WebContentsView`.
 *
 * "Ineligible" (`resolveTargetPolicyId` finds no compiled policy for this URL) is the ordinary
 * case today -- no real employer target is compiled in yet (see `application-target-policies.ts`'s
 * own header comment) -- so this is presented as a plain, expected state, not an error.
 */
export function ApplicationReviewSession({ attempt, onClose }: ApplicationReviewSessionProps) {
  const [state, setState] = useState<SessionState>({ phase: 'resolving' });
  const openedRef = useRef(false);

  useEffect(() => {
    let cancelled = false;
    openedRef.current = false;

    async function start() {
      setState({ phase: 'resolving' });
      try {
        const policyId = await window.applicationExecutor.resolveTargetPolicyId(attempt.canonicalUrl);
        if (cancelled) return;
        if (!policyId) {
          setState({ phase: 'ineligible' });
          return;
        }
        setState({ phase: 'opening' });
        const review = await window.applicationExecutor.openReview({ attemptId: attempt.id, policyId, targetUrl: attempt.canonicalUrl });
        if (cancelled) return;
        openedRef.current = true;
        setState({ phase: 'ready', review });
      } catch (err) {
        if (!cancelled) setState({ phase: 'error', message: describeError(err, 'could not open a review for this attempt') });
      }
    }
    void start();

    return () => {
      cancelled = true;
      if (openedRef.current) {
        openedRef.current = false;
        void window.applicationExecutor.closeReview(attempt.id);
      }
    };
  }, [attempt.id, attempt.canonicalUrl]);

  const handleApprove = useCallback(async () => {
    if (state.phase !== 'ready') return;
    setState({ phase: 'deciding', review: state.review });
    try {
      const result = await window.applicationExecutor.submitReview(attempt.id);
      if (!result.ok) {
        setState({ phase: 'error', message: result.detail ?? `refused: ${result.reason ?? 'unknown reason'}` });
        return;
      }
      openedRef.current = false;
      await window.applicationExecutor.closeReview(attempt.id);
      onClose();
    } catch (err) {
      setState({ phase: 'error', message: describeError(err, 'could not submit this application') });
    }
  }, [attempt.id, onClose, state]);

  const handleSkip = useCallback(async () => {
    if (state.phase !== 'ready') return;
    setState({ phase: 'deciding', review: state.review });
    try {
      openedRef.current = false;
      await window.applicationExecutor.closeReview(attempt.id);
      await window.workspace.updateApplicationAttempt(attempt.id, { checkpoint: 'skipped' });
      onClose();
    } catch (err) {
      setState({ phase: 'error', message: describeError(err, 'could not skip this attempt') });
    }
  }, [attempt.id, onClose, state]);

  // Closing while a decision is in flight would tear down the browser view (application-review-
  // session.ts's closeApplicationReview calls view.destroy()) out from under a submit() call that
  // may already be mid-click -- a real gap found during #202's own review. Disabled, not hidden:
  // the person should still see the buttons, just not be able to act on them mid-request.
  const closeDisabled = state.phase === 'deciding';

  return (
    <div className="modal modal-open" role="dialog" aria-modal="true">
      <div className="modal-box max-w-lg">
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-sm font-semibold">
            Review &amp; submit <span className="text-base-content/60">&middot;</span> {attempt.role} at {attempt.company}
          </h2>
          <button type="button" aria-label="Close" className="btn btn-ghost btn-sm btn-circle" disabled={closeDisabled} onClick={onClose}>
            ✕
          </button>
        </div>

        {(state.phase === 'resolving' || state.phase === 'opening') && (
          <div className="flex items-center gap-2 py-8 text-sm text-base-content/70">
            <span className="loading loading-spinner loading-sm" />
            {state.phase === 'resolving' ? 'Checking eligibility…' : 'Opening a live review…'}
          </div>
        )}

        {state.phase === 'ineligible' && (
          <div className="alert alert-warning">
            <span>
              This application&rsquo;s site isn&rsquo;t one of the platforms reviewed for automated submission yet, so
              there is nothing to submit here automatically. Apply through the site directly, then mark this attempt
              done from its own record.
            </span>
          </div>
        )}

        {state.phase === 'error' && (
          <div className="alert alert-error" role="alert">
            <span>{state.message}</span>
          </div>
        )}

        {(state.phase === 'ready' || state.phase === 'deciding') && (
          <ApplicationReviewSwipeCard
            attempt={attempt}
            snapshot={state.review.snapshot}
            screenshotBase64={state.review.screenshotBase64}
            busy={state.phase === 'deciding'}
            onApprove={handleApprove}
            onSkip={handleSkip}
          />
        )}
      </div>
      <button type="button" className="modal-backdrop" aria-label="Close" disabled={closeDisabled} onClick={onClose} />
    </div>
  );
}
