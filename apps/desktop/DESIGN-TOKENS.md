# Design tokens

## Where they live

All design tokens live in **`src/styles/tokens.css`** — the app's only stylesheet entry
(imported first in `src/main.tsx`). It loads Tailwind CSS v4, registers daisyUI 5 with all
built-in themes disabled, and defines the single custom daisyUI theme **`openvacancyradar`**.

## The aesthetic: strict black-and-white minimalism

- **True monochrome.** Every theme color has oklch chroma `0`: pure black (`base-content`,
  `primary`), pure white (`base-100`), and a small set of neutral grays (`base-200`,
  `base-300`, `secondary`, `accent`). There are **no color accents** — not even for
  info/success/warning/error, which are mapped to grays of different lightness.
- **States are expressed through contrast, weight, and borders — never hue.** An error is a
  heavy near-black surface or a bold/border-marked line; success is solid black; muted is
  reduced opacity.
- **Sharp and flat.** Fields and controls have zero border-radius, boxes at most `0.25rem`,
  and `--depth`/`--noise` are `0`.
- **Typography.** Native sans stack via `font-sans`, monospace via `font-mono`, and a small
  type scale (`text-xs` … `text-2xl`). Don't use sizes above `text-2xl`.

## The one rule for component styling

**All component styling must use daisyUI semantic classes or Tailwind utilities that resolve
to these tokens.** Never hardcode a raw hex/rgb/oklch color, and never use an arbitrary
Tailwind value (`bg-[#111]`, `text-[13px]`, `rounded-[7px]`) in component JSX. If a new value
is genuinely needed, add it as a token in `tokens.css` first, then reference it.

Approved vocabulary:

- daisyUI components: `btn`, `btn-primary`, `btn-outline`, `input`, `select`, `textarea`,
  `card`, `card-border`, `alert`, `alert-error`, `badge`, `badge-neutral`, …
- Semantic color utilities: `bg-base-100/200/300`, `text-base-content`, `text-base-content/60`,
  `border-base-300`, `bg-neutral`, …
- Token-backed utilities: `font-sans`, `font-mono`, `text-sm`, `rounded-box`, spacing utilities.

### Good

```tsx
<button className="btn btn-primary">Run</button>
<div className="alert alert-error">Daemon unavailable</div>
<span className="text-sm text-base-content/60">secondary text</span>
```

### Bad

```tsx
<button style={{ background: '#2563eb' }}>Run</button>          // raw hex, and a hue
<div className="bg-[#fee2e2] text-[#b91c1c]">error</div>        // arbitrary values, red
<span className="text-[13px] rounded-[6px]">…</span>            // off-scale size/radius
```

This rule exists so future (AI-assisted) UI edits stay consistent: change a token once in
`tokens.css` and the whole app follows.
