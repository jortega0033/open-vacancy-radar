# Loop Constraints

These rules are binding for every loop run.

## L2 scope

- Triage plus ONE narrowly scoped fix per run, delivered as a pull request from an isolated git worktree branched from fresh `origin/master`. Never edit the main checkout or other worktrees.
- Source edits are allowed only inside that fix worktree and only within the minimal-fix scope: the smallest change, no unrelated refactor.
- An independent verifier (`loop-verifier`, a different agent than the implementer) must re-run tests and check diff scope and protected paths before the PR is opened.
- Outside the fix worktree, only `STATE.md` and `loop-run-log.md` may change.
- At most one primary specialist per task, plus a separate verifier. A specialist may edit only inside the fix worktree and only within the minimal-fix scope. It may not push, open, or merge a PR; the loop owner does that after verification. Overlapping roles are not stacked.

## Push and merge

- Never push to `master` or the default branch. Only the fix branch may be pushed, and only after verification passes.
- Never merge or auto-merge a PR. Merging is a human decision. In an interactive session the user may explicitly tell the assistant to merge for that session only; that never carries over to a later loop run.
- Do not close or edit issues beyond adding one comment with the PR link.
- Never touch other open PRs.
- No scheduler or unattended trigger; the loop stays opt-in and manual.

## Protected paths and secrets

- Never edit `.env`, `.env.*`, credentials, secrets, authentication, payments, infrastructure configuration, or CI release workflows during a loop run.
- Never expose secret values in output or logs.

## Code and verification

- Never disable or weaken tests.
- Never refactor unrelated code.
- One narrowly scoped fix per run; stop after three failed attempts on one item and escalate in `STATE.md`.

## Communication and budget

- State the intended action before any mutation.
- At 80% of the daily cap, remain report-only; at 100%, stop.
- If `loop-pause-all` is active, exit immediately.

---

<!-- Add project-specific rules below. -->
