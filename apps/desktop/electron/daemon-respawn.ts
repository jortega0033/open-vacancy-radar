/**
 * The decision logic behind a daemon crash's bounded respawn-with-backoff (draft-daemon-auto-respawn):
 * given how many consecutive attempts have already failed, whether the app is quitting, and which
 * generation of `spawnDaemon()` a late-arriving readiness result belongs to, decide what happens
 * next. Nothing here calls `spawnDaemon` itself or touches any Electron API -- those stay exactly
 * where they are in `main.ts`, reached only through the `spawnDaemon`/`setTimeout`/`isQuitting`
 * callbacks below.
 *
 * Lives here for the same reason `tick.ts` and `application-queue-port.ts` do: `main.ts` cannot be
 * imported by a test -- doing so boots Electron, spawns the daemon sidecar and opens two SQLite
 * databases, a long-standing architectural gap several test files already record. So this exact
 * logic -- attempt counting, the backoff formula, the `isQuitting` gate checked twice (once when a
 * respawn is first scheduled, again when its delay elapses, because quitting can start mid-backoff),
 * and the generation guard that lets a stale readiness poll from an attempt that already lost stand
 * down instead of adopting a later daemon -- shipped this session with no automated coverage of its
 * own. This module exists to close that gap without touching the behavior it covers.
 */

export interface DaemonRespawnPolicy {
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
}

export type DaemonRespawnDecision =
  | { kind: 'quitting' }
  | { kind: 'exhausted'; maxAttempts: number }
  | { kind: 'retry'; attempt: number; delayMs: number };

/**
 * The pure half: no counters of its own and no clock -- just "attempt N already failed, is the app
 * quitting, what is the policy" in, one of the three outcomes above out. Exported on its own because
 * it is what actually makes the backoff formula and the exhaustion cutoff assertable attempt by
 * attempt, independent of `createDaemonRespawn`'s stateful bookkeeping below.
 */
export function decideDaemonRespawn(
  attemptsSoFar: number,
  isQuitting: boolean,
  policy: DaemonRespawnPolicy,
): DaemonRespawnDecision {
  if (isQuitting) return { kind: 'quitting' };
  if (attemptsSoFar >= policy.maxAttempts) return { kind: 'exhausted', maxAttempts: policy.maxAttempts };
  const attempt = attemptsSoFar + 1;
  const delayMs = Math.min(policy.baseDelayMs * 2 ** (attempt - 1), policy.maxDelayMs);
  return { kind: 'retry', attempt, delayMs };
}

export interface DaemonRespawnDeps {
  policy: DaemonRespawnPolicy;
  /** `main.ts`'s module-level `isQuitting` flag, read fresh on every call -- never cached -- because
   * the whole point of the second, delayed check inside `scheduleRespawn`'s timer is to see a value
   * that changed after the respawn was already scheduled. */
  isQuitting: () => boolean;
  /** Starts the next daemon attempt for real. Called only once the backoff delay elapses, and only
   * if `isQuitting()` is still `false` at that later moment. */
  spawnDaemon: () => void;
  /** Real `setTimeout` in production; a fake clock (or a synchronous stand-in) in tests. */
  setTimeout: (callback: () => void, delayMs: number) => void;
  /** `console.warn`-shaped: called once a respawn budget is exhausted, before giving up for good. */
  onExhausted: (reason: string, maxAttempts: number) => void;
  /** `console.warn`-shaped: called once a respawn is actually scheduled. */
  onScheduled: (reason: string, attempt: number, maxAttempts: number, delayMs: number) => void;
}

export interface DaemonRespawn {
  /** `scheduleDaemonRespawn`'s decision, minus the `sendStatus` side effect `main.ts` still performs
   * itself immediately before calling this -- this module has no renderer to notify. */
  scheduleRespawn(reason: string): void;
  /** Called by `waitForDaemonReady` on a successful readiness result: a daemon that reached `ready`
   * gets a fresh retry budget rather than inheriting exhaustion from an earlier, unrelated incident. */
  resetAttempts(): void;
  /** Bumped once per real `spawnDaemon()` call; returns the new generation for that call's own
   * readiness loop to capture and compare later via `isCurrentGeneration`. */
  nextGeneration(): number;
  /** True only for the generation `spawnDaemon()` most recently started. A readiness loop belonging
   * to an earlier, already-superseded attempt sees `false` and should stand down without touching
   * any shared state. */
  isCurrentGeneration(generation: number): boolean;
}

export function createDaemonRespawn(deps: DaemonRespawnDeps): DaemonRespawn {
  let attempts = 0;
  let generation = 0;

  return {
    scheduleRespawn(reason) {
      const decision = decideDaemonRespawn(attempts, deps.isQuitting(), deps.policy);
      if (decision.kind === 'quitting') return;
      if (decision.kind === 'exhausted') {
        deps.onExhausted(reason, decision.maxAttempts);
        return;
      }
      attempts = decision.attempt;
      deps.onScheduled(reason, decision.attempt, deps.policy.maxAttempts, decision.delayMs);
      deps.setTimeout(() => {
        // isQuitting may have flipped true while this timer was pending (the user quit mid-backoff).
        if (deps.isQuitting()) return;
        deps.spawnDaemon();
      }, decision.delayMs);
    },
    resetAttempts() {
      attempts = 0;
    },
    nextGeneration() {
      generation += 1;
      return generation;
    },
    isCurrentGeneration(candidate) {
      return candidate === generation;
    },
  };
}
