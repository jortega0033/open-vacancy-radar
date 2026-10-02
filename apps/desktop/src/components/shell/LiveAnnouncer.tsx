import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';

type Announce = (text: string) => void;

/**
 * Outside a provider (a page rendered alone in a test, a story) announcing is a no-op instead of an
 * error, so a page that announces never needs the shell to render.
 */
const LiveAnnouncerContext = createContext<Announce>(() => {});

/**
 * Screen readers (NVDA, JAWS, Narrator) often skip a `role="status"` region that is mounted together
 * with its text: the region has to exist before the text changes. So the one polite live region for
 * the whole app is always mounted here, visually hidden, and pages push text into it with `announce`.
 */
export function LiveAnnouncerProvider({ children }: { children: ReactNode }) {
  const [message, setMessage] = useState('');
  // Repeating the exact same text would not change the region, so nothing would be spoken. A
  // trailing non-breaking space flips every repeat without changing what is read out.
  const [flip, setFlip] = useState(false);

  const announce = useCallback<Announce>((text) => {
    setMessage(text);
    setFlip((current) => !current);
  }, []);

  const value = useMemo(() => announce, [announce]);

  return (
    <LiveAnnouncerContext.Provider value={value}>
      {children}
      <div className="sr-only" role="status" aria-live="polite" aria-atomic="true" data-testid="live-announcer">
        {message}
        {flip ? ' ' : ''}
      </div>
    </LiveAnnouncerContext.Provider>
  );
}

export function useAnnounce(): Announce {
  return useContext(LiveAnnouncerContext);
}
