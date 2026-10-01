import {
  START_SESSION_DENIAL_REASONS,
  type AttachRefusal,
  type StartSessionDenialReason,
} from '../../../electron/agent-workspace-types.js';

/**
 * Every reason a session can be refused, and the one sentence this build is willing to show for it
 * (ADI-07).
 *
 * ## Why a closed table rather than a message from anywhere else
 *
 * This mirrors `electron/daemon-session-refusals.ts` exactly, one layer further out. The daemon
 * answers refusals with a machine-readable `code`; main maps that code onto a reason token from a
 * closed table and never forwards the daemon's own `error` text (an audit-store failure's message
 * quotes the filesystem error that names its log file). This table is the last step of that chain:
 * a reason token in, a sentence this repo wrote out. A refusal message the user reads has therefore
 * never been anywhere near a path, a port, or a stack trace.
 *
 * ## Exhaustive, and checked two ways
 *
 * `satisfies Record<StartSessionDenialReason, RefusalCopy>` makes a missing reason a **compile
 * error**, and `refusal-copy.test.ts` walks `START_SESSION_DENIAL_REASONS` at runtime so a reason
 * added to the type union but not to that array is caught too. Same two-sided discipline ADI-05
 * applies to its redactor's event-type inventory.
 *
 * ## The two 409s read as different situations, on purpose
 *
 * `active_session_limit` and `workspace_lease_conflict` are both a 409 from the same route, and a
 * UI that showed one message for both would be actively misleading. They are different problems
 * with different fixes:
 *
 * - **`active_session_limit`**: too many sessions are running *anywhere*. Waiting or stopping one
 *   fixes it; changing folder does not.
 * - **`workspace_lease_conflict`**: another session already holds this *folder*. Over this repo's
 *   one transport, `workspaceLeaseModeFor` returns `'write'` unconditionally, so every session is
 *   an exclusive writer and two concurrent sessions genuinely require two different granted
 *   folders. Picking a different folder fixes it; stopping an unrelated session does not.
 *
 * No em dashes anywhere in this file: it is all user-facing UI copy (see this project's copy
 * convention, and the repo-wide sweep in PR #54 that established it).
 */

export interface RefusalCopy {
  /** A short label for a list row or a badge. Sentence case, no trailing period. */
  title: string;
  /** What happened and what the user can do about it. One or two plain sentences. */
  detail: string;
}

const COPY = {
  timeout: {
    title: 'The approval expired',
    detail:
      'The folder approval was only valid for a few minutes and that window has passed. Choose the folder again to continue.',
  },
  navigation: {
    title: 'The approval was reset',
    detail:
      'The page reloaded after you approved the folder, so the approval no longer applies. Choose the folder again.',
  },
  webcontents_destroyed: {
    title: 'The approval was reset',
    detail: 'The window that showed you the approval dialog is gone. Choose the folder again to continue.',
  },
  daemon_generation: {
    title: 'The AI runtime restarted',
    detail:
      'The local runtime restarted after you approved the folder, and its replacement never saw that approval. Choose the folder again.',
  },
  trust_revoked: {
    title: 'Access to this folder was withdrawn',
    detail: 'This folder is no longer trusted for agent sessions. Approve it again if you still want to use it.',
  },
  wrong_webcontents: {
    title: 'That approval belongs to another window',
    detail: 'This window cannot use an approval that was granted somewhere else. Choose the folder again here.',
  },
  unknown_handle: {
    title: 'That approval is no longer valid',
    detail: 'The approval could not be found. Choose the folder again to continue.',
  },
  already_consumed: {
    title: 'That approval was already used',
    detail: 'Each folder approval can only be spent once. Choose the folder again to start another session.',
  },
  identity_drift: {
    title: 'The folder changed after you approved it',
    detail:
      'The folder you approved is not the same folder any more: it may have been moved, renamed, or replaced. Choose it again so you can confirm what the agent will run in.',
  },
  not_trusted: {
    title: 'The folder was not approved',
    detail: 'The local runtime did not record an approval for this folder, so no session was started.',
  },
  audit_failure: {
    title: 'The security log could not record this',
    detail:
      'This action was refused rather than performed unrecorded. Restart the app, and archive the security log if it is full.',
  },
  unknown_workspace_ref: {
    title: 'The folder is no longer available for new sessions',
    detail: 'Approve the folder again to start another session in it.',
  },
  daemon_unavailable: {
    title: 'The AI runtime is not running',
    detail: 'Sessions cannot start until the local runtime is available. Check the AI Runtime page.',
  },
  workspace_lease_conflict: {
    title: 'Another session is already using this folder',
    detail:
      'A session gets exclusive use of its folder while it runs, so two sessions cannot share one. Pick a different folder, or wait for the running session to finish.',
  },
  unc_workspace_unsupported: {
    title: 'Network locations are not supported',
    detail:
      'A network path cannot be given a stable identity, so the app cannot guarantee the folder you approve is the folder the agent runs in. Choose a folder on a local drive.',
  },
  invalid_workspace_path: {
    title: 'The folder could not be read',
    detail:
      'The folder may have been deleted or renamed, or it may be on a drive that is no longer connected. Choose another folder.',
  },
  unknown_resume_target: {
    title: 'That conversation could not be continued',
    detail: 'The local runtime has no record of the session you asked to continue. Start a new one instead.',
  },
  resume_not_allowed: {
    title: 'That conversation cannot be continued this way',
    detail: 'A continued session keeps the model it started with and cannot change it. Start a new session instead.',
  },
  active_session_limit: {
    title: 'You have reached the concurrent session limit',
    detail:
      'Only a few agent sessions may run at once on this machine. Wait for one to finish, or stop one, then try again.',
  },
  storage_full: {
    title: 'There is no room to record this session',
    detail: 'The local session store is full, so nothing was started. Free up disk space and try again.',
  },
  invalid_request: {
    title: 'That request could not be sent',
    detail: 'The local runtime rejected the request. Check the prompt is not empty, then try again.',
  },
  refused: {
    title: 'The session was refused',
    detail: 'The local runtime refused to start this session. Check the AI Runtime page, then try again.',
  },
} as const satisfies Record<StartSessionDenialReason, RefusalCopy>;

export const REFUSAL_COPY: Readonly<Record<StartSessionDenialReason, RefusalCopy>> = Object.freeze(COPY);

/** The reader, with the same fail-closed fallback `daemonSessionRefusalReason` uses. */
export function refusalCopy(reason: string): RefusalCopy {
  return REFUSAL_COPY[reason as StartSessionDenialReason] ?? REFUSAL_COPY.refused;
}

/** Re-exported so a test can walk the real inventory rather than a list it wrote for itself. */
export { START_SESSION_DENIAL_REASONS };

/**
 * Why a session is not being streamed live.
 *
 * Separate from the refusal table because none of these is a failure. A session that is finished,
 * or one that ran before the app last restarted, simply has no live stream to attach to, and the UI
 * says that plainly instead of borrowing an error's vocabulary for it.
 */
const ATTACH_COPY = {
  attach_limit: 'Live updates are paused for this session because several others are already streaming.',
  daemon_unavailable: 'Live updates are unavailable because the local runtime is not running.',
  invalid_session_id: 'Live updates are unavailable for this session.',
} as const satisfies Record<AttachRefusal, string>;

export const ATTACH_REFUSAL_COPY: Readonly<Record<AttachRefusal, string>> = Object.freeze(ATTACH_COPY);

/**
 * What a finished session with no readable activity says for itself.
 *
 * This is the honest answer to a real and common state, not an error message. The v2 read routes
 * are content-free by design (ADI-05: no event content ever reaches disk), so once the live stream
 * that carried the prose is gone, the outcome is genuinely all that survives.
 */
export const HISTORY_ONLY_EXPLANATION =
  'This session ran before the app last restarted, so the details of what it did are not available any more. Its outcome is recorded below.';
