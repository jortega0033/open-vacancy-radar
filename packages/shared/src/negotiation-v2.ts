/** The only v2 version this build understands. A future v3 gets its own constant, not a bump of this one. */
export const PROTOCOL_VERSION_V2 = 2;

/** The shape `GET /health` returns, as far as negotiation cares -- see `healthResponseSchema`. */
export interface ProtocolVersionSource {
  protocolVersion: number;
  supportedProtocolVersions?: readonly number[];
}

/** What a client and a daemon agreed on, derived entirely from one `GET /health` response. */
export interface ProtocolNegotiation {
  /** Every version this client build understands. */
  readonly clientVersions: readonly number[];
  /** Every version the daemon advertised (falls back to `[protocolVersion]` for a pre-v2 daemon). */
  readonly daemonVersions: readonly number[];
  /** The highest version both sides understand. */
  readonly selected: number;
}

/**
 * A pre-v2 daemon has no `supportedProtocolVersions` field at all; its only signal is the legacy
 * `protocolVersion` scalar, which this treats as "the one version I speak." When the array IS
 * present, it is authoritative and the scalar is ignored entirely, even if the two disagree: a
 * well-behaved daemon that still supports v1 always includes 1 in the array (see
 * `healthResponseSchema`'s doc comment in schemas.ts), so a daemon whose array omits 1 while its
 * scalar still claims 1 is self-contradictory, and trusting the more specific field is the only
 * option that doesn't require guessing which of two conflicting signals a buggy daemon meant.
 */
export function daemonProtocolVersions(health: ProtocolVersionSource): readonly number[] {
  return health.supportedProtocolVersions ?? [health.protocolVersion];
}

/**
 * Highest-common-version selection. Returns `undefined` when the client and daemon share no
 * version at all -- the caller decides what that means (typically `ProtocolMismatchError`).
 * Order of either input never matters, and a version neither side recognizes is simply ignored
 * rather than causing a spurious mismatch.
 */
export function negotiateProtocolVersion(
  clientVersions: readonly number[],
  daemonVersions: readonly number[],
): ProtocolNegotiation | undefined {
  const shared = clientVersions.filter((version) => daemonVersions.includes(version));
  if (shared.length === 0) return undefined;
  return { clientVersions, daemonVersions, selected: Math.max(...shared) };
}

/**
 * Whether `version` is safe to use against this negotiation: both this client build and the
 * daemon must actually list it. Deliberately membership in the shared set, not `selected ===
 * version` -- checking against the negotiated top alone would wrongly reject a real, fully shared
 * version the moment a *third*, higher version enters either side's list (e.g. once a v3 exists,
 * a client and daemon that both still list `[1, 2, 3]` would otherwise have
 * `supportsProtocolVersion(negotiation, 2)` read as unusable even though 2 is fully shared).
 * Membership also already gives the legacy version (`AGENT_DOCK_PROTOCOL_VERSION`) exactly the
 * leniency it needs -- it was the sole protocol for years and this client always lists it in
 * `AGENT_DOCK_SUPPORTED_PROTOCOL_VERSIONS`, so nothing about negotiation makes it harder to reach
 * than before v2 existed, without needing a special case here.
 */
export function supportsProtocolVersion(negotiation: ProtocolNegotiation, version: number): boolean {
  return negotiation.clientVersions.includes(version) && negotiation.daemonVersions.includes(version);
}
