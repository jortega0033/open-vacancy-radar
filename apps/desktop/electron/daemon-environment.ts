import { CREDENTIAL_SHAPED_ENV_DENY_PATTERNS } from '@agent-dock/shared';

/**
 * ADI-21. Removes vacancy-source and other credential-shaped variables from the environment
 * Electron's main process hands the spawned daemon child.
 *
 * ADI-15 (`packages/agent-runtime/src/providers/common/provider-environment.ts`) already stops
 * these same names one hop later -- daemon to spawned `claude`/`codex` child -- but only after
 * they have already landed in the daemon's own `process.env`. `packages/vacancy-engine/src/
 * config.ts` reads `AI_API_KEY`, `BRAVE_SEARCH_API_KEY`, `ADZUNA_APP_ID`/`ADZUNA_APP_KEY`,
 * `JOOBLE_API_KEY`, `REED_API_KEY`, and `JOBSPIPE_API_KEY` straight out of `process.env`, so on a
 * machine where any of those are exported (a `.env` loaded before Electron starts, a system-wide
 * var, a CI/dev shell) they land in Electron's own environment and, before this, were forwarded to
 * the daemon child verbatim by `spawnDaemon`'s `{ ...process.env, ... }`. This closes that earlier
 * hop.
 *
 * Deliberately a deny list, not ADI-15's allowlist: unlike a provider CLI, the daemon genuinely
 * needs broad platform and network access for its own HTTP calls (job-source APIs, the AI
 * provider), so narrowing to an allowlist here risks the same false "not working" failure ADI-15
 * was careful to avoid, for a process with far more legitimate reasons to read its environment.
 *
 * Keeps this repo's own operational variables (`AGENT_DOCK_*`, `ELECTRON_*`, `VITE_*`) out of the
 * deny list on purpose -- those are the daemon's and Electron's own internals, not secrets, and
 * `spawnDaemon` sets the `AGENT_DOCK_*` overrides explicitly after this filter runs regardless.
 *
 * Issue #176: the credential-shaped group below is `@agent-dock/shared`'s
 * `CREDENTIAL_SHAPED_ENV_DENY_PATTERNS`, the same array ADI-15's `provider-environment.ts` (a
 * `packages/agent-runtime`-internal module `apps/desktop` still does not, and should not, depend
 * on) uses for its own, differently-scoped deny list. `apps/desktop` already depends on
 * `@agent-dock/shared` for its schemas, so sharing just this subset -- rather than the whole
 * hand-duplicated pattern list this comment used to describe -- makes the two boundaries agreeing
 * on it structural instead of a "keep them in sync by hand" reminder. The vacancy-source additions
 * below stay local: they are deliberately not part of the shared array, since they are specific to
 * this product's own credential names, not a universal secret shape.
 */
export const DAEMON_ENVIRONMENT_DENY_PATTERNS: readonly RegExp[] = [
  // Credential-shaped by convention. Shared with provider-environment.ts -- see this constant's
  // own doc comment above and credential-env-patterns.ts.
  ...CREDENTIAL_SHAPED_ENV_DENY_PATTERNS,
  // This product's own vacancy-source credential names (packages/vacancy-engine/src/config.ts).
  /^AI_/i,
  /^BRAVE_SEARCH_/i,
  /^ADZUNA_/i,
  /^JOOBLE_/i,
  /^REED_/i,
  /^JOBSPIPE_/i,
];

/** True when a variable name must be dropped before the daemon ever sees it. */
export function isDeniedDaemonEnvironmentName(name: string): boolean {
  return DAEMON_ENVIRONMENT_DENY_PATTERNS.some((pattern) => pattern.test(name));
}

/** Applies the deny list to a parent environment, dropping denied names and `undefined` values. */
export function buildDaemonEnvironment(parentEnv: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(parentEnv)) {
    if (value === undefined) continue;
    if (isDeniedDaemonEnvironmentName(name)) continue;
    env[name] = value;
  }
  return env;
}
