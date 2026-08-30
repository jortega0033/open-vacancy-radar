# Providers

## The `AgentProvider` interface

Every provider adapter (`packages/agent-runtime/src/providers/*/adapter.ts`) implements one
interface (`packages/agent-runtime/src/types.ts`):

```ts
interface AgentProvider {
  readonly id: ProviderId;
  readonly name: string;
  detect(): Promise<ProviderStatus>;
  startSession(options: StartSessionOptions): ProviderSessionHandle;
}
```

An implementation handles executable discovery, command construction, process spawning, output
parsing, and normalization into `AgentEvent`. Code outside `packages/agent-runtime` should not need
to know a provider's native event shape. Each adapter normalizes its output into the shared
`AgentEvent` union documented in
[protocol-v1.md](protocol-v1.md). In practice, an adapter doesn't implement spawning/parsing
directly. It delegates to the shared `runProviderSession()` helper (see
[architecture.md#process-management](architecture.md#process-management)) and supplies only
`buildArgs()` and `parseLine()`, the two provider-specific pure functions.

## Executable discovery

`findExecutable()` (`packages/agent-runtime/src/detect-executable.ts`) does not assume the CLI is
on whatever `PATH` the daemon inherited. A GUI app's `PATH` frequently differs from an
interactive login shell's, especially on macOS. It:

1. Tries a PATH lookup (`where` on Windows or `which` on POSIX), without invoking a shell.
2. Falls back to a short, curated list of directories CLI installers commonly use, per
   `commonInstallDirs()`: `~/.local/bin`, `/usr/local/bin`, `/opt/homebrew/bin`,
   `~/.npm-global/bin` on macOS; `~/.local/bin`, `%LOCALAPPDATA%\Programs\OpenAI\Codex\bin`,
   `%APPDATA%\npm` on Windows; `~/.local/bin`, `/usr/local/bin`, `/usr/bin` on Linux.

This was verified against local installations during development. On the development machine,
`claude` resolved to `~/.local/bin/claude.exe` and `codex` to
`%LOCALAPPDATA%\Programs\OpenAI\Codex\bin\codex.exe`, neither of which is a path you'd want to
hardcode. The discovery logic checks common installation paths instead.

An NSIS-installed build launched from the Start Menu also found and reported both CLIs. It did not
inherit a terminal session's `PATH`. Packaging does not change the discovery logic, but the
inherited environment can differ from a terminal's, so both launch paths were tested.

## `ProviderStatus`

```ts
type AuthStatus = 'authenticated' | 'unauthenticated' | 'unknown';

type ProviderStatus = {
  id: 'claude' | 'codex';
  name: string;
  installed: boolean;
  authenticated: AuthStatus;
  capabilities: ProviderCapabilities;
  executablePath?: string;
  version?: string;
  error?: string;
};
```

`AuthStatus` is a three-value string union with no boolean member. It used to be
`boolean | 'unknown'`, which allowed `if (status.authenticated)` to treat an unknown result as
authenticated. The current type requires consumers to write
`status.authenticated === 'authenticated'` explicitly. `'unknown'` is a distinct state. A check
that failed, timed out, or returned output the adapter could not parse is reported as unknown and
is never coerced to `'authenticated'`. The
desktop UI is expected to route a user through the CLI's own login flow whenever `installed` is
true but `authenticated` isn't `'authenticated'`.

## Provider capabilities

```ts
interface ProviderCapabilities {
  resume?: boolean;
  cancellation?: boolean;
  tools?: boolean;
  usage?: boolean;
  thinking?: boolean;
  [futureCapability: string]: boolean | undefined;
}
```

`capabilities` describes what **this adapter implements**, not every feature of the underlying
model. A field is `true` only if the adapter implements and normalizes that behavior. This lets a
downstream client ask "does this provider support resume"
instead of writing `if (provider.id === 'claude')`.

Every known key is optional. **An absent key means unsupported, like `false`.** Adding a sixth
capability later doesn't break a client built against today's five-key shape. The wire schema
(`providerCapabilitiesSchema` in `packages/shared/src/schemas.ts`) matches: every known key is
`.optional()`, and unknown keys pass through validation via `.catchall(z.boolean())` rather than
being rejected or silently stripped, so an older client can still receive a new capability from
the daemon. Keep capability values as optional booleans. A provider-specific extension that does
not fit a
boolean belongs in a namespaced extension field on `ProviderStatus`, not a new top-level capability
key.

Both current adapters (`providers/claude/capabilities.ts`, `providers/codex/capabilities.ts`)
declare every field `true`. Each value corresponds to implemented behavior:

| Capability | Claude | Codex | Why |
|---|---|---|---|
| `resume` | ✅ | ✅ | `--resume <id>` / `exec resume <id>`. Argv construction unit-tested (`build-args.ts`); wired end to end through `POST /sessions`'s `resumeProviderSessionId`, which the daemon rejects with `400` for a provider whose `capabilities.resume` is `false` |
| `cancellation` | ✅ | ✅ | Both go through the shared `runProviderSession()` process-tree kill. See [Process management](architecture.md#process-management) |
| `tools` | ✅ | ✅ | Claude's `tool_use`/`tool_result` blocks and Codex's `command_execution`/`file_change`/`mcp_tool_call` items both normalize to `tool.started`/`tool.completed` |
| `usage` | ✅ | ✅ | Claude's `message.usage`/`result.usage` and Codex's `turn.completed.usage` both normalize to `usage` events |
| `thinking` | ✅ | ✅ | Claude's `thinking` content blocks and Codex's `reasoning` items both normalize to `thinking.delta`. The event appears only when the CLI's own extended-thinking or reasoning-effort configuration produces one; `true` means the adapter passes it through when present, not that it is always present |

`FakeProvider` (used across the test suite) declares `resume: false`, `tools: false`, and
`thinking: false`. This lets tests confirm that capability-gated behavior uses the flag instead of
always running
(see [Provider contract tests](#provider-contract-tests) below).

Add a capability field only when it corresponds to behavior a real adapter already implements.
`modelSelection`, `fileEdits` as distinct from `tools`, and similar fields were left out for
v0.2. Callers can pass a model through `CreateSessionInput.model`, but the capability response does
not advertise model discovery or selection support. File-edit and command-execution distinctions
are already covered by the generic `tools` flag plus each tool event's own `toolName`.

## Claude Code adapter

`packages/agent-runtime/src/providers/claude/`

- **Detection**: `claude --version` for the version string, `claude auth status --json` for login
  state (`{ loggedIn: boolean, ... }`). See [`ProviderStatus`](#providerstatus) for how that maps
  to `AuthStatus`.
- **Execution**: `claude -p --input-format text --output-format stream-json --verbose`, plus either
  `--session-id <daemon-uuid>` on a fresh session or `--resume <providerSessionId>` when resuming
  (argv construction is in `build-args.ts`, unit- and contract-tested independently of spawning a
  process). Passing the daemon UUID as `--session-id` means the daemon's session id and Claude's
  session id are the same value from the start, instead of needing to reconcile two ids after the
  fact. Resuming is reachable end to end via `POST /sessions`'s `resumeProviderSessionId` field.
  **The prompt itself is not an argv element**. It's written to the child's stdin and the stdin
  stream is then closed (`run-session.ts`'s `promptViaStdin` config, only set for Claude). Two
  reasons: an argv element must fit inside Windows' `CreateProcess` command-line limit (~32,767
  characters), below the 200,000 characters permitted by the shared request schema, and an argv-passed
  prompt is visible to any same-user process for the whole life of the process (`ps`/Task
  Manager's command-line column) for the life of the process.
- **Parsing** (`parser.ts`): maps `system`/`init` → captures the session id; `assistant`/`user`
  message content blocks (`text`, `thinking`, `tool_use`, `tool_result`) → `assistant.message` /
  `thinking.delta` / `tool.started` / `tool.completed`; `result` → a `usage` event (with
  `total_cost_usd` as `cost`) and, if `is_error` is set, an `error` event. Claude emits a `usage`
  event on every `assistant`/`user` line *and* again on the final `result` line. One session
  produces several `usage` events, not one; see [Protocol v1](protocol-v1.md) for why a consumer
  should never treat a single `usage` event as a session total.
- This project intentionally does **not** pass `--include-partial-messages`: without it, Claude
  Code emits one complete `assistant` message per turn instead of a token-by-token delta stream.
  Protocol v1 has no token-streaming event variant. An earlier `assistant.delta` placeholder was
  removed before an adapter emitted it; see [Protocol v1](protocol-v1.md). If an adapter later
  needs token streaming, add a defined event at that point.

Verified manually against an authenticated `claude` CLI during development (see the project's
technical report or commit history for the transcript). The daemon started a session,
Claude's response and token usage came back as normalized events, and the session reached
`session.completed` with no API key ever requested.

## Codex adapter

`packages/agent-runtime/src/providers/codex/`

- **Detection**: `codex --version`; `codex login status`, whose output is a short human-readable
  line (`"Logged in using ChatGPT"`, `"Logged in using API key"`, or a not-logged-in variant)
  rather than JSON. The parser matches conservatively and falls back to `'unknown'` rather than
  guessing when the text doesn't clearly say one way or the other.
- **Execution**: `codex exec <prompt> --json --skip-git-repo-check`, or
  `codex exec resume <providerSessionId> <prompt> --json --skip-git-repo-check` to continue a
  prior thread (argv construction is in `build-args.ts`). `--skip-git-repo-check` is required
  because a session's working directory is whatever the user picked, not necessarily a git
  repository. Resuming is reachable end to end via `POST /sessions`'s `resumeProviderSessionId` field.
- **Parsing** (`parser.ts`): `thread.started` → captures the thread id as `providerSessionId`;
  `item.started` / `item.completed` → `tool.started` / `tool.completed` for `command_execution`,
  `file_change`, and `mcp_tool_call` items, `assistant.message` for a completed `agent_message`
  item, `thinking.delta` for `reasoning` items; `turn.completed.usage` → a `usage` event;
  `turn.failed` → a fatal `error` event. A completed item of type `error` (Codex uses this for
  non-fatal warnings, e.g. a local config quirk, that don't stop the turn) is normalized as
  `recoverable: true`, unlike `turn.failed` which is not.

Verified manually with an authenticated `codex` CLI. It produced a response through the daemon,
adapter, and SSE pipeline, including Codex's thread id as `providerSessionId`.

### Decision: stay on `codex exec --json` instead of migrating to `codex app-server` (AD-21)

Recorded against the CLI version used during the review:
**codex-cli 0.147.0**, which itself labels `app-server` `[experimental]` (with a further
stable and experimental split inside `app-server`). Revisit this decision if any of these four
conditions becomes true:

1. AgentDock needs interactive tool approvals. `codex exec --json` cannot provide them, and
   protocol v1 has no client-to-daemon response channel.
2. A real multi-turn conversational loop replaces the current one-shot "type a prompt, press Run"
   interface, and measurement shows that per-turn CLI startup is a bottleneck.
3. OpenAI drops the `[experimental]` label from `app-server` and publishes a stability policy.
4. `codex exec --json` is deprecated, or its output schema changes in a way this adapter cannot
   support.

None of the four applies today. A migration would replace per-session process isolation and the
"one terminal event, always last" guarantee derived by `runProviderSession()` from process exit.
The Codex adapter would need to reproduce both at the RPC layer. `app-server` also adds
bidirectional JSON-RPC, session multiplexing, and approval and interrupt flows, making this
adapter differ substantially from the one-adapter-per-provider pattern used elsewhere in the
repository.

**Correction to an earlier claim in this doc**: a migration to `app-server` was previously
described as touching only `buildArgs`/`parseLine`. That understates it. `runProviderSession()`
closes stdin immediately after spawn, reads a one-way JSONL stream to completion, and derives the
terminal event from process exit. `app-server` violates three of those four assumptions (it's
bidirectional, long-lived, and multiplexes sessions rather than one-process-per-session), so a real
migration would need new process-lifecycle handling in the shared runner, not just two swapped-out
functions.

`ProviderSessionHandle` and `AgentEvent` themselves would not need to change. The public
provider-neutral abstraction can support a later transport change, so this migration can wait
until one of the conditions above applies.

## Provider contract tests

`packages/agent-runtime/test/support/provider-contract.ts` exports `describeProviderContract()`.
It is a reusable Vitest suite for the guarantees every adapter must uphold. It runs each adapter's
`parseLine` and `buildArgs` functions, with a small `node` fixture script representing the CLI
binary. `test/claude-contract.test.ts` and
`test/codex-contract.test.ts` are ~15-line call sites that just supply each provider's fixtures and
declared capabilities. See either for the pattern to copy for a new provider.

It checks that `session.started` is emitted first and tagged with the correct provider; a
nonexistent working directory is rejected before the CLI starts; no raw or unrecognized
provider-native event type reaches the normalized stream; an unrecognized event kind does not
crash the session; assistant output normalizes; tool events normalize *only when
`capabilities.tools` says they should*, same for `usage`; exactly one terminal event occurs, always
last, carrying the provider session id on success; cancellation (gated on `capabilities.cancellation`)
terminates the process and prevents `session.completed` from following `session.cancelled`; resume (gated
on `capabilities.resume`) produces an argv that references the prior provider session id and
differs from a fresh session's argv.

It lives under `test/support/`, not `src/`. It is a Vitest-specific test helper, not part of this
package's public runtime API, so it isn't exported from `index.ts`. A provider adapter maintained
outside this repo would copy the pattern rather than import the file directly.

Both `ClaudeProvider` and `CodexProvider` pass the suite. Run
`pnpm --filter @agent-dock/agent-runtime test` for the current test count. Provider-specific
parsing detail (the exact Claude/Codex JSONL shapes) stays in `test/claude-parser.test.ts` /
`test/codex-parser.test.ts`, which the contract suite doesn't replace. Both providers' `detect()`
auth parsing also has dedicated pure-function tests independent of the contract suite. See
`test/claude-detect.test.ts` / `test/codex-detect.test.ts`.

## Adding a new provider

Adding `GeminiProvider` should not require provider-specific daemon routes, client methods, or
runtime-card markup. The shared provider ID and its display label still need updates:

1. **Register the ID.** Add `'gemini'` to `PROVIDER_IDS` in `packages/shared/src/provider.ts`, add
   its label in `apps/desktop/src/provider-labels.ts`, and update the related shared and desktop
   tests.
2. **Write `detect.ts`.** Resolve the executable (via `findExecutable`, see
   [Executable discovery](#executable-discovery)), get its version, and determine auth state.
   Report an indeterminate result as `'unknown'`, not `true` (see
   [`ProviderStatus`](#providerstatus)).
3. **Write `capabilities.ts`.** Declare a `ProviderCapabilities` object reflecting what you
   implemented in the steps below (see
   [Provider capabilities](#provider-capabilities)).
4. **Write `parser.ts`.** A pure function `(raw: unknown, logger: Logger) => ParsedLine` mapping
   the CLI's native JSONL shape into `AgentEvent[]`, matching the `ParsedLine` contract in
   `providers/common/run-session.ts`.
5. **Write `build-args.ts`.** A pure function `(opts: StartSessionOptions) => string[]`
   constructing the CLI's argv, branching on `opts.resumeProviderSessionId` if `capabilities.resume`
   is true.
6. **Write `adapter.ts`.** A class implementing `AgentProvider`
   (see [The `AgentProvider` interface](#the-agentprovider-interface)), delegating execution to the
   shared `runProviderSession()` helper. Validation, spawning, cancellation, and the
   completed, failed, or cancelled terminal-event guarantee are handled there; supply only
   `buildArgs` and `parseLine`.
7. **Write provider-specific parser tests**, and **run the shared provider contract suite.** Add
   parser tests against fixture JSON (see `test/codex-parser.test.ts` for the shape), then add
   `test/gemini-contract.test.ts` calling `describeProviderContract()` with your fixtures and
   capabilities (see [Provider contract tests](#provider-contract-tests)). Use a `node` fixture
   script to represent the CLI so CI does not need a Gemini account.
8. **Register it.** Add `new GeminiProvider(logger)` to `buildProviderRegistry()` in
   `apps/daemon/src/providers.ts`.

`GET /providers` picks it up automatically because it iterates the registry.
`@agent-dock/client` needs no provider-specific method once its shared `ProviderStatus` schema
accepts the new ID. The Runtime page maps the provider list dynamically, and event rendering works
for any provider because it switches only on `AgentEvent.type`.
