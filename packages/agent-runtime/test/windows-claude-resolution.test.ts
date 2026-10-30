import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { findExecutable } from '../src/detect-executable.js';
import { execCapture } from '../src/process/exec-capture.js';
import { detectClaude } from '../src/providers/claude/detect.js';

/**
 * #719 against the real Windows machinery: the real `where`, the compiled Job Host (built by
 * `test/support/global-setup.ts`), a real `cmd.exe`, and the production `detectClaude`.
 *
 * The fake CLI is a Node script behind an npm-style `.cmd` shim, next to an extensionless shim of
 * the kind npm also writes. `where claude` lists that extensionless file first, which is exactly
 * the installed-app failure: before #719 detection took it, could not spawn it, and reported
 * `claude --version failed`.
 *
 * What this proves: target selection and the shell-free `.cmd` launch path, end to end, on a Windows
 * runner. What it does not prove: the packaged app on a real user profile with the real Claude CLI,
 * which is left to the packaged-installer CI job and to release testing.
 */
const isWindows = process.platform === 'win32';
const logger = { debug() {}, info() {}, warn() {}, error() {} };

const FAKE_CLAUDE = [
  "import { writeFileSync } from 'node:fs';",
  'const args = process.argv.slice(2);',
  "if (args[0] === '--version') {",
  "  process.stdout.write('2.1.308 (Claude Code)');",
  "} else if (args.join(' ') === 'auth status --json') {",
  "  process.stdout.write(JSON.stringify({ loggedIn: true, authMethod: 'claude.ai' }));",
  "} else if (args[0] === 'hang') {",
  "  writeFileSync('grandchild.pid', String(process.pid));",
  '  setInterval(() => {}, 1000);',
  '} else {',
  "  process.stderr.write('unexpected argv ' + JSON.stringify(args));",
  '  process.exit(9);',
  '}',
].join('\n');

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

async function waitUntil(predicate: () => boolean | Promise<boolean>, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (!(await predicate())) {
    if (Date.now() >= deadline) throw new Error('condition timed out');
    await new Promise<void>((resolve) => setTimeout(resolve, 25));
  }
}

function lines(stdout: string): string[] {
  return stdout.split(/\r?\n/).filter((line) => line.length > 0);
}

describe.skipIf(!isWindows)('Windows Claude target resolution, real where + Job Host (#719)', () => {
  let temp: string;
  let savedPath: string | undefined;

  /** PATH holds only the given directories plus System32, so `where` (and nothing installed) is found. */
  function usePath(...directories: string[]) {
    const system32 = join(process.env.SystemRoot ?? String.raw`C:\Windows`, 'System32');
    process.env.PATH = [...directories, system32].join(';');
  }

  async function writeNpmStyleInstall(directory: string): Promise<{ shim: string; cmd: string }> {
    const script = join(directory, 'node_modules', 'fake-claude', 'cli.mjs');
    await mkdir(dirname(script), { recursive: true });
    await writeFile(script, FAKE_CLAUDE);
    const shim = join(directory, 'claude');
    const cmd = join(directory, 'claude.cmd');
    // npm's extensionless sh shim: not a PE image, so neither spawn nor the Job Host can run it.
    await writeFile(shim, '#!/bin/sh\nexec node "$basedir/node_modules/fake-claude/cli.mjs" "$@"\n');
    await writeFile(cmd, `@ECHO off\r\n"${process.execPath}" "${script}" %*\r\n`);
    return { shim, cmd };
  }

  beforeEach(async () => {
    savedPath = process.env.PATH;
    temp = await mkdtemp(join(tmpdir(), 'ovr claude resolution '));
  });

  afterEach(async () => {
    process.env.PATH = savedPath;
    await rm(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });

  it('detectClaude reports ready through the .cmd when where lists the extensionless shim first', async () => {
    const directory = join(temp, 'npm global');
    const { shim, cmd } = await writeNpmStyleInstall(directory);
    usePath(directory);

    // Precondition: the real `where` reproduces the field ordering.
    expect(lines((await execCapture('where', ['claude'])).stdout)).toEqual([shim, cmd]);

    const status = await detectClaude(logger);

    expect(status).toMatchObject({
      installed: true,
      authenticated: 'authenticated',
      version: '2.1.308',
      executablePath: cmd,
    });
    expect(status.error).toBeUndefined();
  }, 30_000);

  it('real where: selects the .cmd when it is the only result', async () => {
    const directory = join(temp, 'cmd only');
    const { cmd, shim } = await writeNpmStyleInstall(directory);
    await rm(shim);
    usePath(directory);

    expect(lines((await execCapture('where', ['claude'])).stdout)).toEqual([cmd]);
    await expect(findExecutable(['claude'])).resolves.toBe(cmd);
  });

  it('real where: selects a native .exe when it is the only result', async () => {
    const directory = join(temp, 'native bin');
    await mkdir(directory, { recursive: true });
    const exe = join(directory, 'claude.exe');
    await writeFile(exe, 'selection-only placeholder; never executed');
    usePath(directory);

    expect(lines((await execCapture('where', ['claude'])).stdout)).toEqual([exe]);
    await expect(findExecutable(['claude'])).resolves.toBe(exe);
  });

  it('real where: an unusable first result is skipped for a usable native .exe after it', async () => {
    const first = join(temp, 'first');
    await mkdir(first, { recursive: true });
    await writeFile(join(first, 'claude'), '#!/bin/sh\n');
    const second = join(temp, 'second');
    await mkdir(second, { recursive: true });
    const exe = join(second, 'claude.exe');
    await writeFile(exe, 'selection-only placeholder; never executed');
    usePath(first, second);

    expect(lines((await execCapture('where', ['claude'])).stdout)).toEqual([join(first, 'claude'), exe]);
    await expect(findExecutable(['claude'])).resolves.toBe(exe);
  });

  it('a timed-out probe through a .cmd reaps the CLI that cmd.exe started, not just cmd.exe', async () => {
    const { cmd } = await writeNpmStyleInstall(join(temp, 'hang'));
    const pidFile = join(temp, 'grandchild.pid');
    const startedAt = Date.now();

    // Generous timeout so the grandchild provably exists before it fires, even on a loaded runner
    // (a cold `cmd.exe` -> `node.exe` start can take seconds there); the assertion below is about
    // what the timeout reaps, not how fast it fires.
    const probe = execCapture(cmd, ['hang'], { cwd: temp, timeoutMs: 10_000 });
    await waitUntil(async () => (await readFile(pidFile, 'utf8').catch(() => '')).length > 0, 9_000);
    const pid = Number(await readFile(pidFile, 'utf8'));
    expect(pid).toBeGreaterThan(0);
    expect(alive(pid)).toBe(true);

    const result = await probe;

    expect(result.timedOut).toBe(true);
    expect(Date.now() - startedAt).toBeLessThan(20_000);
    await waitUntil(() => !alive(pid));
  }, 30_000);
});
