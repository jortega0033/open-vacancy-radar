import { describe, expect, it } from 'vitest';
import {
  CLAUDE_HARDENED_DISALLOWED_TOOLS,
  CLAUDE_HARDENED_TOOLS,
  CLAUDE_HARDENING_ARGS,
  buildClaudeArgs,
} from '../src/providers/claude/build-args.js';

/**
 * The exact argv a v1 (non-hardened) Claude session produced *before* ADI-08b, transcribed from the
 * assertions that already existed in this file rather than regenerated from the current code.
 *
 * That provenance is the whole value of these two constants: a test that built its expectation by
 * calling `buildClaudeArgs` would pass no matter what the function did. These are the literal
 * strings the pre-change suite pinned, so "v1 is byte-identical" is checked against history.
 */
const V1_FRESH_ARGV = [
  '-p', '--input-format', 'text', '--output-format', 'stream-json', '--verbose', '--session-id', 'sess-1',
] as const;
const V1_RESUMED_ARGV = [
  '-p', '--input-format', 'text', '--output-format', 'stream-json', '--verbose', '--resume', 'thread-1',
] as const;

describe('buildClaudeArgs: prompt transport (AD-05)', () => {
  it('never includes the prompt anywhere in the returned argv', () => {
    const prompt = 'this exact string must never appear in argv, not even split across elements';
    const args = buildClaudeArgs({ sessionId: 'sess-1', cwd: '/tmp', prompt });
    expect(args.join(' ')).not.toContain(prompt);
    expect(args).not.toContain(prompt);
  });

  it('never includes the prompt when resuming either', () => {
    const prompt = 'a resumed-session prompt that must also stay out of argv';
    const args = buildClaudeArgs({ sessionId: 'sess-1', cwd: '/tmp', prompt, resumeProviderSessionId: 'thread-1' });
    expect(args.join(' ')).not.toContain(prompt);
  });

  it('still passes -p, explicit --input-format text, and the session-id/resume flags', () => {
    const fresh = buildClaudeArgs({ sessionId: 'sess-1', cwd: '/tmp', prompt: 'hi' });
    expect(fresh).toEqual(['-p', '--input-format', 'text', '--output-format', 'stream-json', '--verbose', '--session-id', 'sess-1']);

    const resumed = buildClaudeArgs({ sessionId: 'sess-1', cwd: '/tmp', prompt: 'hi', resumeProviderSessionId: 'thread-1' });
    expect(resumed).toEqual(['-p', '--input-format', 'text', '--output-format', 'stream-json', '--verbose', '--resume', 'thread-1']);
  });

  it('does not change shape based on prompt length: a huge prompt is still absent from argv', () => {
    const hugePrompt = 'x'.repeat(500_000); // well beyond Windows' ~32,767-char argv limit
    const args = buildClaudeArgs({ sessionId: 'sess-1', cwd: '/tmp', prompt: hugePrompt });
    expect(args.join('').length).toBeLessThan(200); // just the flags, nowhere near the prompt size
  });
});

describe('buildClaudeArgs: model selection', () => {
  it('omits --model entirely when no model is given', () => {
    const args = buildClaudeArgs({ sessionId: 'sess-1', cwd: '/tmp', prompt: 'hi' });
    expect(args).not.toContain('--model');
  });

  it('appends --model <value> verbatim, unvalidated, when a model is given', () => {
    const args = buildClaudeArgs({ sessionId: 'sess-1', cwd: '/tmp', prompt: 'hi', model: 'fable' });
    expect(args).toEqual(['-p', '--input-format', 'text', '--output-format', 'stream-json', '--verbose', '--session-id', 'sess-1', '--model', 'fable']);
  });

  it('still appends --model after --resume when both resuming and selecting a model', () => {
    const args = buildClaudeArgs({ sessionId: 'sess-1', cwd: '/tmp', prompt: 'hi', resumeProviderSessionId: 'thread-1', model: 'opus' });
    expect(args).toEqual(['-p', '--input-format', 'text', '--output-format', 'stream-json', '--verbose', '--resume', 'thread-1', '--model', 'opus']);
  });
});

/**
 * ADI-08b (issue #126). Every expected value here was verified against the real installed
 * `claude` 2.1.228 binary -- both its `--help` text and the `system`/`init` frame of an actually
 * executed hardened session -- not against documentation or assumption.
 */
describe('buildClaudeArgs: v1 stays byte-identical (ADI-08b)', () => {
  it('produces exactly the pre-ADI-08b argv when `hardened` is absent', () => {
    expect(buildClaudeArgs({ sessionId: 'sess-1', cwd: '/tmp', prompt: 'hi' })).toEqual([...V1_FRESH_ARGV]);
    expect(
      buildClaudeArgs({ sessionId: 'sess-1', cwd: '/tmp', prompt: 'hi', resumeProviderSessionId: 'thread-1' }),
    ).toEqual([...V1_RESUMED_ARGV]);
  });

  it('produces the same argv for an explicitly non-hardened session', () => {
    // `hardened: false` and an omitted `hardened` must be indistinguishable in the output. The
    // daemon omits the key for v1, but nothing in the type system stops a caller passing `false`.
    expect(buildClaudeArgs({ sessionId: 'sess-1', cwd: '/tmp', prompt: 'hi', hardened: false })).toEqual([
      ...V1_FRESH_ARGV,
    ]);
  });

  it('adds not one of the hardening flags to a v1 session, including with a model and a resume', () => {
    const everyV1Shape = [
      buildClaudeArgs({ sessionId: 'sess-1', cwd: '/tmp', prompt: 'hi' }),
      buildClaudeArgs({ sessionId: 'sess-1', cwd: '/tmp', prompt: 'hi', model: 'fable' }),
      buildClaudeArgs({ sessionId: 'sess-1', cwd: '/tmp', prompt: 'hi', resumeProviderSessionId: 'thread-1' }),
      buildClaudeArgs({ sessionId: 'sess-1', cwd: '/tmp', prompt: 'hi', resumeProviderSessionId: 'thread-1', model: 'opus' }),
    ];
    const hardeningFlags = [
      '--safe-mode',
      '--strict-mcp-config',
      '--setting-sources',
      '--disable-slash-commands',
      '--tools',
      '--disallowed-tools',
    ];
    for (const args of everyV1Shape) {
      for (const flag of hardeningFlags) expect(args).not.toContain(flag);
    }
  });
});

describe('buildClaudeArgs: hardened v2 sessions (ADI-08b)', () => {
  it('carries all six restriction flags with their reviewed values', () => {
    const args = buildClaudeArgs({ sessionId: 'sess-1', cwd: '/tmp', prompt: 'hi', hardened: true });

    // Asserted as adjacent flag/value pairs rather than by `toContain`, so a value landing next to
    // the wrong flag is a failure. `--setting-sources ""` in particular is only correct as a pair:
    // the empty string alone says nothing, and an omitted flag loads user+project+local settings.
    const pairAt = (flag: string): string | undefined => args[args.indexOf(flag) + 1];

    expect(args).toContain('--safe-mode');
    expect(args).toContain('--strict-mcp-config');
    expect(args).toContain('--disable-slash-commands');
    expect(pairAt('--setting-sources')).toBe('');
    expect(pairAt('--tools')).toBe('Read,Write,Edit,Glob,Grep,NotebookEdit,WebFetch,WebSearch');
    expect(pairAt('--disallowed-tools')).toBe('Bash,PowerShell');
  });

  it('denies both shells, because --safe-mode was verified NOT to disable either one', () => {
    // The real 2.1.228 binary run with `--safe-mode --strict-mcp-config --setting-sources ""
    // --disable-slash-commands` and no tool flags still reported both `Bash` and `PowerShell` in
    // its init frame -- matching that flag's own help text, "built-in tools ... work normally".
    // So these two names are the load-bearing part of the restriction, not decoration.
    expect(CLAUDE_HARDENED_DISALLOWED_TOOLS).toContain('Bash');
    expect(CLAUDE_HARDENED_DISALLOWED_TOOLS).toContain('PowerShell');
    // Neither shell may appear in the positive allowlist either.
    expect(CLAUDE_HARDENED_TOOLS).not.toContain('Bash');
    expect(CLAUDE_HARDENED_TOOLS).not.toContain('PowerShell');
  });

  it('grants no tool that spawns agents, schedules standing work, or egresses out of band', () => {
    // The categories the parent ticket's restriction rule names, plus the ones a per-session
    // workspace lease cannot bound. Each was present in a real `--safe-mode` session's tool list,
    // so excluding them is an actual removal rather than a no-op.
    for (const forbidden of [
      'Task', 'TaskCreate', 'TaskStop', 'Monitor', 'ToolSearch',
      'CronCreate', 'CronDelete', 'ScheduleWakeup', 'RemoteTrigger', 'Workflow',
      'Artifact', 'PushNotification', 'SendMessage', 'ReportFindings', 'DesignSync',
      'EnterWorktree', 'ExitWorktree', 'Skill',
    ]) {
      expect(CLAUDE_HARDENED_TOOLS).not.toContain(forbidden);
    }
  });

  it('appends hardening as a suffix, leaving the v1 prefix untouched', () => {
    const hardened = buildClaudeArgs({ sessionId: 'sess-1', cwd: '/tmp', prompt: 'hi', hardened: true });
    expect(hardened.slice(0, V1_FRESH_ARGV.length)).toEqual([...V1_FRESH_ARGV]);
    expect(hardened.slice(V1_FRESH_ARGV.length)).toEqual([...CLAUDE_HARDENING_ARGS]);
  });

  it('keeps --model ahead of the hardening suffix, so neither variadic tool flag can swallow it', () => {
    // `--tools` and `--disallowed-tools` are both declared `<tools...>`. A value appended *after*
    // them would be collected into them by the CLI's own parser.
    const args = buildClaudeArgs({ sessionId: 'sess-1', cwd: '/tmp', prompt: 'hi', model: 'fable', hardened: true });
    expect(args.indexOf('--model')).toBeLessThan(args.indexOf('--tools'));
    expect(args[args.indexOf('--model') + 1]).toBe('fable');
    // Nothing follows the final variadic flag's value.
    expect(args[args.length - 2]).toBe('--disallowed-tools');
  });

  it('still keeps the prompt out of argv when hardened', () => {
    const prompt = 'a hardened-session prompt that must also stay out of argv';
    expect(buildClaudeArgs({ sessionId: 'sess-1', cwd: '/tmp', prompt, hardened: true }).join(' ')).not.toContain(prompt);
  });

  it('is a frozen constant, so no caller can compose a weaker hardening set', () => {
    expect(Object.isFrozen(CLAUDE_HARDENING_ARGS)).toBe(true);
  });
});
