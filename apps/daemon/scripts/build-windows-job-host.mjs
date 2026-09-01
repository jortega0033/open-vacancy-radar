// Compiles the Windows Job Object host (native/windows/AgentDock.JobHost.cs) into
// dist/agent-dock-job-host.exe, next to the daemon's own esbuild bundle.
//
// Ported from upstream AgentDock (apps/daemon/scripts/build-windows-job-host.mjs at commit
// 8d0d9ef). See packages/agent-runtime/src/process/windows-job-host.ts for why the helper exists
// and how it is located at runtime.
//
// Two deliberate choices worth knowing about:
//
//   * **PowerShell's `Add-Type`, not a .NET SDK.** `Add-Type -OutputType ConsoleApplication` drives
//     the C# compiler that ships in-box with the .NET Framework on every supported Windows
//     install. Requiring a .NET SDK just to build the daemon would be a large new toolchain
//     dependency for one ~600-line helper, and would have to be installed on every contributor
//     machine and CI runner.
//   * **dist/, not a new packaging entry.** electron-builder.yml already ships all of
//     apps/daemon/dist to resources/daemon as an extraResources entry (the same way
//     @napi-rs/keyring's native binding rides along), so writing the exe here is sufficient for it
//     to be packaged and to sit beside the daemon bundle at runtime.
import { execFile } from 'node:child_process';
import { mkdir, rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export const WINDOWS_JOB_HOST_NAME = 'agent-dock-job-host.exe';
const DAEMON_DIR = fileURLToPath(new URL('../', import.meta.url));

/**
 * Guard for the Windows packaging pipeline. Packaging a Windows build from a non-Windows host
 * would silently produce an installer with no Job Host in it, and the failure would only show up
 * as orphaned processes on an end user's machine after a cancelled session. Failing the build
 * loudly is much better than shipping that.
 */
export function assertWindowsJobHostBuildPlatform(platform = process.platform) {
  if (platform !== 'win32') {
    throw new Error(
      'Windows packaging requires win32 so agent-dock-job-host.exe is compiled and verified',
    );
  }
}

export async function buildWindowsJobHost() {
  const outputPath = join(DAEMON_DIR, 'dist', WINDOWS_JOB_HOST_NAME);
  // Removed first so a failed compile can never leave a stale exe from an earlier source revision
  // in place, which would then be packaged and shipped as if it were current.
  await rm(outputPath, { force: true });
  // A no-op rather than an error off Windows: `pnpm build` runs on Linux CI and macOS dev machines,
  // and neither needs (nor can produce) this helper. The packaging path uses the assert above.
  if (process.platform !== 'win32') return undefined;

  const sourcePath = join(DAEMON_DIR, 'native', 'windows', 'AgentDock.JobHost.cs');
  await mkdir(dirname(outputPath), { recursive: true });
  // Paths reach PowerShell as single-quoted literals with '' doubling, never interpolated into a
  // command where a path containing a quote or a $ could change what runs.
  const literal = (value) => `'${value.replaceAll("'", "''")}'`;
  const command = [
    '$ErrorActionPreference = "Stop"',
    `Add-Type -LiteralPath ${literal(sourcePath)} -OutputAssembly ${literal(outputPath)} -OutputType ConsoleApplication`,
  ].join('; ');
  try {
    await execFileAsync(
      'powershell.exe',
      ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', command],
      { windowsHide: true, maxBuffer: 1024 * 1024 },
    );
  } catch (error) {
    const stderr = error && typeof error === 'object' && 'stderr' in error ? error.stderr : '';
    throw new Error(
      `Windows Job Object host build failed${stderr ? `: ${String(stderr).trim()}` : ''}`,
    );
  }
  return outputPath;
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  if (process.argv.includes('--assert-windows')) assertWindowsJobHostBuildPlatform();
  else await buildWindowsJobHost();
}
