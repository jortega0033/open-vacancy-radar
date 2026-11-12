# Claude project instructions

Read [AGENTS.md](AGENTS.md) first; it is the canonical shared guidance. Preserve unrelated changes and the passive L1 loop boundary.

## Orientation

- [docs/repo-map.md](docs/repo-map.md): where everything lives, the real package dependency graph, and the `electron/` feature-module convention (`<feature>.ts` / `-parse` / `-service` / `-ipc` + `workspace/*-store.ts`). Follow that shape for new desktop features.
- [DEVELOPMENT.md](DEVELOPMENT.md) "I want to change X" table and "Common architectural rules" are binding: no shell strings, renderer never reaches the daemon, no provider-id branching outside `packages/agent-runtime`, no generic IPC passthrough, every IPC input Zod-validated and registered through `guardedIpc`.
- Verify with `pnpm typecheck && pnpm lint && pnpm test && pnpm build`; narrower: `pnpm --filter <pkg> exec vitest run <path>`. Desktop tests live in the flat `apps/desktop/test/`, not beside sources.

The landing page cloud project `ovr-landing` moved intact to `vialeighortega@gmail.com` and organization `772038913203` on 2026-11-01. See [the migration decision](docs/adr-cloud-account-migration-2026-11-01.md) and [Terraform operations](https://github.com/jortega0033/cloud-infrastructure/tree/main/projects/open-vacancy-radar). Deploy with `pnpm deploy:landing`, never a bare Firebase deployment. Keep the existing no-billing Spark setup. Do not delete the live project to remove an old account's access.
