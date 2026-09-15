## Goal
Record the research findings on scraping Built In (builtin.com) as a vacancy source, and the resulting decision: **no adapter, blocked by Terms of Use, not just deferred for lack of implementation effort.**

## What was checked
- **`robots.txt`** (generic `User-agent: *` block, lines 39-211): individual job postings at `/job/<slug>/<id>` and bare listing pages (`/jobs`, `/jobs?page=N`) are *not* disallowed for generic crawlers -- only specific faceted/filtered listing URLs (by city, industry, seniority, etc.) are blocked. `/job/sitemap.xml` is explicitly disallowed, so bulk job-URL discovery has to go through the allowed `/jobs?page=N` listing pages instead of a sitemap.
- **Page structure:** individual job pages (`https://builtin.com/job/...`) are server-rendered and already embed `schema.org/JobPosting` JSON-LD (title, location, `MonetaryAmount` salary, `Organization`, `PostalAddress`, etc.) -- confirmed directly against a live job page. This repo's existing `packages/vacancy-engine/src/ats/json-ld.ts` (`extractJsonLdVacancies`) already parses exactly this shape and would work against Built In's pages with no new parser needed, mechanically speaking.
- **Terms of use** (`builtin.com/community-terms-of-use`, Section 3(f)): explicitly prohibits accessing or using the Site "through the use of bots, spiders, scrapers, web crawlers, indexing agents, or other automated devices or mechanisms," applied broadly across the whole site including job listings. Section 4.3 confirms this applies even though Built In doesn't itself author the employer-posted job content.

## Why this is a hard no, not a backlog item
`robots.txt` being permissive does not override the ToS -- `robots.txt` is a crawler-politeness signal, the Terms of Use is the actual contract, and it bans automated collection outright with no carve-out for structured data. Mechanically easy (reusing `json-ld.ts`) is irrelevant when the source explicitly prohibits the access method. This is the same shape of decision this repo already made for Indeed (#28: "No adapter until written generic-client and aggregation authorization") and LoopCV (#31: "No production adapter without an aggregator/commercial agreement") in `docs/mcp-source-policy.md` -- Built In is a job-board aggregator with an explicit anti-scraping clause, not a company's own ATS/careers page (which is what `packages/vacancy-engine/src/ats/*` targets today).

## What would need to be true before this is worth building
1. A written agreement or licensed API access from Built In authorizing automated collection -- the same bar set for Indeed/LoopCV, not a lower one just because the technical extraction is easy.
2. Absent that, this stays a permanent no, not a "someday": there's no ambiguity in Section 3(f) the way there is with some sites' silence on the topic.

## Non-goals
Do not build a Built In adapter, scheduled crawl, or one-off scrape against `/jobs` or `/job/*` without the authorization above -- doing so would violate the site's terms regardless of `robots.txt` being permissive, and would be inconsistent with how this project already treats Indeed and LoopCV.

## Addendum: "an AI agent scrapes it instead, results surfaced later" does not change the analysis
Considered and rejected: routing the collection through an AI browsing agent (e.g. `agent-browser`, see `draft-agent-browser-mcp-tool.md`) instead of a conventional scraper, and holding results back from the UI so the source "just grows in the background" rather than appearing immediately.

This doesn't cure the problem, for two independent reasons:
- **The ToS clause is about method, not pace or presentation.** Section 3(f) prohibits access "through the use of bots, spiders, scrapers, web crawlers, indexing agents, or other automated devices or mechanisms." An AI agent driving a browser to systematically visit and extract job pages *is* an automated mechanism under that definition -- swapping which tool does the automated fetching, or delaying when the extracted data is shown to the user, doesn't change that the collection method itself is automated and unauthorized.
- **"Continuously growing in the background" is exactly what this project's own policy already bans.** `docs/mcp-source-policy.md` prohibits "bulk enumeration, continuous corpus monitoring, ... and UI scraping" outright, independent of any specific site's terms. A slow-drip background agent that keeps expanding a stored corpus of Built In listings over time is continuous corpus monitoring by definition, not a lesser or different activity than what that policy already forecloses.

Slower, quieter, or delayed does not mean authorized. The only path that changes the answer is the same one named above: a written agreement or licensed API access from Built In.
