import { useSyncExternalStore } from 'react';
import type { ProviderId } from '@agent-dock/shared';

/**
 * Which providers last reported a usage limit (#461), so the failure shows up where the person is
 * looking (the sidebar, the provider card) and not only under the button that failed.
 *
 * Held in memory only: a limit is a statement about the last few hours, and a restart is as good a
 * moment as any to ask the provider again. An entry leaves when that provider next completes a run,
 * when the person retries, or when its parsed reset time passes.
 */
export interface ProviderLimit {
  provider: ProviderId;
  /** Epoch ms of the failed run. */
  reachedAt: number;
  resetLabel?: string;
  resetAt?: number;
}

type Snapshot = ReadonlyMap<ProviderId, ProviderLimit>;

let limits: Snapshot = new Map();
const listeners = new Set<() => void>();

function emit(next: Snapshot): void {
  limits = next;
  for (const listener of listeners) listener();
}

export function recordProviderLimit(limit: ProviderLimit): void {
  emit(new Map(limits).set(limit.provider, limit));
}

export function clearProviderLimit(provider: ProviderId): void {
  if (!limits.has(provider)) return;
  const next = new Map(limits);
  next.delete(provider);
  emit(next);
}

export function resetProviderLimitsForTest(): void {
  emit(new Map());
}

/** The limit for one provider, or undefined once its parsed reset time has passed. */
export function activeProviderLimit(provider: ProviderId, now: number = Date.now()): ProviderLimit | undefined {
  const limit = limits.get(provider);
  if (!limit) return undefined;
  return limit.resetAt !== undefined && limit.resetAt <= now ? undefined : limit;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useProviderLimits(): Snapshot {
  return useSyncExternalStore(subscribe, () => limits);
}

/** A provider the person chose to use for now, after another hit its limit. Session-only, and never
 * written to settings: the saved default stays what they picked in AI Runtime. */
let override: ProviderId | null = null;
const overrideListeners = new Set<() => void>();

export function setProviderOverride(provider: ProviderId | null): void {
  override = provider;
  for (const listener of overrideListeners) listener();
}

export function useProviderOverride(): ProviderId | null {
  return useSyncExternalStore(
    (listener) => {
      overrideListeners.add(listener);
      return () => overrideListeners.delete(listener);
    },
    () => override,
  );
}
