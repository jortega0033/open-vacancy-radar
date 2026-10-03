import { useSyncExternalStore } from 'react';
import type { VacancyEngineStatus } from './window.js';

/**
 * Whether the job search engine (the local vacancy database behind scans) works, as the whole app
 * sees it (#477). The sidebar used to show only the AI runtime, so a green "Claude Code ready"
 * sat next to a search that could not run. The shell polls the live engine status and publishes it
 * here; the Search page publishes the result of its own check and recovery the moment it has one,
 * so the sidebar changes at once rather than at the next poll.
 */
export type EngineHealth =
  | { state: 'checking' }
  | { state: 'ready' }
  | { state: 'attention'; category?: VacancyEngineStatus['category']; message: string };

let health: EngineHealth = { state: 'checking' };
const listeners = new Set<() => void>();

export function publishEngineHealth(status: Pick<VacancyEngineStatus, 'ready' | 'category' | 'error'>): void {
  const next: EngineHealth = status.ready
    ? { state: 'ready' }
    : {
        state: 'attention',
        ...(status.category ? { category: status.category } : {}),
        message: status.error ?? 'The local job cache is not ready.',
      };
  const same =
    next.state === health.state &&
    (next.state !== 'attention' || (health.state === 'attention' && health.category === next.category && health.message === next.message));
  if (same) return;
  health = next;
  for (const listener of listeners) listener();
}

export function resetEngineHealthForTest(): void {
  health = { state: 'checking' };
  for (const listener of listeners) listener();
}

export function getEngineHealth(): EngineHealth {
  return health;
}

export function useEngineHealth(): EngineHealth {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => health,
  );
}
