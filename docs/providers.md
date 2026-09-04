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

An implementation owns everything provider-specific: executable discovery, command construction,
process spawning, output parsing, and normalization into `AgentEvent`. Nothing outside
`packages/agent-runtime` should ever need to know a provider's native event shape; that's the whole
point of normalizing into the shared `AgentEvent` union documented in
[protocol-v1.md](protocol-v1.md). In practice, an adapter doesn't implement spawning/parsing
directly: it delegates to the shared `runProviderSession()` helper (see
[architecture.md#process-management](architecture.md#process-management)) and supplies only
`buildArgs()` and `parseLine()`, the two genuinely provider-specific pure functions.

## Executable discovery

`findExecutable()` (`packages/agent-runtime/src/detect-executable.ts`) does not assume the CLI is
on whatever `PATH` the daemon inherited: a GUI app's `PATH` frequently differs from an
interactive login shell's, especially on macOS. It:

1. Tries a real PATH lookup (`where` on Windows, `which` on POSIX, never a shell builtin like
   `command -v`, and never a shell at all).
2. Falls back to a short, curated list of directories CLI installers commonly use, per
   `commonInstallDirs()`: `~/.local/bin`, `/usr/local/bin`, `/opt/homebrew/bin`,
   `~/.npm-global/bin` on macOS; `~/.local/bin`, `%LOCALAPPDATA%\Programs\OpenAI\Codex\bin`,
   `%APPDATA%\npm` on Windows; `~/.local/bin`, `/usr/local/bin`, `/usr/bin` on Linux.

This was verified against real local installs during development: on this project's dev machine,
`claude` resolved to `~/.local/bin/claude.exe` and `codex` to
`%LOCALAPPDATA%\Programs\OpenAI\Codex\bin\codex.exe`, neither of which is a path you'd want to
hardcode, which is exactly why discovery works this way instead.

Re-verified after packaging: launched from the Start Menu shortcut of a real NSIS-installed build
(not a dev terminal, so not inheriting whatever `PATH` a shell session happens to have), the daemon
still found and correctly reported both CLIs. Discovery logic itself is unchanged by
packaging (it's the same `findExecutable()` call either way), but the *inherited environment* a
packaged app launches with genuinely can differ from a terminal's, which is exactly the scenario
this was built to handle, so it was worth confirming rather than assuming.

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

`AuthStatus` is deliberately a pure three-value string union with no boolean member. It used to be
`boolean | 'unknown'`, which let a lazy `if (status.authenticated)` silently treat "couldn't
determine" as authenticated, exactly backwards for a security-relevant signal, and bad enough
that the type's own docstring had to warn against the obvious usage. There is no shortcut with the
current shape: every consumer writes `status.authenticated === 'authenticated'` explicitly.
`'unknown'` is a distinct, first-class state: a check that failed, timed out, or returned output
the adapter couldn't parse is reported as unknown, **never** coerced to `'authenticated'`. The
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

`capabilities` describes what **this adapter implements**, not a marketing claim about the
underlying model: a field is `true` only if the codebase reliably implements and normalizes that
behavior today. This is what lets a downstream client ask "does this provider support resume"
instead of writing `if (provider.id === 'claude')`.

Every known key is optional, **absent means unsupported, exactly like `false`**, so adding a 6th
capability later doesn't break a client built against today's five-key shape. The wire schema
(`providerCapabilitiesSchema` in `packages/shared/src/schemas.ts`) matches: every known key is
`.optional()`, and unknown keys pass through validation via `.catchall(z.boolean())` rather than
being rejected or silently stripped, so a client one version behind a daemon that's grown a new
capability still gets to see it. Don't build a richer capability-descriptor shape than this:
plain optional booleans are the whole design; a provider-specific extension that doesn't fit a
boolean belongs in a namespaced extension field on `ProviderStatus`, not a new top-level capability
key.

Both current adapters (`providers/claude/capabilities.ts`, `providers/codex/capabilities.ts`)
declare every field `true`, and each is true for a specific, checkable reason, not because the two
CLIs happen to be similar:

| Capability | Claude | Codex | Why |
|---|---|---|---|
| `resume` | ✅ | ✅ | `--resume <id>` / `exec resume <id>`: argv construction unit-tested (`build-args.ts`); wired end to end through `POST /sessions`'s `resumeProviderSessionId`, which the daemon rejects with `400` for a provider whose `capabilities.resume` is `false` |
| `cancellation` | ✅ | ✅ | Both go through the shared `runProviderSession()` process-tree kill (see [Process management](architecture.md#process-management)) |
| `tools` | ✅ | ✅ | Claude's `tool_use`/`tool_result` blocks and Codex's `command_execution`/`file_change`/`mcp_tool_call` items both normalize to `tool.started`/`tool.completed` |
| `usage` | ✅ | ✅ | Claude's `message.usage`/`result.usage` and Codex's `turn.completed.usage` both normalize to `usage` events |
| `thinking` | ✅ | ✅ | Claude's `thinking` content blocks and Codex's `reasoning` items both normalize to `thinking.delta`: **only surfaced when the CLI's own extended-thinking/reasoning-effort configuration produces one**; a `true` here means "the adapter passes it through when present," not "always present" |

`FakeProvider` (used across the test suite) deliberately declares `resume: false`, `tools: false`,
`thinking: false` even though it *could* trivially fake any of them: the contrast is what lets
tests assert that capability-gated behavior actually gates on the flag instead of always running
(see [Provider contract tests](#provider-contract-tests) below).

Add a capability field only when it corresponds to behavior a real adapter already implements.
`modelSelection`, `fileEdits`-as-distinct-from-`tools`, and similar were considered and left out for
v0.2: neither adapter lets a caller pick a model via the API, and file-edit/command-execution
distinctions are already covered by the generic `tools` flag plus each tool event's own `toolName`.

## Claude Code adapter

`packages/agent-runtime/src/providers/claude/`

- **Detection**: `claude --version` for the version string, `claude auth status --json` for login
  state (`{ loggedIn: boolean, ... }`), see [`ProviderStatus`](#providerstatus) for how that maps
  to `AuthStatus`.
- **Execution**: `claude -p --input-format text --output-format stream-json --verbose`, plus either
  `--session-id <daemon-uuid>` on a fresh session or `--resume <providerSessionId>` when resuming
  (argv construction is in `build-args.ts`, unit- and contract-tested independently of spawning a
  process). Passing our own UUID as `--session-id` means the daemon's session id and Claude's own
  session id are the same value from the start, instead of needing to reconcile two ids after the
  fact. Resuming is reachable end to end via `POST /sessions`'s `resumeProviderSessionId` field.
  **The prompt itself is not an argv element**: it's written to the child's stdin and the stdin
  stream is then closed (`run-session.ts`'s `promptViaStdin` config; as of ADI-14 Codex sets it
  too, so both shipped adapters now use this path). Two
  reasons: an argv element has to fit inside Windows' `CreateProcess` command-line limit (~32,767
  characters), well under what the shared request schema permits (200,000), and an argv-passed
  prompt is visible to any same-user process for the whole life of the process (`ps`/Task
  Manager's command-line column), not just at spawn time.
- **Parsing** (`parser.ts`): maps `system`/`init` → captures the session id; `assistant`/`user`
  message content blocks (`text`, `thinking`, `tool_use`, `tool_result`) → `assistant.message` /
  `thinking.delta` / `tool.started` / `tool.completed`; `result` → a `usage` event (with
  `total_cost_usd` as `cost`) and, if `is_error` is set, an `error` event. Claude emits a `usage`
  event on every `assistant`/`user` line *and* again on the final `result` line: one session
  produces several `usage` events, not one; see [Protocol v1](protocol-v1.md) for why a consumer
  should never treat a single `usage` event as a session total.
- This project intentionally does **not** pass `--include-partial-messages`: without it, Claude
  Code emits one complete `assistant` message per turn instead of a token-by-token delta stream,
  which is simpler to parse and has fewer partial-line edge cases than a token-by-token stream, for
  an MVP. Protocol v1 has no token-streaming event variant today (an earlier `assistant.delta`
  placeholder was removed before anything emitted it, see [Protocol v1](protocol-v1.md)); a future
  adapter or CLI flag that wants real token streaming
  needs a properly-specified event added at that point, not a speculative one reserved now.

Verified manually against a real, already-authenticated `claude` CLI during development (see the
project's technical report / commit history for the transcript): the daemon started a session,
Claude's response and token usage came back as normalized events, and the session reached
`session.completed` with no API key ever requested.

## Codex adapter

`packages/agent-runtime/src/providers/codex/`

- **Detection**: `codex --version`; `codex login status`, whose output is a short human-readable
  line (`"Logged in using ChatGPT"`, `"Logged in using API key"`, or a not-logged-in variant)
  rather than JSON. The parser matches conservatively and falls back to `'unknown'` rather than
  guessing when the text doesn't clearly say one way or the other.
- **Execution**: `codex exec - --json --skip-git-repo-check --ignore-user-config`, or
  `codex exec resume <providerSessionId> - --json --skip-git-repo-check --ignore-user-config` to
  continue a prior thread (argv construction is in `build-args.ts`). `--skip-git-repo-check` is
  required because a session's working directory is whatever the user picked, not necessarily a git
  repository. `--ignore-user-config` (issue #174) stops a session from silently loading
  `$CODEX_HOME/config.toml`, which could otherwise set `sandbox_permissions` or
  `shell_environment_policy` to anything; `CODEX_HOME`-based auth is unaffected. Resuming is
  reachable end to end via `POST /sessions`'s `resumeProviderSessionId` field.
  **The prompt itself is not an argv element** (ADI-14): the `-` above is the placeholder Codex
  documents for its `[PROMPT]` positional (*"If not provided as an argument (or if `-` is used),
  instructions are read from stdin"*, `codex exec --help` on the pinned 0.147.0 build; `codex exec
  resume --help` says the same for the resume shape), and the prompt is written to the child's stdin
  and the stream closed. Same two reasons as Claude: a 200,000-character prompt cannot fit Windows'
  ~32,767-character `CreateProcess` command line, and an argv-passed prompt -- here routinely a CV
  plus a scraped vacancy description -- is readable by any same-user process for the whole life of
  the process. Until ADI-14 this adapter did embed the prompt in argv; that is what changed, and it
  also moved Codex's accepted-work boundary (see below).
- **Parsing** (`parser.ts`): `thread.started` → captures the thread id as `providerSessionId`;
  `item.started` / `item.completed` → `tool.started` / `tool.completed` for `command_execution`,
  `file_change`, and `mcp_tool_call` items, `assistant.message` for a completed `agent_message`
  item, `thinking.delta` for `reasoning` items; `turn.completed.usage` → a `usage` event;
  `turn.failed` → a fatal `error` event. A completed item of type `error` (Codex uses this for
  non-fatal warnings, e.g. a local config quirk, that don't stop the turn) is normalized as
  `recoverable: true`, unlike `turn.failed` which is not.

Verified manually the same way as Claude: a real, already-authenticated `codex` CLI produced a
correct response through the full daemon → adapter → SSE pipeline, including capturing Codex's own
thread id as `providerSessionId`.

### Decision: staying on `codex exec --json`, not migrating to `codex app-server` (AD-21)

Recorded against the CLI version verified during the post-audit hardening pass:
**codex-cli 0.147.0**, which itself labels `app-server` `[experimental]` (with a further
stable/experimental split inside `app-server` too). This is a dated decision, not a permanent one:
revisit it if any of these four triggers becomes true:

1. Interactive tool approvals enter AgentDock's scope (something `codex exec --json` structurally
   cannot provide; there is no client→daemon response channel in protocol v1 for it either).
2. A real multi-turn conversational loop replaces the current one-shot "type a prompt, press Run"
   UX, making per-turn CLI boot cost a measured bottleneck.
3. OpenAI drops the `[experimental]` label from `app-server` and publishes a stability policy.
4. `codex exec --json` itself is deprecated, or its output schema regresses in a way this adapter
   can't absorb.

None of the four is true today, and migrating now would cost real things this project depends on:
per-session process isolation and the structurally-derived "exactly one terminal event, always
last" guarantee (both fall out of `runProviderSession()` deriving the terminal event from process
exit; an `app-server` migration would have to re-derive both at the RPC layer, for this provider
only), and the symmetric, copyable one-adapter-per-provider pattern that is this repo's actual
pedagogical deliverable: `app-server`'s bidirectional JSON-RPC, session multiplexing, and
approval/interrupt flows would make the Codex adapter the largest and least copyable file in the
repo.

**Correction to an earlier claim in this doc**: a migration to `app-server` was previously
described as touching only `buildArgs`/`parseLine`. That understates it. `runProviderSession()`
closes stdin immediately after spawn, reads a one-way JSONL stream to completion, and derives the
terminal event from process exit: `app-server` violates three of those four assumptions (it's
bidirectional, long-lived, and multiplexes sessions rather than one-process-per-session), so a real
migration would need new process-lifecycle plumbing in the shared runner, not just two swapped-out
functions.

`ProviderSessionHandle` and `AgentEvent` themselves would not need to change: the public
provider-neutral abstraction survives a transport swap cleanly, which is exactly why this decision
is safe to defer rather than urgent to make now.

## Provider contract tests

`packages/agent-runtime/test/support/provider-contract.ts` exports `describeProviderContract()`:
a reusable vitest suite asserting the guarantees *every* adapter must uphold, run against each
adapter's real `parseLine`/`buildArgs` (not a re-implementation of them), with a small `node`
fixture script standing in for the real CLI binary. `test/claude-contract.test.ts` and
`test/codex-contract.test.ts` are ~15-line call sites that just supply each provider's fixtures and
declared capabilities (see either for the pattern to copy for a new provider).

What it checks: `session.started` is emitted first and tagged with the right provider; a
nonexistent working directory is rejected before the CLI is ever touched; no raw/unrecognized
provider-native event type ever reaches the normalized stream; an unrecognized event kind doesn't
crash the session; assistant output normalizes; tool events normalize *only when
`capabilities.tools` says they should*, same for `usage`; exactly one terminal event occurs, always
last, carrying the provider session id on success; cancellation (gated on `capabilities.cancellation`)
terminates the process and never lets `session.completed` follow `session.cancelled`; resume (gated
on `capabilities.resume`) produces an argv that references the prior provider session id and
differs from a fresh session's argv.

It lives under `test/support/`, not `src/`: it's a vitest-coupled test helper, not part of this
package's public runtime API, so it isn't exported from `index.ts`. A provider adapter maintained
outside this repo would copy the pattern rather than import the file directly.

ADI-04 added two fields to `ProviderContractSpec`: `promptViaStdin` (required) and `fixtureSet`
(optional). `promptViaStdin` mirrors the adapter's own setting and is cross-checked against the real
argv builder, since it is the observable fact the provider's accepted-work boundary is derived from
(see the next section); `fixtureSet` names the conformance corpus the provider's compatibility
manifest entry declares. Every pre-existing assertion in this suite is unchanged.

Both `ClaudeProvider` and `CodexProvider` pass the full suite today (28 tests total, 14 each; run
`pnpm --filter @agent-dock/agent-runtime test` to see current counts directly rather than trusting
a number in prose, which is exactly the kind of claim that drifts silently). Provider-specific
parsing detail (the exact Claude/Codex JSONL shapes) stays in `test/claude-parser.test.ts` /
`test/codex-parser.test.ts`, which the contract suite doesn't replace. Both providers' `detect()`
auth parsing also has dedicated pure-function tests independent of the contract suite (see
`test/claude-detect.test.ts` / `test/codex-detect.test.ts`).

## Accepted-work boundaries and the compatibility manifest (ADI-04)

`packages/agent-runtime/src/providers/compatibility-manifest.ts` records, per
provider/CLI-version/transport triple, the **accepted-work boundary**: the instant after which this
repo can no longer prove the provider did *not* act on the user's prompt. This is a safety fact,
not a progress indicator — it exists so a supervisor can answer "is it safe to retry?" without
guessing, and so it is never answered optimistically by accident.

| Provider | Pinned version | Transport | Accepted-work boundary | Why |
|---|---|---|---|---|
| Claude Code | `2.1.228` | `legacy-one-shot` | `first-prompt-byte-to-stdin` | `build-args.ts` deliberately keeps the prompt out of argv and `adapter.ts` sets `promptViaStdin`, so nothing reaches the CLI until the stdin write. Everything before that write is provably undelivered. |
| Codex | `0.147.0` | `legacy-one-shot` | `first-prompt-byte-to-stdin` | Since ADI-14, `build-args.ts` emits Codex's documented `-` stdin placeholder rather than the prompt and `adapter.ts` sets `promptViaStdin`, so nothing reaches the CLI until the stdin write. It read `process-spawn-attempt` before that, when the prompt was an argv element (`codex exec <prompt>`) and was therefore handed over by the act of creating the process. |

No entry declares `process-spawn-attempt` any more. That value is deliberately kept in the union
anyway, because it is still what `acceptedWorkBoundaryFor` returns on a manifest miss (see
[the fail-closed rule](#the-fail-closed-manifest-miss-rule)), and the fail-closed default must stay
expressible even when no reviewed entry uses it.

The supervisor does not actually read this table's boundary column at runtime to decide *when* to
mark work accepted, and deliberately so: it reads `runProviderSession`'s own `promptViaStdin` flag
instead, reported at the exact moment of the spawn attempt (see `SessionLaunchProbe.onSpawnAttempt`
in `types.ts`). A separately-maintained boundary field that silently drifted out of sync with a real
adapter change (e.g. `build-args.ts` switching a provider from argv to stdin without this manifest
being updated) would have been a manifest **hit** confidently reporting the *old* transport, which
is worse than a miss — a miss already fails closed. Deriving from the actual flag instead makes that
drift structurally impossible: there is one flag governing both what `runProviderSession` does and
what the supervisor assumes it did. The manifest's boundary column above still documents which
boundary applies to each pinned version, for fixture classification and this table, but is not the
enforcement mechanism.

Both providers reach the same terminal accepted-work value for a successful session —
`acceptedWork: 'accepted'` — and, since ADI-14, both reach it at the same observable moment: an
observed stdin flush, which is direct evidence of delivery. `AcceptedWorkState` measures delivery
(retry-safety), never completion, so "accepted" here never implies the CLI has finished, or even
started, acting on the prompt — only that it has provably received it.

An argv-transport adapter would instead latch `'accepted'` at the spawn attempt itself, since an
argv-embedded prompt is handed over unconditionally and atomically the instant the process is
created — there is no in-flight window analogous to a stdin write that could still fail. Codex
worked that way until ADI-14, and the conformance suite still describes both cases: its
"accepted-work boundary timing" section samples the latch from inside the probe callbacks, and
requires a stdin-transport provider to read `not_accepted` immediately after the spawn attempt,
reaching `'accepted'` only once the write is flushed. Asserting the terminal value alone would not
have distinguished the two, which is why the timing is sampled rather than inferred.

### The fail-closed manifest-miss rule

Lookup is **exact match only**. There is deliberately no semver-range matching and no
"nearest version" fallback: a manifest entry is a claim that *that exact build* was run against the
conformance fixtures, and range matching would silently extend that claim to builds nobody tested.
So a user on `claude 2.1.229`, or on a build whose version could not be detected at all, is a
manifest miss — which is an ordinary, expected state, not an error.

On a miss, `acceptedWorkBoundaryFor(undefined)` returns **`'process-spawn-attempt'`**, the earliest
and therefore most conservative boundary in the union. An unverified CLI is assumed to have received
the prompt the moment we tried to start it.

The direction matters, and it is the single most consequential default in this area. Defaulting the
other way (`'first-prompt-byte-to-stdin'`) would assume an unverified CLI reads its prompt from
stdin and that nothing before that write can have reached it — an assumption that is false for every
argv-prompt CLI, and whose failure mode is the dangerous one: concluding "no work was accepted, safe
to retry" for a CLI that had already started acting on the user's prompt. Being wrong in the
conservative direction costs a refused retry. Being wrong in the other direction costs a duplicated
side effect in the user's working directory.

### Where this is exercised

`test/support/supervisor-contract.ts` (`describeSupervisorContract`) is the per-provider conformance
suite for the supervisor, with `test/claude-supervisor-contract.test.ts` and
`test/codex-supervisor-contract.test.ts` as thin call sites — the same pattern as the v1 provider
contract above, kept in a separate file so a failure is unambiguous about which contract broke.
`test/compatibility-manifest.test.ts` additionally checks each boundary against the adapter's *real*
argv builder, so an adapter that moved its prompt into or out of argv without updating the manifest
fails rather than getting a silently wrong boundary.

Run both contract suites together with `pnpm test:provider-conformance` from the repo root.

## Adding a new provider

Say you want to add `GeminiProvider`. You should not need to touch the daemon's routes, the client
package, or the desktop UI at all:

1. **Register the id.** Add `'gemini'` to `PROVIDER_IDS` in `packages/shared/src/provider.ts`.
2. **Write `detect.ts`.** Resolve the executable (via `findExecutable`, see
   [Executable discovery](#executable-discovery)), get its version, and determine auth state,
   never coercing "couldn't tell" into `true` (see [`ProviderStatus`](#providerstatus)).
3. **Write `capabilities.ts`.** Declare a `ProviderCapabilities` object reflecting what you
   actually implemented in the steps below, not an aspiration (see
   [Provider capabilities](#provider-capabilities)).
4. **Write `parser.ts`.** A pure function `(raw: unknown, logger: Logger) => ParsedLine` mapping
   the CLI's native JSONL shape into `AgentEvent[]`, matching the `ParsedLine` contract in
   `providers/common/run-session.ts`.
5. **Write `build-args.ts`.** A pure function `(opts: StartSessionOptions) => string[]`
   constructing the CLI's argv, branching on `opts.resumeProviderSessionId` if `capabilities.resume`
   is true.
6. **Write `adapter.ts`.** A class implementing `AgentProvider`
   (see [The `AgentProvider` interface](#the-agentprovider-interface)), delegating execution to the
   shared `runProviderSession()` helper: validation, spawning, cancellation, and the
   completed/failed/cancelled terminal-event guarantee are all handled there; you only supply
   `buildArgs` and `parseLine`.
7. **Write provider-specific parser tests**, and **run the shared provider contract suite.** Unit-
   test the parser against fixture JSON (see `test/codex-parser.test.ts` for the shape), then add
   `test/gemini-contract.test.ts` calling `describeProviderContract()` with your fixtures and
   capabilities (see [Provider contract tests](#provider-contract-tests)), a `node` fixture script
   standing in for the real CLI, so CI never needs a real Gemini account.
8. **Register it.** Add `new GeminiProvider(logger)` to `buildProviderRegistry()` in
   `apps/daemon/src/providers.ts`.

That's the whole surface. `GET /providers` picks it up automatically (it iterates the registry),
`@agent-dock/client` needs no changes (it already validates against the shared `ProviderStatus`
schema, not a provider-specific one), and the desktop UI's provider `<select>` only needs a new
`<option>`: its event rendering already works for any provider because it only ever switches on
`AgentEvent.type`.
