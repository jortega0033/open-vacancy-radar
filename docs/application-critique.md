# Independent review of a prepared application

Issue #690. An optional "Review this application" action on the **application drawer** (Applications > any row). It asks a
second, separate AI session to read the package that was already prepared and point at problems. It is not part of ordinary
preparation, runs only when you press it, and a correct package gets no findings and no rewrite.

## What it reads

One fresh no-network, no-tool session (the same closed profile drafting uses; Claude is the only provider that implements it)
is shown, as data and never as instructions:

- the exact CV and letter drafts, with the document version of each;
- the job description exactly as the application stored it;
- your reviewed CV facts and reviewed skills;
- only the company facts that are adequate right now (current, confirmed, uncontested, this employer): the same list a letter
  may use. It never researches, fetches or looks anything up.

It shares no context with the session that wrote the documents. Independence here is a separate session and a checked result,
not a different provider.

## What comes back

Findings of five kinds: a claim your reviewed CV does not support, a requirement the draft leaves out, two documents that
disagree, wording that is unclear, and detail that is not needed. **The app checks every reference itself**:

| Kind | Needs |
| --- | --- |
| Unsupported claim | A quote that is really in the draft, and not in your reviewed CV or an approved company fact |
| Omitted requirement | A quote that is really in the posting, plus the reviewed fact the draft should use (or an explicit "nothing in your CV covers this") that the draft does not already contain |
| Documents disagree | A real quote from each of at least two documents |
| Unclear wording / unnecessary detail | A quote that is really in the draft |

A finding that fails its check is not shown as a finding. It is listed under "Left out because it could not be checked", with the
reason. The reviewer's own opinion never outranks your reviewed CV: calling a sourced bullet "unsupported" is refused.

## Suggested changes

The reviewer may propose a revised CV, or a new selection of reviewed facts for a generated letter. A suggestion is offered only if:

- it passes the **same validators drafting uses**, with nothing removed from it (an invented skill, metric, date, employer, contact
  detail, rewritten summary or rewritten bullet refuses the whole suggestion and names what was wrong);
- the revised document renders and passes the document acceptance contract;
- an accepted finding is about that document.

A letter you wrote yourself is reviewed but never rewritten. A letter built from facts is only re-selected from reviewed fact ids;
the app writes every sentence. The reviewer cannot approve achievements, skills or dates, change your profile, change a
submission, or grant itself a tool or network.

You read the change list and the full revised text, then choose **Use this** or **Not now**. Nothing is applied without that click.

## What accepting does

- Creates a **new version** of that one document and replaces only its current file. The earlier version stays on record.
- Closes only what described the old file: a scheduled automatic send is cancelled, and a prepared form that already holds the old
  PDF is closed (the application returns to "needs you", and you prepare it again; the accepted revision is reused, not regenerated).
- Leaves your reviewed CV, the brief, company facts, other applications, receipts and everything already sent exactly as they were.

A package that was **already sent** can be read but never reviewed again or changed, and a revised package is never shown as the
one that was sent.

## Versions and stale results

A review is bound to the posting text, your reviewed CV, each document version, and the company facts it saw. Opening the panel
re-checks that, without a model call. If an input changed, the findings and suggestions that depended on it are marked "Earlier
version" and their buttons are withdrawn; the rest stay. A result that arrives after its inputs changed, or after Cancel or a data
reset, is discarded.

## When it does not finish

Cancel, a timeout (4 minutes), a usage limit, an unusable answer or an error record what happened and change nothing: your documents
and any previous review stay. There is no automatic retry and no revision loop. One review is one AI request; the panel shows the
request count and the token counts only if the provider reported them.

## Limits

- Packages prepared before this version have no stored drafts and say so; prepare them again to review them.
- The app checks references and your reviewed facts, not whether a quote is *important* or a contradiction is *real*. A finding is
  the reviewer's opinion with evidence you can read, not a verdict.
- Nothing here estimates interview or hiring odds.
- The evaluation below is synthetic and hermetic; it is not a real-world result.

## Evaluation (synthetic, hermetic)

`apps/desktop/test/application-critique-evaluation.test.ts` runs 13 invented cases (4 `construction`, 9 `held-out`, different
candidates and wording) through the real preparation pipeline and the real critique service. Defects, noise and invented facts are
**predeclared** in `test/application-critique-eval-cases.ts`. The "reviewer" is a fixed scripted reply per case, so the run measures
**what the app does with each kind of reply**, not how good any model is. Run it with
`OVR_690_EVAL_OUT=<file> pnpm --filter @agent-dock/desktop exec vitest run test/application-critique-evaluation.test.ts`.

| | construction | held-out |
| --- | --- | --- |
| Cases / clean cases / labelled defects | 4 / 1 / 4 | 9 / 3 / 7 |
| Defects shown with checked evidence | 4 | 7 |
| Corrections applied after the person accepted every offered suggestion | 2 | 3 |
| Defects left for the person (letter text, gaps, refused rewrites) | 2 | 4 |
| Findings refused, and why | 0 | 4 (not in the posting, sourced text called unsupported, no evidence, extra permission key) |
| Suggestions offered / refused by the validators | 2 / 1 | 2 / 2 |
| Invented skill, metric, date or employer attempted / present in a final package | 3 / 0 | 3 / 0 |
| Factual errors in a final package (independent set-membership check) | 0 | 0 |
| Edits forced on a clean package | 0 | 0 |
| Model calls: drafting (current) vs critique pass | 7 vs 4 | 16 vs 9 |
| Token usage | not reported | not reported |

A scripted operation count (one read per finding shown, one decision per suggestion, one manual edit per defect left; every weight 1,
**not time**) came out at 7 (no review) against 13 (review) on the held-out set, so the critique arm saves nothing under that proxy.
Human editing time was not measured; the raw file records a concrete protocol for measuring it. One held-out fixture was mislabelled
and corrected after its first run (recorded in the raw file). These cases are small, author-written and not blind. Nothing here
estimates real-world gains, interview or ATS outcomes.
