# Loop Constraints

These rules are binding for every loop run.

## L1 scope

- Report only; never edit source code.
- Only `STATE.md` and `loop-run-log.md` may change during an authorized run.
- May delegate to at most one bounded agency specialist (see `AGENTS.md`) when it materially helps
  triage. No specialist invoked during an L1 run may edit source, push, or open/merge a PR — the
  L1 boundary binds the specialist the same as the loop itself.

## Push and merge

- Never push without explicit user authorization.
- Never auto-merge to the default branch.
- Never create, close, or modify issues or pull requests without explicit user authorization.

## Protected paths and secrets

- Never edit `.env`, `.env.*`, credentials, secrets, authentication, payments, or infrastructure configuration during a loop run.
- Never expose secret values in output or logs.

## Code and verification

- Never disable or weaken tests.
- Never refactor unrelated code.
- One narrowly scoped fix per future L2 run; stop after three failed attempts and escalate.

## Communication and budget

- State the intended action before any mutation.
- At 80% of the daily cap, remain report-only; at 100%, stop.
- If `loop-pause-all` is active, exit immediately.

---

<!-- Add project-specific rules below. -->
