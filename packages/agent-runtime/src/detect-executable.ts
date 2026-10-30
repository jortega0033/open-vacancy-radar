import { existsSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, win32 } from 'node:path';
import { execCapture } from './process/exec-capture.js';

export interface FindExecutableOptions {
  /** Test seam only. Production always uses the real `process.platform`. */
  platform?: NodeJS.Platform;
}

/**
 * Locates an executable without assuming it's on the PATH the daemon inherited. Electron/GUI
 * apps frequently start with a different PATH than an interactive login shell (notably on
 * macOS), so on top of a real PATH lookup (`where` / `which`, never a shell builtin) we probe a
 * short, curated list of directories CLI installers commonly use.
 *
 * On Windows the result must also be something this package can actually launch without a shell
 * (#719). `where claude` on an npm install lists the extensionless `sh` shim *first* and the
 * `.cmd` shim second; neither Node's shell-free `spawn` nor the Job Host can run the extensionless
 * one, so taking the first line made detection report `claude --version failed` and every session
 * die with SIGKILL. See `selectWindowsSpawnTarget` for the rule.
 */
export async function findExecutable(
  names: string[],
  extraCandidateDirs: string[] = [],
  options: FindExecutableOptions = {},
): Promise<string | null> {
  const platform = options.platform ?? process.platform;
  const isWindows = platform === 'win32';

  for (const name of names) {
    if (isAbsolute(name) && existsSync(name)) return name;
  }

  for (const name of names) {
    const onPath = await lookupOnPath(name, isWindows);
    const selected = isWindows ? selectWindowsSpawnTarget(onPath) : onPath[0];
    if (selected) return selected;
  }

  // Directory order stays authoritative here (callers' `extraCandidateDirs` first); within one
  // directory a native `.exe` beats a `.cmd`, and on Windows an extensionless file never qualifies.
  const candidateDirs = [...extraCandidateDirs, ...commonInstallDirs(platform)];
  for (const dir of candidateDirs) {
    for (const name of names) {
      if (isWindows) {
        const selected = selectWindowsSpawnTarget(
          WINDOWS_SPAWNABLE_EXTENSIONS.map((ext) => join(dir, `${name}${ext}`)),
        );
        if (selected) return selected;
        continue;
      }
      const candidate = join(dir, name);
      if (existsSync(candidate)) return candidate;
    }
  }

  return null;
}

/**
 * The only file types a provider can be launched from on Windows, in preference order. `.exe` is
 * spawned natively; `.cmd` is launched through the Job Host's quoted `cmd.exe /d /s /c` path (see
 * `spawnProcess`). Anything else -- the extensionless npm `sh` shim, `.ps1`, `.bat` -- is not
 * launchable shell-free and is skipped rather than returned and failed on later.
 */
const WINDOWS_SPAWNABLE_EXTENSIONS = ['.exe', '.cmd'] as const;

/**
 * Picks a deterministic, launchable Windows target from candidates in search order: the first
 * usable native `.exe`, otherwise the first usable `.cmd`. A candidate is usable only if it is an
 * absolute path to an existing regular file with one of those extensions, so a stale `where` line,
 * a directory, or a non-launchable shim earlier in the list cannot shadow a usable one after it.
 * Native wins across the list because it needs no command interpreter at all.
 */
function selectWindowsSpawnTarget(candidates: readonly string[]): string | null {
  const usable = candidates.filter(isUsableWindowsTarget);
  for (const extension of WINDOWS_SPAWNABLE_EXTENSIONS) {
    const match = usable.find((candidate) => win32.extname(candidate).toLowerCase() === extension);
    if (match) return match;
  }
  return null;
}

function isUsableWindowsTarget(candidate: string): boolean {
  const extension = win32.extname(candidate).toLowerCase();
  if (!(WINDOWS_SPAWNABLE_EXTENSIONS as readonly string[]).includes(extension)) return false;
  if (!isAbsolute(candidate)) return false;
  try {
    return statSync(candidate).isFile();
  } catch {
    return false;
  }
}

/**
 * Every non-empty line of a real PATH lookup, in the lookup's own order. Windows callers need the
 * whole list (see `selectWindowsSpawnTarget`); POSIX callers use the first line, as before.
 */
async function lookupOnPath(name: string, isWindows: boolean): Promise<string[]> {
  const [command, args] = isWindows ? ['where', [name]] : ['which', [name]];
  try {
    const result = await execCapture(command, args, { timeoutMs: 5_000 });
    if (result.code !== 0) return [];
    return result.stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
  } catch {
    return [];
  }
}

function commonInstallDirs(platform: NodeJS.Platform): string[] {
  const home = homedir();
  if (platform === 'darwin') {
    return [
      join(home, '.local', 'bin'),
      '/usr/local/bin',
      '/opt/homebrew/bin',
      join(home, '.npm-global', 'bin'),
    ];
  }
  if (platform === 'win32') {
    const localAppData = process.env.LOCALAPPDATA ?? join(home, 'AppData', 'Local');
    const appData = process.env.APPDATA ?? join(home, 'AppData', 'Roaming');
    return [
      join(home, '.local', 'bin'),
      join(localAppData, 'Programs', 'OpenAI', 'Codex', 'bin'),
      join(appData, 'npm'),
    ];
  }
  return [join(home, '.local', 'bin'), '/usr/local/bin', '/usr/bin'];
}
