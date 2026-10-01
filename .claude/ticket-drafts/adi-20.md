## Objective
Maintain one canonical, mechanically-checked capability matrix documenting which parts of the AgentDock v2 port are real, partial, or deliberately dormant -- giving the honesty this repo's ADRs currently carry in prose the same enforcement its code already gets.

## Why this matters
This repo has an unusually large amount of deliberately dormant or partial machinery, each currently documented only in ADR prose: `FallbackGate` (provably always-deny with one registered transport), the session-supervisor's fuller internals, `workspaceLeaseModeFor` (hardcoded to always return `'write'` until a second transport exists), `accountEvidence: 'cli_owned'` (a documented limitation, not a real multi-account distinction), the MCP control plane's forced-off empty policy array, and now the Codex app-server transport's "sandbox: unknown" posture if ADI-08's pending decision goes that way. Prose in an ADR can drift from the code silently; nothing currently checks that a claim like "this route is deliberately read-only" stays true as the codebase changes.

Upstream built this discipline for exactly this reason (commits `44bdae0`/PR #81, `85d4500`/PR #82): one canonical `docs/capability-matrix.md` with a Supported/Partial/Unsupported/Design-target legend per transport/capability, backed by a mechanical CI check (link/anchor resolution, required-category presence, a banned-framings list so nothing claims more certainty than it has), plus an in-app status-badge scaffold labeling any UI panel that's ahead of its real implementation state.

## Scope
- A new `docs/capability-matrix.md` cataloguing every currently-dormant, partial, or capability-limited piece of this repo's own v2 port, cross-referenced against the ADR's existing per-ticket sections rather than duplicating them.
- A mechanical check (a script run in CI) verifying the matrix's internal links/anchors resolve and that it doesn't contain banned overclaiming language (e.g. asserting something is "sandboxed" or "verified" without a corresponding test backing that specific claim).
- If any desktop UI surface currently presents a capability as more complete than it is (check the AI Workspace page from ADI-07 and the workspace-grant confirmation dialog from ADI-06 for candidates), add a status-badge component labeling it honestly.

## Non-goals
Do not use this ticket to relitigate any prior ADI ticket's actual scope decisions -- it documents and mechanically enforces what's already true, it doesn't change what's built.

## Dependencies
Best done after the current wave of ticket updates/new tickets from this drift audit settles, so the matrix reflects a stable state rather than needing an immediate rewrite.

## Acceptance criteria
- [ ] Every dormant/partial mechanism named above has an entry in the matrix with an accurate status.
- [ ] The mechanical check catches a deliberately-introduced false claim (e.g. asserting a capability is "Supported" when no corresponding passing test exists) in a test of the checker itself.
- [ ] No existing desktop UI surface overstates a capability's real status once the audit pass is done.

## Tests
A test of the mechanical checker script itself, using a deliberately-broken fixture matrix (a bad anchor link, a banned-framing phrase, a missing required category) and confirming each failure mode is actually caught.

## Rollback
Remove the matrix and its CI check; no other behavior depends on it.

## Stop conditions
None -- this is a documentation/tooling ticket with no runtime behavior to fail closed on.

## Ownership and routing
Backend Architect. Balanced specialist model at moderate reasoning.
