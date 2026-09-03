import { describe, expect, it } from 'vitest';
import {
  CODEX_STDIN_PROMPT_PLACEHOLDER,
  buildCodexArgs,
} from '../src/providers/codex/build-args.js';

/**
 * ADI-14. Mirrors `claude-build-args.test.ts`'s "prompt transport" section: the single fact these
 * assert is that the user's prompt is not an argv element, for either session shape.
 *
 * Both expected argv arrays were checked against the real installed `codex-cli 0.147.0` binary, not
 * just against `--help`: each parses successfully and then fails with Codex's own
 * `No prompt provided via stdin.` when handed an empty stdin, which is what proves the `-` in the
 * prompt position both parses as the `[PROMPT]` positional and switches the CLI to reading stdin.
 */
const FRESH_ARGV = ['exec', '-', '--json', '--skip-git-repo-check'] as const;
const RESUMED_ARGV = ['exec', 'resume', 'thread-1', '-', '--json', '--skip-git-repo-check'] as const;

describe('buildCodexArgs: prompt transport (ADI-14)', () => {
  it('never includes the prompt anywhere in the returned argv', () => {
    const prompt = 'this exact string must never appear in argv, not even split across elements';
    const args = buildCodexArgs({ sessionId: 'sess-1', cwd: '/tmp', prompt });
    expect(args.join(' ')).not.toContain(prompt);
    expect(args).not.toContain(prompt);
  });

  it('never includes the prompt when resuming either', () => {
    const prompt = 'a resumed-session prompt that must also stay out of argv';
    const args = buildCodexArgs({
      sessionId: 'sess-1',
      cwd: '/tmp',
      prompt,
      resumeProviderSessionId: 'thread-1',
    });
    expect(args.join(' ')).not.toContain(prompt);
    expect(args).not.toContain(prompt);
  });

  it('puts the documented `-` stdin placeholder in the prompt position, fresh and resumed', () => {
    expect(buildCodexArgs({ sessionId: 'sess-1', cwd: '/tmp', prompt: 'hi' })).toEqual([...FRESH_ARGV]);
    expect(
      buildCodexArgs({ sessionId: 'sess-1', cwd: '/tmp', prompt: 'hi', resumeProviderSessionId: 'thread-1' }),
    ).toEqual([...RESUMED_ARGV]);
    expect(CODEX_STDIN_PROMPT_PLACEHOLDER).toBe('-');
  });

  it('keeps the placeholder in exactly the argv slot the raw prompt used to occupy', () => {
    // Pre-ADI-14 the fresh shape was ['exec', <prompt>, '--json', '--skip-git-repo-check'] and the
    // resumed one ['exec', 'resume', <id>, <prompt>, ...]. Asserting the index rather than mere
    // membership is what proves this is a substitution, not a flag appended somewhere harmless.
    const fresh = buildCodexArgs({ sessionId: 'sess-1', cwd: '/tmp', prompt: 'hi' });
    expect(fresh[1]).toBe(CODEX_STDIN_PROMPT_PLACEHOLDER);

    const resumed = buildCodexArgs({
      sessionId: 'sess-1',
      cwd: '/tmp',
      prompt: 'hi',
      resumeProviderSessionId: 'thread-1',
    });
    expect(resumed[3]).toBe(CODEX_STDIN_PROMPT_PLACEHOLDER);
    // The placeholder must not be mistaken for the session id, which stays a real argv element.
    expect(resumed[2]).toBe('thread-1');
  });

  it('does not change shape based on prompt length: a huge prompt is still absent from argv', () => {
    // 500,000 chars: well past Windows' ~32,767-character CreateProcess command-line limit, and
    // past the 200,000-character cap `packages/shared/src/schemas.ts` permits. Under the old argv
    // shape this argv could not have been spawned at all on this repo's primary platform.
    const hugePrompt = 'x'.repeat(500_000);
    const fresh = buildCodexArgs({ sessionId: 'sess-1', cwd: '/tmp', prompt: hugePrompt });
    const resumed = buildCodexArgs({
      sessionId: 'sess-1',
      cwd: '/tmp',
      prompt: hugePrompt,
      resumeProviderSessionId: 'thread-1',
    });
    expect(fresh.join('').length).toBeLessThan(200);
    expect(resumed.join('').length).toBeLessThan(200);
    expect(fresh).toEqual([...FRESH_ARGV]);
    expect(resumed).toEqual([...RESUMED_ARGV]);
  });

  it('ignores `hardened`, which Codex has no reviewed restriction profile for', () => {
    // Stated so a future Codex hardening profile has to change a test rather than land silently.
    expect(buildCodexArgs({ sessionId: 'sess-1', cwd: '/tmp', prompt: 'hi', hardened: true })).toEqual([
      ...FRESH_ARGV,
    ]);
  });
});
