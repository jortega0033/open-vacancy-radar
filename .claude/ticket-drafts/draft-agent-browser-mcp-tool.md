## Goal
Track `agent-browser` (forked from vercel-labs/agent-browser) as a capability to pull into this repo's runtime once it lands upstream -- not to implement here. Per the AgentDock dev AI: the MCP-server wiring described below belongs in `jortega0033/agentdock` (the upstream project `apps/daemon`, `packages/shared`, `packages/client`, and `packages/agent-runtime` are copy-derived from -- see `docs/adr-agentdock-v2-provenance.md`), and this repo's job is to pull/port it in afterward the same way the ADI tickets (ADI-01 through ADI-13) port upstream's v2 architecture in.

## Why this is deferred, not built here
This repo's `packages/agent-runtime`, `apps/daemon`, `packages/shared`, and `packages/client` are explicitly tracked as a copy-derived fork of `jortega0033/agentdock`, evolved independently since the fork point but still meant to receive upstream's architecture via the ADI port process rather than diverge with parallel runtime-level features. A generic browser-automation MCP tool is exactly that kind of runtime-level capability (belongs in `agent-runtime`/`daemon`, not in the product-only `packages/vacancy-engine` or `apps/desktop/{src,assets}` code that has no upstream counterpart). Building it here first would create exactly the kind of drift the provenance ADR exists to track and eventually have to reconcile.

## What the original plan was (for reference, once it's pullable)
The intended shape, worked out before this redirect:
- `agent-browser mcp --tools core` registered as an opt-in MCP server in a session's strict MCP config (the `--strict-mcp-config` lever from ADI-08's hardening flags).
- Gated per-workspace by a new, narrow trust grant, not on by default.
- Read-only tools only in the first slice (`open`, `snapshot`, `read`, `screenshot`) -- `click`/`fill`/`type`/`press`/credential entry explicitly out of scope until a dedicated ticket designs a confirm-before-submit gate.

If/when upstream ships this, check whether their design matches the constraints above (workspace-gated, read-only first, no credential entry) before porting it in as-is.

## What would need to be true before this is worth acting on
1. Upstream `jortega0033/agentdock` actually ships the `agent-browser` MCP integration (or an equivalent).
2. The next ADI-style port ticket pulls it into this repo's copy the same way prior ADI tickets ported other upstream changes.

## Non-goals
Do not implement `agent-browser` MCP wiring directly in this repo. Do not fork ahead of upstream on this feature. This ticket exists to hold the use-case reasoning so it isn't lost, and to flag it for pulling once upstream has it.
