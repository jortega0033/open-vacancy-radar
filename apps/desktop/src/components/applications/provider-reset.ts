import { useEffect, useState } from 'react';
import type { ProviderErrorInfo } from '../../provider-error.js';

export function formatClock(ms: number): string {
  return new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

/** Longest single wait between re-checks, so a sleeping laptop or a clock change is caught soon. */
const RESET_RECHECK_MAX_MS = 60_000;

/**
 * Whether `resetAt` is still ahead, read from the clock at render time (never a value cached at
 * mount, so a new attempt with a long-past reset is unlocked at once). While it is ahead, one timer
 * re-renders just after the reset, re-armed in steps of at most a minute, and none runs after.
 */
export function useWaitingForReset(resetAt: number | undefined): boolean {
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (resetAt === undefined) return;
    const remaining = resetAt - Date.now();
    if (remaining <= 0) return;
    const timer = window.setTimeout(() => setTick((value) => value + 1), Math.min(remaining + 100, RESET_RECHECK_MAX_MS));
    return () => window.clearTimeout(timer);
  }, [resetAt, tick]);
  return resetAt !== undefined && resetAt > Date.now();
}

export function retryLabel(info: ProviderErrorInfo | null | undefined, waiting: boolean, idle: string): string {
  if (!info || !waiting || info.resetAt === undefined) return idle;
  return `Try again after ${formatClock(info.resetAt)}`;
}
