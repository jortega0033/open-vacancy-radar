import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { DEFAULT_APP_ID, sanitizeAppId } from './discovery-file.js';

/**
 * Resolves where the v2 durable session store lives on disk.
 *
 * Separate from `discovery-file.ts`'s runtime directory on purpose: that one holds a single
 * ephemeral rendezvous file under `os.tmpdir()` and is *expected* to be wiped by the OS. This one
 * holds state whose whole reason for existing is surviving a restart, so it must live under the
 * per-user application-data root instead. The app-id validation is deliberately shared with
 * discovery-file.ts (`sanitizeAppId`) rather than reimplemented: both turn the same untrusted
 * string into a path segment, and two independently-maintained "is this safe as a filename" checks
 * is exactly how one of them ends up weaker than the other.
 */

/**
 * The env override the desktop app sets (see apps/desktop/electron/main.ts), pointing the daemon at
 * a directory under Electron's own `userData` root so v2 state sits beside `workspace.db` and
 * `vacancy-engine.db` rather than creating a second, undocumented product-data location.
 */
export const STATE_DIR_ENV_VAR = 'AGENT_DOCK_STATE_DIR';

export interface ResolveStateDirectoryOptions {
  appId?: string;
  /**
   * Paths the state root must not be an ancestor or descendant of: the product databases
   * (`workspace.db`, `vacancy-engine.db`). See `assertNotColocatedWithProductData`.
   */
  reservedPaths?: readonly string[];
  /** Injected for tests; defaults to the real `process.env`. */
  env?: NodeJS.ProcessEnv;
}

/**
 * Platform-native per-user application-data root, per-app-id.
 *
 * - win32: `%LOCALAPPDATA%\<appId>` (falls back to `~/AppData/Local/<appId>` when the variable is
 *   somehow unset, which happens in stripped-down service contexts).
 * - darwin: `~/Library/Application Support/<appId>`.
 * - everything else: `$XDG_STATE_HOME/<appId>`, falling back to `~/.local/state/<appId>`.
 *   `XDG_STATE_HOME` and not `XDG_DATA_HOME`: this is state that is useful to keep but that a user
 *   losing would not consider data loss, which is exactly what the XDG spec reserves state for.
 */
function platformStateRoot(appId: string, env: NodeJS.ProcessEnv): string {
  if (process.platform === 'win32') {
    const localAppData = env.LOCALAPPDATA?.trim();
    return join(localAppData && localAppData.length > 0 ? localAppData : join(homedir(), 'AppData', 'Local'), appId);
  }
  if (process.platform === 'darwin') {
    return join(homedir(), 'Library', 'Application Support', appId);
  }
  const xdgStateHome = env.XDG_STATE_HOME?.trim();
  return join(
    xdgStateHome && xdgStateHome.length > 0 ? xdgStateHome : join(homedir(), '.local', 'state'),
    appId,
  );
}

/** True when `candidate` is `base`, or lives underneath it. Case-insensitive on win32. */
function isSameOrInside(base: string, candidate: string): boolean {
  const a = process.platform === 'win32' ? resolve(base).toLowerCase() : resolve(base);
  const b = process.platform === 'win32' ? resolve(candidate).toLowerCase() : resolve(candidate);
  if (a === b) return true;
  const rel = relative(a, b);
  return rel.length > 0 && !rel.startsWith('..') && !isAbsolute(rel);
}

/**
 * A mechanical guard, not a policy check: refuses a state root that contains, is contained by, or
 * equals any product database path.
 *
 * The failure this exists to prevent is not a permissions problem, it is a *lifecycle* one. The
 * product databases are backed up, migrated by drizzle, exported, and (on a "reset my workspace"
 * flow) deleted wholesale. A v2 state store that had been quietly nested inside one of those
 * directories would inherit all of that, and the specific consequence is the worst one this store
 * has: losing an `acceptedWork: 'accepted'` record means a session that already ran becomes
 * eligible for an automatic retry, duplicating a side effect in the user's working directory.
 * Making that structurally impossible is cheaper than remembering it at every future call site.
 */
export function assertNotColocatedWithProductData(
  stateRoot: string,
  reservedPaths: readonly string[],
): void {
  for (const reserved of reservedPaths) {
    if (!reserved) continue;
    if (isSameOrInside(stateRoot, reserved) || isSameOrInside(reserved, stateRoot)) {
      throw new Error(
        `refusing to use ${stateRoot} as the agent-dock state directory: it overlaps the product ` +
          `data path ${reserved}. The v2 session store must not share a directory tree with a ` +
          'product database, so a backup, migration, or workspace reset cannot take it along.',
      );
    }
  }
}

/**
 * Resolves and creates the per-app-id state root, returning its absolute path.
 *
 * Creation uses mode 0700. On win32 that argument is effectively advisory (NTFS ACLs are inherited
 * from the parent, and a per-user `%LOCALAPPDATA%` is already restrictive), so an `EPERM`/`ENOSYS`
 * from the mode is swallowed there rather than pretended to mean something. This mirrors the same
 * honest-about-Windows stance `discovery-file.ts#ensureSecureRuntimeDir` takes.
 */
export function resolveStateDirectory(options: ResolveStateDirectoryOptions = {}): string {
  const env = options.env ?? process.env;
  const appId = sanitizeAppId(options.appId?.trim() || DEFAULT_APP_ID);

  const override = env[STATE_DIR_ENV_VAR]?.trim();
  const stateRoot = override && override.length > 0 ? resolve(override) : platformStateRoot(appId, env);

  assertNotColocatedWithProductData(stateRoot, options.reservedPaths ?? []);

  try {
    mkdirSync(stateRoot, { recursive: true, mode: 0o700 });
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (process.platform !== 'win32' || (code !== 'EPERM' && code !== 'ENOSYS')) throw err;
    // Retry without the mode: on win32 the directory itself is still what we need.
    mkdirSync(stateRoot, { recursive: true });
  }

  return stateRoot;
}
