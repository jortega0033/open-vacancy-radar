import type { ApplicationArtifactSummary, ApplicationAttemptCheckpoint, ApplicationAttemptRecord } from '../../window.js';
import { classifyProviderError, type ProviderErrorInfo } from '../../provider-error.js';
import { ATTEMPT_CHECKPOINT_BADGE_CLASS, ATTEMPT_CHECKPOINT_LABEL } from './attempt-status.js';

/**
 * Pure state for the Review & apply workspace (#657): which stage an application is in, what its
 * progress says, how a stored checkpoint detail is classified, and the list label a person sees.
 *
 * The workspace and the policy-backed review dialog both read these, so the prose matching the
 * pipeline's stored sentences lives in one module with its own tests instead of being repeated in
 * several components.
 */

/** Checkpoints where preparation is still running and the workspace shows progress in place. */
export const PREPARING_CHECKPOINTS: ReadonlySet<ApplicationAttemptCheckpoint> = new Set([
  'queued',
  'reading_jd',
  'tailoring',
  'rendering',
  'filling',
  'submitting',
]);

/** Checkpoints that wait for the person: the package is ready, or something needs their decision. */
export const REVIEW_CHECKPOINTS: ReadonlySet<ApplicationAttemptCheckpoint> = new Set(['ready', 'needs_user']);

export type WorkspaceStage = 'preparing' | 'review' | 'finished';

export function workspaceStageFor(checkpoint: ApplicationAttemptCheckpoint): WorkspaceStage {
  if (PREPARING_CHECKPOINTS.has(checkpoint)) return 'preparing';
  if (REVIEW_CHECKPOINTS.has(checkpoint)) return 'review';
  return 'finished';
}

/**
 * True while a send is in flight: the Send application click (`application-review-session.ts`) or
 * Blind Apply about to send writes `submitting`. It is listed with the preparing checkpoints so the
 * workspace keeps re-reading it, but it is never shown as preparation, and it never offers the
 * employer form, which could lead to a second, duplicate application.
 */
export function isSendInProgress(checkpoint: ApplicationAttemptCheckpoint): boolean {
  return checkpoint === 'submitting';
}

/** The stored sentence the pipeline writes when automatic tailoring stops (`application-pipeline.ts`
 * matches on the same prefix). The raw reason after it is kept for a Details disclosure. */
export const TAILORING_STOPPED_PREFIX = 'Automatic CV tailoring stopped:';

/** Phrases the pipeline writes when a manual (no-policy) package is useful to the person. */
const MANUAL_DOCUMENTS_READY_PHRASES = [
  'Your application documents are ready.',
  'Your tailored CV is ready.',
  'Your CV was prepared without any skills.',
] as const;

/** True when a stored detail says the prepared documents can be used on the employer site. */
export function hasUsefulManualDocuments(detail: string): boolean {
  return MANUAL_DOCUMENTS_READY_PHRASES.some((phrase) => detail.includes(phrase));
}

/** True when a `needs_user` detail is a success (documents ready), not a blocker. */
export function isDocumentsReadyDetail(detail: string): boolean {
  return detail.includes('Your application documents are ready.');
}

/** True when the cover letter of a manual package is missing and the detail says why. */
export function isLetterMissing(detail: string, documents: readonly ApplicationArtifactSummary[]): boolean {
  return (
    !documents.some((document) => document.kind === 'cover_letter_pdf' || document.kind === 'combined_pdf') &&
    /\b(?:cover|motivation) letter\b/iu.test(detail)
  );
}

/** One plain sentence for a blocked preparation. The pipeline's own sentence stays in Details. */
export function describePreparationBlocker(message: string): string {
  return /\b(?:cover|motivation) letter\b/iu.test(message)
    ? 'Your cover letter still needs attention.'
    : 'This application needs your attention.';
}

/**
 * Markers after which the pipeline stores a provider run's own failure text. Only that text is
 * classified, never the whole detail, so a blocker about the form that happens to mention "429" or
 * "rate limit" is not mistaken for Claude's usage limit (#546).
 */
const PROVIDER_FAILURE_MARKERS = [
  TAILORING_STOPPED_PREFIX,
  'automatic cover letter generation stopped:',
  'working out what goes in each field did not finish:',
] as const;

/**
 * A usage limit behind a blocked preparation. The reset time is placed relative to when the
 * attempt last changed, not to now, so a stored message read hours later does not move the reset
 * into the future.
 */
export function pipelineLimit(message: string, updatedAt: string): ProviderErrorInfo | null {
  const marker = PROVIDER_FAILURE_MARKERS.find((candidate) => message.includes(candidate));
  if (!marker) return null;
  const providerText = message.slice(message.indexOf(marker) + marker.length);
  const when = Date.parse(updatedAt);
  const info = classifyProviderError(providerText, Number.isNaN(when) ? new Date() : new Date(when));
  return info.kind === 'usage_limit' ? info : null;
}

/** A limit with no reset time is not recorded once it is older than Claude's usage window. */
export const UNTIMED_LIMIT_MAX_AGE_MS = 5 * 60 * 60 * 1000;

/**
 * How a review-stage application opens, decided from the stored attempt and the target policy the
 * main process resolved for its link. `live_review` is the allowlisted, policy-backed path: it keeps
 * the existing review dialog with its live view and Send application gate untouched.
 */
export type ReviewEntry =
  | { kind: 'tailoring_blocked'; message: string }
  | { kind: 'preparation_blocked'; message: string }
  | { kind: 'manual' }
  | { kind: 'live_review'; policyId: string };

/** Tailoring stops are known before a policy lookup is needed. */
export function isTailoringStopped(attempt: Pick<ApplicationAttemptRecord, 'checkpoint' | 'checkpointDetail'>): boolean {
  return attempt.checkpoint === 'needs_user' && attempt.checkpointDetail.startsWith(TAILORING_STOPPED_PREFIX);
}

export function classifyReviewEntry(
  attempt: Pick<ApplicationAttemptRecord, 'checkpoint' | 'checkpointDetail'>,
  policyId: string | null,
): ReviewEntry {
  if (isTailoringStopped(attempt)) return { kind: 'tailoring_blocked', message: attempt.checkpointDetail };
  if (!policyId) {
    if (attempt.checkpoint === 'needs_user' && !hasUsefulManualDocuments(attempt.checkpointDetail)) {
      return { kind: 'preparation_blocked', message: attempt.checkpointDetail };
    }
    return { kind: 'manual' };
  }
  if (attempt.checkpoint === 'needs_user') return { kind: 'preparation_blocked', message: attempt.checkpointDetail };
  return { kind: 'live_review', policyId };
}

export type ProgressStepState = 'done' | 'current' | 'todo';

export interface ProgressStep {
  label: string;
  state: ProgressStepState;
}

/**
 * The preparation progress shown in place, in plain words (text diet T17). Pipeline checkpoint
 * names never reach the screen. `filling` only happens for an allowlisted site. `submitting` is a
 * send in flight (see `isSendInProgress`) and the workspace shows it without these steps.
 */
const PROGRESS_STEPS = ['Checking the posting', 'Writing your CV', 'Writing your letter and files', 'Ready to review'] as const;

function progressIndex(checkpoint: ApplicationAttemptCheckpoint): number {
  switch (checkpoint) {
    case 'queued':
    case 'reading_jd':
      return 0;
    case 'tailoring':
      return 1;
    case 'rendering':
      return 2;
    case 'filling':
    case 'submitting':
      return 2;
    default:
      return PROGRESS_STEPS.length - 1;
  }
}

export function preparationSteps(checkpoint: ApplicationAttemptCheckpoint): ProgressStep[] {
  const current = progressIndex(checkpoint);
  const finished = !PREPARING_CHECKPOINTS.has(checkpoint);
  return PROGRESS_STEPS.map((label, index) => ({
    label,
    state: finished || index < current ? 'done' : index === current ? 'current' : 'todo',
  }));
}

/** The one sentence the polite live region says while preparation runs. */
export function preparationStatusLine(checkpoint: ApplicationAttemptCheckpoint): string {
  switch (checkpoint) {
    case 'queued':
      return 'Waiting to start. Checking the posting comes first.';
    case 'reading_jd':
      return 'Checking the posting is still open…';
    case 'tailoring':
      return 'Writing your CV for this job…';
    case 'rendering':
      return 'Writing your letter and making the files…';
    case 'filling':
      return 'Getting the employer form ready…';
    case 'submitting':
      return 'Sending your application…';
    default:
      return 'Ready to review.';
  }
}

export interface AttemptListStatus {
  label: string;
  badgeClass: string;
}

/**
 * The list label for an application. A successful manual package is "Ready to review" (success),
 * never the warning "Needs your input"; that label stays for real blockers.
 */
export function attemptListStatus(attempt: Pick<ApplicationAttemptRecord, 'checkpoint' | 'checkpointDetail'>): AttemptListStatus {
  if (attempt.checkpoint === 'needs_user' && isDocumentsReadyDetail(attempt.checkpointDetail)) {
    return { label: 'Ready to review', badgeClass: 'badge badge-success badge-soft' };
  }
  return {
    label: ATTEMPT_CHECKPOINT_LABEL[attempt.checkpoint],
    badgeClass: ATTEMPT_CHECKPOINT_BADGE_CLASS[attempt.checkpoint],
  };
}

/** The next application waiting for the person, newest first, never the one already open. */
export function nextReadyAttempt(
  attempts: readonly ApplicationAttemptRecord[],
  currentId: string,
): ApplicationAttemptRecord | null {
  const waiting = attempts
    .filter((attempt) => attempt.id !== currentId && REVIEW_CHECKPOINTS.has(attempt.checkpoint) && !attempt.scheduledAutomaticSubmitAt)
    .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
  return waiting[0] ?? null;
}
