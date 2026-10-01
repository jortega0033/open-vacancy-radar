## Objective
Pull upstream `jortega0033/agentdock`'s new live model-catalog capability (commits `f7b0328` #109
and `f72534f` #114, closing upstream #107/#110) into this repo's copy-derived packages, so the
already-shipped-but-static ADI-13 model-select capability resolves against a real, live model list
per provider instead of a hardcoded array -- and, for both providers, brings in the `model.catalog`
capability at all, since it does not exist anywhere in this repo's copy today (see Dependencies:
this is blocked on ADI-08, which has not landed here yet).

## What changed upstream, verified by reading both commits directly
- `f7b0328` ("feat(protocol): allow a caller to select model per v2 session", closes upstream #107):
  adds `fetchModelCatalog?(options: { cwd, signal }): Promise<readonly ProviderModelCatalogEntry[]>`
  to the provider interface (`packages/agent-runtime/src/types.ts`), `GET
  /v2/providers/:providerId/models` (`apps/daemon/src/routes/v2-providers.ts`), and wires Codex's
  catalog to a live validation against the app-server's own `model/list` RPC (an invalid model now
  fails session startup with `codex_model_unavailable` instead of being silently ignored). Also fixes
  a real, previously-uncaught bug: both providers' `model.catalog` capability-support records used a
  `pageSize` outside `catalogConstraintsSchema`'s own declared 1-100 bound, which failed
  `negotiateCapabilities()`'s schema validation for the *entire* manifest, not just that one field --
  this was the actual root cause of an unrelated-looking Windows packaged-daemon smoke-test timeout.
- `f72534f` ("feat(claude): live model catalog probe", closes upstream #110): adds
  `probeClaudeModelCatalog()` -- a short-lived Claude Agent SDK session that starts and immediately
  ends without ever sending a real prompt, used only to read the SDK's own live model list and
  (best-effort) the account's resolved default model from the first `system/init` stream message.
  Wires `ClaudeProvider.fetchModelCatalog()` to it and flips Claude's `model.catalog` capability
  record from unsupported to supported. Ships with a full fake-SDK-factory test suite mirroring the
  existing `claude-sdk-transport.test.ts` pattern.

`ProviderModelCatalogEntry` is `{ id: string; displayName: string; isDefault: boolean }`, not a plain
string -- richer than this repo's own `availableModels: string[]`.

## Why this is useful for OVR specifically, not just an upstream nicety
This repo already has its own, independently-designed per-v2-session model-selection mechanism
(ADI-03/#121, activated by ADI-13/#140): `MODEL_SELECT_CAPABILITY_ID =
'ext.open_vacancy_radar.model_select'` (`packages/vacancy-agent-adapter/src/model-select.ts`),
resolved in `apps/daemon/src/routes/v2-sessions-create.ts`'s `resolveCapability()` via
`resolveModelSelection(extension.constraints, catalog)`. Verified directly: at both call sites
(`v2-sessions-create.ts:246` and `:417`) the `catalog` argument passed in is
`status.availableModels` -- and `packages/agent-runtime/src/providers/claude/detect.ts:44` sets that
to `[...CLAUDE_MODELS]`, a hardcoded static array from `capabilities.js`. There is no
`fetchModelCatalog` anywhere in this repo's `packages/agent-runtime` today (confirmed by grep --
zero matches). So the resolver, the capability, and the daemon-side plumbing to *use* a live catalog
already exist and are already tested; the only missing piece is a real catalog to hand them, which
is exactly what these two upstream commits build.

Concretely, pulling this in means: a new Claude model becomes selectable the moment it exists in the
account's own live SDK-reported list, with zero code change here to add it to a hardcoded array (and
a retired/renamed model stops being silently offered as valid). It also unlocks Codex model selection
for the first time in this repo -- today `resolveCapability`'s `catalog` argument for Codex is
whatever `status.availableModels` is for that provider, and this repo's Codex provider has never had
a live-validated model list either.

## Non-goals
- No end-user-facing model picker UI. Grep confirms zero references to
  `MODEL_SELECT_CAPABILITY_ID`/`modelSelect`/`ModelSelect` anywhere under `apps/desktop/src` or
  `apps/desktop/electron` -- the whole capability, live catalog included, ships with no caller today,
  same as ADI-03/ADI-13 shipped before it. Building that picker is a real, separate follow-on ticket
  once this port lands, not bundled here.
- Does not change `resolveModelSelection`'s own signature or validation rules (regex, byte bound) --
  those are unrelated to where the catalog comes from.
- Does not port the Codex-specific `app-server/scope-probe.ts` widening wholesale if this repo's own
  Codex adapter has diverged enough that it doesn't apply cleanly -- verify against this repo's
  current `packages/agent-runtime/src/providers/codex/` before assuming a straight copy works LN #34.

## Scope
1. **`packages/agent-runtime`**: port `ProviderModelCatalogEntry` and the optional
   `fetchModelCatalog` provider-interface method (`types.ts`); port Claude's
   `sdk/catalog-probe.ts`, the `sdk-options.ts` config-directory extraction it depends on, and the
   `sdk-support.ts` capability-record flip (with the `pageSize` bound fixed correctly the first
   time, per the bug upstream found); port Codex's live `model/list` validation and
   `app-server-support.ts` capability record.
2. **`packages/shared`**: port `providerModelV2Schema`/`providerModelCatalogV2ResponseSchema`
   (`capabilities-v2.ts`) and confirm `catalogConstraintsSchema`'s bound (this repo's copy may
   already have the correct 1-100 bound if it postdates the fork -- verify before re-fixing
   something already fine).
3. **`apps/daemon`**: add `GET /v2/providers/:providerId/models` to this repo's own
   `v2-providers.ts` -- note this is **not a drop-in file copy**: this repo's `v2-providers.ts` has
   already diverged from upstream's (different response shape --
   `V2_SESSION_VIEW_SCHEMA_VERSION`/`toProviderV2View`/`ActiveSessionLimiter`, none of which exist
   upstream), so the new route must be written against this repo's existing conventions, not pasted
   from the diff.
4. **Wire the seam**: change `v2-sessions-create.ts`'s two `resolveCapability(extension,
   status.availableModels)` call sites to prefer a live `provider.fetchModelCatalog()` result
   (mapped to `entry.id[]`, since `resolveModelSelection`'s `catalog` parameter is
   `readonly string[] | undefined`) when the provider supports it, falling back to
   `status.availableModels` when it does not -- decide during implementation whether that fallback
   belongs in the route or inside `detect()` itself.

## Dependencies
**Blocked on ADI-08 (#126, still OPEN).** Re-verified while filing this ticket: neither
`packages/agent-runtime/src/providers/claude/sdk*` nor
`packages/agent-runtime/src/providers/codex/app-server*` exist in this repo at all -- OVR's Claude
and Codex providers are still v1 CLI-exec-only (`adapter.ts`/`build-args.ts`/`capabilities.ts`/
`detect.ts`/`parser.ts` for Claude; the equivalent v1 set for Codex), with no v2 `getV2Support`
surface and no `model.catalog` capability record of any kind, supported or stub. Upstream's live
Codex catalog validates against the app-server's own `model/list` RPC (no RPC channel exists over
plain CLI exec), and upstream's live Claude catalog is a short-lived Claude Agent SDK session (the
SDK dependency and its session-transport plumbing is squarely ADI-08's scope, not something to
introduce standalone). ADI-13's `resolveCapability`/`resolveModelSelection` mechanism this ticket
plugs into is independent of v2 capability negotiation -- it reads `status.availableModels`, a plain
string array off `ProviderStatus`, not a `model.catalog` capability record -- so the daemon-side
plumbing genuinely has no blocker of its own; the block is entirely "there is no live catalog to
fetch yet, for either provider, until ADI-08 lands the transport that can produce one." Builds on
already-merged ADI-03 (#121) and ADI-13 (#140, closed) once unblocked.

## Acceptance criteria
- [ ] `fetchModelCatalog` exists on the Claude and Codex providers in this repo's
      `packages/agent-runtime`, backed by a live probe/RPC, not a hardcoded list.
- [ ] `GET /v2/providers/:providerId/models` exists on this repo's daemon, in this repo's own v2
      response-schema style, and returns a real catalog for a provider that supports one.
- [ ] A fresh `POST /v2/sessions` request carrying the `ext.open_vacancy_radar.model_select`
      capability resolves against the live catalog when available (verified with a fake
      SDK/app-server harness, not a real network/CLI call in CI).
- [ ] The existing static-list fallback still works unchanged for a provider/build where the live
      probe is unavailable or times out -- this must be `unavailableOptional`, never a request
      failure, per `resolveCapability`'s own documented three-way split.
- [ ] Every ported capability-support record is asserted against the real
      `catalogConstraintsSchema` at runtime in a test (not just `toMatchObject` against named
      fields) -- this is the exact gap that let upstream's `pageSize` bug reach a packaging smoke
      test undetected; do not reintroduce it here.

## Tests
Port upstream's fake-SDK-factory `claude-model-catalog-probe.test.ts` pattern and the
`server-v2.test.ts` route-level positive test, adapted to this repo's actual v2 route file and
response shape. Add a `resolveCapability`-level test proving a live catalog (not just
`status.availableModels`) is what actually gets consulted once wired.

## Rollback
Every file this touches is additive (`fetchModelCatalog` is an optional interface method; the new
route is a new endpoint) except the two `resolveCapability` call sites in
`v2-sessions-create.ts`, which is a single, easily-reverted line change per call site back to
`status.availableModels`. No schema/migration involved.

## Stop conditions
Stop and re-scope if this repo's Codex adapter has diverged from upstream's far enough that
`app-server/scope-probe.ts`'s widening does not translate cleanly -- read this repo's current file in
full before assuming the upstream diff applies, the same lesson ADI work has already learned about
`v2-providers.ts`.

## Ownership and routing
AI Engineer (provider-adapter/live-probe work) with a follow-up Frontend ticket once this lands, if
and when a real model-picker UI is wanted -- this ticket intentionally stops at the daemon/protocol
layer per the Non-goals above.
