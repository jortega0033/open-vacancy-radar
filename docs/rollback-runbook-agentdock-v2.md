# Rollback runbook: AgentDock v2 port (ADI-01…ADI-09)

This runbook exists because the v2 port (issues #119-#127) touches the runtime layer
(`apps/daemon`, `packages/shared`, `packages/client`, `packages/agent-runtime`) that this product's
own data depends on. A rollback of any ADI-series change must never take product data down with it.
Follow this before rolling back any ADI-0x PR, and update it if a later ticket introduces new
persistent state this doesn't yet cover.

## What must survive a rollback, unconditionally

[privacy.md](privacy.md#what-is-stored-and-where) is the authoritative record of what this app
stores and where; this section states only the rollback-specific fact that document doesn't need to
carry: **a rollback of any ADI-0x change never needs to, and must never, delete, migrate, or
truncate `workspace.db` or `vacancy-engine.db`.** Both live under Electron's
`app.getPath('userData')` and hold all user-created product data (saved jobs, applications, CV
documents, and letters in `workspace.db`; Netherlands/IND pipeline scan history in
`vacancy-engine.db`, created via `DATABASE_PATH=vacancy-engine.db` set in `vacancyEngineConfig()` in
`electron/main.ts`). Neither database is touched by anything in the v1 runtime layer (`apps/daemon`,
`packages/shared`, `packages/client`, `packages/agent-runtime`) — they belong entirely to
`apps/desktop` and `packages/vacancy-engine`. If a specific ADI ticket introduces a new migration
against one of these databases, that migration's own down-migration is the only sanctioned way to
revert it — never a blanket file delete.

The same `userData` root also holds a pre-existing, unrelated `ai-workspace/` scratch directory (see
privacy.md), which holds no durable user data and is safe to delete at any time — do not confuse it
with any new v2 "AI Workspace" durable session/grant store a later ADI ticket introduces; that store
gets its own named path and its own rollback treatment when it lands.

## Rollback procedure

1. **Identify the blast radius.** Check which ADI-0x PR(s) are being rolled back and whether any of
   them shipped a database migration (grep the PR's file list for `drizzle/*.sql` under
   `electron/workspace/` or `packages/vacancy-engine/`). If none did, skip to step 3.
2. **If a migration shipped:** do not `git revert` the migration file in isolation. Write and apply
   the migration's down-migration first (or restore from a pre-upgrade backup if no down-migration
   exists), confirm the app opens against the reverted schema with no data loss, then revert the
   code.
3. **Revert the code.** Standard `git revert` (or `gh pr close` before merge) of the ADI-0x commit(s)
   in dependency order, latest first — the ADI chain is strictly sequential (ADI-09 depends on
   ADI-08 depends on ADI-07 …), so a mid-chain rollback must also revert everything after it in the
   chain, not just the one ticket.
4. **Confirm protocol negotiation degrades safely.** Any v2 protocol/client work (ADI-02 onward)
   must keep `AGENT_DOCK_PROTOCOL_VERSION` (v1) working unmodified — v2 is additive
   (`supportedProtocolVersions`, `client.v2`), never a replacement. After rolling back, verify a v1
   session still starts end to end (`pnpm --filter @agent-dock/daemon test`, plus a manual
   `POST /sessions` against a `claude`/`codex` provider if the automated suite doesn't already cover
   the specific path being rolled back).
5. **Re-run the full validation suite** (`pnpm lint && pnpm typecheck && pnpm test && pnpm build`)
   before considering the rollback complete. A rollback that reintroduces a lint/type/test failure
   the original change fixed is not a clean rollback.
6. **CLI fallback stays permanent.** Per the ADI tickets' own design, CLI-based provider transports
   (the current `claude`/`codex` CLI spawning path) are the permanent rollback path for any richer
   v2 transport (Codex app-server, Claude Agent SDK) introduced later in the chain (ADI-08). Rolling
   back a transport-layer ADI ticket should never require touching the CLI path at all — if it does,
   that CLI path was wrongly coupled to the v2 work and the coupling itself is the bug to fix before
   retrying the rollback.

## What a rollback does not need to worry about

- The v1 protocol surface, session store, and SSE framing are untouched by this port (v2 is
  additive), so no existing v1 client integration needs any change to keep working through a
  rollback.
- `packages/vacancy-engine` and all of `apps/desktop/src` (the renderer) have no upstream
  counterpart and are never part of an ADI-0x diff; a rollback of runtime-layer code cannot affect
  them directly. If a rollback appears to break vacancy-engine or renderer behavior, that is a sign
  the ADI change reached outside its stated scope and the root cause is the scope violation, not a
  missing rollback step here.
