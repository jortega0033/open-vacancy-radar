# Company evidence (#689)

A local record of public facts about an employer, each with its source, scope, observation time and expiry, reused
by cover-letter preparation and by "Prepare interview". It is kept apart from your CV and from every application note.
Part of #683. The application brief (#688) and further interview work (#691) can read the same record later; neither is
needed for this to work, and neither is built here.

## What is stored, and under what key

| Table | Holds |
| --- | --- |
| `company_evidence_records` | One employer, keyed by a **verified** identity plus an optional entity reference you typed. |
| `company_evidence_facts` | Claim text, source URL, scope (company or one role), topic, a quote from the page, retrieval time, observation time, **expiry**, verification state, origin, correction provenance. |
| `company_evidence_contradictions` | Two active claims about the same single-answer topic that disagree. |
| `company_evidence_identity_links` | A proposed, confirmed or rejected link between two look-alike employers. |
| `application_attempt_evidence_uses` | What a prepared letter actually said about the employer. No link to the fact, so editing or deleting evidence later never rewrites it. |

A record is keyed by one of: the ATS account named in the vacancy's own apply link (`ats:greenhouse:northwind`), the
employer's own host when the posting is hosted on a domain recognisably the company's (`host:northwind.example`), or a
website you confirmed (`domain:northwind.example`). A company **name** is never a key. A name match in a public
register (for example the IND recognised-sponsor list) is not an identity and never proves sponsorship for a role.

Look-alike names with different domains get separate records and share nothing. When a second look-alike record is
created the app **proposes** a link; only after you confirm it do the other employer's *company-level* claims appear
(labelled with where they came from). Role claims never cross a link, and a rejected link shares nothing.

## When a claim may enter a letter or interview prep

All of these must hold at the moment of use (`selectProseEvidence`, run in the main process for letters and again in the
renderer for the interview prompt):

1. The employer is verified (above).
2. The claim has a confirmed source: either the app fetched the page and found the quoted passage (`source_confirmed`),
   or you pressed **I read the source** (`user_confirmed`, recorded as yours).
3. It has not expired. Company claims are valid for 90 days from the observation, role claims for 14. The expiry is
   written when the evidence is observed. Nothing extends it except a successful re-fetch of the source that finds the
   quote again, or an explicit **I read the source** by you.
4. It has no open contradiction.
5. A role claim belongs to *this* role. A sponsorship claim must be about the role and come from the employer or its job
   posting.
6. The source is a credential-free https address, and is not a register name match.

Anything else is a **lead**: visible in the panel with the reason, never sent to a model as fact. A letter built with no
evidence is byte-identical to one built before this feature.

## What runs, when

| Action | Network | Profile | Bound |
| --- | --- | --- | --- |
| Reading the panel, preparing a letter, building interview prep | none | `no-network` drafting sessions | local store only |
| **Add a source yourself** | one safe fetch of the page you named, to look for your quote | shared safe HTTP client (public addresses only, origin-locked redirects, no cache, no retries, 20 s) | 1 request |
| **Check sources again** | one safe fetch per non-current claim | same | at most 8 claims, cancellable |
| **Research this company** | one `web-only` Claude session (WebSearch and WebFetch only) plus the app's own fetch of each cited page | the existing `/sessions/vacancy-web-discovery` route | 4 searches, 6 fetches, 60 s, 6 claims, cancellable |

Research is Claude-only because that is what the existing web-only route supports; nothing else is claimed. If Claude
Code is not installed or not signed in, research says so and the rest keeps working.

The research prompt is built from a type that carries only the company name, its verified host, the public role title and
topic names. A CV, letter, note or candidate profile has no path into it, into the model's queries, or into the stored
diagnostics (status code, counts and the model's public queries). What the model returns is never authority: each claim is
stored as a lead and only becomes supported if the app's own fetch finds the quoted passage on the cited page.

A current, confirmed claim for every requested topic is a **cache hit**: no session, no request, and the original
retrieval time stays visible. A failed, blocked, timed-out or cancelled refresh changes neither `retrievedAt` nor
`expiresAt`. A source that no longer contains the quote demotes the claim to an unconfirmed lead.

Stopping or failing research or a refresh writes nothing and leaves every prepared draft as it was.

## Retention and reset

- Facts per record are capped at 80. Pruning removes withdrawn and replaced claims first, then the oldest expired or
  unconfirmed ones, and never a current supported claim or one in an open disagreement. A record left with no claims and
  no reviewed link is deleted.
- **Delete company evidence** (panel) removes one employer's record, claims, disagreements and links.
- **Settings > Advanced > Reset application data** deletes all five tables and reports the counts. It first cancels any
  research or refresh in flight; a result that finishes later finds no record and writes nothing.
- Deleting an application attempt removes its "what the letter used" snapshot with it. Deleting or correcting evidence
  never touches a prepared package, its documents or that snapshot.

## Limits

- The daemon cannot intercept a tool call before it runs, so the research budget cancels the session and discards its
  output; it cannot prevent the call. Loopback and private-network `WebFetch` targets remain an open question documented
  in `vacancy-web-discovery.ts`.
- Role-scoped claims are never reused across roles, so role-level facts always need their own source.
- No third-party company database, employee scraping, credential use, culture or sentiment score, or automatic profile
  edit exists here.
