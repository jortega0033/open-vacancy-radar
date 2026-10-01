## Objective
Track upstream `jortega0033/agentdock`'s new Codex `usage.rate_limits` protocol event (`fa322fc`
#116) so it is folded into ADI-08's (#126) Codex app-server work once that lands, instead of being
rediscovered or skipped when this repo's Codex provider finally gets a real app-server transport.

## Current decision
Not actionable yet. Confirmed directly: `packages/agent-runtime/src/providers/codex/app-server/
normalizer.ts` and `app-server-support.ts` do not exist anywhere in this repo -- OVR's Codex
provider is still v1 CLI-exec-only, with no app-server RPC channel to normalize notifications from.
ADI-08 (#126, OPEN) is the ticket scoped to add that transport at all; this feature has nothing to
attach to before then.

## What upstream added, verified by reading the commit directly
Codex's `account/rateLimits/updated` app-server notification was already being validated as a
well-formed object and then discarded -- nothing reached the daemon or any consumer, so there was no
way to observe rate-limit/quota headroom for a Codex session. The commit adds a new
`content.usage.rate_limits` core capability (Codex-only, no Claude equivalent -- Claude's CLI/SDK
exposes no equivalent signal) and normalizes the notification's primary/secondary window data into a
real `usage.rate_limits` protocol event, mirroring the existing `usage.tokens`/`usage.cost` event
shape already in `packages/shared/src/protocol-v2.ts`. A sparse rolling update carrying no window
data yet emits nothing, matching the vendor's own "merge into last-observed snapshot" guidance --
i.e. this does not fabricate a rate-limit event out of a partial/empty notification.

## Why this is worth having once Codex app-server lands
Anyone running Codex-backed daemon sessions in this app currently has no visibility into how close a
session is to Codex's own rate limit -- a session can simply start failing with no forewarning.
`usage.rate_limits` is a low-risk, read-only observability event (same trust tier as the
already-planned `usage.tokens`/`usage.cost` events for ADI-08's scope) with a real, if not urgent,
UX payoff (a rate-limit indicator in the AI Runtime panel, or just better error messages when a
session is refused for being near the limit).

## Non-goals
No Codex app-server transport of any kind here -- that is entirely ADI-08's scope. No desktop UI for
surfacing this event; that is a separate follow-on once the event itself exists in this repo and
ADI-08's own UI wiring (if any) is scoped.

## Dependencies
Blocked on ADI-08 (#126) landing the Codex app-server transport and its normalizer. This is a small,
additive fast-follow once that normalizer file exists, not something to fold directly into ADI-08's
own (already large, security-focused) acceptance criteria.

## Acceptance criteria
- [ ] Once ADI-08's Codex `app-server/normalizer.ts` exists in this repo, a follow-up ticket adds
      the `content.usage.rate_limits` capability and normalizes `account/rateLimits/updated` into a
      `usage.rate_limits` protocol event, mirroring this repo's own `usage.tokens`/`usage.cost`
      event shape (whatever that ends up looking like here, since `protocol-v2.ts` itself does not
      exist in this repo today either -- see Stop conditions).
- [ ] A sparse/partial rate-limit notification (missing window data) emits nothing, not a
      malformed or fabricated event.
- [ ] This ticket closes once that follow-up ticket exists and references it.

## Tests
None here. The follow-up ticket should port upstream's own test additions
(`codex-app-server-support.test.ts` capability assertion, `codex-app-server-transport.test.ts`'s
normalizer cases) once the underlying transport exists to test against.

## Rollback
N/A -- this is a tracking ticket with no code changes.

## Stop conditions
Re-verify this ticket's exact target shape once ADI-08 lands: this repo's `packages/shared` has
`capabilities-v2.ts` but not upstream's `protocol-v2.ts` (confirmed by direct file check), meaning
this repo's v2 event-shape conventions have already diverged from upstream's in ways not yet mapped
here -- do not assume `usage.rate_limits`'s upstream shape drops in unchanged.

## Ownership and routing
Whoever picks up ADI-08's Codex app-server work, as a fast-follow once that transport exists. No
action needed until then.
