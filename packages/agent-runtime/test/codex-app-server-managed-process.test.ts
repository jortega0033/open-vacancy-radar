import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ManagedAppServerProcess } from '../src/providers/codex/app-server/managed-process.js';
import { CodexAppServerProtocolError } from '../src/providers/codex/app-server/errors.js';

const FIXTURE = fileURLToPath(new URL('./fixtures/fake-app-server-echo.mjs', import.meta.url));

/**
 * `platform: 'linux'` is forced everywhere below regardless of the real host platform: this file
 * tests `ManagedAppServerProcess`'s own callback-wiring/write/close logic on top of whatever
 * `spawnProcess()` gives it, not the Windows Job Host mechanics themselves (already covered by
 * `spawn-process.test.ts`, including its negative-control orphan test). Forcing the POSIX spawn
 * path here keeps these tests portable without depending on a pre-built
 * `agent-dock-job-host.exe` artifact.
 */
function setup(overrides: Partial<{ onStdout: (chunk: Buffer) => void; onStdoutEnd: () => void; onFailure: (error: Error) => void }> = {}) {
  const stdoutChunks: Buffer[] = [];
  const failures: Error[] = [];
  const process_ = new ManagedAppServerProcess({
    executable: process.execPath,
    executableArgs: [FIXTURE],
    cwd,
    platform: 'linux',
    onStdout: overrides.onStdout ?? ((chunk) => stdoutChunks.push(chunk)),
    onStdoutEnd: overrides.onStdoutEnd ?? (() => {}),
    onFailure: overrides.onFailure ?? ((error) => failures.push(error)),
  });
  return { process: process_, stdoutChunks, failures };
}

let cwd: string;

beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), 'agent-dock-managed-process-test-'));
});

afterEach(() => {
  rmSync(cwd, { recursive: true, force: true });
});

describe('ManagedAppServerProcess', () => {
  it('delivers a written frame to the child and the child\'s stdout back through onStdout', async () => {
    const { process: proc, stdoutChunks } = setup();
    try {
      await proc.write(Buffer.from('hello\n', 'utf8'));
      await vi.waitFor(() => expect(Buffer.concat(stdoutChunks).toString('utf8')).toContain('hello'));
    } finally {
      await proc.close();
    }
  });

  it('accumulates only bounded, redacted stderr summaries -- never raw provider text', async () => {
    const { process: proc } = setup();
    try {
      await vi.waitFor(() => expect(proc.stderrSummary.length).toBeGreaterThan(0));
      for (const summary of proc.stderrSummary) {
        expect(summary).toMatch(/^Codex app-server stderr redacted \(\d+ bytes\)$/);
        expect(summary).not.toContain('fixture stderr line 1');
      }
    } finally {
      await proc.close();
    }
  });

  it('never grows the stderr summary list past its bound, even under a burst', async () => {
    // Real event coalescing on the OS pipe makes an exact eviction count non-deterministic to
    // drive through a real subprocess (the count tracks stderr *data events*, not lines, and a
    // fast burst is not guaranteed to arrive as one event per write); this asserts the invariant
    // that actually matters -- the list can never exceed its cap -- rather than an exact count.
    const { process: proc } = setup();
    try {
      const burst = Array.from({ length: 500 }, (_, i) => `STDERR:line ${i}`).join('\n') + '\n';
      await proc.write(Buffer.from(burst, 'utf8'));
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(proc.stderrSummary.length).toBeLessThanOrEqual(128);
    } finally {
      await proc.close();
    }
  });

  it('calls onFailure with a process_failed error when the child exits unexpectedly', async () => {
    const { process: proc, failures } = setup();
    await proc.write(Buffer.from('EXIT:1\n', 'utf8'));
    await vi.waitFor(() => expect(failures).toHaveLength(1));
    expect((failures[0] as CodexAppServerProtocolError).code).toBe('process_failed');
    expect(failures[0]!.message).toContain('unexpectedly');
  });

  it('routes a raw stderr stream error through onFailure instead of crashing as an unhandled EventEmitter error', async () => {
    const { process: proc, failures } = setup();
    try {
      // Reaches the private spawned child directly to force a real stream 'error' event -- the
      // exact scenario the missing listener this test guards against would otherwise leave
      // completely unhandled (Node throws an uncaught exception for an 'error' event with no
      // listener), which this test would itself fail with if the fix regressed.
      const internals = proc as unknown as { spawned: { child: { stderr: NodeJS.EventEmitter } } };
      internals.spawned.child.stderr.emit('error', new Error('EPIPE'));
      await vi.waitFor(() => expect(failures).toHaveLength(1));
      expect((failures[0] as CodexAppServerProtocolError).code).toBe('process_failed');
    } finally {
      await proc.close();
    }
  });

  it('calls onFailure when the executable cannot be spawned at all (e.g. Codex not installed)', async () => {
    const failures: Error[] = [];
    const proc = new ManagedAppServerProcess({
      executable: join(cwd, 'this-executable-does-not-exist'),
      cwd,
      platform: 'linux',
      onStdout: () => {},
      onStdoutEnd: () => {},
      onFailure: (error) => failures.push(error),
    });
    try {
      await vi.waitFor(() => expect(failures).toHaveLength(1));
      expect((failures[0] as CodexAppServerProtocolError).code).toBe('process_failed');
    } finally {
      await proc.close();
    }
  });

  it('does not report a failure for an exit that happens after close() was called', async () => {
    const { process: proc, failures } = setup();
    await proc.close();
    // Give any late 'exit' handling a moment to (not) fire onFailure.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(failures).toHaveLength(0);
  });

  it('write() rejects once the process is closing', async () => {
    const { process: proc } = setup();
    await proc.close();
    await expect(proc.write(Buffer.from('too late\n', 'utf8'))).rejects.toThrow(CodexAppServerProtocolError);
  });

  it('close() resolves (spawnProcess()\'s own kill() guarantees confirmed-reaped) and is idempotent', async () => {
    const { process: proc } = setup();
    await proc.write(Buffer.from('probe\n', 'utf8'));
    await proc.close();
    // A second close() must not throw or hang (kill() is memoized/idempotent).
    await proc.close();
  });

  it('forceClose() reaps the process without first ending stdin gracefully', async () => {
    const { process: proc } = setup();
    await proc.write(Buffer.from('probe\n', 'utf8'));
    await proc.forceClose();
    await expect(proc.write(Buffer.from('too late\n', 'utf8'))).rejects.toThrow(CodexAppServerProtocolError);
  });
});
