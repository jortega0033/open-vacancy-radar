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
| The person presses **Check again** | A forced check, regardless of the window. |

Searching never checks postings. There is no whole-feed refresh, no browser crawling and no scheduled recheck.

## Which postings can be checked

Only links with an official, read-only single-posting route on a job-board host the app already reads:

| Source | Route (one GET) |
| --- | --- |
| Greenhouse | `boards-api.greenhouse.io/v1/boards/{board}/jobs/{id}` |
| Lever | `api.lever.co` or `api.eu.lever.co` `/v0/postings/{site}/{id}` |
| Workable | `apply.workable.com/api/v2/accounts/{account}/jobs/{id}` (an account-less short link needs one extra redirect lookup) |
| Jobgether | `jobgether.com/astroapi/offer/{id}.json` |

Every other link costs **no request**: it is reported as "could not check" and the person is offered
**Open the posting** so they can look themselves. No new source, host or permission is added; every request goes
through the shared safe HTTP client (public-address check, origin boundary, size cap, timeout) with no retries.

## The four outcomes

| Outcome | Meaning | What the app does |
| --- | --- | --- |
| Confirmed open | The posting was returned and is not materially different from the text the work was prepared from. | Reuses all existing work. One quiet line, no extra screen. |
| Confirmed closed | The posting's job system said it does not exist (HTTP 404/410, Workable's `/oops`, or an explicit closure notice in the first 240 characters of the posting text). | Stops before any AI work and shows a warning with **Open the posting**, **Get ready anyway** and **Check again**. |
| Materially changed | The posting is open but a requirement, location, pay, language or similar line changed, or at least a fifth of it was rewritten. | Takes a prepared package out of review, shows what changed, and waits for **Refresh from the updated posting** or **Keep my application**. Nothing is overwritten until the person chooses. |
| Could not check | Timeout, 401/403/login wall, rate limit, server error, network failure, off-site redirect, unreadable answer or an unsupported source. | Preparation continues on the stored text. The notice says this does **not** mean the posting is closed, and offers **Check again** and **Open the posting**. |

A failed attempt to read a posting is never treated as proof that it closed, is never retried through another route,
and never tries to get around a denial or a sign-in.

Cosmetic changes (markup, whitespace, capitalization, punctuation) and one- or two-character wording fixes with
unchanged numbers are not material. A change from "five" to "eight" is.

## Freshness, validators and observation time

- **Freshness window: 24 hours.** A stored finding younger than that is reused. Its displayed time is the time the
  posting was actually contacted, never the time it was reused.
- **"Could not check" is retried after 15 minutes**, or at once on **Check again**. Inability is never fresh proof.
- **Hard cap per check: 20 seconds**, one request (no retry ladder).
- **Conditional requests.** Greenhouse and Lever go through the shared HTTP cache, which sends the stored
  `ETag`/`Last-Modified`; a 304 confirms "unchanged" at the time of that request. Workable and Jobgether keep their
  existing no-store policy, so the app sends the validators it stored itself and treats a 304 as "unchanged since
  the last read".

## What is stored (workspace database, table `application_posting_verifications`)

Per application: when it was observed, the source, a host/route label (no ids), the outcome and a stable reason
code, the HTTP status, a hash of the normalized posting text, a per-application content version (the text the work
was prepared from is version 1), the hash it was compared against, the deadline the posting states with the
sentence it came from, the validators, and the person's decision. For a materially changed posting only, the
changed text is kept so a refresh needs no second request. Nothing about the person's CV, profile or answers is sent
or stored by this check.

A **deadline** is recorded only when the posting text states one. A missing deadline is "the posting states no
deadline"; it is never derived from a posted date or from when the job was first seen. A passed stated deadline is a
warning, not a closure.

## Submitted applications are immutable

Applications that were submitted, reported as applied, are submitting, unconfirmed or skipped are never checked, never
refreshed and never written to by this feature. Their job description, hash and documents stay exactly as sent even
when the live posting later changes or closes.

## Interruption and overlap

- Overlapping prepare, resume and check requests for one application share one request and one result.
- The result is written only if the application is still at the step that asked for it, so a cancelled, skipped or
  abandoned preparation records nothing.
- An observation older than the stored one never replaces it, and a repeat of the same finding updates its time
  instead of adding a row.

## Limits

- A closed posting behind a sign-in, a denial or an unsupported source is not detected.
- Only the four sources above can be checked automatically.
- A source whose list text differs systematically from its single-posting text could show a change that is not one.
  The result is a prompt to refresh, never a silent overwrite and never a closure.
- Requirement mappings and CV tailoring cases that were created outside an application are not invalidated.
- Measurement on synthetic fixtures only; see the pull request. No real-world closure rate, latency or quality is claimed.
