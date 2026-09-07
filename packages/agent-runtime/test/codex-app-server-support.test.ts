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
