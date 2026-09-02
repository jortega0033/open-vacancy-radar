import { execFile } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { realpath as realpathCallback, promises as fs, type BigIntStats } from 'node:fs';
import { basename } from 'node:path';
import { promisify } from 'node:util';
import {
  MAX_WORKSPACE_BRANCH_LENGTH,
  MAX_WORKSPACE_DISPLAY_NAME_LENGTH,
} from '@agent-dock/shared';

/**
 * Workspace **object identity**: the answer to "is this the same directory the user confirmed?".
 *
 * Ported from upstream AgentDock's `resolveWorkspaceIdentity`/`revalidateWorkspaceIdentity`
 * (`a275b9e`, refined by `5bc0b67` which added branch resolution), keeping upstream's mechanics:
 * double resolution with a stability comparison, binding to *both* the Git worktree root and the
 * Git common directory, scrubbing every `GIT_*` variable before invoking Git, argv-only
 * `execFile` with `shell: false` and a timeout, output byte caps, control-character rejection on
 * the branch label, and the fail-closed non-reusable-incarnation idiom.
 *
 * ## D1: keyed on `dev`+`ino`, not on the canonical path string
 *
 * This is the one deliberate divergence from upstream, and it closes a real Windows fail-open.
 * Upstream derives `workspaceId` from the canonical path *string*. On Windows a single physical
 * directory has more than one canonical-looking string form: `C:\PROGRA~1\x` (an 8.3 short name)
 * and `C:\Program Files\x` name the same object, as do two paths differing only in case. Two
 * different ids for one directory means two *exclusive write leases* over the same physical bytes,
 * which is precisely the failure an exclusive lease exists to prevent. Keying on the filesystem
 * object's own identity (`dev` + `ino`, which Windows fills from the volume serial number and the
 * NTFS file index) makes those forms converge by construction rather than by string normalization
 * that has to be right on every platform.
 *
 * `incarnation` keeps the canonical path in its digest, on purpose and unchanged from upstream: it
 * answers a different question ("is this still the same directory, at the same place, created at
 * the same moment?"), and a rename genuinely *should* force the user to re-confirm even though the
 * object is the same.
 *
 * ## Why `realpath.native` everywhere
 *
 * `fs.realpath` (the JS implementation) does not expand Windows 8.3 short names, and it throws
 * `EISDIR` on a `\\?\` device path. `fs.promises.realpath.native` delegates to the OS resolver,
 * which does both correctly. Every canonicalization in this module uses `.native`; using the
 * non-native form anywhere would silently reintroduce the bug D1 exists to fix.
 */

/** Domain-separated digest prefixes. Changing one is a schema change: it invalidates every id. */
const WORKSPACE_OBJECT_PREFIX = 'workspace-object-v1';
const WORKSPACE_GIT_OBJECT_PREFIX = 'workspace-git-object-v1';
const WORKSPACE_INCARNATION_PREFIX = 'workspace-incarnation-v1';

/** Hard ceiling on any single Git invocation, in bytes and in milliseconds. */
const GIT_MAX_OUTPUT_BYTES = 64 * 1024;
const GIT_TIMEOUT_MS = 5_000;

/**
 * Thrown for a UNC (or UNC-equivalent) workspace root, before any identity resolution is attempted.
 *
 * D6. There is no Node API that can safely unify a UNC path's canonical form with a drive-letter
 * path that maps to the same share, so `\\server\share\repo` and a `Z:\repo` mapped to it would get
 * two different ids for one directory: the exact class of bug D1 exists to close, reached by a
 * different route. Rather than ship an identity that is wrong on network paths, this refuses them
 * outright with a distinct error the desktop app can show verbatim.
 */
export class UncWorkspacePathError extends Error {
  readonly code = 'unc_workspace_unsupported';

  constructor() {
    super(
      'network locations are not supported as agent workspaces. Choose a folder on a local drive: ' +
        'a UNC path (\\\\server\\share\\...) cannot be given a stable identity, so the app cannot ' +
        'guarantee that the folder you approve is the folder the agent later runs in.',
    );
    this.name = 'UncWorkspacePathError';
  }
}

/** Thrown when the requested path is not a directory, or does not exist. */
export class InvalidWorkspacePathError extends Error {
  readonly code = 'invalid_workspace_path';

  constructor(message: string) {
    super(message);
    this.name = 'InvalidWorkspacePathError';
  }
}

export interface WorkspaceGitBinding {
  /** Canonical (`realpath.native`) worktree root. */
  worktreeRoot: string;
  /** Canonical (`realpath.native`) Git common directory: the shared `.git` of a linked worktree. */
  commonDir: string;
  /** Bounded, control-character-free branch label, absent on a detached HEAD or an unreadable ref. */
  branch?: string;
}

export interface WorkspaceIdentity {
  /** sha256 hex. Stable across renames and across every spelling of the same directory. */
  workspaceId: string;
  /** sha256 hex, or 32 random bytes when the identity is not reusable. Path-sensitive. */
  incarnation: string;
  /** `realpath.native` form. **Never leaves the daemon or Electron main**: not in any view, not on disk. */
  canonicalPath: string;
  /** Bounded basename, the only human-readable string a workspace view carries. */
  displayName: string;
  /** False when the filesystem could not give a stable object identity: see `nonReusableIncarnation`. */
  reusable: boolean;
  git?: WorkspaceGitBinding;
}

/** Injection seam for tests: every filesystem and subprocess call this module makes goes through it. */
export interface WorkspaceIdentityDeps {
  realpathNative(path: string): Promise<string>;
  statBigInt(path: string): Promise<BigIntStats>;
  runGit(args: readonly string[], cwd: string): Promise<GitResult>;
}

export interface GitResult {
  ok: boolean;
  stdout: string;
}

/**
 * True for a UNC path in any of the spellings Windows accepts, plus the POSIX-looking `//server/share`
 * form Node itself will hand back on some inputs.
 *
 * Checked against **both** the raw input and its canonical form: a drive-letter path can canonicalize
 * to a UNC path (a directory symlink or junction pointing at a share does exactly that), and a check
 * on the input alone would let that through.
 */
export function isUncPath(candidate: string): boolean {
  const normalized = candidate.replace(/\//g, '\\');
  if (normalized.startsWith('\\\\?\\UNC\\') || normalized.startsWith('\\\\.\\UNC\\')) return true;
  // `\\?\C:\...` and `\\.\C:\...` are device paths for a local volume, not UNC: exclude them
  // before the generic leading-double-backslash test below, which would otherwise match them.
  if (normalized.startsWith('\\\\?\\') || normalized.startsWith('\\\\.\\')) return false;
  return normalized.startsWith('\\\\');
}

/**
 * A random 32-byte incarnation, used whenever the filesystem cannot give a stable object identity.
 *
 * This is the fail-closed idiom, and it is load-bearing rather than a fallback value. A random
 * incarnation can never equal the one recorded at grant time, so `revalidateWorkspaceIdentity`
 * always returns false for such a workspace, and `WorkspaceTrustStore.setTrusted` refuses it
 * outright. The cases this covers are real: filesystems that report `dev: 0`/`ino: 0` (some Windows
 * network redirectors, some FUSE mounts), SMB shares that renumber inodes, and any path whose two
 * consecutive stats disagree -- which is what a swap racing the resolution looks like.
 */
function nonReusableIncarnation(): string {
  return randomBytes(32).toString('hex');
}

function sha256Hex(parts: readonly string[]): string {
  const hash = createHash('sha256');
  // NUL-separated with an explicit terminator so no reordering or concatenation of components can
  // produce the same digest as a different component list.
  for (const part of parts) hash.update(part, 'utf8').update('\0', 'utf8');
  return hash.digest('hex');
}

/**
 * Bounds a directory basename for display. Never a full path, and never empty.
 *
 * The empty-basename case is real and is exactly the case where returning the input would be worst:
 * `basename('C:\\')` and `basename('/')` are both `''`, so a user who picks a drive root would
 * otherwise have the full canonical path travel to the renderer inside a field the whole design
 * promises is a bounded folder name (the renderer is never told where anything is; see
 * `workspace-grant.ts`). A drive root has no folder name to show, so it is labelled as what it is.
 */
export function toDisplayName(canonicalPath: string): string {
  const name = basename(canonicalPath).trim();
  if (name.length === 0) return '(drive root)';
  return name.slice(0, MAX_WORKSPACE_DISPLAY_NAME_LENGTH) || 'workspace';
}

/**
 * The OS resolver, promisified.
 *
 * `fs.promises.realpath` has **no** `.native` variant -- the native resolver is exposed only on the
 * callback API as `fs.realpath.native` (and synchronously as `fs.realpathSync.native`). Promisifying
 * the callback form is therefore the only way to get the native resolver with an async signature,
 * and getting the native resolver is not optional here: the JS implementation does not expand
 * Windows 8.3 short names (so `C:\PROGRA~1\x` and `C:\Program Files\x` would stay distinct strings)
 * and it throws `EISDIR` on a `\\?\` device path.
 */
const realpathNative: (path: string) => Promise<string> = promisify(realpathCallback.native);

/**
 * The real dependency set: the native realpath above, a bigint `stat` (so `dev`, `ino`, and
 * `birthtimeNs` arrive without float rounding), and an argv-only Git runner.
 */
export function defaultWorkspaceIdentityDeps(): WorkspaceIdentityDeps {
  return {
    realpathNative,
    statBigInt: (path) => fs.stat(path, { bigint: true }),
    runGit,
  };
}

/**
 * Environment for a Git invocation, with **every** `GIT_*` variable removed.
 *
 * Not a denylist of the dangerous ones: the set of Git variables that can redirect a command
 * (`GIT_DIR`, `GIT_WORK_TREE`, `GIT_COMMON_DIR`, `GIT_CONFIG`, `GIT_CONFIG_GLOBAL`, `GIT_ALTERNATE_*`,
 * `GIT_EXTERNAL_DIFF`, `GIT_SSH_COMMAND`, ...) is long and grows between Git releases, so the only
 * durable rule is to drop the whole namespace. `GIT_TERMINAL_PROMPT=0` is then added back so a repo
 * needing credentials fails fast instead of blocking on a prompt until the timeout.
 */
export function gitSafeEnv(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(source)) {
    if (key.toUpperCase().startsWith('GIT_')) continue;
    env[key] = value;
  }
  env.GIT_TERMINAL_PROMPT = '0';
  return env;
}

/**
 * Runs one Git command. `shell: false` (execFile's default) with an argv array, never a command
 * string: a workspace path is attacker-influenceable in the sense that matters here (a directory
 * named `x & calc` is trivial to create), and a shell would interpret it.
 *
 * Never throws: a missing Git, a non-repository, a timeout, and a non-zero exit all resolve to
 * `{ ok: false }`. Callers decide what a failure means, and for `isWorkspaceDirty` it deliberately
 * means "dirty".
 */
export function runGit(args: readonly string[], cwd: string): Promise<GitResult> {
  return new Promise((resolve) => {
    execFile(
      'git',
      [...args],
      {
        cwd,
        env: gitSafeEnv(),
        timeout: GIT_TIMEOUT_MS,
        maxBuffer: GIT_MAX_OUTPUT_BYTES,
        windowsHide: true,
        encoding: 'utf8',
      },
      (error, stdout) => {
        if (error) {
          resolve({ ok: false, stdout: '' });
          return;
        }
        resolve({ ok: true, stdout: typeof stdout === 'string' ? stdout : '' });
      },
    );
  });
}

/** Rejects a branch label carrying a control character, and bounds its length. */
export function sanitizeBranchLabel(raw: string): string | undefined {
  const value = raw.trim();
  if (value.length === 0 || value.length > MAX_WORKSPACE_BRANCH_LENGTH) return undefined;
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(value)) return undefined;
  if (value === 'HEAD') return undefined; // detached HEAD: not a branch, and not worth showing as one
  return value;
}

/**
 * Resolves the current branch, added upstream by `5bc0b67`. Purely presentational: it appears in the
 * confirmation dialog so a user can tell `main` from a release branch before granting access, and it
 * is deliberately **not** part of any digest -- a branch switch must not invalidate a grant, because
 * a branch is not a different directory.
 */
export async function resolveGitBranch(worktreeRoot: string, deps: WorkspaceIdentityDeps): Promise<string | undefined> {
  const result = await deps.runGit(['rev-parse', '--abbrev-ref', 'HEAD'], worktreeRoot);
  if (!result.ok) return undefined;
  return sanitizeBranchLabel(result.stdout);
}

interface ObjectKey {
  dev: string;
  ino: string;
  birthtimeNs: string;
  stable: boolean;
}

/**
 * Stats a path twice and reports whether the two agree.
 *
 * The second stat is not paranoia about the first being wrong: it is the window check. Everything
 * between the two calls is a moment in which the directory could be replaced (a symlink retargeted,
 * a junction swapped, the directory deleted and recreated). Two agreeing stats do not prove nothing
 * happened, but two *disagreeing* ones prove something did, and that is enough to fail closed.
 *
 * A `dev` or `ino` of zero is treated as unstable regardless of agreement: those are the values a
 * filesystem reports when it has no object identity to offer, and two zeros agreeing says nothing.
 */
async function objectKey(path: string, deps: WorkspaceIdentityDeps): Promise<ObjectKey> {
  const first = await deps.statBigInt(path);
  const second = await deps.statBigInt(path);

  const dev = first.dev.toString();
  const ino = first.ino.toString();
  const birthtimeNs = first.birthtimeNs.toString();

  const agrees =
    first.dev === second.dev && first.ino === second.ino && first.birthtimeNs === second.birthtimeNs;
  const identified = first.dev !== 0n && first.ino !== 0n;

  return { dev, ino, birthtimeNs, stable: agrees && identified };
}

/**
 * Binds the workspace to its Git worktree root **and** its Git common directory, when both resolve.
 *
 * Binding both is what defeats the "swap the `.git` common dir" attack. A linked worktree's
 * `.git` is a file pointing at a shared common directory elsewhere; an attacker who can replace
 * that pointer redirects every hook, config, and alternate object store the CLI will read, while the
 * worktree root itself is untouched. An id derived from the worktree alone would not notice. Both
 * directories are canonicalized with `realpath.native` and reduced to their own `dev`/`ino`, so the
 * binding is to the objects, not to the strings naming them.
 */
async function resolveGitBinding(
  canonicalPath: string,
  deps: WorkspaceIdentityDeps,
): Promise<{ binding: WorkspaceGitBinding; worktreeKey: ObjectKey; commonKey: ObjectKey } | undefined> {
  const result = await deps.runGit(
    ['rev-parse', '--path-format=absolute', '--show-toplevel', '--git-common-dir'],
    canonicalPath,
  );
  if (!result.ok) return undefined;

  const lines = result.stdout
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  const [rawWorktree, rawCommon] = lines;
  if (!rawWorktree || !rawCommon) return undefined;

  try {
    const worktreeRoot = await deps.realpathNative(rawWorktree);
    const commonDir = await deps.realpathNative(rawCommon);
    // A Git-reported path that canonicalizes onto a share is the same D6 hazard as the requested
    // path being one, and it arrives through a channel the boundary check never saw.
    if (isUncPath(worktreeRoot) || isUncPath(commonDir)) throw new UncWorkspacePathError();

    const worktreeKey = await objectKey(worktreeRoot, deps);
    const commonKey = await objectKey(commonDir, deps);
    const branch = await resolveGitBranch(worktreeRoot, deps);

    return {
      binding: { worktreeRoot, commonDir, ...(branch === undefined ? {} : { branch }) },
      worktreeKey,
      commonKey,
    };
  } catch (err) {
    if (err instanceof UncWorkspacePathError) throw err;
    // Anything else (the worktree vanished mid-resolution, a permission error on the common dir)
    // means Git's answer cannot be bound to real objects, so there is no Git binding to make. The
    // workspace still gets a plain object identity below.
    return undefined;
  }
}

export interface ResolveWorkspaceIdentityOptions {
  deps?: WorkspaceIdentityDeps;
}

/**
 * Resolves the full identity of a workspace root.
 *
 * Order matters and is fixed:
 *
 * 1. reject UNC on the raw input, before touching the filesystem at all;
 * 2. canonicalize with `realpath.native`, then reject UNC again on the result (a junction or
 *    symlink pointing at a share is only visible here);
 * 3. confirm it is a directory;
 * 4. take the object key twice and compare (see `objectKey`);
 * 5. resolve the Git binding, if any, and take object keys for both Git directories too;
 * 6. derive `workspaceId` from the object keys and `incarnation` from those plus the canonical path.
 *
 * If any object key is unstable, the whole identity is marked non-reusable and gets a random
 * `workspaceId` **and** `incarnation`. Randomizing both, rather than only the incarnation, is a
 * deliberate hardening over upstream: on a filesystem reporting `dev: 0`/`ino: 0` for everything, a
 * derived id would be *identical for every directory on that mount*, silently merging their trust
 * and lease state. A random id can never be matched, trusted, or shared, which is the correct
 * outcome for an identity the filesystem refused to provide.
 */
export async function resolveWorkspaceIdentity(
  requestedPath: string,
  options: ResolveWorkspaceIdentityOptions = {},
): Promise<WorkspaceIdentity> {
  const deps = options.deps ?? defaultWorkspaceIdentityDeps();

  if (isUncPath(requestedPath)) throw new UncWorkspacePathError();

  let canonicalPath: string;
  try {
    canonicalPath = await deps.realpathNative(requestedPath);
  } catch (err) {
    throw new InvalidWorkspacePathError(
      `could not resolve the workspace directory: ${(err as NodeJS.ErrnoException).code ?? 'unknown error'}`,
    );
  }
  if (isUncPath(canonicalPath)) throw new UncWorkspacePathError();

  const stats = await deps.statBigInt(canonicalPath).catch((err: unknown) => {
    throw new InvalidWorkspacePathError(
      `could not read the workspace directory: ${(err as NodeJS.ErrnoException).code ?? 'unknown error'}`,
    );
  });
  if (!stats.isDirectory()) {
    throw new InvalidWorkspacePathError('the workspace path is not a directory');
  }

  const selfKey = await objectKey(canonicalPath, deps);
  const git = await resolveGitBinding(canonicalPath, deps);

  const stable = selfKey.stable && (!git || (git.worktreeKey.stable && git.commonKey.stable));

  if (!stable) {
    return {
      workspaceId: nonReusableIncarnation(),
      incarnation: nonReusableIncarnation(),
      canonicalPath,
      displayName: toDisplayName(canonicalPath),
      reusable: false,
      ...(git ? { git: git.binding } : {}),
    };
  }

  const workspaceId = git
    ? sha256Hex([
        WORKSPACE_GIT_OBJECT_PREFIX,
        git.worktreeKey.dev,
        git.worktreeKey.ino,
        git.commonKey.dev,
        git.commonKey.ino,
      ])
    : sha256Hex([WORKSPACE_OBJECT_PREFIX, selfKey.dev, selfKey.ino]);

  const incarnation = sha256Hex([
    WORKSPACE_INCARNATION_PREFIX,
    selfKey.dev,
    selfKey.ino,
    selfKey.birthtimeNs,
    canonicalPath,
    git ? git.worktreeKey.dev : '',
    git ? git.worktreeKey.ino : '',
    git ? git.commonKey.dev : '',
    git ? git.commonKey.ino : '',
  ]);

  return {
    workspaceId,
    incarnation,
    canonicalPath,
    displayName: toDisplayName(canonicalPath),
    reusable: true,
    ...(git ? { git: git.binding } : {}),
  };
}

export interface ExpectedWorkspaceIdentity {
  workspaceId: string;
  incarnation: string;
}

/**
 * Re-resolves the identity of `requestedPath` and reports whether it still matches `expected`.
 *
 * Both fields must match. `workspaceId` alone would accept a different directory that happens to
 * share a Git repository, and `incarnation` alone would accept an object whose id changed but whose
 * path, birth time, `dev`, and `ino` somehow did not. Never throws: a vanished directory, a UNC path
 * that only became one after a junction swap, and an unreadable Git common directory are all simply
 * "no longer the same workspace", and a caller in the middle of an admission decision must get
 * `false` rather than an exception it might log and continue past.
 */
export async function revalidateWorkspaceIdentity(
  requestedPath: string,
  expected: ExpectedWorkspaceIdentity,
  options: ResolveWorkspaceIdentityOptions = {},
): Promise<boolean> {
  try {
    const identity = await resolveWorkspaceIdentity(requestedPath, options);
    if (!identity.reusable) return false;
    return identity.workspaceId === expected.workspaceId && identity.incarnation === expected.incarnation;
  } catch {
    return false;
  }
}
