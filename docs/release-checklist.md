# Release checklist

Repeatable steps for cutting a release of Open Vacancy Radar. Windows-only for now; see
[packaging.md#platform-matrix](packaging.md#platform-matrix).

## 1. Versioning

- [ ] Bump `version` in the root [package.json](../package.json) and in
      [apps/desktop/package.json](../apps/desktop/package.json) to the same value (the installer
      name and the About section come from the desktop one; the release workflow refuses a
      mismatch). Other workspace packages keep their own versions.
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
- [ ] If `packages/agent-runtime/src/providers/compatibility-manifest.ts`'s pinned Claude/Codex
      versions changed since the last release, run the live provider smoke matrix against real,
      authenticated installs of both CLIs before claiming the new versions are verified:
      `AGENT_DOCK_LIVE_PROVIDER_SMOKE=1 pnpm --filter @agent-dock/daemon run smoke:live-providers`
      (see [providers.md#live-provider-smoke-matrix](providers.md#live-provider-smoke-matrix)).
      Read `apps/daemon/live-provider-smoke-evidence.jsonl` afterward — every row you're relying on
      must show `resultCode: "success"`; a `skipped_*` row means that transport wasn't actually
      exercised and proves nothing. Skip this box entirely when the pins didn't change.

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
- [ ] MCP job-source providers: confirm the daemon's provider policy list matches what this release
      actually ships (see
      [SECURITY.md#three-separate-kinds-of-credential-not-one](../SECURITY.md#three-separate-kinds-of-credential-not-one)
      for what "registered" means). If it's still empty, as of this writing there is nothing to
      connect — check the box once you've confirmed that's still true. If a provider has since been
      registered, connect it and confirm credential save/search/disconnect all work before checking
      this box (see the daemon's `apps/daemon/test/mcp-*.test.ts` for the equivalent automated
      coverage).

## 6. Artifact hashes

Automated by [.github/workflows/release.yml](../.github/workflows/release.yml) as of this section's
last update: pushing the tag in step 7 builds the installer fresh, computes its SHA-256, and
publishes both. The installer is uploaded under the name GitHub serves it as
(`Open.Vacancy.Radar-Setup-<version>.exe`, spaces become dots), and its `.sha256` file is one
`<lowercase sha256>  <that name>` line, so `sha256sum -c Open.Vacancy.Radar-Setup-<version>.exe.sha256`
works after download. The release tooling lives in `scripts/release-tools.mjs` and is tested by
`node --test scripts/release-tools.test.mjs scripts/release-workflow.test.mjs` (the second file
checks the workflow's publish gating, permissions, action pins and hand-off rehearsal). Nothing to
do by hand here unless that workflow itself needs debugging -- in which case, fall back to the
manual command it automates:

- [ ] Compute and record a SHA-256 for the installer:
      `Get-FileHash "dist-packages\Open Vacancy Radar-Setup-<version>.exe" -Algorithm SHA256`
- [ ] Publish the hash alongside the release artifact so users can verify their download.

## 7. Tag and publish

- [ ] Rehearse first, without publishing: the release PR that adds `docs/release-notes-v<version>.md`
      runs the same Release workflow as a dry run, and after merge
      `gh workflow run release.yml --ref master` runs it on the merged commit. A dry run builds,
      tests (including the Windows e2e run, the only place the `*-win32.png` visual baselines are
      compared), packages, smoke-tests and checksums the installer, and uploads it as a run
      artifact. Its read-only "Rehearse the release hand-off (no publish)" job then downloads that
      same-run artifact and runs the publish job's own hand-off steps: checksum re-verification
      against the build's hash, `sha256sum -c` and the release notes with their provenance footer.
      It uploads nothing and never calls `gh release`. The dry-run installer is rehearsal evidence,
      not the release asset; the tag build makes its own. If the win32 baselines fail, the run
      uploads the Playwright report and the actual screenshots from the release runner image for
      inspection.
- [ ] Tag the merged release commit on `master` (`git tag v<version> <sha>`), push the tag.
- [ ] Pushing the tag triggers `.github/workflows/release.yml`. Its `build` job (read-only token)
      refuses the tag unless it is exactly `v` + the version in both `package.json` and
      `apps/desktop/package.json`, `docs/release-notes-v<version>.md` exists, and the tagged commit
      is on `origin/master`. It then builds the installer on a fresh checkout of that exact commit,
      verifies it was produced, runs the packaged-app and silent-install smoke tests on that same
      binary, and computes its SHA-256. The separate `publish` job (the only one with
      `contents: write`) re-verifies the checksum after the artifact hand-off and publishes both
      files as a GitHub Release. Its notes are `docs/release-notes-v<version>.md` plus a
      "Build provenance" footer with the tag, the full commit SHA, the workflow run and the hash.
      `gh release create --verify-tag` cannot create a tag of its own, and a version with a
      pre-release part (`0.2.0-rc.1`) is published as a pre-release. Watch the workflow run to
      confirm it succeeds. The publish step is idempotent: rerunning for an existing tag updates
      its notes and replaces both assets instead of failing because the release already exists.
      The installer artifact is named per run attempt
      (`windows-installer-v<version>-release-<commit>-attempt<n>`) and the build passes that exact
      name to `publish`. "Re-run failed jobs" after a failed publish reruns only `publish`, which
      downloads the successful build attempt's artifact. "Re-run all jobs" rebuilds and uploads
      under the new attempt's name. Neither path downloads an artifact from another run.
- [ ] Confirm the published release: the installer and a matching `.sha256` file are both attached,
      `sha256sum -c` passes on the downloaded pair, and the notes' provenance footer names the
      commit you tagged.
- [ ] Link the release from any relevant open issue (e.g. the release-readiness epic).

## Rollback

If a released installer turns out to be broken:

- [ ] Do not delete the GitHub release — mark it as a pre-release or edit the release notes to add
      a visible warning at the top, so existing links don't 404 and downloaders see the warning.
- [ ] Publish a fixed patch version through this same checklist as soon as possible.
- [ ] There is no auto-update mechanism in this app yet: affected users must be told to manually
      download and reinstall the fixed version. Note this prominently in the corrected release
      notes.
