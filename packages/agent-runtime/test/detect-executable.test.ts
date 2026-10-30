import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { findExecutable } from '../src/detect-executable.js';

describe('findExecutable', () => {
  it('returns an absolute path directly when it already exists on disk', async () => {
    const result = await findExecutable([process.execPath]);
    expect(result).toBe(process.execPath);
  });

  it('returns null for a name that is installed nowhere', async () => {
    const result = await findExecutable(['definitely-not-a-real-cli-xyz-123']);
    expect(result).toBeNull();
  });
});

/**
 * #719: the real `findExecutable` selection, driven by a recorded `where`/`which` stdout and real
 * files on disk, on every platform. Only the PATH lookup's child process is replaced; the candidate
 * parsing, usability checks and preference order are the production code. The Windows-only
 * `windows-claude-resolution.test.ts` repeats the key cases against the real `where`.
 */
describe('findExecutable: Windows spawnable-target selection (#719)', () => {
  let temp: string;
  let lookupStdout: string;
  const lookups: Array<{ command: string; args: string[] }> = [];

  async function load() {
    vi.doMock('../src/process/exec-capture.js', () => ({
      execCapture: async (command: string, args: string[]) => {
        lookups.push({ command, args });
        return { code: lookupStdout ? 0 : 1, stdout: lookupStdout, stderr: '', timedOut: false };
      },
    }));
    return (await import('../src/detect-executable.js')).findExecutable;
  }

  async function file(...segments: string[]): Promise<string> {
    const path = join(temp, ...segments);
    await mkdir(join(path, '..'), { recursive: true });
    await writeFile(path, 'placeholder');
    return path;
  }

  function whereOutput(...paths: string[]): string {
    // `where` prints CRLF-terminated absolute paths in PATH order.
    return paths.map((path) => `${path}\r\n`).join('');
  }

  beforeEach(async () => {
    vi.resetModules();
    lookups.length = 0;
    lookupStdout = '';
    temp = await mkdtemp(join(tmpdir(), 'ovr find-executable '));
  });

  afterEach(async () => {
    vi.doUnmock('../src/process/exec-capture.js');
    await rm(temp, { recursive: true, force: true });
  });

  it('skips an extensionless npm shim listed first and selects the .cmd after it', async () => {
    const shim = await file('npm', 'claude');
    const cmd = await file('npm', 'claude.cmd');
    lookupStdout = whereOutput(shim, cmd);
    const find = await load();

    await expect(find(['claude'], [], { platform: 'win32' })).resolves.toBe(cmd);
    expect(lookups).toEqual([{ command: 'where', args: ['claude'] }]);
  });

  it('selects a .cmd when it is the only result', async () => {
    const cmd = await file('npm', 'claude.cmd');
    lookupStdout = whereOutput(cmd);
    const find = await load();

    await expect(find(['claude'], [], { platform: 'win32' })).resolves.toBe(cmd);
  });

  it('selects a native .exe when it is the only result', async () => {
    const exe = await file('native', 'claude.exe');
    lookupStdout = whereOutput(exe);
    const find = await load();

    await expect(find(['claude'], [], { platform: 'win32' })).resolves.toBe(exe);
  });

  it('skips unusable results (stale path, directory, extensionless, .ps1) before a usable native .exe', async () => {
    const stale = join(temp, 'uninstalled', 'claude.exe');
    const directory = join(temp, 'looks-like', 'claude.exe');
    await mkdir(directory, { recursive: true });
    const shim = await file('npm', 'claude');
    const ps1 = await file('npm', 'claude.ps1');
    const exe = await file('native', 'claude.exe');
    lookupStdout = whereOutput(stale, directory, shim, ps1, exe);
    const find = await load();

    await expect(find(['claude'], [], { platform: 'win32' })).resolves.toBe(exe);
  });

  it('prefers a native .exe over a .cmd listed earlier, case-insensitively', async () => {
    const cmd = await file('npm', 'claude.CMD');
    const exe = await file('native', 'claude.EXE');
    lookupStdout = whereOutput(cmd, exe);
    const find = await load();

    await expect(find(['claude'], [], { platform: 'win32' })).resolves.toBe(exe);
  });

  it('falls back to install directories when PATH has nothing launchable, never to an extensionless file', async () => {
    const shim = await file('npm', 'claude');
    lookupStdout = whereOutput(shim);
    await file('fallback-a', 'claude');
    const fallbackCmd = await file('fallback-b', 'claude.cmd');
    const find = await load();

    await expect(
      find(['claude'], [join(temp, 'fallback-a'), join(temp, 'fallback-b')], { platform: 'win32' }),
    ).resolves.toBe(fallbackCmd);
  });

  it('keeps POSIX behavior: the first `which` line, extensionless, unchanged', async () => {
    const posix = await file('bin', 'claude');
    lookupStdout = `${posix}\n/other/claude\n`;
    const find = await load();

    await expect(find(['claude'], [], { platform: 'linux' })).resolves.toBe(posix);
    expect(lookups).toEqual([{ command: 'which', args: ['claude'] }]);
  });
});
