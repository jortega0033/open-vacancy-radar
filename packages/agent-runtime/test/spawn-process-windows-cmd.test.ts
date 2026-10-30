import { EventEmitter } from 'node:events';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SpawnOptions as NodeSpawnOptions } from 'node:child_process';

/**
 * #719: the exact command, argv and options `spawnProcess` hands to Node for each Windows target
 * kind, on every platform. Only `child_process.spawn` itself is replaced (with a recorder that
 * returns an inert child); the Job Host routing decision, the v1 wire encoding and the environment
 * filter are all the production code. The real-process counterpart, which runs `cmd.exe` through
 * the compiled host, is `windows-claude-resolution.test.ts`.
 */
const calls: Array<{ command: string; args: string[]; options: NodeSpawnOptions }> = [];

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return {
    ...actual,
    spawn: (command: string, args: string[], options: NodeSpawnOptions) => {
      calls.push({ command, args, options });
      return Object.assign(new EventEmitter(), {
        stdin: new PassThrough(),
        stdout: new PassThrough(),
        stderr: new PassThrough(),
        pid: 4242,
        exitCode: null,
        kill: () => true,
      });
    },
  };
});

const { spawnProcess } = await import('../src/process/spawn-process.js');
const { buildClaudeArgs, CLAUDE_HARDENING_ARGS } = await import('../src/providers/claude/build-args.js');

// Absolute on whichever platform runs the test; the host override only has to be absolute.
const JOB_HOST = join(tmpdir(), 'agent-dock-job-host.exe');
const CWD = tmpdir();
const NPM_CMD = String.raw`C:\Users\someone\AppData\Roaming\npm\claude.cmd`;
const NATIVE_EXE = String.raw`C:\Users\someone\.local\bin\claude.exe`;

function decodeJobHostArgs(args: string[]): string[] {
  return args.map((field) => Buffer.from(field, 'base64').toString('utf8'));
}

describe('spawnProcess: Windows target routing (#719)', () => {
  const savedKey = process.env.ANTHROPIC_API_KEY;

  beforeEach(() => {
    calls.length = 0;
    process.env.ANTHROPIC_API_KEY = 'sk-ant-planted-must-not-reach-child';
  });

  afterEach(() => {
    if (savedKey === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = savedKey;
  });

  it('routes a .cmd version probe through the Job Host even when the caller bypasses it (execCapture options)', () => {
    spawnProcess(NPM_CMD, ['--version'], {
      cwd: CWD,
      useJobHostOnWindows: false,
      platform: 'win32',
      windowsJobHostPath: JOB_HOST,
    });

    expect(calls).toHaveLength(1);
    const [call] = calls;
    expect(call!.command).toBe(JOB_HOST);
    expect(decodeJobHostArgs(call!.args)).toEqual([String(process.pid), NPM_CMD, CWD, '--version']);
    expect(call!.options).toMatchObject({ shell: false, detached: false, windowsHide: true });
  });

  it('matches .cmd case-insensitively', () => {
    const upper = String.raw`C:\npm\CLAUDE.CMD`;
    spawnProcess(upper, ['auth', 'status', '--json'], {
      cwd: CWD,
      useJobHostOnWindows: false,
      platform: 'win32',
      windowsJobHostPath: JOB_HOST,
    });

    expect(calls[0]!.command).toBe(JOB_HOST);
    expect(decodeJobHostArgs(calls[0]!.args)).toEqual([String(process.pid), upper, CWD, 'auth', 'status', '--json']);
  });

  it('carries the exact hardened Claude session argv to a .cmd target, including the empty value', () => {
    const cmd = String.raw`C:\npm bin\claude.cmd`;
    const args = buildClaudeArgs({ sessionId: 's-719', prompt: 'unused', cwd: CWD, hardened: true });
    expect(args).toEqual(expect.arrayContaining([...CLAUDE_HARDENING_ARGS]));
    expect(args).toContain('');

    spawnProcess(cmd, args, { cwd: CWD, platform: 'win32', windowsJobHostPath: JOB_HOST });

    expect(calls[0]!.command).toBe(JOB_HOST);
    expect(decodeJobHostArgs(calls[0]!.args)).toEqual([String(process.pid), cmd, CWD, ...args]);
    expect(calls[0]!.options.shell).toBe(false);
  });

  it('still spawns a native .exe probe directly and shell-free when the caller bypasses the host', () => {
    spawnProcess(NATIVE_EXE, ['--version'], {
      cwd: CWD,
      useJobHostOnWindows: false,
      platform: 'win32',
      windowsJobHostPath: JOB_HOST,
    });

    expect(calls[0]!.command).toBe(NATIVE_EXE);
    expect(calls[0]!.args).toEqual(['--version']);
    expect(calls[0]!.options).toMatchObject({ shell: false });
  });

  it('leaves POSIX untouched: a .cmd-named file is spawned directly, detached, shell-free', () => {
    spawnProcess('/opt/tools/claude.cmd', ['--version'], { cwd: CWD, platform: 'linux' });

    expect(calls[0]!.command).toBe('/opt/tools/claude.cmd');
    expect(calls[0]!.options).toMatchObject({ shell: false, detached: true });
  });

  it('applies the provider environment filter on the .cmd route', () => {
    spawnProcess(NPM_CMD, ['--version'], {
      cwd: CWD,
      useJobHostOnWindows: false,
      platform: 'win32',
      windowsJobHostPath: JOB_HOST,
    });

    const env = calls[0]!.options.env ?? {};
    expect(Object.values(env)).not.toContain('sk-ant-planted-must-not-reach-child');
    expect(Object.keys(env).map((name) => name.toUpperCase())).not.toContain('ANTHROPIC_API_KEY');
  });
});
