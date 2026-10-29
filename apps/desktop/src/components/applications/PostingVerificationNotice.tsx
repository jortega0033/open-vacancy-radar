import { useCallback, useEffect, useRef, useState } from 'react';
import type { PostingVerificationAction, PostingVerificationView } from '../../window.js';
import {
  describePostingVerification,
  POSTING_ACTION_LABEL,
  POSTING_ACTION_PENDING_LABEL,
} from './posting-verification-text.js';

/**
 * What an action did, for the surrounding screen: `checked` (a new check result), `refreshed`
 * (preparation queued from the updated posting), `resumed` (preparation queued), `restored` (a held
 * package was put back exactly as it was) or `recorded` (only the decision was saved).
 */
export type PostingNoticeDoneKind = 'checked' | 'refreshed' | 'resumed' | 'restored' | 'recorded';

export interface PostingVerificationNoticeProps {
  /** The application whose posting this describes. Main re-derives everything else from it. */
  attemptId: string;
  /** Where the person can look at the posting themselves (the manual check). */
  postingUrl: string;
  /** Changes whenever the application changes, so the stored check is read again. */
  reloadKey?: string;
  /** Called after an action that changed the application, so the page can refresh. */
  onDone?: (kind: PostingNoticeDoneKind, view?: PostingVerificationView) => void;
  /** Disables the actions while the surrounding dialog is busy. */
  disabled?: boolean;
}

/**
 * The live posting check for one application (#687), shown inside the screens the person already
 * uses (the application drawer and the review dialog). Not a screen of its own, and not a gate: a
 * posting that is open and unchanged is one quiet line, and a check that could not run says so
 * without calling the posting closed.
 *
 * Reads the stored check without any request. Anything that contacts the posting is an explicit
 * button ("Check again"); the check that runs when an application is prepared or resumed happens in
 * the main process, not here.
 */
export function PostingVerificationNotice({ attemptId, postingUrl, reloadKey, onDone, disabled = false }: PostingVerificationNoticeProps) {
  const [view, setView] = useState<PostingVerificationView | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [busy, setBusy] = useState<PostingVerificationAction | null>(null);
  const [error, setError] = useState<string>();
  // An action can outlive the dialog it was started in; nothing is set on an unmounted notice.
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const reload = useCallback(async (isCurrent: () => boolean) => {
    // A bridge from an older build has no such method: show nothing rather than fail.
    if (typeof window.applicationPipeline?.postingVerification !== 'function') return;
    try {
      const next = await window.applicationPipeline.postingVerification(attemptId);
      if (isCurrent()) {
        setView(next);
        setLoadFailed(false);
      }
    } catch {
      if (isCurrent()) {
        setView(null);
        setLoadFailed(true);
      }
    }
  }, [attemptId]);

  useEffect(() => {
    let cancelled = false;
    setError(undefined);
    void reload(() => !cancelled && mounted.current);
    return () => {
      cancelled = true;
    };
  }, [reload, reloadKey]);

  const run = useCallback(
    async (action: PostingVerificationAction) => {
      setBusy(action);
      setError(undefined);
      try {
        if (action === 'check_again') {
          const next = await window.applicationPipeline.verifyPosting(attemptId, { force: true });
          if (!mounted.current) return;
          setView(next);
          onDone?.('checked', next);
        } else if (action === 'refresh') {
          const result = await window.applicationPipeline.refreshFromPosting(attemptId);
          if (!result.ok) throw new Error(result.detail ?? 'We could not refresh this application.');
          if (!mounted.current) return;
          onDone?.('refreshed');
        } else if (action === 'prepare_now') {
          // The finding that stopped preparation was settled by a later check, so there is no decision
          // to record: this is the ordinary resume, which queues preparation once.
          const result = await window.applicationPipeline.resume(attemptId);
          if (!result.ok) throw new Error(result.detail ?? 'We could not prepare this application.');
          if (!mounted.current) return;
          onDone?.('resumed');
        } else if (action === 'keep_current' || action === 'prepare_anyway') {
          const result = await window.applicationPipeline.resume(attemptId, { resolution: action });
          if (!result.ok) throw new Error(result.detail ?? 'We could not continue with this application.');
          if (!mounted.current) return;
          if (result.continued === 'restored' || result.continued === 'recorded') {
            // Nothing was queued: show the decision here and let the screen re-read the application.
            await reload(() => mounted.current);
            onDone?.(result.continued);
          } else {
            onDone?.('resumed');
          }
        }
      } catch (err) {
        if (mounted.current) setError(err instanceof Error ? err.message : 'That did not work. Try again.');
      } finally {
        if (mounted.current) setBusy(null);
      }
    },
    [attemptId, onDone, reload],
  );

  if (view === null) {
    if (!loadFailed) return null;
    return (
      <section aria-label="Posting check" data-testid="posting-verification" data-status="load_failed" className="rounded-box border border-base-300 p-3 text-sm">
        <p role="status" className="text-xs text-base-content/70">
          We could not load the posting check. This does not mean the posting is closed.
        </p>
      </section>
    );
  }
  const text = describePostingVerification(view);
  const warning = text.tone === 'warning';
  const buttonActions = view.actions.filter((action) => action !== 'open_posting');
  const canOpen = view.actions.includes('open_posting') && postingUrl.length > 0;
  if (view.status === 'not_applicable' && view.actions.length === 0 && text.lines.length === 0) return null;

  return (
    <section
      aria-label="Posting check"
      data-testid="posting-verification"
      data-status={view.status}
      className={
        warning
          ? 'rounded-box border border-warning/50 bg-warning/10 p-3 text-sm'
          : 'rounded-box border border-base-300 p-3 text-sm'
      }
    >
      <div role={warning ? 'alert' : 'status'}>
        <p className={warning ? 'font-semibold' : text.tone === 'quiet' ? 'text-base-content/80' : 'font-medium'}>{text.headline}</p>
        {text.lines.map((line) => (
          <p key={line} className="mt-0.5 text-xs text-base-content/70">
            {line}
          </p>
        ))}
      </div>

      {view.change && (view.change.added.length > 0 || view.change.removed.length > 0) && (
        <details className="mt-2" open>
          <summary className="cursor-pointer text-xs font-medium">What changed</summary>
          {view.change.removed.length > 0 && (
            <div className="mt-1">
              <p className="text-xs text-base-content/60">No longer in the posting</p>
              <ul className="list-disc pl-5 text-xs">
                {view.change.removed.map((line) => (
                  <li key={`r-${line}`} className="break-words">{line}</li>
                ))}
              </ul>
            </div>
          )}
          {view.change.added.length > 0 && (
            <div className="mt-1">
              <p className="text-xs text-base-content/60">New in the posting</p>
              <ul className="list-disc pl-5 text-xs">
                {view.change.added.map((line) => (
                  <li key={`a-${line}`} className="break-words">{line}</li>
                ))}
              </ul>
            </div>
          )}
        </details>
      )}

      {error && (
        <p className="mt-2 text-xs text-error" role="alert">
          {error}
        </p>
      )}

      {(buttonActions.length > 0 || canOpen) && (
        <div className="mt-2 flex flex-wrap gap-2">
          {buttonActions.map((action) => (
            <button
              key={action}
              type="button"
              className={
                action === 'refresh' || action === 'prepare_anyway' || action === 'prepare_now'
                  ? 'btn btn-primary btn-sm'
                  : action === 'check_again' && !warning
                    ? 'btn btn-ghost btn-xs'
                    : 'btn btn-outline btn-sm'
              }
              disabled={disabled || busy !== null}
              onClick={() => void run(action)}
            >
              {busy === action
                ? POSTING_ACTION_PENDING_LABEL[action as keyof typeof POSTING_ACTION_PENDING_LABEL]
                : POSTING_ACTION_LABEL[action as keyof typeof POSTING_ACTION_LABEL]}
            </button>
          ))}
          {canOpen && (
            <a className="btn btn-outline btn-sm" href={postingUrl} target="_blank" rel="noreferrer">
              {POSTING_ACTION_LABEL.open_posting}
            </a>
          )}
        </div>
      )}
    </section>
  );
}
