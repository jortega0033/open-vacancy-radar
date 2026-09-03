import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentEvent } from '@agent-dock/shared';
import { noopLogger } from '../src/logger.js';
import { runProviderSession } from '../src/providers/common/run-session.js';
import { parseClaudeLine } from '../src/providers/claude/parser.js';
import { buildCodexArgs } from '../src/providers/codex/build-args.js';
import { parseCodexLine } from '../src/providers/codex/parser.js';
import type { StartSessionOptions } from '../src/types.js';

const fixturesDir = fileURLToPath(new URL('./fixtures', import.meta.url));

async function collectEvents(events: AsyncGenerator<AgentEvent, void, void>): Promise<AgentEvent[]> {
  const out: AgentEvent[] = [];
  for await (const event of events) out.push(event);
  return out;
}

let cwd: string;

beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), 'agent-dock-run-session-'));
});

afterEach(() => {
  rmSync(cwd, { recursive: true, force: true });
});

describe('runProviderSession (spawns real node child processes via fixtures)', () => {
  it('runs a successful session end to end, tolerating split JSONL chunks', async () => {
    const handle = runProviderSession(
      {
        providerId: 'claude',
        executableNames: [process.execPath],
        buildArgs: () => [join(fixturesDir, 'fake-claude-success.mjs')],
        parseLine: parseClaudeLine,
      },
      { sessionId: 'test-session-1', cwd, prompt: 'hello' },
      noopLogger,
    );

    const events = await collectEvents(handle.events);
    expect(events[0]).toEqual({ type: 'session.started', sessionId: 'test-session-1', provider: 'claude' });
    expect(events).toContainEqual({ type: 'assistant.message', text: 'hello from fixture' });
    const completed = events.at(-1);
    expect(completed).toMatchObject({ type: 'session.completed', providerSessionId: 'claude-fixture-session-id' });
  });

  it('surfaces a non-zero exit as session.failed with stderr in the error message', async () => {
    const handle = runProviderSession(
      {
        providerId: 'claude',
        executableNames: [process.execPath],
        buildArgs: () => [join(fixturesDir, 'fake-claude-failure.mjs')],
        parseLine: parseClaudeLine,
        describeFailure: (stderr) => stderr.trim(),
      },
      { sessionId: 'test-session-2', cwd, prompt: 'hello' },
      noopLogger,
    );

    const events = await collectEvents(handle.events);
    expect(events.some((e) => e.type === 'error')).toBe(true);
    const failed = events.at(-1);
    expect(failed).toMatchObject({ type: 'session.failed', message: 'fatal: something went wrong' });
  });

  it('includes a stderr snippet in the default failure message when the adapter has no describeFailure (both real adapters currently rely on this default)', async () => {
    const handle = runProviderSession(
      {
        providerId: 'claude',
        executableNames: [process.execPath],
        buildArgs: () => [join(fixturesDir, 'fake-claude-failure.mjs')],
        parseLine: parseClaudeLine,
        // no describeFailure. This is exactly how providers/claude/adapter.ts and
        // providers/codex/adapter.ts are configured in production.
      },
      { sessionId: 'test-session-2b', cwd, prompt: 'hello' },
      noopLogger,
    );

    const events = await collectEvents(handle.events);
    const failed = events.at(-1);
    expect(failed).toMatchObject({ type: 'session.failed' });
    expect((failed as { message: string }).message).toContain('fatal: something went wrong');
    expect((failed as { message: string }).message).toContain('exited with code');
  });

  it('logs a bounded stderr snippet at warn level on a non-zero exit, even when describeFailure is not provided', async () => {
    const logger = { debug: () => {}, info: () => {}, warn: vi.fn(), error: () => {} };
    const handle = runProviderSession(
      {
        providerId: 'claude',
        executableNames: [process.execPath],
        buildArgs: () => [join(fixturesDir, 'fake-claude-failure.mjs')],
        parseLine: parseClaudeLine,
      },
      { sessionId: 'test-session-2c', cwd, prompt: 'hello' },
      logger,
    );
    await collectEvents(handle.events);

    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('process exited non-zero'),
      expect.objectContaining({ stderrSnippet: expect.stringContaining('fatal: something went wrong') }),
    );
  });

  it('normalizes codex fixture output through the same skeleton', async () => {
    const handle = runProviderSession(
      {
        providerId: 'codex',
        executableNames: [process.execPath],
        buildArgs: () => [join(fixturesDir, 'fake-codex-success.mjs')],
        parseLine: parseCodexLine,
      },
      { sessionId: 'test-session-3', cwd, prompt: 'hello' },
      noopLogger,
    );

    const events = await collectEvents(handle.events);
    expect(events).toContainEqual({
      type: 'tool.completed',
      toolName: 'shell',
      toolCallId: 'item_0',
      result: { command: 'echo hi', output: 'hi\n', exitCode: 0 },
      isError: false,
    });
    expect(events.at(-1)).toMatchObject({ type: 'session.completed', providerSessionId: 'codex-fixture-thread-id' });
  });

  it('rejects a nonexistent working directory without spawning anything', async () => {
    const handle = runProviderSession(
      {
        providerId: 'claude',
        executableNames: [process.execPath],
        buildArgs: () => [join(fixturesDir, 'fake-claude-success.mjs')],
        parseLine: parseClaudeLine,
      },
      { sessionId: 'test-session-4', cwd: join(cwd, 'does-not-exist'), prompt: 'hello' },
      noopLogger,
    );

    const events = await collectEvents(handle.events);
    expect(events.some((e) => e.type === 'error' && e.code === 'INVALID_CWD')).toBe(true);
    expect(events.at(-1)).toEqual({ type: 'session.failed', message: 'invalid working directory' });
  });

  it('reports PROVIDER_NOT_INSTALLED when the executable cannot be found', async () => {
    const handle = runProviderSession(
      {
        providerId: 'claude',
        executableNames: ['definitely-not-a-real-cli-xyz-123'],
        buildArgs: () => [],
        parseLine: parseClaudeLine,
      },
      { sessionId: 'test-session-5', cwd, prompt: 'hello' },
      noopLogger,
    );

    const events = await collectEvents(handle.events);
    expect(events.some((e) => e.type === 'error' && e.code === 'PROVIDER_NOT_INSTALLED')).toBe(true);
  });

  it('cancels a long-running session and terminates the child process', async () => {
    const handle = runProviderSession(
      {
        providerId: 'codex',
        executableNames: [process.execPath],
        buildArgs: () => [join(fixturesDir, 'fake-hang.mjs')],
        parseLine: parseCodexLine,
      },
      { sessionId: 'test-session-6', cwd, prompt: 'hello' },
      noopLogger,
    );

    const collected: AgentEvent[] = [];
    const iterator = handle.events;
    // Wait for the first event so we know the process has actually started.
    const first = await iterator.next();
    if (!first.done) collected.push(first.value);

    await handle.cancel();

    for await (const event of iterator) collected.push(event);

    expect(collected.at(-1)).toEqual({ type: 'session.cancelled' });
  }, 10_000);

  describe('prompt via stdin (AD-05)', () => {
    async function runStdinEcho(prompt: string) {
      const handle = runProviderSession(
        {
          providerId: 'claude',
          executableNames: [process.execPath],
          buildArgs: () => [join(fixturesDir, 'fake-stdin-echo.mjs')],
          parseLine: parseClaudeLine,
          promptViaStdin: true,
        },
        { sessionId: 'stdin-echo-session', cwd, prompt },
        noopLogger,
      );
      const events = await collectEvents(handle.events);
      const message = events.find((e) => e.type === 'assistant.message') as { text: string } | undefined;
      return { events, receivedText: message?.text };
    }

    it('delivers the prompt to the child over stdin, not argv, and it round-trips exactly', async () => {
      const { receivedText } = await runStdinEcho('a perfectly ordinary prompt');
      expect(receivedText).toBe('a perfectly ordinary prompt');
    });

    it('preserves spaces, quotes, and embedded newlines exactly', async () => {
      const prompt = 'line one\nline "two" with quotes\n  leading spaces and trailing   ';
      const { receivedText } = await runStdinEcho(prompt);
      expect(receivedText).toBe(prompt);
    });

    it('preserves multi-byte Unicode exactly', async () => {
      const prompt = 'emoji 🎉🚀, CJK 日本語テスト, accents café résumé';
      const { receivedText } = await runStdinEcho(prompt);
      expect(receivedText).toBe(prompt);
    });

    it('handles a prompt far larger than any argv limit (well past Windows argv ~32,767 chars)', async () => {
      const prompt = 'y'.repeat(200_000); // the shared schema's own max
      const { receivedText } = await runStdinEcho(prompt);
      expect(receivedText).toBe(prompt);
      expect(receivedText?.length).toBe(200_000);
    }, 10_000);

    it('still reaches session.completed normally with stdin transport', async () => {
      const { events } = await runStdinEcho('hi');
      expect(events.at(-1)).toMatchObject({ type: 'session.completed' });
    });

    it('cancellation still works when the prompt is delivered via stdin', async () => {
      const handle = runProviderSession(
        {
          providerId: 'claude',
          executableNames: [process.execPath],
          buildArgs: () => [join(fixturesDir, 'fake-hang.mjs')],
          parseLine: parseClaudeLine,
          promptViaStdin: true,
        },
        { sessionId: 'stdin-cancel-session', cwd, prompt: 'hi' },
        noopLogger,
      );
      const iterator = handle.events;
      const first = await iterator.next();
      const collected: AgentEvent[] = first.done ? [] : [first.value];

      await handle.cancel();
      for await (const event of iterator) collected.push(event);

      expect(collected.at(-1)).toEqual({ type: 'session.cancelled' });
    }, 10_000);
  });

  /**
   * ADI-14, the Codex half of the same guarantee, run end to end against a real spawned process
   * whose argv is built by the **real** `buildCodexArgs` rather than a test-local stand-in. The
   * fixture echoes back both its own argv and everything it read from stdin, so a single run proves
   * the two acceptance criteria together: the prompt arrives intact over stdin, and it appears
   * nowhere in the command line of the process that was actually created.
   */
  describe('codex prompt via stdin (ADI-14)', () => {
    async function runCodexStdinEcho(prompt: string, overrides: Partial<StartSessionOptions> = {}) {
      const handle = runProviderSession(
        {
          providerId: 'codex',
          executableNames: [process.execPath],
          // The fixture script stands in for the `codex` binary, and everything after it is the
          // genuine argv this adapter would hand the real CLI.
          buildArgs: (opts) => [join(fixturesDir, 'fake-codex-stdin-echo.mjs'), ...buildCodexArgs(opts)],
          parseLine: parseCodexLine,
          promptViaStdin: true,
        },
        { sessionId: 'codex-stdin-echo-session', cwd, prompt, ...overrides },
        noopLogger,
      );
      const events = await collectEvents(handle.events);
      const messages = events.filter((e) => e.type === 'assistant.message') as Array<{ text: string }>;
      return {
        events,
        // Emitted in this order by the fixture: argv first, then the stdin payload.
        childArgv: JSON.parse(messages[0]!.text) as string[],
        receivedPrompt: messages[1]?.text,
      };
    }

    it('delivers the prompt over stdin while the spawned process argv carries only the `-` placeholder', async () => {
      const prompt = 'a distinctive codex prompt that must not be visible in any process list';
      const { childArgv, receivedPrompt } = await runCodexStdinEcho(prompt);

      expect(receivedPrompt).toBe(prompt);
      expect(childArgv).toEqual(['exec', '-', '--json', '--skip-git-repo-check']);
      expect(childArgv.join(' ')).not.toContain(prompt);
    });

    it('does the same when resuming a prior thread', async () => {
      const prompt = 'a resumed codex prompt that must also stay off the command line';
      const { childArgv, receivedPrompt } = await runCodexStdinEcho(prompt, {
        resumeProviderSessionId: 'prior-thread-id',
      });

      expect(receivedPrompt).toBe(prompt);
      expect(childArgv).toEqual(['exec', 'resume', 'prior-thread-id', '-', '--json', '--skip-git-repo-check']);
      expect(childArgv.join(' ')).not.toContain(prompt);
    });

    it('preserves spaces, quotes, embedded newlines, and multi-byte Unicode exactly', async () => {
      const prompt = 'line one\nline "two" with quotes\n  emoji 🎉🚀, CJK 日本語テスト, café résumé   ';
      const { receivedPrompt } = await runCodexStdinEcho(prompt);
      expect(receivedPrompt).toBe(prompt);
    });

    it('carries a prompt that could never have been spawned as argv on Windows', async () => {
      // 200,000 characters: the shared request schema's own cap, and roughly six times Windows'
      // ~32,767-character CreateProcess command-line limit. Under the pre-ADI-14 argv shape this
      // exact request would have failed to spawn or silently truncated on this repo's primary
      // platform; here it round-trips byte for byte and the argv stays four short elements.
      const prompt = 'y'.repeat(200_000);
      const { childArgv, receivedPrompt } = await runCodexStdinEcho(prompt);

      expect(receivedPrompt).toBe(prompt);
      expect(receivedPrompt?.length).toBe(200_000);
      expect(childArgv.join(' ').length).toBeLessThan(100);
    }, 15_000);

    it('still reaches session.completed carrying the provider thread id', async () => {
      const { events } = await runCodexStdinEcho('hi');
      expect(events.at(-1)).toEqual({
        type: 'session.completed',
        providerSessionId: 'codex-stdin-echo-thread-id',
      });
    });
  });

  it('kills a grandchild process on cancellation, not just the direct child (no orphaned tool subprocess)', async () => {
    const markerPath = join(cwd, 'grandchild-marker.txt');

    const handle = runProviderSession(
      {
        providerId: 'codex',
        executableNames: [process.execPath],
        buildArgs: () => [join(fixturesDir, 'fake-spawns-grandchild.mjs'), markerPath],
        parseLine: parseCodexLine,
      },
      { sessionId: 'test-session-7', cwd, prompt: 'hello' },
      noopLogger,
    );

    const iterator = handle.events;

    // Wait until the grandchild has actually started writing its marker file (real spawn +
    // process startup latency, not just our own process.started event).
    const deadline = Date.now() + 5000;
    while (!existsSync(markerPath) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    expect(existsSync(markerPath)).toBe(true);

    await handle.cancel();
    // Drain remaining events so the session fully reaches its terminal state.
    for await (const _event of iterator) {
      // no-op; just drain
    }

    // The grandchild writes a fresh timestamp to the marker file every 100ms. If cancellation
    // only killed the direct child (e.g. `child.kill()` without process-tree/group semantics),
    // the grandchild would keep running and keep updating this file indefinitely.
    const valueRightAfterCancel = readFileSync(markerPath, 'utf8');
    await new Promise((resolve) => setTimeout(resolve, 1000));
    const valueOneSecondLater = readFileSync(markerPath, 'utf8');

    expect(valueOneSecondLater).toBe(valueRightAfterCancel);
  }, 15_000);
});
