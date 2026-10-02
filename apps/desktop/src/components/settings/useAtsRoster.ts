import { useCallback, useEffect, useState } from 'react';
import type { AtsRosterImportResult, AtsRosterStatus } from '@open-vacancy-radar/vacancy-engine';

function describeError(err: unknown, fallback: string): string {
  return err instanceof Error ? err.message : fallback;
}

export interface UseAtsRosterOptions {
  /** A successful download, with the import result. */
  onRefreshed: (result: AtsRosterImportResult) => void;
  /** A failed download, already turned into a message. */
  onRefreshError: (message: string) => void;
}

/**
 * The company-roster state shared by Settings > Search and the first-launch checklist: the last
 * import's status, whether one is running, and the download itself, all through the existing
 * `getAtsRosterStatus` / `refreshAtsRoster` bridge calls. Callers pass stable callbacks.
 */
export function useAtsRoster({ onRefreshed, onRefreshError }: UseAtsRosterOptions) {
  const [status, setStatus] = useState<AtsRosterStatus>(null);
  const [loadError, setLoadError] = useState<string>();
  const [refreshing, setRefreshing] = useState(false);
  // False until the first status read settles, so a caller can tell "nothing imported yet" from "not read yet".
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const current = await window.vacancyRadar.getAtsRosterStatus();
        if (!cancelled) setStatus(current);
      } catch (err) {
        if (!cancelled) setLoadError(describeError(err, 'could not load the company roster status'));
      } finally {
        if (!cancelled) setLoaded(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const refresh = useCallback(() => {
    setRefreshing(true);
    setLoadError(undefined);
    void (async () => {
      try {
        const result = await window.vacancyRadar.refreshAtsRoster();
        setStatus({
          importedAt: result.importedAt,
          totalEntries: result.totalEntries,
          sourceCounts: Object.fromEntries(
            result.providers.map((provider) => [provider.provider, provider.importedCount]),
          ),
        });
        onRefreshed(result);
      } catch (err) {
        onRefreshError(describeError(err, 'could not refresh the company roster'));
      } finally {
        setRefreshing(false);
      }
    })();
  }, [onRefreshed, onRefreshError]);

  return { status, loadError, refreshing, loaded, refresh };
}
