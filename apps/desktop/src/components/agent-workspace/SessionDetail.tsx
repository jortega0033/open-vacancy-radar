import { ActivityTimeline } from './ActivityTimeline.js';
import { ATTACH_REFUSAL_COPY } from './refusal-copy.js';
import { STATUS_BADGE_CLASS, formatInstant, provenanceLine, statusCopy, terminalReasonCopy } from './status.js';
import type { SessionEntry } from './workspace-reducer.js';
import { isRunning } from './workspace-reducer.js';

/**
 * The detail pane for one selected session (ADI-07).
 *
 * Selection is the *only* thing this component depends on, and it is a render pointer: unmounting
 * it does not stop a session, does not detach its live relay, and does not discard its timeline.
 * Everything it shows was accumulated by the hook whether or not this session was ever on screen.
 *
 * ## Stopping goes through v1
 *
 * The Stop button calls `agentDock.cancelSession`, v1's existing channel. ADI-07 adds no v2 cancel
 * route and no new cancel bridge: a v2 session lives in the same `SessionManager` as a v1 one, so
 * the existing verb already reaches it, and a second one would be a second thing to keep in
 * agreement with it for no capability gained.
 *
 * ## The three "no live stream" states are not errors
 *
 * A finished session, a session whose stream closed, and a session recovered across an app restart
 * all end up with `liveStatus: 'ended'`, and none of them is a failure. The pane says which of them
 * it is, in words from a closed table, and never borrows an error's vocabulary for any of them.
 *
 * No em dashes: this is user-facing copy.
 */

export interface SessionDetailProps {
  entry: SessionEntry;
  onCancel(sessionId: string): void;
  /** True while a stop request for this session is in flight. */
  cancelling: boolean;
}

export function SessionDetail({ entry, onCancel, cancelling }: SessionDetailProps) {
  const { view } = entry;
  const status = statusCopy(view.status);
  const reason = terminalReasonCopy(view.terminalReason);
  const running = isRunning(view);

  return (
    <section className="min-w-0" aria-label="Session detail">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <h3 className="text-base font-semibold">{provenanceLine(view)}</h3>
            <span className={`badge badge-sm ${STATUS_BADGE_CLASS[status.tone]}`}>{status.label}</span>
          </div>
          <p className="mt-1 text-xs text-base-content/60">Started {formatInstant(view.startedAt)}</p>
          {view.completedAt !== undefined && (
            <p className="text-xs text-base-content/60">Finished {formatInstant(view.completedAt)}</p>
          )}
        </div>
        {running && (
          <button
            type="button"
            className="btn btn-sm"
            disabled={cancelling}
            onClick={() => onCancel(view.id)}
          >
            {cancelling ? 'Stopping…' : 'Stop session'}
          </button>
        )}
      </div>

      {reason !== undefined && <p className="mt-2 text-sm text-base-content/70">{reason}</p>}

      {/* Reason-only, from a closed table. A refused attach is not a session failure, so it is not
          drawn as an alert. */}
      {entry.lastRefusal !== undefined && (
        <p className="mt-2 text-sm text-base-content/60" data-testid="attach-refusal">
          {ATTACH_REFUSAL_COPY[entry.lastRefusal]}
        </p>
      )}

      <dl className="mt-3 grid grid-cols-[130px_1fr] gap-x-2.5 gap-y-1.5 rounded-box border border-base-300 p-3 text-xs">
        <dt className="text-base-content/60">Runtime</dt>
        <dd className="font-medium">{view.provider}</dd>
        <dt className="text-base-content/60">Model</dt>
        <dd className="font-medium">{view.model ?? 'CLI default'}</dd>
        <dt className="text-base-content/60">Authentication</dt>
        <dd className="font-medium">{view.scope.authenticated}</dd>
        <dt className="text-base-content/60">Platform</dt>
        <dd className="font-medium">{view.scope.platform}</dd>
        <dt className="text-base-content/60">Recorded events</dt>
        <dd className="font-medium">
          {view.eventCount.toLocaleString()}
          {view.eventsTruncated && ' (older events were dropped by the runtime)'}
        </dd>
        {view.unknownFrameCount > 0 && (
          <>
            <dt className="text-base-content/60">Unrecognized output</dt>
            <dd className="font-medium">
              {view.unknownFrameCount.toLocaleString()} lines this app could not interpret
            </dd>
          </>
        )}
      </dl>

      {/* The one place the boundary is stated to the user rather than merely enforced. */}
      <p className="mt-2 text-xs text-base-content/50">
        The folder this session runs in is held by the app itself and is not shown here.
      </p>

      <h4 className="mt-5 mb-2 text-[11px] font-semibold tracking-wide text-base-content/60 uppercase">
        Activity
      </h4>
      <ActivityTimeline entry={entry} />
    </section>
  );
}
