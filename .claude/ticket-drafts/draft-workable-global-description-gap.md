## Goal
F-E: workable_global can never carry a job description -- product decision needed (P1)

Decide, as a product call rather than a unilateral code fix, whether `workable_global` -- the single highest-volume discovery source -- gets a real per-listing detail-fetch to obtain job descriptions, or whether "permanently `needs_user` for this source" is accepted and documented as a known limitation. This ticket is for that decision; it is not a request to build either option yet.

## Why now
Verified directly this session in `packages/vacancy-engine/src/global-remote/workable-feed.ts:24-59`: `JOB_FIELDS` (the source RSS field list Workable's feed actually exposes) includes `description`, but `RECORD_FIELDS` (the compact shape this app persists per listing) omits it entirely -- the field is read off the wire and then thrown away by design, not missing from the source. Line 463 confirms the parser actively discards it in the streaming XML handler: `if (activeField.name !== 'description') activeField.value += text;`. There is no per-listing detail-fetch for `workable_global` anywhere in this codebase -- unlike Himalayas/Jobgether (see `.claude/ticket-drafts/draft-on-demand-jd-fetch-himalayas-jobgether.md`), there isn't even an unwired helper to point to; the description text is dropped at parse time and never fetched again.

This was a latent, cosmetic gap until this session: a JD-capture guard fixed earlier in this session now refuses to let an attempt proceed past the `reading_jd` checkpoint without a real, captured description (`apps/desktop/electron/application-pipeline.ts`), and the `fetchMissingJobDescription` hook on `ApplicationPipelineDeps` that the guard can fall back to currently only covers Jobgether. For `workable_global`, there is no fallback to call -- every vacancy from this source now hits the guard and lands on `needs_user` for "Prepare application" with no path forward. Because `workable_global` is the highest-volume source in the app, this is not a small edge case: it is a structural dead end sitting on top of the largest slice of vacancies the app surfaces, and it will not close itself the way a rare per-listing failure would.

## Scope
- Lay out, with real costs, the two live options:
  1. **Build a real per-listing detail-fetch for `workable_global`.** This means fetching each individual Workable job page (or a per-id API endpoint, if Workable's job-board API exposes one beyond the RSS feed) on demand, parsing the real description out of page/response chrome, and wiring it into `fetchMissingJobDescription` the same way Jobgether is wired. Real engineering cost: a new fetch+parse path against a source not controlled by this app, ongoing maintenance risk if Workable changes page/feed structure, and the same bot-detection and timeout constraints already documented for Himalayas/Jobgether in the sibling ticket.
  2. **Accept and document the limitation.** `workable_global` vacancies stay permanently `needs_user` for "Prepare application" unless/until a detail-fetch is built. Requires an explicit, user-visible explanation (not a silent stall) and a call on whether that is acceptable given the source's volume share.
- Quantify, or at least estimate, what share of scanned/matched vacancies come from `workable_global` so the product owner is deciding with real numbers, not just "highest-volume" as a qualitative label.
- Get an explicit decision recorded (this ticket, a follow-up ticket, or wherever decisions are tracked in this repo) before any implementation ticket is opened for either path.

## Non-goals
- No implementation of a detail-fetch in this ticket.
- No change to `RECORD_FIELDS`, the RSS parser, or any other `workable-feed.ts` behavior in this ticket.
- No change to the `reading_jd` guard's behavior or to `ApplicationPipelineDeps` in this ticket.
- Not a re-litigation of the Himalayas/Jobgether ticket's scope -- this is `workable_global` specifically, which currently has zero fetch path, versus those two sources' partial coverage.

## Acceptance criteria
- A documented, explicit product decision exists: build a `workable_global` detail-fetch, or accept and document the `needs_user` limitation for this source.
- If "build," a follow-up implementation ticket is opened with its own scope, matching the shape of the Jobgether/Himalayas ticket (fetch mechanism, chrome-stripping, timeout/retry bounds, tests).
- If "accept," the limitation is reflected somewhere a user encountering `needs_user` on a `workable_global` vacancy can understand why (e.g., the refusal message or in-app documentation), not left as an unexplained stall.
- Either way, this ticket itself does not merge any code change to `workable-feed.ts` or `application-pipeline.ts`.

## Risk
Low as a ticket (no code change), but the underlying exposure is high if left undecided: the highest-volume discovery source silently produces vacancies that can never complete "Prepare application," and a user has no way to distinguish "this specific listing has no description" from "this entire source structurally cannot support this feature." Leaving the decision unmade risks the guard's dead end being discovered piecemeal by users rather than addressed deliberately.
