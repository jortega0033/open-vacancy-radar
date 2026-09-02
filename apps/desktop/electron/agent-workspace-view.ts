import { truncateToBytes } from '@agent-dock/shared';
import type {
  SessionCapacity,
  SessionScopeSummary,
  SessionSummary,
} from './agent-workspace-types.js';

/**
 * The main-process rebuild of the daemon's v2 session read view into the path-free `SessionSummary`
 * the renderer sees (ADI-07).
 *
 * ## Rebuilt, never spread, and never "spread minus omissions"
 *
 * Every field below is copied by name. There is no `{ ...view, cwd: undefined }` anywhere, and
 * that is the point rather than a style preference: `AgentSessionV2View` carries a real filesystem
 * path in `cwd` and another in `scope.executablePath`, and a spread-minus-omissions rebuild has
 * exactly one failure mode -- a *future* daemon build adds a path-shaped field, nobody updates the
 * omission list, and it crosses silently. A name-by-name rebuild fails the other way: the new field
 * simply does not appear, and someone has to come to this file to make it appear.
 *
 * `workspace-grant.ts`'s `createSession` response builder in main.ts already establishes this
 * discipline for `POST /v2/sessions`; this is the same rule applied to the read routes. And, as
 * there, the rebuild happens **twice**: once here, and again independently in `preload.ts`. Two
 * rebuilds is not redundancy, it is the assumption that main might one day be wrong.
 *
 * ## `cwd`, `providerSessionId`, and `scope.executablePath` are absent keys, not undefined values
 *
 * `{ cwd: undefined }` and `{}` serialize identically over IPC today, and are different objects to
 * every in-memory check that follows. A test asserting `expect(summary).not.toHaveProperty('cwd')`
 * passes only for the second. So none of the three is ever written, not even as `undefined`.
 */

/** Bounds for the identifier-ish strings copied verbatim. Matches ADI-05's own 256-byte precedent. */
const MAX_ID_BYTES = 256;
/** Enum-ish fields (`status`, `acceptedWork`, `continuationKind`, `terminalReason`). */
const MAX_ENUM_BYTES = 64;
/** ISO-8601 instants. */
const MAX_TIMESTAMP_BYTES = 64;
/** `authenticated`, `platform`, `providerVersion`: short adapter-authored labels. */
const MAX_LABEL_BYTES = 128;

function str(value: unknown, maxBytes: number): string | undefined {
  return typeof value === 'string' ? truncateToBytes(value, maxBytes) : undefined;
}

function nonNegativeInt(value: unknown): number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : 0;
}

/**
 * `FrozenLaunchScope`'s read view, minus `executablePath`.
 *
 * `accountEvidence` is written as the literal rather than copied, for the reason preload.ts writes
 * `effects: 'unbounded_cli'` as a literal: it is a documented *limitation* marker (see the ADR's
 * "accountEvidence: 'cli_owned' is not an account fingerprint"), and echoing back a stronger value
 * a future daemon sent would let a widened identity claim reach the UI without anyone reviewing it.
 */
function toScopeSummary(value: unknown): SessionScopeSummary {
  const source = (value && typeof value === 'object' ? value : {}) as Record<string, unknown>;
  const providerVersion = str(source.providerVersion, MAX_LABEL_BYTES);
  return {
    ...(providerVersion === undefined ? {} : { providerVersion }),
    authenticated: str(source.authenticated, MAX_LABEL_BYTES) ?? 'unknown',
    platform: str(source.platform, MAX_LABEL_BYTES) ?? 'unknown',
    accountEvidence: 'cli_owned',
  };
}

/**
 * Projects one `AgentSessionV2View`-shaped payload onto a `SessionSummary`.
 *
 * Takes `unknown` rather than the typed view because the input is an HTTP response body: typing it
 * would be a claim about a peer's output, and this function's whole job is to not make one. Returns
 * `null` when the payload does not even carry an `id`, which is the fail-closed direction (a
 * session this build cannot name is a session it cannot render).
 */
export function toSessionSummary(view: unknown): SessionSummary | null {
  if (!view || typeof view !== 'object' || Array.isArray(view)) return null;
  const source = view as Record<string, unknown>;

  const id = str(source.id, MAX_ID_BYTES);
  if (id === undefined || id.length === 0) return null;

  const model = str(source.model, MAX_ID_BYTES);
  const terminalReason = str(source.terminalReason, MAX_ENUM_BYTES);
  const parentSessionId = str(source.parentSessionId, MAX_ID_BYTES);
  const completedAt = str(source.completedAt, MAX_TIMESTAMP_BYTES);
  const protocolVersion = source.protocolVersion;

  return {
    id,
    provider: str(source.provider, MAX_ENUM_BYTES) ?? '',
    protocolVersion: typeof protocolVersion === 'number' && Number.isInteger(protocolVersion) ? protocolVersion : 1,
    transportId: str(source.transportId, MAX_ENUM_BYTES) ?? 'legacy-one-shot',
    ...(model === undefined ? {} : { model }),
    status: str(source.status, MAX_ENUM_BYTES) ?? 'starting',
    ...(terminalReason === undefined ? {} : { terminalReason }),
    acceptedWork: str(source.acceptedWork, MAX_ENUM_BYTES) ?? 'unknown',
    rootSessionId: str(source.rootSessionId, MAX_ID_BYTES) ?? id,
    ...(parentSessionId === undefined ? {} : { parentSessionId }),
    continuationKind: str(source.continuationKind, MAX_ENUM_BYTES) ?? 'fresh',
    startedAt: str(source.startedAt, MAX_TIMESTAMP_BYTES) ?? '',
    ...(completedAt === undefined ? {} : { completedAt }),
    earliestSequence: nonNegativeInt(source.earliestSequence),
    eventCount: nonNegativeInt(source.eventCount),
    eventsTruncated: source.eventsTruncated === true,
    scope: toScopeSummary(source.scope),
    // A count, not the frames themselves, and not `selection` either: both carry structure with no
    // reader in this UI, and the conservative rule for this boundary is that a field nothing renders
    // does not cross it.
    unknownFrameCount: Array.isArray(source.unknownFrames) ? source.unknownFrames.length : 0,
  };
}

/**
 * The daemon's own capacity aggregate, rebuilt.
 *
 * Rendered as-is, including the `provider` bucket's deliberate meaning: it reports the **busiest**
 * provider, not the one a particular session uses, because the question a list response answers is
 * "can I start another session?" and the honest ceiling across providers is whichever bucket is
 * closest to full (see `aggregateCapacity` in apps/daemon/src/routes/v2-sessions.ts). ADI-07 does
 * not add a `?provider=` query parameter to narrow it; a UI that rendered spare capacity a `POST`
 * would then refuse is worse than one that under-promises.
 */
export function toCapacity(value: unknown): SessionCapacity {
  const source = (value && typeof value === 'object' ? value : {}) as Record<string, unknown>;
  return { global: bucket(source.global), provider: bucket(source.provider) };
}

function bucket(value: unknown): { active: number; limit: number } {
  const source = (value && typeof value === 'object' ? value : {}) as Record<string, unknown>;
  return { active: nonNegativeInt(source.active), limit: nonNegativeInt(source.limit) };
}
