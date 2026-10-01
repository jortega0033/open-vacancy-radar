# ADR: keep the daemon as a separate OS process

## Status

Accepted (describes the architecture as built; see [architecture.md](architecture.md) and
[daemon.md](daemon.md)). Contains one open question for the product owner, flagged below.

## Decision

The daemon (`apps/daemon`) stays a separate, independently-spawned OS process from Electron main,
talking to it only over the local HTTP+SSE contract in `@agent-dock/client`
(`packages/client`), never by importing daemon code into `main.ts` directly. This ADR exists
because, until now, nothing in the repo wrote down *why* — the closest thing on record,
`SECURITY.md`, gives a rationale for a different property that doesn't actually require this one
(see below), so a future reader had nothing accurate to point to.

## Why this ADR, not just SECURITY.md

`SECURITY.md:15-18` and `SECURITY.md:31-33` describe the daemon boundary in terms of main/renderer
secrecy: the daemon's bearer token and base URL never cross into the renderer.
`SECURITY.md:66-67` is explicit that this is "a localhost trust boundary, not a sandbox between OS
users or processes." Taken at face value, that rationale does not require an OS-process boundary
at all — a bearer token held in a `main.ts` module variable, with no daemon process ever spawned,
would be exactly as invisible to the renderer as it is today, because the renderer never had a
path to main-process module state in the first place.

**SECURITY.md's stated rationale remains true and relevant to its own concern (renderer isolation
from the token), but it is not the reason the daemon is a separate process, and should not be
cited as one.** The real justification is the three properties below, all of which genuinely
depend on process separation and would be lost or weakened without it.

## The real, load-bearing justification

1. **Crash isolation.** `apps/desktop/electron/main.ts:491-499`'s daemon exit handler turns a
   daemon crash into a renderer-visible status update, not a crash of all of Electron main. If the
   daemon's logic ran inside `main.ts` instead, an unhandled exception in session handling, SSE
   framing, or provider process management would take the whole app down with it. (As of this
   writing `spawnDaemon()` has exactly one call site, `main.ts:2595`, with no auto-respawn on
   exit — tracked separately — but that gap is only safe to close *because* this crash isolation
   already exists: respawning inside the same process wouldn't recover from a crash that just
   took that process down.)

2. **Process-tree-kill-on-cancel.** `SECURITY.md:234-238` documents that cancelling a session kills
   the whole process tree as a group — the provider CLI plus any grandchild tool subprocess it
   spawned — via `taskkill /T /F` on Windows or a negative-pid `SIGTERM` on POSIX, and this is
   covered by a dedicated test fixture. This mechanism depends on the CLI being a grandchild of
   Electron main, which is true regardless of whether the daemon itself is a separate process — but
   it is implemented today assuming the current topology (daemon process → CLI process → tool
   subprocesses), and changing that topology would mean re-verifying the kill behavior from
   scratch rather than inheriting an already-tested guarantee.

3. **Potential upstream/multi-frontend reuse.** `apps/desktop/electron/main.ts:420-426`'s `APP_ID`
   comment, together with `apps/daemon/package.json` defining `@agent-dock/daemon` as an
   independently runnable package with zero Electron dependency and its own `dev`/`start`/`test`/
   `smoke:live-providers` scripts, point at the daemon being built as a standalone, HTTP-contracted
   runtime — not desktop-app-private logic. This is consistent with this repo's own convention
   (runtime-level features land in the upstream `jortega0033/agentdock` fork first, then get pulled
   into this repo) of treating the daemon as shared infrastructure a non-Electron frontend (a CLI,
   a VS Code extension, a second desktop shell) could in principle talk to over the same API,
   something that stops being possible the moment daemon logic is folded into `main.ts`.

## OPEN QUESTION for the product owner

Property 3 above (upstream/multi-frontend reuse) is a *potential* benefit verified only as
"the architecture doesn't preclude it" — not as "something is actually consuming it today."
**Does a real, non-Electron consumer of the daemon's HTTP contract exist right now, or is this
goal aspirational?** The answer changes how this property should be weighed: if another frontend
already depends on the daemon's standalone HTTP API, the boundary is actively earning its keep on
this axis; if not, this specific property is unexamined inherited complexity (still justified by
crash isolation and process-tree-kill alone, but not by reuse) until someone builds that second
consumer. This needs the product owner's answer, not further code archaeology.

## Consequences

- Keeping the boundary means every daemon call from `main.ts` goes through `AgentDockClient`
  (HTTP+SSE, bearer auth) rather than a direct function call, which is the cost side of this
  decision: more moving parts (a second process to spawn, discover, and shut down; see
  [daemon.md](daemon.md)) in exchange for crash isolation and process-tree-kill guarantees that a
  same-process design would not have.
- `SECURITY.md`'s main/renderer secrecy rationale is unaffected by this ADR and needs no change —
  it documents a real and separate property of the current design, just not the reason for the
  process boundary itself.
- This ADR does not propose removing or collapsing the daemon/main boundary; it documents and
  justifies keeping the architecture as built.

## References

- [architecture.md#why-a-separate-daemon-instead-of-running-the-cli-logic-in-electrons-main-process](architecture.md#why-a-separate-daemon-instead-of-running-the-cli-logic-in-electrons-main-process)
- [SECURITY.md](../SECURITY.md)
- [daemon.md](daemon.md)
