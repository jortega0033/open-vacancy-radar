# Application target evidence register

This register records the terms and eligibility evidence behind *submitting* a job application
through a platform on a user's behalf, using an automated browser executor. It is the
submission-side counterpart to the [job source evidence register](job-source-evidence.md), and it
applies a deliberately higher bar: discovery reads a public page, submission takes a real,
irreversible action under the user's name and identity. It is not legal advice. Re-review every
entry when a platform's terms, help documentation, or application-form behavior changes, and
before any adapter-specific auto-fill or auto-submit code targets a platform for the first time.

Two structural findings shape this whole register and should be read before the table. First,
**most ATS vendors publish no applicant-facing terms of service at all.** What they publish is a
customer/subscription agreement binding the *employer*, plus a candidate *privacy* notice. A
candidate filling in a hosted application form is frequently bound by nothing the vendor has
published. That is not permission. Under `docs/job-source-policy.md` an uncertain-but-not-prohibited
*discovery* source falls back to linked-index mode; submission has no equivalent safe fallback, so
absent applicant-facing terms the entry is recorded as `insufficient_evidence` and stays ineligible
until a human reads the tenant's own posted terms. Second, **a terms review is not sufficient on its
own.** Greenhouse, Recruitee and SAP SuccessFactors document CAPTCHA or bot-scoring controls on the
application form itself. `docs/job-source-policy.md`'s existing hard stop on CAPTCHAs and technical
access challenges binds independently of what any terms document says, so a platform can be clean
on terms and still be non-viable in practice.

**On AI disclosure for applicants:** no platform in this register imposes a disclosure requirement
on applicants for AI-generated or AI-assisted application content in terms we were able to read. One
near-miss is worth recording rather than dismissing. Greenhouse publishes
[guidelines for AI use in interviews](https://www.greenhouse.com/guidelines-for-using-ai-in-our-interviewing-process)
stating that "If we determine in any stage of our interviews that AI is being used outside of the
guidelines below without disclosure or citation, your candidacy may be disqualified" -- but that
document explicitly scopes itself to Greenhouse's own hiring: "the principles and policies below
reflect the position of Greenhouse Software, Inc., as it relates to our own hiring. Customers who use
Greenhouse to power their talent acquisition processes are entitled to their own principles and
policies." So it is not a platform-wide rule, but it is a concrete precedent that an individual
employer on any of these platforms may impose one in its own posting. Workable's customer terms
address AI only from the employer side, requiring that "Outputs generated are reviewed by trained
human personnel before being relied upon for decisions that may materially affect candidates or
employees" -- nothing about applicants. The open ethics question #154 raised is therefore not
resolved by any platform's terms and remains a product decision, not a compliance one.

| Platform | Automation/bot prohibition found? | Guest application offered? | Rate-limiting/abuse detection documented? | AI-disclosure requirement for applicants? | Evidence (real URLs) | Recommended status | Reviewed |
| --- | --- | --- | --- | --- | --- | --- | --- |
| **Ashby** | No, but no applicant-facing terms exist to search. Only a customer agreement, which binds the employer and contains no automation clause. | Not vendor-documented either way. | Yes. Privacy policy documents fraud signals: "technical signals such as IP address characteristics, connection method, device and browser information, and contact information validity, which we use to help detect and prevent fraudulent activity". Customer ToS defines the Service as including "fraud detection and prevention services". | No explicit requirement found. | [Customer Terms of Service, updated 2025-09-29](https://www.ashbyhq.com/resources/terms); [Privacy Policy, updated 2025-09-24](https://www.ashbyhq.com/resources/privacy) | `insufficient_evidence` | 2026-09-04 |
| **Greenhouse** | No. The [Master Subscription Agreement](https://www.greenhouse.com/master-subscription-agreement) (effective 2026-02-01) binds "Customer" only; the [legal index](https://www.greenhouse.com/legal) lists no candidate-facing terms document, only privacy and CCPA notices. | Yes, explicitly documented: "Creating a MyGreenhouse account is optional. Candidates can continue to apply to your organization's roles in the same ways they always have, with or without a MyGreenhouse account." | Yes, extensively. Invisible reCAPTCHA "analyzes activity on a job post, like mouse movements and typing patterns, to determine if a user is a robot", and is "automatically built into careers page integrations options 1-4". Fraud Detection analyzes "a candidate's phone number, email address, location, and IP address", treating signals such as "the IP address being linked to a data center" as high risk. | No platform-wide requirement. See the AI-disclosure paragraph above for the Greenhouse-only precedent. | [Legal index](https://www.greenhouse.com/legal); [MSA](https://www.greenhouse.com/master-subscription-agreement); [MyGreenhouse candidate portal](https://support.greenhouse.io/hc/en-us/articles/28688386131739-MyGreenhouse-candidate-portal); [Invisible reCAPTCHA](https://support.greenhouse.io/hc/en-us/articles/115005448066-Invisible-reCAPTCHA); [Fraud Detection](https://support.greenhouse.io/hc/en-us/articles/42738009117467-Fraud-Detection) | `eligible_for_review`, but see blocking note below the table | 2026-09-04 |
| **Lever** | No, but the only terms located are customer-facing: "These Terms of Service govern a customer's acquisition and use of Lever, Inc." No applicant-facing terms found. | Not confirmed. Lever's help center article on career site options failed to render on fetch, so no vendor documentation was obtained. | Nothing documented found. | No explicit requirement found. | [Terms of Service, updated 2023-08-25](https://www.lever.co/agreements/tos/); [mirror](https://www.lever.co/legal/terms-of-service/) | `insufficient_evidence` | 2026-09-04 |
| **Personio** | Undetermined. `https://www.personio.com/terms/` returned HTTP 429 on every attempt in this pass; search indexing indicates it is a customer subscription GTC for "web-based personnel administration and recruiting software", not an applicant document. | Probably yes, not confirmed from a fetched vendor page. Career-page documentation describes candidates applying via an application form that creates a candidate profile on submission, with default fields name, email, phone, documents. The support article fetch returned HTTP 403. | Nothing documented found. | No explicit requirement found. | [General Terms & Conditions](https://www.personio.com/terms/) (not retrievable, HTTP 429); [Set up the Personio career page](https://support.personio.de/hc/en-us/articles/8758636857629-Set-up-the-Personio-career-page) (not retrievable, HTTP 403) | `insufficient_evidence` | 2026-09-04 |
| **Recruitee (Tellent)** | No explicit bot/scraper clause. Broad clause only, Article 2.3 Illegitimate Use: "Any fraudulent, abusive, improper or unauthorized use of the Services or use in violation of the Agreement may be reason for Tellent... to suspend, terminate or cancel Subscriber's right to use the Services." Binds Subscribers; reaches candidates only indirectly. | Yes, no candidate account documented as required. Default required application fields are name, phone, email, CV. The careers-site API documents that creating a candidate "is like a candidate applying for a job". | Yes, per-tenant opt-in. Invisible CAPTCHA "runs in the background of your site and assesses whether or not a user is a potential threat. If so, a CAPTCHA challenge will be displayed once the user tries to submit an application form", and "effectively block[s] bot traffic". | No explicit requirement found. | [Terms & Conditions, last modified 2026-06-15](https://recruitee.com/terms); [Add CAPTCHA to your application forms](https://support.recruitee.com/en/articles/6929909-add-captcha-to-your-application-forms); [Careers Site API](https://docs.recruitee.com/reference/intro-to-careers-site-api) | `eligible_for_review`, with two caveats below | 2026-09-04 |
| **SmartRecruiters** | Partial and ambiguous. The one genuinely applicant-facing ToS in this register prohibits candidates from "Use automatic means to access content or data from other users", "Harvest, collect, gather or assemble information or data regarding other users without their consent", and "Access or use Your Candidate Portal and our services in any manner that could damage, disable, overburden or impair any SmartRecruiters server". The automation clause is scoped to *other users'* data and does not on its face reach automating one's own application; the overburden clause does bite on submission volume. | Employer-configurable, not guaranteed. Some employers permit guest application, others require account registration; the terms describe a Candidate Portal registered after applying. No blanket vendor guarantee either way. | Only the overburden clause above. No CAPTCHA or velocity limit documented. | No explicit requirement found. | [Candidate Terms of Use, updated 2019-05-14](https://www.smartrecruiters.com/legal/terms-of-use/); [dated version](https://www.smartrecruiters.com/legal/terms-of-use/may-14-2019/); [legal index](https://www.smartrecruiters.com/legal/) | `insufficient_evidence` | 2026-09-04 |
| **SAP SuccessFactors** | Yes, strongly indicated but not directly verified. SAP's website terms prohibit accessing SAP Websites "using any automated data gathering or extraction methods designed to scrape or extract data from SAP Websites (such as bots, scrapers, spiders, crawlers, Model Context Protocol (MCP), agent-frameworks, or any other text and data mining technology)". Direct fetch returned HTTP 403 twice; text is corroborated by two independent search-index extracts. Whether "SAP Websites" reaches customer-hosted career sites is not established. | **No.** SAP KB 2835999 records that there is currently no way to apply without the candidate either signing into an existing account or creating one. | Yes. SAP KB 2082087 documents Google reCAPTCHA on the external career site: "CAPTCHA is a tool that helps to distinguish a human user from a bot, hacker, or any other automated attack." | No explicit requirement found. | [Terms of Use for SAP Websites](https://www.sap.com/about/legal/terms-of-use.html) (direct fetch blocked, HTTP 403); [KB 2835999, applying without signing in](https://userapps.support.sap.com/sap/support/knowledge/en/2835999); [KB 2082087, CAPTCHA for External Career Site](https://userapps.support.sap.com/sap/support/knowledge/en/2082087); [career-site guidance](https://help.sap.com/docs/successfactors-recruiting/setting-up-and-maintaining-sap-successfactors-recruiting/career-sites-for-sap-successfactors-recruiting) | `blocked_requires_login` | 2026-09-04 |
| **Teamtailor** | No applicant-facing prohibition. The T&C bind "Customer" and its "Users" and prohibit them from "violate the restrictions on the Service, work around, bypass or circumvent any of the technical limitations" and from monitoring "the Service availability, performance or functionality for any competitive purpose". No applicant-facing terms located. | Not vendor-confirmed. The Connect talent pool does require profile creation via Facebook, LinkedIn or email, but Connect is not the job application path, and no vendor page confirms application without an account. | Yes, rule-based rather than challenge-based. Spam filter rules auto-flag or auto-discard applications matching spam domains and addresses, with "a set of default rules... added based on email domains and email addresses historically identified as spam in Teamtailor". No CAPTCHA documented. | No explicit requirement found. | [Terms and conditions, updated 2026-05-02](https://www.teamtailor.com/en/terms-and-conditions/); [Spam filter rules](https://support.teamtailor.com/en/articles/11785160-spam-filter-rules) | `insufficient_evidence` | 2026-09-04 |
| **Workable** | No. Applicant-facing job-board terms exist and were read in full; the closest clause prohibits users from "create computer viruses or implement any form of software or scripts onto the Website", which addresses malicious code rather than automated access. Customer T&C are separate and contain no bot clause. | Yes, explicitly stated in the applicant-facing terms, section 2.1: "You can easily use the Job Board without creating any Account. You can search or identify job opportunities and apply by submitting Your personal information". | Nothing documented found. | No. Customer terms address employer-side AI review only, quoted in the AI paragraph above. | [Job board terms for job seekers, updated 2023-09-21](https://jobs.workable.com/terms); [Customer Terms and Conditions, updated 2026-03-02](https://www.workable.com/terms) | `eligible_for_review`, with the scope caveat below | 2026-09-04 |
| **Workday** | **Yes, explicit and directly on point.** Site Terms prohibit: "Use any data mining, robots or similar data gathering or extraction methods designed to scrape or extract data from our Sites"; "Develop or use any applications that interact with our Sites without our prior written consent"; "Bypass or ignore instructions contained in our robots.txt file". The second clause covers a browser executor regardless of whether any data is extracted. | Tenant-configurable, and frequently no. Workday documents that organizations "can require Candidate Home accounts for all job applications" via tenant setup. | Not separately documented beyond the terms above. | No explicit requirement found. | [Terms of Service, updated 2026-08-13](https://www.workday.com/en-us/legal/site-terms.html); [Set Up Candidate Home Accounts](https://doc.workday.com/admin-guide/en-us/human-capital-management/recruiting/career-sites/gtv1538650489786.html) | `prohibited` | 2026-09-04 |
| **LinkedIn** | **Yes, explicit.** User Agreement section 8.2 prohibits members from: "Use bots or other unauthorized automated methods to access the Services, add or download contacts, send or redirect messages, create, comment on, like, share, or re-share posts, or otherwise drive inauthentic engagement", and "Develop, support or use software, devices, scripts, robots or any other means or processes (such as crawlers, browser plugins and add-ons or any other technology) to scrape or copy the Services, including profiles and other data". | Not applicable. Easy Apply requires an authenticated LinkedIn account, so the flow would require credential entry, independently prohibited by #154 guardrail 2. | Not applicable, the platform is excluded. | Generative AI features clause tells members to "review and edit such content before sharing with others", but imposes no applicant disclosure duty. | [User Agreement, effective 2025-11-03](https://www.linkedin.com/legal/user-agreement); carried forward from #32 | `prohibited` | 2026-09-04 |

## Blocking notes that survive a clean terms review

- **Greenhouse.** Terms eligibility is the clearest of any platform here, and guest application is
  documented. It is still not enableable as things stand: invisible reCAPTCHA is on by default for
  four of the careers-page integration options, and driving an automated submission through it is
  circumventing a technical access challenge, which `docs/job-source-policy.md` hard-stops
  regardless of terms. The fraud-detection scoring treating a data-center IP as a high-risk signal
  is a second, independent reason an automated submission may be silently discarded rather than
  delivered, which would leave the user believing they applied when they did not.
- **Recruitee.** Two caveats. The CAPTCHA is per-tenant opt-in, so eligibility cannot be decided
  once for the platform and must be detected per employer at runtime, with the presence of a
  challenge treated as a stop rather than an obstacle. Separately, the Article 2.3 "abusive,
  improper or unauthorized use" clause is broad enough that automated submission is plausibly
  within it; that reading has not been tested and warrants a legal read before enabling.
- **Workable.** The applicant-facing terms that make this the strongest candidate govern
  `jobs.workable.com`, Workable's own job board. Many Workable vacancies are applied to through
  tenant-hosted forms on `apply.workable.com` or an employer's own domain, and it is not
  established that the same job-seeker terms attach there. Confirm the governing document per
  application host before treating a Workable target as reviewed.
- **SAP SuccessFactors.** Recorded as `blocked_requires_login` on the guest-application finding
  alone, which is dispositive under #154 guardrail 2. If SAP's website terms are later confirmed to
  reach customer career sites, this becomes `prohibited` and should be moved.
- **Workday.** The `prohibited` status rests on the Site Terms clause about developing or using
  applications that interact with Workday's Sites. Those terms do not explicitly enumerate
  `*.myworkdayjobs.com`, so the scope is technically ambiguous. Under this register's bar,
  ambiguity about an explicit prohibition resolves against automation, not for it. Note also that
  Workday's separate [End User Agreement](https://www.workday.com/en-us/legal/end-user-agreement.html)
  carries even stronger anti-automation language, but the fetched document referenced
  `scoutrfp.com` and its applicability to career sites is doubtful; it is recorded here for
  completeness and should not be relied on as the controlling citation.

## Adding a platform to this register

Recording an entry here is a blocking prerequisite for any auto-fill or auto-submit code targeting
a platform, per #154 guardrail 6. It is not a one-time audit. To add a platform:

1. Locate and fetch the terms that bind a **candidate**, not the employer customer. A
   customer/subscription agreement with no automation clause is not evidence of permission; record
   it as absent applicant-facing terms and stop at `insufficient_evidence`.
2. Search the fetched text for "automated", "bot", "script", "robot", "scrape", "crawl", "spider".
   Record verbatim quotes and the effective date, not a paraphrase.
3. Establish whether guest application is offered from vendor documentation, not from observed
   behavior on one tenant. Anything requiring account creation is `blocked_requires_login`, since
   credential entry stays absolutely prohibited.
4. Record documented CAPTCHA, bot-scoring, spam-filtering or velocity controls. Where nothing is
   documented, write that nothing is documented rather than inferring absence.
5. Check for an applicant AI-disclosure requirement, and record "no explicit requirement found"
   when none exists.
6. Resolve every ambiguity against automation. Set `insufficient_evidence` and require a named
   human re-review before the platform can move to `eligible_for_review`.
7. Re-review on any change to the platform's terms, help documentation, or application-form
   controls, and at minimum every six months.

## Platforms without high-confidence evidence

Flag these honestly rather than treating them as reviewed:

- **Ashby** -- no applicant-facing terms exist to read; guest application unconfirmed.
- **Lever** -- no applicant-facing terms found; help-center page failed to render, so guest
  application is unverified.
- **Personio** -- terms page returned HTTP 429 on every attempt and the career-page support
  article returned HTTP 403. Nothing about Personio was verified by direct fetch in this pass.
- **SmartRecruiters** -- terms were read, but the automation clause's scope is genuinely ambiguous
  for the submission use case, and guest application is employer-configurable with no vendor
  guarantee.
- **SAP SuccessFactors** -- the SAP website Terms of Use could not be fetched directly (HTTP 403 on
  three attempts, three different regional paths); the quoted automation clause rests on two
  independent search-index extracts, not a first-hand read. KB 2835999 likewise came from search
  metadata, not a successful fetch. The `blocked_requires_login` status is safe regardless, but the
  prohibition finding needs a human to open that page.
- **Teamtailor** -- no applicant-facing terms found; guest application unconfirmed.
- **Workday** -- the prohibition text is first-hand and solid, but its applicability to
  `*.myworkdayjobs.com` career sites is not stated in the document.

Greenhouse, Workable and LinkedIn are the three entries where the controlling document was fetched
first-hand, is genuinely applicant-facing (or, for Greenhouse, confirmed absent from a fetched
legal index), and answered the question directly.
