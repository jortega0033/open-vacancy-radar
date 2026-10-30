# Role scope: research result and decision (#694)

Evidence date: 2026-10-30, against `master` at `d31a4b88` (after #693 merged in #707). Every result below is
**Executed** by `apps/desktop/test/role-scope-research/evaluation.test.ts` and checked in as
`docs/research/role-scope/694-evaluation.json`, which the test byte-compares. Source citations are
`path:line` at that commit.

## Decision (ADR)

**Status:** Accepted for this delivery. The user chose "keep frontend focus" on 2026-10-28, and this research
found no safety or correctness reason to narrow it further.

**Context.** The Search profile accepts any target-role text (`packages/vacancy-engine/src/candidate/profile.ts:25`).
The evaluator that orders Search is frontend-shaped (`packages/vacancy-engine/src/filtering/relevance.ts:272`).
It reads `targetRoles` only to decide whether a profile is configured at all (`packages/vacancy-engine/src/candidate/profile.ts:130`),
never to decide what a good role is. So a backend or data target gets a frontend ranking, presented as if it fitted the stated target.

**Decision.** OVR stays **frontend-only** (option A):

- Equivalent frontend titles and languages are covered by #686 **reviewed** search plans. They are not covered by
  automatic expansion and not by a second evaluator.
- The deterministic evaluator stays the only production scorer.
- Backend was evaluated as the one additional research family (option B). It is **not selected for production**.
- No role-family behaviour, profile field, search plan, preference or score is added or changed by this work.

**Consequences.**

- Easier: one evaluator, one explanation vocabulary and one set of tests. The product claim ("frontend job search")
  matches what the scorer actually measures.
- Harder:
  - A person whose targets are not frontend still gets a frontend-shaped ordering. The product already states
    "frontend-only" (`README.md:25`), and the score breakdown's reasons already name frontend evidence. §7.2 is the contract any
    future change to target-role input must keep.
  - Two gaps found here stay open until their own small fixes land: #713 and #714 (§10).
- Reversible: option B is a self-contained research module with versioned explanations. If the conditions in §8 are ever met, it can be revisited without undoing anything shipped.

## What is in this PR

| Path | What it is |
|---|---|
| `docs/role-scope-research.md` | This memo |
| `docs/research/role-scope/694-evaluation.json` | The generated evaluation (raw cases, labels, results), byte-compared |
| `apps/desktop/test/role-scope-research/fixtures.ts` | 46 synthetic postings and 3 synthetic profiles, all written for this research |
| `apps/desktop/test/role-scope-research/plans.ts` | Four query plans built with #686's own functions |
| `apps/desktop/test/role-scope-research/comparator.ts` | Option B: research-only deterministic role-family comparator |
| `apps/desktop/test/role-scope-research/evaluate.ts` | The evaluation: production evaluator, sort, plan compiler, shared filter and eligibility assessor vs option B |
| `apps/desktop/test/role-scope-research/*.test.ts` | Byte compare, invariances, comparator properties, non-production guard, doc-reference check |

No production file, dependency, migration, IPC channel or UI changes.

```sh
# from apps/desktop
pnpm exec vitest run test/role-scope-research
# regenerate after an intended change:
OVR_EVAL_OUT=../../docs/research/role-scope/694-evaluation.json pnpm exec vitest run test/role-scope-research/evaluation.test.ts
# measure latency (written only where you point it, never committed):
OVR_LATENCY_OUT=<file>.json pnpm exec vitest run test/role-scope-research/evaluation.test.ts
```

## 1. How to read every number here

- **Labels are fixture-author expectations.** I wrote them from the synthetic profile and the posting text. They are not
  human-reviewed relevance labels, not a panel, and not hiring truth. Grades are `relevant > adjacent > not_relevant`.
  One case (S03, a generic title with no text) is deliberately **unlabelled** and excluded from every graded count.
- **Synthetic, rights-safe data.** All postings, profiles and company names ("Example Co NN") were written for this research.
  No real advert, CV, job-site text, private workspace or paid extraction was used, and nothing was fetched.
- **Counts, never bare percentages.** Every count below has its case table in the JSON (`scorer.*.rows`,
  `retrieval.*.perCase`, `ranking.*.order`, `preClassification.rows`).
- **Three separate questions.** A ranker cannot recover a job that was never discovered, so these are not merged:
  - **Scorer:** every case scored as if retrieved.
  - **Retrieval:** which cases a plan would keep.
  - **Ranking:** the order of only the retrieved cases.
  The discovery pre-classification (§5.2b) and the eligibility answers are reported beside all three. Neither is ever folded into a grade.
- **Retrieval is a projection.** It uses the production plan compiler and shared local filter over the corpus. It does
  not model which sources accept a role query upstream, paging, caps, failures, or a source's own ranking. It is not live coverage.

## 2. Existing owners reused

| Concern | Owner reused | How |
|---|---|---|
| Scoring | `scoreWorldwideVacancy` (`packages/vacancy-engine/src/filtering/relevance.ts:640`) and the pipeline step that calls it per row (`packages/vacancy-engine/src/pipeline/global-remote.ts:275`) | Called unchanged. The evaluator is not re-exported from the package index, so it is reached through its module's own export, the same way `apps/desktop/test/vacancy-scan-run.test.ts` reaches the pipeline |
| Score breakdown and ordering (#367/#395/#464) | `sortSearchResultIndex` (`apps/desktop/src/components/search/results.ts:723`) via `sortResults` | Real Search order of the scored rows |
| Reviewed titles and languages (#686) | `approveSearchPlanDraft` (`packages/vacancy-engine/src/candidate/search-plan.ts:244`), `captureSearchPlanSnapshot` (`packages/vacancy-engine/src/candidate/search-plan.ts:322`), `compileSearchPlanQueries` (`packages/vacancy-engine/src/global-remote/search-plan.ts:123`), `vacancyMatchesRole` / `vacancyTitleMatches` (`packages/vacancy-engine/src/global-remote/focused-scan.ts:280`, `packages/vacancy-engine/src/global-remote/focused-scan.ts:288`) | Plans are approved, snapshotted and compiled exactly as a run does. Unapproved suggestions stay unapproved |
| Eligibility (#280) | `assessWorkEligibility` with a fixed clock | Answers reported as `yes / no / unknown`, never combined |
| Comparator / model benchmark (#412) | Not duplicated | No AI comparator, model, SDK or provider call. §9 offers this corpus as a shared fixture contract |
| Outcome measurement (#693) | `docs/outcome-gap-research.md` conventions | Same evidence vocabulary and byte-compared evaluation. A negative control checks that outcome fields carried through the real pipeline, Search sort and option B change nothing (§5.7) |
| Extraction (#634) | Untouched | Not read or changed |
| Historical #152/#153 | Context only | No deleted seam (SemanticScorer, free-text AI ranking) is revived |

## 3. Why target roles and scoring disagree today (source reading)

- **Role fit is a fixed frontend title/evidence rule.** Its scores:

  | Role reading | Role fit |
  |---|---|
  | frontend | 96 |
  | generic frontend | 84 / 88 |
  | full-stack TypeScript | 82 |
  | generic software | 48 / 52 |
  | unclear | 30 |
  | design | 20 |
  | backend, management, QA, data, embedded, devops, support | 5 or 8 |

  Sources: `packages/vacancy-engine/src/filtering/relevance.ts:272`, `packages/vacancy-engine/src/filtering/relevance.ts:369`.
- **Technical fit counts a fixed list of frontend concepts.** The list has Angular, React, TypeScript, Web Components, etc.,
  but no Vue or Svelte (`packages/vacancy-engine/src/filtering/relevance.ts:67`). It is capped at 55 for backend and other
  non-frontend families (`packages/vacancy-engine/src/filtering/relevance.ts:450`).
- **The only profile-driven gates** are excluded role families (`packages/vacancy-engine/src/filtering/relevance.ts:572`)
  and the mandatory-language cap of 45 (`packages/vacancy-engine/src/filtering/relevance.ts:608`). `targetRoles` is read only
  through `isCandidateProfileConfigured` (`packages/vacancy-engine/src/filtering/relevance.ts:645`).
- **The 70 threshold hides nothing.** The pipeline discards `relevant` (`packages/vacancy-engine/src/pipeline/global-remote.ts:280`)
  and Search sorts every scored row by score. "Below threshold" therefore means "ranked lower", never "removed".
  This research does not read every low score as a hidden result.
- **There is no "not enough text" state.** A missing description produces an ordinary low number.
- **A second, title-only role gate runs at discovery.** `classifyDiscoveryVacancy`
  (`packages/vacancy-engine/src/global-remote/evaluation.ts:90`) marks every title that is not explicitly frontend-only as
  `role_mismatch`. Its positive rule is English-only: front-end/angular + engineer/developer, or "UI engineer/developer"
  (`packages/vacancy-engine/src/global-remote/evaluation.ts:13`, `packages/vacancy-engine/src/global-remote/evaluation.ts:14`).
  It also has a fixed exclusion list (`packages/vacancy-engine/src/global-remote/evaluation.ts:15`). A #686-approved title
  stands in for the positive rule only (`packages/vacancy-engine/src/pipeline/global-remote.ts:1067`).
  This decision is shown as "Discovery decision" in the detail pane and counted in report statistics. Search **neither hides
  nor reorders** a `role_mismatch` row (`apps/desktop/src/components/search/SearchResultList.tsx:56`), so in Search a
  `role_mismatch` is not a hidden result, and this research does not treat it as one. The generated HTML report is different:
  its "Discovery-board title matches" table omits `role_mismatch` and `non_vacancy` rows
  (`packages/vacancy-engine/src/global-remote/report.ts:89`) and names the full per-listing audit file, `latest.audit.ndjson`,
  instead (`packages/vacancy-engine/src/global-remote/report.ts:194`). A reader of that table alone does not see those rows.
- **Queries do read target roles.** The scheduled scan searches the first target role
  (`apps/desktop/electron/vacancy-scan-query.ts:135`), and Search's default query is the first role (`apps/desktop/src/components/search/SearchPage.tsx:956`).
  The Resume Toolkit's best-fit prompt can propose stretch directions and titles outside frontend
  (`apps/desktop/src/components/cv/prompts.ts:395`). Those land only as reviewable plan suggestions
  (`packages/vacancy-engine/src/candidate/search-plan.ts:268`). So a non-frontend title can be **searched**, but its results are **ranked** by the frontend rule.

## 4. Method

| Pin | Value |
|---|---|
| Base commit | `d31a4b88` |
| Corpus | `role-scope-corpus/1.0.0-synthetic`, 46 cases, 44 in a configured source and 2 in none |
| Profiles | `role-scope-synthetic-frontend-v1`, `role-scope-synthetic-backend-research-v1`, `role-scope-synthetic-unsupported-target-v1` |
| Current evaluator | `scoreWorldwideVacancy`, threshold 70. The evaluator has no version constant, so the base commit plus the byte-compared outputs pin it |
| Option B | `role-family-comparator/0.1.0-research`, explanation schema `role-family-explanation/0.1.0-research`, sparse below 12 words |
| Plans | P0 frontend literal (the first target role, as the scheduled scan uses), P1 #686 reviewed frontend plan (literal + 10 approved titles incl. Dutch and German, 1 unapproved suggestion), P2 backend literal, P3 backend research plan (literal + 5 titles). P2 and P3 are research only |
| Eligibility clock | `2026-10-30T00:00:00.000Z` |
| Model | none |

**Corpus coverage:**

- equivalent frontend titles: UI Developer, Vue.js, Client-side, Web Engineer, Frontend-Entwickler, Frontend ontwikkelaar
- frontend controls
- mixed and backend-dominated full-stack roles
- ambiguous platform and product roles
- out-of-scope roles: design, sales, data, embedded
- backend roles
- sparse and missing descriptions
- language: mandatory, preferred, unclear before / after / under a later heading, and Dutch-worded mandatory
- work country: known mismatch, unknown, accepted
- preferred versus mandatory requirements
- four hard negatives a frontend plan does retrieve (backend role naming the query in its body, "UI Engineer in Test", frontend engineering manager, Unity game UI)
- two cases in no configured source

**Resource envelope (identical for both evaluators).** Same profile and same title/description per case, one synchronous
in-process call per (case, profile). No network, model, provider, file I/O, cache or retries.

## 5. Results

### 5.1 Scorer, frontend profile (every case scored as if retrieved)

| Fixture grade | Current: at/above 70 | Current: below 70 | Option B: match | adjacent | mismatch | uncertain |
|---|---|---|---|---|---|---|
| relevant (25) | 19 | **6**: F08, S01, S02, L01, L03, L06 | 25 | 0 | 0 | 0 |
| adjacent (3) | 2: M01, M03 | 1: M04 | 0 | 2 | 0 | 1: M04 |
| not_relevant (17) | 0 | 17 | **3**: N02, N03, N04 | 0 | 14 | 0 |
| unlabelled (1) | S03 = 41 | | | | | S03 |

**Relevant cases scored below 70 (case table, with the evaluator's own breakdown):**

| Case | Title | Score | Role fit | Technical fit | Cause | Kind |
|---|---|---|---|---|---|---|
| F08 | Senior Vue.js Developer | 53 | 30 ("Unclear role family") | 57 | title rule and concept list have no Vue | **Scorer gap (frontend vocabulary)** |
| S01 | Senior Frontend Developer (no text) | 69 | 96 | 35 | no description | **Sparse: low number, no uncertainty state** |
| S02 | Frontend Engineer ("Join our team.") | 68 | 96 | 35 | one line | same |
| L01 | Senior Frontend Engineer + "Fluent German is required." | 45 | 96 | 82 | mandatory-language cap | **Correct eligibility gate**, not a role error |
| L03 | same body + unclear "Our team speaks German…" after the Requirements list | 45 | 96 | 82 | cap from an inherited Requirements heading | Debatable: the author reads no obligation |
| L06 | same sentence under a later "About us" heading | 45 | 96 | 82 | cap: the heading context does not reset at "About us" | **Language-detection defect** (§10), invents an eligibility "no" |

**Correct frontend controls.** F01–F07, F09–F11, L02, L04, L05, E01–E03, R01, R03 and D01 score 78–98. That covers
UI Developer (82), Client-side (78), Web Engineer (88), Frontend-Entwickler (88) and Frontend ontwikkelaar (84). The hard negatives
N01 (29), N03 manager (28) and N04 Unity (38) are correctly low. **No not-relevant case reaches 70.** The one misleading
case is N02 "Senior UI Engineer in Test" at 69, read as frontend (role fit 96) because the QA title rule does not cover
"engineer in test" (`packages/vacancy-engine/src/filtering/relevance.ts:326`).

**Option B on the same cases** matches all 25 relevant cases. That includes F08 and S01/S02 (at `low` confidence). But it calls
N02, N03 and N04 a frontend **match** (low confidence, title-only), and today's evaluator gets those three right. Its family rule
has no management, test or game-UI awareness.

### 5.2 Retrieval projection (which in-source cases each plan's OR set keeps)

| Plan | Queries | Retrieved | relevant kept | relevant in source but not matched | relevant in no configured source |
|---|---|---|---|---|---|
| P0 frontend literal | 1 | 11 | **10 of 24** | 14: F02–F11, S01, S02, L04, R03 | D01 |
| P1 #686 reviewed plan | 11 | 27 | **23 of 24** | 1: F05 "Web Platform Engineer" (no approved title matches) | D01 |
| P2 backend literal (research) | 1 | 2 | 2 of 4 | B02 "Go Engineer", B03 "Node.js Engineer" | D02 |
| P3 backend plan (research) | 6 | 7 | 4 of 4 | 0 | D02 |

- **P1's 23 of 24 is true by construction.** I chose P1's ten approved titles knowing the corpus titles (Vue.js Developer,
  Client-side Engineer, Design Systems Engineer, Frontend ontwikkelaar, Frontend-Entwickler, ...), and left F05 "Web Platform
  Engineer" as the one deliberate miss. So 23 of 24 shows the **mechanism**: an approved title is matched by the shared title
  filter, and an equivalent title the person did not approve is not. It is an **upper bound on this synthetic corpus**, not an
  estimate of what a person's real reviewed plan, or any live source, would retrieve.
- **On this corpus, by construction, retrieval is the larger lever for equivalent titles.** The reviewed plan changed what is kept
  more than any scoring difference did. The literal typed query matches title or description; approved titles match the title only.
- **Undiscovered jobs are unrecoverable.** D01 and D02 never reach any evaluator.
- **Unapproved suggestions stay out.** P1's unapproved suggestion "Full-Stack Engineer" never became a query, so the adjacent
  full-stack cases M01/M03/M04 are not retrieved by P1. That is intended: a suggestion searches nothing until the person approves it.
- **Projection, not live coverage.** These counts say nothing about live source coverage.

### 5.2b Discovery pre-classification (title-only role gate; reported apart from scoring)

| | Without a plan | With the P1 reviewed plan |
|---|---|---|
| Relevant cases marked `role_mismatch` | 8: F04 Design Systems, F05 Web Platform, F06 and L04 Frontend ontwikkelaar, F08 Vue.js, F09 Client-side, F10 Web Engineer, F11 Frontend-Entwickler | **1: F05** |
| Not-relevant cases passing the role gate | 2: N02 "UI Engineer in Test", N04 "UI Developer (Unity)" | the same 2 |
| Adjacent full-stack cases marked `role_mismatch` | M01, M03, M04 (full-stack is an excluded family) | the same 3 |

N03 "Frontend Engineering Manager" matches the approved title "Frontend Engineer" but correctly stays `role_mismatch`, because
the exclusion list still runs on the real title. The reviewed plan fixes the English-only positive rule for exactly the
titles the person approved, which is the intended #686 behaviour. "Engineer in test" is missing from this gate's exclusions as
well as from the scorer's QA rule (#714).

### 5.3 Ranking (retrieved cases only)

**P1 (frontend, reviewed plan), 27 retrieved, 92 labelled pairs with different grades:**

| | concordant | tied | discordant | discordant / tied pairs |
|---|---|---|---|---|
| Current evaluator | 86 | 1 | 5 | F08>N02, S02>N02, L01>N02, L03>N02, L06>N02. Tied: S01=N02 |
| Current, excluding the 3 language-capped rows | 77 of 80 | 1 | 2 | F08>N02, S02>N02 |
| Option B | 74 | **18** | 0 | ties between the six low-confidence relevant cases (F11, S01, S02, L04, R01, R03) and N02/N03/N04 |

- **Top-k.** Both put 10/10 relevant in the top 10. In the top 20, both have 19 relevant and 1 not-relevant (current: N02 at rank 19; B: N03).
- **Every current discordance involves N02.** The language-capped pairs are eligibility, not role order.
- **B's ties are not wins.** B avoids discordance only by tying uncertain relevant cases with confident-looking wrong matches.

**P0 (frontend literal).** 11 retrieved, 10 pairs, all concordant for both. The literal plan's problem is retrieval, not order.

**P3 (backend research plan, backend profile), 7 retrieved, 14 pairs:**

| | concordant | tied | discordant |
|---|---|---|---|
| Current evaluator | 6 | 0 | **8**: F05 "Web Platform Engineer" (87, retrieved by the "Platform Engineer" title) sits above every backend case; B01 and S04 rank below A01 |
| Option B | 9 | 4 | 1 (S04>B04) |

Top 3: current has 2 relevant + F05; option B has 3 relevant.

### 5.4 Unsupported-family behaviour today

- **Swapping target roles changes nothing.** Replacing the frontend profile's target roles with backend ones leaves all 46 scores
  identical (`unsupportedFamily.targetRolesChangeCurrentScores: false`).
- **Backend-target profile.** The current top 5 are F01, F04, F02, R01 and E01: all frontend, scores 88–98. The four in-source
  backend-relevant cases score B01 31, B02 39, B03 44 and S04 25. D02, which no plan can retrieve, scores 28 when scored as if retrieved.
- **Data-scientist target.** The current top 5 are again frontend jobs (86–98). Option B returns `unsupported_family` for every
  case: an explicit refusal, not a low score.

**What this is and is not.** It is the core coherence gap: arbitrary target text, frontend ranking. It is **not** a reason to ship
backend support. It is a reason for the product to state the boundary (§7.2).

### 5.5 Slices: language, eligibility, sparse, preferred vs mandatory, mixed

**Language** (frontend profile, candidate languages: English):

| Case | Posting says | Detector | Eligibility | Cap | Author expected |
|---|---|---|---|---|---|
| L01 | "Fluent German is required." | mandatory | no | 45 | no ✓ |
| L02 | "German is a plus." | preferred | unknown | none | unknown ✓ |
| L03 | unclear line after the Requirements list | mandatory (inherited heading) | no | 45 | unknown ✗ |
| L05 | same line before any heading | none | unknown | none | unknown ✓ |
| L06 | same line under a later "About us" heading | mandatory (heading not reset) | no | 45 | unknown ✗ |
| L04 | "Vloeiend Nederlands is vereist." (Dutch wording) | not detected (markers are English) | unknown | none | unknown, recorded as a detection limit |

**Work country** (candidate country: Netherlands). E01 "United States only" gives `no`, E02 "fully remote" gives `unknown`, E03
"Netherlands or Germany" gives `yes`. All three score 90: country never changes a score. With no candidate country configured,
every case answers `unknown`. With no candidate language, every case answers `unknown` and no cap applies. Nothing in this
research or in option B produces a legal or work-eligibility claim.

**Sparse.**

- S01/S02: today 69/68, a confident-looking number. Option B: match at low confidence.
- S03 (generic title, no text): today 41. Option B: `uncertain`, and the author does not label it either.
- S04 (backend title, no text): today 25 for both profiles. Option B: backend match at low confidence.

**Preferred vs mandatory.**

- R01: Go/Kubernetes/Terraform are only nice-to-have. Today: 89, because preference lines are weighted 0.35. Option B: match, ignored signals reported.
- R02: frontend terms only nice-to-have, backend core. Today: 36. Option B: mismatch. Both are right.
- R03: frontend role with "Must have: 3+ years of Kubernetes". Today: 83, no gap named. Option B: match.
- Neither names the mandatory non-frontend requirement. That explanation belongs to the ATS-fit requirement view (#361/#370), not Search ranking.

**Mixed / ambiguous.**

- M01/M03 (full-stack TypeScript): today 84/76, B adjacent. Both are reasonable.
- M02 and N01 (backend-dominated "full-stack"): today 33/29, B mismatch. Both are right.
- M04 "Product Engineer" (thin text): today 57, B `uncertain`.
- A01 "Platform Engineer" (infrastructure): today 34, B mismatch.
- F05 "Web Platform Engineer": today 87, B match. Both are right.

### 5.6 Latency and usage

| | Calls in one evaluation run | Network | Model | Tokens / cost |
|---|---|---|---|---|
| Current evaluator | 258 direct calls + 319 rows through the pipeline step | 0 | 0 | not applicable |
| Option B | 415 | 0 | 0 | not applicable |

The outcome negative control (§5.7) accounts for 184 of the pipeline rows (46 cases × 2 profiles × clean and noised runs) and
184 of the option-B calls.

Wall-clock latency is measured by the test but **not committed**, because it is not deterministic. One run on 2026-10-30
(Windows build 10.0.22000 from `os.release()`, Intel i7-2600, Node 22.23.4, under vitest, after module load) gave a median of **0.19 ms per call for the
current evaluator** and **0.04 ms for option B**, 20 samples of 92 calls each. This is indicative only: different hardware will differ.
It shows neither option has a latency problem. It is not a reason to choose one.

### 5.7 Invariances (asserted on every run)

- **Outcome negative control.** No production scoring or ordering function declares an outcome or application-status
  parameter, so the claim is not that an outcome "could" change a score. The control checks the real boundary instead:
  - All 46 cases run twice per profile (frontend and backend research) through the production path: audit row →
    `applyWorldwideProfileScores` → `toPartialResults` → `sortResults`. One run is clean. In the other, six cases carry
    `outcome` and `applicationStatus` (`rejected`, `no_response`, `interview`, `applied`). The pipeline spreads the row and
    Search keeps it as `raw`, so the fields really reach the Search ordering input (`noiseReachedSearchRows: true`).
  - Option B is given the full noised case, not a title/description pick.
  - Result: no score, no `profileMatch`, no Search order position and no option-B output changes. Every label equals a
    `structuredClone` taken before the noise was attached.
  - The control **can fail**: `comparator.test.ts` injects a score step that reads `outcome` off the row, one that folds it into
    the breakdown, a comparator that reads it, and a comparator that writes a label; each is reported.
  - It cannot see an outcome reaching scoring through a different channel (for example a store keyed by vacancy id). An
    outcome is never role or skill truth in the paths it checks.
- An unapproved plan suggestion never reaches a query.
- No candidate country gives `unknown` everywhere. No candidate language gives `unknown` everywhere and no cap.
- Work country never changes a score. A preferred language never caps.
- No case in no configured source appears in any ranking.

## 6. Options compared

| | A: frontend-only (selected) | B: role-aware, + backend (research only) |
|---|---|---|
| Product claim | "Frontend job search", which the scorer actually measures | "Your target roles", true for two families, explicitly refused for the rest |
| Equivalent titles | Via #686 reviewed plans: 23 of 24 here (by construction, an upper bound, §5.2) vs 10 of 24 for the literal query | Same retrieval, plus a family check |
| Frontend scorer errors on this corpus | 1 vocabulary false low (F08), 2 sparse lows, 1 misleading test role (N02) | 0 relevant missed. 3 wrong matches (N02, N03, N04) that A gets right. 18 ties |
| Non-frontend targets | Misleading frontend ordering (§5.4) unless the UI states the boundary | Backend ordered sensibly here (8 → 1 discordant). Others refused |
| Cost to ship | 2 small deterministic fixes (#713, #714). The scope statement already exists | A second evaluator and explanation vocabulary, backend source and query planning, backend vocabulary per stack, a labelled corpus and UI for unsupported families |
| Evidence strength | In-sample on 46 synthetic cases | **In-sample and tuned on the same corpus** (§11). Not generalisable |
| Reversibility | High | Lower once a second family is promised to users |

**Trade-off named.** Option A gives up correct ordering for non-frontend targets. In return it keeps one evaluator, one
explanation vocabulary and a claim the code can back. Option B would buy backend ordering on 7 retrieved cases at the cost of a
second production surface, built and validated on evidence that is too thin (§8).

## 7. Decision contract for a future implementation

### 7.1 Evaluator selection

- **One production evaluator: the deterministic `scoreWorldwideVacancy`.** Any other evaluator (option B, a #412 model)
  runs only as an offline comparator over a pinned corpus and never orders production results.
- **The evaluator is chosen by the product scope, not per profile.** A profile cannot switch evaluators by typing a target role.
- **Changes to the frontend rule ship with regression cases.** The corpus cases they affect (§10) become regression cases in the
  engine's own tests. Expected outputs must be human-reviewed before they are called labels.

### 7.2 Unsupported-family behaviour

Applies when the Search profile's target roles do not read as frontend. The fixture lexicon in `comparator.ts` illustrates the
check; a production check would need its own review.

- **Never present the score as a fit to that target.** Ordering may continue (it is still the frontend evaluator), and the
  explanation must keep saying it is frontend-shaped. Today's role-fit reasons do, e.g. "The title directly identifies a target
  frontend role family". Any future wording that talks about "your target roles" must either be true for the family or say
  "this target is outside what OVR scores".
- **Never** hide rows, drop rows, rewrite target roles, add plan titles or change preferences automatically.
- **Explicit beats a silent low score.** Option B's `unsupported_family` shows the shape: a state, not a number.
- **No backend or other family behaviour ships with this ticket.**

### 7.3 Versioned explanations

The research explanation (`role-family-explanation/0.1.0-research`) carries:

- `schema`, `comparator`
- `verdict`, `confidence` (`normal | low | none`)
- `targetFamilies`, `adjacentFamilies`, `unsupportedTargetRoles`
- `titleFamily`, `vacancyFamily`, `lean`
- `evidence` (`sufficient | sparse`)
- the matched `signals` per family, `ignoredPreferenceSignals`, `reasonCodes`

Any production explanation of role scope should keep these properties:

- **Versioned.** Requirement for a future consumer: refuse an unknown major version instead of coercing it. Nothing in this
  research implements or tests that refusal; the research explanation only carries the version strings.
- **States its own confidence.** Sparse text is a state, not a number.
- **Names the signals it used and the ones it ignored** (nice-to-have lines).
- **Carries no eligibility, salary, outcome or application field.** Those stay with their owners.
- **Never stored as a fact about the candidate.**

## 8. Conditions for reconsidering another family (no promise of expansion)

Revisit only when **all** of these hold. Meeting them makes a new research ticket legitimate, not a feature.

1. **Demand evidence.** Recorded need from real use: people saving non-frontend target roles or approving non-frontend plan
   titles, measured through #693-style observation (role family of saved and selected jobs). Not a guess.
2. **Labelled corpus.** At least **150 human-reviewed** cases for the candidate family plus 150 frontend controls. Each case is
   labelled by at least two reviewers with recorded agreement. Disagreements are adjudicated and kept, not dropped. Synthetic
   fixtures like these 46 may seed, but never count as, labels.
3. **Held-out evaluation.** The comparator is designed on one split and reported on a held-out split it never saw. This research
   did not meet this: option B was adjusted once on this corpus (§11).
4. **Retrieval instrumentation first.** Per-source and per-query-variant retrieval counts for that family's titles from real runs.
   #686 already records `queryProvenance`, but saved jobs do not keep it (#693 §3). Coverage gaps must be measured before ranking gains are claimed.
5. **Error slices reported separately**, each with its case table:
   - sparse text
   - mixed and full-stack roles
   - management, test and game-UI title confusions
   - non-English titles and postings
   - mandatory vs preferred requirements
   - language and work-country unknowns

   Any slice with a confident wrong answer the current evaluator gets right is a no-go until fixed (as with N02/N03/N04 here).
6. **Same resource envelope.** Deterministic, local, no network or model in the ranking path. A model comparator is #412's to measure.
7. **Human review of the explanation and the UI wording** for both the supported family and the refusal path, before anything ships.
8. **Explicit user decision** on the product claim. No silent widening.

Against these gates, option B today is **no-go**:

- 5 backend-relevant fixture cases, not 150 human labels
- no held-out split
- no live retrieval instrumentation for backend titles
- 3 confident wrong matches in the frontend slice

## 9. Shared corpus and measurement contract (#412, #693)

#412 owns the pinned Jev/Laya comparator experiment and has not committed a corpus. This corpus is **offered, not imposed**,
as a shared fixture. A comparator that reuses it should:

- keep the case ids and `CORPUS_VERSION`, and bump the minor version when adding cases
- report against the same three separate questions (scorer, retrieval, ranking) with case tables
- treat `expect` as fixture-author expectations, never as labels
- add its own pinned model or version under `pins`
- run under its own declared envelope, never mixed into this one

#693's evidence vocabulary (Executed / Source-read / Projected, refuse-not-coerce versioning) is followed here.
Nothing in #412, #634 or #686 is modified by this PR.

## 10. Follow-ups (small, evidence-backed, outside the current queue)

- **#713: language heading context leaks past unrelated headings** (L06, and arguably L03). An unclear language sentence under a later
  "About us" heading is read as mandatory. It caps the score at 45 and reports eligibility `no`. That fabricates an eligibility
  mismatch. The detector is `packages/vacancy-engine/src/eligibility/language.ts:137` (heading state at
  `packages/vacancy-engine/src/eligibility/language.ts:145`).
- **#714: frontend vocabulary and test-role boundary** (F08, N02). The title rule and concept list have no Vue/Nuxt/Svelte, and
  "engineer in test" is not read as QA. This is a small deterministic fix within frontend scope, with F08 and N02 as regression
  cases.
- **Maintenance note for both.** They will move lines this memo cites (for example `relevance.ts:67`, `language.ts:137`). When
  they do, update the `path:line` citations here and the `ANCHORS` table in
  `apps/desktop/test/role-scope-research/doc-references.test.ts` in the same PR. That test fails on purpose when an anchor moves.
- **Not filed:**
  - backend or any other family support (no-go, §8)
  - an AI comparator (#412 owns it)
  - a sparse-description uncertainty state. The evidence supports it, but it is a Search explanation change better scoped
    together with #367's breakdown. It is recorded here as a known limit.

## 11. Limits and what is not claimed

- **Small, synthetic, author-labelled corpus.** 46 cases, no human labels, no inter-rater agreement, no real postings. It shows
  that behaviours exist and how the code handles them. It does **not** estimate how often they happen.
- **Option B is in-sample and was tuned on this corpus.** The first run had no fallback to the title's family when text
  evidence was thin, so it abstained on several frontend-titled cases (F11, R01, R03). The fallback was added before
  the committed run. The four plan-matching hard negatives (N01–N04) and the L05/L06 language controls were added after the first run,
  to make the frontend ranking comparison non-vacuous; their labels were written from the text before they were scored.
  Nothing here is evidence that option B generalises.
- **Retrieval is a projection** over the corpus with the production local filter. It is not live source coverage.
- **P1 retrieval is true by construction.** P1's approved titles were chosen by the fixture author with knowledge of the corpus
  titles, and F05 was left out on purpose. Its 23 of 24 demonstrates the approved-title/shared-filter mechanism and is an upper
  bound on this synthetic corpus. It is not an estimate of real reviewed-plan coverage or of live-source coverage. The same
  applies to P3 (4 of 4).
- **Latency is one machine, indicative.** No token, cost or provider number exists because nothing metered was called.
- **Nothing here claims** hiring outcomes, interview rates, time saved, provider or model quality, market coverage, or legal or
  work eligibility.
