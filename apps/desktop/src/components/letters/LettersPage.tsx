import { useCallback, useRef, useState } from 'react';
import type { LetterRecord } from '../../window.js';
import { LetterGenerator } from './LetterGenerator.js';
import { LettersLibrary } from './LettersLibrary.js';
import type { SelectedVacancy } from './types.js';

/**
 * Which half of the feature is on screen. The generator additionally carries *what* it is editing
 * and a `seq`, because `LetterGenerator` seeds its form from props on mount only (deliberately;
 * see its state initializers). Bumping `seq` gives it a new React key, which is what makes
 * "Open a different letter" and "New letter" actually reset the editor instead of leaving the
 * previous document's title and body in place.
 */
type View =
  | { tab: 'library' }
  | { tab: 'generator'; letter: LetterRecord | null; seq: number };

export interface LettersPageProps {
  /**
   * A vacancy selected elsewhere (the Search page's "Generate Letter" action). Offered as the
   * generator's default job; the page works with nothing supplied.
   */
  vacancy?: SelectedVacancy | null;
  /** Optional provider model id, passed through to the agent run. */
  model?: string;
  /** Fired whenever the number of saved letters may have changed, for the sidebar badge. */
  onLettersChanged?: () => void;
}

/**
 * The whole "Letters" destination: the prototype's two letter routes (`/letters/new` and
 * `/letters`) as one page with a tab between them.
 *
 * They are one page rather than two nav entries because the round trip between them is the actual
 * workflow: generate, save, come back later, reopen, and regenerate. A shell-level route change
 * per step would throw away the generator's in-progress state on every hop. The tabs are plain
 * local state for the same reason: nothing here needs to survive a restart, and `App.tsx` stays
 * untouched.
 *
 * Saving is the one event both halves care about, so the page holds a `refreshToken` that a save
 * bumps; the library reloads on it instead of guessing when its rows went stale.
 *
 * Switching to the Library tab unmounts the editor, exactly as the prototype's two routes would.
 * Returning to it reopens the last letter *as last saved*. An unsaved draft is not carried across,
 * which is why the editor labels unsaved changes and offers Save before anything else.
 */
export function LettersPage({ vacancy = null, model, onLettersChanged }: LettersPageProps) {
  const [view, setView] = useState<View>({ tab: 'library' });
  const [refreshToken, setRefreshToken] = useState(0);
  // A ref, not state: this counter only ever feeds the editor's key, and incrementing it inside a
  // state updater would make it double-count under StrictMode's double-invoked reducers.
  const editorSeq = useRef(0);
  /** What the generator tab shows when it is re-entered without opening a specific letter. */
  const lastEditor = useRef<{ letter: LetterRecord | null; seq: number }>({ letter: null, seq: 0 });

  const openLibrary = useCallback(() => setView({ tab: 'library' }), []);

  const openGenerator = useCallback((letter: LetterRecord | null) => {
    editorSeq.current += 1;
    lastEditor.current = { letter, seq: editorSeq.current };
    setView({ tab: 'generator', letter, seq: editorSeq.current });
  }, []);

  const handleTab = useCallback(
    (tab: View['tab']) => {
      if (tab === 'library') {
        openLibrary();
        return;
      }
      // Switching *to* the generator tab resumes whatever it was last editing; only "New letter"
      // and "Open" deliberately reset it.
      setView((current) =>
        current.tab === 'generator' ? current : { tab: 'generator', ...lastEditor.current },
      );
    },
    [openLibrary],
  );

  const handleSaved = useCallback(
    (letter: LetterRecord) => {
      setRefreshToken((token) => token + 1);
      onLettersChanged?.();
      // Keep the editor pointed at the row it just wrote without changing `seq`, so the open
      // editor is not remounted. Leaving and re-entering the tab then resumes the saved
      // version rather than a blank form.
      lastEditor.current = { letter, seq: editorSeq.current };
      setView((current) => (current.tab === 'generator' ? { ...current, letter } : current));
    },
    [onLettersChanged],
  );

  const handleCountChanged = useCallback(() => {
    setRefreshToken((token) => token + 1);
    onLettersChanged?.();
  }, [onLettersChanged]);

  return (
    <div>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div role="tablist" className="tabs tabs-box" aria-label="Letters views">
          <button
            role="tab"
            type="button"
            className={`tab ${view.tab === 'generator' ? 'tab-active' : ''}`}
            aria-selected={view.tab === 'generator'}
            onClick={() => handleTab('generator')}
          >
            Generator
          </button>
          <button
            role="tab"
            type="button"
            className={`tab ${view.tab === 'library' ? 'tab-active' : ''}`}
            aria-selected={view.tab === 'library'}
            onClick={() => handleTab('library')}
          >
            Library
          </button>
        </div>
        {view.tab === 'generator' && (
          <button className="btn btn-ghost btn-sm" type="button" onClick={() => openGenerator(null)}>
            New letter
          </button>
        )}
      </div>

      <div className="mt-5">
        {view.tab === 'library' ? (
          <LettersLibrary
            refreshToken={refreshToken}
            onOpen={openGenerator}
            onNew={() => openGenerator(null)}
            onCountChanged={handleCountChanged}
          />
        ) : (
          <LetterGenerator
            key={`letter-editor-${view.seq}`}
            letter={view.letter}
            vacancy={vacancy}
            {...(model ? { model } : {})}
            onSaved={handleSaved}
            onClose={openLibrary}
          />
        )}
      </div>
    </div>
  );
}
