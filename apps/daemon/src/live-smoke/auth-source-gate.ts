import type { AuthSource } from '@agent-dock/shared';

export type AuthSourceGateResult = { supported: true } | { supported: false; reason: string };

/**
 * The app-server transport cannot bind a resume/continuation identity to an API-key session
 * (`agent-runtime`'s `scope-evidence.ts`) -- `transport-selection.ts` already knows this and
 * silently, transparently falls back to the exec transport for exactly this account state. This
 * gate exists so a live-smoke run over an API-key account reports that explicitly, rather than
 * reporting `success` for the `codex-app-server` case having actually run over the exec fallback
 * the whole time, unremarked. The same "an untested/unreachable combination must never silently
 * read as success" principle `checkVersionSupported` (`version-gate.ts`) already enforces, for a
 * different cause (an untested CLI version rather than an incompatible auth source).
 */
export function checkAuthSourceSupportsAppServer(authSource: AuthSource | undefined): AuthSourceGateResult {
  if (authSource === 'api_key') {
    return { supported: false, reason: 'api_key auth cannot bind an app-server continuation identity' };
  }
  return { supported: true };
}
