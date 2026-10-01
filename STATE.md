# Loop State: Open Vacancy Radar

Last run: 2026-09-11T17:22:00Z (2026-09-11, Europe/Amsterdam)
Mode: L1 research with explicitly authorized GitHub ticket publishing; no product-source edits
Automation status: ACTIVE after the user's 2026-09-11 request to continue researching uncovered areas.
Kill switch: inactive
Budget accounting reset: 2026-09-11T08:52:00Z, epoch `substantive-research-v2`. The previous 105,500 estimate mixed substantive research with repeated context recovery and hourly bookkeeping. It remains in the log as historical, non-metered data but is not comparable to the new ledger. Future substantive runs have an 8,000 estimated-token ceiling and a 100,000 rolling-24-hour epoch cap. Budget-only/no-change checks count 0 and do not write state or log. Current epoch usage: 41,000 estimated tokens. Automation is ACTIVE after the user's resume request.

## High Priority

### Application-workflow tranche complete

Issues [#271 through #284](https://github.com/jortega0033/open-vacancy-radar/issues/271) are closed. The R01-R10 notes below are retained as implementation history, not an active research queue. The recurring monitor now follows [#39](https://github.com/jortega0033/open-vacancy-radar/issues/39), the public MVP release gate.

### MVP release gate

PR [#310](https://github.com/jortega0033/open-vacancy-radar/pull/310) resolved the large all-countries search freeze from the initial installed-app smoke test and passed CI, CodeQL, Electron E2E, Windows tests, packaging and secret scanning at `b4e6118`. The remaining release proof is operational: rerun the packaged-app core journey on the rebuilt NSIS installer, clean Windows first launch, restart persistence, uninstall/data-retention behavior, and published artifact download/checksum/install/launch/version verification. No GitHub release or tag was present in the checked repository state. Treat those as release-day evidence to attach to #39, not as claims to infer from CI.

Latest installer feedback produced four confirmed follow-ups: search-profile/re-score clarity [#311](https://github.com/jortega0033/open-vacancy-radar/issues/311), large-report responsiveness [#312](https://github.com/jortega0033/open-vacancy-radar/issues/312), CV Library and vacancy-context handoffs [#313](https://github.com/jortega0033/open-vacancy-radar/issues/313), and visible preparation outcomes [#314](https://github.com/jortega0033/open-vacancy-radar/issues/314). The saved-job badge fix is already covered by merged #289; retest it on the rebuilt installer before reopening.

Discovery cost control is now tracked in [#315](https://github.com/jortega0033/open-vacancy-radar/issues/315): an interactive worldwide scan needs an upstream-effective narrowing signal or an explicit, capped Browse all override. This is distinct from #312's client-side rendering scope.

### R01. Submission receipt semantics

**Resolved upstream:** PR [#302](https://github.com/jortega0033/open-vacancy-radar/pull/302), commit `172d3f0`, closed [#271](https://github.com/jortega0033/open-vacancy-radar/issues/271). A submit click is now followed by a bounded receipt observer. Only a new confirmation, receipt reference, or observed application identifier reaches `submitted`; visible form errors reach `needs_user`; lost or inconclusive outcomes reach `submission_unknown` and refuse a blind retry. Durable receipt rows record attempt, destination, timestamp, source, and evidence. Tests cover validation-error responses, confirmation pages, navigation loss, delayed receipt reconciliation, user reports, and error payloads behind successful HTTP responses. No follow-up ticket is warranted from this pass.

### R02. The application components do not form a live end-to-end workflow

Confirmed in upstream: `apps/desktop/electron/application-target-policies.ts:67` contains only a local fixture policy. `application-review-session.ts:103` always passes `ownedArtifactIds: []`, rejecting upload assignments. The low-level executor has an attach operation, but the application bridge does not resolve owned artifacts or invoke that path. `application-generation-runner.ts:37` and unattended staging have no production callers in the searched desktop/daemon tree; `src/components/applications/ApplicationReviewSwipeCard.tsx:113` documents the missing generation-to-fill path. The review card nevertheless labels the number of discovered fields as "filled" at line 106.

**Next:** trace and specify one complete review-mode path: selected job -> identified full JD -> versioned source profile/CV -> generated artifacts -> verified field map -> exact uploads -> visible review -> receipt. Reuse the existing components. Treat approved live-target coverage as a separate dependency. **Effort:** large overall, split into small integration changes.

Acceptance: a controlled ATS fixture exercises the production UI, generation adapter, staging, upload bridge and outcome store together; required fields and filenames are read back. Discovered fields never count as filled. The first live pilot must have an applicable reviewed target policy; do not turn the fixture into a wildcard policy. Closing an epic is not evidence of live capability.

### R03. Source-CV preservation and candidate project controls

**Resolved upstream:** PR [#294](https://github.com/jortega0033/open-vacancy-radar/pull/294), commit `d18400f`, closed [#274](https://github.com/jortega0033/open-vacancy-radar/issues/274). The reviewed source-CV model now carries contact facts, history, education, stable project records, engagement type/client distinction, candidate pins, and a configurable project count. Reconciliation restores pins and rejects unsupported model additions. The test suite covers long-source completeness, PDF/DOCX content preservation, direct-employment versus client engagement, and neutral no-cap defaults. No follow-up ticket is warranted from this pass.

### R04. Completed-application duplicate prevention

**Resolved upstream:** PR [#302](https://github.com/jortega0033/open-vacancy-radar/pull/302), commit `172d3f0`, closed [#275](https://github.com/jortega0033/open-vacancy-radar/issues/275). Completed attempts are now identified by ATS employer plus requisition where available, then canonical URL and vacancy fallbacks. `submitted`, `submission_unknown`, and `user_reported` evidence suppress a fresh ordinary attempt. An explicit reapply must name the predecessor, include a reason, and retain both CV hashes. The migration preserves existing rows and never collapses distinct requisitions at one employer. No follow-up ticket is warranted from this pass.

### R05. Document acceptance and PDF usability

**Resolved upstream:** PR [#297](https://github.com/jortega0033/open-vacancy-radar/pull/297), commit `fae8c3a`, closed [#276](https://github.com/jortega0033/open-vacancy-radar/issues/276). One acceptance contract now governs CVs and letters, checking readable text, blank pages, page bounds, clipping, overlapping runs, required content, usable links, identity, and target addressing. Real Electron `printToPDF` E2E coverage includes long titles, multi-page history, pinned projects, link annotations, and letters. Accepted hashes and targets are bound to readiness so changed or wrong-target bytes cannot be uploaded as verified. No follow-up ticket is warranted from this pass.

### R06. Form readiness and visible handoff need evidence

**Resolved upstream:** PR [#304](https://github.com/jortega0033/open-vacancy-radar/pull/304), merge commit `f16f04d`, closed [#277](https://github.com/jortega0033/open-vacancy-radar/issues/277). Form readiness now distinguishes discovered fields from verified committed values, identifies active rendered forms, reads back text/select/radio/attachment state, blocks on validation or stale page state, and presents a focusable live handoff. The merged PR's CI, CodeQL, Electron Playwright E2E, Windows suite and packaging checks all passed. No follow-up ticket is warranted from this pass.

Acceptance: duplicate hidden/visible frames select the visible form; filling the same email twice is idempotent; radio/select answers persist after blur; failed required fields prevent ready status. The handoff command shows and focuses the correct company/role and verifies visibility. Preserve CAPTCHA/login handoffs for the user; do not solve challenges or close them during unrelated tab cleanup. No claim that one browser universally succeeds more often without measurements on comparable forms.

## Watch List

### R07. Discovery needs consistent URL identity and eligibility evidence

The `gpt-5.6-luna` audit found direct-URL checks in newer adapters, shared retries, partial-source reporting, Workable canonical deduplication and existing semantic grouping. Main review confirmed `packages/vacancy-engine/src/global-remote/models.ts` still uses one `url` field for discovery results, `pipeline/global-remote.ts:77` gives Workable special canonical handling, and `crawler/http-client.ts:646` already implements retries. Preserve those capabilities.

**Next, medium effort:** separate attribution URL, canonical vacancy identity and application URL, with per-field provenance. Join the same employer/ATS requisition across sources before semantic fallback. Add logical request, actual attempt, retry and pagination-completion telemetry to source reports. A recovered 429 can still finish complete; record its retries without falsely classifying the scan as incomplete. Avoid arbitrary small batches: resume cursors until completion or a stated source/time budget, recording what remains.

Official review already has outside-US/NL eligibility states (`global-remote/evaluation.ts:114`); discovery also has a possible NL sponsor match. Extend this into explicit candidate-work-country, required-language, visa-sponsorship and EOR facts, each yes/no/unknown with scope and evidence. The smaller-model audit flags worldwide language enforcement for the next focused check. Unknown EOR or sponsorship must remain reviewable. Remote, global company presence, or IND registration alone does not prove this particular role's hiring eligibility. Separate compensation amount, currency, period, base/total and geographic applicability; do not treat US salary bands as an NL/EOR quote.

Acceptance: same requisition through two feeds deduplicates; different requisitions at one company survive. An inaccessible or unresolved direct URL is never proof of closure. Proven closed jobs retain history when archived. Explicit mandatory language/location restrictions affect eligibility; employer-policy uncertainty stays visible. Measure unresolved official URLs and missing work-country/EOR/sponsorship evidence by source from a real saved scan before adding more sources.

Overlap: #6/#257, #9/#258, #251/#264 and #139/#171 already cover source hardening, coverage telemetry, roster discovery and duplicate grouping. #183 is a refinement of existing grouping. #115 remains open although possible NL sponsor-match code exists; inspect the acceptance gap before claiming sponsorship lookup is wholly absent.

### R08. Complete JD and profile facts must reach every document

Interactive prompts use a 6,000-character JD limit; structured resume prompts use 60,000 and expose truncation detection. Attempts have `jdComplete`, but the reviewed submit gate does not check it, and creation defaults it to true. Trace the missing production orchestration before deciding where enforcement belongs. A byte/character limit alone cannot prove the original ATS description was fully captured.

Design a shared document input bundle: versioned base CV + private corrected contact profile + full JD + eligibility facts + answer preferences + selected projects + document kind. Cover/motivation letters need required-field prompts, language and length constraints, with EOR/relocation wording only when supported by the candidate's preferences and target. English unless the candidate requests another language; explicit mandatory-Dutch requirements are a configurable skip rule. A requirement discovered late in the JD must still affect eligibility and drafting. Employer sponsor registration is not a promise to sponsor this vacancy. EOR preference is not employer acceptance.

### R09. Optional mailbox evidence and sheet reconciliation

The inspected attempt contract has no dedicated receipt/evidence record, and no Gmail reconciliation path was found in the searched application modules. Start with a provider-neutral receipt interface. Optional Gmail access can look for a matching application acknowledgement using recipient, employer/ATS tenant, role/requisition and time window. A rejection may prove receipt, but it is also a separate hiring outcome. An old acknowledgement or a different role at the same company must not confirm the current attempt. Absence of email is not proof of failure. Use manual receipt import/user reports when no mailbox connector is available.

Search by message and read enough of a candidate receipt to establish identity. Keep inbox data local/minimal and outside prompts/logs by default. The existing ChatGPT Gmail connection is not automatically an OVR capability. Gmail read-only access requires its own authorized integration; do not request send/delete access for evidence reading. See the primary references below for scope and query limitations.

For optional sheet integration, store stable source sheet/tab/row IDs plus expected identity. Record an outcome durably before advancing; replay a failed sheet update idempotently and re-read the target before writing. Use mutually exclusive primary status buckets with evidence labels as separate dimensions. Report unique companies, unique vacancies and attempts separately; overlapping category counts must not be presented as a total success rate.

### R10. Route by task capability, then measured cost

OVR already accepts provider/model choices and upstream now has Codex live model catalog support (PR #262). Do not recreate a static model catalog. A catalog is not a workflow router. `apps/daemon/src/routes/application-generation.ts` currently accepts only Claude for its no-network field-map-generation contract, so a new router must respect that restriction until equivalent providers are implemented and tested.

Proposed routing: deterministic ATS fetch/normalization, identity comparison, rendering, hashing, field validation and state updates; small model for bounded extraction/classification; capable mid-tier model for grounded CV/letter drafting and ambiguous matching; frontier reasoning only for a named unresolved conflict or architecture/security review. Never delegate a submit decision to an LLM. Prefer cached validated output keyed by source-CV/profile/JD/workflow versions. At most one targeted retry before escalating the evidence problem; missing data needs retrieval or a handoff, not a more expensive guess. Measure latency, token use, validation pass rate and human corrections before claiming savings or model superiority.

## Recent Noise

Already present: direct ATS discovery, source-gap telemetry (#258), verified ATS roster seeding (#264), CV tailoring, letter generation/export, artifact/attempt schemas, queue infrastructure, isolated executor, automatic-mode guardrails and manual CV export (#269). Reuse them. #193 and its slices are closed, but current code still shows the R01/R02 integration gaps. Read issue comments: #154's original no-auto-submit stance was amended, and #193's daemon-owned-browser proposal was corrected to Electron-main ownership. Do not revive stale decisions from issue titles.

At the start, the local checkout had two pre-existing tracked Search changes and many ticket drafts, and was ten commits behind upstream. During research, another process advanced HEAD/origin/master to `c5e88fa55e0fde16c408c45d36072dce950000a2` and the Search changes ceased to be dirty. The inspected delta is progressive source-result streaming (#266); the application findings remain applicable. Treat streaming as shipped, not pending. This research performed no source checkout, pull, reversion, application submission, spreadsheet mutation or GitHub issue/PR mutation.

## Research Basis

- User request: 2026-09-11 local date, recurring hourly research to improve OVR using the application workflow's practical lessons, with efficient model delegation.
- Live GitHub master and local origin/master both verified at `f30c195882580d3346a1e79ab5854682d296a3f4`; local HEAD `00657e7bf7e77c097df8f04cfb86d2cc46e1cf6f`. File references above are to upstream, not the dirty checkout. For line-accurate source links use [the immutable source tree](https://github.com/jortega0033/open-vacancy-radar/tree/f30c195882580d3346a1e79ab5854682d296a3f4).
- Graph was tried first; newer application symbols were absent, so targeted `git show`/`git grep` of the verified upstream supplied evidence. Graph output alone is not current-source proof.
- Read the installed job-application-assistant skill and batch/sheet workflow references. Lessons came from user reports and recorded workflow corrections; individual employer outcomes were not independently re-audited in Gmail in this pass.
- Findings are static code research with proposed acceptance checks. No live employer submission or test-suite execution was needed or performed. A future implementation must reproduce these cases on controlled fixtures.
- [Application epic and amendments](https://github.com/jortega0033/open-vacancy-radar/issues/193), [automatic-mode amendment](https://github.com/jortega0033/open-vacancy-radar/issues/154#issuecomment-5546180608), [manual export PR](https://github.com/jortega0033/open-vacancy-radar/pull/269).

Primary implementation references checked this run:

- [Playwright input and file uploads](https://playwright.dev/docs/input#upload-files): native file-input assignment or a filechooser listener started before clicking. Prefer ordinary fill; sequential typing is for special keyboard handling. This is design evidence, not an instruction to replace OVR's existing CDP executor wholesale.
- [Electron PDF rendering](https://www.electronjs.org/docs/latest/api/web-contents#contentsprinttopdfoptions): reuse Electron's existing render path; printing success does not validate the artifact's completeness/layout.
- [Gmail filtering](https://developers.google.com/workspace/gmail/api/guides/filtering): message search supports queries, but metadata-only scope cannot use the q parameter, and API searches differ from Gmail UI behavior.
- [Gmail scopes](https://developers.google.com/workspace/gmail/api/auth/scopes): read-only and metadata are distinct restricted scopes. Select only what receipt verification actually requires. The sync-guide fetch timed out; synchronization behavior is not asserted from that failed fetch.

## Hourly Research Contract

Automation: `ovr-application-research`, active after the user's 2026-09-11 resume request. Hourly schedule retained. The separate Relocation URL discovery automation remains paused. Next research cursor: cycle 3, R03/R05.

Budget policy superseded by epoch `substantive-research-v2` above. Do not carry prior estimates into its cap. A substantive run must record `accounting_epoch: "substantive-research-v2"`, use at most 8,000 estimated tokens, and include only purposeful research, source inspection, worker work and ticket preparation. Do not count heartbeat delivery, no-op decisions, state-only confirmations or inherited context. No-op runs should not mutate the repository. At 80,000 epoch tokens, remain report-only without workers; at 100,000, stop substantive work until the rolling window drops below the cap.

This is research and design, with local state/report updates. On 2026-09-11 the user additionally instructed: "Now, turn these findings and future findings into GH tickets". This explicitly authorizes creating relevant GitHub issues, adding substantive evidence to matching issues, and maintaining tracker #270; it supersedes the earlier issue-publishing prohibition for this task only. Product source changes, PR creation/merging, pushes and real applications remain outside this recurring task. Do not automatically close or reopen existing issues. The user's explicit hourly cadence and request to route to capable models supersede the default twice-daily/no-subagent settings for this research task only. Keep the 100,000 estimated-token daily ceiling, the 80% no-subagent throttle, the kill switch, and the one-primary-specialist limit. This does not change other loops' defaults.

Read this state first. Compare the live repository revision and relevant issue/PR updates against the recorded baseline, then take one unresolved research question. Use one `gpt-5.6-luna` worker for a bounded routine audit. If a previous result leaves a concrete code/architecture conflict, choose `gpt-5.6-terra` for that next cycle. Use a frontier model only when that conflict remains beyond the smaller model's capability. Do not inherit a frontier model into every worker. Actual model names must be available in the runtime. The heartbeat coordinator inherits this task's model; worker routing does not change that scheduler setting.

Routine-run target: no more than 6,000 estimated incremental tokens, one narrow audit, compact output. This is a planning target, not a claim of metered enforcement. Record estimates separately from measured usage; at the daily ceiling stop substantive work, and before 80% avoid starting work likely to overrun the remainder. Skip a run if another run is active. A no-change run with no unresolved question exits without an agent. Notify only for a material new finding, completed research milestone, failure or required user action; keep no-op runs quiet. Never keep researching the same unchanged question merely to fill the hour.

Next cycles, in order:

1. R01/R04: receipt-state and same-vacancy reapply design, including delayed email and crash fixtures.
2. R02: exact missing production links, one reviewed target's capability prerequisites, and an integration acceptance map.
3. R03/R05: source-CV preservation, pinned-project contract and a shared CV/letter PDF fixture matrix.
4. R06: visible handoff, frame/control state and idempotent input behavior.
5. R07/R08: quantify direct-URL and eligibility-evidence gaps by source on a saved scan; verify worldwide mandatory-language handling.
6. R09/R10: optional receipt/sheet adapters and a capability-aware routing benchmark.

Move the cursor after a question is answered. Revisit an answered research question only for changed code, new evidence or a failed acceptance check. Merge into these IDs instead of duplicating tickets. Keep progress resumable across context resets. No personal contact details, inbox bodies or application documents belong in this report.

## Cycle 1 Follow-up

Checked upstream `8cc9145b6a29ce8d597259799e11c59ef3796cac`; latest change #285 concerns Search layout, and the inspected application files remain unchanged. Open/closed issue search and recent PR review found the same scopes already tracked by #271/#275. One bounded `gpt-5.6-luna` worker inspected receipt/crash boundaries; it was timeboxed and closed. No source changes or tests.

- R01: added [receipt/restart contract and fixture sequence](https://github.com/jortega0033/open-vacancy-radar/issues/271#issuecomment-5627215940). The current ambiguous-click test fails at DOM.getBoxModel, not after server acceptance. Preserve schedule clearing, observe before clicking, persist receipt and checkpoint atomically, and prevent late timeout updates from overwriting confirmation. Crash/restart and delayed receipt cases remain proposed tests, not proven runtime behavior.
- R04: added [mixed-identity guard gap and reapply history](https://github.com/jortega0033/open-vacancy-radar/issues/275#issuecomment-5627187598). repository.ts:515-525 chooses key or URL; the same URL with a newly supplied/different key bypasses the non-terminal lookup. Coordinate aliases with #278, retain explicit predecessor/reason/artifact versions, and bind late receipts to the original attempt.

Both comments read back and matched their intended content. Evidence fingerprints: `ovr-research:R01:cycle1:8cc9145b6a29ce8d597259799e11c59ef3796cac` and `ovr-research:R04:cycle1:8cc9145b6a29ce8d597259799e11c59ef3796cac`. No new tickets or tracker restructuring needed. Cycle 1's design question is answered; revisit only if implementation changes, evidence conflicts or a fixture fails. Next: R02 production wiring and reviewed-target prerequisites, subject to budget throttle.

## Cycle 2 Partial, Budget Stop

2026-09-11T01:00:04Z: upstream is `69848dbe5880b75a9d98cfd240137b7bac8a9dd3`. Live GitHub metadata shows #286 (manual ATS-roster import trigger), #287 (application count refresh and feed HTML decoding), and #288 (bounded worldwide sponsor lookup) merged. Do not file those as missing features. #272/#273 remain open with no update since publication. No subagent was spawned and no GitHub mutation was made while throttled.

Graph returned no matching orchestration symbols. The latest object is absent locally, so read-only GitHub contents/compare API supplied immutable source without fetching or changing the checkout. The changed main-process wiring concerns roster import; the reviewed ApplicationsPage changes refresh counts. The target-policy table and field-map generation runner remain unchanged.

R02 clarification for later ticket update: `application-target-policies.ts:13-24,67-88` deliberately permits only exact local fixtures. Its comments and `docs/application-target-evidence.md` record unresolved live-target review, not an accidental missing wildcard. These are repository policy observations, not a fresh legal assessment of vendor terms. Completing generation/upload wiring alone cannot make a live employer eligible. The integration acceptance map should first exercise the full controlled fixture path, with refusal for non-allowlisted targets. A later live pilot needs a named human review, exact host/navigation scope, per-action permissions, upload constraints, rate limits and kill switches. Do not broaden fixture authority or treat absent prohibition as approval.

The complete production-call/acceptance map was not finished before the budget stop. Keep cursor at cycle 2/R02. Pending evidence belongs in #272/#273 after the budget permits publication and a fresh overlap check. No tests or live applications executed. Existing dirty changes and ticket drafts preserved.

## Cycle 2 Follow-up

Checked master `15f95dbdbf0e9319b1d38f69dc831ad944e7ae1b` and the related open tickets. #298 has merged and closes #278 for discovery-level canonical identity, source URL and apply URL semantics. It does not change application attempts or the review session. No worker, source edit, test, live application or spreadsheet action occurred.

- R02a: [#272 follow-up](https://github.com/jortega0033/open-vacancy-radar/issues/272#issuecomment-5632539470) confirms the review UI runs `attempt -> policy resolution -> open snapshot/screenshot -> submit`. It never calls field-map generation/application, document staging or upload. Attempts still persist only `canonicalUrl`, and the review passes that URL to the browser, so the discovery-level apply URL must be snapshotted or explicitly handed off at attempt creation.
- R02b: [#273 follow-up](https://github.com/jortega0033/open-vacancy-radar/issues/273#issuecomment-5632540231) confirms staging stores artifacts by attempt but the fill bridge supplies `ownedArtifactIds: []` and applies only values/options. The integration needs main-process artifact resolution, target constraints, attach/readback evidence and fixture cases for stale/cross-attempt/replacement files.

Both comments were read back. Evidence fingerprints: `ovr-research:R02a:cycle2:15f95dbdbf0e9319b1d38f69dc831ad944e7ae1b` and `ovr-research:R02b:cycle2:15f95dbdbf0e9319b1d38f69dc831ad944e7ae1b`. Cycle 2 is answered; next cursor: cycle 3, R03/R05 source-CV preservation, pinned projects and shared document fixture matrix.

## Published Tickets

Tracker: [#270](https://github.com/jortega0033/open-vacancy-radar/issues/270). All 14 child issues and the tracker were read back after publication; titles and bodies match the intended content. Suggested priority and proposed acceptance checks are not claims of completed implementation or tests.

| Finding | Ticket | Scope |
| --- | --- | --- |
| R01 | [#271](https://github.com/jortega0033/open-vacancy-radar/issues/271) | Require a receipt before marking an application submitted |
| R02a | [#272](https://github.com/jortega0033/open-vacancy-radar/issues/272) | Connect the existing application stages into a complete review-mode flow |
| R02b | [#273](https://github.com/jortega0033/open-vacancy-radar/issues/273) | Resolve attempt-owned artifacts through the application upload bridge |
| R03 | [#274](https://github.com/jortega0033/open-vacancy-radar/issues/274) | Preserve source CV history, contacts and projects through tailoring and export |
| R04 | [#275](https://github.com/jortega0033/open-vacancy-radar/issues/275) | Prevent requeueing a submitted vacancy without an explicit reapply decision |
| R05 | [#276](https://github.com/jortega0033/open-vacancy-radar/issues/276) | Validate CV and letter PDF completeness and layout before readiness |
| R06 | [#277](https://github.com/jortega0033/open-vacancy-radar/issues/277) | Verify committed form values and show the live application handoff |
| R07a | [#278](https://github.com/jortega0033/open-vacancy-radar/issues/278) | Separate source and application URLs with cross-feed requisition identity |
| R07b | [#279](https://github.com/jortega0033/open-vacancy-radar/issues/279) | Report retry attempts and pagination completeness for discovery sources |
| R07c | [#280](https://github.com/jortega0033/open-vacancy-radar/issues/280) | Record work-country, language, visa and EOR eligibility evidence |
| R08 | [#281](https://github.com/jortega0033/open-vacancy-radar/issues/281) | Share complete versioned inputs across CV, cover and motivation letters |
| R09a | [#282](https://github.com/jortega0033/open-vacancy-radar/issues/282) | Design optional mailbox receipts for application reconciliation |
| R09b | [#283](https://github.com/jortega0033/open-vacancy-radar/issues/283) | Reconcile sheet statuses from durable application outcomes |
| R10 | [#284](https://github.com/jortega0033/open-vacancy-radar/issues/284) | Route application stages by model capability and measured cost |

Publication fingerprint for these findings: immutable source baseline `f30c195882580d3346a1e79ab5854682d296a3f4`, checked against `c5e88fa55e0fde16c408c45d36072dce950000a2`, marker `ovr-research:<finding-id>:2026-09-11`. R02, R07 and R09 were split into independent scopes. The upload bridge ticket links #129; candidate eligibility links #115; canonical identity links #183; model routing links #219/#164. These older issues are not replaced or reopened.

Before future publication, read this map, tracker #270, matching open/closed issues and active PRs. Add a comment only for genuinely new evidence on the same behavior; preserve others' edits and avoid repeated no-change comments. Create a new ticket only for an uncovered actionable finding or an explicitly scoped research question. Include exact source revision and links, observation versus inference, user impact, bounded scope, related work and acceptance checks. Use existing labels and keep private data out. Record the returned number/URL and evidence fingerprint here before advancing, then read back the issue. If a write times out, search for its marker/title before retrying. No hourly ticket quota.

---

Run log: `loop-run-log.md`

## MVP Gate Update, 2026-09-11 21:14Z

Master advanced to `77bfde3a44a9cb4f4a82821c99fadb874cfe1fef` through merged PR #322. Installed-app follow-ups #311-#314 and discovery guard #315 are closed. Exact-head CI, E2E, Windows Test Suite, Windows Packaging, and Secret scan runs passed. No GitHub release or tag is published, and issue #39 still has no clean-Windows core-journey, restart-persistence, uninstall/data-retention, or final artifact checksum/install/launch/version evidence for this candidate. Added and read back [the release-gate evidence comment](https://github.com/jortega0033/open-vacancy-radar/issues/39#issuecomment-5640715799). Next check: published release or new human smoke evidence against `77bfde3a44a9cb4f4a82821c99fadb874cfe1fef` or a later commit.
