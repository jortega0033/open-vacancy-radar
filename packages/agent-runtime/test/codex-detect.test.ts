import { beforeEach, describe, expect, it, vi } from 'vitest';
import { parseCodexAuthSource, parseCodexLoginStatus } from '../src/providers/codex/detect.js';

describe('parseCodexLoginStatus: pure parser (AD-16)', () => {
  it('returns "authenticated" for a real "Logged in using ChatGPT" line', () => {
    expect(parseCodexLoginStatus('Logged in using ChatGPT')).toBe('authenticated');
  });

  it('returns "authenticated" for "Logged in using API key"', () => {
    expect(parseCodexLoginStatus('Logged in using API key')).toBe('authenticated');
  });

  it('returns "unauthenticated" for "Not logged in"', () => {
    expect(parseCodexLoginStatus('Not logged in')).toBe('unauthenticated');
  });

  it('returns "unauthenticated" for "Not authenticated" / "No credentials found" variants', () => {
    expect(parseCodexLoginStatus('Not authenticated. Run `codex login` first.')).toBe('unauthenticated');
    expect(parseCodexLoginStatus('No credentials found.')).toBe('unauthenticated');
  });

  it('does not fall into the substring trap: "Not logged in" must not match the "logged in" positive check', () => {
    expect(parseCodexLoginStatus('Not logged in')).not.toBe('authenticated');
  });

  it('returns "unknown" for empty output', () => {
    expect(parseCodexLoginStatus('')).toBe('unknown');
  });

  it('returns "unknown" for unexpected/unrecognized output', () => {
    expect(parseCodexLoginStatus('codex: unrecognized subcommand "status"')).toBe('unknown');
    expect(parseCodexLoginStatus('some future wording this parser has never seen')).toBe('unknown');
  });
});

describe('parseCodexAuthSource: pure parser (ADI-08)', () => {
  it('returns "chatgpt" for a real "Logged in using ChatGPT" line', () => {
    expect(parseCodexAuthSource('Logged in using ChatGPT')).toBe('chatgpt');
  });

  it('returns "api_key" for a real "Logged in using API key" line', () => {
    expect(parseCodexAuthSource('Logged in using API key')).toBe('api_key');
  });

  it('returns "unknown" for output that does not name a specific source, including unauthenticated output', () => {
    expect(parseCodexAuthSource('Not logged in')).toBe('unknown');
    expect(parseCodexAuthSource('')).toBe('unknown');
    expect(parseCodexAuthSource('some future wording this parser has never seen')).toBe('unknown');
  });
});

describe('detectCodex: end-to-end failure paths (mocked exec, no real CLI)', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('reports "unknown" and installed:false when the executable cannot be found at all', async () => {
    vi.doMock('../src/detect-executable.js', () => ({ findExecutable: async () => null }));
    const { detectCodex } = await import('../src/providers/codex/detect.js');
    const status = await detectCodex({ debug() {}, info() {}, warn() {}, error() {} });
    expect(status).toMatchObject({ installed: false, authenticated: 'unknown' });
  });

  it('reports "unknown" when --version exits non-zero', async () => {
    vi.doMock('../src/detect-executable.js', () => ({ findExecutable: async () => '/usr/local/bin/codex' }));
    vi.doMock('../src/process/exec-capture.js', () => ({
      execCapture: async () => ({ code: 1, stdout: '', stderr: 'not found', timedOut: false }),
    }));
    const { detectCodex } = await import('../src/providers/codex/detect.js');
    const status = await detectCodex({ debug() {}, info() {}, warn() {}, error() {} });
    expect(status).toMatchObject({ installed: true, authenticated: 'unknown', error: 'codex --version failed' });
  });

  it('reports "unknown" when the login status check times out', async () => {
    vi.doMock('../src/detect-executable.js', () => ({ findExecutable: async () => '/usr/local/bin/codex' }));
    vi.doMock('../src/process/exec-capture.js', () => ({
      execCapture: async (_cmd: string, args: string[]) =>
        args.includes('--version')
          ? { code: 0, stdout: 'codex-cli 0.147.0', stderr: '', timedOut: false }
          : { code: null, stdout: '', stderr: '', timedOut: true },
    }));
    const { detectCodex } = await import('../src/providers/codex/detect.js');
    const status = await detectCodex({ debug() {}, info() {}, warn() {}, error() {} });
    expect(status).toMatchObject({ installed: true, authenticated: 'unknown', error: 'login status check timed out' });
  });

  it('reports "authenticated" end to end when both commands succeed with a logged-in line, threading authSource through', async () => {
    vi.doMock('../src/detect-executable.js', () => ({ findExecutable: async () => '/usr/local/bin/codex' }));
    vi.doMock('../src/process/exec-capture.js', () => ({
      execCapture: async (_cmd: string, args: string[]) =>
        args.includes('--version')
          ? { code: 0, stdout: 'codex-cli 0.147.0', stderr: '', timedOut: false }
          : { code: 0, stdout: 'Logged in using ChatGPT', stderr: '', timedOut: false },
    }));
    const { detectCodex } = await import('../src/providers/codex/detect.js');
    const status = await detectCodex({ debug() {}, info() {}, warn() {}, error() {} });
    expect(status).toMatchObject({ installed: true, authenticated: 'authenticated', version: '0.147.0', authSource: 'chatgpt' });
  });

  it('reports authSource: "api_key" end to end for an API-key logged-in line', async () => {
    vi.doMock('../src/detect-executable.js', () => ({ findExecutable: async () => '/usr/local/bin/codex' }));
    vi.doMock('../src/process/exec-capture.js', () => ({
      execCapture: async (_cmd: string, args: string[]) =>
        args.includes('--version')
          ? { code: 0, stdout: 'codex-cli 0.147.0', stderr: '', timedOut: false }
          : { code: 0, stdout: 'Logged in using API key', stderr: '', timedOut: false },
    }));
    const { detectCodex } = await import('../src/providers/codex/detect.js');
    const status = await detectCodex({ debug() {}, info() {}, warn() {}, error() {} });
    expect(status).toMatchObject({ installed: true, authenticated: 'authenticated', authSource: 'api_key' });
  });

  it('never sets authSource when the login state is not "authenticated"', async () => {
    vi.doMock('../src/detect-executable.js', () => ({ findExecutable: async () => '/usr/local/bin/codex' }));
    vi.doMock('../src/process/exec-capture.js', () => ({
      execCapture: async (_cmd: string, args: string[]) =>
        args.includes('--version')
          ? { code: 0, stdout: 'codex-cli 0.147.0', stderr: '', timedOut: false }
          : { code: 0, stdout: 'Not logged in', stderr: '', timedOut: false },
    }));
    const { detectCodex } = await import('../src/providers/codex/detect.js');
    const status = await detectCodex({ debug() {}, info() {}, warn() {}, error() {} });
    expect(status.authenticated).toBe('unauthenticated');
    expect(status.authSource).toBeUndefined();
  });

  it('reports "unauthenticated" end to end for a clean not-logged-in response', async () => {
    vi.doMock('../src/detect-executable.js', () => ({ findExecutable: async () => '/usr/local/bin/codex' }));
    vi.doMock('../src/process/exec-capture.js', () => ({
      execCapture: async (_cmd: string, args: string[]) =>
        args.includes('--version')
          ? { code: 0, stdout: 'codex-cli 0.147.0', stderr: '', timedOut: false }
          : { code: 0, stdout: 'Not logged in', stderr: '', timedOut: false },
    }));
    const { detectCodex } = await import('../src/providers/codex/detect.js');
    const status = await detectCodex({ debug() {}, info() {}, warn() {}, error() {} });
    expect(status).toMatchObject({ installed: true, authenticated: 'unauthenticated' });
  });
});
