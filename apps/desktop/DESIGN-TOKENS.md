# Design tokens

## Where they live

All design tokens live in **`src/styles/tokens.css`** — the app's only stylesheet entry
(imported first in `src/main.tsx`). It loads Tailwind CSS v4, registers daisyUI 5 with all
built-in themes disabled, and defines the app's two themes: **`openvacancyradar`** (light,
default) and **`openvacancyradar-dark`**.

## The aesthetic: near-monochrome, with three real state colors

- **Surfaces, text and actions are grayscale.** White/near-black page and panel surfaces, a
  small set of neutral grays for borders, hover and selected rows, and a single near-black
  (inverted to near-white in dark) "brand" color for primary actions. Emphasis comes from
  contrast steps, not from hue.
- **`success`, `warning` and `error` carry real hue** — green, amber, red, in a light and a
  dark variant. This is a deliberate change from the original all-monochrome rule. The app now
  reports employer verification outcomes, scan results and application statuses, and a
  grayscale badge cannot honestly distinguish "IND-recognised sponsor" from "not verified", or
  a healthy runtime from a dead one. Those three are the *only* hues in the system;
  `info` stays grayscale, because "working on it" is not an outcome worth a color.
- **Color is never the only signal.** Every place a state hue appears, the same information is
  also in the text ("Claude Code Ready", "Recognised sponsor"). A user who cannot distinguish
  the dot still gets the state.
- **Flat.** `--depth` and `--noise` are `0`. Radii are the prototype's soft 4–8px
  (`--radius-field` `0.375rem`, `--radius-box` `0.5rem`).
- **Typography.** Native sans stack via `font-sans`, monospace via `font-mono`, and a small
  type scale (`text-xs` … `text-2xl`). Don't use sizes above `text-2xl`.

## Themes and density

Both are attributes on `<html>`, written **only** by `src/theme.ts`:

| Preference | Attribute | Effect |
| --- | --- | --- |
| theme `system` | *(no `data-theme`)* | follows `prefers-color-scheme`, live, with no JS listener |
| theme `light` | `data-theme="openvacancyradar"` | explicit light |
| theme `dark` | `data-theme="openvacancyradar-dark"` | explicit dark |
| density `comfortable` | *(no `data-density`)* | `--ovr-row-padding: 11px` |
| density `compact` | `data-density="compact"` | `--ovr-row-padding: 7px` |

The "system follows the OS" behavior comes from daisyUI's `prefersdark: true` option on the dark
theme block, which emits `@media (prefers-color-scheme: dark) { :root:not([data-theme]) { … } }`.
Density is a plain custom property rather than a theme, because it is orthogonal to color —
folding it into daisyUI's theme system would mean four themes instead of two.

Consume density through the `ovr-row` utility, not by reading the variable directly.

## The one rule for component styling

**All component styling must use daisyUI semantic classes, Tailwind utilities that resolve to
these tokens, or one of the named `ovr-*` utilities defined in `tokens.css`.** Never hardcode a
raw hex/rgb/oklch color, and never use an arbitrary Tailwind value (`bg-[#111]`, `text-[13px]`,
`rounded-[7px]`) in component JSX. If a new value is genuinely needed, add it as a token or a
`@utility` in `tokens.css` first, then reference it.

This is what survives from the original rule: the point was never that hue is forbidden, it was
that **a one-off color invented at a call site is forbidden**. Green/amber/red are in the token
set now. A fourth accent someone liked the look of still isn't.

Approved vocabulary:

- daisyUI components: `btn`, `btn-primary`, `btn-outline`, `btn-ghost`, `input`, `select`,
  `textarea`, `card`, `card-border`, `alert`, `alert-error`, `alert-soft`, `badge`,
  `badge-neutral`, …
- Semantic color utilities: `bg-base-100/200/300`, `text-base-content`, `text-base-content/60`,
  `border-base-300`, `bg-neutral`, and — for state only — `text-success`, `bg-warning`,
  `text-error`, `bg-success`, …
- Token-backed utilities: `font-sans`, `font-mono`, `text-sm`, `rounded-box`, spacing utilities.
- App utilities from `tokens.css`: `ovr-row`, `ovr-sidebar`, `ovr-sidebar-collapsed`,
  `ovr-header`, `ovr-nav-icon`.

### Good

```tsx
<button className="btn btn-primary">Run</button>
<span className="size-1.5 rounded-full bg-success" aria-hidden="true" />
<span className="text-sm">Claude Code <span className="text-base-content/50">Ready</span></span>
<tr className="ovr-row border-b border-base-300">…</tr>
```

### Bad

```tsx
<button style={{ background: '#2563eb' }}>Run</button>          // raw hex, and an invented hue
<div className="bg-[#fee2e2] text-[#b91c1c]">error</div>        // arbitrary values
<span className="text-[13px] rounded-[6px]">…</span>            // off-scale size/radius
<span className="bg-success" />                                 // color as the ONLY state signal
<div style={{ padding: 'var(--ovr-row-padding)' }} />           // use the ovr-row utility
```

This rule exists so future (AI-assisted) UI edits stay consistent: change a token once in
`tokens.css` and the whole app follows, in both themes.
