## Objective
Track two real bugfixes upstream `jortega0033/agentdock` made to its Git-worktree manager
(`ae22e3d` #117, `2096501` #118) so they are folded into whatever implementation ticket eventually
comes out of ADI-12 (#130), instead of being reintroduced from scratch or forgotten when that
implementation work starts.

## Current decision
Not actionable yet. Confirmed directly: `apps/daemon/src/worktree-manager.ts`,
`apps/daemon/src/routes/v2-agents-worktrees.ts`, and `packages/shared/src/agent-worktree-v2.ts` do
not exist anywhere in this repo (`find`/`ls` all miss). ADI-12 (#130) is a design-only ticket whose
own body states "Deferred. Worktree/subagent routes, bridges, UI, and provider actions remain
unregistered" and "Separate implementation tickets are created only after approval." There is
nothing to port these two fixes into today.

## What upstream fixed, verified by reading both commits directly
- **`ae22e3d` (#117, "allow untracked-only worktree cleanup and opt-in branch deletion"):**
  `cleanup()` used to refuse on ANY dirty status, including untracked-only files (build output,
  `node_modules`) that were never committed and never will be -- failing on the happy path for any
  real workflow. Fix adds two independent, opt-in options: `deleteUntracked` (treats
  untracked-only dirtiness as removable, still unconditionally refusing on any *tracked*-file
  change -- the case that actually risks losing work) and `deleteBranch` (best-effort `git branch
  -D` on the worktree's own ref after a successful removal, so a failure there never undoes a
  cleanup that already succeeded). Previously the manager also leaked one branch per worktree
  forever.
- **`2096501` (#118, "queue concurrent worktree create/cleanup per repo instead of rejecting"):**
  `create()`/`cleanup()` each keyed a lease off the source repo's workspaceId and threw
  `worktree_busy` immediately if another operation against that same repo was already in flight --
  even when the two callers wanted entirely independent worktrees. Fix replaces the boolean lease
  `Set` with a per-workspaceId promise-chain queue: a concurrent caller now waits its turn and still
  succeeds instead of being rejected, while a distinct workspaceId never waits on another's queue.
  Serialization itself is preserved on purpose (git worktree add/remove mutate shared `.git`
  metadata unsafe to touch concurrently) -- only the reject-instead-of-wait behavior was the bug.

## Why this matters for whenever ADI-12 is approved
Both fixes are exactly the kind of "obvious in hindsight, easy to reintroduce" bug a fresh
from-scratch implementation could plausibly reintroduce: an untracked-only dirty check that's too
strict, and a naive one-boolean-lease-per-repo instead of a real queue for a multi-consumer daemon.
Recording them now, while they're fresh from a direct upstream reading, is cheaper than rediscovering
them independently once ADI-12's design is approved and a real implementation ticket is scoped.

## Non-goals
No worktree implementation of any kind here. This ticket does not create `worktree-manager.ts`,
does not register any route, and does not move ADI-12 out of "deferred."

## Dependencies
Blocked on ADI-12 (#130) reaching an approved design and a real implementation ticket being filed.
This ticket's only job is to hand that future ticket two pre-verified requirements.

## Acceptance criteria
- [ ] Whichever future ticket implements ADI-12's worktree manager cites this ticket and explicitly
      includes: (a) an opt-in `deleteUntracked`-equivalent that only treats untracked-only
      dirtiness as removable, never a tracked-file change; (b) an opt-in best-effort branch-deletion
      option that never undoes an already-successful cleanup on its own failure; (c) a
      per-workspaceId queue (not a reject-on-busy boolean lease) for concurrent create/cleanup
      against the same repo, with a test proving no two Git commands for the same repo ever run at
      once.
- [ ] This ticket is closed once that future implementation ticket exists and references it (not
      once the feature itself ships -- this ticket's scope is "the requirement is captured
      somewhere real," not "the feature is built").

## Tests
None here. The future implementation ticket should port upstream's own test additions
(`subagent-worktree.test.ts`'s untracked-cleanup and branch-deletion cases, `worktree-trust.test.ts`'s
concurrent-queue proof) once it exists.

## Rollback
N/A -- this is a tracking ticket with no code changes.

## Stop conditions
None -- this ticket cannot fail, only wait.

## Ownership and routing
Whoever picks up ADI-12's eventual implementation ticket. No action needed until then.
