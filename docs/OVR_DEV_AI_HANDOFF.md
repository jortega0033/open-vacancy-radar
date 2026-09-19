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

## Batch 2 — source policy, scraper research, and MCP vacancy connectors

Reviewed: #3, #5, #7, #8, #10, #28, #29, #30, #31, #32.

### Recommended disposition

- **#29 Upwork MCP** — implementation-ready only in the newly narrowed principal-directed/unscored V1.
- **#3 JobSpy** — keep as policy-first spike; do not build Python runtime until one named source proves value and permission.
- **#30 JobGPT** — keep as bounded API-key spike; production remains blocked on vendor/data-rights evidence.
- **#5 BambooHR** — keep deferred.
- **#7 enterprise ATS tranche** — keep deferred and split provider-by-provider if resumed.
- **#8 browser/Crawlee fallback** — keep deferred until one concrete reviewed source proves static HTTP is insufficient.
- **#28 Indeed MCP** — keep deferred; official docs still say Claude Connector only.
- **#31 LoopCV MCP** — keep deferred pending written commercial/data-rights agreement.
- **#32 openings-mcp** — keep wholesale integration prohibited/deferred; use only as provider-by-provider research evidence.
- **#10 source-expansion epic** — coordination/history only; do not implement the epic directly.

### #29 — Upwork MCP

Status: **implementation-ready for a narrower V1 than the original ticket implied**.  
Label: `decision: implement` remains justified after refinement.

Current OVR state:
- #27 MCP foundation is already shipped.
- policy-gated daemon manager, strict tool allowlisting, OS credential storage, cache expiry, daemon routes and renderer IPC all exist;
- `McpTransportPolicy` supports `oauth-pkce`;
- `McpSdkConnectorFactory` can accept a provider-specific `OAuthClientProvider`;
- `buildMcpManager()` currently injects no OAuth provider factory, so provider onboarding still needs explicit work.

Current Upwork API & MCP Terms v2.3 (effective 2026-08-13) create an important product constraint: an Agent may retrieve/display results using search/filter criteria explicitly supplied by the Principal, but must not independently rank/score/filter employment opportunities using criteria it determines.

Therefore V1 must:
- live in a separate Freelance/Upwork surface;
- use only contemporaneous user-entered search criteria;
- never feed Upwork rows through OVR profile scoring, SemanticScorer, CV matching, automatic recommendation, or AI-derived filtering;
- never run in a scheduler/background scan;
- preserve provider ordering unless the user explicitly chooses a deterministic display sort;
- retain only according to Upwork's current MCP-output limits;
- expose no application/proposal/message/contract/payment tools.

Implementation should extend the existing MCP foundation rather than create another client. Provider-specific OAuth/PKCE, localhost redirect handling and token persistence belong in this ticket.

### #30 — JobGPT MCP

Status: **time-boxed spike only**.  
Label: `decision: spike` remains correct.

The upstream facts changed:
- official JobGPT now supports browser OAuth 2.1/PKCE as well as API-key auth;
- current API keys are documented as `sk_`, not `mcp_`;
- upstream reviewed at `17f9f3b51cf8db4ecc288f1626c086b0750b8b25`.

For this spike, use OVR's already-shipped API-key credential path unless OAuth is specifically needed to answer the spike questions. Do not build general OAuth onboarding merely for this experiment.

Allowlist only `search_jobs` and `get_job`. The vendor exposes many write/profile/resume/outreach/auto-apply tools; those remain mechanically unreachable.

Production remains blocked on source rights, storage/redistribution terms, GDPR allocation and vendor agreement evidence.

### #28 — Indeed MCP

Status: **deferred, freshly reverified**.

Indeed's official MCP docs were updated on 2026-09-12 and still explicitly say the MCP server is available only for the Claude Connector. Current Developer Agreement language also requires written approval of integrations and restricts unapproved combinations, permanent-copy/database behavior and algorithmic API calls.

Do not implement a generic OVR Indeed connector until Indeed gives written authorization for OVR's exact client/aggregation model.

### #31 — LoopCV MCP

Status: **deferred, unchanged**.

LoopCV still publicly advertises job-search API/MCP coverage over LinkedIn, Indeed, Glassdoor and 30+ sources, but MCP remains beta/early access and its generic website terms still grant personal, non-commercial use only. The required commercial/source-rights agreement remains missing.

No implementation work should start from this ticket.

### #32 — openings-mcp provider audit

Status: **wholesale integration remains prohibited/deferred**.

Current upstream was rechecked at `3726ec094d5a17e21bed592686a2e126de12a4ab`. The risky evidence is still present:
- LinkedIn client warms a cookie jar around HTTP 999/authwall behavior and documents the endpoint as reverse-engineered/not public API;
- Indeed client still sends a mobile app key to `apis.indeed.com/graphql`;
- upstream README still says the project is unofficial/personal-use, uses some undocumented APIs and provides no internal rate limiter.

Upstream has many useful ATS implementation references. Those may inform #349/provider-specific research, but never justify connecting the whole openings-mcp binary or inheriting all providers.

### #3 — JobSpy worker

Status: **policy-first spike, not runtime implementation**.

OVR now has #9 source-gap telemetry and #341 durable source observations. JobSpy should not receive a Python worker just because the package exists.

Before any second-runtime work:
1. identify a named JobSpy-backed source with affirmative access/reuse permission;
2. show that current OVR telemetry has a material gap for it;
3. show that an existing native adapter or #349 follow-up is not the simpler solution.

Current JobSpy still centers on scraping major boards and documents proxy usage for blocking-sensitive sources, so no production source is implicitly approved.

### #5 — BambooHR

Status: **deferred**.

Fresh BambooHR documentation confirms the documented ATS job-summary endpoint is authenticated and requires ATS-settings access. It is not a documented public job-board discovery API.

#9/#341 provide the telemetry machinery now, but there is still no evidence in this ticket that BambooHR is a sufficiently large unresolved gap or that a stable public discovery interface has affirmative permission. If signatures recur, #349 is the correct evidence lane.

### #7 — enterprise ATS tranche

Status: **deferred; original candidate list was stale**.

Corrections:
- #9 telemetry shipped;
- #341 observations/planner shipped;
- #349 owns unsupported-family evidence;
- Rippling should no longer be treated as deferred here because its dedicated #192 work completed and current detection treats it as supported.

Any remaining candidate must graduate into its own provider-specific issue. Never implement #7 as one bulk adapter PR.

### #8 — browser/Crawlee fallback

Status: **deferred**.

Telemetry now exists, but this ticket still lacks the required concrete source proving that bounded static HTTP/API/feed/sitemap/JSON-LD cannot recover useful vacancies.

If #349 finds such a provider, justify browser execution in that provider-specific follow-up. Do not create a generic crawler first, and never use this ticket to justify CAPTCHA/WAF/auth bypass.

### #10 — source-expansion epic

Status: **coordination/history only**.

Current continuation:
- #341 shipped;
- #348 is the approved bounded scheduled ATS-scouting implementation;
- #349 is the evidence-only unsupported-family research lane;
- #3 remains a spike;
- #5/#7/#8 remain deferred.

The Dev AI should implement the bounded child issue, never the epic itself.

### Batch 2 changes made during review

Ticket bodies materially refined:
- #3 — raised the threshold for creating a Python worker now that OVR has real telemetry/observations.
- #5 — recorded fresh official evidence that BambooHR's documented ATS jobs endpoint is authenticated.
- #7 — removed Rippling conceptually from the deferred tranche and tied remaining providers to #349 evidence.
- #8 — clarified that any browser fallback must be provider-specific.
- #10 — reconciled the epic with #341/#348/#349.
- #29 — updated for Upwork API & MCP Terms v2.3 and prohibited OVR-owned scoring/ranking of Upwork results.
- #30 — corrected current JobGPT OAuth/API-key behavior and key-prefix assumptions.
- #32 — revalidated the specific upstream LinkedIn/Indeed risk evidence against current source.

Freshly reviewed but no ticket-body change needed:
- #28 Indeed — deferral remains accurate.
- #31 LoopCV — deferral remains accurate.

No decision labels changed in Batch 2.


---

## Remaining batches

Not yet reviewed in this document:

- AgentDock / ADI runtime and capability tickets;
- deferred product/research tickets;
- source-scouting / release QA / epics and final backlog cleanup.

Do not treat unreviewed tickets as implementation-ready merely because they are open.
