# Open Vacancy Radar agent instructions

## Code discovery

- Use the codebase-memory graph first when its MCP tools are available: `search_graph`, `trace_path`, `get_code_snippet`, `query_graph`, then `get_architecture`.
- Fall back to text/file search for literals, errors, configuration, non-code files, or when the graph is insufficient.

## Agency specialists

- Project specialists are defined in `.codex/agents/agency-*.toml`; their source playbooks remain in `.claude/agents/`.
- Outside an L1 loop, delegate at most one bounded task to one primary specialist when specialization materially helps. Add `agency_code_reviewer` only when an independent review materially helps.
- Do not stack overlapping roles or let a role broaden the user's scope.
- Specialists inherit the parent session's MCP and permissions. They must not edit unless the delegated task authorizes implementation.
- During an L1 loop, do not delegate to any specialist.

## Loop Engineering

- The local loop is opt-in and passive. No scheduler or automation is implied by these files.
- Current maturity is L1: triage and state/report updates only. Do not auto-fix source, push, open/merge PRs, or mutate external systems.
- A loop run loads `$loop-constraints`, then `$loop-budget`, then `$loop-triage`, and reads `STATE.md` before reporting.
- Keep loop state changes limited to `STATE.md` and `loop-run-log.md`. Stop when there is no actionable signal.

## Scope

- Preserve unrelated working-tree changes.
- Prefer the narrowest change that proves the requested outcome.
