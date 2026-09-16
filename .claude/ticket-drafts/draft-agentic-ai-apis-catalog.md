## Goal
Record why the forked `agentic-ai-apis` catalog (2,036 listed agent/model/MCP-server APIs) is not being integrated now, and what would need to be true before any entry in it is worth pulling into this project.

## Why this is deferred, not just delayed
- The fork is a link/description catalog, not code -- there is nothing in it to import, only entries to evaluate one at a time.
- No one has yet gone through it to find the subset that's actually relevant here: job-board APIs, ATS APIs (Greenhouse, Lever, etc.), or MCP servers that would let a session read structured job-listing data instead of scraping a rendered page.
- A structured API is strictly preferable to browser automation (see `draft-agent-browser-mcp-tool.md`) wherever one exists and its terms of service allow the kind of automated access this project would put it to -- but that's a per-API legal/ToS judgment call this catalog doesn't make for us, and getting it wrong risks the user's accounts on those services.
- Nothing in the current roadmap (ADI-04 through ADI-13: session supervisor, provider/session stores, workspace trust, concurrent AI workspace, `/v2/sessions`) has a concrete need for a new external API yet.

## What would need to be true before this is worth building
1. A specific job-search or listing-retrieval need that browser automation (`draft-agent-browser-mcp-tool.md`) can't satisfy well -- e.g. a site that blocks headless browsers but offers a documented API.
2. Someone has actually read that entry's ToS and confirmed the intended automated use is allowed.
3. A concrete ticket naming the one API to integrate, not a bulk import of the catalog.

## Non-goals
Do not bulk-import or wire up any API from this catalog speculatively. This ticket exists only to record that the fork was looked at and deliberately not acted on yet, so the option isn't silently lost or re-discovered from scratch later.
