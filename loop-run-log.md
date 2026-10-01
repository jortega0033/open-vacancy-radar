# Loop Run Log: Open Vacancy Radar

Append one JSON object per authorized run. Prune entries older than 30 days.

## Format

```json
{
  "run_id": "2026-08-30T08:15:00Z",
  "pattern": "daily-triage",
  "duration_s": 45,
  "items_found": 4,
  "actions_taken": 0,
  "escalations": 0,
  "tokens_estimate": 52000,
  "outcome": "report-only | escalated | no-op"
}
```

## Recent runs

<!-- Append below this line. -->

```json
{"run_id":"2026-09-11T08:52:00Z","pattern":"research-accounting-reset","accounting_epoch":"substantive-research-v2","tokens_estimate":0,"previous_epoch_estimate":105500,"estimate_basis":"User-authorized accounting correction. Earlier estimates mixed substantive work with repeated bookkeeping and inherited-context recovery, so they are retained as historical, non-metered data and excluded from the new epoch.","substantive_epoch_usage":0,"outcome":"budget-policy-reset","next_question":"Cycle 2 R02"}
```

```json
{"run_id":"2026-09-11T09:40:28Z","pattern":"hourly-ovr-application-research","accounting_epoch":"substantive-research-v2","tokens_estimate":6000,"rolling_24h_epoch_tokens_estimate":6000,"estimate_basis":"Bounded source, issue and verification work only; no repeated full state dump or inherited context counted. Estimate, not provider-metered.","items_found":2,"issues_created":0,"issues_commented":[272,273],"comment_ids":[5632539470,5632540231],"worker_model":null,"worker_scope":"No worker needed; direct trace was bounded and conclusive.","upstream_commit":"15f95dbdbf0e9319b1d38f69dc831ad944e7ae1b","outcome":"authorized-evidence-comments-published","next_question":"Cycle 3 R03/R05: source CV preservation, pinned projects and shared document fixture matrix","verification":"Read back both issue comments. No source edits, tests, applications, spreadsheet actions, pushes or PR mutations."}
```

```json
{
  "run_id": "2026-09-10T22:55:35Z",
  "pattern": "hourly-ovr-application-research",
  "duration_s": null,
  "items_found": 10,
  "actions_taken": 0,
  "state_updates": 2,
  "escalations": 0,
  "tokens_estimate": 45000,
  "estimate_basis": "Conservative estimate of incremental initial audit work including the delegated worker; not provider-metered. Inherited conversation replay is excluded and can add cost. Duration was not measured.",
  "coordinator_model": "gpt-6-astra",
  "worker_model": "gpt-5.6-luna",
  "worker_scope": "Read-only discovery, canonical URLs, deduplication, coverage and eligibility",
  "worker_id": "01a08d80-f60e-7542-836e-f642ec3bd536",
  "upstream_commit": "f30c195882580d3346a1e79ab5854682d296a3f4",
  "local_commit": "00657e7bf7e77c097df8f04cfb86d2cc46e1cf6f",
  "final_observed_commit": "c5e88fa55e0fde16c408c45d36072dce950000a2",
  "concurrent_change": "Another process advanced HEAD/origin/master; reviewed progressive-streaming delta and preserved it.",
  "automation_id": "ovr-application-research",
  "outcome": "report-only",
  "next_question": "R01/R04: design receipt observation, reconciliation and intentional reapply behavior",
  "verification": "Static source and live GitHub metadata checked. No tests or live applications executed. Existing Search changes preserved."
}
```

```json
{
  "run_id": "2026-09-10T23:18:24Z",
  "pattern": "user-requested-research-ticket-publication",
  "duration_s": null,
  "items_found": 0,
  "issues_created": 15,
  "tracker_issue": 270,
  "child_issues": [271, 272, 273, 274, 275, 276, 277, 278, 279, 280, 281, 282, 283, 284],
  "tokens_estimate": 22000,
  "estimate_basis": "Estimate of incremental ticket preparation, overlap review and publication; not provider-metered and excludes inherited conversation replay.",
  "worker_model": "gpt-5.6-luna",
  "worker_scope": "Read-only overlap review of five existing issues",
  "worker_id": "01a08d97-97e2-7d73-839e-a284db14c068",
  "outcome": "authorized-tickets-published",
  "automation_id": "ovr-application-research",
  "automation_change": "Hourly cadence and model routing preserved; current/future issue creation and evidence updates explicitly authorized.",
  "verification": "Read back all 15 public issues and matched expected titles/bodies. No product-source edits, pushes, PR mutations or real applications."
}
```

```json
{
  "run_id": "2026-09-10T23:56:20Z",
  "finished_at": "2026-09-11T00:04:41Z",
  "pattern": "hourly-ovr-application-research",
  "duration_s": 501,
  "items_found": 2,
  "issues_created": 0,
  "issues_commented": [271, 275],
  "comment_ids": [5627215940, 5627187598],
  "tokens_estimate": 16000,
  "rolling_24h_tokens_estimate": 83000,
  "estimate_basis": "Conservative incremental estimate including bounded worker, context recovery and source/readback work; not provider-metered. Excludes inherited conversation replay. Routine 6000 target exceeded; 80 percent throttle applies after this run.",
  "worker_model": "gpt-5.6-luna",
  "worker_scope": "Read-only receipt and crash-boundary evidence; timeboxed final, then closed",
  "worker_id": "01a08dc3-cb3f-7ba3-b3ef-8f26a7fb2846",
  "upstream_commit": "8cc9145b6a29ce8d597259799e11c59ef3796cac",
  "outcome": "authorized-evidence-comments-published",
  "next_question": "Cycle 2 R02: missing production links, reviewed target prerequisites, integration acceptance map",
  "next_run_mode": "Recalculate budget; report-only and no subagents while >=80 percent; stop at 100 percent",
  "verification": "Checked immutable source, issue overlap and recent PRs; read back both comments. No product-source edits, tests, pushes, PR mutations, sheet edits or applications. Existing unrelated changes preserved."
}
```

```json
{
  "run_id": "2026-09-11T00:58:21Z",
  "finished_at": "2026-09-11T01:00:04Z",
  "pattern": "hourly-ovr-application-research",
  "duration_s": 103,
  "items_found": 1,
  "issues_created": 0,
  "issues_commented": [],
  "tokens_estimate": 17000,
  "rolling_24h_tokens_estimate": 100000,
  "estimate_basis": "Conservative estimate of incremental instruction/state/source/metadata reads and reporting, not provider-metered; inherited conversation replay excluded. Repeated large reads exceeded the routine target. Cap reached: stop substantive work.",
  "worker_model": null,
  "worker_scope": "No worker: 80 percent throttle active at start",
  "upstream_commit": "69848dbe5880b75a9d98cfd240137b7bac8a9dd3",
  "outcome": "report-only-budget-stop",
  "next_question": "Cycle 2 R02 unchanged: finish production wiring and integration acceptance map; preserve deliberate target-policy restrictions",
  "next_run_mode": "Budget check only until rolling estimate is below cap; earliest recorded release 2026-09-11T22:55:35Z",
  "verification": "Read live commit, relevant issue metadata, recent PRs, immutable policy/runner source and compare patches. New git object absent locally; used read-only GitHub API. No source edits, tests, GitHub mutations, sheets or real applications."
}
```

```json
{"run_id":"2026-09-11T01:58:22Z","pattern":"hourly-budget-check","tokens_estimate":1500,"estimate_basis":"Incremental budget-check and bookkeeping estimate, not measured; excludes inherited context replay. No substantive work after cap.","rolling_24h_tokens_estimate":101500,"issues_created":0,"issues_commented":[],"subagents":0,"outcome":"budget-stop-no-research","next_question":"Cycle 2 R02 unchanged","next_budget_release_utc":"2026-09-11T22:55:35Z"}
```

```json
{"run_id":"2026-09-11T02:59:53Z","pattern":"hourly-budget-check","tokens_estimate":1000,"estimate_basis":"Incremental budget-check/bookkeeping estimate, not measured; inherited replay excluded.","rolling_24h_tokens_estimate":102500,"issues_created":0,"issues_commented":[],"subagents":0,"outcome":"budget-stop-no-research","next_question":"Cycle 2 R02 unchanged","next_budget_release_utc":"2026-09-11T22:55:35Z"}
```

```json
{"run_id":"2026-09-11T03:59:54Z","pattern":"hourly-budget-check","tokens_estimate":1000,"estimate_basis":"Incremental budget-check/bookkeeping estimate, not measured; inherited replay excluded.","rolling_24h_tokens_estimate":103500,"issues_created":0,"issues_commented":[],"subagents":0,"outcome":"budget-stop-no-research","next_question":"Cycle 2 R02 unchanged","next_budget_release_utc":"2026-09-11T22:55:35Z"}
```

```json
{"run_id":"2026-09-11T05:00:55Z","pattern":"hourly-budget-check","tokens_estimate":1000,"estimate_basis":"Incremental budget-check/bookkeeping estimate, not measured; inherited replay excluded.","rolling_24h_tokens_estimate":104500,"issues_created":0,"issues_commented":[],"subagents":0,"outcome":"budget-stop-no-research","next_question":"Cycle 2 R02 unchanged","next_budget_release_utc":"2026-09-11T22:55:35Z"}
```

```json
{"run_id":"2026-09-11T06:01:56Z","pattern":"hourly-budget-check","tokens_estimate":1000,"estimate_basis":"Incremental budget-check/bookkeeping estimate, not measured; inherited replay excluded.","rolling_24h_tokens_estimate":105500,"issues_created":0,"issues_commented":[],"subagents":0,"outcome":"budget-stop-no-research","next_question":"Cycle 2 R02 unchanged","next_budget_release_utc":"2026-09-11T22:55:35Z"}
```

```json
{"run_id":"2026-09-11T10:55:00Z","pattern":"user-directed-ovr-research","accounting_epoch":"substantive-research-v2","tokens_estimate":4500,"rolling_24h_epoch_tokens_estimate":10500,"estimate_basis":"Bounded upstream commit, source, test and issue verification for R03/R05; no worker, no source edits or repeated full audit.","items_found":2,"issues_created":0,"issues_commented":[],"upstream_commit":"c8b4ffd11355851f26e58051db0932e3a1aa709c","outcome":"resolved-upstream","next_question":"R01/R02/R04/R06 remaining application workflow integration and evidence gaps","verification":"Verified merged PRs #294 and #297, closed issues #274 and #276, structured-source/pinned-project tests, and real Electron document-acceptance E2E coverage. No product-source edits, tests, applications, sheets, pushes, PR, or GitHub mutations."}
```

```json
{"run_id":"2026-09-11T11:48:00Z","pattern":"hourly-ovr-application-research","accounting_epoch":"substantive-research-v2","tokens_estimate":3500,"rolling_24h_epoch_tokens_estimate":14000,"estimate_basis":"Bounded upstream commit, receipt implementation, and fixture-test inspection for R01/R04; no worker or repeated source audit.","items_found":2,"issues_created":0,"issues_commented":[],"upstream_commit":"172d3f069afececb2d63720750bc1c737b5d442c","outcome":"resolved-upstream","next_question":"R06 committed form-value and live-handoff evidence","verification":"Verified merged PR #302, closed issues #271 and #275, receipt observation semantics, delayed reconciliation, and identity-based duplicate tests. No product-source edits, test execution, applications, sheets, pushes, PR, or GitHub mutations."}
```

```json
{"run_id":"2026-09-11T12:49:00Z","pattern":"hourly-ovr-application-research","accounting_epoch":"substantive-research-v2","tokens_estimate":3000,"rolling_24h_epoch_tokens_estimate":17000,"estimate_basis":"Bounded upstream source, test, IPC and issue audit for R06; no worker or product-source edits.","items_found":1,"issues_created":0,"issues_commented":[277],"upstream_commit":"172d3f069afececb2d63720750bc1c737b5d442c","outcome":"scope-narrowed","next_question":"R02 complete production workflow wiring, then R06 committed form state and CSS-visible-frame acceptance","verification":"Verified current manual-handoff IPC wiring, attachment filename readback, fill/select behavior, form extraction limits, and fixture coverage. Commented on #277 to remove resolved handoff/upload claims. No product-source edits, test execution, applications, sheets, pushes, or PR changes."}
```

```json
{"run_id":"2026-09-11T14:52:00Z","pattern":"hourly-ovr-application-research","accounting_epoch":"substantive-research-v2","tokens_estimate":3500,"rolling_24h_epoch_tokens_estimate":20500,"estimate_basis":"Bounded live-upstream, PR metadata, changed-file and issue-status audit for R06; no worker or product-source edits.","items_found":1,"issues_created":0,"issues_commented":[],"upstream_commit":"545fb25c2f0df22b0c2749e7fbac331b994beaa9","outcome":"pending-upstream-review","next_question":"R06 merge and fixture verification for PR #304","verification":"Verified master advanced only with unrelated Linux E2E snapshot work, while open review-required PR #304 changes the form snapshot, AX readback, readiness, executor, active-form validation, live handoff and matching test suites. Issue #277 remains open. No source edits, test execution, applications, sheets, pushes, or PR mutations."}
```

```json
{"run_id":"2026-09-11T15:53:00Z","pattern":"hourly-ovr-application-research","accounting_epoch":"substantive-research-v2","tokens_estimate":2000,"rolling_24h_epoch_tokens_estimate":22500,"estimate_basis":"Bounded merged-PR, issue-status, and CI verification for R06; no worker or product-source edits.","items_found":1,"issues_created":0,"issues_commented":[],"upstream_commit":"76a7020c819b4ffc6dacfc934921f338e6176d5c","outcome":"resolved-upstream","next_question":"R02 merged pipeline and verified upload integration status","verification":"Verified PR #304 merged at f16f04d, issue #277 closed, and successful CI, CodeQL, Electron Playwright E2E, Windows test-suite, packaging and secret-scan checks. No source edits, test execution, applications, sheets, pushes, or PR mutations."}
```

```json
{"run_id":"2026-09-11T16:00:00Z","pattern":"user-directed-mvp-release-monitor-transition","accounting_epoch":"substantive-research-v2","tokens_estimate":3000,"rolling_24h_epoch_tokens_estimate":25500,"estimate_basis":"Bounded epic, issue-tranche, release/tag, automation and historic blocker audit; no worker or product-source edits.","items_found":1,"issues_created":0,"issues_commented":[],"upstream_commit":"76a7020c819b4ffc6dacfc934921f338e6176d5c","outcome":"monitor-transition","next_question":"MVP #39 release-day evidence and published artifact verification","verification":"Verified #271-#284 all closed, read #39 and its prior release evidence, confirmed no published GitHub release or tag, and updated the hourly monitor to the MVP release gate. No source edits, test execution, applications, sheets, pushes, PR, or GitHub issue mutations."}
```

```json
{"run_id":"2026-09-11T16:54:00Z","pattern":"hourly-mvp-release-monitor","accounting_epoch":"substantive-research-v2","tokens_estimate":3500,"rolling_24h_epoch_tokens_estimate":29000,"estimate_basis":"Bounded live epic, release-blocker, merged-PR and CI audit; no worker or product-source edits.","items_found":1,"issues_created":0,"issues_commented":[39],"upstream_commit":"b4e611847d4cea4fed657d04e728e4cb87e55285","outcome":"release-blocker-resolved-pending-resmoke","next_question":"Fresh clean-Windows smoke and published release artifact evidence","verification":"Verified #307 closed by merged PR #310, all reported CI/CodeQL/E2E/Windows packaging checks green, and #39 still requires a fresh installer smoke plus published artifact verification. Added factual release-gate update to #39. No source edits, test execution, applications, sheets, pushes, or PR mutations."}
```

```json
{"run_id":"2026-09-11T17:10:00Z","pattern":"user-feedback-installed-app-triage","accounting_epoch":"substantive-research-v2","tokens_estimate":7000,"rolling_24h_epoch_tokens_estimate":36000,"estimate_basis":"Targeted current-source, issue-overlap, pipeline and UX audit plus one bounded gpt-5.6-luna UX specialist; no product-source edits.","items_found":4,"issues_created":[311,312,313,314],"issues_commented":[154],"upstream_commit":"b4e611847d4cea4fed657d04e728e4cb87e55285","outcome":"four-actionable-followups","next_question":"Prioritize #314 and #312 for the next installed-app MVP smoke","verification":"Verified report-wide client transforms despite page-sized DOM, stale scan-derived profile warning, separate CV assistant upload state, one-way letter handoff, hidden attempts tab, and pipeline needs-user policy handoff. Confirmed #289 already addresses saved-job badge refresh. No source edits, test execution, applications, sheets, pushes, or PR mutations."}
```

```json
{"run_id":"2026-09-11T17:22:00Z","pattern":"user-directed-discovery-cost-control-triage","accounting_epoch":"substantive-research-v2","tokens_estimate":5000,"rolling_24h_epoch_tokens_estimate":41000,"estimate_basis":"Targeted current Search scan contract, issue-overlap audit, and one bounded gpt-5.6-luna UX specialist; no product-source edits.","items_found":1,"issues_created":[315],"issues_commented":[],"upstream_commit":"b4e611847d4cea4fed657d04e728e4cb87e55285","outcome":"new-discovery-guard-ticket","next_question":"Implement #315 before the next broad worldwide scan","verification":"Verified role query alone currently reaches worldwide discovery while country/source/date/employment filters are client-side. Created #315 with an upstream-effective signal gate, explicit capped Browse all override, completeness reporting, and background-scan safeguards. No source edits, test execution, applications, sheets, pushes, or PR mutations."}
```

```json
{"run_id":"2026-09-11T21:14:20Z","pattern":"hourly-mvp-release-monitor","accounting_epoch":"substantive-research-v2","tokens_estimate":1500,"rolling_24h_epoch_tokens_estimate":42500,"estimate_basis":"Bounded live epic, release, exact-head workflow, and follow-up issue-state check; no worker or product-source edits.","items_found":1,"issues_created":[],"issues_commented":[39],"upstream_commit":"77bfde3a44a9cb4f4a82821c99fadb874cfe1fef","outcome":"candidate-green-pending-human-release-evidence","next_question":"Clean-Windows core journey, persistence, uninstall, and published artifact verification for the latest candidate","verification":"Verified #311-#315 closed, PR #322 merged, five exact-head workflows green, no published GitHub release/tag, and no newer human smoke evidence on #39. Added and read back issue comment 5640715799. No source edits, tests, applications, sheets, pushes, or PR mutations."}
```
