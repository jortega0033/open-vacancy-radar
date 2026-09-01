# ADR: AgentDock v1 provenance and the v2 upgrade boundary

This repository is not an independent implementation of the AgentDock runtime: `apps/daemon`,
`packages/shared`, `packages/client`, and `packages/agent-runtime` are a copy-derived fork of the
upstream [`jortega0033/agentdock`](https://github.com/jortega0033/agentdock) project, taken at a
point in that project's history and then evolved independently ever since. Issues #119-#127
("ADI-01" through "ADI-09") plan to port a "v2" architecture from that same upstream project into
this repo's copy. Before any of that port work starts, this ADR records exactly what was copied,
from where, how far it has since drifted, and which of that drift is safe to overwrite versus must
be preserved. This is the artifact ADI-01 (issue #119) commits to producing; ADI-02 onward will cite
it rather than re-deriving these facts.

## Upstream reference points

- **Upstream repository:** `jortega0033/agentdock`
- **v2 target commit:** `5bc0b679…` (the commit the ADI tickets cite as the v2 architecture to port)
- **Nearest upstream baseline to this repo's fork point:** `751341bcb452d2b5711d0d4c1f4d099bfb1d5b49`
  ("chore: remove unused zod devDependency from apps/desktop") — confirmed by cloning upstream and
  checking out this commit directly; it exists and checks out cleanly.
- **This repo's initial commit:** `624247d60ce7d897303e40eb451451eae2df2504`
  ("feat: initial OpenVacancyRadar desktop app", 2026-08-29) — the point this repo's history starts
  from; it already contains the copy-derived packages, so the fork happened before this repo's own
  history begins.

## The copy-derived boundary

Diffing this repo's file tree against the upstream baseline commit identifies exactly which
directories are copy-derived, by finding the largest set of paths that exist verbatim (by path) in
both trees:

| Directory | File count |
|---|---|
| `apps/daemon` | 18 |
| `packages/shared` | 10 |
| `packages/client` | 8 |
| `packages/agent-runtime` | 45 |
| **Total** | **81** |

This 81-file set is the "core" this ADR and the ADI tickets treat as copy-derived and in scope for
provenance tracking. Four more files — `apps/desktop/electron/{main.ts, preload.ts,
resolve-daemon-entry.ts, send-to-renderer.ts}` — also exist verbatim by path in the upstream tree,
but are **excluded** from the 81-file core: they diverge far more heavily (whole new IPC
namespaces, vacancy-radar-specific wiring) than the 81-file set does, so folding them in would blur
a genuinely different kind of file under one number. Everything under `packages/vacancy-engine` and
`apps/desktop/{src,assets,e2e,scripts}` is pure product code with no upstream counterpart at all.

## Two valid, differently-scoped comparison numbers

Diffing the 81-file core against upstream produces **two different, both-correct answers**,
depending on which local commit you diff against — and conflating them would misstate what's
actually shipped:

**At this repo's fork point (`624247d`, the initial commit):**

```
TOTAL=81  IDENTICAL=69  MODIFIED=12  ADDED=0  DELETED=0  LINES=+84/-6
```

The 12 modified files at this point are exactly the Claude model-selection feature (see below) —
nothing else had touched the copy yet. This is the number issue #119 originally cited, and it is
accurate as a description of **provenance at the fork point**.

**At current `master` (HEAD, as of this ADR):**

```
TOTAL=81  IDENTICAL=32  MODIFIED=49  ADDED=0  DELETED=0  LINES=+410/-159
```

Nothing was added or deleted from the 81-path set in either case (every upstream path still exists
locally), but 17 more files have been modified since the fork, roughly quadrupling the line delta.
**This ADR treats the current-state number as the actual, load-bearing provenance record** — it is
what ADI-02 onward must diff the v2 target against — while keeping the fork-time number here as
historical context for how issue #119 arrived at its original "81/69/12" claim.

## What changed since the fork, and why

Four same-day commits (2026-08-30, the day before issue #119 was filed) account for the full
divergence between the two snapshots above:

1. **`4f4f611` — "feat(mcp): add policy-gated vacancy source foundation".** Adds a vacancy-source
   MCP client/connection-manager foundation: `apps/daemon/src/mcp/{cache, credential-store, manager,
   sdk-connector, types}.ts`, `apps/daemon/src/routes/mcp.ts`, `packages/shared/src/mcp.ts`, plus
   matching tests. These are net-new files *inside* the copy-derived directories but *outside* the
   81-path set, so they don't appear in the "modified" count above — they only affect the small
   number of core files that wire the new manager in (`apps/daemon/src/index.ts`,
   `apps/daemon/src/server.ts`, `packages/shared/src/index.ts`, `packages/client/src/client.ts`).
2. **`a6b7233` (PR #54) — "chore(copy): normalize project language".** A repo-wide sweep removing
   em dashes from comments and docs across nearly every core file, including many with no logic
   change at all. This single commit accounts for the bulk of the "modified file count" jump between
   the two snapshots: 29 of the 49 currently-modified core files differ from upstream in comments or
   docstrings only, with zero behavioral difference.
3. **`44adc81` — "fix: address CodeQL alerts…" (issue #39 Phase 1).** Rate-limiting-finding dismissal
   comments in `apps/daemon/src/routes/{providers,sessions}.ts`, and a real fix in
   `packages/client/src/client.ts` replacing a ReDoS-shaped regex with `stripTrailingSlashes`.
4. **`ca68c37` — "fix: repair packaged-app daemon crash and vacancy-engine path resolution".** Further
   `apps/daemon` packaging/build-script changes (`package.json`, `scripts/build.mjs`).

Of the 49 currently-modified core files, only **20 carry an actual behavioral difference** from
upstream; the other 29 are comment-only (mostly from the em-dash sweep). The 20 real changes fall
into three feature threads, none of which is a later, unrelated drift — all three were present by
the fork-time snapshot or added in the four commits above:

- **Claude model selection** (present since the fork): `packages/agent-runtime/src/providers/claude/
  {build-args,capabilities,detect}.ts` (adds a `--model` flag and a `CLAUDE_MODELS`/
  `availableModels` list), `packages/agent-runtime/src/types.ts` (`StartSessionOptions.model`),
  `packages/shared/src/{provider,schemas,session}.ts` (the schema/type surface for it),
  `apps/daemon/src/{routes/sessions,session-manager}.ts` (passthrough to the provider).
- **MCP vacancy-source foundation** (added `4f4f611`): the daemon/client wiring for the new MCP
  manager described above.
- **CodeQL remediation** (added `44adc81`): the ReDoS fix and rate-limit comment updates described
  above.

## The MCP foundation ships dormant, on purpose

`apps/daemon/src/index.ts` builds its `McpConnectionManager` (via the exported `buildMcpManager()`
factory) with an **empty policy array**, on purpose: provider-specific policies (starting with #29)
will inject an `OAuthClientProvider` there, and keeping the registry empty until then means an OAuth
server can never be contacted before its redirect URI, PKCE/token persistence, terms, tool, and
retention policy have all been reviewed together (see the comment on `buildMcpManager` itself for
the full reasoning — it isn't repeated here to avoid this ADR drifting out of sync with the code it
describes).

The manager, SDK connector, credential store, and routes are fully built and unit-tested against
fabricated policies, but **zero MCP providers are wired into the shipped daemon today** — this is
scaffolding with the gate deliberately closed, not an oversight. This ADR records the decision that
follow-on ADI work must respect: **treat the empty policy array as a real, shipped product
invariant**, not a temporary state to silently fill in as a side effect of some other change. A
regression test (`apps/daemon/test/index.test.ts`) now pins this by constructing the real manager via
`buildMcpManager()` and asserting `providerIds()` is empty, rather than pattern-matching `index.ts`'s
source text, so the test keeps working across any refactor that preserves the actual invariant.

## Preload surface vs. documentation (now reconciled)

`apps/desktop/electron/preload.ts` exposes five `contextBridge` namespaces, only one of which
(`agentDock`) is upstream-derived; the other four (`vacancyRadar`, `workspace`, `cv`, `system`) are
product-specific additions. `docs/architecture.md`, `docs/client-sdk.md`, and `docs/electron.md`
previously all claimed "seven narrow IPC capabilities" — accurate for `agentDock` at the fork point,
but stale now that `agentDock` alone has 11 methods (4 added by the MCP foundation) and the other
four namespaces (33 more methods across them) were never documented at all. All three docs have been
corrected as part of this ADR to describe the real, current five-namespace surface; see
[electron.md](electron.md#the-preload-bridge) for the authoritative list.

## Golden/regression coverage added or confirmed for this ADR

| Area | Status before this ADR | Action taken |
|---|---|---|
| v1 routes, SSE streaming, cancellation | Already covered (`apps/daemon/test/server.test.ts`) | None needed |
| Claude model propagation | Covered at the schema/manager layer only; no full-HTTP-route test | Added a `POST /sessions` route-level test in `server.test.ts` asserting a `model` field in the request body reaches the provider's `startedOptions` |
| Compiled vacancy-source MCP | Manager/routes/SDK-connector logic covered; the shipped-empty invariant was unpinned | Added `apps/daemon/test/index.test.ts` pinning the empty policy array |
| Preload key allowlist | `agentDock`/`vacancyRadar`/`workspace`/`cv` covered; `system` had zero coverage | Added an exact-allowlist test for `system` in `apps/desktop/test/preload.test.ts` |
| Payload validation, safe external URLs, product database schemas | Already covered | None needed |
| Packaged resources | Path-resolution logic (`resolve-daemon-entry`, `resolve-vacancy-engine-paths`, `resolve-window-icon`) covered; nothing checked that `electron-builder.yml`'s `extraResources` actually matches what those resolvers expect | Added `apps/desktop/test/electron-builder-resources.test.ts`, a one-directional static check that the YAML declares the paths the resolvers expect. It cannot catch drift starting on the resolver side (a path literal renamed there without a matching yaml edit), since neither resolver exports its path segments as a constant this test could share instead of hardcoding its own copy — closing that direction is a real gap this ADR leaves open, not one it claims to close |

One gap is explicitly **not** closed by this ADR and is called out for whoever picks it up: there is
no automated check that `apps/desktop/electron/workspace/schema.ts` and
`packages/vacancy-engine/src/db/schema.ts` stay in sync with their respective Drizzle migration
folders — only manual `drizzle-kit generate` catches drift today. This is a real gap, but adding
migration-diffing CI is a larger, separately-scoped change and out of bounds for ADI-01.

## Reproducible asset-validation environment

`pnpm run assets:validate` (`scripts/assets/validate_assets.py`, Pillow + CairoSVG) already has a
documented, pinned Python environment in [assets.md](assets.md) (`python -m venv .venv-assets`,
`scripts/assets/requirements.txt`). While verifying this criterion, a real, pre-existing bug was
found and fixed: the validator's exact-file-set check for `assets/app-icons/` had not been updated
after PR #89 added `installer.nsh` and `vc_redist.x64.exe` to that directory, so the validator
failed on an unrelated, correct state. `check_exact_files` now accepts an `allow_extra` parameter,
and the `ICON_ROOT` check allowlists those two files.
