import { useEffect, useState, type RefObject } from 'react';

/**
 * The content width of an element in pixels, kept current with a `ResizeObserver`, or `null` until
 * the first measurement (and always `null` where `ResizeObserver` does not exist). Callers treat
 * `null` as "wide", so an environment that cannot measure keeps the full split layout.
 *
 * Search chooses between the split and single-pane layouts from this rather than from a viewport
 * breakpoint, because the sidebar changes the width the page actually has without changing the
 * viewport (#451).
 */
export function useElementWidth(ref: RefObject<HTMLElement | null>): number | null {
  const [width, setWidth] = useState<number | null>(null);
  useEffect(() => {
    const element = ref.current;
    if (!element || typeof ResizeObserver === 'undefined') return;
    // The first reading, so the layout is right before the observer's first callback; an element
    // with no layout box yet reports 0, which is "unknown", not "zero wide".
    const initial = Math.round(element.getBoundingClientRect().width);
    if (initial > 0) setWidth(initial);
    const observer = new ResizeObserver((entries) => {
      const entry = entries[entries.length - 1];
      if (entry) setWidth(Math.round(entry.contentRect.width));
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [ref]);
  return width;
}
