# ATS source observation import

OVR can import deterministic ATS tenant candidates without adding them to a checked-in registry.
The import is local, versioned, and revalidates every candidate through OVR's existing URL safety
policy and ATS adapter before promotion.

```json
{
  "version": 1,
  "generatedAt": "2026-09-13T13:37:27.322Z",
  "sources": [
    {
      "company": "Example Company",
      "url": "https://job-boards.greenhouse.io/example",
      "evidence": "Public board returned a schema-valid vacancy with a canonical job URL."
    }
  ]
}
```

Import a file from the repository root:

```text
pnpm --filter @open-vacancy-radar/vacancy-engine exec node dist/cli.js ats-sources:import <file>
```

Only Greenhouse, Lever, Ashby, Recruitee, and Personio are accepted by this contract. Unsupported,
malformed, non-HTTPS, authentication-gated, blocked, empty, and invalid boards remain outside the
active roster. Healthy empty boards and failed candidates are retained in the local observation
store for later review or retry. Accepted tenants are deduplicated by canonical provider and slug.

The planner state is stored under `.data/ats-source-observations-v1.json`. It records source health,
observed countries, role families, remote scope, adaptive refresh timing, failure categories, and a
durable exploration cursor. This file is local runtime state and is not committed.
