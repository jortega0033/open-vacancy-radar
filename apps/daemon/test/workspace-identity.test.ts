import { execFileSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
  type BigIntStats,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  InvalidWorkspacePathError,
  UncWorkspacePathError,
  gitSafeEnv,
  isUncPath,
  resolveWorkspaceIdentity,
  revalidateWorkspaceIdentity,
  sanitizeBranchLabel,
  toDisplayName,
  type GitResult,
  type WorkspaceIdentityDeps,
} from '../src/workspace-identity.js';

const isWindows = process.platform === 'win32';

// Several tests here shell out for real: `git rev-parse`/`git status` on every identity resolution,
// and a PowerShell COM call to obtain an 8.3 short name. Each is fast on its own (a few hundred
// milliseconds) but process startup is exactly what slows down when the whole suite runs in
// parallel on a loaded machine, and vitest's 5s default is close enough to that to flake. Raising
// the ceiling does not hide a correctness regression: a genuinely broken resolution still fails,
// just later.
vi.setConfig({ testTimeout: 30_000 });

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'agent-dock-workspace-identity-'));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function makeDir(name: string): string {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * Whether this machine can create the link type a test needs.
 *
 * On Windows, a plain `symlinkSync` requires either Developer Mode or elevation, while a
 * `'junction'` needs neither. Rather than skip the whole symlink-swap class of tests on an
 * unprivileged Windows checkout, the junction variant covers the same attack there.
 */
function canSymlink(): boolean {
  const probeTarget = makeDir('symlink-probe-target');
  const probeLink = join(root, 'symlink-probe-link');
  try {
    symlinkSync(probeTarget, probeLink, 'dir');
    rmSync(probeLink, { force: true });
    return true;
  } catch {
    return false;
  }
}

describe('UNC rejection at the boundary (D6)', () => {
  it('recognizes every UNC spelling, and does not mistake a device path for one', () => {
    expect(isUncPath('\\\\server\\share\\repo')).toBe(true);
    expect(isUncPath('\\\\localhost\\c$\\repo')).toBe(true);
    expect(isUncPath('\\\\?\\UNC\\server\\share')).toBe(true);
    expect(isUncPath('//server/share/repo')).toBe(true);

    // `\\?\C:\...` is a long-path device form of a LOCAL path. Treating it as UNC would refuse
    // perfectly ordinary deep directories.
    expect(isUncPath('\\\\?\\C:\\Users\\someone\\repo')).toBe(false);
    expect(isUncPath('C:\\Users\\someone\\repo')).toBe(false);
    expect(isUncPath('/home/someone/repo')).toBe(false);
  });

  it('rejects a UNC workspace root with its own distinct error, before touching the filesystem', async () => {
    await expect(resolveWorkspaceIdentity('\\\\server\\share\\repo')).rejects.toBeInstanceOf(
      UncWorkspacePathError,
    );
    // The message has to be actionable on its own: it is shown verbatim in the desktop app.
    await expect(resolveWorkspaceIdentity('\\\\server\\share\\repo')).rejects.toThrow(/local drive/i);
  });

  it('rejects a path that only becomes UNC after canonicalization', async () => {
    const deps = stubDeps({
      realpathNative: async () => '\\\\server\\share\\repo',
    });
    await expect(resolveWorkspaceIdentity(join(root, 'looks-local'), { deps })).rejects.toBeInstanceOf(
      UncWorkspacePathError,
    );
  });

  it('gives the UNC error a distinct code, so the desktop app can tell it from a bad path', async () => {
    const uncError = await resolveWorkspaceIdentity('\\\\server\\share').catch((err: unknown) => err);
    const missingError = await resolveWorkspaceIdentity(join(root, 'does-not-exist')).catch(
      (err: unknown) => err,
    );
    expect((uncError as UncWorkspacePathError).code).toBe('unc_workspace_unsupported');
    expect(missingError).toBeInstanceOf(InvalidWorkspacePathError);
    expect((missingError as InvalidWorkspacePathError).code).toBe('invalid_workspace_path');
  });
});

describe('object identity (D1)', () => {
  it('gives one directory one id, and two directories two ids', async () => {
    const a = makeDir('alpha');
    const b = makeDir('beta');

    const first = await resolveWorkspaceIdentity(a);
    const again = await resolveWorkspaceIdentity(a);
    const other = await resolveWorkspaceIdentity(b);

    expect(first.workspaceId).toBe(again.workspaceId);
    expect(first.incarnation).toBe(again.incarnation);
    expect(first.workspaceId).not.toBe(other.workspaceId);
    expect(first.workspaceId).toMatch(/^[0-9a-f]{64}$/);
  });

  it('never exposes the path in the id, and bounds the display name to a basename', async () => {
    const dir = makeDir('my-secret-project');
    const identity = await resolveWorkspaceIdentity(dir);
    expect(identity.workspaceId).not.toContain('my-secret-project');
    expect(identity.incarnation).not.toContain('my-secret-project');
    expect(identity.displayName).toBe('my-secret-project');
    expect(toDisplayName(join('a', 'b', 'c'))).toBe('c');
  });

  it.runIf(isWindows)(
    'gives C:\\Repo and c:\\repo the SAME workspaceId: the regression D1 exists to prevent',
    async () => {
      const dir = makeDir('CaseSensitivity');
      const swappedCase =
        dir.slice(0, 1).toLowerCase() === dir.slice(0, 1)
          ? dir.slice(0, 1).toUpperCase() + dir.slice(1)
          : dir.slice(0, 1).toLowerCase() + dir.slice(1);

      const canonical = await resolveWorkspaceIdentity(dir);
      const alternate = await resolveWorkspaceIdentity(swappedCase);

      expect(alternate.workspaceId).toBe(canonical.workspaceId);
      // And the incarnation matches too, because `realpath.native` normalizes the drive letter,
      // so the path component of the incarnation digest is the same string in both cases.
      expect(alternate.incarnation).toBe(canonical.incarnation);
    },
  );

  it.runIf(isWindows)(
    'gives an 8.3 short-name path the SAME workspaceId as its long form (the proven fail-open D1 closes)',
    async () => {
      // A name longer than eight characters with a space is what makes the filesystem mint an 8.3
      // alias, when 8.3 generation is enabled on the volume at all.
      const longName = 'Program Files Like Name';
      const dir = makeDir(longName);
      const shortPath = shortNameFor(dir);

      if (!shortPath) {
        // Documented rather than silently skipped: some volumes (and most CI images) have 8.3 name
        // generation disabled, so there is no short form to resolve. The unit test below covers the
        // same property against stubbed stat results, which is where the logic actually lives.
        expect(shortPath).toBeUndefined();
        return;
      }

      expect(shortPath).not.toBe(dir);
      const canonical = await resolveWorkspaceIdentity(dir);
      const viaShortName = await resolveWorkspaceIdentity(shortPath);
      expect(viaShortName.workspaceId).toBe(canonical.workspaceId);
      expect(viaShortName.incarnation).toBe(canonical.incarnation);
    },
  );

  it('derives the same id from two different path strings that stat to the same object', async () => {
    // The platform-independent form of the 8.3 regression: two spellings, one object. If the id were
    // derived from the canonical *string* (as upstream does), these would differ and the same
    // directory would be handed two exclusive write leases.
    const dir = makeDir('one-object');
    const stats = await import('node:fs').then((fs) => fs.promises.stat(dir, { bigint: true }));

    const viaLongName = await resolveWorkspaceIdentity('/spelling/one', {
      deps: stubDeps({
        realpathNative: async () => '/canonical/one-object',
        statBigInt: async () => stats,
      }),
    });
    const viaShortName = await resolveWorkspaceIdentity('/SPELL~1/one', {
      deps: stubDeps({
        realpathNative: async () => '/canonical/one-object',
        statBigInt: async () => stats,
      }),
    });

    expect(viaShortName.workspaceId).toBe(viaLongName.workspaceId);
  });

  it('changes the incarnation but not the workspaceId when a directory is renamed', async () => {
    const dir = makeDir('before-rename');
    const before = await resolveWorkspaceIdentity(dir);

    const moved = join(root, 'after-rename');
    renameSync(dir, moved);
    const after = await resolveWorkspaceIdentity(moved);

    // Same object: the write lease must still be exclusive across the rename.
    expect(after.workspaceId).toBe(before.workspaceId);
    // Different place: the user approved a folder at a path, so a rename needs re-confirmation.
    expect(after.incarnation).not.toBe(before.incarnation);
    expect(await revalidateWorkspaceIdentity(moved, before)).toBe(false);
  });

  it('refuses a file, and a path that does not exist', async () => {
    const file = join(root, 'not-a-directory.txt');
    writeFileSync(file, 'hello');
    await expect(resolveWorkspaceIdentity(file)).rejects.toBeInstanceOf(InvalidWorkspacePathError);
    await expect(resolveWorkspaceIdentity(join(root, 'nope'))).rejects.toBeInstanceOf(
      InvalidWorkspacePathError,
    );
  });
});

describe('revalidation against a swapped directory', () => {
  it('denies after a symlink is retargeted between issue and consume', async () => {
    if (!canSymlink()) {
      // Covered by the junction test below on this platform.
      expect(isWindows).toBe(true);
      return;
    }
    const real = makeDir('real-workspace');
    const decoy = makeDir('decoy-workspace');
    const link = join(root, 'workspace-link');
    symlinkSync(real, link, 'dir');

    const granted = await resolveWorkspaceIdentity(link);
    expect(await revalidateWorkspaceIdentity(link, granted)).toBe(true);

    rmSync(link, { force: true, recursive: false });
    symlinkSync(decoy, link, 'dir');

    expect(await revalidateWorkspaceIdentity(link, granted)).toBe(false);
  });

  it.runIf(isWindows)('denies after an NTFS junction is swapped', async () => {
    const real = makeDir('junction-real');
    const decoy = makeDir('junction-decoy');
    const link = join(root, 'junction-link');
    symlinkSync(real, link, 'junction');

    const granted = await resolveWorkspaceIdentity(link);
    expect(await revalidateWorkspaceIdentity(link, granted)).toBe(true);

    rmSync(link, { recursive: true, force: true });
    symlinkSync(decoy, link, 'junction');

    expect(await revalidateWorkspaceIdentity(link, granted)).toBe(false);
  });

  it('denies when the directory is deleted and a new one is created with the same name', async () => {
    const dir = makeDir('replaced');
    const granted = await resolveWorkspaceIdentity(dir);

    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });

    // A fresh directory: different inode (POSIX) or different NTFS file index and birth time.
    expect(await revalidateWorkspaceIdentity(dir, granted)).toBe(false);
  });

  it('denies when the directory has been removed entirely, rather than throwing at the caller', async () => {
    const dir = makeDir('vanishing');
    const granted = await resolveWorkspaceIdentity(dir);
    rmSync(dir, { recursive: true, force: true });
    await expect(revalidateWorkspaceIdentity(dir, granted)).resolves.toBe(false);
  });

  it('denies when only one half of the expected pair matches', async () => {
    const dir = makeDir('half-match');
    const granted = await resolveWorkspaceIdentity(dir);

    await expect(
      revalidateWorkspaceIdentity(dir, { ...granted, incarnation: 'f'.repeat(64) }),
    ).resolves.toBe(false);
    await expect(
      revalidateWorkspaceIdentity(dir, { ...granted, workspaceId: 'f'.repeat(64) }),
    ).resolves.toBe(false);
  });
});

describe('Git binding: worktree AND common directory', () => {
  const gitDeps = (worktree: string, commonDir: string, statFor: Map<string, BigIntStats>) =>
    stubDeps({
      realpathNative: async (path: string) => path,
      statBigInt: async (path: string) => {
        const stats = statFor.get(path);
        if (!stats) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
        return stats;
      },
      runGit: async (args: readonly string[]): Promise<GitResult> => {
        if (args[0] === 'rev-parse' && args.includes('--show-toplevel')) {
          return { ok: true, stdout: `${worktree}\n${commonDir}\n` };
        }
        if (args[0] === 'rev-parse') return { ok: true, stdout: 'main\n' };
        return { ok: false, stdout: '' };
      },
    });

  /** Distinct fake stat results, so a changed component is visible in the digest. */
  function fakeStats(dev: bigint, ino: bigint, birthtimeNs = 1_000n): BigIntStats {
    return {
      dev,
      ino,
      birthtimeNs,
      isDirectory: () => true,
    } as unknown as BigIntStats;
  }

  it('binds a Git workspace to both directories, so replacing the common dir changes the id', async () => {
    const worktree = '/repo';
    const commonDir = '/repo/.git';

    const original = new Map([
      [worktree, fakeStats(1n, 10n)],
      [commonDir, fakeStats(1n, 20n)],
    ]);
    const swappedCommonDir = new Map([
      [worktree, fakeStats(1n, 10n)],
      // Same worktree object, DIFFERENT common directory: the "swap the .git common dir" attack.
      // An id derived from the worktree alone would not notice this at all.
      [commonDir, fakeStats(1n, 999n)],
    ]);

    const granted = await resolveWorkspaceIdentity(worktree, {
      deps: gitDeps(worktree, commonDir, original),
    });
    const afterSwap = await resolveWorkspaceIdentity(worktree, {
      deps: gitDeps(worktree, commonDir, swappedCommonDir),
    });

    expect(granted.workspaceId).not.toBe(afterSwap.workspaceId);
    expect(
      await revalidateWorkspaceIdentity(worktree, granted, {
        deps: gitDeps(worktree, commonDir, swappedCommonDir),
      }),
    ).toBe(false);
  });

  it('changes the id when the worktree object changes but the common dir does not', async () => {
    const worktree = '/repo';
    const commonDir = '/repo/.git';
    const before = new Map([
      [worktree, fakeStats(1n, 10n)],
      [commonDir, fakeStats(1n, 20n)],
    ]);
    const after = new Map([
      [worktree, fakeStats(1n, 11n)],
      [commonDir, fakeStats(1n, 20n)],
    ]);

    const a = await resolveWorkspaceIdentity(worktree, { deps: gitDeps(worktree, commonDir, before) });
    const b = await resolveWorkspaceIdentity(worktree, { deps: gitDeps(worktree, commonDir, after) });
    expect(a.workspaceId).not.toBe(b.workspaceId);
  });

  it('keeps the branch out of every digest: switching branches must not invalidate a grant', async () => {
    const worktree = '/repo';
    const commonDir = '/repo/.git';
    const statFor = new Map([
      [worktree, fakeStats(1n, 10n)],
      [commonDir, fakeStats(1n, 20n)],
    ]);
    const withBranch = (branch: string) =>
      stubDeps({
        realpathNative: async (path: string) => path,
        statBigInt: async (path: string) => statFor.get(path) as BigIntStats,
        runGit: async (args: readonly string[]) =>
          args.includes('--show-toplevel')
            ? { ok: true, stdout: `${worktree}\n${commonDir}\n` }
            : { ok: true, stdout: `${branch}\n` },
      });

    const onMain = await resolveWorkspaceIdentity(worktree, { deps: withBranch('main') });
    const onFeature = await resolveWorkspaceIdentity(worktree, { deps: withBranch('feature/x') });

    expect(onMain.git?.branch).toBe('main');
    expect(onFeature.git?.branch).toBe('feature/x');
    expect(onFeature.workspaceId).toBe(onMain.workspaceId);
    expect(onFeature.incarnation).toBe(onMain.incarnation);
  });

  it('falls back to a plain object identity when Git is unavailable or the directory is not a repo', async () => {
    const dir = makeDir('not-a-repo');
    const identity = await resolveWorkspaceIdentity(dir, {
      deps: stubDeps({ runGit: async () => ({ ok: false, stdout: '' }) }),
    });
    expect(identity.git).toBeUndefined();
    expect(identity.reusable).toBe(true);
    expect(identity.workspaceId).toMatch(/^[0-9a-f]{64}$/);
  });

  it('refuses a Git common directory that resolves onto a network share', async () => {
    await expect(
      resolveWorkspaceIdentity('/repo', {
        deps: stubDeps({
          realpathNative: async (path: string) =>
            path === '/repo/.git' ? '\\\\server\\share\\repo.git' : path,
          statBigInt: async () =>
            ({ dev: 1n, ino: 2n, birthtimeNs: 3n, isDirectory: () => true }) as unknown as BigIntStats,
          runGit: async (args: readonly string[]) =>
            args.includes('--show-toplevel')
              ? { ok: true, stdout: '/repo\n/repo/.git\n' }
              : { ok: false, stdout: '' },
        }),
      }),
    ).rejects.toBeInstanceOf(UncWorkspacePathError);
  });
});

describe('the fail-closed non-reusable incarnation', () => {
  function unstableDeps(overrides: Partial<WorkspaceIdentityDeps> = {}): WorkspaceIdentityDeps {
    return stubDeps({
      realpathNative: async (path: string) => path,
      statBigInt: async () =>
        ({ dev: 0n, ino: 0n, birthtimeNs: 5n, isDirectory: () => true }) as unknown as BigIntStats,
      runGit: async () => ({ ok: false, stdout: '' }),
      ...overrides,
    });
  }

  it('marks a workspace non-reusable when the filesystem reports no object identity', async () => {
    const identity = await resolveWorkspaceIdentity('/mnt/share', { deps: unstableDeps() });
    expect(identity.reusable).toBe(false);
  });

  it('never revalidates a non-reusable identity, not even against itself', async () => {
    const identity = await resolveWorkspaceIdentity('/mnt/share', { deps: unstableDeps() });
    await expect(
      revalidateWorkspaceIdentity('/mnt/share', identity, { deps: unstableDeps() }),
    ).resolves.toBe(false);
  });

  it('gives every resolution of a non-reusable workspace a fresh id, so two of them never collide', async () => {
    // Two DIFFERENT directories on a filesystem reporting dev:0/ino:0 must not share an id: a
    // derived id would be identical for both and would silently merge their trust and lease state.
    const first = await resolveWorkspaceIdentity('/mnt/share/a', { deps: unstableDeps() });
    const second = await resolveWorkspaceIdentity('/mnt/share/b', { deps: unstableDeps() });
    expect(first.workspaceId).not.toBe(second.workspaceId);
    expect(first.incarnation).not.toBe(second.incarnation);
    expect(first.workspaceId).toMatch(/^[0-9a-f]{64}$/);
  });

  it('marks a workspace non-reusable when two consecutive stats disagree (a swap racing resolution)', async () => {
    let call = 0;
    const identity = await resolveWorkspaceIdentity('/racing', {
      deps: unstableDeps({
        // Call 1 is the is-a-directory check; calls 2 and 3 are the two comparison stats, and it is
        // those two that must disagree for the stability check to fire.
        statBigInt: async () => {
          call += 1;
          return {
            dev: 1n,
            ino: call < 3 ? 10n : 11n,
            birthtimeNs: 3n,
            isDirectory: () => true,
          } as unknown as BigIntStats;
        },
      }),
    });
    expect(identity.reusable).toBe(false);
  });
});

describe('Git invocation hardening', () => {
  it('scrubs every GIT_* variable, not a denylist of the dangerous ones', () => {
    const env = gitSafeEnv({
      PATH: '/usr/bin',
      GIT_DIR: '/evil/.git',
      GIT_COMMON_DIR: '/evil/common',
      GIT_CONFIG_GLOBAL: '/evil/config',
      GIT_SSH_COMMAND: 'curl evil.example',
      git_lowercase_variant: '/evil',
      HOME: '/home/someone',
    });
    expect(env.PATH).toBe('/usr/bin');
    expect(env.HOME).toBe('/home/someone');
    for (const key of Object.keys(env)) {
      if (key === 'GIT_TERMINAL_PROMPT') continue;
      expect(key.toUpperCase().startsWith('GIT_')).toBe(false);
    }
    // Added back deliberately: a repo needing credentials must fail fast, not block on a prompt.
    expect(env.GIT_TERMINAL_PROMPT).toBe('0');
  });

  it('rejects a branch label carrying control characters, and bounds its length', () => {
    expect(sanitizeBranchLabel('main')).toBe('main');
    expect(sanitizeBranchLabel('  feature/x  ')).toBe('feature/x');
    expect(sanitizeBranchLabel('main\r\nAllow access')).toBeUndefined();
    expect(sanitizeBranchLabel('main\u001b[2J')).toBeUndefined();
    expect(sanitizeBranchLabel('x'.repeat(300))).toBeUndefined();
    expect(sanitizeBranchLabel('')).toBeUndefined();
    // A detached HEAD is not a branch, and labelling it one in a dialog would be misleading.
    expect(sanitizeBranchLabel('HEAD')).toBeUndefined();
  });
});

describe('Windows device paths', () => {
  it.runIf(isWindows)('resolves a \\\\?\\ device path without throwing EISDIR', async () => {
    // The whole reason this module uses `realpath.native`: the JS `fs.realpath` implementation
    // throws EISDIR on this form, so a user with a long path would hit an unexplainable failure.
    const dir = makeDir('device-path');
    const identity = await resolveWorkspaceIdentity(`\\\\?\\${dir}`);
    const direct = await resolveWorkspaceIdentity(dir);
    expect(identity.workspaceId).toBe(direct.workspaceId);
  });
});

/** Builds a dep set with real defaults for anything a test does not care about. */
function stubDeps(overrides: Partial<WorkspaceIdentityDeps>): WorkspaceIdentityDeps {
  return {
    realpathNative: async (path: string) => path,
    statBigInt: async () =>
      ({ dev: 1n, ino: 2n, birthtimeNs: 3n, isDirectory: () => true }) as unknown as BigIntStats,
    runGit: async () => ({ ok: false, stdout: '' }),
    ...overrides,
  };
}

/**
 * The 8.3 short form of a directory, or `undefined` when the volume does not generate them.
 *
 * Asks the Windows scripting host's `FileSystemObject.ShortPath`, which is the only way to get a
 * short name from Node without a native module. The path is fed over **stdin** rather than as an
 * argument: a directory name containing a space (which is exactly what forces an 8.3 alias into
 * existence) is otherwise re-tokenized by PowerShell's parser.
 *
 * A volume with 8.3 generation disabled (common on modern installs and on most CI images) has no
 * short form to return, so this reports `undefined` and the caller documents the gap instead of
 * asserting against a value that does not exist.
 */
function shortNameFor(path: string): string | undefined {
  if (!isWindows) return undefined;
  try {
    const out = execFileSync(
      'powershell',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        '$p = [Console]::In.ReadLine(); (New-Object -ComObject Scripting.FileSystemObject).GetFolder($p).ShortPath',
      ],
      { encoding: 'utf8', windowsHide: true, timeout: 20_000, input: `${path}\n` },
    ).trim();
    if (!out || out.toLowerCase() === path.toLowerCase()) return undefined;
    return out;
  } catch {
    return undefined;
  }
}
