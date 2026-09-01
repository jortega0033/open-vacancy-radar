import type { ProviderId, ProviderStatus } from '@agent-dock/shared';
import type { StartSessionOptions } from '../../types.js';

/**
 * An immutable snapshot of everything that identifies *what was launched* for one session.
 *
 * Its only job is to answer one question later: "is this candidate launch the same launch, in the
 * same context, as the one we already started?" The fallback gate refuses to reuse a session's
 * accepted-work state across anything but an exactly-equal scope, so a drifted executable, a
 * changed model, or a re-authenticated CLI can never inherit a prior session's safety conclusions.
 */
export interface FrozenLaunchScope {
  readonly provider: ProviderId;
  readonly cwd: string;
  readonly executablePath: string | undefined;
  readonly providerVersion: string | undefined;
  readonly authenticated: string;
  readonly model: string | undefined;
  readonly platform: NodeJS.Platform;
  readonly transportId: string;
  /**
   * A deliberate, documented limitation marker rather than a real fingerprint.
   *
   * `'cli_owned'` records that the strongest identity claim this repo can make is "the same CLI
   * binary, at the same version, reporting the same auth state" — because that is genuinely all
   * the information available. `ProviderStatus` (packages/shared/src/provider.ts) carries no
   * account identifier, no auth-source discriminator, and no credential fingerprint, and this
   * repo's adapters never read a provider's credential storage by design (see SECURITY.md).
   *
   * So this scope cannot distinguish "the same CLI, still logged into the same account" from
   * "the same CLI, logged out and back into a *different* account between two launches". The
   * literal type makes that gap visible at every use site instead of letting a reader assume the
   * scope binds to an account. Closing it needs `authSource`/`accountFingerprint` fields on
   * `ProviderStatus` that do not exist yet; see docs/adr-agentdock-v2-provenance.md.
   */
  readonly accountEvidence: 'cli_owned';
}

/**
 * Builds and freezes the scope for one launch. Frozen, not merely `readonly`-typed: `readonly` is
 * erased at runtime, and the entire value of this record is that whoever holds it later is holding
 * what was actually launched, not what someone edited afterwards.
 *
 * `authenticated` is widened to `string` rather than kept as `AuthStatus` on purpose: this field
 * is only ever compared for equality, never branched on, and typing it as the narrow union would
 * invite a future `if (scope.authenticated)` — the exact truthiness bug `AuthStatus` was designed
 * to prevent (see the comment on `AuthStatus`).
 */
export function freezeLaunchScope(
  status: ProviderStatus,
  start: StartSessionOptions,
  transportId: string,
): FrozenLaunchScope {
  return Object.freeze({
    provider: status.id,
    cwd: start.cwd,
    executablePath: status.executablePath,
    providerVersion: status.version,
    authenticated: status.authenticated,
    model: start.model,
    platform: process.platform,
    transportId,
    accountEvidence: 'cli_owned' as const,
  });
}

/**
 * The exact field list compared by `launchScopesEqual`, and the list the mutation-matrix test
 * iterates. Declared as a `const` tuple typed against `keyof FrozenLaunchScope` so that adding a
 * field to the interface without adding it here is a compile error at the `satisfies` below,
 * rather than a silent hole where two different launches compare equal.
 */
const SCOPE_FIELDS = [
  'provider',
  'cwd',
  'executablePath',
  'providerVersion',
  'authenticated',
  'model',
  'platform',
  'transportId',
  'accountEvidence',
] as const satisfies readonly (keyof FrozenLaunchScope)[];

/**
 * Compile-time exhaustiveness: if `FrozenLaunchScope` gains a field that is missing from
 * `SCOPE_FIELDS`, this type resolves to that field name instead of `never` and the assignment
 * below fails to compile. This is what stops a future field from being silently excluded from
 * equality — a hole that would let a materially different launch pass the gate's scope check.
 */
type MissingScopeField = Exclude<keyof FrozenLaunchScope, (typeof SCOPE_FIELDS)[number]>;
const _allScopeFieldsCompared: MissingScopeField extends never ? true : MissingScopeField = true;
void _allScopeFieldsCompared;

/** Field names compared for scope equality. Exported for the mutation-matrix test's field count. */
export const LAUNCH_SCOPE_FIELDS: readonly (keyof FrozenLaunchScope)[] = SCOPE_FIELDS;

/**
 * Field-by-field strict equality over the full declared field list.
 *
 * Explicitly not a JSON-stringify comparison: `JSON.stringify` is sensitive to key insertion order
 * and silently drops `undefined`-valued keys, which would make `{ model: undefined }` and a scope
 * with no `model` key at all compare equal to each other but *unequal* to a re-ordered copy of
 * themselves — the exact opposite of what is wanted. Iterating a fixed field list is both
 * insertion-order insensitive and `undefined`-preserving.
 */
export function launchScopesEqual(a: FrozenLaunchScope, b: FrozenLaunchScope): boolean {
  for (const field of SCOPE_FIELDS) {
    if (a[field] !== b[field]) return false;
  }
  return true;
}
