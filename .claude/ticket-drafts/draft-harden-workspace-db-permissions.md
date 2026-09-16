## Goal
Harden `workspace.db`'s on-disk file permissions to match the daemon's own state stores, so the sqlite file holding a user's CV text, contact info, cover letters, application answers, and full job-posting text is created with an explicit restrictive mode (0700 directory / 0600 file) instead of relying on the OS-default umask.

## Why now
From this session's audit security/privacy review: `createWorkspaceDb` (`apps/desktop/electron/workspace/client.ts:19-28`) opens the database with `new Database(databasePath)` and creates its containing directory with `mkdirSync(userDataPath, {recursive:true})` -- neither call passes a file-mode argument, so the file lands with whatever the process umask happens to produce. This is the single store in the app holding the most sensitive data it handles in plaintext, unencrypted SQLite.

By contrast, the daemon's own state stores handling equivalently sensitive data are already deliberately hardened with explicit modes: `apps/daemon/src/discovery-file.ts:57` and `:93` (0700/0600), `session-lineage-store.ts:603`, `:815`, `:1133-1134` (0700), `attachment-store.ts:186` and `:390` (0700), `audit-store.ts:173` (0700), and `application-queue-store.ts:145` and `:237` (0700/0600). `workspace.db` is the odd one out despite being at least as sensitive as any of those. Generated PDF/document artifacts have the same gap: `application-artifact-staging.ts:151-152`'s `writeFile(storagePath, options.pdf)` also takes no explicit mode.

The threat model stays inside the app's declared "same OS user" trust boundary (`SECURITY.md:29-42`), so this is P2, not P1/P0 -- but on a shared or multi-user POSIX machine, the default profile-directory mode is not guaranteed private the way an explicit 0700 is, and `SECURITY.md` is currently silent on `workspace.db` entirely despite documenting the rest of the app's storage this carefully.

## Scope
- Set an explicit restrictive mode when creating the workspace data directory in `apps/desktop/electron/workspace/client.ts` (mirror the daemon's `mkdirSync(path, {recursive:true, mode:0o700})` pattern from `discovery-file.ts`/`session-lineage-store.ts`/etc.).
- Set an explicit restrictive mode (0600) on the `workspace.db` file itself at creation, and on the SQLite `-wal`/`-shm` sidecar files if better-sqlite3's `new Database()` doesn't already respect a passed mode for those.
- Apply the same explicit-mode treatment to generated PDF/document artifacts written in `application-artifact-staging.ts:151-152`.
- Decide, and act on, one of the two options the audit called out: either apply the permission fix (preferred, since the pattern already exists in the daemon and is cheap to replicate), or, if the fix is deferred, add an explicit note to `SECURITY.md` documenting that `workspace.db` is a knowingly-unencrypted plaintext store currently left to OS-directory-default protection.
- Windows/POSIX scoping: confirm what the daemon's existing 0700/0600 calls actually do on Windows (chmod-style modes are largely a no-op there) so the fix and its documentation describe real behavior on both platforms the app ships for, not just POSIX.

## Non-goals
- No change to whether `workspace.db` itself is encrypted at rest -- this ticket is about file-permission hardening only, not introducing SQLite encryption (e.g. SQLCipher) or an OS-keychain-backed key.
- No change to the daemon's own already-hardened stores (`discovery-file.ts`, `session-lineage-store.ts`, `attachment-store.ts`, `audit-store.ts`, `application-queue-store.ts`) -- they are the reference pattern, not part of the change.
- No broader SECURITY.md rewrite beyond adding the `workspace.db` note if the permission fix is deferred instead of implemented.

## Acceptance criteria
- `createWorkspaceDb` creates the workspace data directory with an explicit restrictive mode and creates/opens `workspace.db` (and its `-wal`/`-shm` sidecars, if applicable) with an explicit restrictive mode, matching the daemon's existing 0700/0600 convention.
- `application-artifact-staging.ts`'s `writeFile(storagePath, options.pdf)` call writes generated artifacts with an explicit restrictive mode rather than relying on the default umask.
- A test verifies the created directory/file modes on a POSIX runner, and the change's platform behavior on Windows is documented (either verified equivalent-effect or explicitly called out as POSIX-only hardening).
- `SECURITY.md` is updated to describe `workspace.db`'s storage posture explicitly -- either that it is now permission-hardened, or, if the fix is deferred, that it is a knowingly-unencrypted plaintext store left to OS-directory-default protection.

## Risk
Low. This is an additive hardening change to file-creation calls using a pattern the daemon's own stores already establish and rely on in production; the main risk is platform-specific behavior (POSIX chmod modes vs. Windows ACLs) being asserted incorrectly in code comments or SECURITY.md rather than any behavioral regression to the app itself.
