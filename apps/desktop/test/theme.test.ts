import { beforeEach, describe, expect, it } from 'vitest';
import {
  applyDensity,
  applyTheme,
  DARK_THEME_NAME,
  LIGHT_THEME_NAME,
  resolveThemeName,
} from '../src/theme.js';

let root: HTMLElement;

beforeEach(() => {
  root = document.createElement('div');
});

describe('resolveThemeName', () => {
  it('maps explicit preferences to the two daisyUI theme names', () => {
    expect(resolveThemeName('light')).toBe(LIGHT_THEME_NAME);
    expect(resolveThemeName('dark')).toBe(DARK_THEME_NAME);
  });

  it('returns null for "system", which is how the OS is allowed to decide', () => {
    // The dark theme is declared with daisyUI's `prefersdark`, which emits
    // `@media (prefers-color-scheme: dark) { :root:not([data-theme]) { … } }`. Removing the
    // attribute is therefore not "give up and go light." It is the live-following state, and it
    // needs no media-query listener in JavaScript.
    expect(resolveThemeName('system')).toBeNull();
  });
});

describe('applyTheme', () => {
  it('sets and clears the attribute so a later change fully replaces the earlier one', () => {
    applyTheme('dark', root);
    expect(root.getAttribute('data-theme')).toBe(DARK_THEME_NAME);

    applyTheme('light', root);
    expect(root.getAttribute('data-theme')).toBe(LIGHT_THEME_NAME);

    applyTheme('system', root);
    expect(root.hasAttribute('data-theme')).toBe(false);
  });
});

describe('applyDensity', () => {
  it('marks only the non-default value, so :root alone always means comfortable', () => {
    applyDensity('compact', root);
    expect(root.getAttribute('data-density')).toBe('compact');

    applyDensity('comfortable', root);
    expect(root.hasAttribute('data-density')).toBe(false);
  });
});
