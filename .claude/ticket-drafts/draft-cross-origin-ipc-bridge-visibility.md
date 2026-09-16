## Goal
Let the review UI and the field-map generation session see which frame each field actually lives in, so a person reviewing an application (or the AI assigning values to fields) can reason about a cross-origin field the same way `packages/application-executor` now can.

## Why now
The September 2026 architecture audit's F-D finding (cross-origin iframe field-fill has no origin check) was fixed and merged this session: `dom-extract.ts`/`executor.ts` now refuse to fill any field whose frame origin differs from the top document's unless a policy explicitly allowlists it (`isFrameFillAllowed`, `target-policy.ts`). That fix closes the write path. But the fix's own implementer flagged a real, adjacent gap in their final report: `apps/desktop/electron/preload.ts` (~line 1230) rebuilds a sanitized snapshot field-by-field for the renderer, and that rebuild does not carry `frameOrigin`/`topFrameOrigin` across the IPC bridge. So while a cross-origin field can no longer be *filled*, nobody on the desktop side of the bridge -- not the review UI a person looks at, not the field-map generation session an AI call drives -- can currently see or reason about which frame a field came from at all. A field silently refused for being cross-origin shows up to a reviewer as an unexplained blocker, not as "this field lives in a third-party widget, not the real form."

## Scope
- Extend whatever sanitized snapshot shape `preload.ts` sends to the renderer to include each field's `frameOrigin`, and the snapshot's own `topFrameOrigin`, mirroring what `FormSnapshot`/`SnapshotField` already carry inside the executor package.
- Surface it somewhere a person reviewing the application can actually see -- at minimum, a blocker/explanation string for a field refused specifically for being cross-origin (distinct from "required field empty" or other existing blocker kinds), so `describeBlockers`-style UI copy can say what's actually going on instead of a generic refusal.
- Consider whether the field-map generation session's own prompt should be told a field's frame origin, so the AI assigning values can avoid proposing an assignment to a field it already knows will be refused, rather than proposing it and having the executor silently drop it.

## Non-goals
- No change to the refusal logic itself (`isFrameFillAllowed`, `resolveActiveGroup`) -- that's already correct and tested; this ticket is purely about making the existing decision visible on the other side of the IPC boundary.
- No new policy-configuration UI for `allowedSubFrameOrigins` -- that stays a code-reviewed policy field, per `target-policy.ts`'s existing "never JSON/config" discipline.

## Acceptance criteria
- A fixture page with a cross-origin embedded widget (reusing `packages/application-executor/test/cross-origin-frame-fill.test.ts`'s fixture shape) shows a person-readable, frame-origin-specific blocker in the review UI, not a generic one.
- The field-map generation session's prompt-building code has access to per-field frame origin, verified by a new test asserting it's present in the bundle passed to the session.
- No change to any existing test's assertions about same-origin pages -- this is additive visibility only.

## Risk
Low. This is a read-only visibility extension across an existing IPC boundary and prompt-input bundle -- no new write path, no new trust decision. The only real risk is scope creep into redesigning the blocker/UI copy system; keep this to "surface the data that already exists one level deeper," not a UI redesign.
