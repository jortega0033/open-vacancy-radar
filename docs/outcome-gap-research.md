# Outcome and recurring-gap feedback: research result

Issue #693 (part of the #683 workflow roadmap). **This is a research deliverable.** It adds no table, event, screen, scorer, model call, schedule or setting to the product, and nothing here is a shipped feedback loop. The prototype lives under `apps/desktop/test/outcome-gap-research/`, is imported by nothing that ships (a test enforces that), and runs only on synthetic data.

## Verdict

1. **Do not ship automated calibration.** Not a score change, not a search-weight change, not a preference change, not a model. On the data this app records today, neither view can support an inference: there are too few matured sends, no query-variant attribution, no exposure denominator, no status-change time and mostly unassessed jobs (§3, §10).
2. **A read-only, person-reviewed aggregate is plausible, but only after two small instrumentation follow-ups** record what is missing (§13): dated, sourced outcome events (A) and search provenance carried into the saved job (B). Until both exist, the funnel's query-variant and lead-to-saved views stay `no_go` by construction.
3. **The recurring-requirements view needs less new data than the funnel** because requirement-level evidence classes already exist (`candidate_confirmed_gap` vs `unsupported`/`needs_verification`). Its limit is how many jobs the person has actually assessed and whether those assessments are comparable.
4. **The evidence-driven suggestions are complementary to manual review, not a replacement** (§11). They win at counting across many jobs; manual review wins on per-job detail and on anything that lives only in free text.

## What is in this PR

| Path | What |
| --- | --- |
| `docs/outcome-gap-research.md` | This design: key, contract, semantics, gates, results, follow-up contracts |
| `docs/research/outcome-gap/693-evaluation.json` | The checked-in evaluation output (raw counts, cases, failed/no-go cases, unknowns, limits) |
| `apps/desktop/test/outcome-gap-research/contract.ts` | Versioned observation contract, missing-data vocabulary, author-declared review gates |
| `…/requisition.ts` | Canonical requisition key v1, copy collapse, identity-risk accounting |
| `…/observations.ts` | Read-only adapter over the real repository, brief, overlay and interview-round readers |
| `…/funnel.ts` | View 1: funnel by source / query variant / role family |
| `…/requirements.ts` | View 2: recurring requirements in four lanes |
| `…/suggestions.ts` | Reviewable suggestions, dismissal reducer, withholding |
| `…/fixtures.ts`, `builders.ts`, `real-world.ts` | Synthetic portfolios with fixture-author expectations; a synthetic workspace written through the real writers |
| `…/evaluate.ts`, `evaluation.test.ts` | The reproducible evaluation; the test byte-compares a fresh run with the checked-in JSON |
| `…/*.test.ts` | Accounting, semantics, versions, isolation, dismissal, no-mutation, non-production guard |

Reproduce (from `apps/desktop`):

```
pnpm exec vitest run test/outcome-gap-research
# regenerate the checked-in evaluation after an intended change:
OVR_EVAL_OUT=../../docs/research/outcome-gap/693-evaluation.json pnpm exec vitest run test/outcome-gap-research/evaluation.test.ts
```

The run is hermetic and deterministic: fixed clock, no randomness, no network, no provider, no live site. Database-backed tests use a temporary migrated `workspace.db`.

## 1. How to read every number here

| Label | Meaning |
| --- | --- |
| **Executed** | The prototype functions ran on constructed inputs. The output is in `docs/research/outcome-gap/693-evaluation.json`. |
| **Source-read** | Established by reading current code at `master 29b69dd`, with a file reference. Not executed unless a test says so. |
| **Projected** | A field the contract would need but production does **not** record today (query attribution, dated status events, lead exposure). Results that use it describe the contract, not the app. |
| **Author-declared** | A threshold or an expected label written by the fixture author. Not statistically derived, not tuned on data, **not human validated**. |

There is no human study, no real job search, no time measurement and no provider or token telemetry in this PR, and none is claimed. Upstream `ai-job-search` references come from the ticket's pinned links ([outcome calibration](https://github.com/ai-job-search-dev/ai-job-search/blob/e16acee3abdaae57f8026789338a3c6eebf4608b/.claude/commands/outcome.md#L233), [aggregate gap reports](https://github.com/ai-job-search-dev/ai-job-search/blob/e16acee3abdaae57f8026789338a3c6eebf4608b/.claude/skills/upskill/SKILL.md#L54)); they were **not refetched** here and no upstream text or code is reused, so no MIT notice is carried. Their anecdotal outcomes are not treated as evidence about this app.

## 2. Existing owners reused (nothing new competes with them)

| Concern | Owner reused | How |
| --- | --- | --- |
| Sent evidence class | `classifySubmission` (#692), `apps/desktop/electron/application-actions-core.ts:444` | Same six classes; only `receipt_backed`, `user_reported`, `user_stated` count as sent |
| Requisition identity | `vacancyIdentityFor` (#278), `packages/vacancy-engine/src/vacancies/identity.ts:245`, stored as `application_briefs.identity_key` (#688, `apps/desktop/electron/workspace/schema.ts:947`) | The research key is that identity, namespaced (§4) |
| Per-requirement evidence | `cv_evidence_overlays.requirements` (`apps/desktop/electron/workspace/schema.ts:137`), `CvRequirementMapping.evidenceClass` | The only source of requirement-level lanes |
| Eligibility mismatch | `classifyEligibility`, `apps/desktop/electron/application-brief.ts:239` | Reused unchanged |
| Staleness of an assessment | `matchOverlay`, `apps/desktop/electron/application-brief.ts:446`, `BRIEF_WORKFLOW_VERSION`, `apps/desktop/electron/application-brief.ts:30` | Reused unchanged |
| Search provenance | `LeadQueryProvenance` (#686), `packages/vacancy-engine/src/global-remote/models.ts:381` | The shape follow-up B would copy |
| Role family | Scorer `primaryFit` in `profileMatch` (#367), `packages/vacancy-engine/src/filtering/relevance.ts:640` | Only when the job was scored |

No new scorer, package, queue, corpus or model was added. #412 (comparator) and #694 (role scope) are untouched.

## 3. What current records can answer today (Source-read, plus Executed on a real migrated database)

`workspace-contract.test.ts` writes a synthetic search through the app's own writers into a migrated database and reads it back. The matrix below is generated into the evaluation's `realContractLane.answerability`.

| Question | Today | Where / limit |
| --- | --- | --- |
| Distinct requisitions the person selected | **Answerable** | Briefs and aliases. Created when a job is saved (`apps/desktop/electron/main.ts:3490`) |
| Which saved copies are one requisition | **Answerable** | Brief aliases (`apps/desktop/electron/workspace/schema.ts:981`) |
| Which provider returned a copy | **Partial** | Alias `provider`; a hand-entered job has a link, no provider |
| **Which query variant found it** | **Not recorded** | `queryProvenance` (`packages/vacancy-engine/src/global-remote/models.ts:369`) exists on scan rows and in the report JSON only. `BriefSourceFacts` (`apps/desktop/electron/application-brief.ts:271`) and `saved_jobs` do not copy it. Reports are pruned after `REPORT_RETENTION_DAYS` (default 90, `packages/vacancy-engine/src/config.ts:28`). Test: `workspace-contract.test.ts` asserts no stored brief contains `queryProvenance`, `fetchedBy` or `planRevision` |
| Role family | **Partial** | `primaryFit` only for a scored job. Unscored stays unclassified, never inferred from the title |
| Was it sent, on what evidence | **Answerable** | `classifySubmission` over `applications` + `application_attempts` + receipts |
| When was it sent | **Partial** | `applied_at`/`submitted_at`; a hand-tracked "applied" can have no date |
| **What happened and when it changed** | **Partial** | `applications.status` is one mutable value (`apps/desktop/electron/workspace/schema.ts:279`). No change time, source or reason; no "checked, still no reply" record. Test: no `updated/changed/outcome/reason/history` column on the application record |
| Interviews held | **Answerable** | `application_interview_rounds` (#691) |
| Requirements and CV evidence | **Partial** | Only where "Compare with my CV" was run. The brief's summary lists are capped at `BRIEF_LIST_CAP = 5` (`apps/desktop/electron/application-brief.ts:51`), so the adapter reads overlays, not the brief |
| Was the posting text complete when assessed | **Answerable** | `cv_evidence_overlays.jd_complete` / `jd_confirmed_complete`. An assessment over a text known to be truncated and not confirmed complete is treated as `partial` and not pooled (`workspace-contract.test.ts`) |
| Person-recorded missing experience | **Answerable where assessed** | `candidate_confirmed_gap`, which only the person can set |
| Preference/eligibility mismatch | **Partial** | Scan eligibility answers; absent for a job with no scan facts |
| JD / CV / rule version of an assessment | **Partial** | Hashes only. `cv_documents` keeps no history, so compatibility is hash equality, not a diff |
| Profile / preference version a score was made under | **Partial** | The brief keeps `scoredPreferences` (grouped preferences) and `scoredBeforeProfileSave`, plus the scan `runId`/`generatedAt`; it does **not** keep the profile version string, so the contract's `profileVersion` reads `null` |
| Generation workflow version of an application | **Recorded, unused** | `application_attempts.workflow_version` names the preparation contract; the views do not compare on it because they do not read generated documents |
| **Leads shown but not selected** | **Not recorded** | The denominator for any "source/variant yield" is not stored |
| **Jobs the person dropped** | **Not recorded** | Deleting a saved job removes it (and an unreferenced brief): selection is survivorship-filtered |

The scorer's own "gaps" are **not** skill gaps. `scoreWorldwideVacancy` (`packages/vacancy-engine/src/filtering/relevance.ts:640`) emits "No explicit candidate skill match found", seniority, excluded role family, unmet mandatory language and salary notes. They compare a job to the person's stated profile; they never list a requirement the person lacks. They belong to the evaluator-opinion/preference lanes, not the missing-experience lane.

### Four identity surfaces, and a defect found

Requisition identity is expressed four ways today: the discovery row key (`saved_jobs.vacancy_key`), the engine identity (briefs), the attempt pair `employerKey` + `requisitionId` (`apps/desktop/electron/workspace/application-identity.ts:293`, #275) and the overlay key `vacancyKeyFor` (`apps/desktop/electron/workspace/cv-evidence-schema.ts:1281`). The adapter bridges them the way the brief service does (aliases, then `vacancyKeyFor` over every known URL). Two of them disagree in coverage: #275 recognises Workable, SmartRecruiters, Teamtailor and Workday posting URLs; #278 does not.

**Finding (not fixed here):** the engine's `isGenericListingUrl` tests `/^\/j\//` against the whole path (`packages/vacancy-engine/src/vacancies/identity.ts:209`), but a real Workable posting is `/<org>/j/<code>`. Such a posting is therefore classified as a generic listing and falls to the weak semantic tier. `requisition.test.ts` pins the observed behaviour. It is outside this research's scope and is reported as a separate small bug (§13).

## 4. Canonical requisition key v1

```
rk1:req:<engine requisition key>   strong  ATS tenant + the ATS's own requisition id
rk1:url:<canonical posting URL>    medium  a specific posting URL, no requisition id recognised
rk1:sem:<company :: title :: loc>  weak    text only
(none)                             none    nothing identifies the job; the row stands alone
```

Rules (each is a test in `requisition.test.ts` or `funnel.test.ts`):

- **Source of truth.** The key is the stored brief identity (`application_briefs.identity_key`/`identity_kind`) prefixed with `rk1:`. A job without a brief gets the same function computed from stored fields, marked `origin: derived_at_read`. The research does not invent a fifth algorithm.
- **Syndicated copies count once.** Same key ⇒ one requisition. The number collapsed is always reported (`copiesCollapsed`, `sourceRowsRead`) so the collapse is visible. Tracking parameters and host spelling variants collapse; verified for Greenhouse.
- **Distinct roles at one employer stay distinct.** The employer is never an identity. Two Greenhouse requisitions at one tenant are two keys.
- **Reapplication is one requisition, several attempts.** The funnel counts the requisition once, reports the extra sent rows (`reapplicationRows`) and takes the outcome of the **latest** sent application; the reapplication link comes from `supersedesAttemptId`.
- **Un-keyed rows are never merged** with each other.
- **Under-merge and over-merge are reported, not hidden.** Two different strong/medium keys that share company+title+location text are listed as `possibleUnderMerge`. The weak tier cannot tell two same-text roles apart (documented in the engine); the funnel therefore reports the weak-key share and refuses outcome views when it exceeds a gate.
- **A re-posted requisition with a new id is a new key.** It cannot be linked; this is a stated limit.

## 5. Data contract v0.1 (`contract.ts`)

A `JobObservation` is one requisition from one person's workspace:

| Field | Meaning | Production today |
| --- | --- | --- |
| `requisition: RequisitionKey` | key, tier, strength, origin | recorded (brief) or derived at read |
| `copies` | saved-job rows collapsed into it | derived |
| `contributions[]` | `{ provider, url, queryRefs, planRevision }` per source copy | provider/url recorded; **`queryRefs: 'not_recorded'`** |
| `selectedAt` | first selection time (`saved_jobs.saved_at`) | recorded for saved jobs only |
| `score` | `{ state: scored \| unscored \| stale, value \| null, roleFamily \| null }` | recorded when scored |
| `applications[]` | `{ submission, evidence, sentAt, status, statusHistory, heldRounds, reapplicationOf }` | recorded; **`statusHistory: 'current_value_only'`** |
| `assessment` | `{ state, requirements[], coverage }` | recorded only where assessed |
| `eligibility[]` | the brief's six answers, classified | recorded when scanned |
| `versions` | contract, profile, scored preferences, JD hash, CV hash, rule version, plan revision | partly recorded (hashes, rule version) |
| `availability` | per field: `recorded \| derived_at_read \| not_recorded \| projected_by_contract` | the adapter fills it |

**Projected only** (follow-ups A/B): `queryRefs` as an array (a copy of `LeadQueryProvenance`, by value) and `statusHistory.events[]` (`status`, `source: user_set | app_observed`, `occurredOn | null`, `recordedAt`). Any test or fixture that uses them is in the projected lane; the evaluation marks each portfolio `current_shape` or `projected_instrumentation`.

**Versioning.** `CONTRACT_VERSION = 0.1.0-research`, major 0: no compatibility promise. A future production contract bumps major when the meaning of a stored value changes, and a reader must **refuse, not coerce**, a value whose major it does not know. Minor additions are optional fields that default to "not recorded".

## 6. Missing-data semantics (one meaning each, never merged)

| Situation | Meaning | Never means |
| --- | --- | --- |
| Unscored (`profileScore: null`) | no score exists | zero fit; low fit |
| No assessment | not assessed (unknown) | no requirements; no gaps |
| Stale/partial assessment | not pooled; counted as not current | a confirmed gap |
| `unsupported` / `needs_verification` | no CV claim is permitted on current evidence | missing skill; missing ability |
| `candidate_confirmed_gap` | the **person** said they lack it | anything a model or a rejection inferred |
| `no_recorded_outcome` (sent, status still "applied") | nothing recorded | rejected; ineligible; delivery failed; "no response" as a fact |
| `rejected_recorded` | the person set "rejected" (no source, reason or date) | evidence of a missing requirement |
| Prepared / ready / handed off / unconfirmed | not sent | submitted |
| Held interview round, status never updated | a reply was recorded | an offer, or how the employer judged anything |
| Sent without a date | undated | mature; or immature |
| Exposure not recorded | no denominator | zero exposure |

## 7. Source and query attribution, and denominators

- A requisition seen through several sources/variants appears in **each** of those cells. Cells therefore **overlap by design**. Every table returns `distinctRequisitions`, `sumOfCells` and `overlap = sumOfCells − distinct`, and cells are never presented as a partition.
- No "first source wins" partition is offered: no contribution carries a first-seen time, so any such credit would be arbitrary.
- The query side distinguishes `fetched_upstream` (the source received that query) from `matched_locally` (the shared filter found it, and in `title` or `description`), exactly as #686 does.
- Only three one-way marginals (source, query variant, role family) are produced. The cross-product is not, because cells would be below the small-sample gate for any realistic personal search.
- Denominators per cell: `requisitions` (distinct), `withApplicationRow`, `sent`, then **mature** sent. Outcome counts are over mature sent only.

## 8. Windows, censoring, versions

- **Window.** Everything is as of an explicit `asOf`. A sent application is **mature** if `asOf − sentAt ≥ maturityDays`; younger ones are **censored** (reported, excluded from outcome denominators); undated ones are **undated** (reported, cannot be placed). `maturityDays` defaults to 28 and is a **view parameter with no empirical basis**: employers answer on very different scales and many never answer.
- **No imputation.** Rates are returned only as bounds: `lower = known / n`, `upper = (known + unknown) / n`, with `unknown` kept in `n`. A "rate among known outcomes" is shown only as a constructed comparison of what goes wrong (§11).
- **Time to reply is not computed.** Without status-change times it cannot be; the view reports the sufficiency verdict (`no_status_timestamps`) only.
- **Version classes.** Requirement evidence is pooled only within one class `assessmentWorkflow | reviewedCvHash`; a different CV makes "not shown on your CV" a different statement. The dominant class must be the rule version the reader understands (`application-brief-v1`). A dominant class that is old or unknown makes the whole view unusable (`version_incompatible_dominates`), which is intentionally conservative. Unknown versions are excluded and counted, never defaulted.
- **JD change.** An assessment made against a different JD hash is `stale` (via the real `matchOverlay`) and not pooled.
- **Preference change.** `scoredPreferences` is carried so a later reader can see which preferences a score was made under; the prototype does not rescore.

## 9. The two views

### View 1: funnel by source / query variant / role family (`funnel.ts`)

Stages use only recorded facts: selected → has an application row → **sent** (receipt-backed, user-reported or user-stated). Each cell reports sent-by-evidence-type so a person's own statement is never mixed into "receipt". Per-metric verdicts keep one missing input from blocking the others: `outcomeDistribution`, `perCellOutcomeComparison`, `leadToSelected` (needs exposure), `timeToReply` (needs dated events).

### View 2: recurring requirements across selected jobs (`requirements.ts`)

Lanes, never merged: `recorded_missing_experience` (the person's own `candidate_confirmed_gap`), `cv_evidence_not_recorded` (`unsupported`/`needs_verification`), `supported_by_cv`, `unreviewed`; plus `preference_or_eligibility_mismatch` from recorded `known_mismatch` answers. A job lists a requirement once (the most informative lane wins). Recurrence is by **exact normalised wording** (case, accents, punctuation); two wordings become one row only through a **person-confirmed alias**. There is no fuzzy matching and no built-in skill vocabulary, so recurrence can be under-counted; the output says so.

**Frequency vs fit opinion.** The fit score appears only as a context field on a supporting job. Tests set every score to missing, to 0 and to 99 and every outcome to rejected or to interview; no row, lane count, eligibility row or suggestion changes (`invariances` in the evaluation). A score of `0` is counted as scored; a missing score as unscored.

**Outcomes are context only.** Each supporting job carries its recorded outcome and every suggestion carries `OUTCOME_CONTEXT_CAVEAT`: a rejection, an interview or silence is not evidence that the requirement was the reason, and nothing estimates a chance of being hired.

## 10. Suggestions, dismissal, no-go (`suggestions.ts`)

A `Suggestion` carries: a deterministic `id` (hash of kind and subject), the `statement` (non-causal wording; says what the person may do and that nothing was changed), `support.items` (the jobs, with requisition keys), raw `denominators` with labels, the selection `window` and `asOf`, the `versionClass`, `uncertainty` (small-sample flag and limits), labelled `outcomeContext`, `effect: 'none'` and the single action `dismiss`.

Kinds: `add_cv_evidence` (a requirement recurs with no CV evidence recorded), `consider_learning_priority` (it recurs and the person recorded they lack it), `review_preference_conflict` (the person's own stated need conflicts with a recorded answer in several chosen jobs), `review_search_variant` (needs the projected exposure digest: a variant shown to at least `minExposed` distinct leads that the person rarely selected; a fact about selection, not about hiring).

- **Dismissal** is a pure reducer over `{ dismissed: { [id]: { at, supportAtDismissal } } }`. A dismissed suggestion leaves the visible list, stays inspectable, does **not** return when more supporting jobs arrive, and reports how many newer supporting jobs exist. Restoring is a second reducer call.
- **No mutation.** No function in the prototype accepts or returns a profile, preference, search plan or weight. Tests deep-freeze inputs, snapshot every workspace table before and after a full run plus a dismissal, and the non-production guard rejects writers, timers, network, model and randomness in the read-only modules.
- **Withholding is a result.** When a view is `no_go` its suggestions are not produced and the reasons are returned in `withheld`.

**Review gates** (`GATES`, **author-declared**, not derived, not validated): minimum matured sends 20, unknown-outcome share ≤ 0.5, weak-key share ≤ 0.25, extra-copy share ≤ 0.5, ≥ 8 assessed, unassessed share ≤ 0.5, incompatible-version share ≤ 0.34, recurrence ≥ 3, small-sample flag below twice the recurrence threshold, search-variant review needs ≥ 20 leads shown and a selection share ≤ 0.1. They decide only whether a view is worth showing a person for review. They could be wrong in either direction and must not be treated as calibrated.

## 11. Results (Executed; see `docs/research/outcome-gap/693-evaluation.json`)

**Portfolios.** Ten constructed portfolios, 11 checks against fixture-author expectations: 0 mismatches. One portfolio passes the gates (`rich_projected`, which uses projected fields); the other nine are `no_go` for at least one view, and between them they exercise every named no-go reason: too few matured sends, unknown outcomes dominating, weak identity dominating, copies dominating, too few assessed, unassessed dominating, incompatible versions dominating, no recurring requirement.

**Real-contract lane.** On a synthetic workspace written through the real writers (5 requisitions from 6 saved jobs and 6 application rows): copies and reapplication isolate correctly; 1 matured send, 2 censored, 1 undated, 1 prepared-only; the outcome and per-cell views are `no_go: too_few_mature_sent`, lead-to-selected is `no_go: no_exposure_denominator`, time-to-reply is `no_go: no_status_timestamps`, the query-variant view has one cell (`(query variant not recorded)`), requirements are `no_go`, and **no suggestion is produced**. This is what the app could do today.

**Invariances.** Flipping every outcome to rejected or to interview, setting every score to missing/0/99, and removing every assessment: the first two change nothing but labelled outcome context; the last leaves zero requirement rows and zero requirement suggestions, however the titles read. Dismissal behaves as specified.

**Constructed baselines** (simpler rules on the same fixture; not shipped behaviour): "a rejection means a missing skill" would call 9 of 13 requirement-job pairs a gap that the CV actually supports; "the title says Kubernetes" would attribute a gap to all 10 unassessed jobs; summing source cells would count 34 for 30 requisitions; counting copies as jobs inflates 30 to 34; a "rate among known outcomes" gives 0.429 where the data only supports 0.273 to 0.636 with 8 of 22 outcomes unknown.

### Desk comparison with current manual review

Method: the rich portfolio (30 requisitions) plus invented free text on some jobs. **Manual side = source reading** of what current screens show (`apps/desktop/src/components/saved/SavedJobDrawer.tsx` kept "Fit check" free text and the brief panel; `apps/desktop/src/components/applications/ApplicationsTable.tsx` next step; `apps/desktop/src/components/applications/ApplicationDrawer.tsx` notes; `apps/desktop/src/components/search/VacancyDetail.tsx` "Found with"). **Prototype side = executed.** Unit = counted record opens, **not time**. No human labels; "better" is the fixture author's reading.

| Question | Manual opens | Prototype | Where manual is better |
| --- | --- | --- | --- |
| Which requirements recur and how often | 30 drawers (20 have a structured answer, 2 only a free-text Fit check, 8 nothing) | 1 view; 20 assessed, 10 reported as not assessed | Per-job wording; 2 free-text-only findings the structured view cannot read |
| Recorded gap vs just not on the CV | 30; the brief separates them per job, a kept Fit check does not | 1; lanes never merged | Tie per job; prototype only aggregates |
| Repeated conflict with a stated need | 30 | 1 | Tie per job |
| Source / variant of sent applications and result | 50 (row + drawer per sent application) | 1, **only with projected fields**; a no-go today | Source per job; neither can name the variant of a saved job |
| Context only in notes / next step | 3 | none, by design | **Manual** |

Totals: 143 counted opens by hand across the five questions vs 5 prototype runs, on data the prototype can only read if it exists. A person with three saved jobs gains nothing; the advantage grows with the number of jobs. Free text can carry the decisive fact and the prototype ignores it on purpose.

## 12. Retention, reset, deletion, privacy, migration and UI contracts (for any future production work)

These are contracts for follow-ups, not a description of anything that exists.

- **Derive on read.** Aggregates are computed from existing tables on demand and **not stored**. Nothing needs a new corpus, cache or scheduled job. The only new persisted state a review UI would need is the dismissal set (suggestion ids and a timestamp, no CV text, no job text).
- **Reset and deletion.** Settings > Advanced > Reset application data (`resetApplicationData`, `apps/desktop/electron/workspace/repository.ts:3067`) must delete any new table with a count, like #688–#692; deleting an application or saved job removes its events through `ON DELETE CASCADE`; deleting the last job for a requisition removes its derived rows. Aggregates disappear because they are never stored.
- **Privacy.** Local only. No CV text, JD text, notes, next step or draft is read by an aggregate; requirement wording is the posting's own text already stored. No provider call is needed and none may be added. Query text is user-entered search terms, already stored in the search plan.
- **Survivorship.** Deleting a saved job erases it from every aggregate. The UI must say the aggregate describes jobs the person kept.
- **Migration.** New tables are additive (next migration after 0040). Existing applications get **no backfilled events**: their history is unknown, so they read as `current_value_only`, and the review must treat pre-instrumentation rows as having no timing. Existing briefs have no `queryProvenance`; they read as `not_recorded`. A reader must refuse an unknown major version.
- **Report pruning.** Search reports are pruned after 90 days by default; therefore provenance cannot be recovered from reports later and must be copied at save time.
- **UI.** Read-only panel on Applications (not Search, not a new page), reachable by keyboard, every number a button that lists its jobs, every suggestion with a dismiss action and an expandable "evidence": jobs, denominators, window, version class, small-sample note, outcome context with the caveat. Empty or `no_go` states say what is missing and which follow-up would record it. No score, probability, ranking, colour-coded "good/bad" or progress toward a goal. No notification, badge or scheduled run. Text uses the app's existing terms (`copy-rules` tests apply).

## 13. Bounded follow-ups (future work; not part of the selected implementation queue)

Reconciled against open and closed issues first: no existing issue owns outcome events, saved-job search provenance or an aggregate review. #658/#659 record when an employer page was opened and whether the person applied, which is submission evidence, not outcomes; #283 (closed) reconciled sheet statuses; #9/#341 (closed) are ATS fetch-failure telemetry, a different "gap".

| | A. Dated, sourced outcome events (#708) | B. Carry search provenance into the saved job (#709) | C. Gated read-only outcome and requirements review (#710) |
| --- | --- | --- | --- |
| **Owner** | Applications | Search / application brief (#688) | Applications |
| **Trigger** | The person sets or changes a status, or the app records a receipt | A job is saved or an application is prepared while the scan row is loaded | The person opens the review |
| **Inputs** | applicationId, from/to status, `source: user_set \| app_observed`, optional `occurredOn` the person supplies, `recordedAt` | `sources[]` and `queryProvenance` of the scan row, copied by value, size-bounded | A + B + existing tables |
| **Versioning** | additive table, event schema version | additive field in `BriefSourceFacts`; `factsVersion` bump | contract major/minor of this doc |
| **Retention / reset** | deleted with the application and by Reset | deleted with the brief and by Reset | dismissals only; Reset deletes them |
| **Migration** | no backfill; old rows read `current_value_only` | no backfill; old briefs read `not_recorded` | none beyond dismissals |
| **UI** | optional date field when changing a status; history list in the drawer | "Found with" shown in the brief | §12 |
| **Acceptance** | no event is created by silence; occurredOn never defaults to recordedAt; unknown stays unknown | variants survive a rescan and report pruning; deleting a variant later does not rewrite it | reproduces the evaluation's accounting on real data; every number lists its jobs; dismissal persists |
| **Depends on** | none | none | A and B shipped; ≥ the gates met on the person's own data |
| **No-go gate** | do not infer a response from silence or from a status change | do not store profile or CV text | **do not ship if the person's data fails the §10 gates; never change a profile, preference, weight or model automatically** |

The Workable generic-listing defect described in §3 is filed separately as #711 (outside this research's scope). #708-#711 are future work; none is added to the selected implementation queue, and #710 is gated on #708, #709 and its own no-go result.

A lead-exposure digest (counts of distinct leads shown per source and variant per scan) is documented as a conditional option, not filed: without A and B it would add storage for a view that stays `no_go`, and the person may prefer not to have it.

## 14. Limits and what is not claimed

- Not a shipped feedback loop, not a scorer, not a hiring estimate; no model, provider or token cost is involved.
- No human study. Expected labels are fixture-author expectations. Gates are author-declared. Maturity (28 days) has no empirical basis.
- The one passing portfolio relies on fields production does not record; its `go_review` verdicts describe the contract, not the app.
- Exact-text recurrence under-counts; person-confirmed aliases fix only wordings the person notices.
- Selection is survivorship-filtered; correlation between a requirement and an outcome is never presented as cause.
- The evaluation cannot say whether a suggestion would be useful, understood or acted on.
- The identity key inherits the engine's documented weak tier and the Workable defect above.
