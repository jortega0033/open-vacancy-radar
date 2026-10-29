# Posting verification (#687)

When you get ready to apply to a job, or come back to an application that was prepared a while ago, the app
asks the posting's own job system one question before it spends work on it: is this posting still there, and
does it still say what it said when it was read? This page records exactly what that check does and does not do.

## What triggers it

| When | What happens |
| --- | --- |
| An application is prepared for a selected job | One bounded check runs before tailoring, even if a job description is already stored. |
| A stopped or failed application is resumed | The same check runs again, but a result younger than the freshness window is reused with no request. |
| A prepared application is reopened for review | The review dialog asks main for the check first; main only contacts the posting when the stored result is stale. |
| The person presses **Check again** | A forced check, regardless of the window. It is only offered for links that can actually be checked. |

Searching never checks postings. There is no whole-feed refresh, no browser crawling and no scheduled recheck.

## Which postings can be checked

Only links with an official, read-only single-posting route on a job-board host the app already reads:

| Source | Route |
| --- | --- |
| Greenhouse | `boards-api.greenhouse.io/v1/boards/{board}/jobs/{id}` |
| Lever | `api.lever.co` or `api.eu.lever.co` `/v0/postings/{site}/{id}` |
| Workable | `apply.workable.com/api/v2/accounts/{account}/jobs/{id}` (an account-less short link is looked up first) |
| Jobgether | `jobgether.com/astroapi/offer/{id}.json` |

Every other link costs **no request**: it is reported as "could not check" and the person is offered
**Open the posting** so they can look themselves (no **Check again**, which could never ask anyone). No new source,
host or permission is added; every request goes through the shared safe HTTP client (public-address check, origin
boundary, size cap) with no retries.

## The request envelope (enforced, not just described)

| | Logical client calls | Physical network requests (each redirect hop counts) |
| --- | --- | --- |
| Greenhouse, Lever, Jobgether, Workable with an account in the link | 1 | at most 2 (one same-origin redirect is followed; a second is "could not check") |
| Workable account-less short link | 2 (account lookup, then the posting) | at most 5 (lookup follows at most 2 same-origin redirects, the posting route at most 1) |

- `maxRetries: 0`: a 429/5xx/timeout is not retried.
- **One 20-second deadline per check, enforced by aborting the request.** The check's `AbortSignal` reaches the
  shared SafeHttpClient, which stops DNS resolution, frees a scheduler slot it is still queued for without fetching,
  and aborts the in-flight fetch. A desktop-side backstop (deadline + 5 s) only guards a verifier that never answers.
- The deadline bounds network work. It does **not** bound CPU work; that is bounded by design (next section).

These limits are exported as `POSTING_REQUEST_ENVELOPE` and asserted with the real SafeHttpClient in the engine tests.

## Bounded work on the posting text

The posting text is untrusted remote content handled in the Electron main process, so every step is bounded:

- Text is capped at 120,000 characters. Every regular expression applied to it is linear (literal phrases, single
  character classes, bounded repetition); the deadline parser collapses whitespace once and reads fixed 80-character
  windows after at most 8 cue phrases.
- HTML is parsed with the same parser the adapters use (so list text and single-posting text stay identical) only
  inside a budget of 400,000 characters and 4,000 tags, counted with a linear scan first. A bigger payload is
  "could not check (too large)", never parsed and never guessed.
- The comparison pairs typo-level line edits only between lines with the same numbers and lengths within two
  characters, with a banded edit distance that stops early, and a fixed total budget (1.5 million cells; no pairing
  at all above 400 changed lines). When the budget is reached the remaining lines simply count as changed and the
  result is marked `bounded`.

## The four outcomes

| Outcome | Meaning | What the app does |
| --- | --- | --- |
| Confirmed open | The posting was returned and is not materially different from the text the work was prepared from. | Reuses all existing work. One quiet line, no extra screen. |
| Confirmed closed | The posting's job system said it does not exist: HTTP 404/410 from the single-posting route, Workable's `/oops`, or a payload that is nothing but an unqualified closure notice. | Before preparing: stops before any AI work. On a prepared package: takes it out of review (see below). Either way the same explicit choice: **Get ready anyway**, **Open the posting**, **Check again**. |
| Materially changed | The posting is open but requirement-bearing text changed, or at least a fifth of it was rewritten. | Before preparing: stops before any AI work. On a prepared package: takes it out of review. Shows what changed; **Refresh from the updated posting** or **Keep my application**. |
| Could not check | Timeout, 401/403/login wall, rate limit, server error, network failure, off-site or too many redirects, unreadable or too-large answer, an unsupported source, or the check itself could not start. | Preparation continues on the stored text. The notice says this does **not** mean the posting is closed. |

A failed attempt to read a posting is never treated as proof that it closed, is never retried through another route,
and never tries to get around a denial or a sign-in.

### Closure needs an authoritative signal

Closure-like wording inside an open posting is **open**: "closed to applicants without EU work authorisation",
"closed in the US but open in Canada", "closed to external candidates", "filled internally in the past; we are
hiring again", "no longer accepting applications from recruitment agencies". Prose counts only when the whole payload
is essentially the notice (its first line is one of a few fixed closure sentences, the normalised payload is at most
300 characters, and nothing in it qualifies or reopens the role).

### What counts as a material change

- **Requirement change** (shown as "The requirements in this posting changed"): a changed line with a requirement
  signal (years of experience, "required"/"must"/"minimum", work authorisation or visa, language or CEFR level, remote/
  hybrid/onsite/relocation/office days, salary/compensation/currency amounts, contract type, degree/certification, skills
  outside an "about us"/"benefits"/"responsibilities" section), or any line under a Requirements/Qualifications/About
  you heading.
- **Text change** (shown as "The posting text changed a lot"): at least a fifth of the lines changed with no
  requirement signal. It still asks the person, but never claims the requirements changed.
- **Not material**: markup, whitespace, capitalisation, punctuation, line order, a typo-level edit with the same
  numbers, and ordinary employer copy such as a company blurb that now says "we lead the market", "founded 12 years
  ago", a new office perk or an equal-opportunity sentence.

## Prepared packages are held, never deleted, by a finding

- When a check finds a **closed** or **changed** posting for a **prepared package** (a `ready` review, or the manual
  hand-off whose documents are ready), the package is taken out of review: the application shows the finding and its
  checkpoint, detail and prepared answers are copied onto the finding in the same transaction. Staged documents stay.
- **Keep my application** (changed) / **Get ready anyway** (closed) put the package back exactly as it was: same
  checkpoint, detail, prepared answers and documents. No AI work, nothing queued.
- A later **Check again** that finds the posting open and not materially different puts the package back by itself.
  A later check that cannot reach the posting leaves the finding (and the hold) in place and says so.
- Only **Refresh from the updated posting** replaces the package: the updated text becomes the job description and
  preparation runs again through the existing restart flow. A plain **Resume** of a held application also prepares
  again; the old package is then never restored.
- An application waiting on **anything else** (a question, a missing letter, a failure) is never touched by a check:
  its detail and prepared answers stay; the notice shows the finding and a decision only records the decision.
- When preparation itself stops on a finding (nothing prepared yet), **Keep** / **Get ready anyway** continue that
  preparation.
- When a **later check finds that posting open and unchanged** (or only trivially different, or back to what was
  prepared from), the finding is settled and nothing is left to decide. The application's stored sentence becomes
  "The posting is open again, so this application can be prepared now." and the notice offers **Prepare now** in the
  application drawer and in the review dialog. It is the ordinary resume (one click, queued once, no package exists
  that could be lost); nothing prepares by itself, not even when the dialog's own check found it. The same button
  stays available if a still later check merely cannot reach the posting, because that does not undo the earlier
  open answer. While a closed or changed finding is still undecided, **Prepare now** is never offered, and a resume
  that bypasses the buttons stops again at the finding with no AI work.

## Freshness, validators and observation time

- **Freshness window: 24 hours.** A stored finding younger than that is reused. Its displayed time is the time the
  posting was actually contacted, never the time it was reused.
- **"Could not check" is retried after 15 minutes**, or at once on **Check again**. Inability is never fresh proof.
- **Conditional requests.** Greenhouse and Lever go through the shared HTTP cache, which sends the stored
  `ETag`/`Last-Modified`; a 304 confirms "unchanged" at the time of that request. Workable and Jobgether keep their
  existing no-store policy, so the app sends the validators it stored itself and treats a 304 as "unchanged since
  the last read".

## What is stored (workspace database, table `application_posting_verifications`)

Per application: when it was observed, the source, a host/route label (no ids), the outcome and a stable reason
code, the HTTP status, a hash of the normalized posting text, a per-application content version (the text the work
was prepared from is version 1), the hash it was compared against, the deadline the posting states with the
sentence it came from, the validators, a short change summary (at most 6 lines of 240 characters each way, plus
whether it is a requirement or text change), the person's decision, and, while a package is held, its previous
checkpoint, detail and prepared answers. Nothing about the person's CV or profile is sent by the check.

Retention and lookup:

- Rows are looked up through an index on `(attempt_id, observed_at)` (migration 0035).
- At most 12 rows per application are kept, plus every row that records a decision, holds a package or is the
  newest answer; repeating the same answer refreshes its row instead of adding one (even with "could not check"
  rows in between). Pruned rows can make a later re-seen text get a new, higher content version.
- A changed posting's full text (capped at 120,000 characters) is kept **only while nobody has decided about it**,
  so a refresh needs no second request. It is cleared on Keep, on Get ready anyway, when a newer answer supersedes
  it, and on Refresh (the text is then the application's job description; the hash and version stay as provenance).
- Rows are deleted with their application.

A **deadline** is recorded only when the posting text states one. A missing deadline is "the posting states no
deadline"; it is never derived from a posted date or from when the job was first seen. A passed stated deadline is a
warning, not a closure.

## Submitted applications are immutable

Applications that were submitted, reported as applied, are submitting, unconfirmed or skipped are never checked, never
refreshed, never held and never written to by this feature. Their job description, hash and documents stay exactly as
sent even when the live posting later changes or closes.

## Interruption and overlap

- Overlapping prepare, resume and check requests for one application share **only the network request**. Each
  caller then judges and records the result under its own step, permissions and liveness, so a renderer check can
  never make a preparation run lose its result or stall; a forced check that joins a request in flight receives that
  live answer, never a stored one.
- The result is written only if the application is still at the step that asked for it, so a cancelled, skipped or
  abandoned preparation records nothing; an observation older than the stored one never replaces it.
- A verifier that throws or never answers is "could not check" (`check_failed` / `timeout`); preparation continues.

## Limits

- A closed posting behind a sign-in, a denial or an unsupported source is not detected.
- Only the four sources above can be checked automatically.
- Requirement detection is a token and section heuristic. A requirement change worded with no requirement signal,
  outside a requirements section, and under a fifth of the posting is not flagged; unusual employer copy using
  requirement words (for example "salary" in a blurb) can be flagged.
- A source whose list text differs systematically from its single-posting text could show a change that is not one.
  The result is a prompt to decide, never a silent overwrite and never a closure.
- Requirement mappings and CV tailoring cases that were created outside an application are not invalidated.
- Measurement on synthetic fixtures only; see the pull request. No real-world closure rate, latency or quality is claimed.
