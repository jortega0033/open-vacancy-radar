/**
 * The public contract version for the daemon's HTTP+SSE API and the AgentEvent shape it emits.
 * Bump this only when a *breaking* change is made to either. A downstream client (starting with
 * @agent-dock/client) checks this against `GET /health` and refuses to proceed on a mismatch
 * rather than guessing whether it's still compatible. See docs/protocol-v1.md.
 *
 * This is a plain number with exact-match comparison, not a semver range or negotiation handshake.
 * The Electron app, downstream clients, and daemon currently ship against one protocol version.
 * Add version negotiation if that changes.
 */
export const AGENT_DOCK_PROTOCOL_VERSION = 1;
