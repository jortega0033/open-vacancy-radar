# OVR Dev AI Handoff

Last reviewed: 2026-09-19 (Europe/Amsterdam)  
Repository: `jortega0033/open-vacancy-radar`  
Baseline reviewed: `master` at `8dbaa2fa0c6b847d15df432a48c4ab3a0082cdae`

## Purpose

This is a living implementation handoff for the current open-issue backlog. The backlog is being reviewed in finite batches rather than on an hourly schedule.

For each ticket, this review checks:

- whether the issue still matches current `master`;
- whether dependencies/blockers are accurate;
- whether the issue contains enough implementation detail to start without rediscovery;
- whether `decision: implement` is justified;
- whether stale assumptions or contradictions need to be repaired before handoff;
- whether another open ticket must land first for the stated behavior to be true.

This document does **not** authorize broad scope expansion. Follow each issue's explicit non-goals and preserve current security/privacy boundaries.

## Recommended implementation rule

Prefer one issue or one explicitly bounded phase per PR. Do not combine unrelated backlog tickets simply because they touch the same page/package.

---

## Batch 1 — newest active implementation tickets

Reviewed: #395, #396, #398, #399, #400.

### Recommended order

1. **#399 — Browse-all stale scoped filters**
2. **#400 — persisted vs effective AI provider**
3. **#395 — scoreless query-match ordering**
4. **#396 — scanned/image-only PDF CV transcription fallback**
5. **#398 Phase 1 only — on-demand AI web-search vacancy discovery**

The order is about dependency/risk reduction, not product priority. #398 is largely independent but is much larger than the first four.

### #399 — Browse-all scan inherits stale scoped-search filters in live and final views

Status: **implementation-ready**  
Label: `decision: implement` remains justified.

Current `master` confirms the bug:

- `runBrowseAllScan` still calls `setPendingScanFilters(filters)`;
- the backend call is only `runScan({ mode: 'browse_all' })`;
- live rows use `effectiveFilters = pendingScanFilters` while streaming;
- successful completion promotes `pendingScanFilters` into `appliedFilters`.

Therefore stale query/country/employment/salary criteria can still narrow a Browse All run despite never being sent to the backend.

The ticket's proposed `browseAllViewFilters(filters)` boundary is appropriately narrow. Preserve local display refinements and clear scan-bound criteria plus `sponsorOnly`.

Implementation note: land this before relying on #395's claim that Browse All has an empty effective query.

### #400 — Distinguish persisted AI-provider preference from effective installed provider

Status: **implementation-ready**  
Label: `decision: implement` remains justified.  
Unblocks: **#396**.

Current `master` confirms:

- workspace `defaultProvider` still defaults to `claude`;
- `useAgentRun` still independently falls back with `options.provider ?? 'claude'`;
- the persisted preference is distinct from runtime installation detection.

Preserve the ticket's core semantic decision:

- persisted preference changes only through explicit user choice;
- effective provider may temporarily fall back to the single installed alternative;
- never rewrite the stored preference merely because an executable disappears.

Important implementation detail: centralize resolution rather than reproducing fallback logic in every feature. Low-level hooks should not silently invent a second provider-selection policy.

### #395 — Rank scoreless Search results by query-match strength before recency

Status: **implementation-ready, but sequence after #399 for the Browse All integration contract**.  
Label: `decision: implement` remains justified.

Current `master` confirms:

- `filterSearchResultIndex` already uses deterministic lowercase substring matching across title/company/description;
- `sortSearchResultIndex` currently sorts scored/scored pairs by profile score, then falls through to posted date/title;
- scoreless rows have no query-match ordering today;
- `SearchPage` currently calls `sortSearchResultIndex(...)` without the effective query.

The ticket was refined during this review to make the #399 sequencing explicit. The sort-helper work can be implemented independently, but Browse All only becomes naturally recency-only after #399 clears stale query criteria from `pendingScanFilters`.

Do not solve #399 inside #395.

### #396 — Add reviewed transcription fallback for scanned/image-only PDF CVs

Status: **blocked by #400; otherwise substantially specified**.  
Label: no `decision: implement` yet, correctly.

Runtime blocker already removed:

- #401/#402 landed outbound session attachments on current `master`;
- direct PDF attachment support now exists in the local AgentDock fork.

Current app gap still exists:

- `cv-text.ts` throws a generic error when PDF extraction yields no text;
- `cv:select-and-read` in Electron main simply returns `readCvFile(filePath)`;
- there is no consented AI-transcription fallback or provenance/review flow yet.

This review corrected one stale contradiction in the ticket: after direct PDF attachment made rasterization unnecessary, the bounds section still required cleanup of temporary rasterized images. It now correctly requires cleanup of the app-owned staged PDF/scratch attachment.

Required sequence:

1. land #400 so the app can choose an effective installed provider reliably;
2. then implement this ticket without exposing renderer-supplied arbitrary paths;
3. keep explicit per-upload consent and transcription provenance/review.

After #400 merges, re-check the blocker and add `decision: implement` only if no new provider-selection ambiguity remains.

### #398 — Add AI-web-search vacancy discovery source

Status: **implementation-ready for Phase 1 only; scheduled Phase 2 has additional gates**.  
Label: `decision: implement` remains justified for beginning the bounded Phase 1 slice.

Current `master` confirms the ticket's important architecture claims:

- `runGlobalRemoteDiscovery` is a fixed in-process `Promise.all` fan-out;
- `vacancy-engine` is not the place to host Claude/Codex sessions;
- Claude's existing hardened tools include both filesystem tools and `WebSearch`/`WebFetch`, so a dedicated web-only profile is materially safer;
- `SessionManager.create` already selects a server-owned `toolProfile`, and the application field-map route demonstrates the correct route-owned hardening pattern;
- `DiscoveryProvider` is a closed union and `SOURCE_FILTER_CAPABILITIES` is exhaustive.

Keep Phase 1 bounded to **manual/on-demand discovery**. Do not bundle scheduled/unattended discovery into the first implementation PR.

Before Phase 2 scheduled execution, resolve the provider's actual behavior for loopback/private/link-local WebFetch targets or move exact-page retrieval behind OVR's controlled HTTP boundary as described in the issue.

Also preserve these boundaries:

- Claude-only for V1 unless another provider can mechanically enforce the required web-only capability;
- no CV body, identity, email, phone, or application history in the web-enabled prompt;
- strict intermediate schema validated outside the daemon;
- exact vacancy-page verification rather than snippet-only trust;
- deterministic discovery must still succeed when this source is unavailable.

---

## Batch 1 changes made during review

- #395: added an explicit sequencing note explaining that its Browse All behavior depends on #399 landing first.
- #396: removed stale rasterization cleanup language and replaced it with staged PDF/scratch attachment cleanup.
- No labels were changed in Batch 1 because the current readiness labels already match the reviewed state.

---

## Remaining batches

Not yet reviewed in this document:

- source integrations / source-policy / public-data tickets;
- AgentDock / ADI runtime and capability tickets;
- deferred product/research tickets;
- source-scouting / release QA / epics and final backlog cleanup.

Do not treat unreviewed tickets as implementation-ready merely because they are open.
