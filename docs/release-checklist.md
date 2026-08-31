# Release checklist

Repeatable steps for cutting a release of Open Vacancy Radar. Windows-only for now; see
[packaging.md#platform-matrix](packaging.md#platform-matrix).

## 1. Versioning

- [ ] Bump `version` in the root [package.json](../package.json) (and any workspace package that
      needs its own bump).
- [ ] Add a `docs/release-notes-v<version>.md`, following the shape of
      [release-notes-v0.1.0.md](release-notes-v0.1.0.md): what's in, known limitations, privacy
      implications, deferred items.

## 2. Clean build

- [ ] `git status` clean, on the intended commit.
- [ ] `pnpm install` from a clean checkout (no stale `node_modules` from a different branch).
- [ ] `pnpm build` — all workspace packages compile.
- [ ] `pnpm typecheck` — clean across all packages.

## 3. Automated checks

- [ ] `pnpm lint` — clean.
- [ ] `pnpm test` — full workspace suite passes (see
      [DEVELOPMENT.md#testing-without-paid-providers](../DEVELOPMENT.md#testing-without-paid-providers) —
      no real CLI/account needed).
- [ ] `apps/desktop` e2e suite (Playwright) passes, including visual-snapshot baselines for
      win32.
- [ ] CI green on the release commit: build, typecheck, test, e2e workflows.
- [ ] No open CodeQL alerts without a documented dismissal rationale; no open Dependabot alerts
      above low severity. Check via `gh api repos/jortega0033/open-vacancy-radar/code-scanning/alerts`
      and `.../dependabot/alerts`.

## 4. Package

- [ ] `pnpm package:win` from the clean build above.
- [ ] Launch `dist-packages/win-unpacked/Open Vacancy Radar.exe` directly — confirm it starts, the
      daemon connects, and the window isn't blank.
- [ ] Install via `dist-packages/Open Vacancy Radar-Setup-<version>.exe`, confirm SmartScreen
      warning is the expected unsigned-app one (not a build/corruption error), then launch the
      installed app.
- [ ] Launch the installed app a second time — confirm single-instance focus behavior, not a
      second window/daemon (see
      [daemon.md#single-instance-behavior](daemon.md#single-instance-behavior)).
- [ ] Uninstall, confirm the uninstaller runs cleanly (see
      [packaging.md#platform-matrix](packaging.md#platform-matrix)).

## 5. Installed-app smoke test

Exercise the golden paths a real user would hit first, on the installed build specifically (not
`pnpm dev`):

- [ ] Run a vacancy scan against at least one real source; confirm results appear.
- [ ] Save a job, log an application, confirm both persist across an app restart.
- [ ] Upload a CV, confirm AI-assisted parsing completes (requires an authenticated `claude` or
      `codex` CLI on the test machine).
- [ ] Draft a letter for a saved application; confirm copy-to-clipboard and at least one export
      format (md/docx/pdf) work.
- [ ] MCP job-source providers are not yet enabled in this build (empty policy registry — see
      [docs/mcp-source-policy.md](mcp-source-policy.md) and
      [SECURITY.md#three-separate-kinds-of-credential-not-one](../SECURITY.md#three-separate-kinds-of-credential-not-one));
      there is nothing to connect from the app today, so skip this item. Once a provider is
      registered, run the daemon's `apps/daemon/test/mcp-*.test.ts` integration suite and update
      this line to a manual connect/save/search/disconnect pass.

## 6. Artifact hashes

- [ ] Compute and record a SHA-256 for the installer:
      `Get-FileHash "dist-packages\Open Vacancy Radar-Setup-<version>.exe" -Algorithm SHA256`
- [ ] Publish the hash alongside the release artifact so users can verify their download.

## 7. Tag and publish

- [ ] Tag the release commit (`git tag v<version>`), push the tag.
- [ ] Create the GitHub release, attach the installer and its hash, paste in the release notes.
- [ ] Link the release from any relevant open issue (e.g. the release-readiness epic).

## Rollback

If a released installer turns out to be broken:

- [ ] Do not delete the GitHub release — mark it as a pre-release or edit the release notes to add
      a visible warning at the top, so existing links don't 404 and downloaders see the warning.
- [ ] Publish a fixed patch version through this same checklist as soon as possible.
- [ ] There is no auto-update mechanism in this app yet: affected users must be told to manually
      download and reinstall the fixed version. Note this prominently in the corrected release
      notes.
