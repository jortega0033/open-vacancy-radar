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

/** Notifications the normalizer (`app-server/normalizer.ts`) translates into existing `AgentEvent`
 * members. `turn/completed` alone carries success/failure/interruption via its own `status` field
 * (verified directly against upstream's normalizer: there is no separate `turn/failed` method), so
 * no separate failure notification needs allowlisting. */
export const CODEX_APP_SERVER_INCOMING_NOTIFICATION_METHODS = Object.freeze([
  'thread/started',
  'turn/started',
  'turn/completed',
  'item/started',
  'item/completed',
  'item/agentMessage/delta',
  'thread/tokenUsage/updated',
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
