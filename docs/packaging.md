# Packaging

`apps/desktop/electron-builder.yml` configures [electron-builder](https://www.electron.build/) to
produce a distributable desktop app. Today that means a Windows NSIS installer. See
[Platform matrix](#platform-matrix) below for the tested and untested platforms.

## Commands

```bash
pnpm build         # compiles every package; required before packaging
pnpm package:win   # pnpm build, then electron-builder --win nsis
pnpm package       # pnpm build, then electron-builder for whatever platform you're on
```

Both `package` commands are non-interactive and safe to run from a clean checkout after `pnpm
install`, with no code signing configured. There's nothing to sign with in this repository (see
[Unsigned installer](#unsigned-installer-and-smartscreen) below).

## What `pnpm build` produces (the prerequisite step)

- `packages/shared/dist/`, `packages/agent-runtime/dist/`: compiled library output (plain `tsc`)
- `apps/daemon/dist/index.js`: the daemon bundled by **esbuild** into one self-contained file,
  every dependency inlined (including the two packages above and `fastify`/`zod`). Required so it
  can run under plain `node`, with no workspace resolution or `tsx`, once packaged. `tsc` alone
  can't produce this: `packages/shared` and `packages/agent-runtime` intentionally publish
  TypeScript source (their `package.json` `main` points at `src/index.ts`, not a built `dist/`) so
  `tsx`/Vite/Vitest get live source with no separate build step in dev. But that means a plain
  `node dist/index.js` with no loader can't resolve them through a bare package specifier. This
  caused `ERR_MODULE_NOT_FOUND` when the packaged-mode code path (`node dist/index.js`) ran. See
  `apps/daemon/scripts/build.mjs` for the fix.
- `apps/desktop/dist/`: the Vite production build of the React renderer
- `apps/desktop/dist-electron/main.js`, `preload.js`: the Electron main process and preload
  script, each bundled to a single file (`main.js` inlines `@agent-dock/client`,
  `@agent-dock/shared`, and `zod`; `preload.js` is forced to CommonJS since Electron's sandboxed
  preload loader doesn't support ESM)

None of this is an installer yet. `electron .` against `apps/desktop` at this point runs the app
unpacked, useful for a quick check without a full package step.

## Output layout

```
dist-packages/
  win-unpacked/                                  the unpacked app (Open Vacancy Radar.exe + resources/)
  Open Vacancy Radar-Setup-<version>.exe         the NSIS installer
```

`directories.output: ../../dist-packages` in `electron-builder.yml` keeps installer
output at the repo root, out of both `apps/desktop/dist/` (Vite) and `dist-electron/` (esbuild via
vite-plugin-electron). Installer output never mixes with plain build artifacts. `dist-packages/` is
gitignored.

## Product and icon resources

`productName` and the Windows executable name are `Open Vacancy Radar`. The executable, NSIS
installer and NSIS uninstaller use
`apps/desktop/assets/app-icons/open-vacancy-radar.ico`. The Start Menu shortcut keeps the existing
enabled policy and inherits the executable icon; the desktop shortcut remains disabled.

The window icon follows two explicit paths:

- development/unpacked: `app.getAppPath()/assets/app-icons/png/icon-256.png`
- packaged: `process.resourcesPath/assets/app-icons/png/icon-256.png`

The packaged PNG is a separate `extraResources` entry outside `app.asar`; the daemon entry below
remains unchanged. The resolver returns no icon option when the file is missing instead of crashing
startup, while Windows executable branding still comes from electron-builder's ICO resource.

## Runtime layout once packaged

```
Open Vacancy Radar.exe           (Electron; renderer + main process live in resources/app.asar)
resources/
  app.asar                       renderer (dist/) + main + preload + better-sqlite3 JavaScript
  app.asar.unpacked/
    node_modules/better-sqlite3/ native binding smart-unpacked by electron-builder
  assets/app-icons/png/
    icon-256.png                 BrowserWindow icon for the packaged app
  daemon/
    index.js                     the daemon's own esbuild bundle, unmodified from apps/daemon/dist/
```

## The daemon ships outside `app.asar`

`extraResources: [{ from: ../daemon/dist, to: daemon }]` in `electron-builder.yml` puts the daemon
bundle *outside* the asar archive entirely, rather than relying on Electron's asar-aware `fs`
patching. It is spawned as a separate OS process (`child_process.spawn`) instead of being imported.
Asar is a virtual filesystem that Electron's `fs` module can read, but a separate process cannot
reliably use a path inside it.

## `resolveDaemonEntry()`

`apps/desktop/electron/resolve-daemon-entry.ts` is a pure function with no Electron import. See
`apps/desktop/test/resolve-daemon-entry.test.ts` for its unit tests. It handles three cases, in
priority order:

1. **Dev server** (`VITE_DEV_SERVER_URL` set): always run `apps/daemon/src/index.ts` live through
   `tsx`, even if a stale `dist/` build exists from an earlier `pnpm build`.
2. **Packaged** (`app.isPackaged`): `process.resourcesPath/daemon/index.js`. Never source, never
   `tsx`, since neither exists in a packaged build.
3. **Unpacked production build** (`pnpm build` ran but the app isn't packaged, e.g. `electron .`
   directly): prefer the daemon's own `dist/index.js` next to its source; fall back to `tsx` +
   source only if that build hasn't been run yet.

Tests assert that packaged mode never falls through to the `tsx`/source path, since neither exists
in a packaged build. This catches a fallback that works during development but fails after
packaging.

## What electron-builder treats as a runtime dependency

`react`, `react-dom`, `zod`, and `@agent-dock/shared`/`@agent-dock/client` are fully inlined into
`dist/` and `dist-electron/main.js` (Vite for the renderer, vite-plugin-electron for main). They stay
in `devDependencies`, avoiding a second unbundled copy in `app.asar`.

`better-sqlite3` is different: `vite.config.ts` externalizes the native addon, so it is
a production `dependency`. Electron-builder's dependency walker includes its JavaScript and
smart-unpacks the Electron-x64 native binding even though the explicit `files` list has no broad
`node_modules` glob. Test an installed build, not only an unpacked build beside the repository,
because repository-level `node_modules` can otherwise mask a missing packaged addon.

## Start Menu and single-instance behavior

The NSIS config (`nsis:` in `electron-builder.yml`) creates a Start Menu shortcut
(`createStartMenuShortcut: true`) but no desktop shortcut by default, and allows the user to change
the install directory (`allowToChangeInstallationDirectory: true`). The installed app takes
`app.requestSingleInstanceLock()`. Launching it a second time (Start Menu, desktop, or otherwise)
focuses the existing window rather than opening a second one, which would otherwise spawn a second
daemon and lose the race described in
[daemon.md#single-instance-behavior](daemon.md#single-instance-behavior). A test with an installed
build confirmed that launching the packaged `.exe` a second time left the process count and the
daemon's port unchanged.

## Unsigned installer and SmartScreen

The NSIS installer and the packaged `Open Vacancy Radar.exe` are unsigned. Electron-builder's log shows
signing steps being skipped for lack of a certificate. **Expect Windows SmartScreen to warn on
first run** ("Windows protected your PC" / unknown publisher). This is expected for an unsigned
open-source build and does not indicate a packaging error. Code signing was out of scope for
this milestone; see [troubleshooting.md](troubleshooting.md) if you need to click through it for
local testing.

## Platform matrix

| | source / dev | production build | packaged app | installer | uninstall |
|---|---|---|---|---|---|
| **Windows** | verified | verified | verified (installed, launched, closed, relaunched, second-instance-blocked) | verified (NSIS, silent install/uninstall) | verified |
| **macOS** | untested | untested | untested | not implemented | not applicable |
| **Linux** | untested | untested | untested | not implemented | not applicable |

The application code does not intentionally depend on Windows. Path handling uses `node:path`, and
process management already has explicit POSIX branches (see
[SECURITY.md](../SECURITY.md#process-hygiene)). But "should work" and "verified" are different
claims. Only Windows has been installed and tested end to end. Adding `mac`/`linux` targets
(`dmg`/`zip`, `AppImage`/`deb`) to `electron-builder.yml` was not attempted. macOS and Linux
packaging are out of scope for this milestone, as are signing and notarization.

## Verifying a packaging-sensitive change

If you touched anything under `apps/desktop/electron/` (main process, preload, or
`electron-builder.yml`), `pnpm build` and `pnpm typecheck` alone do not cover every packaging-mode
failure. Problems involving `resolveDaemonEntry`'s asar boundary, bundled versus native dependency
ownership, and the shutdown path described in [architecture.md](architecture.md) were found only by
running `pnpm package:win` and launching the result. Confirm that the app launches from
`dist-packages/win-unpacked/Open Vacancy Radar.exe` before completing the change.
