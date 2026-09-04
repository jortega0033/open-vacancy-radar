import type { StartSessionOptions } from '../../types.js';

/**
 * The placeholder Codex accepts in its `[PROMPT]` positional to mean "read the instructions from
 * stdin instead". Not a guess and not the generic Unix convention taken on faith: it is the exact
 * behavior `codex exec --help` documents on the pinned 0.147.0 build this repo is verified against.
 *
 *   [PROMPT]
 *       Initial instructions for the agent. If not provided as an argument (or if `-` is used),
 *       instructions are read from stdin. ...
 *
 * and, for the resume subcommand (`codex exec resume --help`):
 *
 *   [PROMPT]
 *       Prompt to send after resuming the session. If `-` is used, read from stdin
 *
 * Both shapes were additionally exercised against the real installed binary rather than read only
 * from help text: `codex exec - --json --skip-git-repo-check` and
 * `codex exec resume <uuid> - --json --skip-git-repo-check`, each fed an empty stdin, both parse
 * their argv successfully and then fail with Codex's own `No prompt provided via stdin.` — which
 * is positive proof that the `-` was accepted as the prompt positional AND that it switched the
 * CLI into reading the prompt from stdin.
 */
export const CODEX_STDIN_PROMPT_PLACEHOLDER = '-';

/**
 * Pure argv construction for `codex exec ...`, extracted from adapter.ts so it can be unit- and
 * contract-tested without spawning a process (in particular, the resume-vs-fresh-session
 * branching. See the provider contract suite's "resume" section).
 *
 * The prompt is deliberately NOT one of these argv elements (ADI-14): `CODEX_STDIN_PROMPT_PLACEHOLDER`
 * stands in its position and the prompt itself is written to the child's stdin instead (see
 * `runProviderSession`'s `promptViaStdin`, wired in adapter.ts). This mirrors what
 * `providers/claude/build-args.ts` has always done, for the same two reasons:
 *
 * - An argv element has to fit Windows' `CreateProcess` command-line limit (~32,767 characters for
 *   the whole command line), while `packages/shared/src/schemas.ts` permits a 200,000-character
 *   prompt. Passing the prompt in argv meant a long-enough request could truncate or fail to spawn
 *   outright on this repo's primary platform. Moving it to stdin is what makes that cap safe to use.
 * - An argv-passed prompt is readable by any same-user process for the entire lifetime of the
 *   child (Task Manager's command-line column, `wmic process`, `ps`), not just transiently at
 *   spawn. For this product that string routinely contains the user's CV text and a scraped
 *   vacancy description, so this was a real disclosure of personal data, not a theoretical one.
 *
 * Argument order is otherwise unchanged from the pre-ADI-14 shape: the placeholder occupies exactly
 * the position the raw prompt used to, so the only difference in the spawned command line is which
 * string sits in the prompt slot.
 */
/**
 * Issue #174. Codex has no analogue of Claude's `CLAUDE_HARDENED_TOOLS`/`CLAUDE_HARDENING_ARGS`
 * (`opts.hardened` is read nowhere in this file, and stays that way -- see the doc comment on
 * `buildCodexArgs` below for why). This flag closes the one concrete, verifiable gap that exists
 * regardless: without it, a session silently loads `$CODEX_HOME/config.toml`, which can set
 * `sandbox_permissions`/`shell_environment_policy` to anything, including full disk/network
 * access -- an arbitrary, host-specific configuration a session should not inherit unannounced.
 * `codex exec --help` on the pinned 0.147.0 build: "Do not load `$CODEX_HOME/config.toml`; auth
 * still uses `CODEX_HOME`", so this does not disturb the allowlisted `CODEX_HOME`-based auth in
 * `provider-environment.ts`. Unconditional, not gated behind `opts.hardened`, on the same
 * reasoning #173 applied to Claude: there is no session for which inheriting an arbitrary host
 * config is the desired behavior.
 */
const CODEX_IGNORE_USER_CONFIG_ARG = '--ignore-user-config';

export function buildCodexArgs(opts: StartSessionOptions): string[] {
  if (opts.resumeProviderSessionId) {
    return [
      'exec',
      'resume',
      opts.resumeProviderSessionId,
      CODEX_STDIN_PROMPT_PLACEHOLDER,
      '--json',
      '--skip-git-repo-check',
      CODEX_IGNORE_USER_CONFIG_ARG,
    ];
  }
  return [
    'exec',
    CODEX_STDIN_PROMPT_PLACEHOLDER,
    '--json',
    '--skip-git-repo-check',
    CODEX_IGNORE_USER_CONFIG_ARG,
  ];
}
