# Source access desk research (spikes #50, #51, #52, #53)

Desk research done on 2026-10-05 from public pages only. Nobody was contacted, no credentials were used and no API calls were made. Every spike below needs a written answer from the data provider before it can be decided, so none of them is closed by this note.

Anything marked UNVERIFIED could not be confirmed from a page that was actually fetched.

## Summary

| Spike | Provider | Registry state | Ingestion | Decision |
|---|---|---|---|---|
| #50 | Job Market Finland | `partner_required` | `disabled` | Hold. Written KEHA approval needed. |
| #51 | VDAB (Belgium) | `partner_required` | `disabled` | Hold. Written VDAB answers needed, and VDAB says new applications are paused. |
| #52 | Jobnet (Denmark) | `partner_required` | `disabled` | Hold. Technical spec was unreachable. Written STAR answers needed. |
| #53 | France Travail | `configuration_required` | `disabled` | Hold. Nothing about terms could be verified. |

No implementation ticket should be opened for any of these until the provider confirms in writing that a locally installed, open-source desktop app is allowed.

## #50 Job Market Finland

Sources: the four official pages linked in the issue (overview, retrieval description, API terms, KIPA technical documentation).

Confirmed from the pages:
- Access runs through an activation form, KEHA Centre verification, test credentials, then production credentials.
- Endpoints are `https://api-qa.ahtp.fi/kipa/p67/v2/jobpostings` (test) and `https://api.ahtp.fi/kipa/p67/v2/jobpostings` (production).
- IP allowlisting is part of access control, with separate lists for test and production.
- Required attribution on every displayed job: "Source: Job Market Finland's customer information system".
- Postings must be kept current and removed immediately when needed. Removed postings may not be stored in a retrievable way.
- Forwarding postings to third parties needs separate permission.
- Data may not be used to advertise or market software or services based on the dataset without KEHA permission.
- No public price. Quotas, credential expiry and revocation: UNVERIFIED.
- Support addresses differ between two pages (`tmt-rajapinnat.keha@ely-keskus.fi` and `tmt-rajapinnat@keha-keskus.fi`). Confirm which is current before writing.

Open questions for KEHA:
1. Is OVR one approved e-service, or is each installation a third party?
2. How can credentials and allowlisted IPs work when users have changing home or office addresses?
3. Will KEHA grant a written exception under the software-marketing clause for a free open-source project?
4. Does production activation require Finnish organisation details?
5. Credential rotation, renewal and how allowlist changes are made.
6. Who is the data controller when the app runs on end-user devices.

## #51 VDAB (Belgium)

Sources: `werkgevers.vdab.be/data-uitwisseling` and the public parts of the VDAB extranet API pages. The developer portal itself returned 403.

Confirmed from the pages:
- Access is partner based: application form, exploratory meeting, approval, then a signed cooperation agreement.
- The data-exchange page says new applications cannot be submitted for now because of the number of requests.
- The Vacature API is free and requires VDAB to be named as the source.
- Credentials are an API key, with OAuth 2.0 mentioned for related APIs.
- Support: 0800 30 700 (weekdays) and a contact form on `werkgevers.vdab.be`.
- Quotas, exact attribution wording, cache window and deletion timing: UNVERIFIED.
- Whether individuals (not organisations) may apply: UNVERIFIED.

Open questions for VDAB:
1. Is a locally installed desktop app eligible, and can API keys be shipped or issued per user?
2. May data be stored locally, for how long, and how fast must closed vacancies be removed?
3. Is a full local snapshot allowed, or only live queries?
4. Quotas and burst limits.
5. Test credentials, sandbox, and approval timeline given the pause on new applications.
6. Any extra terms for public open-source repositories.
7. Is coverage Flemish only or all of Belgium?

## #52 Jobnet (Denmark, STAR)

Sources: the STAR overview page for the Jobnet WebService. The linked wiki page (`starwiki.atlassian.net`, JobannonceService) returned 404, so the technical contract could not be read.

Confirmed from the page:
- The service is free to use. New customers should expect their own development costs.
- It is meant for companies and organisations that import ads to show on their own job portal or website.
- Support contact: `spoc@star.dk`.
- Certificate type and setup, quotas, persistence and deletion rules, attribution: UNVERIFIED.

Open questions for STAR:
1. Does "own job portal or website" cover a locally installed open-source desktop app?
2. Which certificate is required, and may a desktop client store it?
3. Approval steps, test environment access and timeline.
4. How long may ads be stored locally, and what deletion duties apply?
5. Exact attribution text and canonical link rules.
6. Can a local app poll the JobannonceService export, or does it need a hosted callback endpoint?
7. Quotas, versioning and support level.

## #53 France Travail

Sources: `francetravail.io` pages, the `France-Travail` GitHub organisation and the Mobiville repository. The developer site renders with JavaScript, so fetching it returned no content, and the old `api.pole-emploi.io` host refused connections.

Confirmed:
- The job-offers API exists and is used by the Mobiville project.
- `pole-emploi.io` now redirects to `francetravail.io`.

Everything else is UNVERIFIED: access model, eligibility, OAuth client types, pricing, quotas, redistribution, caching, attribution and desktop distribution.

The only contact found is `sioss.00006@francetravail.fr`, which is listed on the GitHub organisation for open-source projects. It is not an API support address, so use the contact form on `francetravail.io` first and treat this one as a fallback.

Open questions for France Travail:
1. Who may register an application, and is a non-French open-source project eligible?
2. Price and quotas.
3. OAuth client types, and whether a client secret may be shipped in a desktop app.
4. May vacancy data be cached locally, and may descriptions be shown or only linked?
5. Required attribution and canonical link rules.
6. A current OpenAPI definition and the versioning policy.

## Next step

Send one written request per provider describing OVR as a free, open-source, locally installed desktop app with end-user data staying on the user's machine, and ask the questions above. Record the answers in the matching issue, then update the registry state and decide whether an implementation ticket makes sense.
