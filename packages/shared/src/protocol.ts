/**
 * The public contract version for the daemon's HTTP+SSE API and the AgentEvent shape it emits.
 * Frozen at 1 forever: every v1 route, request/response shape, and SSE frame this repo has ever
 * shipped stays addressable under this number. A downstream client (starting with
 * @agent-dock/client) checks this against `GET /health` and refuses a v1 call on a mismatch rather
 * than guessing whether it's still compatible. See docs/protocol-v1.md.
 */
export const AGENT_DOCK_PROTOCOL_VERSION = 1;

/**
 * Every protocol version this build of @agent-dock/shared and @agent-dock/client understand.
 * `GET /health` additionally reports the *daemon's* own supported set (see
 * `supportedProtocolVersionsSchema` in schemas.ts) so a client can negotiate the highest version
 * both sides share -- see negotiation-v2.ts. A daemon that never adds v2 routes never needs to
 * report anything past `[1]`; this constant only bounds what a *client* can ask for.
 */
export const AGENT_DOCK_SUPPORTED_PROTOCOL_VERSIONS = Object.freeze([1, 2] as const);

export type AgentDockProtocolVersion = (typeof AGENT_DOCK_SUPPORTED_PROTOCOL_VERSIONS)[number];
