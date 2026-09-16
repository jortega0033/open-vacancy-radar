## Goal
Track the deferred half of ADI-08 (#126): a Claude Agent SDK transport. Descoped from ADI-08 the same way ADI-03's remaining scope was descoped from its first slice -- not abandoned, blocked on real prerequisites that don't exist yet.

## Why this is deferred, not just delayed

Confirmed directly on this machine while designing ADI-08:
- `@anthropic-ai/claude-agent-sdk` is not installed anywhere in this repo or globally. Adopting it would be `@agent-dock/agent-runtime`'s first-ever third-party runtime dependency (it currently has zero).
- The SDK's actual execution model is unverified: whether it spawns the `claude` binary itself (bypassing this repo's `spawnProcess`/Windows Job Host entirely, silently losing the process-tree cancellation guarantee) or runs in-process (in which case its own tool calls, e.g. Bash, would spawn as children of the *daemon*, reachable by no cancellation path this repo has -- strictly worse than today).
- Every restriction ADI-08's own rule asks for ("disable unapproved Bash/settings/MCP/plugins/skills/agents/hooks") is already achievable as a flag on the `claude` CLI binary this repo already ships and already ran through in ADI-08 as `--safe-mode` plus `--strict-mcp-config`/`--setting-sources`/`--disable-slash-commands`/`--tools`. There is currently no restriction this ticket exists to deliver that the SDK would add.
- One flag that looks like the answer is a trap worth recording: `claude --bare`'s own help text states Anthropic auth becomes strictly `ANTHROPIC_API_KEY` under it ("OAuth and keychain are never read"), which would force this repo to hold an API key -- directly violating the standing "never read Claude's credential storage, never pass an API key" invariant. `--safe-mode` is the correct flag; `--bare` must not be used for this.

## What would need to be true before this is worth building

1. A concrete, real reason the CLI-flag hardening (shipped in ADI-08) is insufficient for some restriction it cannot express.
2. The SDK's actual process/execution model verified (spawns the CLI vs. in-process), with a real answer for how Windows Job Host process-tree cancellation applies to it -- not assumed, tested the same way ADI-04's Job Host guarantee was tested (real orphaned-descendant, real daemon-crash, real confirmed-reap tests).
3. A real justification for taking on this package's first third-party runtime dependency, weighed against what it would add over the existing CLI transport.

## Non-goals
Do not build any part of this speculatively. This issue exists so the deferral is a recorded decision with reasons, not a silently dropped scope item.
