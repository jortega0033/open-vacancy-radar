## Goal
Record why the forked `awesome-llm-apps` collection (Python example agents/RAG apps, folders like `advanced_ai_agents`, `agent_skills`, `mcp_ai_agents`, `rag_tutorials`) is being kept as reference only, and when it would actually get used.

## Why this is deferred, not just delayed
- It's a demo/tutorial collection in Python; this repo's runtime (`packages/agent-runtime`, `apps/daemon`, `apps/desktop`) is TypeScript/Node plus the Claude/Codex CLIs as subprocess providers. Nothing in the fork is directly importable -- at most a pattern gets reimplemented in this stack's own idiom.
- No feature currently on the roadmap has asked for the kind of prior art this fork holds (e.g. a resume-screening agent, a RAG-over-CV-corpus pattern, a multi-agent pipeline). Reading it now, without a concrete feature driving the read, produces ideas with nowhere to land.
- The project's existing architecture (provider adapters spawning CLIs, not a custom agent/tool framework -- see `packages/agent-runtime/src/providers/`) means even a good pattern from the fork would need to be re-derived for "how does this fit a CLI-subprocess-per-session model," not copied.

## What would need to be true before this is worth building
1. A concrete feature is being designed that plausibly has prior art in one of the fork's folders -- most likely `agent_skills` or `advanced_ai_agents` for a job-search-specific agent, or `rag_tutorials` if CV/job-listing retrieval ever needs embeddings-based search instead of the current structured matching.
2. At that point, read only the relevant subfolder for its design pattern (prompt structure, tool decomposition, review/confirm points), not for code to port.

## Non-goals
Do not treat this fork as a dependency or a source of code to copy in wholesale. This ticket exists so the fork is remembered as "looked at, kept as idea reference" rather than re-discovered or, worse, half-imported without a real need driving the scope.
