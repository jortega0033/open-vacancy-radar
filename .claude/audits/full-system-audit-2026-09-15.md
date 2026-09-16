# Open Vacancy Radar — Full-System Audit
**Date:** 2026-09-15
**Scope:** Search → Discovery → Filtering → Evaluation → Ranking → Job Selection → Enrichment → Prep → Resume/CV → Cover Letter → Validation → Browser/Form → Submission → Persistence → Retry
**Method:** 16-agent structured audit (7 recon agents in parallel, 4 challenge/red-team agents fed the recon output, 3 cross-cutting audits, 2 independent adversarial reviewers), synthesized and contradiction-resolved by hand against the actual source. Every finding below traces to a file:line citation verified by at least one agent reading the real code, not inferred from docs or comments alone.

---

## 1. Executive Summary

Open Vacancy Radar is a genuinely well-architected desktop app for its size: two SQLite databases with a real bounded-context split, one HTTP-serving sidecar process with a defensible (if under-leveraged) security rationale, deterministic (non-AI) scoring and eligibility logic, and a 13-site AI call inventory that mostly reuses shared grounding infrastructure well. Nothing in this audit found a case for a rewrite, a new runtime service, or a new abstraction layer.

What it found instead is a small number of **real, currently-live correctness and safety gaps concentrated at the seams between subsystems** — the daemon/Electron-main boundary, the two independently-maintained "what is this application doing right now" state machines, and one cross-origin browser-automation gap — plus a long tail of dead code, undocumented forks, and one structurally permanent data-quality dead end (the highest-volume job source can never carry a job description). None of these require new architecture to fix. All of them require fixing the seam, not adding a component.

The single most important finding, surfaced independently by two different agents and confirmed by both adversarial reviewers: **the fix shipped this session for the daemon-hang bug (`daemonFetch` timeout) is real but incomplete.** The underlying single-lease concurrency model — which is the *only* thing preventing two concurrent preparation runs for the same application — has no fencing against an abandoned, still-running promise, and the lease itself is never reconciled after a daemon restart. This is fixable without new architecture (a generation/fencing token plus a startup-time stale-lease clear), but it is not yet fixed, and it is rated P0.

The second most important finding is new, not previously known to the team: **a duplicate-application race.** Two independently-strength identity checks exist in `createApplicationAttempt` — a weak raw-string check that guards in-progress attempts, and a strong normalized-identity check that guards only completed ones. A vacancy re-discovered from a second job board (a real, common occurrence — this is exactly the scenario `application-identity.ts` was built to solve) can spawn a second live attempt for a job already mid-preparation, and nothing downstream stops both from reaching submission. This is also P0.

Both P0s are narrow, well-understood, low-risk fixes — reusing code that already exists (`deriveApplicationIdentity`) or adding a small fencing primitive analogous to one the codebase already has (`submittingAttemptIds`). Neither requires redesigning the queue, the daemon, or the checkpoint model.

## 2. What the System Actually Does

A desktop Electron app runs two local SQLite databases in-process (`workspace.db` for the application/CV/job-tracking domain, `vacancy-engine.db` for sponsor-verification and HTTP caching) and spawns exactly one child process, a Fastify HTTP daemon (loopback-only) that in turn spawns `claude`/`codex` CLI processes on demand to run AI generation sessions. Electron main is purely an HTTP client to the daemon (`daemonFetch`); it is never a server itself.

The product's real job: periodically scan ~10+ remote job sources (`packages/vacancy-engine/src/global-remote/*-discovery.ts`), deterministically score and dedup the results against a candidate profile (zero AI in this path — pure regex/string matching), let the user save jobs and upload a CV, then run an unattended background pipeline that reads the job description, tailors a CV, drafts a cover letter, and — only for a job posting matched against an authorized automation policy — auto-fills a real employer's web form via Chrome DevTools Protocol. Today, **zero real employer sites are authorized for that last automated step** (`application-target-policies.ts` ships exactly one fixture-only policy), so every real application today stops at a manual "open this in your browser and apply yourself" card.

## 3. Current Architecture

```
Electron main process (apps/desktop/electron/main.ts, ~2600 lines)
 ├─ workspace.db  (Drizzle/better-sqlite3, WAL mode)   — CVs, letters, saved jobs, applications, attempts
 ├─ vacancy-engine.db (own client)                     — sponsor verification, HTTP cache
 ├─ 3 independent setInterval tickers (background scan / automatic submission / application pipeline)
 │    each with its own hand-rolled reentrancy guard
 ├─ WebContentsView + CDP (application-review-session.ts) — the real browser automation surface
 └─ spawn(execPath, ELECTRON_RUN_AS_NODE=1) ──► Daemon sidecar (apps/daemon, Fastify, loopback HTTP only)
       ├─ ApplicationQueueStore — single global JSON snapshot + append-only event log,
       │    one nullable `lease` field, synchronous acquire (atomic by construction)
       ├─ 3 more file-based durable stores (discovery-file, session-lineage, attachment, audit)
       └─ spawnProcess() on demand ──► claude / codex CLI (per AI session, never at daemon startup)
```

Packages: 8 total. `vacancy-engine` (discovery/scoring, own 28-key env schema, own SQLite, own undocumented CLI), the Electron app itself, the daemon, `agent-runtime` (provider adapters + process spawning), `client` (typed daemon SDK), `application-executor` (form snapshot/field-map validation/CDP submit), `vacancy-agent-adapter` (model/stage routing policy — thin, one dependency, a candidate for folding into `agent-runtime`).

## 4. End-to-End Search→Apply Pipeline (verified trace)

1. **Search** — `runGlobalRemoteDiscovery` runs ~10 source adapters concurrently (`Promise.all`), each independently try/caught; a blocked/errored/malformed source degrades to a `sources[]` row (`status: 'blocked'|'error'`), never crashes the scan. Fully deterministic dedup (`uniqueDiscovery`, tiered identity: ATS requisition ID → canonical URL → semantic fingerprint) runs once, in-memory, before anything touches disk.
2. **Evaluate** — `scoreWorldwideVacancy` (deterministic, zero AI, zero network) computes technical/role/seniority sub-scores, applies hard caps (excluded role family, unmet mandatory language, below-floor salary), and a `RELEVANCE_THRESHOLD = 70` gate. `assessWorkEligibility` is deterministic except for a `freshness` label that legitimately drifts with wall-clock time.
3. **Persist report** — the full scored/deduped result set is written to `reports/global-remote/latest.json` (+ `.html`/`.ndjson`, temp-file + atomic rename — safe), overwritten wholesale every scan. **Never inserted into any SQL table.**
4. **Save** — a user-saved job snapshot-copies role/company/location/salary/verification/matchPercent into `workspace.db`'s `saved_jobs` table — the *only* durable, queryable record of a discovered vacancy, because step 3's report is wholesale-replaced every 4 hours.
5. **Prepare (unattended, 15s-interval tick)** — `runApplicationAttempt`: acquire the daemon's single global lease → ensure a full job description is present (on-demand fetch for Jobgether/Himalayas if missing; every other source either has one or structurally cannot) → tailor CV (AI) → draft cover letter (AI, grounded fact-selection, never free prose) → resolve a target policy for the canonical URL (today: none, for any real URL) → if no policy, stop at `needs_user` with a manual "open in browser" card; if a policy existed, generate a field-map (AI) and CDP-fill the real form.
6. **Review** — `ManualApplicationReviewCard` (the only card any real user sees) renders a swipe gesture and a "Continue on employer site" button; either path calls `window.open(canonicalUrl)`, intercepted by Electron's `setWindowOpenHandler` → `shell.openExternal`, opening the user's real OS browser. A separate "Mark applied" button self-reports completion (`outcome: 'user_reported'`), never machine-verified.
7. **Submit (automated path, currently unreachable for real sites)** — CAPTCHA pattern-matched and hard-refused; CDP method allowlist excludes `Runtime`/`Network`/`Fetch`; a crash during/after the submit click sets `submission_unknown`, never auto-retried; `submittingAttemptIds` fences concurrent submits for the same attempt.
8. **Retry/recovery** — a settled attempt is untouched by re-runs (real idempotency). An interrupted attempt is reset to `queued` and fully re-runs AI generation from scratch — not idempotent output-wise, and orphans the old PDF artifact files on disk (P2, below).

## 5. Major Findings (P0/P1, full list)

| # | Finding | Class | Evidence |
|---|---|---|---|
| F-A | Hard-timeout backstop (`withHardTimeout`) races the stuck promise instead of cancelling it; the abandoned `runApplicationAttempt` keeps the daemon's global lease forever, surviving both Electron and daemon restarts (`ApplicationQueueStore#loadSnapshot` reloads a stale lease verbatim; `acquireNextLease()` returns `null` forever, indistinguishable from "queue empty"). A naive fix (force-release the lease on timeout) reopens concurrent-write/checkpoint-flapping/duplicate-artifact hazards, confirmed unsafe by adversarial review — needs a fencing token, not just a release. | **P0** | `main.ts:2127-2179`; `application-queue-store.ts:160-172,273-286,295-306`; adversarially confirmed both ways |
| F-B | Duplicate-application race: the in-progress concurrency guard matches on raw `vacancyKey`/`canonicalUrl` string equality; the completed-attempt guard matches on normalized requisition identity (`deriveApplicationIdentity`) but only checks *completed* attempts. A re-discovered posting (different board, different tracking params) can spawn a second live attempt for a job already mid-preparation, with nothing downstream keyed by vacancy identity to stop both from reaching submission. Adversarial review: fix the identity comparison only — do not merge the two checkpoint scopes, which would silently widen the `force` bypass into completed-attempt territory. | **P0** | `repository.ts:853-880`; `application-identity.ts:4-8` (self-documents the exact gap it was built to close, but was never wired into this check) |
| F-C | `main.ts` (~2600 lines, all 3 tickers, `daemonFetch`) has zero test coverage of any kind — no test file exists, confirmed by two independent maintainer test-comment admissions ("importing it boots Electron, spawns the daemon sidecar, and opens two SQLite databases... a pre-existing architectural gap"). This is the exact code class that already caused one silent production incident (the daemonFetch-hang bug fixed this session) with no regression test protecting the fix. | **P0** | `agent-workspace-ipc.test.ts:24-34`; `ipc-sender-guard.test.ts:31`; grep-confirmed zero `daemonFetch` test references |
| F-D | Cross-origin iframe field-fill: DOM extraction pierces every iframe including cross-origin ones; "active" frame/form selection is by field count + geometry only, with no origin check against the target policy's authorized origin. A third-party widget (chat, cookie-consent, job-alert signup) embedded on a real careers page can legitimately win the field-count heuristic and receive typed candidate PII — including, on a `termsEligibleForAutomation` policy, with **no human in the loop**. | **P1** | `dom-extract.ts:242-245,207-224`; `executor.ts:219-270,232-239`; `cdp-allowlist.ts:42-44` (Input.* events fire real DOM events third-party widgets can read) |
| F-E | `workable_global` (the single highest-volume discovery source) structurally can never carry a job description — the RSS parser actively discards the field (`if (activeField.name !== 'description') ...`), and the compact persisted record shape has no slot for it. No detail-fetch exists. This is a permanent dead end, not a coverage gap. | **P1** | `workable-feed.ts:24-59,463` |
| F-F | Two sources (`job_remotely`, `jobspipe`) silently feed wrong data into the `description` field — a skills-list join and a seniority string, respectively — passing the "non-empty" gate and silently corrupting downstream AI-grounding prompts with plausible-looking wrong text. Worse than missing, since nothing flags it. | **P0** | `feed-discovery.ts:750-751`; `keyed-discovery.ts:313` |
| F-G | `workspace.db` (all CV text, contact info, cover letters, application answers, full job-posting text) is a plain unencrypted SQLite file with no explicit file-mode hardening, inconsistent with the daemon's own stores handling equivalent data (all explicitly `0700`/`0600`). | **P2** | `workspace/client.ts:19-28` vs. `discovery-file.ts:57,93`; `session-lineage-store.ts:603,815,1133-1134`; `attachment-store.ts:186,390`; `audit-store.ts:173`; `application-queue-store.ts:145,237` |
| F-H | Two independently-maintained state machines for one application attempt — `ApplicationAttemptCheckpoint` (12 states, `workspace.db`-owned) and `ApplicationQueueEntryState` (6 states, daemon-file-owned) — reconciled only by hand-written functions in one file, never documented as a pair anywhere in the repo. This is the root cause underlying F-A and contributes directly to onboarding cost. | **P1** | `application-pipeline.ts` (`queueStillWantsThis`, `SETTLED_CHECKPOINTS`, `IN_FLIGHT_CHECKPOINTS`); `workspace/types.ts:243-320` |
| F-I | `CvProfile` summary extraction (7 flat fields) and structured source-CV extraction are two independent, full LLM re-reads of the same raw CV text; the former's output is mechanically derivable from the latter. | **P1** | `prompts.ts:434` vs. `prompts.ts:560`; `CvDrawer.tsx:178,185` |
| F-J | Interactive cover-letter/motivation-letter generation (2 call sites) produces free-form prose with no fabrication guard, while the unattended cover-letter path already solved this with grounded fact-ID selection — the safer pattern exists and is tested, just not reused. | **P1** | `letters/prompt.ts:96` vs. `application-cover-letter.ts:93,127-149,203-206` |

## 6. Unnecessary Complexity

- **Dead code, confirmed zero callers**: `findCrossCompanyDuplicateGroups` (tuned, tested Jaccard-dedup algorithm, `reporting/cross-company-duplicates.ts`); `DETERMINISTIC_SCORING_VERSION` constant (`relevance.ts:12`); `target-policy.ts`'s `timeoutMs` field (declared, consumed nowhere in the executor, and set to a real-looking `60_000` in the one fixture policy — actively misleading); two pre-built detail-fetchers `fetchAiDevJobDetail`/`fetchRemooteJobDetail`, never called.
- **Duplicated implementations that should share code**: `ApplicationReviewSwipeCard.tsx` (283 lines, dormant) vs. `ManualApplicationReviewCard.tsx` (242 lines, the only one any real user sees) — ~35-40% structurally identical drag/card-shell logic, independently authored, no shared hook.
- **Duplicated scheduling patterns**: 3 tickers in `main.ts`, 3 different hand-rolled reentrancy mechanisms for the same "don't overlap" problem — one of the three (automatic-submission) has no hard-timeout guard at all, despite doing "real CDP round trips" per its own comment.
- **Small package that's really a policy module**: `vacancy-agent-adapter` — one dependency, sits entirely between the daemon and provider adapters `agent-runtime` already owns.

## 7. Reliability/Correctness Risks

Covered in depth in §5 (F-A, F-B, F-F) and §11's failure-mode trace. Two additional lower-severity items:
- **Orphaned PDF artifacts** on every retry of an interrupted tailoring stage — `restartApplicationTailoring` deletes DB rows but never the files on disk. Disk growth only, no correctness impact. **P2.**
- **Non-atomic multi-file report write**: `writeGlobalRemoteReport`'s `latest.json`/`.html`/`.ndjson` are renamed sequentially, not as one atomic group — a kill mid-loop can pair a stale file with a fresh one until the next scan overwrites it. Self-heals; the primary consumer (`latest.json`) is always fully old or fully new. **P3.**

## 8. AI & Agent Architecture Findings

13 LLM call sites, all in `apps/desktop`, zero in `vacancy-engine` (confirming the scoring/eligibility/dedup pipeline really is 100% deterministic, not just described that way). Shared `GROUNDING_RULES`/`buildGenerationInputBundle` infrastructure is genuinely well-reused, not bloat. Real gaps:
- F-I and F-J above (P1 each).
- **No reuse/caching** in interactive generation despite `isGeneratedArtifactCurrent`/`generationInputFingerprint` already existing and being used by the unattended path — re-generating a letter for the same vacancy re-runs a full daemon session every time. **P2.**
- **`Agent Workspace`** (row 13, full filesystem tool access under a lease) is a materially different trust class riding the same hardening path as every narrow CV/letter call — worth an explicit product decision on whether it's MVP-facing surface or upstream scaffolding that shouldn't be exposed yet. **P2, product decision.**
- Rows 1-3 (unattended pipeline) hardcode `provider: 'claude'` regardless of the user's configured default, because only Claude's adapter implements the `'no-network'` hardening profile Codex's own code comments admit it doesn't honor. Unconfirmed whether this override is disclosed in the settings UI. **P3, needs a UI check before deciding if it's a transparency gap.**

## 9. State/Database Findings

Full detail in §5 (F-H) and the target-state table in §16. Summary verdicts:
- **KEEP**: the two-SQLite-database split (real bounded-context boundary, zero cross-DB atomicity requirement found anywhere); the 28-key `vacancy-engine` env schema (every key traces to a real, currently-wired integration).
- **P1**: no durable, queryable store for discovery/report data (only a wholesale-overwritten JSON blob) — add a metadata-only `discovery_runs` table, don't rebuild the full report as relational data.
- **P2**: unbounded timestamped report file growth (no retention, unlike the codebase's own `HTTP_CACHE_RETENTION_DAYS` precedent); `applications` forks `saved_jobs` fields at creation with no documented intent and no sync path (a later edit to a saved job silently stops being reflected in an already-created application).
- **P3**: `saved_jobs.arrangement` is the one snapshot field never auto-populated from discovery data; `application_attempts.prepared_fields` is the one hand-rolled JSON column in a file that otherwise standardizes on Drizzle's typed `mode:'json'`.

## 10. Testing Reality Check

The application-pipeline test suite (`application-pipeline.test.ts`) is genuinely deep — real SQLite, real CDP command-sequence assertions, real multi-checkpoint traversal, real restart-recovery tests. But it exercises a `FakeQueue`, never the real desktop-to-daemon HTTP transport (`daemonFetch`) where the actual production incident lived. **`main.ts` — where all 3 tickers, the in-flight flags, and `daemonFetch` itself all live — has no test file at all**, an architectural gap the maintainers' own test comments already admit ("importing it boots Electron, spawns the daemon sidecar, and opens two SQLite databases"). No existing test anywhere in the repo would have caught the daemonFetch-hang bug, and none exists today to catch a regression of the fix. This is F-C (§5), rated P0 specifically because it's the same code class that already failed once in production.

## 11. Security/Privacy Findings

Full detail: `SECURITY.md` is unusually thorough and its already-"Verified" claims (daemon bearer token lifecycle, CORS/CSRF posture, env-filtering for spawned CLIs) were spot-checked and held up exactly as documented. New findings from this audit:
- **F-D (§5, P1)**: cross-origin iframe field-fill has no origin check — the one realistic PII-exfiltration path found, sharpened by the fact it's reachable with zero human in the loop on an automated-eligible policy (though zero such policies exist today).
- **F-G (§5, P2)**: `workspace.db` unencrypted/unhardened relative to the daemon's own stores for equivalent data.
- **P3, no urgent action**: daemon stdout is logged verbatim to console with key-name-based (not content-based) secret redaction — no live leak found (81 log call sites checked, all metadata-only), but a structurally thinner guarantee than "never logs PII," worth flagging as a future-regression risk.
- **Confirmed sound, no findings**: daemon bearer-token lifecycle (crypto-random, `timingSafeEqual`, never crosses into the renderer); zero PII in any AI-prompt-adjacent log call; CDP surface correctly denies `Runtime`/`Network`/`Fetch`/`Storage` wholesale; CAPTCHA detection fails closed.

## 12. Dead/Legacy/Duplicate Code

See §6. Confirmed-dead, safe to delete outright: `findCrossCompanyDuplicateGroups` + its barrel export (keep its test only if repurposed); `DETERMINISTIC_SCORING_VERSION`; `target-policy.ts`'s `timeoutMs` field (either wire it into the executor's real timeout paths or remove it — leaving it is actively misleading); `fetchAiDevJobDetail`/`fetchRemooteJobDetail` (confirm truly unreferenced before deleting, then delete).

## 13. What I Would Keep

- The two-SQLite-database split — real domain boundary, no cross-DB atomicity need found.
- The daemon-as-separate-process boundary — its documented security rationale (main/renderer secrecy) doesn't strictly require an OS-process boundary, but the Windows process-tree-kill-on-cancel mechanism (`taskkill /T /F`) and the `@agent-dock/daemon` package's standalone, zero-Electron-dependency reusability are real, load-bearing properties an in-process rewrite would have to re-derive, not gain for free. Keep it; write down why (§16).
- The single global daemon lease — confirmed by adversarial review to be **more** load-bearing than either proposal credited it: it is the *only* thing preventing two concurrent preparation runs for the same attempt today. Any future move to per-attempt leasing needs an explicit replacement mutex, not a removal.
- Deterministic (non-AI) scoring, eligibility, and salary logic in `vacancy-engine` — zero network, zero randomness, fully idempotent, confirmed by direct grep.
- Not merging the 3 unattended AI calls (field-map/tailoring/cover-letter) — each has genuinely different failure semantics (asymmetric retry, non-fatal letter failure) that a merged call would have to reimplement or regress.
- The grounded fact-ID cover-letter pattern in the unattended path — this is the safety pattern the interactive paths should adopt, not replace.

## 14. What I Would Delete

- `findCrossCompanyDuplicateGroups`, `DETERMINISTIC_SCORING_VERSION`, `target-policy.ts`'s dead `timeoutMs` field, the two unwired detail-fetchers (§12).
- **Not** `ApplicationReviewSwipeCard.tsx` — see §15; feature-flag it instead. This reverses the first-pass recommendation from one challenge agent after adversarial review found the delete-it proposal would also delete its regression coverage for the shared review-flow contract, right when that coverage is most valuable (reactivation).

## 15. What I Would Simplify

- **Collapse the two state machines (F-H) toward one source of truth.** Either make the daemon's queue store hold nothing but a lease pointer (attempt id + lease id + expiry) and read/write everything else directly against `workspace.db`'s checkpoint through the existing client SDK, or — if the daemon must stay database-agnostic — publish one explicit checkpoint × queue-state → allowed-next-state table as a single exported map, replacing the four separately-named constant arrays that currently approximate it by hand. This is the single highest-leverage simplification in the whole audit: it directly removes the root cause of F-A (the lease/checkpoint desync) and F-C's hardest-to-test surface.
- **Unify the 3 hand-rolled tickers** into one `createTick({ intervalMs, hardTimeoutMs?, run, label })` helper, instantiated 3 times. Makes the exact bug class that already hit production (a hang that permanently flips an in-flight flag) unit-testable with a fake clock and a controllable never-resolving `run`. Closes the gap that the automatic-submission ticker currently has no hard-timeout guard at all.
- **Fold `vacancy-agent-adapter` into `agent-runtime`** — one dependency, sits entirely between two subsystems `agent-runtime` already owns. Removes one package.json/tsconfig pair from the dependency graph.
- **Feature-flag auto-apply off for MVP** (the user's own proposed scope): (1) a flag that hard-forces "no real site is ever auto-submit-eligible" regardless of the (currently empty) policy list, and (2) route `ApplicationReviewSwipeCard`'s render path to `ManualApplicationReviewCard` at the flag level rather than deleting the component — keep its test suite running against the shared `FormReadiness`/`FormSnapshot` contract so a future reactivation starts from passing tests, not from git history.
- **Derive `CvProfile`'s 7 summary fields deterministically** from the already-parsed structured source CV once one exists, keeping the LLM call only as a fallback for candidates without a source CV yet (F-I).
- **Port the grounded fact-selection pattern** from the unattended cover-letter path into the two interactive letter-generation call sites (F-J).

## 16. Proposed Target Architecture

No new runtime services, no new processes, no new databases. The target is the current architecture with its seams tightened:

```
Electron main process
 ├─ workspace.db (unchanged) — gains: discovery_runs metadata table (in vacancy-engine.db, see below),
 │    3 new saved_jobs salary columns, prepared_fields converted to mode:'json'
 ├─ vacancy-engine.db (unchanged) — gains: discovery_runs table (metadata only, one row per scan)
 ├─ 1 shared createTick() helper, instantiated 3x (replaces 3 hand-rolled patterns)
 ├─ CDP field-fill gains an origin check on the "active" frame (F-D fix)
 └─ spawn(...) ──► Daemon (unchanged process boundary — see §13)
       ├─ ApplicationQueueStore: reconciles/clears a stale lease on startup (paired fix for F-A);
       │    optionally reduced to a lease-pointer-only store once the checkpoint/queue-state
       │    tables are unified (§15) — sequencing note: startup reconciliation must land
       │    before any auto-respawn feature, or auto-respawn converts a loud outage into a
       │    silent one (adversarial-review finding)
       └─ createApplicationAttempt's in-progress guard uses deriveApplicationIdentity
            (normalized identity) instead of raw vacancyKey/canonicalUrl equality (F-B fix,
            bypass scopes for force/reapply left exactly as they are today)
```

**Package count**: 8 → 7 (`vacancy-agent-adapter` folded into `agent-runtime`).
**Two-database split**: unchanged, but its rationale gets written down in `docs/architecture.md` so a new engineer doesn't have to infer it from a README line.
**Daemon-as-separate-process**: unchanged, with an ADR written explaining the 3 real load-bearing reasons (process-tree-kill-on-cancel, potential upstream/multi-frontend reuse, half-realized crash isolation that should be completed with respawn — sequenced after the stale-lease fix).

## 17. Current vs. Proposed Complexity Scorecard

| Dimension | Current | Proposed | Change |
|---|---|---|---|
| Runtime services/processes | 2 (Electron main, daemon) + on-demand CLI grandchildren | 2 (unchanged) | No reduction — justified KEEP, not unexamined legacy |
| Pipeline stages (checkpoints) | 12 attempt checkpoints + 6 queue states, reconciled by 4 hand-written constant arrays in 1 file | 12 attempt checkpoints, queue reduced to a lease pointer (or explicit transition table if kept separate) | 2 independently-owned state machines → 1 authoritative source of truth |
| LLM calls per unattended application | 3 (field-map, tailoring, cover letter) | 3 (unchanged — merging was evaluated and rejected) | 0 |
| LLM calls, whole app (13 sites) | 13, incl. 1 redundant CV-parse pass (row 7 duplicates row 8) | 12 effective (row 7 becomes a fallback-only path) | -1 redundant call class |
| Major abstractions (packages) | 8 | 7 (`vacancy-agent-adapter` folded into `agent-runtime`) | -1 |
| State transitions, sources of truth for "what is this application doing" | 2 (workspace.db checkpoint, daemon queue.json state), hand-reconciled | 1 authoritative (workspace.db checkpoint) | 2 → 1 |
| External dependencies | 7 discovery-source API keys + 2 AI provider CLIs, all confirmed wired to real features | Unchanged | 0 — no dead integrations found |
| Configuration surface | 28-key vacancy-engine env schema (all wired) + 1 dead field (`target-policy.ts`'s `timeoutMs`) | 28 keys + 0 dead fields | -1 dead config key |
| Known live failure points (P0/P1) | 6 (F-A, F-B, F-D, F-E, F-F, F-H) | 0 open, after the fixes in §19 land | -6 |
| Test complexity / coverage gap | `main.ts` (~2600 lines, all tick/timeout logic) has zero tests | `createTick()` extracted, unit-testable with a fake clock; hang-simulation regression test added | Closes the exact gap that already caused a production incident |

## 18. Migration Strategy

All proposed changes are additive or narrowly-scoped edits to existing code paths — nothing requires a data migration with real risk, and nothing requires a flag-day cutover:
1. **F-B fix** (identity comparison swap) is a single query-predicate change, reusing an already-tested function. No schema change, no migration.
2. **F-A fix** (fencing token + startup lease reconciliation) needs a new nullable column or in-memory generation counter on the attempt/lease pair — additive, no backfill required (a `NULL`/absent value means "no in-flight generation," which is the correct default for existing rows).
3. **`createTick()` extraction** (F-C, F-H's ticker half) is a behavior-preserving refactor — each tick's own interval/timeout constants move, unchanged, into the shared helper. Land it with the hang-simulation test as the same PR, or the extraction alone buys nothing.
4. **Feature-flag auto-apply off** touches only routing (`ApplicationReviewSession.tsx`) and the policy-resolution entry point — no schema change.
5. **`discovery_runs` table** (§9) is purely additive; no existing consumer needs to change to benefit from it.
6. **Sequencing constraint, not optional**: do not ship daemon auto-respawn-with-backoff before the stale-lease-on-startup reconciliation — adversarial review confirmed this ordering matters (respawn-without-reconciliation converts a loud, diagnosable "daemon unavailable" outage into a silent, permanent, self-reinforcing one).
7. **Before deleting or flagging `ApplicationReviewSwipeCard`**: grep `e2e/fixtures/` for imports first (two agents flagged this as unverified) — if e2e coverage depends on it, keep both the component and its test running regardless of the flag.

## 19. Prioritized Implementation Plan

| Priority | Item | Depends on |
|---|---|---|
| P0 | F-B: swap in-progress duplicate-attempt guard to normalized identity (`deriveApplicationIdentity`), bypass scopes unchanged | — |
| P0 | F-F: fix `job_remotely`/`jobspipe` description mislabeling (map to `null` instead of wrong field) | — |
| P0 | F-C + F-H (ticker half): extract `createTick()`, write the hang-simulation regression test | — |
| P0 | F-A: add a fencing/generation token so an abandoned hard-timed-out run's late writes are detected and discarded, not applied | `createTick()` extraction (same code path) |
| P0 | F-A (paired): daemon startup reconciles/clears a stale lease | Should land before or with the F-A fencing fix |
| P1 | F-D: origin check on CDP "active frame" resolution before any field is filled | — |
| P1 | F-E: `workable_global` — accept the structural dead end for now; either give it a per-listing detail-fetch (real engineering cost) or document it as permanent | Product decision on the cost/benefit |
| P1 | F-H (state-machine half): unify the two checkpoint/queue-state models into one source of truth | `createTick()` work, F-A fencing |
| P1 | F-I: derive `CvProfile` fields deterministically from the structured source CV | — |
| P1 | F-J: port grounded fact-selection into interactive letter generation | — |
| P2 | `discovery_runs` metadata table | — |
| P2 | Auto-respawn the daemon with backoff | **Must follow** the F-A stale-lease reconciliation fix |
| P2 | Report file retention job | Ideally after `discovery_runs` (can key off it) |
| P2 | `workspace.db` file-mode hardening (0700/0600) | — |
| P2 | `applications`/`saved_jobs` sync — product decision, then implement | Product decision |
| P2 | Fold `vacancy-agent-adapter` into `agent-runtime` | — |
| P3 | `saved_jobs.arrangement` auto-populate; `prepared_fields` → `mode:'json'`; dead-code deletions (§12); DX doc fixes (Node version, missing DEVELOPMENT.md row, wire vacancy-engine CLI) | — |

## 20. Questions/Decisions Requiring Product Input

1. **Auto-apply for MVP**: confirmed direction from this conversation is "flag it off, not delete it" — this audit's adversarial review independently arrived at the same conclusion for `ApplicationReviewSwipeCard` specifically (keep + flag, for its test coverage). Needs your explicit sign-off on scope: (a) hard-force no real site is ever auto-submit-eligible, (b) route the swipe-card component off at the flag level.
2. **`workable_global`'s missing description**: is a real per-listing detail-fetch (engineering cost, ongoing maintenance against a source you don't control) worth building for your single highest-volume source, or is "permanently stuck at `needs_user` for this source" acceptable?
3. **Daemon-as-separate-process**: is the standalone/upstream-reuse goal (`@agent-dock/daemon` consumed by another frontend or the upstream fork) active today, or aspirational? This determines whether the process boundary is earning its keep or is unexamined inherited complexity — needs a written ADR either way.
4. **`applications`/`saved_jobs` field fork**: should an application's role/company/location/verification stay frozen at creation time (like `application_attempts`' CV/JD hashes, which have documented intent), or should they re-derive from the live `saved_jobs` row? Currently unowned behavior — pick one and document it.
5. **Agent Workspace (row 13, full filesystem tool access)**: is this shipping as user-facing MVP product surface, or is it upstream scaffolding that shouldn't be exposed in this product's UI yet?
6. **Provider hardcoding for the unattended pipeline** (always Claude, regardless of user's configured default): is this disclosed to the user today? If not, is silently overriding their choice acceptable, or does it need UI messaging?

---

## If I Owned This Codebase Starting Today

In exact order, highest leverage first:

1. **Fix F-B (duplicate-attempt identity check) and F-F (mislabeled descriptions) first.** Both are single-file, single-predicate changes reusing code that already exists and is already tested. Lowest risk, closes two silent-corruption-class bugs, ships this week.
2. **Extract `createTick()` and write the hang-simulation regression test before touching anything else in `main.ts`.** This is the change that makes every subsequent fix in this list safely testable, and it directly targets the exact code class that already caused a real production incident this session.
3. **Add the fencing/generation token for F-A, paired with the startup stale-lease reconciliation.** Do these together, in that dependency order — landing either alone re-opens or fails to close the hazard (confirmed by adversarial review both directions).
4. **Ship the auto-apply-off flag** (product-confirmed direction), routing `ApplicationReviewSwipeCard` off at the flag level, not deleting it — preserves its regression coverage for whenever automation is revisited.
5. **Fix F-D (cross-origin iframe origin check)** — it's the one realistic PII path this audit found, and it's cheapest to close before any real target policy ever goes live, not after.
6. **Unify the two checkpoint/queue-state machines into one source of truth.** This is the deepest fix on the list and the one most likely to prevent the *next* version of F-A/F-B from appearing in a different form — do it once #2-3 have proven the tick/lease code is well-tested, not before.
7. **Derive `CvProfile` deterministically (F-I) and port grounded fact-selection into interactive letters (F-J).** Both remove real LLM-call classes or real fabrication risk with no product-visible regression.
8. **Decide and close the 6 product questions in §20** — none of them block the engineering work above, but F-E and #3 (daemon ADR) in particular gate whether further investment in those areas is worth it.
9. **Small cleanups** (§12 dead code, `vacancy-agent-adapter` fold-in, DX doc fixes) — do these opportunistically alongside the above, not as a dedicated pass; none are urgent enough to justify a standalone sprint.

## First Implementation Batch

The smallest coherent batch that closes real risk without destabilizing Search→Apply, all independently landable, all reusing existing tested code:

1. F-B fix (identity-check swap)
2. F-F fix (description mislabeling)
3. `createTick()` extraction + hang-simulation test (no behavior change, pure testability)
4. F-A fencing token + startup lease reconciliation (the two must ship together)

Explicitly **excluded** from this first batch: the state-machine unification (§15/§19 P1 — real but larger, do after #3 above has proven out), the auto-apply feature flag (product-confirmed but UI-facing, sequence as its own PR so it's easy to revert independently), and every P2/P3 item (real but not urgent, and none of them touch the failure modes that already happened in production).
