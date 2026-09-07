import { describe, expect, it } from 'vitest';
import { CODEX_APP_SERVER_INCOMING_NOTIFICATION_METHODS } from '../src/providers/codex/app-server-support.js';
import { CodexAppServerNormalizer } from '../src/providers/codex/app-server/normalizer.js';
import { CodexAppServerProtocolError } from '../src/providers/codex/app-server/errors.js';

describe('CodexAppServerNormalizer: exhaustiveness', () => {
  it('has a case for every allowlisted incoming notification method -- no silent gap', () => {
    const normalizer = new CodexAppServerNormalizer();
    for (const method of CODEX_APP_SERVER_INCOMING_NOTIFICATION_METHODS) {
      // Every real param shape differs by method; passing an empty object proves only that the
      // method itself resolves to a case (doesn't throw the specific "no normalizer case"
      // state_invalid error) -- some will still throw for other, expected reasons (e.g. a missing
      // required field), which is fine and asserted against below, not fatal to this loop.
      try {
        normalizer.normalize(method, {});
      } catch (error) {
        if (error instanceof CodexAppServerProtocolError && error.message.includes('no normalizer case')) {
          throw new Error(`CodexAppServerNormalizer has no case for allowlisted method: ${method}`);
        }
      }
    }
  });
});

describe('CodexAppServerNormalizer: session lifecycle', () => {
  it('captures providerSessionId from thread/started and threads it into session.completed', () => {
    const normalizer = new CodexAppServerNormalizer();
    expect(normalizer.normalize('thread/started', { thread: { id: 'thread-abc' } })).toEqual([]);
    expect(normalizer.normalize('turn/completed', { turn: { id: 't1', status: 'completed' } })).toEqual([
      { type: 'session.completed', providerSessionId: 'thread-abc' },
    ]);
  });

  it('maps turn.status completed/interrupted/failed to the three distinct terminal events', () => {
    const completed = new CodexAppServerNormalizer();
    expect(completed.normalize('turn/completed', { turn: { id: 't1', status: 'completed' } })).toEqual([
      { type: 'session.completed', providerSessionId: undefined },
    ]);
    const interrupted = new CodexAppServerNormalizer();
    expect(interrupted.normalize('turn/completed', { turn: { id: 't1', status: 'interrupted' } })).toEqual([{ type: 'session.cancelled' }]);
    const failed = new CodexAppServerNormalizer();
    expect(failed.normalize('turn/completed', { turn: { id: 't1', status: 'failed' } })).toEqual([{ type: 'session.failed', message: 'Codex turn failed' }]);
  });

  it('throws on an unrecognized turn status', () => {
    const normalizer = new CodexAppServerNormalizer();
    expect(() => normalizer.normalize('turn/completed', { turn: { id: 't1', status: 'somethingElse' } })).toThrow(CodexAppServerProtocolError);
  });

  it('maps turn/started to a status event', () => {
    const normalizer = new CodexAppServerNormalizer();
    expect(normalizer.normalize('turn/started', { threadId: 'thread-abc', turn: { id: 't1' } })).toEqual([{ type: 'status', status: 'turn_started' }]);
  });
});

describe('CodexAppServerNormalizer: item lifecycle', () => {
  it('emits assistant.message only on a completed agentMessage item with text', () => {
    const normalizer = new CodexAppServerNormalizer();
    expect(normalizer.normalize('item/started', { item: { id: 'i1', type: 'agentMessage' } })).toEqual([]);
    expect(normalizer.normalize('item/completed', { item: { id: 'i1', type: 'agentMessage', text: 'hello' } })).toEqual([
      { type: 'assistant.message', text: 'hello' },
    ]);
  });

  it('does not emit assistant.message for a completed agentMessage with empty text', () => {
    const normalizer = new CodexAppServerNormalizer();
    expect(normalizer.normalize('item/completed', { item: { id: 'i1', type: 'agentMessage', text: '' } })).toEqual([]);
  });

  it('maps commandExecution start/complete to tool.started/tool.completed', () => {
    const normalizer = new CodexAppServerNormalizer();
    expect(normalizer.normalize('item/started', { item: { id: 'i1', type: 'commandExecution', command: 'ls' } })).toEqual([
      { type: 'tool.started', toolName: 'shell', toolCallId: 'i1', input: { command: 'ls' } },
    ]);
    expect(normalizer.normalize('item/completed', { item: { id: 'i1', type: 'commandExecution', command: 'ls', exitCode: 0, status: 'completed' } })).toEqual([
      { type: 'tool.completed', toolName: 'shell', toolCallId: 'i1', result: { command: 'ls', exitCode: 0 }, isError: false },
    ]);
  });

  it('marks a failed commandExecution as isError: true', () => {
    const normalizer = new CodexAppServerNormalizer();
    expect(
      normalizer.normalize('item/completed', { item: { id: 'i1', type: 'commandExecution', exitCode: 1, status: 'failed' } }),
    ).toEqual([{ type: 'tool.completed', toolName: 'shell', toolCallId: 'i1', result: { command: undefined, exitCode: 1 }, isError: true }]);
  });

  it('maps fileChange start/complete to tool.started/tool.completed', () => {
    const normalizer = new CodexAppServerNormalizer();
    const changes = [{ path: 'a.txt' }];
    expect(normalizer.normalize('item/started', { item: { id: 'i2', type: 'fileChange', changes } })).toEqual([
      { type: 'tool.started', toolName: 'file_change', toolCallId: 'i2', input: { changes } },
    ]);
    expect(normalizer.normalize('item/completed', { item: { id: 'i2', type: 'fileChange', changes, status: 'completed' } })).toEqual([
      { type: 'tool.completed', toolName: 'file_change', toolCallId: 'i2', result: { changes }, isError: false },
    ]);
  });

  it('maps mcpToolCall start/complete to a bounded tool name', () => {
    const normalizer = new CodexAppServerNormalizer();
    expect(normalizer.normalize('item/started', { item: { id: 'i3', type: 'mcpToolCall', server: 'search', tool: 'query', arguments: { q: 'x' } } })).toEqual([
      { type: 'tool.started', toolName: 'mcp:search/query', toolCallId: 'i3', input: { q: 'x' } },
    ]);
    expect(
      normalizer.normalize('item/completed', { item: { id: 'i3', type: 'mcpToolCall', server: 'search', tool: 'query', result: { ok: true }, status: 'completed' } }),
    ).toEqual([{ type: 'tool.completed', toolName: 'mcp:search/query', toolCallId: 'i3', result: { ok: true }, isError: false }]);
  });

  it('emits no event for an unrecognized item type (e.g. reasoning, deferred in this port)', () => {
    const normalizer = new CodexAppServerNormalizer();
    expect(normalizer.normalize('item/started', { item: { id: 'i4', type: 'reasoning', text: 'thinking...' } })).toEqual([]);
    expect(normalizer.normalize('item/completed', { item: { id: 'i4', type: 'reasoning', text: 'thinking...' } })).toEqual([]);
  });
});

describe('CodexAppServerNormalizer: usage and errors', () => {
  it('maps thread/tokenUsage/updated to a usage event', () => {
    const normalizer = new CodexAppServerNormalizer();
    expect(
      normalizer.normalize('thread/tokenUsage/updated', { threadId: 'thread-abc', turnId: 't1', tokenUsage: { last: { inputTokens: 10, outputTokens: 5, cachedInputTokens: 2 } } }),
    ).toEqual([{ type: 'usage', inputTokens: 10, outputTokens: 5, cachedInputTokens: 2 }]);
  });

  it('maps the top-level error notification, deriving recoverable from willRetry', () => {
    const normalizer = new CodexAppServerNormalizer();
    expect(normalizer.normalize('error', { willRetry: true })).toEqual([{ type: 'error', message: 'Codex app-server reported an error', recoverable: true }]);
    expect(normalizer.normalize('error', {})).toEqual([{ type: 'error', message: 'Codex app-server reported an error', recoverable: false }]);
  });
});

describe('CodexAppServerNormalizer: deliberate no-ops', () => {
  it('consumes ordinary in-progress notifications without emitting an event or throwing', () => {
    const normalizer = new CodexAppServerNormalizer();
    const noopMethods = [
      'thread/status/changed',
      'turn/plan/updated',
      'turn/diff/updated',
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
    ] as const;
    for (const method of noopMethods) {
      expect(normalizer.normalize(method, {})).toEqual([]);
    }
  });
});

describe('CodexAppServerNormalizer: malformed input', () => {
  it('throws CodexAppServerProtocolError on a structurally malformed thread/started', () => {
    const normalizer = new CodexAppServerNormalizer();
    expect(() => normalizer.normalize('thread/started', 'not an object')).toThrow(CodexAppServerProtocolError);
    expect(() => normalizer.normalize('thread/started', { thread: 'not an object' })).toThrow(CodexAppServerProtocolError);
  });

  it('throws CodexAppServerProtocolError on a structurally malformed item notification', () => {
    const normalizer = new CodexAppServerNormalizer();
    expect(() => normalizer.normalize('item/started', { item: 'not an object' })).toThrow(CodexAppServerProtocolError);
  });
});
