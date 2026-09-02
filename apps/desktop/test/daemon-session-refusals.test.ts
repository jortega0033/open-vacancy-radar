import { describe, expect, it } from 'vitest';
import {
  DAEMON_SESSION_REFUSALS,
  daemonSessionRefusalReason,
} from '../electron/daemon-session-refusals.js';

/**
 * The mapping from `POST /v2/sessions`'s machine-readable codes onto this process's reason
 * vocabulary (ADI-13).
 *
 * The fallback is deliberately vague, which is exactly why it needs pinning: a code that *should*
 * have a specific answer and silently doesn't looks identical, from the renderer, to a code from a
 * newer daemon this build has never heard of. So every code the daemon's own refusal table can
 * produce is asserted here by name.
 */
describe('daemonSessionRefusalReason', () => {
  it('falls back to a vague refusal for a code this build does not know', () => {
    expect(daemonSessionRefusalReason('something_a_newer_daemon_invented')).toBe('refused');
    expect(daemonSessionRefusalReason('')).toBe('refused');
  });

  it('maps the identity-resolution refusals to their own reasons, not the fallback', () => {
    // Both are surfaced by the daemon's `resolveIdentity(cwd)` at session-create time, well after
    // the folder was approved: a workspace session ref is usable for several sessions, so the
    // folder can be deleted or its drive unplugged inside that window. Before this mapping existed
    // they fell through to `refused`, which told the user nothing they could act on.
    expect(daemonSessionRefusalReason('unc_workspace_unsupported')).toBe('unc_workspace_unsupported');
    expect(daemonSessionRefusalReason('invalid_workspace_path')).toBe('invalid_workspace_path');

    for (const code of ['unc_workspace_unsupported', 'invalid_workspace_path']) {
      expect(daemonSessionRefusalReason(code), `${code} degraded to the generic fallback`).not.toBe('refused');
    }
  });

  it('maps every other code the create route can answer with', () => {
    // Transcribed from `REFUSALS` (plus the lease conflict and the two step-1/step-2 codes) in
    // apps/daemon/src/routes/v2-sessions-create.ts, and from `writeAudit`'s audit-failure codes. A
    // code added there without an entry here is the failure this catches.
    const expected: Record<string, string> = {
      workspace_revoked: 'trust_revoked',
      workspace_grant_stale: 'trust_revoked',
      workspace_identity_drift: 'identity_drift',
      workspace_not_reusable: 'not_trusted',
      workspace_not_trusted: 'not_trusted',
      workspace_lease_conflict: 'workspace_lease_conflict',
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
    };

    for (const [code, reason] of Object.entries(expected)) {
      expect(daemonSessionRefusalReason(code), code).toBe(reason);
    }
  });

  it('is frozen, so no later import can widen what the renderer may be told', () => {
    expect(Object.isFrozen(DAEMON_SESSION_REFUSALS)).toBe(true);
  });
});
