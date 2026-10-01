import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const JOB_HOST = fileURLToPath(
  new URL('../../../../apps/daemon/dist/agent-dock-job-host.exe', import.meta.url),
);
const JOB_HOST_BUILD = fileURLToPath(
  new URL('../../../../apps/daemon/scripts/build-windows-job-host.mjs', import.meta.url),
);

/**
 * Ensures the Windows Job Object host exists before any test spawns a process.
 *
 * Only builds when it is actually missing: compiling costs a couple of seconds, and rebuilding it
 * on every `vitest run` would tax the whole suite for a file that changes about once a ticket. The
 * tradeoff is that editing `AgentDock.JobHost.cs` requires deleting the exe (or running
 * `pnpm build`) to pick the change up in tests, which is the right side of the trade for a file
 * this stable.
 *
 * A build failure is left to throw. A silent fallback to "no job host" would turn a broken helper
 * into a suite of confusing ENOENT failures in unrelated tests, and — worse — would let the
 * orphan-reaping tests pass or fail for reasons unrelated to what they claim to check.
 */
export async function setup(): Promise<void> {
  if (process.platform !== 'win32') return;
  if (existsSync(JOB_HOST)) return;
  // Run as a subprocess rather than importing the builder: the build script is plain `.mjs` in
  // another workspace package with no type declarations, so importing it from TypeScript would
  // need a suppression comment for no benefit.
  await execFileAsync(process.execPath, [JOB_HOST_BUILD], { windowsHide: true });
}
