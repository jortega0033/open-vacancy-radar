# Asset integration plan

This plan records the repository and asset-pack audit completed before production integration.
The Electron repository remains the implementation source of truth; the extracted pack is input
material only. Nothing under the pack's `prototype/` or `integration/` directories is copied as
application code.

## Current architecture

- `apps/desktop` is an Electron 44, React 18, Vite 6, Tailwind 4 and daisyUI 5 application.
- `apps/desktop/electron/main.ts` owns `BrowserWindow`; renderer filesystem access remains blocked.
- `apps/desktop/electron-builder.yml` produces a Windows x64 NSIS installer with ASAR enabled and
  ships the daemon as an unpacked `extraResources` sidecar.
- `AppSidebar` owns expanded/collapsed branding. Its widths are 236px and 64px; collapsed navigation
  targets use the existing 44x44 `ovr-nav-icon` token.
- Light, dark and system themes are implemented by `src/theme.ts` plus current-color daisyUI tokens.
- `EmptyState` is the shared renderer seam. Search and Saved Jobs already have real empty states.
  Applications, CV and Letters do not yet have active page owners; `App.tsx` intentionally shows
  scoped placeholders for those routes. Asset work must not invent those product flows.
- The repository had no image, SVG or platform-icon tree before this integration. Electron-builder
  therefore used its default Electron icon, and `index.html` still displayed `Agent Dock`.

## Destination policy

| Asset-pack source                              | Repository destination               | Class              | Consumer                                   |
| ---------------------------------------------- | ------------------------------------ | ------------------ | ------------------------------------------ |
| `assets/brand/open-vacancy-radar-app-icon.svg` | `apps/desktop/assets/brand/`         | canonical          | icon generator                             |
| `assets/brand/open-vacancy-radar-mark*.svg`    | `apps/desktop/assets/brand/`         | canonical/static   | maintainers and static consumers           |
| `assets/brand/open-vacancy-radar-lockup-*.svg` | `apps/desktop/assets/brand/`         | canonical/static   | documentation consumers                    |
| `assets/app-icons/png/*`                       | `apps/desktop/assets/app-icons/png/` | generated          | Windows runtime resource and verification  |
| `assets/app-icons/open-vacancy-radar.ico`      | `apps/desktop/assets/app-icons/`     | generated          | executable and NSIS                        |
| `assets/app-icons/open-vacancy-radar.icns`     | `apps/desktop/assets/app-icons/`     | generated/future   | retained, not configured or claimed tested |
| `assets/illustrations/*.svg`                   | `apps/desktop/assets/illustrations/` | canonical          | Vite-bundled CSS-mask renderer assets      |
| selected `assets/screenshots/*`                | `docs/images/screenshots/`           | documentation-only | design/reference documentation             |
| selected `assets/social/*`                     | `docs/images/social/`                | documentation-only | README/GitHub/Open Graph use               |

Renderer assets are imported from `apps/desktop/assets`; Vite fingerprints only used files into
`dist`. Documentation images never enter runtime bundles. The packaged BrowserWindow receives only
`icon-256.png` through a second, additive `extraResources` entry.

## Implementation

1. Add an inline, strict-TypeScript `OpenVacancyRadarMark` using `currentColor`; replace only the
   sidebar's temporary circle-and-dot markup.
2. Extend `EmptyState` with an optional typed illustration. Render external SVGs as CSS masks so
   their color follows light, dark and system themes without `dangerouslySetInnerHTML` or a loader.
3. Map `empty-search`, `no-results` and `empty-saved-jobs` to existing real states. Show
   `runtime-unavailable` only on the unavailable AI Runtime page. Use Applications/CV/Letters art
   only on their current honest placeholders until page owners exist.
4. Add a pure, tested window-icon resolver for development, unpacked builds and packaged resources.
5. Merge product name, Windows/NSIS icons and the runtime icon resource into electron-builder while
   preserving the daemon sidecar, ASAR policy, app ID, shortcut policy and Windows-only scope.
6. Keep optional Python asset-maintainer tooling narrow: canonical app-icon SVG to deterministic PNG,
   multi-size ICO and prepared ICNS outputs; validate dimensions, SVG safety, metadata and public
   asset sizes. Python requirements remain documented and are not runtime dependencies.
7. Add the selected public-safe sample-data images to docs and a restrained README hero. Omit the
   pack's visibly flawed portfolio and preview boards, plus Settings/AI Runtime captures containing
   unrelated toast state.

## Non-goals

- No search, scraper, registry, CV, letter, application, settings, AgentDock, database or IPC behavior
  changes.
- No new Applications/CV/Letters page orchestration.
- No macOS/Linux packaging, signing, publishing, updates, analytics or white-label framework.
- No full-pack copy, bundled prototype, capture tooling, installer output or generated package output.
- No app-ID change without a release/upgrade identity decision.

## Verification stop condition

Stop when focused component/path/config tests and all existing repository gates pass, Windows NSIS
packaging emits non-zero branded artifacts, the unpacked and installed application launch with the
new icon/brand, selected renderer states are visually inspected, and the safety scan finds no secret,
PII, absolute local path or external SVG reference in changed assets.
