## Objective
Add an opt-in smoke harness that exercises real installed provider CLIs against this repo's compatibility manifest, skipping cleanly on a version mismatch rather than either false-passing or requiring a CLI in ordinary CI.

## Why this matters
This repo's whole compatibility-manifest design rests on "verified against the real, exact-pinned CLI version," but currently that verification only happens by hand -- as ADI-08b's real findings demonstrated (e.g. discovering `--safe-mode` does not disable `Bash` required someone to actually run a real session and read its `init` frame). There's no checked-in harness that re-runs those kinds of probes on a schedule, so drift between what the manifest claims and what the real CLI actually does can only be caught by another manual investigation.

Upstream built exactly this (commit `1f22cc2`, PR #83): an opt-in (`AGENT_DOCK_LIVE_PROVIDER_SMOKE=1`-gated) matrix that runs against real installed CLIs, where a version mismatch against the pinned build produces a clean `skipped_version_stale` result -- never a false success and never a hard CI failure for a machine that simply doesn't have the right CLI version installed.

## Scope
- An opt-in test suite (gated behind an env var, off by default, so ordinary CI -- which this repo deliberately never installs a real provider CLI into -- is unaffected) that runs a small set of real-CLI probes: version match, basic `detect()` success, and ideally re-running the specific probes ADI-08b already did by hand (confirming `--safe-mode`'s actual tool-disabling behavior, `--tools`/`--disallowed-tools` fail-closed behavior) so they become continuously re-verifiable rather than a one-time manual finding frozen in a code comment.
- A version-mismatch path that produces an explicit, distinguishable "skipped, stale version" result rather than either silently passing or failing the run.

## Non-goals
Do not make this suite part of the default `pnpm test`/CI gate -- it must stay genuinely opt-in, consistent with this repo's stated policy of never requiring a real provider CLI in ordinary CI.

## Dependencies
None.

## Acceptance criteria
- [ ] The suite is off by default and only runs when explicitly opted into via an environment variable.
- [ ] Running it against a CLI version that doesn't match the compatibility manifest's pin produces a clean skip, never a false pass or an unrelated crash.
- [ ] Running it against the correctly-pinned CLI version re-verifies the specific behavioral claims already made in this codebase's code comments (e.g. ADI-08b's `--safe-mode`/`--tools` findings) rather than just checking the version string.

## Tests
The suite itself is the test; additionally, a meta-test confirming the suite is genuinely skipped (not silently no-op'd in a way indistinguishable from passing) when the env var is unset, and confirming the version-mismatch path is reachable and distinguishable from both pass and fail.

## Rollback
Remove the opt-in suite; no other behavior depends on it existing.

## Stop conditions
None beyond the general discipline that this suite must never become required for ordinary contributors to pass CI without a real provider CLI installed.

## Ownership and routing
Backend Architect. Balanced specialist model at high reasoning.
