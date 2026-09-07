// Barrel for the Codex app-server subsystem. Grows as later ADI-08 stages land (scope-probe,
// normalizer, transport); Stage 1 only has the RPC primitives to export so far.
//
// No FailableChannel here, unlike upstream: upstream's own managed-process.ts never actually calls
// its `fail()` method, and its byte-bounding is redundant once stderr is reduced to fixed-format
// "N bytes redacted" summary strings (which it already is -- see managed-process.ts's
// `redactStderr`). This repo's existing `AsyncChannel` (process/async-channel.ts) already covers
// the bounded-push/close semantics that summary stream actually needs, so Stage 2 uses that
// instead of porting a near-duplicate class for capabilities nothing here exercises.
export { CodexAppServerProtocolError, boundedUtf8, safeDisplay } from './errors.js';
export { deferred, type Deferred } from './deferred.js';
export { CodexAppServerRpc, type CodexAppServerRpcOptions, type IncomingRequestResponder, type RpcId } from './rpc.js';
export { ManagedAppServerProcess, type ManagedAppServerProcessOptions } from './managed-process.js';
export {
  parseCodexAccountScope,
  parseCodexModelCatalog,
  resolveCodexSelectedModel,
  toCodexContinuationEvidence,
  type CodexAccountScope,
  type CodexAppServerModel,
  type CodexContinuationEvidence,
} from './scope-evidence.js';
export { probeCodexAppServerScope, type CodexAppServerScopeProbeOptions } from './scope-probe.js';
export { CodexAppServerNormalizer } from './normalizer.js';
