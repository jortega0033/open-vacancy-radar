import { useCallback, useEffect, useRef, useState } from 'react';
import type { BlindApplyFeedItem, BlindApplyStatus } from '../../../electron/blind-apply-types.js';

/** How often an open page re-reads Blind Apply while it is on. Reading is local and cheap. */
export const BLIND_APPLY_POLL_MS = 5_000;

export interface BlindApplyState {
  status: BlindApplyStatus | null;
  feed: BlindApplyFeedItem[];
  error: string | null;
  refresh: () => Promise<void>;
}

/**
 * Reads Blind Apply's status and activity feed (#722). Read-only: every action goes through the bridge
 * directly from the component that offers it, then calls `refresh`.
 *
 * Fails quiet and closed: where the bridge is absent (a page rendered without the preload) or a read
 * fails, the state stays "not active, nothing to show" and an error line is kept for the caller, never
 * a made-up status.
 */
export function useBlindApply(): BlindApplyState {
  const [status, setStatus] = useState<BlindApplyStatus | null>(null);
  const [feed, setFeed] = useState<BlindApplyFeedItem[]>([]);
  const [error, setError] = useState<string | null>(null);
  const mounted = useRef(true);

  const refresh = useCallback(async () => {
    const bridge = (window as { blindApply?: Window['blindApply'] }).blindApply;
    if (!bridge) return;
    try {
      const [nextStatus, nextFeed] = await Promise.all([bridge.status(), bridge.feed()]);
      if (!mounted.current) return;
      setStatus(nextStatus);
      setFeed(nextFeed);
      setError(null);
    } catch {
      if (mounted.current) setError('Could not read Blind Apply right now.');
    }
  }, []);

  useEffect(() => {
    mounted.current = true;
    void refresh();
    const timer = setInterval(() => void refresh(), BLIND_APPLY_POLL_MS);
    return () => {
      mounted.current = false;
      clearInterval(timer);
    };
  }, [refresh]);

  return { status, feed, error, refresh };
}
