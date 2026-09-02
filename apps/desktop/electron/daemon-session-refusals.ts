import type { StartSessionDenialReason } from './workspace-grant.js';

/**
 * How `POST /v2/sessions`'s machine-readable codes map onto this process's own reason vocabulary
 * (ADI-13).
 *
 * A closed table, and anything absent from it becomes `refused` -- the fail-closed direction, and
 * the same shape `consumeGrant`'s mapping uses. A code a newer daemon adds therefore degrades to a
 * vague refusal, never to an unreviewed string reaching the renderer.
 *
 * Its own module rather than a `const` inside main.ts, for the reason `external-url.ts` and
 * `send-to-renderer.ts` are their own modules: main.ts imports Electron and starts a daemon on
 * load, so nothing declared in it can be asserted against directly. A table whose whole purpose is
 * that every daemon code has a reviewed answer is worth being able to test exhaustively.
 */
export const DAEMON_SESSION_REFUSALS: Readonly<Record<string, StartSessionDenialReason>> = Object.freeze({
  workspace_revoked: 'trust_revoked',
  workspace_grant_stale: 'trust_revoked',
  workspace_identity_drift: 'identity_drift',
  workspace_not_reusable: 'not_trusted',
  workspace_not_trusted: 'not_trusted',
  workspace_lease_conflict: 'workspace_lease_conflict',
  // Both of these come out of the daemon's `resolveIdentity(cwd)`, which `POST /v2/sessions` runs
  // at step 4 -- i.e. long after the folder was approved. A workspace session ref is usable for
  // several sessions over its lifetime, so the folder can be deleted, renamed, or sitting on a
  // drive that was unplugged between the approval and this request, and a share can be remapped to
  // a UNC path this build refuses to host a session in. Mapped to their own reasons rather than
  // falling through to `refused`, because "the folder you picked is not there any more" is a thing
  // the user can act on and "something was refused" is not.
  unc_workspace_unsupported: 'unc_workspace_unsupported',
  invalid_workspace_path: 'invalid_workspace_path',
  unknown_resume_target: 'unknown_resume_target',
  resume_cannot_override_model: 'resume_not_allowed',
  resume_not_supported: 'resume_not_allowed',
  invalid_request: 'invalid_request',
  invalid_capability_request: 'invalid_request',
  unsupported_provider: 'invalid_request',
  active_session_limit: 'active_session_limit',
  storage_full: 'storage_full',
  audit_log_full: 'audit_failure',
  audit_unavailable: 'audit_failure',
  audit_write_failed: 'audit_failure',
});

/** The table's one reader, with its fail-closed fallback. */
export function daemonSessionRefusalReason(code: string): StartSessionDenialReason {
  return DAEMON_SESSION_REFUSALS[code] ?? 'refused';
}
