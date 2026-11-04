import { ArrowLeft, CheckCircle } from '@phosphor-icons/react';
import { useCallback, useEffect, useId, useRef, useState } from 'react';
import type { ApplicationArtifactSummary, ApplicationAttemptRecord } from '../../window.js';
import type { SelectedVacancy } from '../letters/types.js';
import { WarningBanner } from '../shell/index.js';
import { useSupportPrompt } from '../support/SupportPromptProvider.js';
import { ApplicationCritiquePanel } from './ApplicationCritiquePanel.js';
import { ApplicationReviewSession } from './ApplicationReviewSession.js';
import { PipelineLimitNotice, TechnicalDetails, useRecordPipelineLimit } from './apply-review-parts.js';
import {
  attemptListStatus,
  classifyReviewEntry,
  describePreparationBlocker,
  isLetterMissing,
  isTailoringStopped,
  nextReadyAttempt,
  pipelineLimit,
  preparationStatusLine,
  preparationSteps,
  TAILORING_STOPPED_PREFIX,
  workspaceStageFor,
} from './apply-workspace-state.js';
import { describeLetterBlocker } from './letter-blocker.js';
import { PostingVerificationNotice } from './PostingVerificationNotice.js';
import { isPostingPreparationStopDetail } from './posting-verification-text.js';
import { retryLabel, useWaitingForReset } from './provider-reset.js';
import {
  alreadySentFailure,
  errorText,
  notSentFailure,
  unconfirmedFailure,
  type ReviewFailure,
} from './review-outcome.js';

/** How often a preparing application is re-read while the workspace is open. */
export const WORKSPACE_POLL_MS = 1_500;

const DOCUMENT_LABEL: Record<ApplicationArtifactSummary['kind'], string> = {
  cv_pdf: 'Tailored CV',
  cover_letter_pdf: 'Cover letter',
  combined_pdf: 'Combined document',
  other: 'Application document',
};

/** CV first, then the letter: the order a person reads and an employer form asks for them. */
const DOCUMENT_ORDER: Record<ApplicationArtifactSummary['kind'], number> = {
  cv_pdf: 0,
  cover_letter_pdf: 1,
  combined_pdf: 2,
  other: 3,
};

type Phase =
  | { phase: 'loading' }
  | { phase: 'preparing' }
  | { phase: 'checking' }
  /** A manual (no-policy) package ready for the person. `approved` and `opened` live here only. */
  | { phase: 'manual'; approved: boolean; opened: boolean; busy: boolean }
  | { phase: 'tailoring_blocked'; message: string; busy: boolean }
  | { phase: 'preparation_blocked'; message: string; busy: boolean }
  /** An allowlisted, policy-backed site: the existing review dialog and its submit gate take over. */
  | { phase: 'live_review' }
  /** `failure.outcome` says whether anything reached the employer (#468). `checked` is set once the
   * person opened the employer page, which is what unlocks Try again after an unconfirmed outcome. */
  | { phase: 'error'; failure: ReviewFailure; busy: boolean; checked: boolean }
  | { phase: 'applied' }
  | { phase: 'skipped'; previous: ApplicationAttemptRecord; busy: boolean }
  /** Opened on an application that already finished (sent, recorded, skipped or failed). */
  | { phase: 'finished' };

export interface ApplyWorkspaceProps {
  attemptId: string;
  /** The record the host already holds (a list row), shown at once while a fresh copy is read. */
  initialAttempt?: ApplicationAttemptRecord | null;
  /** Visible label of the control that leaves the workspace, for example "Back to the vacancy". */
  closeLabel: string;
  onClose: () => void;
  /** Opens another application in this same workspace ("Next ready application"). */
  onOpenAttempt: (attemptId: string) => void;
  /** Hands the application to the letter generator; the host brings the person back here. */
  onGenerateLetter?: (vacancy: SelectedVacancy, attemptId: string) => void;
  /** Fired after anything changed the stored application, so the host can refresh lists and counts. */
  onChanged?: () => void;
  /** Passed to the allowlisted review dialog, whose skip the host can offer to undo (#468). */
  onSkipped?: (attempt: ApplicationAttemptRecord) => void;
}

/** Calls a bridge method so a throw or a missing promise becomes a rejection, never a crash. */
function call<T>(read: () => Promise<T>): Promise<T> {
  return Promise.resolve().then(read);
}

/** Reads one application. An empty answer counts as a failed read. */
async function readAttempt(attemptId: string): Promise<ApplicationAttemptRecord> {
  const fresh = await call(() => window.workspace.getApplicationAttempt(attemptId));
  if (!fresh) throw new Error('application not found');
  return fresh;
}

function errorPhase(failure: ReviewFailure): Phase {
  return { phase: 'error', failure, busy: false, checked: false };
}

/** The main window's open handler sends this to the system browser after its own safety check. */
function openInBrowser(url: string) {
  window.open(url, '_blank', 'noopener,noreferrer');
}

/**
 * The one Review & apply workspace for one application (#657). It opens in place on Search, and
 * the same component opens from Ready to apply, Saved jobs, Blind Apply and the "Application ready"
 * notification. It is a region of the page, not a dialog: the person reads documents and switches
 * to the employer site and back.
 *
 * Preparation progress streams into a polite live region and turns ready in place. A manual
 * package shows the tailored CV and letter together, an optional second opinion, one Approve
 * package action, then Open the employer form and I submitted it. The app never submits for a
 * manual site. Failure and retry states stay here with their actions.
 *
 * An allowlisted, policy-backed site keeps the existing review dialog with its live view and the
 * Send application gate (#202, #443): this component only routes to it.
 */
export function ApplyWorkspace({
  attemptId,
  initialAttempt = null,
  closeLabel,
  onClose,
  onOpenAttempt,
  onGenerateLetter,
  onChanged,
  onSkipped,
}: ApplyWorkspaceProps) {
  const headingId = useId();
  const headingRef = useRef<HTMLHeadingElement>(null);
  const openFormRef = useRef<HTMLButtonElement>(null);
  const { recordSuccessMoment } = useSupportPrompt();

  const seed = initialAttempt?.id === attemptId ? initialAttempt : null;
  const seedRef = useRef(seed);
  seedRef.current = seed;
  const [attempt, setAttempt] = useState<ApplicationAttemptRecord | null>(seed);
  const attemptRef = useRef<ApplicationAttemptRecord | null>(null);
  attemptRef.current = attempt;
  const [loadError, setLoadError] = useState<string | null>(null);
  const [phase, setPhase] = useState<Phase>({ phase: 'loading' });
  const [documents, setDocuments] = useState<readonly ApplicationArtifactSummary[]>([]);
  const [documentNote, setDocumentNote] = useState('');
  const [nextReady, setNextReady] = useState<ApplicationAttemptRecord | null>(null);
  const [critiqueOpen, setCritiqueOpen] = useState(false);
  /** Bumped to read the application again and decide its review entry from scratch. */
  const [entryNonce, setEntryNonce] = useState(0);
  /** One decision at a time: a double click must never record or skip twice. */
  const decisionRef = useRef(false);

  const stage = attempt ? workspaceStageFor(attempt.checkpoint) : null;

  const reload = useCallback(async () => {
    try {
      const fresh = await readAttempt(attemptId);
      setAttempt(fresh);
      setLoadError(null);
      return fresh;
    } catch {
      setLoadError('We could not load this application.');
      return null;
    }
  }, [attemptId]);

  // A different application: start over and move focus to its heading.
  useEffect(() => {
    let cancelled = false;
    const known = seedRef.current;
    setAttempt(known);
    setPhase({ phase: 'loading' });
    setDocuments([]);
    setDocumentNote('');
    setNextReady(null);
    setCritiqueOpen(false);
    setLoadError(null);
    decisionRef.current = false;
    // With a known record, only a newer stage replaces it: a stale read must not undo progress.
    readAttempt(attemptId)
      .then((fresh) => {
        if (!cancelled && (!known || fresh.updatedAt >= known.updatedAt)) setAttempt(fresh);
      })
      .catch(() => {
        if (!cancelled && !known) setLoadError('We could not load this application.');
      });
    headingRef.current?.focus({ preventScroll: false });
    return () => {
      cancelled = true;
    };
  }, [attemptId]);

  // Preparation runs in main. Re-read only this application while it is preparing; stop as soon as
  // it settles, and on unmount.
  const preparing = stage === 'preparing' && (phase.phase === 'loading' || phase.phase === 'preparing');
  useEffect(() => {
    if (!preparing) return;
    setPhase((current) => (current.phase === 'loading' ? { phase: 'preparing' } : current));
    let cancelled = false;
    const timer = window.setInterval(() => {
      readAttempt(attemptId)
        .then((fresh) => {
          if (!cancelled) setAttempt(fresh);
        })
        .catch(() => {});
    }, WORKSPACE_POLL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [attemptId, preparing]);

  // A finished application opened directly (a notification for an old one, a history row).
  useEffect(() => {
    if (stage === 'finished') setPhase((current) => (current.phase === 'loading' || current.phase === 'preparing' ? { phase: 'finished' } : current));
  }, [stage]);

  // Documents belong to this application only (#272). A failure never blocks the review.
  useEffect(() => {
    if (stage !== 'review') return;
    let cancelled = false;
    call(() => window.workspace.listApplicationArtifacts(attemptId))
      .then((rows) => {
        if (!cancelled) setDocuments(rows ?? []);
      })
      .catch(() => {
        if (!cancelled) setDocuments([]);
      });
    return () => {
      cancelled = true;
    };
  }, [attemptId, stage, entryNonce]);

  // The review entry: the same order the review dialog uses. One bounded posting check (#687,
  // reused when fresh), a tailoring stop, then the target policy for the link. Runs when the
  // application reaches review, and again after a retry or a posting decision.
  const reviewReady = stage === 'review';
  useEffect(() => {
    if (!reviewReady) return;
    const initial = attemptRef.current;
    if (!initial) return;
    let cancelled = false;
    async function start(current: ApplicationAttemptRecord) {
      setPhase({ phase: 'checking' });
      if (typeof window.applicationPipeline?.verifyPosting === 'function') {
        try {
          await window.applicationPipeline.verifyPosting(current.id);
          if (cancelled) return;
          current = await readAttempt(current.id);
          if (cancelled) return;
          setAttempt(current);
        } catch {
          // A check that cannot run never blocks the review.
        }
      }
      if (workspaceStageFor(current.checkpoint) !== 'review') return;
      if (isTailoringStopped(current)) {
        setPhase({ phase: 'tailoring_blocked', message: current.checkpointDetail, busy: false });
        return;
      }
      try {
        const policyId = await window.applicationExecutor.resolveTargetPolicyId(current.canonicalUrl);
        if (cancelled) return;
        const entry = classifyReviewEntry(current, policyId);
        if (entry.kind === 'live_review') setPhase({ phase: 'live_review' });
        else if (entry.kind === 'manual') setPhase({ phase: 'manual', approved: false, opened: false, busy: false });
        else setPhase({ phase: entry.kind, message: entry.message, busy: false });
      } catch (err) {
        if (!cancelled) setPhase(errorPhase(notSentFailure('We could not open this application.', errorText(err))));
      }
    }
    void start(initial);
    return () => {
      cancelled = true;
    };
  }, [attemptId, reviewReady, entryNonce]);

  // "Next ready application": read once the person has something to decide, and after a decision.
  const phaseName = phase.phase;
  useEffect(() => {
    if (phaseName === 'loading' || phaseName === 'checking') return;
    let cancelled = false;
    call(() => window.workspace.listApplicationAttempts())
      .then((rows) => {
        if (!cancelled) setNextReady(nextReadyAttempt(rows ?? [], attemptId));
      })
      .catch(() => {
        if (!cancelled) setNextReady(null);
      });
    return () => {
      cancelled = true;
    };
  }, [attemptId, phaseName]);

  // After Approve package, the next step is the one primary action left.
  const approved = phase.phase === 'manual' && phase.approved;
  useEffect(() => {
    if (approved) openFormRef.current?.focus();
  }, [approved]);

  /** Back to preparing in place after a retry, a resume or a refreshed posting. */
  const restartInPlace = useCallback(async () => {
    decisionRef.current = false;
    setDocuments([]);
    setPhase({ phase: 'preparing' });
    onChanged?.();
    await reload();
  }, [onChanged, reload]);

  const handleApprove = useCallback(() => {
    setPhase((current) => (current.phase === 'manual' && !current.busy ? { ...current, approved: true } : current));
  }, []);

  const handleOpenEmployerForm = useCallback(() => {
    if (!attempt?.canonicalUrl) return;
    openInBrowser(attempt.canonicalUrl);
    setPhase((current) => (current.phase === 'manual' ? { ...current, opened: true } : current));
  }, [attempt?.canonicalUrl]);

  /** The person's own statement that they submitted on the employer site. Recorded as
   * `user_reported`, strictly distinct from a receipt the app observed (#271). */
  const handleSubmitted = useCallback(async () => {
    if (phase.phase !== 'manual' || phase.busy || decisionRef.current) return;
    decisionRef.current = true;
    setPhase({ ...phase, busy: true });
    try {
      const result = await window.applicationExecutor.recordUserReportedSubmission(attemptId);
      if (!result.ok) {
        decisionRef.current = false;
        setPhase(errorPhase(notSentFailure('We could not record this application.', result.detail)));
        return;
      }
      recordSuccessMoment();
      setPhase({ phase: 'applied' });
      onChanged?.();
    } catch (err) {
      decisionRef.current = false;
      setPhase(errorPhase(notSentFailure('We could not record this application.', errorText(err))));
    }
  }, [attemptId, onChanged, phase, recordSuccessMoment]);

  const handleSkip = useCallback(async () => {
    if (!attempt) return;
    if (phase.phase !== 'manual' && phase.phase !== 'preparation_blocked' && phase.phase !== 'error') return;
    if (phase.busy || decisionRef.current) return;
    // Skipping from an error is only honoured when nothing was sent. After an unconfirmed send, a
    // skipped checkpoint would bury an application that may have gone out.
    if (phase.phase === 'error' && phase.failure.outcome !== 'not_sent') return;
    decisionRef.current = true;
    const previous = attempt;
    setPhase({ ...phase, busy: true } as Phase);
    try {
      await window.workspace.updateApplicationAttempt(attemptId, { checkpoint: 'skipped' });
      setPhase({ phase: 'skipped', previous, busy: false });
      onChanged?.();
    } catch (err) {
      decisionRef.current = false;
      setPhase(errorPhase(notSentFailure('We could not skip this application.', errorText(err))));
    }
  }, [attempt, attemptId, onChanged, phase]);

  // Reverses only the skip. The application is read again first: if it moved on from `skipped`,
  // undo does nothing rather than overwrite a later checkpoint such as a submission (#468).
  const handleUndoSkip = useCallback(async () => {
    if (phase.phase !== 'skipped' || phase.busy) return;
    const { previous } = phase;
    setPhase({ ...phase, busy: true });
    try {
      const current = await readAttempt(attemptId);
      if (current.checkpoint === 'skipped') {
        await window.workspace.updateApplicationAttempt(attemptId, {
          checkpoint: previous.checkpoint,
          checkpointDetail: previous.checkpointDetail,
        });
      }
      decisionRef.current = false;
      setPhase({ phase: 'loading' });
      onChanged?.();
      const fresh = await reload();
      if (fresh) setEntryNonce((nonce) => nonce + 1);
    } catch (err) {
      setPhase(errorPhase(notSentFailure('We could not undo the skip.', errorText(err))));
    }
  }, [attemptId, onChanged, phase, reload]);

  const handleErrorRetry = useCallback(() => {
    if (phase.phase !== 'error' || phase.busy) return;
    // After an unconfirmed send the same click could send a duplicate application, so the person
    // must have looked at the employer page (or recorded the outcome) first.
    if (phase.failure.outcome === 'unconfirmed' && !phase.checked) return;
    decisionRef.current = false;
    setEntryNonce((nonce) => nonce + 1);
  }, [phase]);

  const handleErrorOpenEmployerPage = useCallback(() => {
    if (phase.phase !== 'error' || !attempt?.canonicalUrl) return;
    openInBrowser(attempt.canonicalUrl);
    setPhase({ ...phase, checked: true });
  }, [attempt?.canonicalUrl, phase]);

  const handleErrorRecordApplied = useCallback(async () => {
    if (phase.phase !== 'error' || phase.busy) return;
    setPhase({ ...phase, busy: true });
    try {
      const result = await window.applicationExecutor.recordUserReportedSubmission(attemptId);
      if (result.ok) {
        recordSuccessMoment();
        setPhase({ phase: 'applied' });
        onChanged?.();
        return;
      }
      setPhase(errorPhase(result.reason === 'already_observed' ? alreadySentFailure(result.detail) : unconfirmedFailure(result.detail)));
    } catch (err) {
      setPhase(errorPhase(unconfirmedFailure(errorText(err))));
    }
  }, [attemptId, onChanged, phase, recordSuccessMoment]);

  const handleSaveArtifact = useCallback(async (document: ApplicationArtifactSummary) => {
    setDocumentNote('');
    try {
      const result = await window.applicationExecutor.saveArtifact(document.id);
      if (result?.saved) setDocumentNote(`Saved a copy of the ${DOCUMENT_LABEL[document.kind].toLowerCase()}.`);
    } catch (err) {
      setPhase(errorPhase(notSentFailure('We could not save this document.', errorText(err))));
    }
  }, []);

  const handleOpenArtifact = useCallback(async (document: ApplicationArtifactSummary) => {
    setDocumentNote('');
    try {
      const result = await window.applicationExecutor.openArtifact(document.id);
      if (!result.opened) throw new Error(result.detail ?? 'could not open this document');
    } catch (err) {
      setPhase(errorPhase(notSentFailure('We could not open this document.', errorText(err))));
    }
  }, []);

  const handleTailoringRecovery = useCallback(async (mode: 'retry' | 'original') => {
    if (phase.phase !== 'tailoring_blocked' || phase.busy) return;
    setPhase({ ...phase, busy: true });
    try {
      const result = mode === 'retry'
        ? await window.applicationPipeline.retryTailoring(attemptId)
        : await window.applicationPipeline.useOriginalCv(attemptId);
      if (!result.ok) throw new Error(result.detail ?? 'could not restart application preparation');
      await restartInPlace();
    } catch (err) {
      setPhase({ phase: 'tailoring_blocked', message: err instanceof Error ? err.message : 'could not restart application preparation', busy: false });
    }
  }, [attemptId, phase, restartInPlace]);

  /** Runs preparation again after the blocker was addressed. Also retries a missing letter. */
  const handleResume = useCallback(async () => {
    if (phase.phase !== 'preparation_blocked' && phase.phase !== 'manual' && phase.phase !== 'finished') return;
    if (phase.phase !== 'finished' && phase.busy) return;
    if (phase.phase !== 'finished') setPhase({ ...phase, busy: true } as Phase);
    try {
      const result = await window.applicationPipeline.resume(attemptId);
      if (!result.ok) throw new Error(result.detail ?? 'could not resume application preparation');
      await restartInPlace();
    } catch (err) {
      setPhase({ phase: 'preparation_blocked', message: err instanceof Error ? err.message : 'could not resume application preparation', busy: false });
    }
  }, [attemptId, phase, restartInPlace]);

  const handleGenerateLetter = useCallback(() => {
    if (!onGenerateLetter || !attempt) return;
    onGenerateLetter({
      key: attempt.vacancyKey,
      title: attempt.role,
      company: attempt.company,
      location: '',
      url: attempt.canonicalUrl,
      description: attempt.jdSnapshot,
    }, attempt.id);
  }, [attempt, onGenerateLetter]);

  const blockedMessage = phase.phase === 'tailoring_blocked' || phase.phase === 'preparation_blocked' ? phase.message : null;
  const limit = blockedMessage === null || !attempt ? null : pipelineLimit(blockedMessage, attempt.updatedAt);
  const waitingForReset = useWaitingForReset(limit?.resetAt);
  useRecordPipelineLimit(limit, attempt?.updatedAt ?? '');

  const letterMissing = phase.phase === 'manual' && attempt !== null && isLetterMissing(attempt.checkpointDetail, documents);
  const letterBlocker = letterMissing && attempt ? describeLetterBlocker(attempt.checkpointDetail, attempt.updatedAt) : null;
  const letterWaitingForReset = useWaitingForReset(letterBlocker?.limit?.resetAt);

  const busy =
    (phase.phase === 'manual' || phase.phase === 'tailoring_blocked' || phase.phase === 'preparation_blocked' || phase.phase === 'error' || phase.phase === 'skipped') &&
    phase.busy;

  const role = attempt?.role ?? '';
  const company = attempt?.company ?? '';
  const statusLine = workspaceStatusLine(phase, attempt);
  const sortedDocuments = [...documents].sort((a, b) => DOCUMENT_ORDER[a.kind] - DOCUMENT_ORDER[b.kind]);
  const hasUrl = Boolean(attempt?.canonicalUrl);

  return (
    <section
      aria-labelledby={headingId}
      data-testid="apply-workspace"
      className="mx-auto w-full max-w-2xl px-6 py-5 pb-10"
    >
      <div className="mb-3">
        <button type="button" className="btn btn-ghost btn-sm -ml-2" disabled={busy} onClick={onClose}>
          <ArrowLeft size={14} aria-hidden="true" />
          {closeLabel}
        </button>
      </div>

      <p className="ovr-eyebrow">{'Review & apply'}</p>
      <h2
        id={headingId}
        ref={headingRef}
        tabIndex={-1}
        data-apply-workspace-heading=""
        className="mt-1 break-words text-xl font-semibold outline-none"
      >
        {attempt ? `${role} at ${company}` : 'Your application'}
      </h2>

      <div className="mt-2 flex flex-wrap items-center gap-2 text-sm">
        {phase.phase === 'manual' && (
          <span className="badge badge-success badge-soft">
            <CheckCircle size={14} aria-hidden="true" />
            Ready to review
          </span>
        )}
        <p role="status" aria-live="polite" className="text-base-content/70" data-testid="apply-workspace-status">
          {statusLine}
        </p>
      </div>

      {loadError && (
        <div className="alert alert-error mt-4 text-sm" role="alert">
          {loadError}
        </div>
      )}

      {attempt && (phase.phase === 'manual' || phase.phase === 'tailoring_blocked' || phase.phase === 'preparation_blocked' || phase.phase === 'error') && (
        <div className="mt-4">
          <PostingVerificationNotice
            attemptId={attempt.id}
            postingUrl={attempt.canonicalUrl}
            reloadKey={`${attempt.updatedAt}:${entryNonce}`}
            disabled={busy}
            onDone={(kind, view) => {
              if (kind === 'refreshed' || kind === 'resumed') void restartInPlace();
              // A package taken out of review, or put back exactly as it was: read it again and decide.
              else if (kind === 'restored' || view?.invalidated || view?.released) {
                void reload().then(() => setEntryNonce((nonce) => nonce + 1));
              }
            }}
          />
        </div>
      )}

      {phase.phase === 'preparing' && attempt && (
        <div className="mt-5">
          <ol className="space-y-2" aria-label="Preparation steps">
            {preparationSteps(attempt.checkpoint).map((step) => (
              <li key={step.label} className="flex items-center gap-2 text-sm">
                {step.state === 'done' ? (
                  <CheckCircle size={16} className="text-success" aria-hidden="true" />
                ) : step.state === 'current' ? (
                  <span className="loading loading-spinner loading-xs" aria-hidden="true" />
                ) : (
                  <span className="inline-block size-4 rounded-full border border-base-300" aria-hidden="true" />
                )}
                <span className={step.state === 'todo' ? 'text-base-content/60' : ''}>
                  {step.label}
                  <span className="sr-only">
                    {step.state === 'done' ? ' (done)' : step.state === 'current' ? ' (in progress)' : ' (not started)'}
                  </span>
                </span>
              </li>
            ))}
          </ol>
          <p className="mt-4 text-xs text-base-content/70">
            You can leave this page. The application turns ready here and under Ready to apply.
          </p>
        </div>
      )}

      {(phase.phase === 'loading' || phase.phase === 'checking') && (
        <div className="flex items-center gap-2 py-8 text-sm text-base-content/70">
          <span className="loading loading-spinner loading-sm" aria-hidden="true" />
        </div>
      )}

      {phase.phase === 'manual' && attempt && (
        <div className="mt-5 space-y-5">
          <section aria-labelledby={`${headingId}-documents`}>
            <h3 id={`${headingId}-documents`} className="ovr-eyebrow">
              Your documents
            </h3>
            {sortedDocuments.length === 0 ? (
              <p className="mt-2 text-sm text-base-content/70">No document is ready yet.</p>
            ) : (
              <ul className="mt-2 space-y-2">
                {sortedDocuments.map((document) => (
                  <li
                    key={document.id}
                    className="flex flex-wrap items-center justify-between gap-3 rounded-box border border-base-300 px-3 py-2"
                  >
                    <span className="text-sm font-medium">{DOCUMENT_LABEL[document.kind]}</span>
                    <span className="flex gap-1">
                      <button
                        type="button"
                        className="btn btn-ghost btn-sm"
                        aria-label={`Open ${DOCUMENT_LABEL[document.kind]}`}
                        onClick={() => void handleOpenArtifact(document)}
                      >
                        Open
                      </button>
                      <button
                        type="button"
                        className="btn btn-outline btn-sm"
                        aria-label={`Save copy of ${DOCUMENT_LABEL[document.kind]}`}
                        onClick={() => void handleSaveArtifact(document)}
                      >
                        Save copy
                      </button>
                    </span>
                  </li>
                ))}
              </ul>
            )}
            {letterMissing && (
              <div className="mt-2 rounded-box border border-warning/50 px-3 py-2" data-testid="apply-letter-missing">
                <p className="text-sm font-medium">Cover letter</p>
                <p className="mt-0.5 text-sm text-base-content/70">
                  {letterBlocker?.message ?? 'The cover letter still needs attention.'} You can also add one on the employer site.
                </p>
                {letterBlocker?.detail ? <TechnicalDetails text={letterBlocker.detail} label="Details" /> : null}
                <div className="mt-2 flex flex-wrap gap-2">
                  <button
                    type="button"
                    className="btn btn-outline btn-sm"
                    disabled={busy || letterWaitingForReset}
                    onClick={() => void handleResume()}
                  >
                    {retryLabel(letterBlocker?.limit, letterWaitingForReset, 'Try again')}
                  </button>
                  {onGenerateLetter && (
                    <button type="button" className="btn btn-outline btn-sm" disabled={busy} onClick={handleGenerateLetter}>
                      Generate letter
                    </button>
                  )}
                </div>
              </div>
            )}
            <p role="status" className="mt-1 min-h-4 text-xs text-base-content/70">
              {documentNote}
            </p>
          </section>

          <details
            className="rounded-box border border-base-300 px-3 py-2"
            onToggle={(event) => setCritiqueOpen((event.currentTarget as HTMLDetailsElement).open)}
          >
            <summary className="cursor-pointer text-sm font-medium">Second opinion (optional)</summary>
            <p className="mt-1 text-xs text-base-content/70">
              A separate AI reads your CV and letter for claims your CV does not back up and requirements they miss.
            </p>
            {critiqueOpen && (
              <div className="mt-3">
                <ApplicationCritiquePanel
                  attemptId={attempt.id}
                  checkpoint={attempt.checkpoint}
                  reloadKey={attempt.updatedAt}
                  onRevised={() => {
                    void reload().then(() => setEntryNonce((nonce) => nonce + 1));
                    onChanged?.();
                  }}
                />
              </div>
            )}
          </details>

          {!phase.approved ? (
            <div className="space-y-2">
              <div className="flex flex-wrap gap-2">
                <button type="button" className="btn btn-primary" disabled={busy} onClick={handleApprove}>
                  Approve package
                </button>
                {letterMissing && hasUrl && (
                  <button type="button" className="btn btn-outline" disabled={busy} onClick={handleOpenEmployerForm}>
                    Open the employer form
                  </button>
                )}
                <button type="button" className="btn btn-ghost" disabled={busy} onClick={() => void handleSkip()}>
                  Skip
                </button>
              </div>
              <p className="text-xs text-base-content/70">You submit on the employer&apos;s site. Nothing is sent from here.</p>
            </div>
          ) : !phase.opened ? (
            <div className="space-y-2">
              <div className="flex flex-wrap gap-2">
                <button
                  ref={openFormRef}
                  type="button"
                  className="btn btn-primary"
                  disabled={busy || !hasUrl}
                  onClick={handleOpenEmployerForm}
                >
                  Open the employer form
                </button>
                <button type="button" className="btn btn-ghost" disabled={busy} onClick={() => void handleSkip()}>
                  Skip
                </button>
              </div>
              <p className="text-xs text-base-content/70">It opens in your browser. Submit there, then come back here.</p>
            </div>
          ) : (
            <div className="space-y-2">
              <p className="text-sm">Submitted it on {company}&apos;s site?</p>
              <div className="flex flex-wrap gap-2">
                <button type="button" className="btn btn-success" disabled={busy} onClick={() => void handleSubmitted()}>
                  I submitted it
                </button>
                <button type="button" className="btn btn-outline" disabled={busy} onClick={onClose}>
                  Not yet
                </button>
                <button type="button" className="btn btn-ghost" disabled={busy || !hasUrl} onClick={handleOpenEmployerForm}>
                  Open the employer form again
                </button>
              </div>
            </div>
          )}
        </div>
      )}

      {phase.phase === 'tailoring_blocked' && (
        <div className="mt-5 space-y-4">
          {limit ? <PipelineLimitNotice info={limit} /> : <WarningBanner>We could not tailor your CV for this job.</WarningBanner>}
          <TechnicalDetails text={phase.message.replace(TAILORING_STOPPED_PREFIX, '').trim()} label="Details" />
          {!limit && <p className="text-sm text-base-content/70">Try again, or use your CV as it is.</p>}
          <div className="flex flex-wrap gap-2">
            <button type="button" className="btn btn-primary" disabled={busy || waitingForReset} onClick={() => void handleTailoringRecovery('retry')}>
              {phase.busy ? 'Restarting…' : retryLabel(limit, waitingForReset, 'Try again')}
            </button>
            <button type="button" className="btn btn-outline" disabled={busy} onClick={() => void handleTailoringRecovery('original')}>
              Use my CV as it is
            </button>
            {hasUrl && (
              <button type="button" className="btn btn-ghost" disabled={busy} onClick={() => attempt && openInBrowser(attempt.canonicalUrl)}>
                Open the employer form
              </button>
            )}
          </div>
        </div>
      )}

      {phase.phase === 'preparation_blocked' && (
        <div className="mt-5 space-y-4">
          {isPostingPreparationStopDetail(phase.message) ? null : limit ? (
            <PipelineLimitNotice info={limit} />
          ) : (
            <WarningBanner>{describePreparationBlocker(phase.message)}</WarningBanner>
          )}
          {isPostingPreparationStopDetail(phase.message) ? null : <TechnicalDetails text={phase.message} label="Details" />}
          {!limit && !isPostingPreparationStopDetail(phase.message) && (
            <p className="text-sm text-base-content/70">Resume to try again, or skip this one.</p>
          )}
          <div className="flex flex-wrap gap-2">
            {isPostingPreparationStopDetail(phase.message) ? null : (
              <button type="button" className="btn btn-primary" disabled={busy || waitingForReset} onClick={() => void handleResume()}>
                {phase.busy ? 'Resuming…' : retryLabel(limit, waitingForReset, 'Resume')}
              </button>
            )}
            {onGenerateLetter && /\b(cover|motivation) letter\b/iu.test(phase.message) && (
              <button type="button" className="btn btn-outline" disabled={busy} onClick={handleGenerateLetter}>
                Generate letter
              </button>
            )}
            {!isPostingPreparationStopDetail(phase.message) && hasUrl && (
              <button type="button" className="btn btn-outline" disabled={busy} onClick={() => attempt && openInBrowser(attempt.canonicalUrl)}>
                Open the employer form
              </button>
            )}
            <button type="button" className="btn btn-ghost" disabled={busy} onClick={() => void handleSkip()}>
              Skip
            </button>
          </div>
        </div>
      )}

      {phase.phase === 'error' && (
        <div className="mt-5 space-y-4">
          <div
            className={`alert ${phase.failure.outcome === 'unconfirmed' ? 'alert-warning' : phase.failure.outcome === 'sent' ? 'alert-info' : 'alert-error'}`}
            role="alert"
          >
            <p className="font-semibold">{phase.failure.message}</p>
          </div>
          {phase.failure.detail ? <TechnicalDetails text={phase.failure.detail} label="Technical details" /> : null}
          {phase.failure.outcome === 'unconfirmed' && !phase.checked ? (
            <p className="text-xs text-base-content/70">Check the employer site first. Then Try again unlocks.</p>
          ) : null}
          <div className="flex flex-wrap gap-2">
            {phase.failure.outcome === 'sent' ? (
              <button type="button" className="btn btn-primary" onClick={onClose}>
                Done
              </button>
            ) : (
              <button
                type="button"
                className="btn btn-primary"
                disabled={phase.busy || (phase.failure.outcome === 'unconfirmed' && !phase.checked)}
                onClick={handleErrorRetry}
              >
                Try again
              </button>
            )}
            {hasUrl && phase.failure.outcome !== 'sent' ? (
              <button type="button" className="btn btn-outline" disabled={phase.busy} onClick={handleErrorOpenEmployerPage}>
                Open the employer form
              </button>
            ) : null}
            {phase.failure.outcome === 'not_sent' ? (
              <button type="button" className="btn btn-outline" disabled={phase.busy} onClick={() => void handleSkip()}>
                Skip for now
              </button>
            ) : null}
            {phase.failure.outcome === 'unconfirmed' ? (
              <button type="button" className="btn btn-outline" disabled={phase.busy} onClick={() => void handleErrorRecordApplied()}>
                I already applied
              </button>
            ) : null}
          </div>
        </div>
      )}

      {phase.phase === 'skipped' && (
        <div className="mt-5 flex flex-wrap items-center gap-2">
          <button type="button" className="btn btn-outline btn-sm" disabled={phase.busy} onClick={() => void handleUndoSkip()}>
            Undo
          </button>
        </div>
      )}

      {phase.phase === 'finished' && attempt?.checkpoint === 'failed' && (
        <div className="mt-5 flex flex-wrap gap-2">
          <button type="button" className="btn btn-primary" onClick={() => void handleResume()}>
            Try again
          </button>
        </div>
      )}

      {phase.phase === 'live_review' && attempt && (
        <ApplicationReviewSession
          attempt={attempt}
          onClose={() => {
            onChanged?.();
            onClose();
          }}
          {...(onGenerateLetter ? { onGenerateLetter } : {})}
          {...(onSkipped ? { onSkipped } : {})}
        />
      )}

      {nextReady && phase.phase !== 'loading' && phase.phase !== 'checking' && phase.phase !== 'live_review' && (
        <div className="mt-6 border-t border-base-300 pt-4">
          <button
            type="button"
            className="btn btn-outline btn-sm"
            disabled={busy}
            aria-describedby={`${headingId}-next`}
            onClick={() => onOpenAttempt(nextReady.id)}
          >
            Next ready application
          </button>
          <p id={`${headingId}-next`} className="mt-1 text-xs text-base-content/70">
            {nextReady.role} at {nextReady.company}
          </p>
        </div>
      )}
    </section>
  );
}

/** The one sentence in the polite live region for the current state. Never pipeline terms. */
function workspaceStatusLine(phase: Phase, attempt: ApplicationAttemptRecord | null): string {
  switch (phase.phase) {
    case 'loading':
      return 'Opening your application…';
    case 'preparing':
      return attempt ? preparationStatusLine(attempt.checkpoint) : 'Getting your application ready…';
    case 'checking':
      return 'Checking the posting is still open…';
    case 'manual':
      if (phase.opened) return `Employer form opened. Submit it on ${attempt?.company ?? 'the employer'}'s site, then come back.`;
      if (phase.approved) return 'Package approved. Open the employer form next.';
      return `Your CV and letter are ready. You apply on ${attempt?.company ?? 'the employer'}'s site.`;
    case 'tailoring_blocked':
      return 'Your CV could not be tailored yet.';
    case 'preparation_blocked':
      return isPostingPreparationStopDetail(phase.message) ? 'Check the posting before you go on.' : 'Preparation stopped before your documents were ready.';
    case 'error':
      // The alert below says it; saying it here too would announce it twice.
      return '';
    case 'live_review':
      return 'The employer form review is open.';
    case 'applied':
      return `Recorded. ${attempt ? `${attempt.role} at ${attempt.company}` : 'This application'} is marked as applied.`;
    case 'skipped':
      return attempt ? `Skipped ${attempt.role} at ${attempt.company}.` : 'Skipped.';
    case 'finished':
      return attempt ? attemptListStatus(attempt).label : '';
  }
}
