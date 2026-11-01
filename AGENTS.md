# Open Vacancy Radar agent instructions

## Code discovery

- Use the codebase-memory graph first when its MCP tools are available: `search_graph`, `trace_path`, `get_code_snippet`, `query_graph`, then `get_architecture`.
- Fall back to text/file search for literals, errors, configuration, non-code files, or when the graph is insufficient.

## Agency specialists

- Project specialists are defined in `.codex/agents/agency-*.toml`; their source playbooks remain in `.claude/agents/`.
- Delegate at most one bounded task to one primary specialist when specialization materially helps, including during an L1 loop run, where a specialist may assist triage. Add `agency_code_reviewer` only when an independent review materially helps.
- Do not stack overlapping roles or let a role broaden the user's scope.
- Specialists inherit the parent session's MCP and permissions. They must not edit unless the delegated task authorizes implementation. During an L1 loop, no specialist may edit source, push, or open/merge a PR, regardless of what the delegated task asks. The loop's own L1 boundary always wins.

## Loop Engineering

- The local loop is opt-in and passive. No scheduler or automation is implied by these files.
- Current maturity is L1: triage and state/report updates only. Do not auto-fix source, push, open/merge PRs, or mutate external systems.
- A loop run loads `$loop-constraints`, then `$loop-budget`, then `$loop-triage`, and reads `STATE.md` before reporting.
- Keep loop state changes limited to `STATE.md` and `loop-run-log.md`. Stop when there is no actionable signal.

## Scope

- Preserve unrelated working-tree changes.
- Prefer the narrowest change that proves the requested outcome.

## Production landing page

- Cloud managing account: `vialeighortega@gmail.com`. Project `ovr-landing` (662399741047), organization `772038913203`. The project was transferred intact on 2026-11-01; the project ID and `https://ovr.web.app` stay unchanged.
- Deploy only with `pnpm deploy:landing` (pins project, account and `hosting:landing`). Firebase target `landing` maps to site `ovr`, serving `apps/landing` directly; no desktop build is needed. Do not deploy the separate default site `ovr-landing` accidentally.
- Keep this Firebase project on its existing free Spark setup, with no billing account attached, unless the owner explicitly requests a change.
- Infrastructure is in the private `jortega0033/cloud-infrastructure` repository under `projects/open-vacancy-radar`; read its README and `docs/adr-cloud-account-migration-2026-11-01.md` before changes. Terraform owns the foundation and GitHub OIDC; Firebase CLI owns Hosting releases.
- Remove old-account IAM access after verification. Never delete the live project as cleanup: there is no duplicate old project. Cloud landing-page ownership is independent of desktop SQLite workspaces and AI CLI authentication.
- These instructions describe an owner-requested migration; they do not expand the passive L1 loop's authorization.
