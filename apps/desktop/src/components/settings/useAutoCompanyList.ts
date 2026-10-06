import { useCallback, useEffect, useRef, useState } from 'react';
import { useAtsRoster } from './useAtsRoster.js';

/**
 * Downloads the company list in the background the first time the app opens (#637), through the
 * same `useAtsRoster` refresh path Settings uses. It starts only when the saved setting is on, the
 * status read settled and no list is saved yet, and it starts at most once per app session: a
 * failure is shown by the caller with a Try again button, never retried on its own.
 */
export function useAutoCompanyList() {
  const [enabled, setEnabled] = useState<boolean>();
  const [failed, setFailed] = useState(false);
  const attempted = useRef(false);
  const onRefreshed = useCallback(() => setFailed(false), []);
  const onRefreshError = useCallback(() => setFailed(true), []);
  const roster = useAtsRoster({ onRefreshed, onRefreshError });
  const { loaded, status, loadError, refresh } = roster;

  useEffect(() => {
    let cancelled = false;
    window.workspace
      .getSettings()
      .then((settings) => {
        if (!cancelled) setEnabled(settings.autoRosterDownloadEnabled);
      })
      .catch(() => {
        if (!cancelled) setEnabled(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (attempted.current || enabled !== true || !loaded || status !== null || loadError) return;
    attempted.current = true;
    refresh();
  }, [enabled, loaded, status, loadError, refresh]);

  const retry = useCallback(() => {
    setFailed(false);
    refresh();
  }, [refresh]);

  return { failed: failed && !roster.refreshing, retrying: roster.refreshing, retry };
}
