# MCP vacancy-source policy

MCP is a transport, not permission to collect or retain vacancy data. Open Vacancy Radar only
connects to providers represented by a reviewed, compiled `McpProviderPolicy`; no route accepts a
server URL, tool name, headers, or native provider arguments from the renderer.

## Required review record

Every provider policy must identify its source URL, attribution, terms/policy version, review date,
retention period, one read-only search tool, fixed argument mapper, strict output parser, payload
limit, timeout, and independent connection/search/persistence kill switches. A provider adapter is
not approved merely because its server implements MCP.

## Default denials

- Unknown tools and capabilities are ignored. Sampling, elicitation, write tools, resources, and
  prompts are not registered or exposed.
- Bulk enumeration, continuous corpus monitoring, access-control bypass, shared credentials, and UI
  scraping are prohibited.
- Remote endpoints are compiled into provider policies and must use credential-free HTTPS. Local
  stdio commands and arguments are likewise compiled into policy.
- Provider output is size-bounded and strictly validated before it can become vacancy data.
- Credentials live in the operating-system credential store. They are not placed in SQLite,
  renderer state, logs, prompts, reports, or exports.
- OAuth policies use the official SDK's `OAuthClientProvider`/PKCE path. Each provider adapter must
  supply its reviewed localhost redirect and OS-keyring token implementation; the daemon fails
  closed when that provider-specific handler is absent.
- Cached results carry source, attribution, policy version/review date, fetch time, and expiry. The
  manager deterministically purges expired rows and deletes provider-controlled rows on removal.

## Provider decisions (reviewed 2026-08-30)

| Provider | Decision | Tracking |
| --- | --- | --- |
| Upwork | Approved for a bounded, user-directed adapter subject to its own retention/attribution rules | #29 |
| Indeed | No adapter until written generic-client and aggregation authorization | #28 |
| JobGPT | Optional API-key spike only after vendor and data-rights evidence | #30 |
| LoopCV | No production adapter without an aggregator/commercial agreement | #31 |
| openings-mcp | Never bundle wholesale; audit each upstream provider independently | #32 |

Reference: MCP authorization specification 2025-06-18 and the provider-specific evidence recorded
in the linked tickets. Legal review must be repeated when terms or intended processing changes.
