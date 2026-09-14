import type { McpProviderPolicy, McpVacancy } from '../types.js';

/**
 * InfoSec Job Board (https://www.infosecjobboard.com) -- a cybersecurity-specialist job board that
 * publishes an operator-supported, no-auth MCP server (official registry entry:
 * https://registry.modelcontextprotocol.io/?q=com.infosecjobboard%2Fjobs). See
 * https://www.infosecjobboard.com/developers and https://www.infosecjobboard.com/ai-info for the
 * public/free-with-attribution access model this policy relies on, and
 * https://www.infosecjobboard.com/cybersecurity-hiring-data for the *separate*, licensed bulk-data
 * product this ticket (#48) never calls: only the two capped, read-only tools below are ever
 * reachable through this policy, never that product's endpoints.
 *
 * This is `linked_index`, not `full_ingestion`: the operator's own public JSON endpoints expose
 * aggregates, not raw dumps, and job-search results are capped at 10 -- both facts are enforced here
 * independently of what any individual request asks for (see `INFOSEC_JOB_BOARD_MAX_RESULTS` below),
 * not merely documented. Numeric request-rate limits are not published, so this policy leans on the
 * shared `McpConnectionManager`'s existing timeout/cancellation rather than adding source-specific
 * retry/backoff on top of it -- matching how every REST discovery adapter in
 * `packages/vacancy-engine` relies on its own shared HTTP boundary instead of reinventing one.
 */
export const INFOSEC_JOB_BOARD_PROVIDER_ID = 'infosec_job_board';
export const INFOSEC_JOB_BOARD_ENDPOINT = 'https://mcp.infosecjobboard.com/mcp';
export const INFOSEC_JOB_BOARD_SEARCH_TOOL = 'search_jobs';
export const INFOSEC_JOB_BOARD_DETAIL_TOOL = 'get_job';
/** The operator's own stated cap (see https://www.infosecjobboard.com/developers): never request or
 * surface more than this many rows from one search, and never page/fan out to reconstruct a larger
 * corpus -- there is deliberately no pagination argument anywhere in this file. */
export const INFOSEC_JOB_BOARD_MAX_RESULTS = 10;

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value : null;
}

/**
 * `posted_at`/similar provider date fields are assumed to be parseable date-or-datetime strings; the
 * shared `mcpVacancySchema` requires a full `Date.prototype.toISOString()`-shaped value (or `null`),
 * so a bare date like `"2026-09-01"` is normalized to midnight UTC rather than rejected outright. An
 * unparseable or missing value is treated as unknown-freshness (`null`), never fabricated.
 */
function isoDateTime(value: unknown): string | null {
  const raw = nonEmptyString(value);
  if (raw === null) return null;
  const parsed = new Date(raw);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

/**
 * The MCP tool-result envelope (2025-06-18 spec): a `content` array of text/other blocks, an
 * optional `structuredContent` object, and an optional `isError` flag for a tool-level (as opposed
 * to transport/protocol-level) failure. Real servers commonly duplicate the same payload as both a
 * JSON text block and `structuredContent`; `structuredContent` is preferred when present, with the
 * first text block's JSON as a fallback for a server that only returns unstructured content.
 */
function toolResultEnvelope(raw: unknown): { structured: Record<string, unknown> | null; text: unknown; isError: boolean } {
  const envelope = record(raw);
  if (envelope === null) throw new Error('InfoSec Job Board returned a non-object tool result');
  const structured = record(envelope.structuredContent);
  const content = Array.isArray(envelope.content) ? envelope.content : [];
  const firstText = content
    .map((block) => record(block))
    .find((block): block is Record<string, unknown> => block !== null && block.type === 'text' && typeof block.text === 'string');
  let text: unknown;
  if (firstText !== undefined) {
    try {
      text = JSON.parse(firstText.text as string) as unknown;
    } catch (error) {
      throw new Error('InfoSec Job Board tool result text content was not valid JSON', { cause: error });
    }
  }
  return { structured, text, isError: envelope.isError === true };
}

/** One raw job object -> the exact, closed field set `mcpVacancySchema` accepts. Anything else about
 * the raw provider row (internal ids, scoring, ATS metadata) is dropped rather than passed through --
 * this adapter never widens the shared vacancy schema for one provider's extra fields. */
function normalizeInfosecJob(raw: unknown): McpVacancy {
  const job = record(raw);
  if (job === null) throw new Error('InfoSec Job Board job entry is not an object');
  const externalId = nonEmptyString(job.id);
  const title = nonEmptyString(job.title);
  const company = nonEmptyString(job.company);
  const url = nonEmptyString(job.url);
  if (externalId === null || title === null || company === null || url === null) {
    throw new Error('InfoSec Job Board job entry is missing a required field');
  }
  return {
    externalId,
    title,
    company,
    url,
    // No country/region default: an unlabeled row stays explicitly "unspecified" rather than being
    // assigned any particular market, matching this project's no-default-bias rule.
    location: nonEmptyString(job.location) ?? 'Remote (eligibility unspecified)',
    description: nonEmptyString(job.description),
    employmentType: nonEmptyString(job.employment_type),
    publishedAt: isoDateTime(job.posted_at),
  };
}

function jobsArray(value: unknown): unknown[] | null {
  if (Array.isArray(value)) return value;
  const wrapped = record(value);
  return wrapped !== null && Array.isArray(wrapped.jobs) ? wrapped.jobs : null;
}

/** The message of an `isError` tool result, from whichever of `structuredContent`/text-JSON carries
 * one -- best-effort only, since neither shape is guaranteed for a tool-level error. */
function toolErrorMessage(structured: Record<string, unknown> | null, text: unknown): string | null {
  return nonEmptyString(structured?.message) ?? nonEmptyString(record(text)?.message);
}

/**
 * `get_job`'s single-job payload can plausibly arrive nested under a `job` key or as the entire
 * structured/text payload itself (both are observed shapes across public MCP job-search servers);
 * `structuredContent` is checked before the text-block JSON fallback. Returns `null` -- never
 * `false` -- when nothing usable is found, so the caller's `=== null` check is reliable.
 */
function extractDetailJob(structured: Record<string, unknown> | null, text: unknown): Record<string, unknown> | null {
  for (const candidate of [structured, record(text)]) {
    if (candidate === null) continue;
    const nested = record(candidate.job);
    if (nested !== null) return nested;
    if (nonEmptyString(candidate.id) !== null) return candidate;
  }
  return null;
}

/**
 * `search_jobs` result -> raw job objects (validated by the shared manager immediately after this
 * returns). Hard-caps to `INFOSEC_JOB_BOARD_MAX_RESULTS` here, independent of both the server's own
 * response size and whatever `limit` the caller asked for, so neither a misbehaving/changed server
 * response nor a future caller passing a larger generic `McpSearchRequest.limit` can ever smuggle
 * more than 10 rows past this adapter -- the manager's own `request.limit` slice downstream is
 * defense in depth, not the only enforcement point.
 */
export function parseInfosecJobBoardSearchResult(raw: unknown): McpVacancy[] {
  const envelope = toolResultEnvelope(raw);
  if (envelope.isError) {
    const message = toolErrorMessage(envelope.structured, envelope.text) ?? 'unknown error';
    throw new Error(`InfoSec Job Board search_jobs reported a tool error: ${message}`);
  }
  const jobs = jobsArray(envelope.structured) ?? jobsArray(envelope.text);
  if (jobs === null) throw new Error('InfoSec Job Board search_jobs response did not contain a jobs array');
  return jobs.slice(0, INFOSEC_JOB_BOARD_MAX_RESULTS).map((job) => normalizeInfosecJob(job));
}

/** `get_job` result -> one raw job object. A tool-reported "not found" (an `isError` result, since
 * this is a tool-level outcome, not a transport failure) surfaces as a rejected promise rather than a
 * fabricated placeholder vacancy -- callers distinguish it the same way `manager.getJob` surfaces any
 * other provider failure, through the shared, sanitized error categories. */
export function parseInfosecJobBoardDetailResult(raw: unknown): unknown {
  const envelope = toolResultEnvelope(raw);
  if (envelope.isError) {
    const message = toolErrorMessage(envelope.structured, envelope.text) ?? 'job not found';
    throw new Error(`InfoSec Job Board get_job reported a tool error: ${message}`);
  }
  const job = extractDetailJob(envelope.structured, envelope.text);
  if (job === null) throw new Error('InfoSec Job Board get_job response did not contain a job');
  return normalizeInfosecJob(job);
}

/**
 * The reviewed policy object itself. Every field here is the "required review record"
 * `docs/mcp-source-policy.md` demands: source URL, attribution, terms/policy version, review date,
 * retention, the one read-only search tool (plus the one read-only detail tool this ticket added
 * support for), fixed argument mappers, strict output parsers, a payload limit, a timeout, and
 * independent connection/search/persistence kill switches.
 */
export const infosecJobBoardMcpPolicy: McpProviderPolicy = {
  id: INFOSEC_JOB_BOARD_PROVIDER_ID,
  displayName: 'InfoSec Job Board',
  transport: { kind: 'streamable-http', endpoint: INFOSEC_JOB_BOARD_ENDPOINT, auth: 'none' },
  searchTool: INFOSEC_JOB_BOARD_SEARCH_TOOL,
  mapSearchArguments: ({ query, limit }) => ({
    query,
    // Clamped at the request boundary too, not only in the parser above: the argument actually sent
    // to the server should itself never ask for more than the board's published cap.
    limit: Math.min(Math.max(limit, 1), INFOSEC_JOB_BOARD_MAX_RESULTS),
  }),
  parseResult: parseInfosecJobBoardSearchResult,
  detailTool: INFOSEC_JOB_BOARD_DETAIL_TOOL,
  mapDetailArguments: ({ externalId }) => ({ id: externalId }),
  parseDetailResult: parseInfosecJobBoardDetailResult,
  sourceUrl: 'https://www.infosecjobboard.com/jobs',
  attribution:
    'Jobs sourced from InfoSec Job Board (infosecjobboard.com) via its public MCP search; not exhaustive of cybersecurity hiring.',
  policyVersion: '2026-09-10',
  policyReviewedAt: '2026-09-10',
  // Short-lived by design ("cache only briefly and retain tool-response provenance" per the ticket),
  // matching the five-minute bound this repo already uses for Remoote's capped anonymous search.
  retentionMs: 5 * 60 * 1000,
  timeoutMs: 15_000,
  maximumPayloadBytes: 262_144,
  killSwitches: { connection: true, search: true, persistence: true },
};
