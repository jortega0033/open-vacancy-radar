import { describe, expect, it } from 'vitest';
import {
  CODEX_APP_SERVER_INCOMING_NOTIFICATION_METHODS,
  CODEX_APP_SERVER_INCOMING_REQUEST_METHODS,
  CODEX_APP_SERVER_OUTGOING_NOTIFICATION_METHODS,
  CODEX_APP_SERVER_OUTGOING_REQUEST_METHODS,
  CodexAppServerUnsupportedError,
  isCodexAppServerIncomingMethod,
  isCodexAppServerIncomingNotificationMethod,
  isCodexAppServerOutgoingMethod,
  resolveCodexTransportMode,
} from '../src/providers/codex/app-server-support.js';

describe('method allowlists', () => {
  it('accepts every declared outgoing request/notification method', () => {
    for (const method of [...CODEX_APP_SERVER_OUTGOING_REQUEST_METHODS, ...CODEX_APP_SERVER_OUTGOING_NOTIFICATION_METHODS]) {
      expect(isCodexAppServerOutgoingMethod(method)).toBe(true);
    }
  });

  it('accepts every declared incoming request/notification method', () => {
    for (const method of [...CODEX_APP_SERVER_INCOMING_REQUEST_METHODS, ...CODEX_APP_SERVER_INCOMING_NOTIFICATION_METHODS]) {
      expect(isCodexAppServerIncomingMethod(method)).toBe(true);
    }
  });

  it('rejects a method that is not on any list, no prefix inference', () => {
    expect(isCodexAppServerOutgoingMethod('thread/fork')).toBe(false);
    expect(isCodexAppServerOutgoingMethod('turn/steer')).toBe(false);
    expect(isCodexAppServerIncomingMethod('thread/fork/completed')).toBe(false);
  });

  it('does not accept an outgoing-only method as incoming, or vice versa', () => {
    expect(isCodexAppServerIncomingMethod('turn/start')).toBe(false);
    expect(isCodexAppServerOutgoingMethod('turn/completed')).toBe(false);
  });

  it('isCodexAppServerIncomingNotificationMethod is narrower than isCodexAppServerIncomingMethod: it excludes incoming requests', () => {
    for (const method of CODEX_APP_SERVER_INCOMING_REQUEST_METHODS) {
      expect(isCodexAppServerIncomingMethod(method)).toBe(true);
      expect(isCodexAppServerIncomingNotificationMethod(method)).toBe(false);
    }
  });
});

describe('CODEX_APP_SERVER_INCOMING_NOTIFICATION_METHODS: pinned against upstream (drift guard)', () => {
  it('is exactly upstream\'s full incoming-notification list minus the two genuinely-unreachable methods', () => {
    // Upstream AgentDock's own app-server-support.ts constant (23 methods, commit 8d0d9ef,
    // cross-verified against its normalizer.ts's own KNOWN_NOTIFICATION_METHODS set), hardcoded
    // here so a future edit to this repo's list that silently drops a method upstream still sends
    // -- or silently re-adds account/rateLimits/updated or a remote-control/MCP-server-lifecycle
    // method that's deliberately excluded -- fails this test instead of drifting unnoticed.
    const upstreamFullList = new Set([
      'remoteControl/status/changed',
      'warning',
      'mcpServer/startupStatus/updated',
      'account/rateLimits/updated',
      'thread/started',
      'thread/status/changed',
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
      'thread/tokenUsage/updated',
      'error',
    ]);
    // Deliberately excluded: this transport never pairs with a remote-control client or
    // configures MCP servers, so these two genuinely cannot fire (see app-server-support.ts's own
    // doc comment). account/rateLimits/updated is separately deferred (#221) until this repo has
    // a usage.rate_limits event.
    const deliberatelyExcluded = new Set(['remoteControl/status/changed', 'mcpServer/startupStatus/updated', 'account/rateLimits/updated']);
    const expected = new Set([...upstreamFullList].filter((method) => !deliberatelyExcluded.has(method)));
    expect(new Set(CODEX_APP_SERVER_INCOMING_NOTIFICATION_METHODS)).toEqual(expected);
  });
});

describe('resolveCodexTransportMode', () => {
  it('defaults to "exec" when unset, not upstream\'s "auto" -- new infrastructure stays inert until an operator opts in', () => {
    expect(resolveCodexTransportMode(undefined)).toBe('exec');
  });

  it('accepts each of the three valid values verbatim', () => {
    expect(resolveCodexTransportMode('exec')).toBe('exec');
    expect(resolveCodexTransportMode('app-server')).toBe('app-server');
    expect(resolveCodexTransportMode('auto')).toBe('auto');
  });

  it('throws on an unrecognized value rather than silently falling back', () => {
    expect(() => resolveCodexTransportMode('APP-SERVER')).toThrow(CodexAppServerUnsupportedError);
    expect(() => resolveCodexTransportMode(' exec')).toThrow(CodexAppServerUnsupportedError);
    expect(() => resolveCodexTransportMode('')).toThrow(CodexAppServerUnsupportedError);
    expect(() => resolveCodexTransportMode('legacy')).toThrow(CodexAppServerUnsupportedError);
  });
});
