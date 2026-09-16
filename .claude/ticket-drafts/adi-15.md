## Objective
Give every spawned provider CLI process a default-deny environment allowlist, instead of full inheritance of the daemon's own environment, closing a real exposure in currently-shipped code.

## Why this is urgent, not speculative
Verified directly: `packages/agent-runtime/src/process/spawn-process.ts` still does `env: opts.env ?? process.env`, and `run-session.ts` passes `options.env` through unchanged (always `undefined` in production, per `StartSessionOptions.env`'s own doc comment -- "unset by every caller in this codebase today"). Every Claude/Codex child process this daemon spawns therefore inherits the daemon's ENTIRE environment: `AGENT_DOCK_STATE_DIR`, the per-launch discovery token, whatever Electron's main process sets, and anything else present in the parent shell.

This repo is arguably more exposed than upstream was when it fixed this, not less: this product ships a keyring-backed vacancy-source credential store (per the user's own description of the product), meaning a compromised or malicious provider CLI output stream could, in principle, be induced (via a sufficiently capable tool-use loop) to read and exfiltrate environment state that has nothing to do with why it was spawned.

Upstream fixed this generally (commit `000bc12`, PR #74): a `provider-environment.ts`-equivalent default-deny builder wired directly into `spawnProcess` itself (plus every other subprocess entry point: `run-session.ts`, a managed-process wrapper, `exec-capture.ts`, both providers' `detect.ts`, and an MCP control-plane module), replacing `env: opts.env ?? process.env` at the source so the safe default is structural, not per-call-site.

## Scope
- `packages/agent-runtime/src/process/spawn-process.ts`: replace the raw `process.env` inheritance default with a call through a new environment-builder function.
- New `packages/agent-runtime/src/providers/common/provider-environment.ts` (or equivalent shared location): a `buildProviderEnvironment(parentEnv)` function producing an allowlisted environment -- required platform variables the CLI needs to find its own config/credentials (`PATH`, `HOME`/`USERPROFILE`, `APPDATA`/`LOCALAPPDATA`, `TEMP`/`TMP`, and platform-equivalent essentials), plus each provider's own documented config-namespace variables (e.g. `CODEX_HOME`), and an explicit, always-enforced deny list for anything matching a secret/credential/token pattern regardless of whether it would otherwise be "required" -- daemon-internal values (`AGENT_DOCK_STATE_DIR`, the discovery token, anything Electron's main process injects) must never reach a provider child. Use ADI-08's already-designed two-list model (required allowlist + always-enforced deny list) as the starting point if that ticket's `provider-environment.ts` work is still unstarted at the time this is picked up -- do not build two divergent versions of the same mechanism.
- `run-session.ts`, `exec-capture.ts`, both providers' `detect.ts`: route through the same builder rather than defaulting to raw `process.env`.

## Non-goals
Do not change what CLI-native credential sources (OAuth session files, keychain entries) the provider CLI itself reads once spawned -- this ticket only bounds what the DAEMON hands the child via its environment, not what the CLI does with its own on-disk state, which remains fully the CLI's own business per this repo's standing "never read a provider credential" invariant.

## Dependencies
None directly, but coordinate with ADI-08 (Codex app-server transport, currently blocked) if that ticket's `provider-environment.ts` design work resumes first -- the two-list model should be shared, not duplicated, across the legacy CLI transports (this ticket) and any future rich transport (ADI-08).

## Acceptance criteria
- [ ] A spawned provider child's environment is a strict subset of the allowlist; a sentinel variable set in the daemon's own process environment never appears in the child's.
- [ ] The daemon's own internal variables (state dir, discovery token) are never present in a spawned child's environment, verified directly, not inferred.
- [ ] Each provider CLI's normal detect/auth/version-check behavior is unaffected -- `claude --version`/`codex --version` and each provider's `detect()` still succeed with the new restricted environment.
- [ ] The change applies uniformly across every subprocess entry point (`spawn-process.ts`, `run-session.ts`, `exec-capture.ts`, both `detect.ts` files), not just the main session-run path.

## Tests
Mirror ADI-06's sentinel-sweep rigor: set ~20-30 poisoned environment variables (including secret-shaped names and at least one plausible-but-unlisted innocuous variable) in the parent test process, spawn a small fixture script that dumps `process.env` as JSON through the real `spawnProcess`, and assert the child's keys are a strict subset of the allowlist with every poisoned name and the innocuous unlisted one both absent (proving it's a real allowlist, not a denylist that happens to cover the test's specific names). A regression test confirming `claude --version`/`codex --version` still succeed under the restricted environment on this machine.

## Rollback
Revert to `env: opts.env ?? process.env` at the single `spawn-process.ts` call site; no persisted state depends on this.

## Stop conditions
Stop if the restricted environment breaks a provider CLI's ability to find its own credentials/config (a false "not authenticated" result caused by an over-restrictive allowlist is a real regression, not just an inconvenience) -- verify against the real installed CLIs before shipping, not just fixture scripts.

## Ownership and routing
Backend Architect with Security review. Strongest reasoning model at high reasoning. Independent review required, given this touches every provider subprocess spawn path in the codebase.
