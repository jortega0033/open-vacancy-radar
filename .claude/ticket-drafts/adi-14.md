## Objective
Move Codex's prompt delivery from argv to stdin, matching upstream and matching this repo's own already-shipped Claude behavior, closing a real correctness and disclosure gap in currently-shipped code.

## Why this is urgent, not speculative
Verified directly against this repo's current state: `packages/agent-runtime/src/providers/codex/build-args.ts` still returns `['exec', opts.prompt, ...]` -- the prompt goes in argv. There is no `CODEX_PROMPT_VIA_STDIN` constant anywhere in this codebase. Meanwhile `packages/shared/src/schemas.ts`'s `createSessionRequestSchema` caps prompts at 200,000 characters, well past Windows' `CreateProcess` argv limit (~32,767 characters total across the whole command line). For this product specifically, a session's prompt routinely contains a user's CV text and a scraped vacancy description -- real personal data, not placeholder content.

Two live consequences today:
1. **Correctness**: a sufficiently long prompt (CV + vacancy + instructions) can silently truncate or fail to spawn on Windows, this repo's primary platform.
2. **Disclosure**: an argv-embedded prompt is readable by any same-user process (Task Manager's command-line column, `wmic process`, any tool the user or another app on the machine runs) for the entire lifetime of the spawned process -- not a transient exposure.

Upstream fixed exactly this (commit `b54f92b`, PR #76): `CODEX_PROMPT_VIA_STDIN` flipped to `true`, `buildCodexArgs` now emits Codex's documented `-` placeholder in the prompt position (for both fresh and resume), and the prompt is written to stdin instead. This repo's Claude adapter already does this (`promptViaStdin: true`), and `run-session.ts` already implements the stdin-write path generically -- the Codex-specific port is small.

## Scope
- `packages/agent-runtime/src/providers/codex/build-args.ts`: emit the `-` stdin placeholder in the prompt's argv position (fresh and resume) instead of the raw prompt string.
- `packages/agent-runtime/src/providers/codex/adapter.ts` (or wherever the per-provider `promptViaStdin` flag is set): flip Codex to `promptViaStdin: true`, matching Claude's existing config shape.
- `packages/agent-runtime/src/providers/compatibility-manifest.ts`: this repo's `acceptedWorkBoundaryFor` / manifest reasoning for Codex currently assumes "an argv-embedded prompt is delivered unconditionally the instant the process exists" (see the ADR's ADI-04 section). That assumption becomes false the moment this ships. Confirm `run-session.ts`'s existing real-evidence mechanism (driving the accepted-work latch off the actual `promptViaStdin` flag reported at the real call site, not a hand-maintained manifest column -- the fix ADI-04 already made for exactly this class of drift) means this degrades correctly by construction, and update the stale manifest column/ADR paragraph in the same change so documentation doesn't silently go stale.

## Non-goals
Do not change Claude's existing stdin behavior. Do not change the daemon-side session-creation schema or the 200,000-character prompt cap -- this ticket makes that cap safe to use for Codex, it doesn't need to change it.

## Dependencies
None -- this is a self-contained fix to an already-shipped adapter.

## Acceptance criteria
- [ ] A prompt near or exceeding the Windows argv limit spawns and delivers correctly via Codex, where it previously would have failed or truncated.
- [ ] The full prompt text never appears in the spawned process's argv, verified by inspecting the actual command line of a real spawned `codex exec` process.
- [ ] `run-session.ts`'s accepted-work latch correctly reports `'accepted'` only after the stdin write is confirmed, not at spawn time, for Codex (mirroring Claude's existing behavior) -- this is a real behavior change from today's "accepted at spawn" assumption and must be covered by a test, not just asserted.
- [ ] The ADR and the compatibility manifest's `acceptedWorkBoundary` documentation for Codex are updated to match; no stale "argv delivers unconditionally at spawn" claim survives this change.

## Tests
A unit test on `buildCodexArgs` confirming the prompt never appears in the returned argv array, for both fresh and resume; an integration test spawning a real (or fixture) Codex process with a prompt near the argv limit and confirming it's delivered intact via stdin; an accepted-work test confirming the latch transitions at stdin-flush time, not spawn time, for Codex specifically (extending the existing supervisor-contract test suite's per-provider `promptViaStdin`/`expectedAcceptedWorkAfterOutput` fixtures).

## Rollback
Revert `promptViaStdin` to `false` for Codex and restore the argv-embedded prompt. No persisted state depends on this change.

## Stop conditions
Stop if the stdin write path drops or corrupts any part of the prompt, or if the accepted-work boundary change causes a fallback decision to differ from what it would have been under the old (spawn-time) assumption in a way that isn't provably safe.

## Ownership and routing
Backend Architect. Balanced specialist model at high reasoning. No independent review required beyond the existing supervisor-contract test suite, since this narrows an existing, already-reviewed mechanism to a second provider rather than introducing a new one.
