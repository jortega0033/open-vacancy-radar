import { useCallback, useState } from 'react';
import type { ProviderId } from '@agent-dock/shared';
import type { SessionCapacity, StartSessionDenialReason } from '../../window.js';
import { PROVIDER_LABEL } from '../../provider-labels.js';
import { refusalCopy } from './refusal-copy.js';
import type { PendingStart } from './workspace-reducer.js';

/**
 * Starting a session, and saying honestly why one was refused (ADI-07).
 *
 * ## The flow this drives is ADI-06's, unchanged
 *
 * `requestGrant` opens a native folder picker and a native confirmation dialog in the **main**
 * process; `consumeGrant` spends the resulting one-shot handle and returns an opaque
 * `workspaceSessionRef`; `startSession` hands that ref to the daemon, which resolves it back to a
 * canonical path main never told the renderer. The panel below names a provider and types a
 * prompt. It never names, learns, displays, or stores a folder: the only thing it ever sees is the
 * approved folder's *display name*, echoed back so the user can confirm which approval a pending
 * start belongs to.
 *
 * ## Concurrency: pending starts are keyed, not queued
 *
 * Submitting does not disable the form. Each submission mints its own client key, and the panel
 * renders one card per in-flight start. Two of them can be waiting on two native dialogs at once,
 * and one can be refused while the other succeeds, in either order. A single "pending start" slot
 * would be the same single-slot mistake as an `activeSessionId`, one layer up.
 *
 * ## The two 409s are drawn as different situations, deliberately
 *
 * `active_session_limit` and `workspace_lease_conflict` are the same HTTP status from the same
 * route and they are not the same problem:
 *
 * - **Too many sessions are running anywhere.** Waiting or stopping one fixes it. Choosing a
 *   different folder does not, so this card offers no folder action, and it shows the live capacity
 *   numbers, which are the thing that has to change.
 * - **Another session already holds that folder.** A session takes an exclusive write lease on its
 *   workspace for as long as it runs, so two concurrent sessions genuinely require two different
 *   granted folders. Choosing another folder fixes it, so this card offers exactly that, and it
 *   does not show capacity numbers, which are not the constraint being hit.
 *
 * Showing one message for both would tell at least half the users to do something that cannot work.
 *
 * No em dashes: this whole file is user-facing copy.
 */

/** Refusals whose remedy is to pick a different folder and try the same prompt again. */
const RETRYABLE_WITH_NEW_FOLDER: ReadonlySet<StartSessionDenialReason> = new Set([
  'timeout',
  'navigation',
  'webcontents_destroyed',
  'daemon_generation',
  'trust_revoked',
  'wrong_webcontents',
  'unknown_handle',
  'already_consumed',
  'identity_drift',
  'not_trusted',
  'unknown_workspace_ref',
  'workspace_lease_conflict',
  'invalid_workspace_path',
  'unc_workspace_unsupported',
]);

export interface NewSessionPanelProps {
  pendingStarts: Readonly<Record<string, PendingStart>>;
  capacity: SessionCapacity | undefined;
  /** The provider the app is configured to use, offered as the default choice. */
  defaultProvider: ProviderId;
  newClientKey(): string;
  onStart(clientKey: string, provider: ProviderId, prompt: string): void;
  onDismiss(clientKey: string): void;
  onOpenSession(sessionId: string): void;
}

export function NewSessionPanel({
  pendingStarts,
  capacity,
  defaultProvider,
  newClientKey,
  onStart,
  onDismiss,
  onOpenSession,
}: NewSessionPanelProps) {
  const [provider, setProvider] = useState<ProviderId>(defaultProvider);
  const [prompt, setPrompt] = useState('');
  /**
   * What each pending start was asked to do, so "try another folder" can resubmit the same prompt.
   *
   * Kept here rather than in the reducer because it is composer state, not session state: the
   * reducer's `pendingStarts` deliberately holds no prompt, so no prompt text ever reaches the
   * settings write-back or any other consumer of workspace state.
   */
  const [drafts, setDrafts] = useState<Readonly<Record<string, { provider: ProviderId; prompt: string }>>>({});

  const submit = useCallback(
    (value: { provider: ProviderId; prompt: string }) => {
      const clientKey = newClientKey();
      setDrafts((current) => ({ ...current, [clientKey]: value }));
      onStart(clientKey, value.provider, value.prompt);
    },
    [newClientKey, onStart],
  );

  const dismiss = useCallback(
    (clientKey: string) => {
      setDrafts((current) => {
        const next = { ...current };
        delete next[clientKey];
        return next;
      });
      onDismiss(clientKey);
    },
    [onDismiss],
  );

  const trimmed = prompt.trim();
  const pending = Object.values(pendingStarts);

  return (
    <section aria-label="Start a session">
      <h3 className="text-base font-semibold">Start an agent session</h3>
      <p className="mt-1 text-sm text-base-content/70">
        The app will ask you to choose a folder and confirm it before anything runs. The agent works
        only in the folder you approve.
      </p>

      <form
        className="mt-3 flex flex-col gap-3"
        onSubmit={(event) => {
          event.preventDefault();
          if (trimmed.length === 0) return;
          submit({ provider, prompt: trimmed });
          setPrompt('');
        }}
      >
        <label className="flex flex-col gap-1">
          <span className="text-xs font-medium text-base-content/70">Runtime</span>
          <select
            className="select select-sm select-bordered w-56"
            aria-label="Runtime"
            value={provider}
            onChange={(event) => setProvider(event.target.value as ProviderId)}
          >
            {(Object.keys(PROVIDER_LABEL) as ProviderId[]).map((id) => (
              <option key={id} value={id}>
                {PROVIDER_LABEL[id]}
              </option>
            ))}
          </select>
        </label>

        <label className="flex flex-col gap-1">
          <span className="text-xs font-medium text-base-content/70">What should the agent do?</span>
          <textarea
            className="textarea textarea-bordered min-h-24 w-full text-sm"
            aria-label="What should the agent do?"
            value={prompt}
            onChange={(event) => setPrompt(event.target.value)}
            placeholder="Describe the task in your own words."
          />
        </label>

        <div className="flex items-center gap-3">
          <button type="submit" className="btn btn-sm btn-primary" disabled={trimmed.length === 0}>
            Choose folder and start
          </button>
          <span className="text-xs text-base-content/50">
            You can start another session while one is already running.
          </span>
        </div>
      </form>

      {pending.length > 0 && (
        <ul className="mt-4 flex flex-col gap-2" aria-label="Pending starts">
          {pending.map((item) => (
            <li key={item.clientKey}>
              <PendingStartCard
                pending={item}
                capacity={capacity}
                onDismiss={() => dismiss(item.clientKey)}
                onOpenSession={onOpenSession}
                onRetry={() => {
                  const draft = drafts[item.clientKey];
                  dismiss(item.clientKey);
                  if (draft !== undefined) submit(draft);
                }}
                canRetry={drafts[item.clientKey] !== undefined}
              />
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

interface PendingStartCardProps {
  pending: PendingStart;
  capacity: SessionCapacity | undefined;
  onDismiss(): void;
  onRetry(): void;
  onOpenSession(sessionId: string): void;
  canRetry: boolean;
}

function PendingStartCard({
  pending,
  capacity,
  onDismiss,
  onRetry,
  onOpenSession,
  canRetry,
}: PendingStartCardProps) {
  if (pending.phase === 'granting') {
    return (
      <div className="rounded-box border border-base-300 p-3 text-sm" data-testid="pending-granting">
        Waiting for you to choose and confirm a folder.
        <button type="button" className="btn btn-ghost btn-xs ml-2" onClick={onDismiss}>
          Cancel
        </button>
      </div>
    );
  }

  if (pending.phase === 'starting') {
    return (
      <div className="rounded-box border border-base-300 p-3 text-sm" data-testid="pending-starting">
        Starting in {pending.workspaceName ?? 'the approved folder'}…
      </div>
    );
  }

  if (pending.phase === 'started') {
    return (
      <div className="rounded-box border border-base-300 p-3 text-sm" data-testid="pending-started">
        Session started in {pending.workspaceName ?? 'the approved folder'}.
        {pending.sessionId !== undefined && (
          <button
            type="button"
            className="btn btn-ghost btn-xs ml-2"
            onClick={() => {
              const id = pending.sessionId;
              if (id !== undefined) onOpenSession(id);
              onDismiss();
            }}
          >
            Open
          </button>
        )}
        <button type="button" className="btn btn-ghost btn-xs ml-1" onClick={onDismiss}>
          Dismiss
        </button>
      </div>
    );
  }

  const reason: StartSessionDenialReason = pending.reason ?? 'refused';
  const copy = refusalCopy(reason);
  const offerFolderRetry = canRetry && RETRYABLE_WITH_NEW_FOLDER.has(reason);

  return (
    <div
      className="rounded-box border border-error/40 bg-error/5 p-3"
      data-testid="pending-refused"
      data-reason={reason}
    >
      <div className="text-sm font-semibold">{copy.title}</div>
      <p className="mt-1 text-sm">{copy.detail}</p>

      {/* The two 409s diverge here, not only in their sentence. */}
      {reason === 'active_session_limit' && capacity !== undefined && (
        <p className="mt-1.5 text-xs text-base-content/60" data-testid="refusal-capacity">
          {capacity.global.active} of {capacity.global.limit} concurrent sessions are in use.
        </p>
      )}

      <div className="mt-2 flex flex-wrap gap-2">
        {offerFolderRetry && (
          <button type="button" className="btn btn-sm" onClick={onRetry} data-testid="refusal-retry-folder">
            {reason === 'workspace_lease_conflict' ? 'Choose a different folder' : 'Choose a folder again'}
          </button>
        )}
        <button type="button" className="btn btn-ghost btn-sm" onClick={onDismiss}>
          Dismiss
        </button>
      </div>
    </div>
  );
}
