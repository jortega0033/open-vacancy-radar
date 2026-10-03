import { useEffect, useRef, useState } from 'react';
import type { ApplicationAttemptRecord } from '../../window.js';

/** What the shell learned when it asked the backend to stop a scheduled send. */
export type CancelScheduledOutcome =
  /** The backend accepted it and the attempt is back in Review. */
  | { status: 'cancelled' }
  /** The deadline had already passed or the send had started: say what happened instead. */
  | { status: 'too_late'; checkpoint: ApplicationAttemptRecord['checkpoint'] }
  | { status: 'failed' };

export interface ScheduledSendBannerProps {
  /** Attempts with a send scheduled and not yet fired, from the persisted attempt store. */
  attempts: readonly ApplicationAttemptRecord[];
  onReview: (attemptId: string) => void;
  onCancel: (attempt: ApplicationAttemptRecord) => Promise<CancelScheduledOutcome>;
}

const MAX_VISIBLE = 3;
const NOTICE_MS = 10_000;

function remainingMs(attempt: ApplicationAttemptRecord, now: number): number {
  return Date.parse(attempt.scheduledAutomaticSubmitAt ?? '') - now;
}

/** m:ss for the visible countdown. */
function formatCountdown(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

/** Whole minutes rounded up, for the sentence a screen reader hears. It changes once a minute, not
 * once a second, so a live region is not spoken on every tick. */
function spokenMinutes(ms: number): string {
  const minutes = Math.max(1, Math.ceil(ms / 60_000));
  return `${minutes} min`;
}

function noticeText(attempt: ApplicationAttemptRecord, outcome: CancelScheduledOutcome): string {
  if (outcome.status === 'cancelled') return `Sending cancelled. ${attempt.role} is back in Review.`;
  if (outcome.status === 'too_late') {
    return outcome.checkpoint === 'submitted' || outcome.checkpoint === 'submitting' || outcome.checkpoint === 'submission_unknown'
      ? `Too late to cancel: the application to ${attempt.company} for ${attempt.role} was already sent. Check its status in Applications.`
      : `The send to ${attempt.company} was not cancelled by this action, and ${attempt.role} is no longer scheduled. Check its status in Applications.`;
  }
  return `Could not cancel sending to ${attempt.company}. It is still scheduled; try again or open Review.`;
}

/**
 * App-wide notice while an automatic submission is scheduled (#445): who it goes to, a live
 * countdown to the persisted deadline, and a Cancel that names the exact application. Shown on
 * every page, because the cancel window is a few minutes and the person may be anywhere.
 *
 * The countdown is computed from the stored deadline against the clock on every tick, so it stays
 * right after sleep or a restart. A deadline that has passed shows "Sending now" and no Cancel,
 * rather than a button that can no longer do anything; the next refresh shows the resulting state.
 */
export function ScheduledSendBanner({ attempts, onReview, onCancel }: ScheduledSendBannerProps) {
  const [now, setNow] = useState(() => Date.now());
  const [cancelling, setCancelling] = useState<ReadonlySet<string>>(() => new Set());
  const [notices, setNotices] = useState<readonly { id: string; text: string; ok: boolean }[]>([]);
  const timers = useRef<number[]>([]);

  useEffect(() => {
    if (attempts.length === 0) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [attempts.length]);

  useEffect(() => () => timers.current.forEach((timer) => window.clearTimeout(timer)), []);

  async function cancel(attempt: ApplicationAttemptRecord) {
    setCancelling((current) => new Set(current).add(attempt.id));
    let outcome: CancelScheduledOutcome;
    try {
      outcome = await onCancel(attempt);
    } catch {
      outcome = { status: 'failed' };
    }
    setCancelling((current) => {
      const next = new Set(current);
      next.delete(attempt.id);
      return next;
    });
    const id = `${attempt.id}:${Date.now()}`;
    setNotices((current) => [...current, { id, text: noticeText(attempt, outcome), ok: outcome.status === 'cancelled' }]);
    timers.current.push(window.setTimeout(() => setNotices((current) => current.filter((notice) => notice.id !== id)), NOTICE_MS));
  }

  if (attempts.length === 0 && notices.length === 0) return null;

  const visible = attempts.slice(0, MAX_VISIBLE);
  return (
    <div className="flex flex-col gap-2 px-6 pb-3" data-testid="scheduled-send-banner">
      {visible.map((attempt) => {
        const left = remainingMs(attempt, now);
        const due = left <= 0;
        return (
          <div key={attempt.id} role="status" className="alert alert-warning alert-soft flex flex-wrap items-center gap-3 text-sm">
            <span className="min-w-0 flex-1">
              {due ? (
                <>Sending your application to <strong>{attempt.company}</strong> now.</>
              ) : (
                <>
                  Your application to <strong>{attempt.company}</strong> for {attempt.role} will be sent in{' '}
                  <span className="sr-only">{spokenMinutes(left)}.</span>
                  <span aria-hidden="true" className="font-mono">{formatCountdown(left)}</span>.
                </>
              )}
            </span>
            <button type="button" className="btn btn-outline btn-xs" onClick={() => onReview(attempt.id)}>
              Review
            </button>
            {!due && (
              <button
                type="button"
                className="btn btn-warning btn-xs"
                disabled={cancelling.has(attempt.id)}
                onClick={() => void cancel(attempt)}
                aria-label={`Cancel sending ${attempt.role} at ${attempt.company}`}
              >
                Cancel sending
              </button>
            )}
          </div>
        );
      })}
      {attempts.length > MAX_VISIBLE && (
        <p className="text-xs text-base-content/70">
          and {attempts.length - MAX_VISIBLE} more scheduled. Open Review to see them.
        </p>
      )}
      {notices.map((notice) => (
        <div key={notice.id} role="status" className={`alert ${notice.ok ? 'alert-success' : 'alert-error'} alert-soft text-sm`}>
          {notice.text}
        </div>
      ))}
    </div>
  );
}
