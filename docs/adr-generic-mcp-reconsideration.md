# ADR template: reconsidering generic AgentDock MCP or component control

This is not a decision record — it is empty by design. ADI-10 (issue #128) keeps upstream
AgentDock's generic, renderer-configurable provider-MCP and component-management surface out of
this repo entirely: no route accepts a server URL, stdio command, header, or arbitrary tool name
from the renderer, and the only MCP model this app ships is the compiled, reviewed vacancy-source
policy described in [mcp-source-policy.md](mcp-source-policy.md). `docs/adr-agentdock-v2-provenance.md`
records what was ported from upstream; this file exists so that if someone ever wants to revisit
*this specific* deferral, they fill in every section below with real evidence before writing any
code — not after. `apps/daemon/test/generic-mcp-deferral.test.ts` and
`apps/desktop/test/generic-mcp-deferral.test.ts` are the mechanical side of this same decision: they
fail the day generic MCP/component routes or bridge channels appear without this ADR ever being
written.

## Why a template, not a normal ADR

A normal ADR records a decision already made. This repo's decision — defer, keep forced off — is
already made and already enforced by the two test files above. What would actually change that
decision is not "someone wants the feature," it is a specific security design meeting every gate
below, evaluated by a security reviewer, not the person proposing the feature. Filling in this
template *is* that proposal. An empty template with a PR attached is not evidence.

## Required sections (fill in all seven before this stops being a template)

### 1. Compiled allowlist model

What is the reviewed, compiled set of servers/tools this reconsideration would allow, and by what
mechanism is it compiled (build-time config, signed manifest, admin-only settings screen)? A
runtime-editable text field the renderer or an agent session can reach is not a compiled allowlist,
no matter how it is labeled. If any allowed server is a local stdio process rather than a remote
HTTPS endpoint, name the exact executable and argv array for each one and how that binding matches
the `shell:false`/argv-array process-spawn discipline `SECURITY.md` already requires elsewhere in
this app — a stdio server is a new place this app runs an external binary, and gets no exception
from that existing rule just because MCP is the caller.

### 2. Exact canonical invocation binding

For every allowed tool call, what pins the call actually made to the call the allowlist approved —
exact tool name, exact argument shape (not "matches a schema," the literal permitted values), exact
target server identity (not a renderer-suppliable URL string)? Name the specific check that would
catch a call that matches the schema but targets a different, unapproved server or tool.

### 3. Unknown tools treated as side-effecting

Per `mcp-source-policy.md`'s existing default-denial model, an unrecognized tool or capability is
ignored, never granted the benefit of the doubt. Does this reconsideration preserve that? If it
proposes any tool auto-discovery or dynamic tool-list acceptance, explain why a newly-appearing tool
from a server already on the allowlist cannot be used to smuggle an unreviewed side effect through
an already-open connection.

### 4. Audit-before-allow

Does every invocation get an audit record written *before* the effect happens, matching the "audit
before effect" discipline `apps/daemon/src/routes/v2-sessions-create.ts` and
`v2-workspaces.ts` already enforce for session creation and trust changes (see
`apps/daemon/test/v2-sessions-create.routes.test.ts`'s `describe('POST /v2/sessions: audit before
effect', ...)` suite for the existing pattern to match)? An audit write that can be skipped on a
fast path, or that happens after the call already ran, does not meet this bar.

### 5. Secret handling

Where do credentials for the newly-allowed servers live? `mcp-source-policy.md`'s existing rule —
OS credential store only, never SQLite, renderer state, logs, prompts, reports, or exports — is the
floor, not a suggestion this reconsideration gets to loosen.

### 6. Revocation

Given a connection or credential already in use, what is the actual mechanism (not "we would add a
button") to revoke it immediately, and does revocation take effect before the next tool call can go
out, or only before the next one that happens to check?

### 7. Renderer-compromise analysis

If the Electron renderer process is fully compromised (arbitrary JS execution in that process, the
threat model `SECURITY.md` already treats as realistic for this app), what can it reach through this
reconsidered surface that it cannot reach today? Name the specific new capability a compromised
renderer would gain — a new persisted command execution path, a new way to reach an
otherwise-unregistered server, a new way to widen an already-approved tool's arguments — and explain
why that is an acceptable increase in blast radius, not just that it is possible to build safely in
the abstract.

## What approval looks like

This repository has one maintainer (`.github/CODEOWNERS`' `* @jortega0033`), so nothing here can
honestly promise an *independent* reviewer the way a multi-maintainer project could — say otherwise
and the promise is worthless the first time it matters. What this file can promise, and does: every
one of the seven sections above is filled in with concrete, checkable answers (a cited file and line,
not a description of an intended design), not placeholders; the two `generic-mcp-deferral.test.ts`
files are updated in the *same* change to allow exactly the newly-approved surface and nothing wider,
so the mechanical guard and the written justification can never drift apart; and — if this repo ever
gains a second maintainer before this is revisited — that person reviews it before merge, which is
what `* @jortega0033` in CODEOWNERS already requires structurally for every file in this repo,
this one included. Until all of that is true, the answer to "can we add generic MCP or component
control" stays no, and this file stays a template.
