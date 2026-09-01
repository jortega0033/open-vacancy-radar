/**
 * The reviewed compatibility manifest: which provider CLI versions, over which transport, this
 * repo has actually exercised, and where each one's "accepted work" boundary sits.
 *
 * Ported from upstream AgentDock (`packages/agent-runtime/src/providers/compatibility-manifest.ts`
 * at commit 7aec0f1) and re-pinned to the two CLI versions this fork was verified against. The
 * upstream entry for a rich interactive transport is deliberately omitted: this repo ships exactly
 * one transport per provider (see LEGACY_ONE_SHOT_TRANSPORT_ID), and adding a second entry here is
 * the thing that would let the fallback gate ever say "allowed" (see providers/common/fallback-gate.ts).
 *
 * See docs/adr-agentdock-v2-provenance.md for the full three-way scope split.
 */

/**
 * The only transport this repo has: `runProviderSession` spawning a provider CLI once,
 * non-interactively, reading its JSONL on stdout until it exits. Named rather than implied so the
 * fallback gate and the manifest can both refer to "the transport we actually ship" by identity.
 */
export const LEGACY_ONE_SHOT_TRANSPORT_ID = 'legacy-one-shot';

/**
 * Deliberately a wider union than `ProviderId`: a manifest entry describes a *CLI implementation*
 * that was version-pinned and tested, which includes the in-repo `fake` provider used by the
 * daemon's own tests. `ProviderId` is the narrower set of providers the product exposes.
 */
export type ProviderImplementation = 'claude' | 'codex' | 'fake';

/**
 * The instant after which this repo can no longer prove the provider did *not* act on the user's
 * prompt. This is a safety boundary, not a progress indicator: it exists so a supervisor can
 * answer "is it safe to retry / fall back to another transport?" without guessing.
 *
 * - `'first-prompt-byte-to-stdin'` — the prompt reaches the CLI only once bytes are written to its
 *   stdin, so everything before that write is provably un-delivered. This is the *later*, more
 *   precise boundary, and only a CLI that reads its prompt from stdin can claim it.
 * - `'process-spawn-attempt'` — the prompt is already embedded in the process command line, so it
 *   is delivered atomically by the act of creating the process. There is no later moment to
 *   observe, and no earlier one that is safe to assume.
 */
export type AcceptedWorkBoundary = 'first-prompt-byte-to-stdin' | 'process-spawn-attempt';

export interface ProviderCompatibilityManifestEntry {
  readonly provider: ProviderImplementation;
  /** Exact `--version` string component this entry was verified against. Never a range. */
  readonly providerVersion: string;
  readonly transportId: string;
  readonly acceptedWorkBoundary: AcceptedWorkBoundary;
  /** Names the conformance fixture corpus this pairing is expected to satisfy. */
  readonly fixtureSet: string;
}

/**
 * Claude Code. `providers/claude/adapter.ts` sets `promptViaStdin: true` and
 * `providers/claude/build-args.ts` deliberately keeps the prompt out of argv entirely, so the
 * boundary is the stdin write, not the spawn.
 *
 * Verified against `claude --version` reporting `2.1.228 (Claude Code)`.
 */
export const CLAUDE_LEGACY_COMPATIBILITY: ProviderCompatibilityManifestEntry = Object.freeze({
  provider: 'claude',
  providerVersion: '2.1.228',
  transportId: LEGACY_ONE_SHOT_TRANSPORT_ID,
  acceptedWorkBoundary: 'first-prompt-byte-to-stdin',
  fixtureSet: 'claude-legacy-2.1.228-v1',
});

/**
 * Codex. `providers/codex/build-args.ts` places the prompt directly in argv (`codex exec <prompt>`),
 * so by the time the process exists the prompt has already been handed over. The boundary is
 * therefore the spawn attempt itself.
 *
 * Verified against `codex --version` reporting `codex-cli 0.147.0`.
 */
export const CODEX_LEGACY_COMPATIBILITY: ProviderCompatibilityManifestEntry = Object.freeze({
  provider: 'codex',
  providerVersion: '0.147.0',
  transportId: LEGACY_ONE_SHOT_TRANSPORT_ID,
  acceptedWorkBoundary: 'process-spawn-attempt',
  fixtureSet: 'codex-legacy-0.147.0-v1',
});

export const PROVIDER_COMPATIBILITY_MANIFEST: readonly ProviderCompatibilityManifestEntry[] =
  Object.freeze([CLAUDE_LEGACY_COMPATIBILITY, CODEX_LEGACY_COMPATIBILITY]);

/**
 * Exact-match lookup. There is deliberately no version-range matching and no "nearest version"
 * fallback: a manifest entry is a claim that *this exact build* was run against the conformance
 * fixtures, and a semver-range match would silently extend that claim to builds nobody tested.
 * A miss is not an error — it is a legitimate, expected state (a user on a newer CLI) that the
 * caller handles by falling back to the conservative boundary via `acceptedWorkBoundaryFor`.
 */
export function findProviderCompatibility(
  provider: ProviderImplementation,
  providerVersion: string | undefined,
  transportId: string,
): ProviderCompatibilityManifestEntry | undefined {
  if (!providerVersion) return undefined;
  return PROVIDER_COMPATIBILITY_MANIFEST.find(
    (entry) =>
      entry.provider === provider &&
      entry.providerVersion === providerVersion &&
      entry.transportId === transportId,
  );
}

/**
 * The fail-closed default, and the reason this function exists rather than callers writing
 * `entry.acceptedWorkBoundary` inline with their own `??`.
 *
 * An unrecognized provider/version pairing must get the **most conservative** boundary, never the
 * least. `'process-spawn-attempt'` is the earliest boundary in the union, meaning "assume the
 * prompt may have been delivered the moment we tried to start the process". Defaulting the other
 * way (`'first-prompt-byte-to-stdin'`) would assume an *unverified* CLI reads its prompt from
 * stdin and that nothing before that write can have reached it — an assumption that is false for
 * every argv-prompt CLI, and whose failure mode is the dangerous one: concluding "no work was
 * accepted, safe to retry" for a CLI that already started acting on the user's prompt.
 *
 * Being wrong in this direction costs a retry that the supervisor refuses to authorize. Being
 * wrong in the other direction costs a duplicated side effect in the user's working directory.
 */
export function acceptedWorkBoundaryFor(
  entry: ProviderCompatibilityManifestEntry | undefined,
): AcceptedWorkBoundary {
  return entry?.acceptedWorkBoundary ?? 'process-spawn-attempt';
}
