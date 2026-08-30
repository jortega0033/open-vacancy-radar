# Job source policy

Open Vacancy Radar exists to put as many current, directly actionable vacancies as possible in
front of job seekers. Coverage is therefore a product requirement, not an optional enrichment.

## Default decision: integrate

Implement a source when it exposes vacancies through a lawful, publicly accessible interface that
can be consumed without defeating a technical or contractual restriction. Engineering complexity
can change implementation order, but it is not by itself a reason to permanently reject useful
coverage.

Prefer sources in this order:

1. official public APIs, XML/RSS/Atom feeds, and published datasets;
2. public ATS endpoints intended to power employer career pages;
3. employer-owned sitemaps and schema.org `JobPosting` data;
4. bounded static HTML from public career pages when permitted;
5. a browser worker only when the source permits automation and structured/static access cannot
   recover the vacancies.

Python or another runtime is acceptable when measured unique coverage justifies its packaging and
maintenance cost. Every runtime must feed the existing normalization and persistence path.

Use the broadest lawful mode supported by the evidence:

1. **Full ingestion** for interfaces with explicit reuse/open-data permission.
2. **Linked index** for public vacancy interfaces with no prohibition but unclear republication
   rights. Source text may be processed and retained locally only as needed for matching; user-facing
   indexes and generated reports must publish factual metadata, attribution, and the canonical
   listing link rather than mirror the source description.
3. **Hard stop** only for an explicit prohibition, an authentication or partner boundary, a
   conflicting crawl rule, a technical access challenge, or another concrete legal restriction.

## Stop boundary

Never bypass authentication, paywalls, CAPTCHAs, access controls, IP blocks, or a source's explicit
automation prohibition. Never use private user cookies, credential extraction, residential proxies,
or fingerprint evasion to turn a blocked source into an available one. A `401`, `403`, `407`, `451`,
or equivalent denial is evidence to stop and classify the source, not an invitation to evade it.

Before enabling a source by default, record its operator-controlled documentation or other evidence
that the interface is public, plus any published terms, attribution, retention, robots, and rate-limit
requirements. Permission uncertainty without a prohibition uses linked-index mode; it does not erase
otherwise useful vacancies. Credentialed and partner interfaces remain `configuration_required` or
`partner_required`, and explicit prohibitions remain `prohibited`.

Current reviewed decisions live in the [job source evidence register](job-source-evidence.md).

## Connector requirements

Every production connector must:

- declare `full_ingestion` or `linked_index` in the source registry or ATS capability catalog, and
  link the controlling documentation used for that decision;
- use the existing safe HTTP boundary, including redirect, response-size, cancellation, cache,
  retry, and `Retry-After` handling;
- send the project user agent, pace requests conservatively, and obey published rate limits and
  crawl rules;
- preserve the source and employer's direct application URL and expose source attribution;
- normalize through the existing vacancy model and deduplicate through existing identity rules;
- distinguish complete, partial, empty, malformed, blocked, and transient outcomes;
- remove or deactivate vacancies that the authoritative source no longer publishes;
- isolate failure so one unavailable source cannot block other source scans;
- ship with hermetic fixtures for valid, empty, malformed, duplicate, bounded, and failure cases;
- avoid collecting applicant data or storing response bodies, query strings, cookies, or secrets in
  diagnostics.

Live smoke tests are opt-in. Normal tests and CI must never depend on an external source being
reachable.

## Coverage review

Source gaps should be ranked by unique, valid vacancies missed for the target markets. The next
integration batch should favor the greatest user impact while keeping the stop boundary above
absolute. Aggregators can supply discovery leads, but direct employer or ATS URLs are preferred for
display and canonical identity whenever available.
