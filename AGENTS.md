# Open Vacancy Radar agent instructions

## Code discovery

- Use the codebase-memory graph first when its MCP tools are available: `search_graph`, `trace_path`, `get_code_snippet`, `query_graph`, then `get_architecture`.
- Fall back to text/file search for literals, errors, configuration, non-code files, or when the graph is insufficient.

## Agency specialists

- Project specialists are defined in `.codex/agents/agency-*.toml`; their source playbooks remain in `.claude/agents/`.
- Delegate at most one bounded task to one primary specialist when specialization materially helps. At L2 a separate verifier (`loop-verifier`) may be added, and `agency_code_reviewer` only when an independent review materially helps.
- Do not stack overlapping roles or let a role broaden the user's scope.
- Specialists inherit the parent session's MCP and permissions. They must not edit unless the delegated task authorizes implementation.
- During a loop run (L2), a specialist may edit only inside the fix worktree and only within the minimal-fix scope. It may never push, open a PR, or merge. The loop owner does that after verification. The loop's own boundary always wins over the delegated task.

## Loop Engineering

- The local loop is opt-in and manual. No scheduler, cron, or unattended trigger is allowed or implied by these files.
- Current maturity is L2 (since 2026-10-06): triage plus one narrowly scoped fix per run, delivered as a pull request from an isolated git worktree branched from fresh `origin/master`.
- A run loads `$loop-constraints`, then `$loop-budget`, then `$loop-triage`, and reads `STATE.md`. It picks the single most actionable item, implements it with the `minimal-fix` discipline, has an independent `loop-verifier` (a different agent than the implementer) re-run tests and check diff scope and protected paths, opens the PR, records the run in `STATE.md` and `loop-run-log.md`, and stops.
- Still forbidden at L2: pushing to `master` or the default branch, merging or auto-merging any PR, closing or editing issues beyond one comment with the PR link, editing protected paths (`.env*`, credentials, secrets, authentication, payments, infrastructure, CI release workflows), touching other open PRs.
- Merging stays a human decision. In an interactive session the user may explicitly tell the assistant to merge, for that session only; that never carries over to a later loop run.
- Stop after three failed fix attempts on one item and escalate in `STATE.md`. Stop when there is no actionable signal.
- Outside the fix worktree, loop state changes are limited to `STATE.md` and `loop-run-log.md`.

### Model routing

Use the cheapest model that fits and escalate one step at a time. Independent review is always a different invocation from the implementation.

| Model | Use for |
|---|---|
| Haiku | Fact gathering, mechanical edits, merging master into a branch, small copy fixes |
| Sonnet | Implementation, test writing, reviews |
| Opus 5.5 | Design, architecture, hard debugging, anything Sonnet failed on twice; only when the item is labeled for it or the owner approves |

## Scope

- Preserve unrelated working-tree changes.
- Prefer the narrowest change that proves the requested outcome.
