# Open Vacancy Radar

An open-source Electron desktop app for finding frontend-developer vacancies, tracking
applications, and preparing CVs and cover letters. Application data stays in an embedded SQLite
workspace on the user's computer, with no external database or cloud account. AI features use the
AgentDock runtime to run agent CLIs that the user has installed and authenticated. Supported CLIs
currently include [Claude Code](https://docs.anthropic.com/en/docs/claude-code) and
[Codex](https://github.com/openai/codex). This project never receives the user's password, token,
or API key.

![Open Vacancy Radar search workspace](docs/images/social/readme-hero.webp)

_Reference interface shown with sample data; production behavior comes from the Electron source in
this repository, not the bundled prototype used to prepare the image._

## What this is

A personal job-search workspace with two defined discovery pipelines. Every match comes from the
Netherlands sponsor search or the Worldwide / Remote search:

- **Netherlands:** frontend vacancies cross-checked against the IND's official recognised-sponsor
  register, so a match means the employer is a verified sponsor, not just a keyword hit.
- **Worldwide / Remote:** frontend-only roles from about 50 reviewed public sources (ATS APIs, RSS
  feeds, keyed job-board APIs), filtered for remote roles that are not limited to US candidates.

Both pipelines try official ATS APIs and structured feeds first, followed by plain HTTP, JSON-LD,
and HTML parsing. A limited headless-browser fallback is used only when those methods do not work.
See [packages/vacancy-engine](packages/vacancy-engine) for the engine. It was copied from the
standalone `ind-job-radar` CLI project and ported from PostgreSQL to an embedded `better-sqlite3`
database, so the desktop app does not need a separate database service.

Vacancy coverage is a product requirement. A lawful public source is integrated in the broadest
mode supported by the available evidence. Sources that take longer to implement remain planned.
When republication rights are unclear, the app stores factual metadata and a link to the source.
Explicit prohibitions, authentication or partner requirements, and technical access controls stop
ingestion. See
[the job source policy](docs/job-source-policy.md).

The desktop app also includes a personal job tracker:

- **Search:** run either pipeline on demand, save leads, or open the CV assistant on any result.
- **Saved Jobs** / **Applications:** track each application from start to finish, with confirmation
  before deletion and a short undo window on every delete.
- **CV Library:** upload or enter multiple CVs, mark one as the default, and compare any CV with a
  specific vacancy.
- **Letters:** generate motivation letters, cover letters, recruiter messages, or short
  application-form responses from a CV and vacancy, with a chosen tone and length, and save the
  drafts.
- **Settings:** theme (light/dark/system), density, default market, and data export/reset, all
  persisted locally.
- **AI Runtime:** choose a provider (Claude Code or Codex), select a model when supported, and view
  events as the run proceeds.

If a user already has `claude` or `codex` installed and logged in, Open Vacancy Radar can use that
existing session for gap analysis and letter drafting. The installed CLI handles authentication;
this project never receives a password, token, or API key.

```
Renderer (React) ──IPC──▶ Electron main ──@agent-dock/client──▶ Local Daemon (Fastify, protocol v1)
                              │                                          │
                    embedded SQLite (workspace +               Unified Agent Runtime
                    vendored vacancy-engine)              ├── Claude Code adapter ──▶ claude CLI
                                                           └── Codex adapter ────────▶ codex CLI
```

The renderer never calls the daemon directly. Only Electron's main process does, through the typed
`@agent-dock/client` SDK. See
[SECURITY.md](SECURITY.md#renderer-never-talks-to-the-daemon-directly) for why, and
[Client SDK](#client-sdk) below for what that package looks like from the outside.

See [docs/architecture.md](docs/architecture.md) for the component details and
[SECURITY.md](SECURITY.md) for the daemon's protections and their rationale.

## Where do I start?

- **Just want to run it?** [Getting started](#getting-started) below.
- **Want to contribute to this repo?** [DEVELOPMENT.md](DEVELOPMENT.md): setup, an "I want to
  change X" map of the codebase, and the common architectural rules that keep the security model
  intact.
- **Want to build your own product on top of AgentDock?** [Building your own product](#building-your-own-product-with-agentdock)
  below.
- **Want to add a provider (a third CLI besides Claude/Codex)?**
  [docs/providers.md#adding-a-new-provider](docs/providers.md#adding-a-new-provider): includes the
  shared provider ID and desktop display label. No provider-specific daemon routes or client
  methods are required.
- **Something's not working?** [docs/troubleshooting.md](docs/troubleshooting.md).

## What this is not

- **Not** an unofficial authentication bypass: every CLI call goes through the real `claude`/`codex`
  binary using its own login state. Nothing here reads, copies, or reverse-engineers credential storage.
- **Not** a token extractor or an API proxy: this project never makes a direct Anthropic/OpenAI API
  call and never asks a user for an API key in CLI mode.
- **Not** a hosted job portal or cloud account service: application data stays in the local
  desktop workspace, and the AI runtime remains provider-neutral infrastructure.
- **Not** a replacement for Claude Code or Codex: it runs those CLIs through a common interface.

## Repository layout

```
apps/
  desktop/          Open Vacancy Radar Electron + React application
                       src/components/{search,saved,applications,cv-library,letters,settings}/
                       electron/workspace/  the personal-data SQLite schema, IPC, and repository
  daemon/           Standalone local Node.js service (Fastify), runnable without Electron
packages/
  vacancy-engine/   The discovery/scoring engine (NL sponsor pipeline + Worldwide / Remote pipeline),
                     vendored from the standalone `ind-job-radar` CLI and ported to embedded SQLite
  agent-runtime/    Provider-neutral runtime: process management, adapters, normalized events
  client/           @agent-dock/client: typed daemon SDK (HTTP+SSE, auth, protocol version check)
  shared/           Types, Zod schemas, and the protocol v1 AgentEvent contract everything else uses
```

Design tokens and shared UI components live in `apps/desktop/src/styles/tokens.css` (the shared
theme, color, and spacing definitions; see [DESIGN-TOKENS.md](apps/desktop/DESIGN-TOKENS.md)) and
`apps/desktop/src/components/shell/` (`ConfirmDialog`, `UndoToast`, `EmptyState`, and the app
shell), reused across every page rather than redefined per feature.

## Requirements

Install and authenticate the CLIs you want to use, independently of this project:

```bash
# Claude Code
claude auth login
claude auth status

# Codex
codex login
codex login status
```

This project never automates account signup or handles credentials on your behalf. Do that
directly with each CLI first.

## Getting started

```bash
pnpm install

# Run the daemon on its own (no Electron required)
pnpm daemon

# In another terminal, verify the daemon is running
curl http://127.0.0.1:<port>/health
```

The daemon prints its listening URL and where it wrote its discovery file (port + auth token) on
startup. See [SECURITY.md](SECURITY.md#local-auth-token) for what that file is and why the token
exists, and [docs/daemon.md](docs/daemon.md) for everything else about running it standalone.

To run the full desktop app (spawns the daemon automatically):

```bash
pnpm dev:desktop
```

No database server or setup step is required: both the vacancy-engine's own database and the
personal workspace database are embedded SQLite files under Electron's per-user app-data directory,
created and migrated automatically on first launch. `pnpm install`'s `postinstall` step also
rebuilds `better-sqlite3`'s native binding against Electron's ABI (`electron-rebuild`). A plain
`node_modules` install alone is not sufficient for the desktop app to run.

### Everyday commands

```bash
pnpm build       # build every package
pnpm typecheck   # strict TypeScript across the whole workspace
pnpm test        # unit + integration tests (no real CLI calls; see docs/providers.md)
pnpm lint        # ESLint
```

These four also run in CI on every push and pull request, plus a separate Windows job that runs
`pnpm package:win` and checks that it produces an installer. See
[CONTRIBUTING.md](CONTRIBUTING.md#before-opening-a-pr).

## Production build

`pnpm build` compiles every package in dependency order and produces:

- `packages/shared/dist/`, `packages/agent-runtime/dist/`: compiled library output
- `apps/daemon/dist/index.js`: the daemon bundled by esbuild into **one self-contained file**
  (every dependency inlined, including the two packages above). This is required so it can run under
  plain `node`, with no workspace resolution or `tsx`, once packaged. See
  [docs/architecture.md](docs/architecture.md#daemon-discovery-and-lifecycle) for the packaging
  constraints.
- `apps/desktop/dist/`: the Vite production build of the React renderer
- `apps/desktop/dist-electron/main.js`, `preload.js`: the Electron main process and preload
  script, each bundled to a single file (`main.js` inlines `@agent-dock/client`,
  `@agent-dock/shared`, and `zod`; `preload.js` is forced to CommonJS since Electron's sandboxed
  preload loader doesn't support ESM)

These outputs are not an installer. They confirm that the code compiles into runnable files.
Running `electron .` against `apps/desktop` starts the unpacked app for a check without a full
packaging step.

## Packaging (Windows)

```bash
pnpm package:win   # pnpm build, then electron-builder --win nsis
```

Produces, under `dist-packages/` at the repo root:

- `dist-packages/win-unpacked/`: the unpacked app (`Open Vacancy Radar.exe` + `resources/`)
- `dist-packages/Open Vacancy Radar-Setup-<version>.exe`: the NSIS installer

`pnpm package` (no `:win`) runs `electron-builder` for whatever platform you're on; today that's
only meaningfully tested on Windows. Both commands are non-interactive and safe to run from a clean
checkout after `pnpm install`, with no signing configured. See
[docs/packaging.md](docs/packaging.md) for the runtime layout once packaged, why the daemon ships
outside `app.asar`, and the full Windows-only platform matrix.

## Client SDK

`@agent-dock/client` is the typed client for the daemon. It handles HTTP requests and responses,
bearer-token authentication, incremental SSE parsing, and the protocol-version compatibility check
(see [Protocol v1](docs/protocol-v1.md)), so a caller never hand-writes daemon URLs, headers, or
event-stream parsing. It is a TypeScript package with no Electron or browser dependency. It can be
used from Electron's main process (as this desktop app does), a Node CLI, or a
future VS Code extension. See [docs/client-sdk.md](docs/client-sdk.md) for the full public API
(including `sessions.get`/`sessions.delete`, not shown below) and design decisions.

```ts
import { AgentDockClient } from '@agent-dock/client';

const client = new AgentDockClient({ baseUrl: 'http://127.0.0.1:PORT', token });

const providers = await client.providers.list();

const session = await client.sessions.create({
  provider: 'claude',
  cwd: '/path/to/project',
  prompt: 'Inspect this repository',
});

for await (const event of client.sessions.events(session.id)) {
  console.log(event); // AgentEventEnvelope: a normalized AgentEvent plus sequence/timestamp
}

await client.sessions.cancel(session.id);
```

Failures use typed errors: `DaemonUnavailableError`, `UnauthorizedError`, `ProtocolMismatchError`,
`ValidationError`, `SessionNotFoundError`, `ProviderUnavailableError`, and `DaemonError`. A caller
can `catch` and branch on `instanceof` instead of parsing error strings. See
[docs/client-sdk.md](docs/client-sdk.md) and [docs/protocol-v1.md](docs/protocol-v1.md).

## Adding a provider

See [docs/providers.md](docs/providers.md#adding-a-new-provider). Implement one adapter, declare its
capabilities, write its parser and tests, run it against the shared provider contract suite, and
register it. Add the provider to the shared ID list and desktop display-label map. No
provider-specific daemon routes or client methods are required.

## Building your own product with AgentDock

Open Vacancy Radar is the product layer built on AgentDock's reusable daemon and client packages.
To build a different product on the same foundation:

1. **Fork the repo** and treat `apps/desktop` as a starting point to replace, not extend in place.
   Keep `packages/shared`, `packages/agent-runtime`, `packages/client`, and `apps/daemon`
   largely as-is; your own product's UI and any product-specific logic (persistence, accounts,
   a specific end-user workflow) belongs in your own app, not upstream in these packages.
2. **Talk to the daemon the same way this repo does:** through `@agent-dock/client` from a trusted
   process (Electron main, a Node backend, a CLI), never from a browser/renderer context. See
   [SECURITY.md](SECURITY.md#renderer-never-talks-to-the-daemon-directly) for why that boundary is
   required if your product also runs in a browser-based renderer.
3. **Add product-specific persistence in your own layer**, not in `SessionStore`. This project's
   `MemorySessionStore` is intentionally ephemeral (see
   [docs/daemon.md#session-lifecycle-sessionmanager-sessionstore](docs/daemon.md#session-lifecycle-sessionmanager-sessionstore)).
   If you need session history to survive a restart, that's a product concern to build in your own
   app (e.g. by storing `AgentEventEnvelope`s as your product receives them over SSE), not something
   to retrofit into the daemon.
4. **Add a provider if you need one AgentDock doesn't ship:** see
   [docs/providers.md#adding-a-new-provider](docs/providers.md#adding-a-new-provider).
5. **Package it as your own app:** update `appId`, `productName`, and add an icon in
   `apps/desktop/electron-builder.yml` (see [docs/packaging.md](docs/packaging.md)); the daemon and
   client packages need no changes to ship under a different product name.

## Documentation

- [DEVELOPMENT.md](DEVELOPMENT.md): setup, an "I want to change X" map, common architectural rules
- [docs/architecture.md](docs/architecture.md): component responsibilities, runtime flow, trust boundaries, dependency graph
- [docs/protocol-v1.md](docs/protocol-v1.md): the `AgentEvent` union, wire format, ordering guarantees, what's public/stable
- [docs/client-sdk.md](docs/client-sdk.md): `@agent-dock/client`'s full public API and design decisions
- [docs/providers.md](docs/providers.md): how the Claude/Codex adapters work, provider capabilities, how to add another, the shared contract test suite
- [docs/daemon.md](docs/daemon.md): running the daemon standalone, routes, session lifecycle, discovery file
- [docs/electron.md](docs/electron.md): the renderer/main/daemon boundary, IPC bridge, where to safely add native functionality
- [docs/packaging.md](docs/packaging.md): electron-builder/NSIS specifics, verified commands, platform support
- [docs/assets.md](docs/assets.md): brand sources, icon generation, renderer mapping and rebranding
- [apps/desktop/DESIGN-TOKENS.md](apps/desktop/DESIGN-TOKENS.md): the design-token rules every component follows
- [docs/troubleshooting.md](docs/troubleshooting.md): common problems and how to diagnose them
- [SECURITY.md](SECURITY.md): the daemon's threat model and local-auth mechanism
- [CONTRIBUTING.md](CONTRIBUTING.md): contribution workflow and checklist

## License

[Apache-2.0](LICENSE)
