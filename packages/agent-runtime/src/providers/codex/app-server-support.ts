/**
 * The reviewed, closed set of Codex app-server RPC methods this repo's transport actually calls or
 * handles, plus the operator-facing transport-mode switch. Narrowed from upstream AgentDock's
 * equivalent module: upstream's app-server integration exposes a much larger capability surface
 * (mid-turn steering, thread forking, structured output, image attachments, subagent observation --
 * see `app-server-support.ts` in the upstream clone) backed by a full `CoreCapabilityId` capability
 * catalog that does not exist in this repo's `packages/shared` (nothing here consumes it -- see
 * ADI-08's plan). This repo's `CodexAppServerTransport` (providers/codex/app-server/transport.ts)
 * produces the same plain `AgentEvent` stream the legacy exec transport already does, so only the
 * methods needed to drive one prompt-in/events-out session -- plus resume, plus the mid-turn
 * approval/elicitation requests the app-server can send unprompted and that must be auto-answered
 * rather than left hanging -- are allowlisted below.
 *
 * `app-server` starts experimental as a whole (see `docs/providers.md`'s AD-21), so this is
 * deliberately a small, reviewed subset of the methods the schema fixture (`app-server-schema/`)
 * declares. Do not infer permission from a prefix: an addition must be reviewed and added here
 * explicitly, the same discipline upstream documents for its own (larger) list.
 */

export type CodexTransportMode = 'auto' | 'app-server' | 'exec';

const CODEX_TRANSPORT_MODES = new Set<CodexTransportMode>(['auto', 'app-server', 'exec']);

/** Requests this transport sends. No `thread/fork` (session.fork is out of scope), no `turn/steer`
 * (no mid-turn follow-up input in this repo's one-prompt-per-session model, matching the legacy
 * exec transport's own shape). */
export const CODEX_APP_SERVER_OUTGOING_REQUEST_METHODS = Object.freeze([
  'initialize',
  'account/read',
  'model/list',
  'thread/start',
  'thread/resume',
  'turn/start',
  'turn/interrupt',
] as const);

export const CODEX_APP_SERVER_OUTGOING_NOTIFICATION_METHODS = Object.freeze(['initialized'] as const);

/** Server-initiated requests this transport must answer (never leave pending): a fixed,
 * non-interactive policy answers each of these automatically -- see `transport.ts`'s documented
 * approval/elicitation policy -- rather than surfacing them to the daemon as a new capability. */
export const CODEX_APP_SERVER_INCOMING_REQUEST_METHODS = Object.freeze([
  'item/commandExecution/requestApproval',
  'item/fileChange/requestApproval',
  'item/permissions/requestApproval',
  'mcpServer/elicitation/request',
] as const);

/**
 * The allowlist boundary here is deliberately wider than what the normalizer (`app-server/
 * normalizer.ts`) turns into an `AgentEvent`: this list exists to answer "can a normal, successful
 * single-turn run legitimately send this method at all," not "does this repo's v1 event model have
 * something to do with it." A notification a real running session sends as an ordinary part of its
 * protocol (in-progress deltas, plan/diff updates, status changes) but that this repo's normalizer
 * has nothing to turn into a v1 `AgentEvent` is still allowlisted and consumed as a deliberate
 * no-op -- leaving it off this list instead would make the RPC layer fail the whole session with
 * `forbidden_method` the first time an entirely ordinary turn used a facet of the protocol nobody
 * thought to allowlist. That failure mode (a real, successful-looking session dying on a method this
 * repo simply doesn't act on) is worse than allowlisting and ignoring a few extra notifications, so
 * this matches upstream's own full incoming-notification list except `remoteControl/status/changed`/
 * `mcpServer/startupStatus/updated` (this transport never pairs with a remote-control client or
 * configures MCP servers, so these two genuinely cannot fire). `warning` and `serverRequest/resolved` are deliberately kept, not excluded: the vendored
 * schema shows `warning`'s `threadId` is optional -- it is a general-purpose caveat channel, not
 * something tied to remote control or MCP, so a normal single-turn session can legitimately receive
 * one -- and `serverRequest/resolved` is plausibly the server's own confirmation that one of the
 * approval/elicitation requests this transport already auto-answers was resolved, which this
 * transport's own auto-answer flow can trigger as an ordinary consequence. Excluding either would
 * risk exactly the failure mode this whole widening exists to prevent.
 *
 * `turn/completed` alone carries success/failure/interruption via its own `status` field (verified
 * directly against upstream's normalizer: there is no separate `turn/failed` method), so no
 * separate failure notification needs allowlisting for that.
 */
export const CODEX_APP_SERVER_INCOMING_NOTIFICATION_METHODS = Object.freeze([
  'account/rateLimits/updated',
  'thread/started',
  'thread/status/changed',
  'thread/tokenUsage/updated',
  'turn/started',
  'turn/completed',
  'turn/plan/updated',
  'turn/diff/updated',
  'item/started',
  'item/completed',
  'item/agentMessage/delta',
  'item/commandExecution/outputDelta',
  'item/fileChange/outputDelta',
  'item/fileChange/patchUpdated',
  'item/mcpToolCall/progress',
  'item/reasoning/summaryTextDelta',
  'item/reasoning/summaryPartAdded',
  'item/reasoning/textDelta',
  'serverRequest/resolved',
  'warning',
  'error',
] as const);

const OUTGOING_METHODS = new Set<string>([
  ...CODEX_APP_SERVER_OUTGOING_REQUEST_METHODS,
  ...CODEX_APP_SERVER_OUTGOING_NOTIFICATION_METHODS,
]);
const INCOMING_METHODS = new Set<string>([
  ...CODEX_APP_SERVER_INCOMING_REQUEST_METHODS,
  ...CODEX_APP_SERVER_INCOMING_NOTIFICATION_METHODS,
]);
const INCOMING_NOTIFICATION_METHODS = new Set<string>(CODEX_APP_SERVER_INCOMING_NOTIFICATION_METHODS);

export function isCodexAppServerOutgoingMethod(method: string): boolean {
  return OUTGOING_METHODS.has(method);
}

export function isCodexAppServerIncomingMethod(method: string): boolean {
  return INCOMING_METHODS.has(method);
}

export function isCodexAppServerIncomingNotificationMethod(method: string): boolean {
  return INCOMING_NOTIFICATION_METHODS.has(method);
}

export class CodexAppServerUnsupportedError extends Error {
  readonly code = 'codex_app_server_unsupported' as const;

  constructor(message: string) {
    super(message);
    this.name = 'CodexAppServerUnsupportedError';
  }
}

/**
 * Strictly parses the operator-facing transport-mode override; whitespace and aliases are
 * intentional failures, matching the "one configuration switch restores legacy transports"
 * acceptance criterion in ADI-08 (#126) by being exact about what that switch accepts.
 *
 * Defaults to `'exec'`, not upstream's `'auto'`: this repo ships new transport infrastructure
 * inert-by-default (matching every other ADI ticket this session -- the live-smoke harness, the
 * MCP vacancy-source policy, etc.), so an operator must explicitly opt into `'app-server'` rather
 * than the daemon silently trying it once compatibility happens to line up.
 */
export function resolveCodexTransportMode(
  value: string | undefined = process.env.AGENT_DOCK_CODEX_TRANSPORT,
): CodexTransportMode {
  if (value === undefined) return 'exec';
  if (CODEX_TRANSPORT_MODES.has(value as CodexTransportMode)) {
    return value as CodexTransportMode;
  }
  throw new CodexAppServerUnsupportedError('AGENT_DOCK_CODEX_TRANSPORT must be exactly "auto", "app-server", or "exec"');
}
