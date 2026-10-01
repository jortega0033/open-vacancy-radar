## Objective
Give the Electron main process's daemon spawn (and its vacancy-engine config load) the same default-deny environment allowlist ADI-15 gave the daemon's own provider-child spawns, closing the one remaining full-inheritance hop: parent shell environment to daemon process.

## Why this is urgent, not speculative
Verified directly, not inferred:
- `apps/desktop/electron/main.ts:341-358` spawns the daemon with `env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', AGENT_DOCK_APP_ID: APP_ID, AGENT_DOCK_STATE_DIR: ... }` -- full inheritance of Electron's own process environment, plus overrides.
- `apps/desktop/electron/main.ts:285-290` (`vacancyEngineConfig`) passes `{ ...process.env, DATABASE_PATH: ..., HTTP_CACHE_DIR: ... }` into `loadConfig`.
- `packages/vacancy-engine/src/config.ts` reads this product's own vacancy-source credentials (`AI_API_KEY`, `BRAVE_SEARCH_API_KEY`, `ADZUNA_APP_ID`/`ADZUNA_APP_KEY`, `JOOBLE_API_KEY`, `REED_API_KEY`, `JOBSPIPE_API_KEY`) straight out of `process.env`.

So on a machine where any of those are exported (a `.env` loaded before Electron starts, a system-wide var, a CI/dev shell), they land in Electron's own `process.env` and are then handed to the daemon child verbatim via full inheritance. ADI-15's `provider-environment.ts` deny list already covers these exact names (`^AI_`, `^BRAVE_SEARCH_`, `^ADZUNA_`, `^JOOBLE_`, `^REED_`, `^JOBSPIPE_`) one hop further downstream, at the daemon-to-provider-child boundary -- but that protection starts one layer too late. It stops a leak from the daemon to a `claude`/`codex` child; it does not stop the leak from Electron's own environment into the daemon process itself, where the values sit in `process.env` available to anything the daemon process does with its own environment (this was checked: no current logging/crash-reporting code in `apps/daemon/src` dumps or echoes `process.env`, so there is no *active* exposure today -- but the daemon holding these values at all is the exact "narrow what a spawned process inherits" discipline ADI-15 just established one level down, and leaving this hop on full inheritance is an inconsistency, not a deliberate tradeoff).

## Scope
- `apps/desktop/electron/main.ts` `spawnDaemon()`: replace `env: { ...process.env, ... }` with a call through a daemon-specific environment builder, analogous to `buildProviderEnvironment` but scoped to what the daemon process itself needs (Node/Electron platform variables, plus the explicit `AGENT_DOCK_*` overrides already set here) rather than the provider-CLI allowlist ADI-15 built (the daemon does not need `CODEX_HOME`/`CLAUDE_CONFIG_DIR`/proxy variables for itself -- those are provider-child concerns, already handled at the next hop).
- `vacancyEngineConfig()`: either route `loadConfig` through the same narrowed environment, or (simpler, and worth considering first) confirm with the vacancy-engine owner whether `loadConfig` actually needs a live `process.env` at all versus just the handful of vacancy-source keys it reads -- narrowing the input at the call site may be lower-risk than narrowing Electron's own environment globally.
- Reuse ADI-15's two-list model and its deny patterns (do not fork a second copy of the credential-shaped regex list) -- import from `packages/agent-runtime/src/providers/common/provider-environment.ts` or extract the deny list to a shared location if that module is the wrong dependency direction for `apps/desktop`.

## Non-goals
Does not change what ADI-15 already bounds (daemon-to-provider-child). Does not touch the daemon's own `process.env` reads for its own config (`AGENT_DOCK_LOG_LEVEL`, `AGENT_DOCK_APP_ID`, `AGENT_DOCK_PORT` in `apps/daemon/src/index.ts`) -- those are the daemon's own intentional config surface, not a leak path.

## Dependencies
Builds on ADI-15's `provider-environment.ts` two-list model. No blocking dependency; can be picked up independently.

## Acceptance criteria
- [ ] A sentinel credential-shaped variable (e.g. `ADZUNA_APP_KEY`) set in the Electron process's own environment never appears in the spawned daemon child's environment, verified directly (spawn a fixture that dumps `process.env`, same technique ADI-15's tests use).
- [ ] The daemon still starts, discovers, and functions normally under the narrowed environment (no regression to daemon startup/discovery).
- [ ] `vacancyEngineConfig()` still resolves the vacancy-source keys it legitimately needs from wherever they're actually meant to be configured (env, or a narrower explicit source) -- this ticket must not silently break the app's own vacancy-source credential loading while fixing the daemon-spawn leak.

## Tests
Mirror ADI-15's sentinel-sweep test: set the six vacancy-source credential names (`AI_API_KEY`, `BRAVE_SEARCH_API_KEY`, `ADZUNA_APP_ID`, `ADZUNA_APP_KEY`, `JOOBLE_API_KEY`, `REED_API_KEY`, `JOBSPIPE_API_KEY`) plus a generic secret-shaped name in the test process, spawn the daemon (or a fixture standing in for `spawnDaemon`'s env-building logic) through the real builder, and assert none of them reach the child's environment.

## Rollback
Revert `spawnDaemon()`'s `env` option to `{ ...process.env, ... }`; no persisted state depends on this.

## Stop conditions
Stop if narrowing the daemon's own environment breaks Node/Electron's ability to spawn or run the daemon process itself (distinct risk from ADI-15's provider-CLI-detection risk -- this is Electron's own child process, not a third-party CLI, so the required-variable set may differ and needs its own verification pass, not a copy of ADI-15's Windows/POSIX lists).

## Ownership and routing
Backend Architect with Security review, same reasoning tier as ADI-15 -- this is its direct sibling (one layer up: daemon-process environment allowlisting, vs ADI-15's provider-child environment allowlisting).
