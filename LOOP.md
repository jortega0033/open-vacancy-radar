# Loop Engineering: Open Vacancy Radar

Status: installed locally, passive, L1 report-only. No automation has been created.

## Active loop

| Pattern | Cadence | Maturity | Invocation |
|---|---|---|---|
| Daily triage | Manual | L1 report-only | `Read STATE.md. Run $loop-constraints, then $loop-budget, then $loop-triage.` |

## L1 boundary

- May inspect authorized local state and connected read-only sources.
- May update only `STATE.md` and `loop-run-log.md` during an authorized run.
- May not edit source, auto-fix, push, create or merge PRs, close tickets, or mutate external systems.
- May delegate to one bounded agency specialist to assist triage; the specialist inherits the same
  L1 boundary and may not edit, push, or open/merge a PR either. `loop_verifier` remains reserved
  for a future human-approved L2 pilot. Its job is approving fixes, which L1 never makes.

## Promotion gate

Do not promote to L2 until the human has reviewed at least one week of useful triage, selected exact writable paths/actions, set a small budget, and approved an isolated worktree plus verifier flow.

Upstream: [Loop Engineering](https://github.com/cobusgreyling/loop-engineering). This local layout uses current Codex repository skills under `.agents/skills` rather than the upstream initializer's legacy `.codex/skills` path.
