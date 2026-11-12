# Repository map

A navigation index for contributors and coding agents: where things live and which pattern each
area follows. It points at the deeper documents instead of repeating them. Read
[architecture.md](architecture.md) for the reasoning behind the layers and
[DEVELOPMENT.md](../DEVELOPMENT.md) for the change workflow. Checked against the tree on 2026-11-13.

## Product in one paragraph

Open Vacancy Radar is a local-first Electron desktop app for finding remote frontend vacancies,
tracking applications, and preparing CVs and letters. Data lives in local SQLite. AI features run
through the user's own installed `claude` and `codex` CLIs, which a separate local daemon (AgentDock)
drives. The project never holds an API key. A static marketing page is deployed separately to
Firebase Hosting.

## Workspace packages (pnpm, Node 22)

| Path | Package | Role |
|---|---|---|
| `packages/shared` | `@agent-dock/shared` | Protocol v1 (`AGENT_DOCK_PROTOCOL_VERSION`), `AgentEvent` union, Zod schemas, v2 session/workspace/capability types. Leaf package. |
| `packages/agent-runtime` | `@agent-dock/agent-runtime` | Provider-neutral CLI runtime: process spawning and tree-kill, JSONL parsing, normalization into `AgentEvent`, model/stage routing policy. |
| `packages/client` | `@agent-dock/client` | Typed HTTP+SSE SDK for the daemon. The only way Electron main talks to it. |
| `packages/vacancy-engine` | `@open-vacancy-radar/vacancy-engine` | Deterministic discovery pipeline (ATS APIs, feeds, keyed boards), eligibility and relevance filtering, IND sponsor lookup, own SQLite DB. Has a standalone CLI. Leaf package. |
| `packages/application-executor` | `@agent-dock/application-executor` | CDP primitives for application forms: field maps, readiness, read-back, submit control, receipt detection, target policy. Leaf package. Not exposed in the UI yet. |
| `apps/daemon` | `@agent-dock/daemon` | Fastify server on `127.0.0.1` with bearer auth: sessions, SSE, v2 workspaces/applications/audit, MCP job sources. |
| `apps/desktop` | `@agent-dock/desktop` | Electron main plus the React renderer. Most of the product lives here. |
| `apps/landing` | (not a package) | Static HTML/CSS/JS served by Firebase target `landing`. See AGENTS.md before you deploy. |

### Dependency graph

```
shared ← agent-runtime ← daemon ─(live-smoke CLI only)→ client
shared ← client ← desktop → vacancy-engine
                         → application-executor
```

Rule: nothing imports "up". The daemon never imports from desktop, and agent-runtime never imports
from daemon. [architecture.md](architecture.md#dependency-graph) has the same graph with its
rationale.

## Runtime topology

```
Renderer (React, jsdom-testable)
   │  window.* bridges (contextBridge, 16 narrow APIs, see docs/electron.md)
   ▼
Electron main (apps/desktop/electron)
   ├─ workspace.db        personal data: drizzle + better-sqlite3 (electron/workspace/)
   ├─ vacancy-engine.db   discovery data: vacancy-engine runs in-process in main
   ├─ application-executor (CDP against a controlled BrowserView)
   └─ @agent-dock/client ──HTTP+SSE, bearer──▶ daemon ──▶ agent-runtime ──▶ claude / codex CLI
```

## `apps/desktop` in detail

### `electron/` (main process, about 118 top-level modules)

- `main.ts` (about 4.3k lines) is the composition root. It creates the window, spawns or attaches to
  the daemon, and registers about 174 IPC handlers through `guardedIpc` (`ipc-sender-guard.ts`), which
  rejects any caller other than the main window's top-level frame.
- `preload.ts` (about 2.4k lines) exposes the 16 bridges listed in
  [electron.md](electron.md#the-preload-bridge). Renderer types are in `src/window.d.ts`, and the
  exact method allowlists are asserted in `test/preload.test.ts`.
- **Feature-module convention.** Newer features split into flat sibling files:

  | Suffix | Responsibility |
  |---|---|
  | `<feature>.ts` | Pure domain logic and types |
  | `<feature>-types.ts` | Shared types and bridge contracts when they are large |
  | `<feature>-parse.ts` | Validates and normalizes untrusted model or page output |
  | `<feature>-service.ts` | Orchestration with injected `Deps` (store, clock, client) |
  | `<feature>-ipc.ts` | Strict Zod input schemas and handlers as plain functions. `main.ts` only registers them. Writes go through the data-reset gate. |
  | `<feature>-relay.ts` / `-notify.ts` | Daemon-event relays and OS notifications |

  Examples: `application-brief*`, `application-critique*`, `company-evidence*`, `blind-apply*`,
  `application-actions*`. Follow this shape for new features.
- `workspace/` holds persistence. `schema.ts` is the drizzle schema, `drizzle/` holds generated
  migrations (`pnpm --filter @agent-dock/desktop workspace:db:generate`), `repository.ts` is the core
  repository, and each feature has its own `*-store.ts`. Zod record schemas are in `*-schema.ts`.
- Vacancy scanning is in `vacancy-scan-*.ts`, `vacancy-run-intent.ts`, `vacancy-web-discovery.ts`,
  and `source-scout*.ts`.
- The daemon lifecycle is in `daemon-*.ts`: environment, lock attach, ready retry, respawn, restart.
- The application pipeline (checkpoint state machine) is `application-pipeline.ts`. It is a separate
  state machine from the daemon's `application-queue-store.ts`. Check which one you are changing.

### `src/` (renderer)

- `App.tsx` handles navigation with plain `useState<NavPage>`. There is no router and no state
  library. State lives in components and small `use*` hooks next to them.
- `components/<area>/` covers search, saved, applications, cv, cv-library, letters, profile, runtime,
  settings, brief, generation, agent-workspace, support, brand, and shell. `shell/` holds the shared
  primitives (`ConfirmDialog`, `UndoToast`, `EmptyState`, and the app frame).
- Styling uses `src/styles/tokens.css` as the single token source. See `DESIGN-TOKENS.md`.
- The renderer never imports `@agent-dock/client` and never sees the daemon token or URL.

### Tests

- `test/` is a flat Vitest suite (jsdom) covering both renderer and main-process modules. No tests
  sit next to the source.
- `e2e/` is Playwright driving the **built** Electron app. Snapshot baselines are Linux-generated.
  Fixtures and seed scripts live alongside.

## `apps/daemon/src`

- `server.ts` handles auth, origin, and CORS refusal. Read SECURITY.md before you change it.
  `index.ts` is the entry point. `discovery-file.ts` writes the port and token discovery file.
- `routes/` has v1 (`/sessions`, `/providers`, `/health`), v2 (`/v2/sessions|applications|workspaces|audit|providers|stage-routing`),
  `/mcp/*`, and the `vacancy-web-discovery` and `application-field-map` session helpers.
- Durable state is in `*-store.ts` plus `durable-store/atomic-fs.ts`. `session-lineage-store.ts` is
  the session history.
- `mcp/` is the MCP job-source layer. One reviewed no-auth provider (InfoSec Job Board) is registered.
- `live-smoke/` is an opt-in real-CLI smoke runner (`.github/workflows/live-provider-smoke.yml`).
- `native/windows/` is the C# job host for process-tree containment on Windows.

## `packages/agent-runtime/src`

- `providers/{claude,codex}/` each contain `adapter`, `build-args`, `parser`, `capabilities`, and
  `detect`. Codex also has an `app-server/` JSON-RPC transport. `providers/fake/` is used in tests.
- `providers/common/` is shared lifecycle code: `run-session`, `session-supervisor`, fallback gate,
  launch scope, and accepted-work.
- `process/` handles spawning (`shell: false`, argv only) and the Windows job host.
- `policy/stage-routing/` handles per-stage model selection, escalation, and telemetry.
- Provider-id branching is allowed **only** in this package.

## `packages/vacancy-engine/src`

- `ats/` has one adapter per ATS (greenhouse, lever, ashby, workday, workable, and others).
  `factory.ts` and `detection.ts` select the adapter.
- `global-remote/` is the main discovery pipeline. It contains one `*-discovery.ts` per source family,
  `source-registry.ts`, the search plan and its ledger, `evaluation.ts` (the discovery
  pre-classifier), and `report.ts`.
- `filtering/relevance.ts` is the frontend role scorer (concepts and title rules). `eligibility/`
  and `geo/` handle the remote-eligibility and language rules.
- `crawler/` is the HTTP client with request budgeting, caching, `url-safety.ts`, and the scheduler.
- `ind/` and `companies/` handle the IND sponsor register, Wikidata lookups, and the ATS roster.
- `db/` is the engine's own drizzle schema. `cli.ts` contains the `pnpm scan`, `roster-import`, and
  `sponsor-sync` commands.

## Repository-level files

| Path | What |
|---|---|
| `AGENTS.md` | Canonical agent guidance: code discovery, scope, L1 loop limits, landing deploy |
| `CLAUDE.md`, `CODEX.md` | Thin per-tool pointers to AGENTS.md |
| `STATE.md`, `LOOP.md`, `.agents/skills/loop-*` | Passive L1 triage loop. A loop run may write only `STATE.md` and `loop-run-log.md`. |
| `.claude/agents/`, `.codex/agents/` | Specialist role definitions (the `.toml` files mirror the `.md` playbooks) |
| `.claude/ticket-drafts/`, `.claude/audits/` | Draft issues and audit reports. These are planning material, not specifications. |
| `docs/` | Topic documents (protocol, daemon, electron, providers, packaging, security-adjacent policies), ADRs (`adr-*.md`), runbooks, research (`docs/research/`), and release notes |
| `docs/capability-matrix.md` | Checked in CI by `pnpm docs:check-capabilities` |
| `docs/role-scope-research.md` | Its `path:line` citations are pinned by `apps/desktop/test/role-scope-research/doc-references.test.ts`. Moving a cited line fails that test on purpose. |
| `scripts/` | `preflight.mjs` (preinstall), release tooling, capability-matrix check, asset generation and validation (Python) |
| `.github/workflows/` | ci, e2e (Xvfb), windows-test, package-windows, release, secret-scan, live-provider-smoke, deploy-landing |
| `firebase.json`, `.firebaserc` | Hosting target `landing` serves `apps/landing` |

## Verification commands

```bash
pnpm typecheck && pnpm lint && pnpm test && pnpm build      # PR gate (CI runs these on Linux)
pnpm docs:check-capabilities                                # when docs/capability-matrix.md or tests it cites change
pnpm test:provider-conformance                              # when agent-runtime provider code changes
pnpm --filter @agent-dock/desktop run build && pnpm --filter @agent-dock/desktop run test:e2e   # UI flows
pnpm package:win                                            # when electron/ main, preload, or packaging changes
```

Single package: `pnpm --filter <name> exec vitest run <path>`.
