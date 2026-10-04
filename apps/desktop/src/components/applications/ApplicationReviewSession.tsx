import { X } from '@phosphor-icons/react';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { OpenApplicationReviewResult } from '../../../electron/application-executor-types.js';
import type { ApplicationArtifactSummary, ApplicationAttemptRecord } from '../../window.js';
import type { SelectedVacancy } from '../letters/types.js';
import { Dialog } from '../shell/Dialog.js';
import { useEscapeToClose } from '../shell/useEscapeToClose.js';
import { useSupportPrompt } from '../support/SupportPromptProvider.js';
import { ApplicationReviewSwipeCard } from './ApplicationReviewSwipeCard.js';
import { ManualApplicationReviewCard } from './ManualApplicationReviewCard.js';
import { WarningBanner } from '../shell/index.js';
import { classifyProviderError, type ProviderErrorInfo } from '../../provider-error.js';
import { recordProviderLimit } from '../../provider-limits.js';
import {
  alreadySentFailure,
  describeSubmitRefusal,
  errorText,
  notSentFailure,
  unconfirmedFailure,
  type ReviewFailure,
} from './review-outcome.js';
import { useWideReviewLayout } from './use-wide-review-layout.js';

export interface ApplicationReviewSessionProps {
  attempt: ApplicationAttemptRecord;
  position?: number;
  total?: number;
  /** Called once the session has ended for any reason -- submitted, skipped, or the person closed
   * it -- so the parent can drop back to the list and, on a real submit, refresh it. */
  onClose: (outcome?: 'dismissed' | 'resolved') => void;
  onGenerateLetter?: (vacancy: SelectedVacancy, attemptId: string) => void;
  /** Called once a skip has been written, just before `onClose('resolved')`, so the parent can
   * offer an undo (#468). Not called for a submit or a person-reported application. */
  onSkipped?: (attempt: ApplicationAttemptRecord) => void;
}

type SessionState =
  | { phase: 'resolving' | 'opening' }
  | { phase: 'tailoring_blocked'; message: string; busy: boolean }
  | { phase: 'preparation_blocked'; message: string; busy: boolean }
  | { phase: 'ineligible'; continued: boolean; busy: boolean }
  | { phase: 'ready'; review: OpenApplicationReviewResult }
  | { phase: 'deciding'; review: OpenApplicationReviewResult }
  /** The real page is on screen, focused, and the person is working in it. The modal is out of the
   * way entirely: anything drawn over the live view would be drawn over the thing they are trying
   * to type into. */
  | { phase: 'handoff'; review: OpenApplicationReviewResult; company: string; role: string; bannerHeightPx: number }
  /** `failure.outcome` says whether anything reached the employer (#468). `busy` covers a skip or
   * record in flight. `checked` is set once the person has opened the employer page, which is what
   * unlocks Try again after an outcome the app could not confirm. */
  | { phase: 'error'; failure: ReviewFailure; busy: boolean; checked: boolean };

/** The stored sentence the pipeline writes when automatic tailoring stops (`application-pipeline.ts`
 * matches on the same prefix). The raw reason after it is kept for a Details disclosure. */
const TAILORING_STOPPED_PREFIX = 'Automatic CV tailoring stopped:';

/** One plain sentence for a blocked preparation. The pipeline's own sentence is kept in a Details
 * disclosure, since it names internal steps. */
function describePreparationBlocker(message: string): string {
  return /\b(?:cover|motivation) letter\b/iu.test(message)
    ? 'Your cover letter still needs attention.'
    : 'This application needs your attention.';
}

/** Raw detail text behind a collapsed disclosure, for the few people who need it. */
function TechnicalDetails({ text, label }: { text: string; label: string }) {
  if (!text) return null;
  return (
    <details className="text-xs text-base-content/70">
      <summary className="cursor-pointer font-medium">{label}</summary>
      <p className="mt-1 break-words">{text}</p>
    </details>
  );
}

/**
 * A usage limit behind a blocked preparation (#546). Application preparation always runs on Claude
 * (`applicationPipelineDeps` in `main.ts`), so a limit there is Claude's whatever tool the person
 * picked. The reset time is placed relative to when the attempt last changed, not to now, so a
 * stored message read hours later does not move the reset into the future.
 */
function pipelineLimit(message: string, updatedAt: string): ProviderErrorInfo | null {
  const when = Date.parse(updatedAt);
  const info = classifyProviderError(message, Number.isNaN(when) ? new Date() : new Date(when));
  return info.kind === 'usage_limit' ? info : null;
}

function formatClock(ms: number): string {
  return new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

/** Re-renders every 30 seconds while a reset time is still ahead, so Try again unlocks on time. */
function useNowUntil(resetAt: number | undefined): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (resetAt === undefined || resetAt <= Date.now()) return;
    const timer = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(timer);
  }, [resetAt]);
  return now;
}

function PipelineLimitNotice({ info }: { info: ProviderErrorInfo }) {
  return (
    <WarningBanner>
      Claude has reached its usage limit{info.resetLabel ? ` until ${info.resetLabel}` : ''}. Preparing an
      application needs Claude, so try again once the limit resets.
    </WarningBanner>
  );
}

function retryLabel(info: ProviderErrorInfo | null, waiting: boolean, idle: string): string {
  if (!info || !waiting || info.resetAt === undefined) return idle;
  return `Try again after ${formatClock(info.resetAt)}`;
}

function errorState(failure: ReviewFailure): SessionState {
  return { phase: 'error', failure, busy: false, checked: false };
}

function describeError(err: unknown, fallback: string): string {
  return err instanceof Error ? err.message : fallback;
}

/** Same pattern as `handleManualContinue` and `Open vacancy`: the main window's open handler sends
 * it to the system browser after its own safety check. */
function openEmployerPage(url: string) {
  window.open(url, '_blank', 'noopener,noreferrer');
}

/**
 * Owns one attempt's whole manual-review lifecycle (issue #202): resolve which compiled policy
 * governs its `canonicalUrl`, open a real browser review against it, show the swipe card, and act
 * on the person's decision -- `submitReview` on approve, a plain `skipped` checkpoint on skip.
 * Always closes the underlying browser view on unmount, whichever way the session ended, so a
 * dismissed or navigated-away-from card never leaks an open `WebContentsView`.
 *
 * "Ineligible" (`resolveTargetPolicyId` finds no compiled policy for this URL) is an ordinary
 * manual-application mode. It still presents the staged documents and explicit Continue/Skip
 * actions instead of ending in a dead-end eligibility message.
 */
export function ApplicationReviewSession({ attempt, position, total, onClose, onGenerateLetter, onSkipped }: ApplicationReviewSessionProps) {
  const [state, setState] = useState<SessionState>({ phase: 'resolving' });
  const wide = useWideReviewLayout();
  const { recordSuccessMoment } = useSupportPrompt();
  /** Bumped by Try again to run the whole open sequence again against the same attempt. */
  const [retryNonce, setRetryNonce] = useState(0);
  // Loaded independently of the browser review, and always scoped to this attempt's own id (#272).
  // A failure here must never block the review itself.
  const [documents, setDocuments] = useState<readonly ApplicationArtifactSummary[]>([]);
  const openedRef = useRef(false);
  const manualDecisionRef = useRef(false);
  /** The policy this review was opened against, kept so reopening after a handoff asks for the
   * same target rather than resolving it again (a reopen against a different target is refused
   * main-process side, by design). */
  const policyIdRef = useRef<string | null>(null);

  /**
   * `attempt` is a plain prop, not something this page re-polls while a review is open (#372):
   * `ApplicationsPage.tsx`'s attempt-list poll drives the review *queue*, not the one attempt
   * already open here. So after `confirmApplicationAnswer` commits a field, the durable
   * `preparedFields` record it just wrote would never reach `ApplicationPreparedSummary` through
   * `attempt` itself -- this local copy is what actually picks that up, re-read once right after a
   * successful confirm. It otherwise always mirrors `attempt`: the effect below resyncs it whenever
   * the prop changes (a fresh review opening, or the parent's own future refresh), so this is never
   * a second, independently-stale source of truth.
   */
  const [liveAttempt, setLiveAttempt] = useState(attempt);
  useEffect(() => setLiveAttempt(attempt), [attempt]);

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
      if (attempt.checkpoint === 'needs_user' && attempt.checkpointDetail.startsWith(TAILORING_STOPPED_PREFIX)) {
        setState({ phase: 'tailoring_blocked', message: attempt.checkpointDetail, busy: false });
        return;
      }
      setState({ phase: 'resolving' });
      try {
        const policyId = await window.applicationExecutor.resolveTargetPolicyId(attempt.canonicalUrl);
        if (cancelled) return;
        if (!policyId) {
          const hasUsefulManualDocuments = attempt.checkpointDetail.includes('Your application documents are ready.')
            || attempt.checkpointDetail.includes('Your tailored CV is ready.')
            || attempt.checkpointDetail.includes('Your CV was prepared without any skills.');
          if (attempt.checkpoint === 'needs_user' && !hasUsefulManualDocuments) {
            setState({ phase: 'preparation_blocked', message: attempt.checkpointDetail, busy: false });
            return;
          }
          setState({ phase: 'ineligible', continued: false, busy: false });
          return;
        }
        if (attempt.checkpoint === 'needs_user') {
          setState({ phase: 'preparation_blocked', message: attempt.checkpointDetail, busy: false });
          return;
        }
        policyIdRef.current = policyId;
        setState({ phase: 'opening' });
        const review = await window.applicationExecutor.openReview({ attemptId: attempt.id, policyId, targetUrl: attempt.canonicalUrl });
        if (cancelled) return;
        openedRef.current = true;
        setState({ phase: 'ready', review });
      } catch (err) {
        if (!cancelled) setState(errorState(notSentFailure('We could not open this application.', errorText(err))));
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
  }, [attempt.id, attempt.canonicalUrl, retryNonce]);

  const handleOpenLiveView = useCallback(async () => {
    if (state.phase !== 'ready') return;
    try {
      const result = await window.applicationExecutor.showHandoff(attempt.id);
      if (!result.ok) {
        setState(errorState(notSentFailure('We could not open the live page.', result.detail ?? result.reason)));
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
      setState(errorState(notSentFailure('We could not open the live page.', errorText(err))));
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
      setState(errorState(notSentFailure('We could not reopen the page.', errorText(err))));
    }
  }, [attempt.id, attempt.canonicalUrl, state]);

  /**
   * Commits one confirmed answer -- a reused saved answer or a freshly-typed one -- into one live
   * field (#372). Returns the bridge's own result so the caller (the awaiting-you row that offered
   * this action) can show its own inline failure rather than this whole session going to its
   * generic error phase: a single field not taking a fill is not the same severity as the review
   * itself failing to open.
   */
  const handleConfirmAnswer = useCallback(
    async (fieldIndex: number, fieldRef: string, value: string) => {
      const result = await window.applicationExecutor.confirmApplicationAnswer({ attemptId: attempt.id, fieldIndex, fieldRef, value });
      if (result.ok) {
        // `result.preparedFields` is main's own updated record, already written -- no second round
        // trip through `getApplicationAttempt` needed just to read back what this same call already
        // returned.
        if (result.preparedFields) setLiveAttempt((current) => ({ ...current, preparedFields: result.preparedFields! }));
        setState((current) =>
          (current.phase === 'ready' || current.phase === 'deciding') && result.readiness
            ? { ...current, review: { ...current.review, readiness: result.readiness } }
            : current,
        );
      }
      return result;
    },
    [attempt.id],
  );

  const handleApprove = useCallback(async () => {
    if (state.phase !== 'ready') return;
    setState({ phase: 'deciding', review: state.review });
    try {
      const result = await window.applicationExecutor.submitReview(attempt.id);
      if (!result.ok) {
        setState(errorState(describeSubmitRefusal(result)));
        return;
      }
      // The application went out. Recorded before the close so a failure while closing the review
      // cannot lose it; the Support ask itself waits for this dialog to be gone (#503).
      recordSuccessMoment();
      openedRef.current = false;
      await window.applicationExecutor.closeReview(attempt.id);
      onClose('resolved');
    } catch (err) {
      // Thrown after the submit was started: the click may or may not have landed, so this is never
      // reported as "not sent".
      setState(errorState(unconfirmedFailure(errorText(err))));
    }
  }, [attempt.id, onClose, recordSuccessMoment, state]);

  const handleSkip = useCallback(async () => {
    if (state.phase !== 'ready' && state.phase !== 'ineligible' && state.phase !== 'preparation_blocked' && state.phase !== 'error') return;
    if ((state.phase === 'ineligible' || state.phase === 'preparation_blocked') && (state.busy || manualDecisionRef.current)) return;
    // Skipping from the error screen is only offered, and only honoured, when nothing was sent. After
    // an unconfirmed submit, writing a skipped checkpoint would bury an application that may have
    // gone out.
    if (state.phase === 'error' && (state.busy || state.failure.outcome !== 'not_sent')) return;
    if (state.phase === 'ready') {
      setState({ phase: 'deciding', review: state.review });
    } else if (state.phase === 'error') {
      setState({ ...state, busy: true });
    } else {
      manualDecisionRef.current = true;
      if (state.phase === 'ineligible') setState({ phase: 'ineligible', continued: state.continued, busy: true });
      else setState({ phase: 'preparation_blocked', message: state.message, busy: true });
    }
    try {
      if (openedRef.current) {
        openedRef.current = false;
        await window.applicationExecutor.closeReview(attempt.id);
      }
      await window.workspace.updateApplicationAttempt(attempt.id, { checkpoint: 'skipped' });
      onSkipped?.(attempt);
      onClose('resolved');
    } catch (err) {
      manualDecisionRef.current = false;
      setState(errorState(notSentFailure('We could not skip this application.', errorText(err))));
    }
  }, [attempt, onClose, onSkipped, state]);

  const handleErrorRetry = useCallback(() => {
    if (state.phase !== 'error' || state.busy) return;
    // After an unconfirmed submit the same click would risk a duplicate application, so the person
    // has to have looked at the employer page (or recorded the outcome) first.
    if (state.failure.outcome === 'unconfirmed' && !state.checked) return;
    manualDecisionRef.current = false;
    setRetryNonce((current) => current + 1);
  }, [state]);

  const handleErrorOpenEmployerPage = useCallback(() => {
    if (state.phase !== 'error' || !attempt.canonicalUrl) return;
    openEmployerPage(attempt.canonicalUrl);
    setState({ ...state, checked: true });
  }, [attempt.canonicalUrl, state]);

  /** The person's own statement that they applied. Reuses the manual-review recording path, which
   * keeps this strictly distinct from an application this app observed being received. */
  const handleErrorRecordApplied = useCallback(async () => {
    if (state.phase !== 'error' || state.busy) return;
    setState({ ...state, busy: true });
    try {
      const result = await window.applicationExecutor.recordUserReportedSubmission(attempt.id);
      if (result.ok) {
        recordSuccessMoment();
        onClose('resolved');
        return;
      }
      setState(errorState(result.reason === 'already_observed' ? alreadySentFailure(result.detail) : unconfirmedFailure(result.detail)));
    } catch (err) {
      setState(errorState(unconfirmedFailure(errorText(err))));
    }
  }, [attempt.id, onClose, recordSuccessMoment, state]);

  const handleManualContinue = useCallback(() => {
    if (state.phase !== 'ineligible' || state.busy) return;
    window.open(attempt.canonicalUrl, '_blank', 'noopener,noreferrer');
    setState({ phase: 'ineligible', continued: true, busy: false });
  }, [attempt.canonicalUrl, state]);

  const handleMarkApplied = useCallback(async () => {
    if (state.phase !== 'ineligible' || state.busy || manualDecisionRef.current) return;
    manualDecisionRef.current = true;
    setState({ ...state, busy: true });
    try {
      const result = await window.applicationExecutor.recordUserReportedSubmission(attempt.id);
      if (!result.ok) {
        manualDecisionRef.current = false;
        setState(errorState(notSentFailure('We could not record this application.', result.detail)));
        return;
      }
      recordSuccessMoment();
      onClose('resolved');
    } catch (err) {
      manualDecisionRef.current = false;
      setState(errorState(notSentFailure('We could not record this application.', errorText(err))));
    }
  }, [attempt.id, onClose, recordSuccessMoment, state]);

  const handleSaveArtifact = useCallback(async (artifactId: string) => {
    try {
      await window.applicationExecutor.saveArtifact(artifactId);
    } catch (err) {
      setState(errorState(notSentFailure('We could not save this document.', errorText(err))));
    }
  }, []);

  const handleOpenArtifact = useCallback(async (artifactId: string) => {
    try {
      const result = await window.applicationExecutor.openArtifact(artifactId);
      if (!result.opened) throw new Error(result.detail ?? 'could not open this document');
    } catch (err) {
      setState(errorState(notSentFailure('We could not open this document.', errorText(err))));
    }
  }, []);

  const handleTailoringRecovery = useCallback(async (mode: 'retry' | 'original') => {
    if (state.phase !== 'tailoring_blocked' || state.busy) return;
    setState({ ...state, busy: true });
    try {
      const result = mode === 'retry'
        ? await window.applicationPipeline.retryTailoring(attempt.id)
        : await window.applicationPipeline.useOriginalCv(attempt.id);
      if (!result.ok) throw new Error(result.detail ?? 'could not restart application preparation');
      onClose('resolved');
    } catch (err) {
      setState({ phase: 'tailoring_blocked', message: describeError(err, 'could not restart application preparation'), busy: false });
    }
  }, [attempt.id, onClose, state]);

  const handleResume = useCallback(async () => {
    if (state.phase !== 'preparation_blocked' || state.busy) return;
    setState({ ...state, busy: true });
    try {
      const result = await window.applicationPipeline.resume(attempt.id);
      if (!result.ok) throw new Error(result.detail ?? 'could not resume application preparation');
      onClose('resolved');
    } catch (err) {
      setState({ phase: 'preparation_blocked', message: describeError(err, 'could not resume application preparation'), busy: false });
    }
  }, [attempt.id, onClose, state]);

  const handleGenerateLetter = useCallback(() => {
    if (!onGenerateLetter) return;
    onClose('dismissed');
    onGenerateLetter({
      key: attempt.vacancyKey,
      title: attempt.role,
      company: attempt.company,
      location: '',
      url: attempt.canonicalUrl,
      description: attempt.jdSnapshot,
    }, attempt.id);
  }, [attempt, onClose, onGenerateLetter]);

  // Closing while a decision is in flight would tear down the browser view (application-review-
  // session.ts's closeApplicationReview calls view.destroy()) out from under a submit() call that
  // may already be mid-click -- a real gap found during #202's own review. Disabled, not hidden:
  // the person should still see the buttons, just not be able to act on them mid-request.
  const closeDisabled = state.phase === 'deciding'
    || (state.phase === 'tailoring_blocked' && state.busy)
    || (state.phase === 'preparation_blocked' && state.busy)
    || (state.phase === 'ineligible' && state.busy)
    || (state.phase === 'error' && state.busy);

  const blockedMessage = state.phase === 'tailoring_blocked' || state.phase === 'preparation_blocked' ? state.message : null;
  const limit = blockedMessage === null ? null : pipelineLimit(blockedMessage, liveAttempt.updatedAt);
  const limitNow = useNowUntil(limit?.resetAt);
  const waitingForReset = limit?.resetAt !== undefined && limit.resetAt > limitNow;
  // So the AI runtime page shows Claude's limit too, not only this dialog. Keyed on plain values,
  // since `limit` is rebuilt every render.
  const limited = limit !== null;
  const limitResetLabel = limit?.resetLabel;
  const limitResetAt = limit?.resetAt;
  const limitUpdatedAt = liveAttempt.updatedAt;
  useEffect(() => {
    if (!limited) return;
    const reachedAt = Date.parse(limitUpdatedAt);
    recordProviderLimit({
      provider: 'claude',
      reachedAt: Number.isNaN(reachedAt) ? Date.now() : reachedAt,
      ...(limitResetLabel ? { resetLabel: limitResetLabel } : {}),
      ...(limitResetAt !== undefined ? { resetAt: limitResetAt } : {}),
    });
  }, [limited, limitResetLabel, limitResetAt, limitUpdatedAt]);

  // Only while the live page is handed over: the dialog below owns Escape for every other phase, and
  // the banner shown during a handoff is not a dialog.
  useEscapeToClose(() => onClose('dismissed'), closeDisabled || state.phase !== 'handoff');

  // The two-pane layout only applies where there is a form screenshot to put beside the decision
  // panel. Every other phase is short text and keeps the narrow dialog.
  const twoPane = wide && (state.phase === 'ready' || state.phase === 'deciding');

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
            Finish anything left on this page, then come back.
          </p>
        </div>
        <button type="button" className="btn btn-primary btn-sm shrink-0" onClick={() => void handleCloseLiveView()}>
          Done, back to review
        </button>
      </div>
    );
  }

  return (
    <Dialog
      aria-label={`Review application for ${attempt.role} at ${attempt.company}`}
      boxClassName={`max-h-[calc(100vh-2rem)] overflow-y-auto p-4 ${
        twoPane ? 'max-w-[min(1100px,calc(100vw-2rem))]' : 'max-w-md'
      }`}
      closeDisabled={closeDisabled}
      onClose={() => onClose('dismissed')}
    >
      <div>
        <div className="mb-4 flex items-center justify-between gap-3">
          <div className="min-w-0">
            <h2 className="truncate text-sm font-semibold">
              {state.phase === 'ineligible' || state.phase === 'tailoring_blocked' || state.phase === 'preparation_blocked'
                ? 'Review application'
                : 'Review & submit'}{' '}
              <span className="text-base-content/60">&middot;</span> {attempt.role} at {attempt.company}
            </h2>
            {position && total ? <p className="text-xs text-base-content/60">{position} of {total} ready</p> : null}
          </div>
          <button type="button" aria-label="Close" className="btn btn-ghost btn-sm btn-circle" disabled={closeDisabled} onClick={() => onClose('dismissed')}>
            <X size={16} weight="bold" aria-hidden="true" />
          </button>
        </div>

        {(state.phase === 'resolving' || state.phase === 'opening') && (
          <div className="flex items-center gap-2 py-8 text-sm text-base-content/70">
            <span className="loading loading-spinner loading-sm" />
            Getting your application ready…
          </div>
        )}

        {state.phase === 'ineligible' && (
          <ManualApplicationReviewCard
            attempt={attempt}
            documents={documents}
            busy={state.busy}
            continued={state.continued}
            onContinue={handleManualContinue}
            onSkip={() => void handleSkip()}
            onMarkApplied={() => void handleMarkApplied()}
            onStillInProgress={() => onClose('dismissed')}
            onSaveArtifact={(artifactId) => void handleSaveArtifact(artifactId)}
            onOpenArtifact={(artifactId) => void handleOpenArtifact(artifactId)}
            onGenerateLetter={onGenerateLetter ? handleGenerateLetter : undefined}
          />
        )}

        {state.phase === 'tailoring_blocked' && (
          <div className="space-y-4">
            {limit ? (
              <PipelineLimitNotice info={limit} />
            ) : (
              <WarningBanner>
                We could not tailor your CV for this job.
              </WarningBanner>
            )}
            <TechnicalDetails text={state.message.replace(TAILORING_STOPPED_PREFIX, '').trim()} label="Details" />
            {!limit && (
              <p className="text-sm text-base-content/70">
                Try again, or use your CV as it is.
              </p>
            )}
            <div className="flex gap-3">
              <button
                type="button"
                className="btn btn-outline flex-1"
                disabled={state.busy}
                onClick={() => void handleTailoringRecovery('original')}
              >
                Use my CV as it is
              </button>
              <button
                type="button"
                className="btn btn-primary flex-1"
                disabled={state.busy || waitingForReset}
                onClick={() => void handleTailoringRecovery('retry')}
              >
                {state.busy ? 'Restarting…' : retryLabel(limit, waitingForReset, 'Try again')}
              </button>
            </div>
          </div>
        )}

        {state.phase === 'preparation_blocked' && (
          <div className="space-y-4">
            {limit ? (
              <PipelineLimitNotice info={limit} />
            ) : (
              <WarningBanner>
                {describePreparationBlocker(state.message)}
              </WarningBanner>
            )}
            <TechnicalDetails text={state.message} label="Details" />
            {!limit && (
              <p className="text-sm text-base-content/70">
                Resume to try again, or skip this one.
              </p>
            )}
            <div className="flex flex-wrap gap-3">
              <button type="button" className="btn btn-outline flex-1" disabled={state.busy} onClick={() => void handleSkip()}>
                Skip
              </button>
              {onGenerateLetter && /\b(cover|motivation) letter\b/iu.test(state.message) ? (
                <button type="button" className="btn btn-outline flex-1" disabled={state.busy} onClick={handleGenerateLetter}>
                  Generate letter
                </button>
              ) : (
                <button type="button" className="btn btn-outline flex-1" disabled={state.busy} onClick={() => window.open(attempt.canonicalUrl, '_blank', 'noopener,noreferrer')}>
                  Open vacancy
                </button>
              )}
              <button type="button" className="btn btn-primary flex-1" disabled={state.busy || waitingForReset} onClick={() => void handleResume()}>
                {state.busy ? 'Resuming…' : retryLabel(limit, waitingForReset, 'Resume')}
              </button>
            </div>
          </div>
        )}

        {state.phase === 'error' && (
          <div className="space-y-4">
            <div
              className={`alert ${state.failure.outcome === 'unconfirmed' ? 'alert-warning' : state.failure.outcome === 'sent' ? 'alert-info' : 'alert-error'}`}
              role="alert"
            >
              <div>
                <p className="font-semibold">{state.failure.message}</p>
              </div>
            </div>
            {state.failure.detail ? <TechnicalDetails text={state.failure.detail} label="Technical details" /> : null}
            {state.failure.outcome === 'unconfirmed' && !state.checked ? (
              <p className="text-xs text-base-content/70">
                Check the employer site first. Then Try again unlocks.
              </p>
            ) : null}
            <div className="flex flex-wrap gap-3">
              {state.failure.outcome === 'sent' ? (
                <button type="button" className="btn btn-primary" onClick={() => onClose('resolved')}>
                  Done
                </button>
              ) : (
                <button
                  type="button"
                  className="btn btn-primary"
                  disabled={state.busy || (state.failure.outcome === 'unconfirmed' && !state.checked)}
                  onClick={handleErrorRetry}
                >
                  Try again
                </button>
              )}
              {attempt.canonicalUrl && state.failure.outcome !== 'sent' ? (
                <button type="button" className="btn btn-outline" disabled={state.busy} onClick={handleErrorOpenEmployerPage}>
                  Open the live page
                </button>
              ) : null}
              {state.failure.outcome === 'not_sent' ? (
                <button type="button" className="btn btn-outline" disabled={state.busy} onClick={() => void handleSkip()}>
                  Skip for now
                </button>
              ) : null}
              {state.failure.outcome === 'unconfirmed' ? (
                <button type="button" className="btn btn-outline" disabled={state.busy} onClick={() => void handleErrorRecordApplied()}>
                  I already applied
                </button>
              ) : null}
            </div>
          </div>
        )}

        {(state.phase === 'ready' || state.phase === 'deciding') && (
          <ApplicationReviewSwipeCard
            attempt={liveAttempt}
            snapshot={state.review.snapshot}
            screenshotBase64={state.review.screenshotBase64}
            documents={documents}
            readiness={state.review.readiness}
            busy={state.phase === 'deciding'}
            onApprove={handleApprove}
            onSkip={handleSkip}
            onOpenArtifact={(artifactId) => void handleOpenArtifact(artifactId)}
            onOpenLiveView={() => void handleOpenLiveView()}
            onConfirmAnswer={handleConfirmAnswer}
            wide={wide}
          />
        )}
      </div>
    </Dialog>
  );
}
