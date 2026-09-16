## Goal
Close three small developer-experience gaps found during the audit's documentation review: wire and document `vacancy-engine`'s existing CLI so Search can be run standalone, add the missing "application pipeline / queue" row to DEVELOPMENT.md's "I want to change X" table, and fix a stale Node-version claim in DEVELOPMENT.md so a new contributor's first command doesn't fail.

## Why now
Verified against the real source this session, not re-derived. `packages/vacancy-engine/src/cli.ts` is a real, working CLI -- `scan`, `roster-import`, and `sponsor-sync` commands, its own dotenv/config load, and an advisory scan lock -- but it is wired into zero `package.json` scripts anywhere in the repo, and neither `README.md` nor `DEVELOPMENT.md` mentions it; the only documented way to run Search today is through the full desktop app. Separately, DEVELOPMENT.md's "I want to change X" table (`DEVELOPMENT.md:41-54`) has no row pointing to the application pipeline, its checkpoint state machine, or the application queue, so a contributor working on either has no map entry to start from. And `DEVELOPMENT.md:8` says "Node 20+" while root `package.json:16-18` and `packages/vacancy-engine/package.json:13-15` both pin `>=22` -- a mismatch that surfaces on literally the first `pnpm install` a new contributor runs. All three are low-risk, high-friction documentation/wiring gaps bundled into one ticket because each is too small to justify its own review cycle.

## Scope
- Add a root `package.json` script that runs the vacancy-engine CLI's scan command directly, e.g. `"scan": "pnpm --filter @open-vacancy-radar/vacancy-engine exec tsx src/cli.ts scan"` (adjust the exact invocation to match how `cli.ts` expects to be invoked, and add sibling scripts for `roster-import` and `sponsor-sync` if that keeps the three commands consistent).
- Ship a `.env.example` next to `packages/vacancy-engine/config/candidate-profile-v1.json` covering the 28-key env schema defined in `config.ts:16-62`, with placeholder (non-real) values and short inline comments on what each key controls.
- Document the CLI in README.md's "Everyday commands" section and in DEVELOPMENT.md, including the new root script(s), the `.env.example` file, and a one-line description of what `scan` / `roster-import` / `sponsor-sync` each do.
- Add a row to DEVELOPMENT.md's "I want to change X" table (`DEVELOPMENT.md:41-54`) for the application pipeline and the application queue, pointing to `apps/desktop/electron/application-pipeline.ts` (checkpoint state machine) and `apps/daemon/src/application-queue-store.ts` (queue state), and explicitly noting in the row's description that these are not the same state machine.
- Update `DEVELOPMENT.md:8` from "Node 20+" to match the `>=22` pin in root `package.json:16-18` and `packages/vacancy-engine/package.json:13-15`.

## Non-goals
- No changes to `cli.ts` itself, `config.ts`, or any runtime behavior of the scan/roster-import/sponsor-sync commands -- this ticket only wires existing, working code into scripts and docs.
- No change to the desktop app's own scan flow or UI -- the CLI remains an additional, standalone way to run Search, not a replacement.
- No audit of other possible doc/version drifts beyond the three cited here; if more turn up they belong in their own ticket.
- No code changes to `application-pipeline.ts` or `application-queue-store.ts` -- the DEVELOPMENT.md row only documents their existing relationship, it doesn't reconcile or unify the two state machines.

## Acceptance criteria
- Running the new root script (e.g. `pnpm scan`) successfully invokes `vacancy-engine`'s `cli.ts scan` command end to end without the desktop app running.
- A `.env.example` file exists next to `packages/vacancy-engine/config/candidate-profile-v1.json`, lists all 28 keys from `config.ts:16-62`, and copying it to `.env` (with real values filled in) is sufficient for the CLI to run.
- README.md's "Everyday commands" section and DEVELOPMENT.md both mention the CLI, the new script(s), and the `.env.example` file.
- DEVELOPMENT.md's "I want to change X" table has a row for the application pipeline / application queue, correctly pointing to both files and noting they are distinct state machines.
- DEVELOPMENT.md's stated Node version requirement matches the `>=22` engines pin in both `package.json` files.

## Risk
Low. This is a documentation and script-wiring change with no effect on any runtime code path already shipped in the desktop app or daemon -- the only executable surface added is a thin script wrapper around an existing, already-working CLI entry point. The main failure mode is the new root script using an invocation form that doesn't match how `cli.ts` actually parses its args, which is a quick local `pnpm scan` check away from being caught before merge.
