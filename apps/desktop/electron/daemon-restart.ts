import type { DaemonStatus } from './preload.js';

/**
 * The renderer's "Try again" on the AI helper banner: restart the daemon sidecar and report how it
 * went. Lives beside `daemon-respawn.ts` for the same reason: `main.ts` cannot be imported by a
 * test, so the part that has to be right (one restart at a time, never a second helper next to the
 * first) is here and every Electron-facing step is injected.
 */
export interface DaemonRestartDeps {
  isQuitting: () => boolean;
  currentStatus: () => DaemonStatus;
  /** Cancels a pending backoff respawn and marks the running attempt stale (`supersede`). */
  supersede: () => void;
  /** Kills the previous helper process, if any, and resolves once it is gone. */
  stopChild: () => Promise<void>;
  /** Resolves with the next `ready` or `unavailable` status. Called before `spawn` so it cannot miss one. */
  nextSettledStatus: () => Promise<DaemonStatus>;
  spawn: () => void;
}

export interface DaemonRestart {
  restart(): Promise<DaemonStatus>;
}

export function createDaemonRestart(deps: DaemonRestartDeps): DaemonRestart {
  let inFlight: Promise<DaemonStatus> | undefined;

  return {
    restart() {
      // Repeated clicks share the one restart already running instead of starting another helper.
      if (inFlight) return inFlight;
      if (deps.isQuitting()) return Promise.resolve({ state: 'unavailable', error: 'the app is closing' });
      const current = deps.currentStatus();
      if (current.state === 'ready') return Promise.resolve(current);

      inFlight = (async (): Promise<DaemonStatus> => {
        try {
          deps.supersede();
          await deps.stopChild();
          const settled = deps.nextSettledStatus();
          deps.spawn();
          return await settled;
        } catch (err) {
          return { state: 'unavailable', error: err instanceof Error ? err.message : 'restart failed' };
        } finally {
          inFlight = undefined;
        }
      })();
      return inFlight;
    },
  };
}
