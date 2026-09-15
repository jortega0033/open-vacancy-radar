## Objective

Add `POST /v2/sessions` — the one v2 write route ADI-05 deliberately deferred — and use it to finally activate the model-select capability extension that ADI-03 shipped but never wired to anything.

## Why this ticket exists

ADI-05 (#123) scoped `v2-session-facade.ts`/`provider-v2.ts`/`routes/v2-sessions.ts` but shipped v2 read-only, explicitly deferring session creation. That left `POST /v2/sessions` owned by no ticket at all: ADI-06 (#124) and ADI-07 (#125) both presuppose it exists in their own acceptance criteria and rollback plans, but neither delivers it. ADI-03 (#121) has been unable to advance past its first slice for the same reason -- every one of its remaining bullets (fresh v2 sessions requesting the capability, persisting the selection, resume preserving model evidence) needs a real v2 session-creation path to attach to, and every workaround investigated (faking a selection for v1 sessions, validating v1's `model` field, negotiating capabilities over the ADI-02 health/protocol-version path) either fabricates negotiation evidence for a session where none occurred or breaks a constraint #121 states explicitly (v1 `CreateSessionRequest.model` stays unvalidated passthrough, v1 behavior stays unchanged).

## Scope

Expected modules:

- `packages/shared/src/session-v2.ts` -- add a `selection` field to `agentSessionV2ViewSchema`: `{ enabled: [{ id, constraints }], unavailableOptional: [{ id, reason }] }`, reusing the already-shipped `opaqueCapabilityConstraintsSchema`. Deliberately narrower than upstream's `CapabilitySelection` -- drop `transport` (already a top-level field on the view) and `possibleEffects`/`effectsComplete` (upstream's `Effect` catalog is not ported and has no other consumer; porting it now for one field would repeat the "schema with no producer" mistake ADI-05 refused).
- `apps/daemon/src/persisted-session-schema.ts` -- add the same `selection` shape to the persisted record; bump the store's `schemaVersion` per the fail-closed future-version rule ADI-05 established (older builds must refuse to touch a store a newer build wrote, not attempt to interpret it).
- `apps/daemon/src/routes/v2-sessions.ts` -- add `POST /v2/sessions`, accepting a narrowed `CreateSessionV2Request` (`{ provider, cwd, prompt, resumeProviderSessionId?, capabilities?: [{ id, value }] }` -- no `allowDirtyWorkspaceShare` unless ADI-06's lease model requires an equivalent).
- `apps/daemon/src/session-manager.ts` -- the actual call site: intersect any requested `ext.open_vacancy_radar.model_select` capability via `resolveModelSelection` (from `packages/vacancy-agent-adapter`, unused since it shipped) against the provider's real catalog, write the result into the session's `selection`, and thread the resolved model into `StartSessionOptions.model` exactly like v1 already does.
- `packages/shared/src/capabilities-v2.ts` -- add `ext.open_vacancy_radar.model_select` to `ACTIVE_CAPABILITY_EXTENSION_IDS` (currently frozen empty, with a doc comment naming ADI-03 as the ticket expected to add the first entry).

## Non-goals

- Do not port an execution graph, turn algebra, or upstream's `Effect` catalog. This repo's lineage store deliberately has none of that (see the ADI-05 ADR section), and a `selection` field does not need it.
- Do not add a "fork" continuation kind. This repo's `continuationKind` stays `'fresh' | 'resume'` only -- upstream's fork concept has no counterpart here and none is being added by this ticket.
- Do not touch v1 `POST /sessions` or `CreateSessionRequest.model`'s existing unvalidated-passthrough behavior.
- Do not attempt transport fallback preserving the model -- that's ADI-08's job (a second transport has to exist before fallback behavior is testable at all; `FallbackGate` is provably always-deny today with only `legacy-one-shot` registered).
- Do not land before ADI-06. ADI-06's objective is establishing the trust boundary before v2 sessions can affect user workspaces; landing real v2 session creation first would ship an unguarded v2 execution path, which is exactly what ADI-06 exists to prevent.

## Dependencies

ADI-05 (merged) and ADI-06.

## Acceptance criteria

- [ ] `POST /v2/sessions` creates a real v2 session through the existing `SessionManager`/`ActiveSessionLimiter`/durable-store path, not a parallel one.
- [ ] A session requesting `ext.open_vacancy_radar.model_select` gets a fail-closed-intersected model, recorded in `selection.enabled`; an invalid/unavailable request lands in `selection.unavailableOptional` with a reason, never silently ignored.
- [ ] `GET /v2/sessions/:id` reflects the same `selection` a client can independently verify against `GET /v2/providers/:id`'s `availableModels`.
- [ ] Resuming a session preserves its original model evidence; a resume request attempting to override the model is rejected, not silently honored.
- [ ] v1 `POST /sessions` and `CreateSessionRequest.model` behavior is provably unchanged (existing v1 tests pass unmodified).
- [ ] A store written by this ticket's schema version is refused (not partially read, not migrated) by a daemon built before this ticket, per the existing downgrade test pattern.

## Tests

New: `POST /v2/sessions` happy path, capability-request rejection paths (unknown model, malformed request, catalog-less provider), resume-preserves-model, resume-override-rejected, v1/v2 shared active-session accounting (extending the existing limiter tests), schema-version downgrade refusal for the bumped store version. Regression: full v1 session-creation suite unchanged.

## Rollback

Disable `POST /v2/sessions` (route returns 404 again, same as pre-ADI-13) and remove `ext.open_vacancy_radar.model_select` from `ACTIVE_CAPABILITY_EXTENSION_IDS`. Existing v2 read routes, v1 sessions, and durable-store state are unaffected.

## Stop conditions

Stop if a v1 session can be made to carry a fabricated `selection`, if a resume can silently swap models, or if this ticket's write path bypasses the active-session limiter or durable store that v1 sessions already go through.

## Ownership and routing

Backend Architect, strongest reasoning model at xhigh. Independent review required (this is the write-path counterpart to a ticket -- ADI-05 -- that already required it).
