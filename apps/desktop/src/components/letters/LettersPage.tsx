import { useCallback, useEffect, useRef, useState } from 'react';
import type { LetterRecord } from '../../window.js';
import { ConfirmDialog, TabPanel, Tabs } from '../shell/index.js';
import { LetterGenerator, type UnsavedKind } from './LetterGenerator.js';
import { LettersLibrary } from './LettersLibrary.js';
import type { SelectedVacancy } from './types.js';

/**
 * Which half of the feature is on screen. The generator additionally carries *what* it is editing
 * and a `seq`, because `LetterGenerator` seeds its form from props on mount only (deliberately:
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
  /**
   * Land directly on the Generator tab, pre-selected on `vacancy`, instead of this page's normal
   * library-first open. Set only by the Search page's "Generate Letter" handoff (see App.tsx): a
   * `vacancy` supplied without this still opens on the Library exactly as before, which is what
   * every other caller of this page relies on.
   */
  openOnGenerator?: boolean;
  /**
   * Fired once, right after mount, when a handoff `vacancy` was supplied. Lets the caller (App.tsx)
   * clear its own pending-handoff state now that this page holds its own independent copy of it
   * (see `handoffVacancy` below), so a later, unrelated visit to Letters -- through the nav
   * sidebar, not this handoff -- never replays a stale vacancy.
   */
  onVacancyConsumed?: () => void;
  onBackToVacancy?: (vacancy: SelectedVacancy) => void;
  /** Opens the CV page, for the generator's "No CVs yet" link. */
  onOpenCvPage?: () => void;
}

/**
 * The whole "Letters" destination: the prototype's two letter routes (`/letters/new` and
 * `/letters`) as one page with a tab between them.
 *
 * They are one page rather than two nav entries because the round trip between them is the actual
 * workflow (generate, save, come back later, reopen, regenerate) and a shell-level route change
 * per step would throw away the generator's in-progress state on every hop. The tabs are plain
 * local state for the same reason: nothing here needs to survive a restart, and `App.tsx` stays
 * untouched.
 *
 * Saving is the one event both halves care about, so the page holds a `refreshToken` that a save
 * bumps; the library reloads on it instead of guessing when its rows went stale.
 *
 * Switching to the Library tab unmounts the editor, exactly as the prototype's two routes would.
 * Returning to it reopens the last letter *as last saved*: an unsaved draft is not carried across,
 * so every way out of an editor with unsaved text (Library tab, "Back to library", "New letter",
 * back to the vacancy) asks first. While the question is open the editor stays mounted, which is
 * what lets "Keep editing" return to the exact text, letter type and job.
 */
export function LettersPage({
  vacancy = null,
  model,
  onLettersChanged,
  openOnGenerator = false,
  onVacancyConsumed,
  onBackToVacancy,
  onOpenCvPage,
}: LettersPageProps) {
  // Captured once at mount, not read reactively: `onVacancyConsumed` below tells the caller to
  // clear its own copy of `vacancy` right after this page starts, which must not yank the job out
  // from under a generator that has already opened on it. Every use of the handed-off vacancy for
  // the rest of this page's lifetime goes through this snapshot, never the live prop.
  const handoffVacancy = useRef(vacancy).current;

  const [view, setView] = useState<View>(() =>
    handoffVacancy && openOnGenerator ? { tab: 'generator', letter: null, seq: 0 } : { tab: 'library' },
  );
  const [refreshToken, setRefreshToken] = useState(0);
  // A ref, not state: this counter only ever feeds the editor's key, and incrementing it inside a
  // state updater would make it double-count under StrictMode's double-invoked reducers.
  const editorSeq = useRef(0);
  /** What the generator tab shows when it is re-entered without opening a specific letter. */
  const lastEditor = useRef<{ letter: LetterRecord | null; seq: number }>({ letter: null, seq: 0 });

  // Runs once on mount only: notify the caller that this page now holds its own snapshot of the
  // handoff vacancy, so it can clear its pending state immediately rather than waiting for the
  // user to navigate elsewhere.
  useEffect(() => {
    if (handoffVacancy) onVacancyConsumed?.();
  }, []);

  const [unsaved, setUnsaved] = useState<UnsavedKind>(null);
  /** The navigation that is waiting on the user's answer to the discard question. */
  const [pendingLeave, setPendingLeave] = useState<(() => void) | null>(null);

  const openLibrary = useCallback(() => setView({ tab: 'library' }), []);

  /** Runs `leave` now, or after the user agrees to drop the unsaved text. */
  const leaveEditor = useCallback(
    (leave: () => void) => {
      if (unsaved) setPendingLeave(() => leave);
      else leave();
    },
    [unsaved],
  );

  const openGenerator = useCallback((letter: LetterRecord | null) => {
    editorSeq.current += 1;
    lastEditor.current = { letter, seq: editorSeq.current };
    setView({ tab: 'generator', letter, seq: editorSeq.current });
  }, []);

  const handleTab = useCallback(
    (tab: View['tab']) => {
      if (tab === 'library') {
        leaveEditor(openLibrary);
        return;
      }
      // Switching *to* the generator tab resumes whatever it was last editing; only "New letter"
      // and "Open" deliberately reset it.
      setView((current) =>
        current.tab === 'generator' ? current : { tab: 'generator', ...lastEditor.current },
      );
    },
    [openLibrary, leaveEditor],
  );

  const handleSaved = useCallback(
    (letter: LetterRecord) => {
      setRefreshToken((token) => token + 1);
      onLettersChanged?.();
      // Keep the editor pointed at the row it just wrote (without changing `seq`, so the open
      // editor is *not* remounted) so that leaving and re-entering the tab resumes the saved
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
        <Tabs
          label="Letters views"
          idPrefix="letters"
          className="tabs tabs-box"
          value={view.tab}
          onChange={handleTab}
          tabs={[
            { id: 'generator', label: 'Generator' },
            { id: 'library', label: 'Library' },
          ]}
        />
        {view.tab === 'generator' && (
          <button className="btn btn-ghost btn-sm" type="button" onClick={() => leaveEditor(() => openGenerator(null))}>
            New letter
          </button>
        )}
      </div>

      <TabPanel idPrefix="letters" id={view.tab} className="mt-5">
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
            vacancy={handoffVacancy}
            {...(model ? { model } : {})}
            onSaved={handleSaved}
            onClose={() => leaveEditor(openLibrary)}
            onUnsavedChange={setUnsaved}
            {...(onOpenCvPage ? { onOpenCvPage } : {})}
            {...(handoffVacancy && onBackToVacancy
              ? { onBackToVacancy: () => leaveEditor(() => onBackToVacancy(handoffVacancy)) }
              : {})}
          />
        )}
      </TabPanel>

      {pendingLeave && (
        <ConfirmDialog
          title={unsaved === 'edited' ? 'Discard your changes?' : 'Discard this letter?'}
          message={
            unsaved === 'edited'
              ? 'Your edits to this letter have not been saved.'
              : 'It has not been saved.'
          }
          confirmLabel="Discard"
          cancelLabel="Keep editing"
          onConfirm={() => {
            const leave = pendingLeave;
            setPendingLeave(null);
            setUnsaved(null);
            leave();
          }}
          onCancel={() => setPendingLeave(null)}
        />
      )}
    </div>
  );
}
