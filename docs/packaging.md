# Packaging

`apps/desktop/electron-builder.yml` configures [electron-builder](https://www.electron.build/) to
produce a distributable desktop app. Today that means a Windows NSIS installer (see
[Platform matrix](#platform-matrix) below for what's actually been verified versus what's merely
not-yet-attempted).

## Commands

```bash
pnpm build         # compiles every package: the prerequisite for packaging, not packaging itself
pnpm package:win   # pnpm build, then electron-builder --win nsis
pnpm package       # pnpm build, then electron-builder for whatever platform you're on
```

Both `package` commands are non-interactive and safe to run from a clean checkout after `pnpm
install`, with no code signing configured: there's nothing to sign with in this repository (see
[Unsigned installer](#unsigned-installer-and-smartscreen) below).

## What `pnpm build` produces (the prerequisite step)

- `packages/shared/dist/`, `packages/agent-runtime/dist/`: compiled library output (plain `tsc`)
- `apps/daemon/dist/`: the daemon bundled by **esbuild** into `index.js`, every JavaScript
  dependency inlined (including the two packages above and `fastify`/`zod`), required so it can run
  under plain `node`, with no workspace resolution or `tsx`, once packaged. `tsc` alone can't
  produce this: `packages/shared` and `packages/agent-runtime` intentionally publish TypeScript
  source (their `package.json` `main` points at `src/index.ts`, not a built `dist/`) so
  `tsx`/Vite/Vitest get live source with no separate build step in dev, but that means a plain
  `node dist/index.js` with no loader can't resolve them through a bare package specifier. This
  was an actual bug, not a theoretical risk: caught by running the packaged-mode code path
  (`node dist/index.js`) and hitting `ERR_MODULE_NOT_FOUND` (see
  `apps/daemon/scripts/build.mjs` for the fix). `dist/` is not *only* `index.js`, though: the one
  native addon in the dependency tree (`@napi-rs/keyring`, used for optional MCP job-source
  credentials — see [SECURITY.md#three-separate-kinds-of-credential-not-one](../SECURITY.md#three-separate-kinds-of-credential-not-one))
  can't be inlined by esbuild, so it ships as a sibling `keyring.<platform>.node` file that
  `extraResources` copies alongside `index.js` as one unit (see `apps/desktop/electron-builder.yml`).
- `apps/desktop/dist/`: the Vite production build of the React renderer
- `apps/desktop/dist-electron/main.js`, `preload.js`: the Electron main process and preload
  script, each bundled to a single file (`main.js` inlines `@agent-dock/client`,
  `@agent-dock/shared`, and `zod`; `preload.js` is forced to CommonJS since Electron's sandboxed
  preload loader doesn't support ESM)

None of this is an installer yet: `electron .` against `apps/desktop` at this point runs the app
unpacked, useful for a quick check without a full package step.

## Output layout

```
dist-packages/
  win-unpacked/                                  the unpacked app (Open Vacancy Radar.exe + resources/)
  Open Vacancy Radar-Setup-<version>.exe         the NSIS installer
```

`directories.output: ../../dist-packages` in `electron-builder.yml` deliberately keeps installer
output at the repo root, out of both `apps/desktop/dist/` (Vite) and `dist-electron/` (esbuild via
vite-plugin-electron); installer output never mixes with plain build artifacts. `dist-packages/` is
gitignored.

## Product and icon resources

`productName` and the Windows executable name are `Open Vacancy Radar`. The executable, NSIS
installer and NSIS uninstaller use
`apps/desktop/assets/app-icons/open-vacancy-radar.ico`. The Start Menu shortcut keeps the existing
enabled policy and inherits the executable icon; the desktop shortcut remains disabled.

The window icon follows two explicit paths:

- development/unpacked: `app.getAppPath()/assets/app-icons/png/icon-256.png`
- packaged: `process.resourcesPath/assets/app-icons/png/icon-256.png`

The packaged PNG is an additive `extraResources` entry outside `app.asar`; the daemon entry below
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
    icon-256.png                 packaged-safe BrowserWindow icon
  daemon/
    index.js                     the daemon's own esbuild bundle, unmodified from apps/daemon/dist/
```

## The daemon ships outside `app.asar`

`extraResources: [{ from: ../daemon/dist, to: daemon }]` in `electron-builder.yml` puts the daemon
bundle *outside* the asar archive entirely, rather than relying on Electron's asar-aware `fs`
patching. It's spawned as a separate OS process (`child_process.spawn`) rather than imported code:
asar is a virtual filesystem Electron's own `fs` module knows how to read, but handing a path
inside it to a freshly spawned process is exactly the kind of "happens to work by accident"
behavior this project avoids.

## `resolveDaemonEntry()`

`apps/desktop/electron/resolve-daemon-entry.ts` is a pure function (no Electron import, fully
unit-testable, see `apps/desktop/test/resolve-daemon-entry.test.ts`) with three cases, in priority
order:

1. **Dev server** (`VITE_DEV_SERVER_URL` set): always run `apps/daemon/src/index.ts` live through
   `tsx`, even if a stale `dist/` build exists from an earlier `pnpm build`.
2. **Packaged** (`app.isPackaged`): `process.resourcesPath/daemon/index.js`, never source, never
   `tsx`, since neither exists in a packaged build.
3. **Unpacked production build** (`pnpm build` ran but the app isn't packaged, e.g. `electron .`
   directly): prefer the daemon's own `dist/index.js` next to its source; fall back to `tsx` +
   source only if that build hasn't been run yet.

Tests assert packaged mode never falls through to the `tsx`/source path, since neither exists in a
real packaged build. That fallback silently working in dev but silently failing once packaged is
exactly the class of bug this function's test coverage exists to catch.

## What electron-builder treats as a runtime dependency

`react`, `react-dom`, `zod`, and `@agent-dock/shared`/`@agent-dock/client` are fully inlined into
`dist/` and `dist-electron/main.js` (Vite for the renderer, vite-plugin-electron for main). They stay
in `devDependencies`, avoiding a second unbundled copy in `app.asar`.

`better-sqlite3` is different: `vite.config.ts` deliberately externalizes the native addon, so it is
a production `dependency`. Electron-builder's dependency walker includes its JavaScript and
smart-unpacks the Electron-x64 native binding even though the explicit `files` list has no broad
`node_modules` glob. An installed launch (not merely an unpacked launch beside the repository) is the
required proof, because repository-level `node_modules` can otherwise mask a missing packaged addon.

## Start Menu and single-instance behavior

The NSIS config (`nsis:` in `electron-builder.yml`) creates a Start Menu shortcut
(`createStartMenuShortcut: true`) but no desktop shortcut by default, and allows the user to change
the install directory (`allowToChangeInstallationDirectory: true`). The installed app takes
`app.requestSingleInstanceLock()`: launching it a second time (Start Menu, desktop, or otherwise)
focuses the existing window rather than opening a second one, which would otherwise spawn a second
daemon and lose the race described in
[daemon.md#single-instance-behavior](daemon.md#single-instance-behavior). This was verified live
against a real installed build: launching the packaged `.exe` a second time while the first was
running left the process count and the daemon's port unchanged.

## Unsigned installer and SmartScreen

The NSIS installer and the packaged `Open Vacancy Radar.exe` are unsigned: electron-builder's log shows
signing steps being skipped for lack of a certificate. **Expect Windows SmartScreen to warn on
first run** ("Windows protected your PC" / unknown publisher); that's expected behavior for an
unsigned OSS boilerplate build, not a packaging bug. Code signing was explicitly out of scope for
this milestone; see [troubleshooting.md](troubleshooting.md) if you need to click through it for
local testing.

## Uninstall behavior

`apps/desktop/electron-builder.yml`'s `nsis:` block sets no `deleteAppDataOnUninstall` key.
electron-builder's own documented default for that option is `false`, so the NSIS uninstaller
removes the install directory, the Start Menu shortcut, and the registry uninstall entries, and
**leaves user data in `%APPDATA%` untouched**. The only custom NSIS hook this repo ships,
`apps/desktop/assets/app-icons/installer.nsh`, defines a `customInstall` macro (a silent VC++
redistributable install, per [What electron-builder treats as a runtime
dependency](#what-electron-builder-treats-as-a-runtime-dependency)) and no `customUnInstall` macro
at all -- there is no script anywhere in this repo that touches user data during uninstall, on
purpose or otherwise.

`app.setName('Open Vacancy Radar')` is called before any `app.getPath(...)` call in
`electron/main.ts`, so the data directory the uninstaller leaves behind is
`%APPDATA%\Open Vacancy Radar`. It holds every piece of local state the app has ever written: the
workspace SQLite database (saved jobs, applications, CV documents, letters, settings), the
vacancy-engine database, the `ai-workspace/` scratch directory the CV/AI features use, and
AgentDock's own daemon state directory. None of it is removed by uninstalling the app, and there is
currently no in-app "delete all my data" action either -- removing that folder by hand (or with
Windows' "Reset this app"/"Uninstall and delete data" prompts, where offered) is the only way to
clear it today. This is determined from the packaging config and the absence of any uninstall
script, not from a live install/uninstall/inspect cycle -- see [Verifying a packaging-sensitive
change](#verifying-a-packaging-sensitive-change) for why an actual install-time verification pass
(clean-machine install, restart, uninstall, confirm what's left) still needs a human or a real
Windows CI runner: this repository's automated environment cannot launch an installer, run it
elevated, or inspect a live `%APPDATA%` the way that check requires.

## Platform matrix

| | source / dev | production build | packaged app | installer | uninstall |
|---|---|---|---|---|---|
| **Windows** | verified | verified | verified (installed, launched, closed, relaunched, second-instance-blocked) | verified (NSIS, silent install/uninstall) | verified (uninstaller runs and completes cleanly) |
| **macOS** | untested | untested | untested | not implemented | n/a |
| **Linux** | untested | untested | untested | not implemented | n/a |

The "uninstall" column above is about the uninstaller *process* completing without error, live-tested
against a real install. What it does or doesn't remove from `%APPDATA%` is a separate claim, covered
in [Uninstall behavior](#uninstall-behavior) above -- determined from the packaging config, not
(yet) from a live inspect-before/after cycle.

**Supported OS/version**: Windows 10 or later, 64-bit (x64) only — `electron-builder.yml`'s `win.target.arch`
is `[x64]` exclusively, and the bundled Electron 44 itself no longer supports Windows 7/8/8.1.
32-bit Windows is not built or tested.

Nothing in the code is deliberately Windows-only: path handling uses `node:path` throughout, and
process management already has explicit POSIX branches (see
[SECURITY.md](../SECURITY.md#process-hygiene)), but "should work" and "verified" are different
claims; only Windows has actually been installed and exercised end to end. Adding `mac`/`linux`
targets (`dmg`/`zip`, `AppImage`/`deb`) to `electron-builder.yml` is a reasonable next step but
wasn't attempted here: macOS/Linux packaging are explicitly out of scope for this milestone, same
as signing/notarization.

## Verifying a packaging-sensitive change

If you touched anything under `apps/desktop/electron/` (main process, preload, or
`electron-builder.yml`), `pnpm build` and `pnpm typecheck` alone won't catch every packaging-mode
failure mode: the real bugs documented above (`resolveDaemonEntry`'s asar boundary, bundled versus
native dependency ownership, and the shutdown-path crash in
[architecture.md](architecture.md)) were each only caught by actually running `pnpm package:win` and
launching the result. Run it and confirm the app launches from
`dist-packages/win-unpacked/Open Vacancy Radar.exe` before considering the change done.
