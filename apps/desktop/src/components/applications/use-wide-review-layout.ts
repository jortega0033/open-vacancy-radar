import { useEffect, useState } from 'react';

/** Windows at least this wide get the two-pane review dialog; narrower ones keep the compact one. */
export const WIDE_REVIEW_MIN_WIDTH_PX = 900;

const QUERY = `(min-width: ${WIDE_REVIEW_MIN_WIDTH_PX}px)`;

function matches(): boolean {
  try {
    return typeof window.matchMedia === 'function' && window.matchMedia(QUERY).matches;
  } catch {
    return false;
  }
}

/**
 * Whether the review dialog should use its two-pane layout (#469). Driven by a media query so the
 * decision tracks live window resizes. Falls back to the compact layout wherever `matchMedia` is
 * unavailable, which keeps the dialog usable in any environment that cannot answer the question.
 */
export function useWideReviewLayout(): boolean {
  const [wide, setWide] = useState(matches);

  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return;
    const list = window.matchMedia(QUERY);
    const update = () => setWide(list.matches);
    update();
    list.addEventListener?.('change', update);
    return () => list.removeEventListener?.('change', update);
  }, []);

  return wide;
}
