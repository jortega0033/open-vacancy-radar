import type { StartSessionOptions } from '../../types.js';

/**
 * Pure argv construction for `claude -p ...`, extracted from adapter.ts so it can be unit- and
 * contract-tested without spawning a process (in particular, the resume-vs-fresh-session
 * branching. See the provider contract suite's "resume" section).
 *
 * The prompt is deliberately NOT one of these argv elements: it's written to the child's stdin
 * instead (see `runProviderSession`'s `promptViaStdin`, wired in adapter.ts). Two reasons: an
 * argv element has to fit Windows' `CreateProcess` command-line limit (~32,767 characters), well
 * under what the shared request schema permits, and an argv-passed prompt is visible to any
 * same-user process via `ps`/Task Manager's command line column for the process's whole
 * lifetime. `--input-format text` makes the stdin-reads-the-prompt behavior explicit rather than
 * relying on it being `-p`'s undocumented default.
 *
 * `opts.hardened` appends `CLAUDE_HARDENING_ARGS` (ADI-08b) and is the only thing in this function
 * that is not v1 behavior. It is a suffix rather than a prefix so that when it is unset — which is
 * every v1 caller — the returned array is not merely equivalent to the pre-ADI-08b one but produced
 * by the same statements in the same order.
 */
export function buildClaudeArgs(opts: StartSessionOptions): string[] {
  const args = ['-p', '--input-format', 'text', '--output-format', 'stream-json', '--verbose'];
  if (opts.resumeProviderSessionId) {
    args.push('--resume', opts.resumeProviderSessionId);
  } else {
    args.push('--session-id', opts.sessionId);
  }
  if (opts.model) {
    args.push('--model', opts.model);
  }
  if (opts.hardened) {
    args.push(...CLAUDE_HARDENING_ARGS);
  }
  return args;
}

/**
 * The reviewed built-in tools a hardened session keeps (ADI-08b).
 *
 * `--tools` is an **allowlist**, and that direction is the point: it is stated positively so that a
 * built-in tool introduced by a future `claude` release is not granted by default. Verified once,
 * manually, against the real 2.1.228 binary — an unrecognized name in this list was silently dropped
 * rather than causing the whole flag to be ignored, so the failure mode of drift here is fail-closed
 * (a tool this repo expected goes missing) and never fail-open (a tool it never reviewed appears).
 *
 * That verification is NOT re-run by CI or any automated test — this repo's test suites deliberately
 * never install or invoke a real Claude/Codex CLI (see CONTRIBUTING.md's testing-requirements
 * section), the same reason `compatibility-manifest.ts`'s version pins are exact-match rather than
 * live-checked. Re-verify this specific claim by hand whenever `CLAUDE_LEGACY_COMPATIBILITY`'s
 * pinned version changes, the same discipline already required for the rest of that manifest.
 *
 * What is excluded, and why:
 *
 * - `Bash`, `PowerShell` — the rule's explicit concern. Also denied a second time, independently,
 *   via `--disallowed-tools`; see below.
 * - `Task`, `Task*`, `Monitor`, `ToolSearch` — sub-agent spawning and background-task machinery.
 *   "agents" in the parent ticket's restriction rule.
 * - `CronCreate`/`CronDelete`/`CronList`, `ScheduleWakeup`, `RemoteTrigger`, `Workflow` — these
 *   create *standing* state that outlives the session, which is exactly the kind of persistent
 *   configuration a per-session workspace lease cannot bound.
 * - `Artifact`, `PushNotification`, `SendMessage`, `ReportFindings`, `DesignSync` — out-of-band
 *   egress channels that publish outside the daemon's own event stream.
 * - `EnterWorktree`/`ExitWorktree` — a git worktree is a second directory. A v2 session holds an
 *   exclusive *workspace* lease (`workspaceLeaseModeFor('legacy-one-shot')` is `'write'`), and a
 *   worktree is a supported way to write outside the folder that lease describes.
 *
 * `WebFetch` and `WebSearch` are the one egress this list does permit, deliberately: they are
 * read-only network reads and this product's sessions exist to research live job postings. They are
 * listed here rather than assumed so that removing them is a one-line, reviewable decision.
 *
 * This is a real, named residual risk, not an oversight: a hardened session both reads untrusted
 * content (a scraped job posting can contain injected instructions) and can `WebFetch` an arbitrary
 * URL. Nothing in this allowlist stops an injected instruction from telling the session to `Read` a
 * workspace file and `WebFetch` a URL with that content encoded in the query string -- "hardened"
 * denies shells and standing configuration, it does not sandbox network egress. This is not a new
 * exposure this ticket introduces (v1 sessions already have the same shape), but the label invites a
 * stronger reading than what is delivered, so it is written down here rather than left implicit.
 */
export const CLAUDE_HARDENED_TOOLS = [
  'Read',
  'Write',
  'Edit',
  'Glob',
  'Grep',
  'NotebookEdit',
  'WebFetch',
  'WebSearch',
] as const;

/** Shell tools, denied explicitly and independently of the `--tools` allowlist. */
export const CLAUDE_HARDENED_DISALLOWED_TOOLS = ['Bash', 'PowerShell'] as const;

/**
 * The frozen argv suffix a hardened Claude session appends (ADI-08b, issue #126).
 *
 * This is the **whole** of what "hardened" means for this provider: a constant, not a builder. It
 * takes no input from the request, so there is no value a caller can supply that produces a weaker
 * set, and a test can compare against it by identity.
 *
 * Every claim below is quoted from `claude --help` on the pinned 2.1.228 build (the version
 * `CLAUDE_LEGACY_COMPATIBILITY` pins) and was additionally verified end-to-end by reading the
 * `system`/`init` frame of a real hardened session:
 *
 * - `--safe-mode` — "Start with all customizations (CLAUDE.md, skills, plugins, hooks, MCP servers,
 *   custom commands and agents, output styles, workflows, custom themes, keybindings, and more)
 *   disabled". Crucially it also promises "Auth, model selection, built-in tools, and permissions
 *   work normally", which is why it can be used without touching how the CLI authenticates.
 * - `--strict-mcp-config` — "Only use MCP servers from --mcp-config, ignoring all other MCP
 *   configurations". This adapter passes no `--mcp-config`, so the reachable set is empty. It is
 *   redundant with `--safe-mode` today and kept anyway: two independent statements of "no MCP", so
 *   that a future change to either one cannot silently re-enable MCP on its own.
 * - `--setting-sources ""` — "Comma-separated list of setting sources to load (user, project,
 *   local)." The empty string is the most restrictive real value: load none of the three. Verified
 *   to be *validated* rather than ignored — `--setting-sources bogus` is rejected with "Invalid
 *   setting source: bogus. Valid options are: user, project, local", while `""` is accepted. Its
 *   observable effect is real: an unhardened session in the same folder picked up the host user's
 *   configured model from `settings.json`, and the hardened one did not.
 * - `--disable-slash-commands` — "Disable all skills".
 * - `--tools` / `--disallowed-tools` — see the two constants above.
 *
 * **`--safe-mode` alone does not disable `Bash`, and this was checked rather than assumed.** A
 * session started with `--safe-mode --strict-mcp-config --setting-sources "" --disable-slash-commands`
 * and no tool flags still reported both `Bash` and `PowerShell` in its `init` frame — exactly as
 * that flag's own help text says it would ("built-in tools ... work normally"). The two tool flags
 * are therefore load-bearing, not decorative, and `PowerShell` must be named alongside `Bash`
 * because this daemon's primary platform is Windows, where it is a second, equally capable shell.
 *
 * ---------------------------------------------------------------------------------------------
 * DO NOT ADD --bare HERE. Not as a hardening measure, not "while we're at it".
 * ---------------------------------------------------------------------------------------------
 *
 * --bare looks like a stronger `--safe-mode` and is not interchangeable with it. Its own help
 * text on this same 2.1.228 build reads:
 *
 *   "Minimal mode: skip hooks, LSP, plugin sync, attribution, auto-memory, background prefetches,
 *    keychain reads, and CLAUDE.md auto-discovery. Sets CLAUDE_CODE_SIMPLE=1. **Anthropic auth is
 *    strictly ANTHROPIC_API_KEY or apiKeyHelper via --settings (OAuth and keychain are never
 *    read).**"
 *
 * That emphasized sentence is disqualifying. This repo's standing invariant is that it never reads
 * Claude's credential storage and never supplies an API key — see SECURITY.md ("What the daemon
 * will never do": *Read a Claude/Codex/any-provider credential file, keychain entry, or OAuth token
 * directly*) and `adapter.ts`'s own doc comment ("Authentication is entirely owned by the `claude`
 * binary. This adapter never reads Claude's credential storage and never passes an API key.").
 *
 * Under --bare the CLI stops reading the OAuth session the user already established, so the only
 * way to make a session authenticate at all would be for this daemon to obtain and pass an
 * `ANTHROPIC_API_KEY` — that is, to start doing the one thing it promises it does not do. Adopting
 * --bare would not be a tightening; it would convert an adapter that handles no credentials into
 * one that must handle a long-lived secret.
 *
 * The properties --bare would add over `--safe-mode` (skipping LSP, attribution, background
 * prefetches) are not security properties this ticket asked for. `--safe-mode` was confirmed to
 * preserve auth in practice: a hardened session's `init` frame reports `"apiKeySource":"none"`,
 * i.e. it authenticated with no API key involved.
 *
 * `claude-bare-prohibition.test.ts` enforces this across the repo, so this comment is a rationale,
 * not the control. That test scans for the flag in *quoted* form (the only form in which it could
 * ever reach an argv array), which is why every mention of it above is written bare and unquoted --
 * including without backticks, since a backtick-quoted mention is indistinguishable from a template
 * literal. Keep it that way: wrapping it in quotes here would make this comment fail that test.
 */
export const CLAUDE_HARDENING_ARGS: readonly string[] = Object.freeze([
  '--safe-mode',
  '--strict-mcp-config',
  // Empty string, not an omitted flag: omitting it loads user+project+local settings.
  '--setting-sources',
  '',
  '--disable-slash-commands',
  // Both are variadic (`<tools...>`) and accept a comma-separated value in a single argv element.
  // Passing one joined element rather than several bare words keeps them from swallowing any
  // argv that might later be appended after this suffix.
  '--tools',
  CLAUDE_HARDENED_TOOLS.join(','),
  '--disallowed-tools',
  CLAUDE_HARDENED_DISALLOWED_TOOLS.join(','),
]);
