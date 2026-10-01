import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import {
  filterWindowsJobHostStderr,
  spawnProcess,
  terminateProcessTree,
  type ProcessExitResult,
  type SpawnedProcess,
} from '../src/process/spawn-process.js';

const ORPHAN_FIXTURE = fileURLToPath(new URL('./fixtures/fake-orphaning-leader.mjs', import.meta.url));
const JOB_HOST = fileURLToPath(
  new URL('../../../apps/daemon/dist/agent-dock-job-host.exe', import.meta.url),
);

const isWindows = process.platform === 'win32';

async function waitUntil(predicate: () => boolean | Promise<boolean>, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (!(await predicate())) {
    if (Date.now() >= deadline) throw new Error('condition timed out');
    await new Promise<void>((resolve) => setTimeout(resolve, 25));
  }
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // Only ESRCH proves absence; EPERM means it exists but is not ours to signal.
    return (error as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function collect(stream: NodeJS.ReadableStream): Promise<string> {
  let output = '';
  stream.on('data', (chunk: Buffer | string) => {
    output += chunk.toString();
  });
  await new Promise<void>((resolve) => stream.once('end', resolve));
  return output;
}

/** Best-effort teardown so a failing assertion cannot leave a heartbeating process behind. */
function forceKill(pid: number | undefined): void {
  if (pid === undefined || !alive(pid)) return;
  try {
    if (isWindows) spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore' });
    else process.kill(pid, 'SIGKILL');
  } catch {
    // Already gone between the check and the kill.
  }
}

describe('spawnProcess process-tree lifecycle', () => {
  it.skipIf(isWindows)(
    'POSIX: kills descendants after the leader has already exited, with no polling needed to see it',
    async () => {
      const childScript = 'setInterval(() => {}, 1000);';
      const leaderScript = [
        "const { spawn } = require('node:child_process');",
        `const child = spawn(process.execPath, ['-e', ${JSON.stringify(childScript)}], { stdio: 'ignore' });`,
        'process.stdout.write(String(child.pid));',
        'setImmediate(() => process.exit(0));',
      ].join('');
      const tree = spawnProcess(process.execPath, ['-e', leaderScript], { cwd: process.cwd() });
      let descendantPid: number | undefined;
      tree.child.stdout.on('data', (chunk) => {
        descendantPid = Number(String(chunk));
      });

      try {
        await waitUntil(() => descendantPid !== undefined);
        await tree.exit;
        // The leader is already gone and the grandchild is still running: this is the scenario a
        // lineage-walking kill cannot handle.
        expect(alive(descendantPid!)).toBe(true);

        await tree.kill();

        // Asserted immediately with no waitUntil: the promise resolving *is* the guarantee. If
        // this needed polling to pass, the contract would be "signalled", not "reaped".
        expect(alive(descendantPid!)).toBe(false);
      } finally {
        forceKill(descendantPid);
      }
    },
    20_000,
  );

  it.skipIf(!isWindows)(
    'Windows: reaps a leader-to-intermediate-to-orphan chain the PID lineage can no longer reach',
    async () => {
      const temp = await mkdtemp(join(tmpdir(), 'ovr job orphan '));
      const marker = join(temp, 'marker.txt');
      const pidFile = join(temp, 'orphan.pid');
      const tree = spawnProcess(process.execPath, [ORPHAN_FIXTURE, marker, pidFile], {
        cwd: temp,
        windowsJobHostPath: JOB_HOST,
      });
      let orphanPid: number | undefined;

      try {
        await waitUntil(async () => (await exists(marker)) && (await exists(pidFile)));
        orphanPid = Number(await readFile(pidFile, 'utf8'));
        expect(alive(orphanPid)).toBe(true);

        await tree.kill();

        // Two independent assertions, because either alone can produce a false positive.
        // PID death alone could be a PID-reuse artifact...
        expect(alive(orphanPid)).toBe(false);

        // ...so also prove the heartbeat actually stopped. The fixture rewrites the marker every
        // ~50ms, so a still-running writer would advance mtime well within this window.
        const mtimeAfterReap = (await stat(marker)).mtimeMs;
        await new Promise<void>((resolve) => setTimeout(resolve, 500));
        expect((await stat(marker)).mtimeMs).toBe(mtimeAfterReap);
      } finally {
        forceKill(orphanPid);
        await tree.kill().catch(() => undefined);
        await rm(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
      }
    },
    30_000,
  );

  /**
   * The negative control, and the reason the test above is meaningful.
   *
   * It runs the *same* orphan fixture through a plain `child_process.spawn` plus
   * `taskkill /T /F` — the mechanism this repo used before ADI-04 — and asserts the orphan
   * SURVIVES. Without this, the Job Host test could be passing for a trivial reason (the fixture
   * exiting on its own, the chain never actually orphaning anything on this Windows build) and
   * nobody would know. This pins that the gap being fixed is real on this machine.
   */
  it.skipIf(!isWindows)(
    'Windows negative control: taskkill /T /F does NOT reach the orphan, proving the gap is real',
    async () => {
      const temp = await mkdtemp(join(tmpdir(), 'ovr taskkill control '));
      const marker = join(temp, 'marker.txt');
      const pidFile = join(temp, 'orphan.pid');
      const leader = spawn(process.execPath, [ORPHAN_FIXTURE, marker, pidFile], {
        cwd: temp,
        stdio: ['pipe', 'ignore', 'ignore'],
        windowsHide: true,
      });
      let orphanPid: number | undefined;

      try {
        await waitUntil(async () => (await exists(marker)) && (await exists(pidFile)));
        orphanPid = Number(await readFile(pidFile, 'utf8'));
        expect(alive(orphanPid)).toBe(true);

        await new Promise<void>((resolve, reject) => {
          const killer = spawn('taskkill', ['/pid', String(leader.pid), '/T', '/F'], {
            stdio: 'ignore',
            windowsHide: true,
          });
          killer.once('error', reject);
          killer.once('exit', () => resolve());
        });
        await waitUntil(() => leader.exitCode !== null || leader.killed);

        // The intermediate parent exited long before the kill, so the orphan is not in the leader's
        // live PID tree and taskkill /T simply never sees it.
        await new Promise<void>((resolve) => setTimeout(resolve, 300));
        expect(alive(orphanPid)).toBe(true);
        const mtimeAfterKill = (await stat(marker)).mtimeMs;
        await new Promise<void>((resolve) => setTimeout(resolve, 300));
        expect((await stat(marker)).mtimeMs).toBeGreaterThan(mtimeAfterKill);
      } finally {
        forceKill(orphanPid);
        forceKill(leader.pid);
        await new Promise<void>((resolve) => setTimeout(resolve, 200));
        await rm(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
      }
    },
    30_000,
  );

  it.skipIf(!isWindows)(
    'Windows: strips the Job Host control line while preserving provider stdout and stderr',
    async () => {
      const canary = 'provider-stderr-canary';
      const tree = spawnProcess(
        process.execPath,
        ['-e', `process.stdout.write('provider-stdout'); process.stderr.write('${canary}')`],
        { cwd: process.cwd(), windowsJobHostPath: JOB_HOST },
      );
      const stdout = collect(tree.child.stdout);
      const stderr = collect(tree.child.stderr);
      tree.child.stdin.end();

      expect((await tree.exit).code).toBe(0);
      expect(await stdout).toBe('provider-stdout');
      expect(await stderr).toBe(canary);
      expect(await stderr).not.toContain('ADJH/1');
    },
    20_000,
  );

  /**
   * Argv fidelity through the Job Host.
   *
   * The host re-quotes arguments itself (they cross a `CreateProcess` command line base64-encoded,
   * then get re-escaped for the target), so this checks the round trip with the values that break
   * naive quoting: embedded quotes, `%`, `&`, `|`, `^`, `<`, `>`, a tab, a trailing backslash, and
   * an empty string. It goes through a `.cmd` shim specifically because that is the case with two
   * parsing passes (cmd.exe's, then the target's) and therefore the one most likely to inject.
   */
  it.skipIf(!isWindows)(
    'Windows: preserves literal argv through a cmd shim with no shell injection or expansion',
    async () => {
      const temp = await mkdtemp(join(tmpdir(), 'ovr cmd argv '));
      const shimDirectory = join(temp, 'npm bin with spaces');
      const shim = join(shimDirectory, 'provider.cmd');
      const recorder = join(temp, 'record-argv.mjs');
      const invocationLog = join(temp, 'argv.json');
      const injectionMarker = join(temp, 'shell injection marker.txt');
      const literalArguments = [
        'quote"value',
        '50%!',
        `literal&echo injected>${injectionMarker}`,
        'pipe|read<input>output^caret',
        'tab\tvalue',
        'slash\\"quote',
        'trailing\\',
        '',
      ];
      await mkdir(shimDirectory, { recursive: true });
      // The recorder writes to a path relative to its own cwd (`temp`) rather than reading one out
      // of the environment. It used to take it from an `OVR_ARGV_LOG` variable passed through
      // `SpawnOptions.env`, which ADI-15 made impossible on purpose: that field now selects the
      // environment to *filter*, so an unlisted name no longer reaches the child. Using cwd keeps
      // this test about argv fidelity, which is all it was ever about.
      await writeFile(
        recorder,
        "import { writeFileSync } from 'node:fs'; writeFileSync('argv.json', JSON.stringify(process.argv.slice(2)));",
      );
      await writeFile(shim, `@echo off\r\n"${process.execPath}" "${recorder}" %*\r\n`);
      const tree = spawnProcess(shim, literalArguments, {
        cwd: temp,
        windowsJobHostPath: JOB_HOST,
      });
      const stdout = collect(tree.child.stdout);
      const stderr = collect(tree.child.stderr);
      tree.child.stdin.end();

      try {
        expect((await tree.exit).code).toBe(0);
        expect(JSON.parse(await readFile(invocationLog, 'utf8'))).toEqual(literalArguments);
        expect(await stdout).toBe('');
        expect(await stderr).toBe('');
        // The `&echo injected>file` argument must have been passed as data, not executed.
        expect(await exists(injectionMarker)).toBe(false);
      } finally {
        await tree.kill().catch(() => undefined);
        await rm(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
      }
    },
    30_000,
  );

  it('memoizes kill(), so concurrent callers share one termination sequence', async () => {
    const tree = spawnProcess(process.execPath, ['-e', 'setInterval(() => {}, 1000);'], {
      cwd: process.cwd(),
      ...(isWindows ? { windowsJobHostPath: JOB_HOST } : {}),
    });
    tree.child.stdin.end();
    await waitUntil(() => tree.child.pid !== undefined);

    const first = tree.kill();
    const second = tree.kill();
    // Identity, not just equivalent behavior: a boolean guard would let the second caller resolve
    // immediately while the first sequence was still running, reporting "reaped" before anything was.
    expect(second).toBe(first);

    await Promise.all([first, second]);
    expect(tree.kill()).toBe(first);
  }, 20_000);
});

describe('terminateProcessTree bounding and platform behavior', () => {
  it('reaps a Windows Job Host directly rather than enumerating a lineage', async () => {
    let exited = false;
    let resolveExit!: (result: ProcessExitResult) => void;
    const exit = new Promise<ProcessExitResult>((resolve) => {
      resolveExit = resolve;
    });
    const kill = vi.fn(() => {
      exited = true;
      resolveExit({ code: null, signal: 'SIGKILL' });
      return true;
    });
    const child = { pid: 12345, kill } as unknown as SpawnedProcess;

    await terminateProcessTree(child, exit, () => exited, { platform: 'win32', timeoutMs: 100 });

    expect(kill).toHaveBeenCalledWith('SIGKILL');
  });

  it('rejects within a bounded time when a process never exits, with a clear message', async () => {
    const child = { pid: 12345, kill: vi.fn(() => true) } as unknown as SpawnedProcess;
    const startedAt = Date.now();

    await expect(
      terminateProcessTree(child, new Promise<ProcessExitResult>(() => undefined), () => false, {
        platform: 'win32',
        timeoutMs: 25,
      }),
    ).rejects.toThrow('could not be confirmed reaped');

    // Bounded by the *deadline*, not by the sum of per-stage timeouts.
    expect(Date.now() - startedAt).toBeLessThan(500);
    expect(child.kill).toHaveBeenCalledWith('SIGKILL');
  });

  it('throws rather than silently succeeding when a Windows child has no pid', async () => {
    const child = { pid: undefined, kill: vi.fn(() => true) } as unknown as SpawnedProcess;
    await expect(
      terminateProcessTree(child, Promise.resolve({ code: 0, signal: null }), () => true, {
        platform: 'win32',
      }),
    ).rejects.toThrow('no process id');
  });
});

describe('filterWindowsJobHostStderr', () => {
  it('suppresses a malformed handshake and every later stderr byte', async () => {
    const source = new PassThrough();
    const invalid = vi.fn();
    const output = collect(filterWindowsJobHostStderr(source, invalid));

    source.write('ADJH/1 BROKEN\ncredential-canary');
    source.write('later-canary');
    source.end();

    expect(await output).toBe('');
    expect(invalid).toHaveBeenCalledOnce();
  });

  it('suppresses an oversized handshake and every later stderr byte', async () => {
    const source = new PassThrough();
    const invalid = vi.fn();
    const output = collect(filterWindowsJobHostStderr(source, invalid));

    source.write(Buffer.alloc(513, 0x78));
    source.write('credential-canary\n');
    source.end();

    expect(await output).toBe('');
    expect(invalid).toHaveBeenCalledOnce();
  });

  it('accepts a valid READY line coalesced with a large provider stderr chunk', async () => {
    const source = new PassThrough();
    const invalid = vi.fn();
    const output = collect(filterWindowsJobHostStderr(source, invalid));
    const providerStderr = 'provider-canary'.repeat(100);

    source.end(`ADJH/1 READY 123\n${providerStderr}`);

    expect(await output).toBe(providerStderr);
    expect(invalid).not.toHaveBeenCalled();
  });

  it('reports invalid when the stream ends before any handshake arrives', async () => {
    const source = new PassThrough();
    const invalid = vi.fn();
    const output = collect(filterWindowsJobHostStderr(source, invalid));
    source.end();
    expect(await output).toBe('');
    expect(invalid).toHaveBeenCalledOnce();
  });
});
