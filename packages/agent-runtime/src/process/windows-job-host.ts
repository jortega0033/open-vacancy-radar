import { existsSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Locating and invoking the shipped Windows Job Object host.
 *
 * Ported near-verbatim from upstream AgentDock (`packages/agent-runtime/src/process/windows-job-host.ts`
 * at commit 8d0d9ef), adapted only for this repo's paths. See
 * `apps/daemon/native/windows/AgentDock.JobHost.cs` for the host itself and
 * docs/adr-agentdock-v2-provenance.md for why Windows needs one at all.
 *
 * The short version: Windows has no process group that survives its leader. `taskkill /T` walks
 * the live parent-PID chain, so a grandchild whose intermediate parent has already exited is
 * simply unreachable — it is not "hard to find", it is genuinely not in the tree any more. A Job
 * Object is the kernel's own answer: membership is permanent, inherited at creation, and
 * `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE` makes closing the last handle terminate every member
 * atomically. The host exists to hold that one handle.
 */

export const WINDOWS_JOB_HOST_NAME = 'agent-dock-job-host.exe';

const MODULE_PATH = fileURLToPath(import.meta.url);

function encodeField(value: string): string {
  return Buffer.from(value, 'utf8').toString('base64');
}

/**
 * Encodes the version-1 Job Host wire protocol: `[ownerPid, executable, cwd, ...args]`, each field
 * independently base64'd.
 *
 * Base64 rather than raw values because these arguments cross a `CreateProcess` command line,
 * which is a single flat string that the receiving process re-splits. Encoding every field removes
 * the entire class of quoting bugs (embedded quotes, trailing backslashes, spaces, `%`, `&`) from
 * the transport, so the host recovers exactly the bytes we sent and re-quotes them itself using
 * the correct algorithm for the target (see `QuoteArgument` / `EscapeCmdArgument` in the .cs host).
 *
 * `ownerPid` is the daemon's own pid: the host watches it and tears the job down if the daemon
 * dies, so a crashed daemon cannot leave an orphaned provider tree running.
 */
export function encodeWindowsJobHostArguments(options: {
  ownerPid: number;
  executable: string;
  cwd: string;
  args: readonly string[];
}): string[] {
  if (!Number.isSafeInteger(options.ownerPid) || options.ownerPid <= 0) {
    throw new TypeError('Windows Job Host owner PID must be a positive integer');
  }
  return [String(options.ownerPid), options.executable, options.cwd, ...options.args].map(encodeField);
}

/**
 * Resolves the shipped helper, and only the shipped helper.
 *
 * Never consults `PATH` and never resolves relative to the process working directory: this
 * executable is handed a fully-privileged command line, so resolving it by search would be a
 * straightforward hijack — drop an `agent-dock-job-host.exe` in the daemon's cwd and every
 * provider launch runs it instead. Every candidate below is an absolute path derived either from
 * the daemon's own entry point or from this module's location.
 *
 * The candidate order mirrors `apps/desktop/electron/resolve-daemon-entry.ts`'s three cases:
 *
 * 1. Packaged: the daemon runs as `resourcesPath/daemon/index.js`, so the helper sits beside it at
 *    `resourcesPath/daemon/agent-dock-job-host.exe`. It gets there for free — `electron-builder.yml`
 *    already ships all of `apps/daemon/dist` to `resources/daemon` as an `extraResources` entry,
 *    exactly like `@napi-rs/keyring`'s native binding, so no new packaging entry is needed.
 * 2. Bundled-but-unpackaged: `apps/daemon/dist/index.js` run directly, same colocation.
 * 3. Workspace TypeScript (dev/tests): this module is real source under `packages/agent-runtime/src`,
 *    so walk up to the repo root and into `apps/daemon/dist`.
 *
 * An `explicitPath` override exists for tests and embedders and must be absolute, so the override
 * cannot itself reintroduce cwd-relative resolution.
 */
export function resolveWindowsJobHostPath(
  explicitPath?: string,
  entrypoint: string | undefined = process.argv[1],
): string {
  if (explicitPath && !isAbsolute(explicitPath)) {
    throw new TypeError('Windows Job Host override must be an absolute path');
  }
  const moduleDirectory = dirname(MODULE_PATH);
  const candidates = explicitPath
    ? [explicitPath]
    : [
        ...(entrypoint && isAbsolute(entrypoint)
          ? [
              join(dirname(entrypoint), WINDOWS_JOB_HOST_NAME),
              join(dirname(entrypoint), '..', 'dist', WINDOWS_JOB_HOST_NAME),
            ]
          : []),
        // Packaged/bundled: this module is inlined into apps/daemon/dist/index.js.
        join(moduleDirectory, WINDOWS_JOB_HOST_NAME),
        // Workspace source: packages/agent-runtime/src/process -> repo root -> apps/daemon/dist.
        join(moduleDirectory, '..', '..', '..', '..', 'apps', 'daemon', 'dist', WINDOWS_JOB_HOST_NAME),
      ];

  for (const candidate of candidates) {
    if (existsSync(candidate)) return realpathSync.native(candidate);
  }
  // Returning a path that does not exist is deliberate: it preserves the existing asynchronous
  // spawn-error path (an ENOENT surfaces as a normal session failure) rather than throwing
  // synchronously from a function whose callers are not written to expect a throw. A missing
  // helper always fails the launch; it never silently falls back to an unprotected spawn.
  return candidates[0] ?? join(moduleDirectory, WINDOWS_JOB_HOST_NAME);
}
