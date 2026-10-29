# Company evidence (#689)

A local record of public facts about an employer, each with its source, scope, observation time and expiry, reused
by cover-letter preparation and by "Prepare interview". It is kept apart from your CV and from every application note.
Part of #683. The application brief (#688) and further interview work (#691) can read the same record later; neither is
needed for this to work, and neither is built here.

**Who uses it.** Exactly two consumers: the cover letter this app prepares for an application attempt (unattended
preparation) and the "Prepare interview" prompt. The Letters page and the CV assistant do not use company evidence.

## What is stored, and under what key

| Table | Holds |
| --- | --- |
| `company_evidence_records` | One employer, keyed by a **verified** identity plus an optional entity reference you typed (a registration number or legal name, to tell apart two employers that share a domain). |
| `company_evidence_facts` | Claim text, source URL, scope (company or one role), topic, a quote from the page, retrieval time, observation time, **expiry**, verification state, origin, correction provenance (first wording and the passage it rested on). |
| `company_evidence_contradictions` | Two active claims about the same single-answer topic that disagree, within one record or across a confirmed identity link. |
| `company_evidence_identity_links` | A proposed, confirmed or rejected link between two look-alike employers. |
| `application_attempt_evidence_uses` | What a prepared letter actually said about the employer. No link to the fact, so editing or deleting evidence later never rewrites it. |

A record is keyed by one of:

- **`ats:<provider>:<board>`** -- the ATS account in the vacancy's own apply link, recognised with the same exact host
  rules as application identity (the host must *be* `greenhouse.io`, `lever.co`, ... or a subdomain of it; the board is
  taken from where that provider really puts it: the first path segment, or the subdomain for Recruitee, Personio,
  Teamtailor and Workday). This identifies the **posting**, not the employer's website: an ATS identity has no website.
- **`host:<registrable domain>`** -- the posting's own domain, only when its registrable label **is** the company name
  (separators removed, optionally without a trailing legal form such as "B.V." or "Inc"). A prefix or superstring
  (`Apex` vs `apexlegends.example`, `Acme` vs `acme-recruiting.example`) is a near miss: it stays unverified and is only
  offered to you as a suggestion.
- **`domain:<registrable domain>`** -- a website you confirmed, **for that vacancy**: the confirmation is bound to the
  application and the posting address it was made for. Another vacancy that only shares the name is not affected; it
  is shown the domain as a suggestion and nothing is shared until you confirm it there too.

Registrable domains come from the Public Suffix List (the `tldts` library, including its private section). A public
suffix (`co.uk`), an IP address, a job board or ATS domain, and any host under a shared-hosting suffix (`github.io`,
`blogspot.com`, `herokuapp.com`, `vercel.app` and the rest of the list) are refused as an employer domain, and a page
there never counts as the employer's own source. Credentials in a URL and non-default ports are refused too.

A company **name** is never a key. A name match in a public register (for example the IND recognised-sponsor list) is
not an identity and never proves sponsorship for a role.

Look-alike names with different domains get separate records and share nothing. When a second look-alike record is
created the app **proposes** a link; only after you confirm it do the other employer's *company-level* claims appear
(labelled with where they came from). Links are pairwise, never transitive; role claims never cross a link, and a
rejected link shares nothing. When two linked records answer the same single-answer topic differently (450 vs 9000
employees), **both** become leads and the disagreement is shown until you choose; revoking the link undoes a choice
that depended on it.

## When a claim may enter a letter or interview prep

All of these must hold at the moment of use (`selectProseEvidence` in the main process; the letter path checks again
after the drafting session returns, see below):

1. The employer is verified (above).
2. The claim has adequate support. Either:
   - **Quoted passage found** (`source_confirmed`): the app fetched the page and found the quoted passage, **and** the
     claim is worded from that passage (`assessQuoteSupport`, below); or
   - **You confirmed** (`user_confirmed`): you pressed *I read the source*, recorded as your own attestation.
3. It has not expired. Company claims are valid for 90 days from the observation, role claims for 14. The expiry is
   written when the evidence is observed. Nothing extends it except a successful re-fetch of the source that finds the
   quote again (for a claim that still passes the floor), or an explicit *I read the source* by you.
4. It has no open contradiction (including one across a confirmed link).
5. A role claim belongs to *this* role.
6. **Sponsorship**: a claim whose wording (claim *or* quote, English or Dutch: visa, sponsor, work permit, work
   authorisation, kennismigrant, highly skilled migrant, blue card / blauwe kaart, werkvergunning,
   tewerkstellingsvergunning, verblijfsvergunning, erkend referent, IND) is about sponsorship is treated as a
   sponsorship claim **whatever topic label it was given**. It must be about this role and come from the employer's
   own domain or its exact ATS tenant; a register entry or a random page never qualifies.
7. The source is a credential-free https address, and is not a register name match.

Anything else is a **lead**: visible in the panel with the reason, never sent to a model as fact. A letter built with no
evidence is byte-identical to one built before this feature.

### The quote floor (what "worded from the passage" means)

`assessQuoteSupport` is deterministic and deliberately strict. It is a **wording check, not semantic verification**: it
shows the claim was written from a passage that was found on the page, not that the page is right or that every
reading of the claim is true. A claim passes only when:

- every number or year in the claim is a number in the passage (`14` is not `140`; `12,000` = `12.000`);
- every content word of the claim occurs in the passage **in the same order** (light stemming only);
- negation (`not`, `no`, `n't`, `geen`, `niet`, ...) and qualifiers (`will`, `may`, `formerly`, `only`, `zal`, ...)
  agree between the claim and the part of the passage it was matched to;
- every capitalised name in the claim is in the passage. The employer's own name may be absent from the passage only
  when the passage speaks in the first person ("we", "our") and names no other organisation where the claim matched.

So boilerplate ("we are an equal opportunity employer") cannot carry an unrelated claim, a corrected number cannot
ride on the old passage, and "does not sponsor" cannot support "sponsors". A true paraphrase also stays a lead: copy a
passage that says it, or confirm you read it. The floor is applied on every read, before any fetch is spent, and by the
store itself before it records a confirmation or a renewal.

### Corrections

Correcting a claim keeps the first wording **and the passage it rested on** as provenance, but that passage no longer
supports anything: the claim becomes a lead with no active passage (`quote_missing`). It becomes usable again only when
you supply a passage from the page that says the corrected wording (checked by the floor and one safe fetch), or you
confirm you read it. "Check sources again" never re-fetches the old passage for the new wording, its observation time
and expiry are not moved by the correction, and a correction that lands while a check is in flight makes that check
stale (nothing is renewed).

### Letters: re-checked after drafting

The drafting session can run for a while. After it returns and **before** the letter is assembled, the app re-reads the
approved list and keeps a company fact the model selected only if the same fact is still approved with the same claim,
source, scope, verification and expiry. A fact withdrawn, corrected, expired, contradicted, unlinked or deleted in the
meantime is dropped from the letter and from its "used" snapshot (the letter is still prepared from your CV facts). If
the re-read fails, every company fact is dropped. A submitted attempt's snapshot is never rewritten.

## What runs, when

| Action | Network | Profile | Bound |
| --- | --- | --- | --- |
| Reading the panel, preparing a letter, building interview prep | none | `no-network` drafting sessions | local store only |
| **Add a source yourself** / correct with a new passage | one safe fetch of the page, only if the claim passes the floor | shared safe HTTP client (public addresses only, origin-locked redirects, no cache, no retries, 20 s) | 1 request |
| **Check sources again** | one safe fetch per non-current claim that passes the floor | same | at most 8 claims, one shared 45 s deadline, cancellable |
| **Research this company** | one `web-only` Claude session (WebSearch and WebFetch only) plus the app's own fetch of each cited page whose claim passes the floor | the existing `/sessions/vacancy-web-discovery` route | session: 4 searches, 6 fetches, 60 s, 6 claims; then page checks 3 at a time under one 30 s deadline (about 90 s in total); cancellable |

Closing the panel stops a research or check it started.

**What the budget can and cannot do.** The session's search and fetch counts are the app's own count of the tool
events the session reports. When a count goes over budget the app cancels the session and discards its output. The
daemon cannot intercept a tool call before it runs, so this is not a hard pre-call cap: a search or fetch that has
already started is not prevented. Loopback and private-network `WebFetch` targets of the model's own session remain an
open question documented in `vacancy-web-discovery.ts`. The app's **own** page checks are separate: they always go
through the shared safe HTTP client above.

Research is Claude-only because that is what the existing web-only route supports; nothing else is claimed. If Claude
Code is not installed or not signed in, research says so and the rest keeps working.

The research prompt is built from a type that carries only the company name, the employer's own verified website (if
known), for an ATS identity the job-board provider, board and public posting address (no query string), the public role
title and topic names. For an ATS identity the prompt says the employer's website is **unknown** and that the job-board
site hosts many employers; it never presents the ATS host as the company website. A CV, letter, note or candidate
profile has no path into the prompt, into the model's queries, or into the stored diagnostics (status code, counts and
the model's public queries). What the model returns is never authority: each claim is stored as a lead and only becomes
supported if it passes the floor and the app's own fetch finds the quoted passage on the cited page.

**Page checks are bounded.** A page larger than 3,000,000 characters is refused as `content_too_large` (never silently
truncated). Text is extracted by a single linear forward scan (no regular expression runs over the page): markup, runs
of `<`, unclosed `<script>` elements, deep nesting and malformed entities cannot make it slow, and each character
reference is decoded exactly once (`&amp;quot;` stays the literal text `&quot;`).

A current, confirmed **company-scope** claim for every requested topic is a **cache hit**: no session, no request, and
the original retrieval time stays visible (a role claim never satisfies a company topic). The in-app counts report only
what was observed: a research cache hit counts one session not started and does not guess how many pages it would have
opened; a refresh counts each current claim it did not re-fetch. A failed, blocked, timed-out or cancelled refresh
changes neither `retrievedAt` nor `expiresAt`. A source that no longer contains the quote demotes the claim to an
unconfirmed lead.

Stopping or failing research or a refresh writes nothing and leaves every prepared draft as it was.

## Retention and reset

- **Admission is bounded**: a record holds at most 80 active claims and 160 rows in total (replaced and withdrawn
  provenance included). A claim beyond that is refused with the stable code `record_full` (research stops adding and
  says so); nothing is silently kept over the limit. Withdrawn claims are deleted once nothing refers to them; when the
  row limit is reached the oldest expired or unconfirmed leads are pruned first. Current claims, claims in an open
  disagreement and replaced (decided) claims are never pruned. A record left with no claims and no reviewed link is
  deleted.
- **Delete company evidence** (panel) removes one employer's record, claims, disagreements, links and vacancy bindings.
- **Settings > Advanced > Reset application data** deletes all five tables and reports the counts. It first cancels any
  research or refresh in flight; a result that finishes later finds no record and writes nothing.
- Deleting an application attempt removes its "what the letter used" snapshot with it. Deleting or correcting evidence
  never touches a prepared package, its documents or that snapshot.

## Limits

- The quote floor is lexical. It cannot tell whether a page is accurate, and it keeps true paraphrases as leads.
- Role-scoped claims are never reused across roles, so role-level facts always need their own source.
- The entity reference is whatever you type; the app does not look it up in any register.
- No third-party company database, employee scraping, credential use, culture or sentiment score, or automatic profile
  edit exists here.
