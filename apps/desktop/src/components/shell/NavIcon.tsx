import type { NavPage } from './nav.js';

/**
 * The prototype's line icons, one per destination. Kept as inline SVG (rather than an icon
 * dependency) for the same reason the font stack is native: this is an offline desktop app and a
 * seven-glyph set is not worth a package. Every path uses `currentColor`, so the icon inherits
 * whatever `text-*` token its button carries and needs no per-theme handling.
 */
export function NavIcon({ page, className }: { page: NavPage; className?: string }) {
  return (
    <svg
      className={className}
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      aria-hidden="true"
      focusable="false"
    >
      {ICON_PATHS[page]}
    </svg>
  );
}

const ICON_PATHS: Record<NavPage, JSX.Element> = {
  search: (
    <>
      <circle cx="11" cy="11" r="7" />
      <line x1="16.5" y1="16.5" x2="21" y2="21" />
    </>
  ),
  saved: <path d="M6 3h12v18l-6-4-6 4z" />,
  applications: (
    <>
      <line x1="4" y1="6" x2="20" y2="6" />
      <line x1="4" y1="12" x2="20" y2="12" />
      <line x1="4" y1="18" x2="14" y2="18" />
    </>
  ),
  cv: (
    <>
      <path d="M6 2h9l4 4v16H6z" />
      <line x1="9" y1="13" x2="15" y2="13" />
      <line x1="9" y1="17" x2="15" y2="17" />
    </>
  ),
  letters: (
    <>
      <rect x="3" y="5" width="18" height="14" rx="1" />
      <path d="M3 7l9 6 9-6" />
    </>
  ),
  runtime: (
    <>
      <rect x="5" y="5" width="14" height="14" rx="1.5" />
      <rect x="9.5" y="9.5" width="5" height="5" />
    </>
  ),
  settings: (
    <>
      <line x1="4" y1="7" x2="20" y2="7" />
      <circle cx="9" cy="7" r="2.5" />
      <line x1="4" y1="16" x2="20" y2="16" />
      <circle cx="15" cy="16" r="2.5" />
    </>
  ),
};
