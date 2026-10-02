import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { isSupportDue, readSupportPrompt } from '../../../electron/workspace/support-prompt.js';
import { hasOpenOverlay } from '../shell/useEscapeToClose.js';
import { SupportDialog } from './SupportDialog.js';
import { applySupportEvent } from './support-store.js';

export interface SupportPromptApi {
  /**
   * Records one success moment: an application that went out (an ok `submitReview`, or the
   * person confirming they sent it themselves). Callers only invoke this from those ok paths.
   * Never throws; the dialog, if now due, shows at the next quiet moment.
   */
  recordSuccessMoment: () => void;
}

const NOOP_API: SupportPromptApi = { recordSuccessMoment: () => {} };
const SupportPromptContext = createContext<SupportPromptApi>(NOOP_API);

/** Outside a provider (isolated component tests) this is a no-op, so no caller needs a guard. */
export function useSupportPrompt(): SupportPromptApi {
  return useContext(SupportPromptContext);
}

/** Lets the review dialog that produced the success finish closing before the guard is checked. */
export const SUPPORT_QUIET_DELAY_MS = 400;

export interface SupportPromptProviderProps {
  /** The active page. A change is a quiet moment: a due dialog re-checks whether it can show. */
  page: string;
  /** The Welcome modal is open. It does not register as an overlay, so the shell says so. */
  welcomeOpen: boolean;
  children: ReactNode;
}

/**
 * App-level owner of the Support ask (#503). Holds only "a dialog is due" and "the dialog is
 * showing" in memory; the counters live in `app_settings` and are re-read on every decision.
 * Never shows at app start or after an error: the only way to become due is a recorded success.
 */
export function SupportPromptProvider({ page, welcomeOpen, children }: SupportPromptProviderProps) {
  const [due, setDue] = useState(false);
  const [showing, setShowing] = useState(false);
  // Bumped on every recorded success so a due dialog that was blocked re-checks, even though
  // `due` itself did not change.
  const [recheck, setRecheck] = useState(0);

  const recordSuccessMoment = useCallback(() => {
    void (async () => {
      try {
        const settings = await applySupportEvent('success');
        if (isSupportDue(readSupportPrompt(settings.supportPrompt))) setDue(true);
        setRecheck((n) => n + 1);
      } catch {
        // A failed read or write costs one ask, nothing else. Never surface it.
      }
    })();
  }, []);

  useEffect(() => {
    if (!due || showing || welcomeOpen) return;
    let cancelled = false;
    const timer = setTimeout(() => {
      void (async () => {
        if (hasOpenOverlay()) return;
        try {
          // A scan can run while the user is on another page; the main process knows.
          const status = await window.vacancyRadar?.getScanStatus?.();
          if (status?.scanning) return;
          const settings = await window.workspace.getSettings();
          if (!isSupportDue(readSupportPrompt(settings.supportPrompt))) {
            if (!cancelled) setDue(false);
            return;
          }
        } catch {
          return;
        }
        if (cancelled || hasOpenOverlay()) return;
        setShowing(true);
      })();
    }, SUPPORT_QUIET_DELAY_MS);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [due, showing, welcomeOpen, page, recheck]);

  const finish = useCallback((event: 'answered' | 'not_now') => {
    setShowing(false);
    setDue(false);
    void applySupportEvent(event).catch(() => {});
  }, []);
  const handleAnswered = useCallback(() => finish('answered'), [finish]);
  const handleNotNow = useCallback(() => finish('not_now'), [finish]);

  const api = useMemo<SupportPromptApi>(() => ({ recordSuccessMoment }), [recordSuccessMoment]);

  return (
    <SupportPromptContext.Provider value={api}>
      {children}
      {showing && <SupportDialog onAnswered={handleAnswered} onNotNow={handleNotNow} />}
    </SupportPromptContext.Provider>
  );
}
