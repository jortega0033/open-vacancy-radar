import type { AuthStatus, ProviderId } from '@agent-dock/shared';

/**
 * The production transports this repo actually ships. Upstream's own live-smoke harness also
 * covers `claude-agent-sdk`, which still doesn't exist in this repo (deferred, see ADI-08c) -- this
 * union stays narrower than upstream's for that one, not a placeholder for it.
 *
 * `'codex-app-server'` was added in ADI-08 stage 8, once the transport itself (stage 5), its
 * compatibility-manifest entry (stage 6), and its daemon wiring with a safe exec fallback
 * (stage 7) all shipped. It is a genuinely separate case from `'codex-legacy-one-shot'`, not a
 * variant of it: `cli.ts`'s `CASES` runs it with `AGENT_DOCK_CODEX_TRANSPORT=app-server` set for
 * the duration of that one case, so a real session actually attempts the app-server transport
 * rather than the operator-facing default (`'exec'`) every other case in this file exercises.
 */
export type LiveSmokeTransportId = 'claude-legacy-one-shot' | 'codex-legacy-one-shot' | 'codex-app-server';

/**
 * Every way a smoke case can end. Only `success` means a real session actually completed.
 * Every `skipped_*` code means no conclusion was reached (missing opt-in, missing binary/auth, a
 * stale provider version) -- callers must never treat a skip as a pass. `failed_*` codes are a
 * real defect: the harness's own logic broke a contract (duplicate terminal event, malformed
 * stream, a hang past the timeout, or an unexpected error).
 */
export type LiveSmokeResultCode =
  | 'success'
  | 'skipped_not_enabled'
  | 'skipped_missing_binary'
  | 'skipped_missing_auth'
  | 'skipped_version_stale'
  | 'skipped_auth_source_incompatible'
  | 'failed_timeout'
  | 'failed_protocol_violation'
  | 'failed_error';

export function isSkippedResult(code: LiveSmokeResultCode): boolean {
  return code.startsWith('skipped_');
}

export function isFailedResult(code: LiveSmokeResultCode): boolean {
  return code.startsWith('failed_');
}

/**
 * One redacted, release-evidence row for a single smoke case. Every field here is safe to
 * publish: no credential, account identifier, raw prompt/output text, or private filesystem path.
 * See `buildEvidenceRecord` for the redaction this type's shape is meant to make easy to audit at
 * a glance -- there is deliberately no field here that could hold a secret.
 *
 * No `capabilitiesTested` field, unlike upstream's record: this repo's v1 protocol has no
 * capability negotiation to report (see `providers.md`'s v1 adapter shape) -- what ran is fully
 * described by `provider`/`transport`/`resultCode` alone.
 */
export interface LiveSmokeEvidenceRecord {
  schemaVersion: 1;
  commit: string;
  os: NodeJS.Platform;
  provider: ProviderId;
  transport: LiveSmokeTransportId;
  providerVersion: string | undefined;
  /** `ProviderStatus.authenticated` verbatim -- this repo has no auth-source category breakdown
   * (no API-key-vs-ChatGPT-vs-keychain distinction), just this coarser enum, which is itself
   * already safe to publish (see `AuthStatus`'s own doc comment). */
  authStatus: AuthStatus;
  resultCode: LiveSmokeResultCode;
  durationMs: number;
  timestamp: string;
}
