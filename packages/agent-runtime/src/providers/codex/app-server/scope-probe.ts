import type { AuthSource } from '@agent-dock/shared';
import { CodexAppServerProtocolError } from './errors.js';
import { ManagedAppServerProcess } from './managed-process.js';
import { CodexAppServerRpc } from './rpc.js';
import {
  parseCodexAccountScope,
  parseCodexModelCatalog,
  resolveCodexSelectedModel,
  toCodexContinuationEvidence,
  type CodexContinuationEvidence,
} from './scope-evidence.js';

export interface CodexAppServerScopeProbeOptions {
  executable: string;
  cwd: string;
  /** The `authSource` `detect()` already reported for this provider status -- compared against
   * what the live probe observes, so a changed/re-authenticated account is caught rather than
   * silently trusted. */
  detectedAuthSource: AuthSource | undefined;
  pinnedModel?: string;
  env?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  /** Test seam only. */
  executableArgs?: readonly string[];
  /** Test seam only. */
  processPlatform?: NodeJS.Platform;
  /** Test/development override for the packaged Windows Job Object host. */
  windowsJobHostPath?: string;
}

const SCOPE_PROBE_TIMEOUT_MS = 4_000;

function waitForProbe<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (signal?.aborted) {
    return Promise.reject(new CodexAppServerProtocolError('closed', 'Scope probe was cancelled'));
  }
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const finish = (callback: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', aborted);
      callback();
    };
    const aborted = (): void => {
      finish(() => reject(new CodexAppServerProtocolError('closed', 'Scope probe was cancelled')));
    };
    const timer = setTimeout(() => finish(() => reject(new CodexAppServerProtocolError('process_failed', 'Scope probe timed out'))), SCOPE_PROBE_TIMEOUT_MS);
    timer.unref?.();
    signal?.addEventListener('abort', aborted, { once: true });
    promise.then(
      (value) => finish(() => resolve(value)),
      (error: unknown) => finish(() => reject(error)),
    );
  });
}

/**
 * The subset of `CodexAppServerScopeProbeOptions` any short-lived, read-only app-server probe
 * needs -- i.e. everything except `detectedAuthSource` and `pinnedModel`, which are specific to
 * `probeCodexAppServerScope`'s own account/model-binding check. Exported so a second probe with no
 * use for those two fields (ADI-22a's `probeCodexModelCatalog`, `model-catalog.ts`) can share this
 * shape and `withCodexAppServerRpc` itself, rather than redeclaring the same seven fields or
 * spawning its own process/RPC pair from scratch.
 */
export type CodexAppServerProbeOptions = Pick<
  CodexAppServerScopeProbeOptions,
  'executable' | 'cwd' | 'env' | 'signal' | 'executableArgs' | 'processPlatform' | 'windowsJobHostPath'
>;

/**
 * Opens a short-lived app-server process, completes the `initialize`/`initialized` handshake, runs
 * `body` against the live RPC connection, and always tears the process down afterward. No thread or
 * turn request is ever sent here, so an unsupported/misbehaving version can be probed without ever
 * becoming a rich transport -- this is the property `ProviderTransportStartupError`'s
 * `deliveryState: 'not_delivered'` throughout `scope-evidence.ts` depends on being true.
 *
 * No `await processHost.ready` step, unlike upstream: this repo's `ManagedAppServerProcess` (see
 * its own doc comment) has no readiness race to wait out in the first place.
 *
 * Exported (ADI-22a) for `model-catalog.ts`'s `probeCodexModelCatalog`, the second real caller of
 * this process/RPC scaffolding -- see that module for why a second short-lived probe is exactly the
 * kind of caller this function's own doc comment already anticipated ("a future settings/
 * diagnostics surface", `transport-selection.ts`).
 */
export async function withCodexAppServerRpc<T>(
  options: CodexAppServerProbeOptions,
  body: (rpc: CodexAppServerRpc) => Promise<T>,
): Promise<T> {
  const rpcRef: { current?: CodexAppServerRpc } = {};
  const processHost = new ManagedAppServerProcess({
    executable: options.executable,
    executableArgs: options.executableArgs,
    cwd: options.cwd,
    env: options.env,
    platform: options.processPlatform,
    windowsJobHostPath: options.windowsJobHostPath,
    onStdout: (chunk) => rpcRef.current?.acceptStdout(chunk),
    onStdoutEnd: () => rpcRef.current?.endStdout(),
    onFailure: (error) => rpcRef.current?.fail(error),
  });
  const rpc = new CodexAppServerRpc({
    write: (frame) => processHost.write(frame),
    onNotification: () => undefined,
    onRequest: () => {
      throw new CodexAppServerProtocolError('forbidden_method', 'Codex app-server requested interaction during a read-only probe');
    },
    onFatal: () => undefined,
  });
  rpcRef.current = rpc;

  let succeeded = false;
  try {
    const result = await waitForProbe(
      (async () => {
        await rpc.request('initialize', { clientInfo: { name: 'agent_dock', title: 'Agent Dock', version: '0.1.0' }, capabilities: null });
        await rpc.notify('initialized');
        return body(rpc);
      })(),
      options.signal,
    );
    succeeded = true;
    return result;
  } finally {
    rpc.shutdown();
    if (succeeded) await processHost.close();
    else await processHost.forceClose();
  }
}

/**
 * Reads only stable, non-mutating app-server account/model metadata and returns the
 * account+model binding a later stage needs to bind a resume continuation safely. Returns
 * `undefined` when the account has no bindable fingerprint (API-key auth) -- a real, expected
 * outcome, not a probe failure.
 */
export async function probeCodexAppServerScope(options: CodexAppServerScopeProbeOptions): Promise<Readonly<CodexContinuationEvidence> | undefined> {
  return withCodexAppServerRpc(options, async (rpc) => {
    const account = parseCodexAccountScope(await rpc.request('account/read', { refreshToken: false }));
    if (!options.detectedAuthSource || options.detectedAuthSource === 'unknown' || account.authSource !== options.detectedAuthSource) {
      throw new CodexAppServerProtocolError('state_invalid', 'Codex authentication source changed during scope probe');
    }
    const catalog = parseCodexModelCatalog(await rpc.request('model/list', { limit: 1_024, includeHidden: false }));
    const selectedModel = resolveCodexSelectedModel(catalog, options.pinnedModel);
    return toCodexContinuationEvidence(account, selectedModel);
  });
}
