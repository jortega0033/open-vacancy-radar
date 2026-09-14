export interface PageLoadingProps {
  /** What is being loaded, e.g. "Loading saved jobs…". Shown next to the spinner. */
  label: string;
}

/**
 * The shared "this is fetching" row: a small spinner plus a label, `role="status"` so assistive
 * tech announces it without needing to poll the DOM.
 *
 * Every page-level load used to roll its own treatment -- some a plain info-alert with no spinner,
 * one a bare unstyled `<p>`, `LettersLibrary` a hand-built spinner row identical in spirit to this
 * one but not shared. This is that row, promoted so every page reads the same "still working" cue.
 *
 * Not used by `SearchPage`: its two-pane layout shows a skeleton shaped like the real results/detail
 * panes instead, which this generic row cannot mimic.
 */
export function PageLoading({ label }: PageLoadingProps) {
  return (
    <div className="mt-4 flex items-center gap-3 text-sm text-base-content/70" role="status">
      <span className="loading loading-spinner loading-sm" aria-hidden="true" />
      <span>{label}</span>
    </div>
  );
}
