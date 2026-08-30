/**
 * The one place that writes theme/density attributes onto the document element.
 *
 * daisyUI 5 keys every theme off `[data-theme="<name>"]`, and the dark theme in
 * `styles/tokens.css` is declared with `prefersdark: true`, which emits
 * `@media (prefers-color-scheme: dark) { :root:not([data-theme]) { … } }`. That gives all
 * three states the settings schema needs with no JavaScript media-query listener at all:
 *
 *   'system' → remove the attribute, and the OS preference decides, live.
 *   'light'  → data-theme="openvacancyradar"
 *   'dark'   → data-theme="openvacancyradar-dark"
 *
 * Density is a separate attribute (`data-density`) driving one custom property, because it
 * is orthogonal to color. See the comment in tokens.css.
 */

export type ThemePreference = 'light' | 'dark' | 'system';
export type DensityPreference = 'comfortable' | 'compact';

export const LIGHT_THEME_NAME = 'openvacancyradar';
export const DARK_THEME_NAME = 'openvacancyradar-dark';

/** Resolves a preference to the daisyUI theme name, or `null` for "let the OS decide". */
export function resolveThemeName(preference: ThemePreference): string | null {
  if (preference === 'light') return LIGHT_THEME_NAME;
  if (preference === 'dark') return DARK_THEME_NAME;
  return null;
}

export function applyTheme(preference: ThemePreference, root: HTMLElement = document.documentElement): void {
  const name = resolveThemeName(preference);
  if (name === null) root.removeAttribute('data-theme');
  else root.setAttribute('data-theme', name);
}

export function applyDensity(preference: DensityPreference, root: HTMLElement = document.documentElement): void {
  // Only the non-default value gets an attribute, so `:root` alone is always the comfortable
  // case and there is never a stale attribute contradicting the default.
  if (preference === 'compact') root.setAttribute('data-density', 'compact');
  else root.removeAttribute('data-density');
}
