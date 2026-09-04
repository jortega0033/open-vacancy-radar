// AD-09: this used to also re-export process/* internals, both providers' build-args, and both
// real providers' capabilities objects, none of which any consumer outside this package (or its
// own tests, which import them by relative path) actually used, and docs/protocol-v1.md already
// (incorrectly) claimed build-args was unexported. Trimmed to what apps/daemon genuinely needs,
// so the documented "internal" surface is actually internal rather than merely undocumented.
export * from './types.js';
export * from './logger.js';
export * from './registry.js';
export * from './providers/claude/adapter.js';
export * from './providers/codex/adapter.js';
export * from './providers/fake/adapter.js';

// ADI-04. Exported for the same reason ADI-03's model-select is: nothing in apps/daemon calls this
// yet (session-manager.ts is deliberately untouched), but the surface is the reviewed one a later
// ticket will wire in, and keeping it unexported would mean re-litigating the API at that point.
// Only the public types are re-exported here — `run-session.ts` and `process/*` stay internal, per
// the AD-09 note at the top of this file.
export * from './providers/compatibility-manifest.js';
export * from './providers/common/session-supervisor.js';
export type {
  AcceptedWorkState,
} from './providers/common/accepted-work.js';
export { ACCEPTED_WORK_RANK, AcceptedWorkLatch } from './providers/common/accepted-work.js';
export type { FrozenLaunchScope } from './providers/common/launch-scope.js';
export { freezeLaunchScope, launchScopesEqual } from './providers/common/launch-scope.js';
// Issue #176: apps/daemon genuinely needs this now, for workspace-identity.ts's git spawn, per the
// same "trimmed to what apps/daemon genuinely needs" principle the AD-09 note above states.
export type { ProviderEnvironment } from './providers/common/provider-environment.js';
export { buildProviderEnvironment } from './providers/common/provider-environment.js';
export type {
  FallbackAuthorizeInput,
  FallbackDecision,
  FallbackDeniedReason,
  ProviderDeliveryState,
} from './providers/common/fallback-gate.js';
export { FallbackGate, ProviderTransportStartupError } from './providers/common/fallback-gate.js';
export type {
  NormalizedUnknownFrame,
  UnknownFrameKind,
} from './providers/common/unknown-frames.js';
export { PROVIDER_FRAME_BOUNDS, UnknownFrameLedger } from './providers/common/unknown-frames.js';
