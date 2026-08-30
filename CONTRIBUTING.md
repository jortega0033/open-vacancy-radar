# Contributing

Thanks for considering a contribution to Open Vacancy Radar. Its local AI runtime is based on
AgentDock and can be used as the base for other products. Keep the shared runtime small,
provider-neutral, and understandable to contributors who reuse it.

## Contribution workflow

1. Search existing issues before starting work. Use the issue forms for bugs, features, or questions.
2. Discuss large, security-sensitive, or architecture-changing work in an issue before implementation.
3. Work from a focused branch in your fork; direct pushes to the default branch are blocked.
4. Open a pull request using the repository template and link the relevant issue.
5. Resolve review conversations and keep all required checks green before merge.

Report vulnerabilities privately through the repository's **Security** tab, never through a public
issue or pull request.

## Development setup

```bash
pnpm install
pnpm typecheck
pnpm test
```

Requires Node 22+ and pnpm (see the `packageManager` field in the root `package.json` for the
exact version this repo was built against).

## Project structure

See [docs/architecture.md](docs/architecture.md) for the component details and
[DEVELOPMENT.md](DEVELOPMENT.md) for an "I want to change X, start here" map. In short:
`packages/shared` (types/contracts) → `packages/agent-runtime` (provider adapters, process
management) → `apps/daemon` (HTTP+SSE server) → `apps/desktop` (Electron+React demo client).
Dependencies only flow in that direction.

### Job source contributions

The default product decision is to integrate lawful public vacancy sources. Follow the
[job source policy](docs/job-source-policy.md): prefer official APIs and feeds, keep all requests
behind the existing safe HTTP boundary, preserve direct application URLs and attribution, and add
local fixtures for complete and failure outcomes. A source that takes longer to implement remains
planned. Uncertain permission limits a connector to
the factual linked-index mode; authentication or access-control bypass and explicit automation or
licensing prohibitions are stop conditions.

## Architecture rules

These rules protect the security model and the dependency boundaries checked by the tests. The
full list, with the reason for each rule, is
[DEVELOPMENT.md#common-architectural-rules](DEVELOPMENT.md#common-architectural-rules); briefly:
never build a shell command string, never let the renderer call the daemon directly, never accept
an executable path from a request, never branch on provider id outside `packages/agent-runtime`,
never add a generic IPC passthrough to the preload bridge.

## Testing requirements

- Never make a test depend on an authenticated Claude or Codex CLI, and never make one that spends
  API credit. CI has neither. See
  [DEVELOPMENT.md#testing-without-paid-providers](DEVELOPMENT.md#testing-without-paid-providers)
  for the fixture-based pattern this project uses instead.
- Never commit a fixture, test, or example that contains a real credential, token, or account
  identifier, even a revoked or expired one. Provider CLI fixtures are small `node` scripts
  standing in for the real CLI's I/O shape, never real recorded CLI output.
- If your change affects the public contract, anything in
  [docs/protocol-v1.md](docs/protocol-v1.md)'s "public/stable" list, `@agent-dock/client`'s exports,
  or a daemon route's shape, update the relevant doc (`docs/protocol-v1.md`, `docs/client-sdk.md`,
  or `docs/daemon.md`) in the same PR.

## Before opening a PR

```bash
pnpm typecheck   # strict TypeScript, no `any` without a comment justifying it
pnpm lint
pnpm test        # must pass without a real Claude/Codex install or any paid API call
pnpm build
pnpm audit       # electron-builder's own build-time dependencies are a documented exception;
                 # see docs/packaging.md; nothing shipped in the app should show up here
```

If you touched anything under `apps/desktop/electron/` (main process, preload, or packaging
config), also run `pnpm package:win` (Windows) and confirm the app still launches from
`dist-packages/win-unpacked/Open Vacancy Radar.exe`. Packaging can fail in ways that `pnpm build`
does not detect. See
[docs/packaging.md#verifying-a-packaging-sensitive-change](docs/packaging.md#verifying-a-packaging-sensitive-change)
for examples.

CI runs the same checks on every push and pull request (`.github/workflows/ci.yml`):
`pnpm install --frozen-lockfile`, `lint`, `typecheck`, `test`, and `build`, in that order, on Linux.
A separate workflow (`.github/workflows/package-windows.yml`) runs `pnpm package:win` on Windows
and fails if it does not produce the NSIS installer. Neither workflow installs or authenticates a
Claude or Codex CLI. See [Testing requirements](#testing-requirements).

### Provider contribution checklist

If you're touching a provider adapter (`packages/agent-runtime/src/providers/*`), add or update:

- a **parser unit test** against a realistic fixture of the CLI's native JSONL output (see
  `packages/agent-runtime/test/codex-parser.test.ts` for the pattern)
- if the change affects process lifecycle (spawning, cancellation, exit handling), an
  **integration test** using a small `node` fixture script standing in for the real CLI (see
  `packages/agent-runtime/test/run-session.test.ts` and `test/fixtures/*.mjs`)
- if you're adding a new provider entirely, the full checklist in
  [docs/providers.md#adding-a-new-provider](docs/providers.md#adding-a-new-provider), including a
  run of the shared `describeProviderContract()` suite against your adapter

## Code style

- TypeScript strict mode, no `any` unless there's a comment explaining why it's unavoidable.
- Avoid comments that only restate *what* code does. Use a comment for a
  non-obvious *why*: a constraint, an invariant, a workaround for a specific CLI quirk.
- Small, focused modules over one big file. If you're adding a provider, follow the existing
  `detect.ts` / `parser.ts` / `adapter.ts` split (see [docs/providers.md](docs/providers.md#adding-a-new-provider)).
- Do not add an abstraction or configuration option for a hypothetical future need. This base
  project should remain easy to adapt and reduce; it is not a general framework.

## Scope

Please open an issue before working on anything that would add: persistence (SQLite/a database),
authentication of the app's own users, telemetry/analytics, a new heavy dependency, or a new
provider mode (API-key based, cloud-hosted). These are explicitly out of scope for the current
version. See the README's "What this is not" section. Maintainers will decide these changes case by
case.

## License

By contributing, you agree your contribution is licensed under this project's
[Apache-2.0 license](LICENSE).
