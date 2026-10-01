import { spawnProcess } from './spawn-process.js';

export interface ExecResult {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

/**
 * Runs a short-lived command (version checks, auth status) and captures its output. Not for
 * long-running sessions. Use spawnProcess + readLines for those. Always bounded by a timeout
 * so a hung CLI can't stall provider detection indefinitely.
 *
 * The environment is not this function's decision (ADI-15): `opts.env` is forwarded to
 * `spawnProcess`, which filters it (or `process.env` when it is unset, as it is at every call site
 * here) through `buildProviderEnvironment`. Both providers' `detect.ts` reach a CLI through this
 * function, so their auth and version probes run under the same allowlist a real session does --
 * which is the point: a detection path that saw a broader environment than the session path would
 * make detection results say nothing about what a session will actually get.
 */
export async function execCapture(
  command: string,
  args: string[],
  opts: { cwd?: string; env?: NodeJS.ProcessEnv; timeoutMs?: number } = {},
): Promise<ExecResult> {
  const { child, exit, kill } = spawnProcess(command, args, {
    cwd: opts.cwd ?? process.cwd(),
    env: opts.env,
    // Bypasses the Windows Job Host: `command` here is routinely a bare name (`where`, `which`,
    // or a CLI invoked only for a quick version/auth check) that relies on the OS's own PATH
    // search, which the Job Host cannot do (it requires an already-absolute path). See
    // `SpawnOptions.useJobHostOnWindows`'s doc comment for the detection breakage this avoids.
    useJobHostOnWindows: false,
  });

  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk: Buffer) => {
    if (stdout.length < 1_000_000) stdout += chunk.toString('utf8');
  });
  child.stderr.on('data', (chunk: Buffer) => {
    if (stderr.length < 1_000_000) stderr += chunk.toString('utf8');
  });

  const timeoutMs = opts.timeoutMs ?? 10_000;
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    // `kill()` returns a promise as of ADI-04 and rejects if the tree cannot be confirmed reaped.
    // Not awaited here on purpose: this timeout's job is to stop *waiting* on a hung CLI, and
    // `await exit` below already resolves once the direct child is gone. The rejection is caught
    // rather than left floating, since an unhandled rejection would crash the daemon over a
    // best-effort cleanup of a version check.
    void kill().catch(() => undefined);
  }, timeoutMs);

  const { code } = await exit;
  clearTimeout(timer);

  return { code, stdout, stderr, timedOut };
}
