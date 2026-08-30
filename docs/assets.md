# Open Vacancy Radar assets

Open Vacancy Radar uses an original monochrome open-radar mark. The square point represents a
vacancy discovered beyond the scanning ring. No third-party provider, job board, government,
national or immigration-service logo is bundled.

## Authoritative files

Primary assets live under `apps/desktop/assets`:

| Path                                      | Role                                            |
| ----------------------------------------- | ----------------------------------------------- |
| `brand/open-vacancy-radar-app-icon.svg`   | fixed-background application icon               |
| `brand/open-vacancy-radar-mark.svg`       | themeable `currentColor` mark                   |
| `brand/open-vacancy-radar-mark-light.svg` | static dark mark for light documents            |
| `brand/open-vacancy-radar-mark-dark.svg`  | static light mark for dark documents            |
| `brand/open-vacancy-radar-lockup-*.svg`   | static horizontal/stacked documentation lockups |
| `illustrations/*.svg`                     | themeable workflow empty-state sources          |

Generated platform outputs live under `apps/desktop/assets/app-icons`. Do not hand-edit PNG, ICO
or ICNS files. Documentation images live under `docs/images`; they are not packaged at runtime.

## Generation and validation

Asset maintenance is optional Python tooling, not an application runtime dependency. Use Python
3.11 or newer in an isolated environment:

```powershell
python -m venv .venv-assets
.\.venv-assets\Scripts\python -m pip install -r scripts\assets\requirements.txt
.\.venv-assets\Scripts\python scripts\assets\generate_assets.py
.\.venv-assets\Scripts\python scripts\assets\validate_assets.py
```

After installing the same pinned requirements into the active Python environment, the workspace
aliases are:

```powershell
pnpm assets:generate
pnpm assets:validate
```

Generation reads one app-icon SVG and overwrites these outputs:

- PNG: 16, 24, 32, 44, 48, 64, 128, 256, 512 and 1024px
- Windows ICO: embedded 16, 24, 32, 48, 64, 128 and 256px representations
- ICNS: prepared for future macOS work; its presence is not macOS packaging verification

Validation checks required files, exact dimensions, multi-size ICO coverage, SVG parsing and
active/external references, embedded local paths, raster metadata, public-image dimensions and
common secret/PII patterns. Generation and validation use no online conversion service.

## Renderer integration

`OpenVacancyRadarMark` is an inline React SVG. It uses `currentColor`, supports decorative and
labelled usage, and has no runtime network dependency. The expanded sidebar combines the mark with
a text label; the collapsed sidebar keeps the mark centred while all
navigation targets retain their 44x44 geometry.

`EmptyState` accepts an optional local illustration URL. Consumers import canonical SVG URLs via
Vite and renders them as CSS masks, allowing the host's `currentColor` to work in light, dark and
system themes without unsafe raw-SVG injection or a new SVG loader.

| Illustration              | Consumer/state                                                                                    |
| ------------------------- | ------------------------------------------------------------------------------------------------- |
| `empty-search.svg`        | Search before a scan                                                                              |
| `no-results.svg`          | completed Search/filter with zero matches; Saved Jobs filter miss                                 |
| `empty-saved-jobs.svg`    | `SavedJobsPage` no-record state                                                                  |
| `empty-applications.svg`  | Applications no-record state                                                                    |
| `empty-cv.svg`            | CV Library no-record state                                                                       |
| `empty-letters.svg`       | Letters no-record state                                                                          |
| `runtime-unavailable.svg` | AI Runtime page only when the local runtime is unavailable                                        |

Loading, validation, and compact error states do not use illustrations.

## Electron and Windows packaging

- Development/unpacked window icon: `app.getAppPath()/assets/app-icons/png/icon-256.png`
- Installed window icon: `process.resourcesPath/assets/app-icons/png/icon-256.png`
- Executable and NSIS icons: `apps/desktop/assets/app-icons/open-vacancy-radar.ico`
- Builder copies only the 256px runtime PNG outside ASAR; source SVGs and other generated sizes
  remain build inputs and are not duplicated inside `app.asar`.
- Start Menu shortcuts inherit the packaged executable icon. Windows can cache old shortcut/taskbar
  icons, so uninstall an older local build before visual verification.

The `.icns` file is retained as a future source artifact only. macOS and Linux packaging are not
configured or claimed verified.

## Documentation and social images

Selected sample-data captures live in `docs/images/screenshots`; public compositions live in
`docs/images/social`:

- `readme-hero.webp`: README introduction
- `github-social-preview.png`: manual GitHub repository social-preview upload
- `open-graph.png`: website/social metadata consumer

These files are documentation-only and never enter the application bundle. The source pack's
portfolio composition, preview boards, and captures with unrelated toast state were not imported.

## Rebranding a fork

1. Replace `apps/desktop/assets/brand/open-vacancy-radar-app-icon.svg` and the static mark/lockups;
   update the matching inline geometry in `OpenVacancyRadarMark.tsx`.
2. Run `pnpm assets:generate`.
3. Run `pnpm assets:validate`.
4. Update product-facing name configuration while preserving any released app ID unless an upgrade
   migration is planned.
5. Rebuild and package on the target OS; visually inspect native icons and all themes.

The project does not provide automated rebranding.

## Licensing

This repository is Apache-2.0. The asset pack supplied no separate license file; its documentation
identifies the brand and illustrations as original Open Vacancy Radar artwork. Contributors must
confirm they have rights to submit those files under the repository license. No font files or
third-party logos are embedded. AgentDock and provider/source names remain factual text references;
no unofficial Claude, Codex, IND, LinkedIn, or job-board marks are included.
