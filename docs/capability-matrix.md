# Capability matrix

This is the one place that says which parts of this repo's AgentDock v2 port are real, which are
partial, and which are absent on purpose. The ADR ([adr-agentdock-v2-provenance.md](adr-agentdock-v2-provenance.md))
keeps the reasoning behind each decision. This file keeps the current status, and a script keeps it
honest.

Run the check with `pnpm docs:check-capabilities`. CI runs it on every pull request
(`scripts/check-capability-matrix.mjs`, tests in `apps/daemon/test/capability-matrix-check.test.mjs`).

## Legend

| Status | Meaning |
|---|---|
| Supported | Built, reachable in the shipped configuration, and backed by a named test file. |
| Partial | Built, but only on some paths, for some providers, or with a documented limit. |
| Unsupported | Not built, or built and deliberately switched off. Nothing in the app relies on it. |
| Design-target | Planned, with an owning issue. No code yet, or code that nothing calls yet. |

Rules the checker enforces on this file:

- Every link and heading anchor resolves.
- Every required category and every required entry id is present.
- Every `Supported` row names an existing test file in its Tests column.
- Every file path in backticks exists, and a `path:line` points inside the file.
- Words that claim more than a row can back are rejected unless the same line cites a test file.

To add or change a row: edit the table, run the check, and keep the evidence lines current. Line
numbers refer to the code as of the commit that last touched this file.

## Transports and fallback

| ID | Capability | Status | Evidence | Tests | Owner |
|---|---|---|---|---|---|
| `fallback-gate` | Retry a session on a second transport when the first never started | Partial | Real logic in `packages/agent-runtime/src/providers/common/fallback-gate.ts:88`. Its only caller is the opt-in Codex app-server path, `packages/agent-runtime/src/providers/codex/transport-selection.ts:196` and `:263`. The default transport mode is `exec`, which never consults it (`packages/agent-runtime/src/providers/codex/app-server-support.ts:134`). | `packages/agent-runtime/test/fallback-gate.test.ts` | #126 |
| `codex-app-server-transport` | Codex app-server transport | Partial | Opt-in through the transport mode setting, off by default: `packages/agent-runtime/src/providers/codex/adapter.ts:53`. Falls back to `exec` before any prompt is delivered. | `packages/agent-runtime/test/codex-transport-selection.test.ts` | #126 |
| `session-supervisor` | v2 session supervisor over the one-shot transport | Partial | A smaller supervisor than upstream's, written to the same contracts: `packages/agent-runtime/src/providers/common/session-supervisor.ts`. See [the ADR section](adr-agentdock-v2-provenance.md#this-supervisor-is-not-upstreams-supervisor). | `packages/agent-runtime/test/session-supervisor.test.ts` | #126 |
| `claude-sdk-transport` | Claude Agent SDK transport | Design-target | No code. Deferred out of the Codex app-server work. | | #144 |

Drift found while writing this file: the ADR section titled "The fallback gate is provably
always-deny in the shipped configuration" and the comment at `packages/agent-runtime/src/providers/common/fallback-gate.ts:62`
both say the gate has no real caller. That stopped being true when the Codex app-server path landed.
The always-deny result still holds for the default `exec` mode. Those two texts are left as they
are in this change, which documents and does not rewrite code.

## Workspace and trust

| ID | Capability | Status | Evidence | Tests | Owner |
|---|---|---|---|---|---|
| `workspace-grant-confirmation` | Native confirmation before a folder is granted, Cancel as the default | Supported | `apps/desktop/electron/workspace-confirm.ts:59` states the effects in plain words. | `apps/desktop/test/workspace-confirm.test.ts` | #124 |
| `workspace-effects` | Limit what the agent can do inside a granted folder | Unsupported | The grant carries one literal, `unbounded_cli`: `packages/shared/src/workspace-v2.ts:53`. The CLI starts in the folder but is not held to it. | `apps/desktop/test/workspace-confirm.test.ts` | #124 |
| `workspace-lease-mode` | Read or write mode for a workspace lease | Partial | `apps/daemon/src/workspace-execution-lease.ts:102` returns `write` for every session. It has one caller, `apps/daemon/src/routes/v2-sessions-create.ts:549`. | `apps/daemon/test/workspace-execution-lease.test.ts` | #124 |
| `account-evidence` | Bind a launch to one provider account | Partial | `packages/agent-runtime/src/providers/common/launch-scope.ts:36` is the literal `cli_owned`, so the scope cannot tell two accounts apart. Codex now reports an account category: `packages/shared/src/provider.ts:109`. | `packages/agent-runtime/test/launch-scope.test.ts` | #126 |
| `codex-account-scope` | Codex app-server account and model scope check | Partial | Catches a switch between account categories only, not two accounts of the same kind: `packages/agent-runtime/src/providers/codex/app-server/scope-evidence.ts`. | `packages/agent-runtime/test/codex-app-server-scope-evidence.test.ts` | #126 |
| `ai-workspace-page` | Concurrent sessions page with honest refusal messages | Supported | `apps/desktop/src/components/agent-workspace/AgentWorkspacePage.tsx`. | `apps/desktop/test/components/agent-workspace/AgentWorkspacePage.test.tsx` | #125 |

Drift found while writing this file: the comment at `packages/agent-runtime/src/providers/common/launch-scope.ts:28`
says `ProviderStatus` has no auth-source field. It has had one for Codex since the app-server work
(`packages/shared/src/provider.ts:109`). The launch scope still does not use it, so `cli_owned` stays
the honest value for the scope itself. The comment at `apps/daemon/src/workspace-execution-lease.ts:14`
also still describes the lease as waiting for a caller.

## Provider hardening

| ID | Capability | Status | Evidence | Tests | Owner |
|---|---|---|---|---|---|
| `claude-no-network-profile` | Claude argv profile with tools limited and no shell | Supported | `packages/agent-runtime/src/providers/claude/capabilities.ts:31`. | `packages/agent-runtime/test/hardening-capability.test.ts` | #284 |
| `hardened-no-network` | The no-network profile on every provider | Partial | Claude only. The daemon refuses other providers for application preparation at `apps/daemon/src/routes/application-generation.ts:47`. Codex does not declare it, because its argv never reads the option. Decision note on #579, port tracked in #590, upstream `jortega0033/agentdock#177`. | `packages/agent-runtime/test/hardening-capability.test.ts` | #590 |
| `codex-sandbox-posture` | Codex app-server enforces its own folder and network limits | Unsupported | The transport sends a fixed `workspace-write` setting and makes no claim of its own: `packages/agent-runtime/src/providers/codex/app-server/transport.ts:79`. See `docs/providers.md`. | `packages/agent-runtime/test/codex-app-server-transport.test.ts` | #126 |
| `windows-sandbox-caveat` | Rely on the Codex OS sandbox on Windows | Unsupported | Per the #579 note, the Windows `unelevated` mode uses weaker network controls and `codex exec` can fall back to it (openai/codex#40158). The Codex argv passes no `--sandbox` flag: `packages/agent-runtime/src/providers/codex/build-args.ts:62`. | | #579 |
| `codex-global-injection` | Keep the user's global AGENTS.md and skills out of a Codex session | Unsupported | Observed in #579. `--ignore-user-config` does not remove them (`packages/agent-runtime/src/providers/codex/build-args.ts:62`), and no switch is known. Claude's profile drops its equivalents. | | #590 |
| `provider-environment-allowlist` | Spawn provider processes with a default-deny environment | Supported | `packages/agent-runtime/src/providers/common/provider-environment.ts`. | `packages/agent-runtime/test/provider-environment.test.ts` | ADI-15 |

## MCP and sources

| ID | Capability | Status | Evidence | Tests | Owner |
|---|---|---|---|---|---|
| `mcp-product-policies` | Product-specific vacancy MCP sources under a reviewed policy | Supported | One policy is active, the credential-free InfoSec Job Board policy: `apps/daemon/src/index.ts:50` and `apps/daemon/src/mcp/providers/infosec-job-board.ts`. See [the ADR section](adr-agentdock-v2-provenance.md#the-mcp-foundation-ships-dormant-on-purpose) and [the source policy](mcp-source-policy.md). | `apps/daemon/test/mcp-infosec-job-board.test.ts` | #48 |
| `mcp-oauth-providers` | MCP sources that need an OAuth sign-in | Design-target | No policy carries an OAuth client yet. Each one needs its own reviewed change to `buildMcpManager()`: `apps/daemon/src/index.ts:52`. | | #29 |
| `mcp-generic-control` | Renderer-configurable provider MCP and component control | Unsupported | Deliberately never ported. No route or preload channel exists for it. See [the reconsideration template](adr-generic-mcp-reconsideration.md). | `apps/daemon/test/generic-mcp-deferral.test.ts` | #128 |

Drift found while writing this file: the older statement "MCP is off, the policy list is forced
empty" is no longer true for the product surface. The list now holds the InfoSec Job Board policy
(`apps/daemon/src/index.ts:52`). What stays off is generic provider MCP and component control, which
is a separate row above.

## Models

| ID | Capability | Status | Evidence | Tests | Owner |
|---|---|---|---|---|---|
| `model-catalog-codex` | Live model list from the Codex CLI | Supported | `packages/agent-runtime/src/providers/codex/adapter.ts:96`, used by `apps/daemon/src/routes/v2-sessions-create.ts:303` and `apps/daemon/src/routes/v2-providers.ts:81`. | `packages/agent-runtime/test/codex-provider-model-catalog.test.ts` | #256 |
| `model-catalog-claude` | Live model list from the Claude CLI | Partial | A fixed list of aliases, not read from the CLI: `packages/agent-runtime/src/providers/claude/capabilities.ts:66`. A live catalog is deferred behind the Claude SDK work. | `packages/agent-runtime/test/model-select.test.ts` | #144 |

## Attachments

| ID | Capability | Status | Evidence | Tests | Owner |
|---|---|---|---|---|---|
| `attachments-outbound` | Fetch a full tool result as a session attachment | Supported | `apps/daemon/src/routes/v2-sessions.ts:278`, read-only. | `apps/daemon/test/attachment-store.test.ts` | ADI-29 |
| `attachments-input-images` | Send an image or PDF into a session | Partial | `exec` transport only. Codex fails closed on the app-server path: `packages/agent-runtime/src/providers/codex/capabilities.ts:39` and `packages/agent-runtime/src/providers/codex/adapter.ts:59`. | `packages/agent-runtime/test/codex-adapter-attachments.test.ts` | agentdock#152 |
| `attachments-user-upload` | A general upload, list and delete lifecycle for user files | Unsupported | The only attachment route is the read-only fetch at `apps/daemon/src/routes/v2-sessions.ts:278`. CV files take a separate one-off path. | | ADI-29 |

## Absent by design

| ID | Capability | Status | Evidence | Tests | Owner |
|---|---|---|---|---|---|
| `worktree-subagent-component` | Git worktree management, sub-agents and component control | Unsupported | Left out of the Claude tool allowlist because a session lease cannot bound writes to a second directory: `docs/adr-agentdock-v2-provenance.md:1125`. Worktree support is a tracking issue only. | `apps/daemon/test/generic-mcp-deferral.test.ts` | #220 |

## How the pieces connect

- Status words here are written by people. The script checks that each claim points at real files,
  real lines and, for `Supported`, a real test file. It cannot tell whether a status is right.
- When a code change makes a row wrong, change the row in the same pull request.
- The user interface follows this file: the AI Workspace start panel shows a badge for the
  `workspace-effects` row (`apps/desktop/src/components/agent-workspace/NewSessionPanel.tsx`).
