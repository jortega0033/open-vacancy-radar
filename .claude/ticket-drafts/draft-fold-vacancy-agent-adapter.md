## Goal
Fold `packages/vacancy-agent-adapter` into `packages/agent-runtime/src/policy/` -- deleting it as a standalone package -- with no behavior change, updating every importer that references `@agent-dock/vacancy-agent-adapter` (or whatever its actual npm package name is) across the repo.

## Why now
Surfaced in the audit's developer-experience review: `packages/vacancy-agent-adapter` is one of 19 distinct concepts (packages, processes, databases, queues, state machines, config layers) a new engineer must hold in their head just to safely change the Search -> Apply pipeline, per the DX audit's own count. It does not earn that weight. It has exactly one dependency, `@agent-dock/shared`; it sits entirely between the daemon and the provider adapters that `packages/agent-runtime` already owns, rather than fronting a distinct subsystem; and its own one-sentence description -- "model-selection and stage-routing policy layer" -- describes a policy module, not a package boundary. A policy layer with one dependency, no consumers outside the daemon-to-agent-runtime path, and a description that reads like a file comment is a package that exists for historical reasons, not architectural ones.

## Scope
- Grep the repo for `@agent-dock/vacancy-agent-adapter` (confirm the exact published name from `packages/vacancy-agent-adapter/package.json` first) and enumerate every importer before touching anything.
- Move `packages/vacancy-agent-adapter`'s source into `packages/agent-runtime/src/policy/`, preserving its exported surface (function/type names and signatures) so callers change their import path only, not their call sites.
- Update every importer found in the grep pass to import from `@agent-dock/agent-runtime` (or the appropriate subpath) instead of `@agent-dock/vacancy-agent-adapter`.
- Remove `packages/vacancy-agent-adapter/package.json`, its `tsconfig.json`/`tsconfig.build.json` pair, and the corresponding entry from any workspace root config (root `package.json` workspaces list, `pnpm-workspace.yaml`, or equivalent) so the dependency edge is actually gone from the graph, not just unused.
- Carry over `vacancy-agent-adapter`'s existing tests into `agent-runtime`'s test tree alongside the moved source, updating only their import paths.

## Non-goals
- No behavioral change to model-selection or stage-routing policy logic itself -- this is a package-boundary consolidation, not a policy rewrite.
- No change to `agent-runtime`'s existing provider-adapter responsibilities or public API beyond adding the moved policy exports.
- No broader dependency-graph cleanup beyond removing this one package and its edge (the audit's other 18 concepts are out of scope for this ticket).

## Acceptance criteria
- `packages/vacancy-agent-adapter/` no longer exists in the repo; its logic lives under `packages/agent-runtime/src/policy/`.
- Every former importer of `@agent-dock/vacancy-agent-adapter` builds and type-checks against the new `agent-runtime` import path, with no remaining reference to the old package name anywhere in the repo (source, configs, lockfile, docs).
- `agent-runtime`'s dependency on `@agent-dock/shared` (inherited from the folded-in code) is declared correctly in `agent-runtime/package.json` if not already present.
- Full test suite (including the carried-over policy tests, now running from `agent-runtime`) passes with no behavior change.
- Lockfile and workspace config no longer list `vacancy-agent-adapter` as a package.

## Risk
Low. This is a pure package-boundary move with an explicit no-behavior-change constraint, and the package has a small, single-dependency surface. The main failure mode is an incomplete grep missing an importer (e.g. a dynamic import, a re-export chain, or a reference in a build/CI config rather than application source) -- worth a second pass checking `pnpm-lock.yaml`/`package-lock.json` and any Dockerfiles or CI workflow files for the old package name before calling this done.
