import type { AgentEvent } from '@agent-dock/shared';
import { asObject as object, CodexAppServerProtocolError, safeDisplay } from './errors.js';

type JsonObject = Record<string, unknown>;

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function itemEvent(kind: 'started' | 'completed', item: JsonObject): AgentEvent | undefined {
  const id = optionalString(item.id);
  const status = optionalString(item.status);
  const isError = status === 'failed' || status === 'declined' || item.success === false;

  switch (item.type) {
    case 'agentMessage':
      if (kind === 'completed' && typeof item.text === 'string' && item.text.length > 0) {
        return { type: 'assistant.message', text: item.text };
      }
      return undefined;
    case 'commandExecution':
      return kind === 'started'
        ? { type: 'tool.started', toolName: 'shell', toolCallId: id, input: { command: item.command } }
        : { type: 'tool.completed', toolName: 'shell', toolCallId: id, result: { command: item.command, exitCode: item.exitCode }, isError };
    case 'fileChange':
      return kind === 'started'
        ? { type: 'tool.started', toolName: 'file_change', toolCallId: id, input: { changes: item.changes } }
        : { type: 'tool.completed', toolName: 'file_change', toolCallId: id, result: { changes: item.changes }, isError };
    case 'mcpToolCall': {
      const toolName = boundedToolName(item.server, item.tool);
      return kind === 'started'
        ? { type: 'tool.started', toolName, toolCallId: id, input: item.arguments }
        : { type: 'tool.completed', toolName, toolCallId: id, result: item.result, isError };
    }
    // 'reasoning' (thinking/reasoning content) and any subagent/dynamic-tool item type are
    // deliberately not translated in this initial port -- see app-server-support.ts's doc comment
    // on why they're allowlisted at the RPC layer (a real session may legitimately send them) but
    // not turned into an AgentEvent here (no consumer needs them yet). Add a case here, following
    // this same pattern, once a real need exists -- not speculatively.
    default:
      return undefined;
  }
}

function boundedToolName(server: unknown, tool: unknown): string {
  return safeDisplay(`mcp:${safeDisplay(server, 96, 'mcp')}/${safeDisplay(tool, 96, 'tool')}`, 256, 'mcp_tool');
}

/**
 * Translates Codex app-server JSON-RPC notifications into this repo's existing, plain `AgentEvent`
 * union (`packages/shared/src/events.ts`) -- the same union `providers/codex/parser.ts` already
 * produces for the exec transport. Deliberately not upstream's `AgentEventV2`: nothing in this repo
 * consumes the richer v2 event shape, and every acceptance criterion in ADI-08 (#126) is satisfiable
 * with the plain union (see the central architectural decision recorded in the issue's own
 * staged-plan comment).
 *
 * Unlike the exec transport, where `session.completed`/`session.failed`/`session.cancelled` are
 * derived by `run-session.ts` from the CLI process's *exit*, this transport's process stays alive
 * independent of any one turn -- so `turn/completed`'s own `status` field is what this normalizer
 * maps directly to the terminal event. `transport.ts` (a later stage) stops consuming further
 * notifications once one of these three is emitted, the same "exactly one terminal event, always
 * last" contract every other provider already upholds.
 *
 * Every method this class switches on must already be allowlisted in `app-server-support.ts`'s
 * `CODEX_APP_SERVER_INCOMING_NOTIFICATION_METHODS` -- `rpc.ts` enforces that before a notification
 * ever reaches here, so this class does not re-check it.
 */
export class CodexAppServerNormalizer {
  private providerSessionId: string | undefined;

  /**
   * Lets a caller (`transport.ts`) hand in the thread id it already has authoritatively from the
   * `thread/start`/`thread/resume` RPC *response* itself, rather than this class depending on a
   * `thread/started` *notification* ever arriving. Both exist in the real protocol, but the
   * response is the one guaranteed by the request/response contract; the notification's delivery
   * timing (or whether it fires at all for a single-client connection) is not something this
   * class's terminal-event correctness should depend on. A later notification, if one does arrive,
   * still overwrites this via the `thread/started` case below -- harmless, since both should agree.
   */
  setProviderSessionId(threadId: string): void {
    this.providerSessionId = threadId;
  }

  normalize(method: string, params: unknown): AgentEvent[] {
    switch (method) {
      case 'thread/started': {
        const thread = object(params, 'thread/started params').thread;
        const threadId = optionalString(object(thread, 'thread/started thread').id);
        if (threadId) this.providerSessionId = threadId;
        return [];
      }
      case 'turn/started':
        return [{ type: 'status', status: 'turn_started' }];
      case 'turn/completed': {
        const turn = object(object(params, 'turn/completed params').turn, 'turn/completed turn');
        switch (turn.status) {
          case 'completed':
            return [{ type: 'session.completed', providerSessionId: this.providerSessionId }];
          case 'interrupted':
            return [{ type: 'session.cancelled' }];
          case 'failed':
            return [{ type: 'session.failed', message: 'Codex turn failed' }];
          default:
            throw new CodexAppServerProtocolError('frame_invalid', 'Invalid Codex turn status');
        }
      }
      case 'item/started': {
        const item = object(object(params, 'item/started params').item, 'started item');
        const event = itemEvent('started', item);
        return event ? [event] : [];
      }
      case 'item/completed': {
        const item = object(object(params, 'item/completed params').item, 'completed item');
        const event = itemEvent('completed', item);
        return event ? [event] : [];
      }
      case 'thread/tokenUsage/updated': {
        const tokenUsage = object(object(params, 'thread/tokenUsage/updated params').tokenUsage, 'token usage');
        const last = object(tokenUsage.last, 'last token usage');
        return [
          {
            type: 'usage',
            inputTokens: typeof last.inputTokens === 'number' ? last.inputTokens : undefined,
            outputTokens: typeof last.outputTokens === 'number' ? last.outputTokens : undefined,
            cachedInputTokens: typeof last.cachedInputTokens === 'number' ? last.cachedInputTokens : undefined,
          },
        ];
      }
      case 'error': {
        const p = object(params, 'error params');
        return [{ type: 'error', message: 'Codex app-server reported an error', recoverable: p.willRetry === true }];
      }
      // Ordinary in-progress signals a real running turn can send that this repo's plain v1 event
      // model has nothing to represent -- deliberate no-ops, not omissions (see the class doc
      // comment and app-server-support.ts's allowlist doc comment for why these are still
      // allowlisted at the RPC layer).
      case 'thread/status/changed':
      case 'turn/plan/updated':
      case 'turn/diff/updated':
      case 'item/agentMessage/delta':
      case 'item/commandExecution/outputDelta':
      case 'item/fileChange/outputDelta':
      case 'item/fileChange/patchUpdated':
      case 'item/mcpToolCall/progress':
      case 'item/reasoning/summaryTextDelta':
      case 'item/reasoning/summaryPartAdded':
      case 'item/reasoning/textDelta':
      case 'serverRequest/resolved':
      case 'warning':
        return [];
      default:
        // Unreachable in practice: rpc.ts only calls this for a method already confirmed
        // allowlisted. Fails closed rather than silently dropping a method this file forgot to
        // handle, so an allowlist addition that's missing its normalizer case is caught here
        // (by a test asserting every allowlisted method has a case) rather than shipped silent.
        throw new CodexAppServerProtocolError('state_invalid', `Codex app-server notification has no normalizer case: ${method}`);
    }
  }
}
