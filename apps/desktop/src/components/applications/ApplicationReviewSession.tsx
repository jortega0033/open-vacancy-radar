import { useCallback, useEffect, useRef, useState } from 'react';
import type { OpenApplicationReviewResult } from '../../../electron/application-executor-types.js';
import type { ApplicationArtifactRecord, ApplicationAttemptRecord } from '../../window.js';
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
  /** The real page is on screen, focused, and the person is working in it. The modal is out of the
   * way entirely: anything drawn over the live view would be drawn over the thing they are trying
   * to type into. */
  | { phase: 'handoff'; review: OpenApplicationReviewResult; company: string; role: string; bannerHeightPx: number }
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
  // Loaded independently of the browser review, and always scoped to this attempt's own id (#272).
  // A failure here must never block the review itself.
  const [documents, setDocuments] = useState<readonly ApplicationArtifactRecord[]>([]);
  const openedRef = useRef(false);
  /** The policy this review was opened against, kept so reopening after a handoff asks for the
   * same target rather than resolving it again (a reopen against a different target is refused
   * main-process side, by design). */
  const policyIdRef = useRef<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    openedRef.current = false;
    setDocuments([]);

    async function loadDocuments() {
      try {
        const rows = await window.workspace.listApplicationArtifacts(attempt.id);
        if (!cancelled) setDocuments(rows);
      } catch {
        if (!cancelled) setDocuments([]);
      }
    }
    void loadDocuments();

    async function start() {
      setState({ phase: 'resolving' });
      try {
        const policyId = await window.applicationExecutor.resolveTargetPolicyId(attempt.canonicalUrl);
        if (cancelled) return;
        if (!policyId) {
          setState({ phase: 'ineligible' });
          return;
        }
        policyIdRef.current = policyId;
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
        // Take the live view off screen before the review goes away, so a handoff can never be left
        // covering the app with nothing owning it. A no-op main-process side for an attempt that is
        // not the one currently showing, so this can never disturb a different attempt's handoff.
        void window.applicationExecutor.hideHandoff(attempt.id);
        void window.applicationExecutor.closeReview(attempt.id);
      }
    };
  }, [attempt.id, attempt.canonicalUrl]);

  const handleOpenLiveView = useCallback(async () => {
    if (state.phase !== 'ready') return;
    try {
      const result = await window.applicationExecutor.showHandoff(attempt.id);
      if (!result.ok) {
        setState({ phase: 'error', message: result.detail ?? `could not open the live page: ${result.reason ?? 'unknown reason'}` });
        return;
      }
      // Employer and role come back from the main process, read from this attempt's own workspace
      // record. Deliberately not taken from the page being handed over, which must never get to
      // tell a person which application they are looking at.
      setState({
        phase: 'handoff',
        review: state.review,
        company: result.company ?? attempt.company,
        role: result.role ?? attempt.role,
        // The main process is what actually sizes the live view, so it is what says how much room
        // this banner has. The fallback only matters for a build where the two got out of step.
        bannerHeightPx: result.bannerHeightPx ?? 56,
      });
    } catch (err) {
      setState({ phase: 'error', message: describeError(err, 'could not open the live page') });
    }
  }, [attempt.id, attempt.company, attempt.role, state]);

  const handleCloseLiveView = useCallback(async () => {
    if (state.phase !== 'handoff') return;
    const { review } = state;
    try {
      await window.applicationExecutor.hideHandoff(attempt.id);
      // Re-open rather than reuse the review object that was on screen before the handoff: the
      // person has just been typing into the real page, so every value, validation message and
      // readiness reading from before it is out of date. Reopening is safe precisely because it
      // preserves the attempt (#277): the same view and executor, then a fresh snapshot of the
      // page the person just changed.
      const refreshed = await window.applicationExecutor.openReview({
        attemptId: attempt.id,
        policyId: policyIdRef.current ?? '',
        targetUrl: attempt.canonicalUrl,
        refresh: true,
      });
      setState({ phase: 'ready', review: refreshed });
    } catch (err) {
      // Falling back to what was on screen before is wrong here: it would show a readiness reading
      // taken before the person touched the page. Surfacing the failure is the honest outcome.
      void review;
      setState({ phase: 'error', message: describeError(err, 'could not re-read the page after the live view closed') });
    }
  }, [attempt.id, attempt.canonicalUrl, state]);

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

  // While the live page is on screen, this is the only part of the window the target page cannot
  // draw in: `application-view.ts` reserves exactly this many pixels at the top for it (the height
  // comes back over the bridge, so there is one source of truth) and sizes the live view to the
  // remainder. So this bar is deliberately a fixed-height strip pinned to
  // the top rather than a dialog, and it is why the employer and role are read from this app's own
  // attempt record rather than from the page underneath: it has to be an answer to "what am I
  // signing in to?" that the page cannot forge, on a pixel the page cannot reach.
  if (state.phase === 'handoff') {
    return (
      <div
        className="fixed inset-x-0 top-0 z-50 flex items-center justify-between gap-4 border-b border-base-300 bg-base-100 px-5 shadow-lg"
        style={{ height: state.bannerHeightPx }}
      >
        <div className="min-w-0">
          <p className="truncate text-sm font-semibold">
            Live application page for {state.role} at {state.company}
          </p>
          <p className="truncate text-xs text-base-content/60">
            Sign in, solve the CAPTCHA, or finish anything the app could not fill, then come back. Press Escape to
            return. Other pending applications are untouched.
          </p>
        </div>
        <button type="button" className="btn btn-primary btn-sm shrink-0" onClick={() => void handleCloseLiveView()}>
          Done, back to review
        </button>
      </div>
    );
  }

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
            documents={documents}
            readiness={state.review.readiness}
            busy={state.phase === 'deciding'}
            onApprove={handleApprove}
            onSkip={handleSkip}
            onOpenLiveView={() => void handleOpenLiveView()}
          />
        )}
      </div>
      <button type="button" className="modal-backdrop" aria-label="Close" disabled={closeDisabled} onClick={onClose} />
    </div>
  );
}
