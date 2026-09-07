import type { AuthStatus, ProviderId } from '@agent-dock/shared';

/**
 * The two production transports this repo actually ships (ADI-19). Upstream's own live-smoke
 * harness also covers `claude-agent-sdk`/`codex-app-server`, but neither transport exists in this
 * repo yet -- both are still deferred (see ADI-08c and ADI-08's own Codex app-server scope). This
 * union is deliberately narrower than upstream's, not a placeholder for the missing two: adding
 * them back is a real follow-on once those transports themselves land, not something to stub now.
 */
export type LiveSmokeTransportId = 'claude-legacy-one-shot' | 'codex-legacy-one-shot';

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
