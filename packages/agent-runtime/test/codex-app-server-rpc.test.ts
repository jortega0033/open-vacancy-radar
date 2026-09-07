import { describe, expect, it, vi } from 'vitest';
import { CodexAppServerRpc, type CodexAppServerRpcOptions, type IncomingRequestResponder } from '../src/providers/codex/app-server/rpc.js';
import { CodexAppServerProtocolError } from '../src/providers/codex/app-server/errors.js';

function line(value: unknown): Buffer {
  return Buffer.from(`${JSON.stringify(value)}\n`, 'utf8');
}

function setup(overrides: Partial<CodexAppServerRpcOptions> = {}) {
  const written: Buffer[] = [];
  const notifications: Array<{ method: string; params: unknown }> = [];
  const requests: IncomingRequestResponder[] = [];
  const fatals: Error[] = [];
  const rpc = new CodexAppServerRpc({
    write: async (frame) => {
      written.push(frame);
    },
    onNotification: (method, params) => notifications.push({ method, params }),
    onRequest: (request) => {
      requests.push(request);
    },
    onFatal: (error) => fatals.push(error),
    ...overrides,
  });
  return { rpc, written, notifications, requests, fatals };
}

describe('CodexAppServerRpc: outgoing allowlist', () => {
  it('rejects request() for a method not on the allowlist, never writing anything', async () => {
    const { rpc, written } = setup();
    await expect(rpc.request('thread/fork', {})).rejects.toThrow(CodexAppServerProtocolError);
    expect(written).toHaveLength(0);
  });

  it('rejects notify() for a method not on the allowlist', async () => {
    const { rpc } = setup();
    await expect(rpc.notify('turn/steer')).rejects.toThrow(CodexAppServerProtocolError);
  });

  it('writes a correctly-framed newline-delimited JSON request for an allowlisted method', async () => {
    const { rpc, written } = setup();
    const pending = rpc.request('account/read', { foo: 'bar' });
    await vi.waitFor(() => expect(written).toHaveLength(1));
    const frame = written[0]!.toString('utf8');
    expect(frame.endsWith('\n')).toBe(true);
    expect(JSON.parse(frame)).toMatchObject({ method: 'account/read', id: 1, params: { foo: 'bar' } });
    rpc.acceptStdout(line({ id: 1, result: {} }));
    await expect(pending).resolves.toEqual({});
  });
});

describe('CodexAppServerRpc: request/response correlation', () => {
  it('resolves a pending request when its matching response arrives', async () => {
    const { rpc } = setup();
    const pending = rpc.request('account/read', {});
    rpc.acceptStdout(line({ id: 1, result: { authSource: 'chatgpt' } }));
    await expect(pending).resolves.toEqual({ authSource: 'chatgpt' });
  });

  it('rejects a pending request when its response carries an error', async () => {
    const { rpc } = setup();
    const pending = rpc.request('model/list', {});
    rpc.acceptStdout(line({ id: 1, error: { code: -32000, message: 'boom' } }));
    await expect(pending).rejects.toThrow(CodexAppServerProtocolError);
  });

  it('fails the whole RPC on a response with an unknown id (no matching pending request)', () => {
    const { rpc, fatals } = setup();
    rpc.acceptStdout(line({ id: 999, result: {} }));
    expect(fatals).toHaveLength(1);
    expect((fatals[0] as CodexAppServerProtocolError).code).toBe('response_invalid');
  });

  it('fails the whole RPC on a duplicate response for an already-completed id', () => {
    const { rpc, fatals } = setup();
    const pending = rpc.request('account/read', {});
    void pending.catch(() => undefined);
    rpc.acceptStdout(line({ id: 1, result: {} }));
    rpc.acceptStdout(line({ id: 1, result: {} }));
    expect(fatals).toHaveLength(1);
    expect((fatals[0] as CodexAppServerProtocolError).code).toBe('response_invalid');
  });

  it('evicts the oldest completed-id record once more than 10,000 requests have completed, reporting a late duplicate as "unknown" rather than "duplicate"', async () => {
    const { rpc, fatals } = setup();
    // Complete request id 1, then 10,000 more (ids 2..10,001) so id 1's "completed" record is
    // exactly at the eviction boundary and gets pushed out.
    for (let i = 1; i <= 10_001; i += 1) {
      const pending = rpc.request('account/read', {});
      void pending.catch(() => undefined);
      rpc.acceptStdout(line({ id: i, result: {} }));
    }
    expect(fatals).toHaveLength(0);
    // A late "response" for the now-evicted id 1 must be classified as unknown, not duplicate --
    // proving the sliding window actually evicted it rather than growing unbounded.
    rpc.acceptStdout(line({ id: 1, result: {} }));
    expect(fatals).toHaveLength(1);
    const error = fatals[0] as CodexAppServerProtocolError;
    expect(error.code).toBe('response_invalid');
    expect(error.message).toContain('unknown response id');
  }, 15_000);
});

describe('CodexAppServerRpc: incoming frame validation', () => {
  it('fails fatally on malformed (non-UTF-8-decodable) JSON', () => {
    const { rpc, fatals } = setup();
    rpc.acceptStdout(Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('\n')]));
    expect(fatals).toHaveLength(1);
    expect((fatals[0] as CodexAppServerProtocolError).code).toBe('frame_invalid');
  });

  it('fails fatally on a frame exceeding the 1 MiB cap', () => {
    const { rpc, fatals } = setup();
    const huge = Buffer.alloc(1024 * 1024 + 10, 0x61);
    rpc.acceptStdout(Buffer.concat([huge, Buffer.from('\n')]));
    expect(fatals).toHaveLength(1);
    expect((fatals[0] as CodexAppServerProtocolError).code).toBe('frame_too_large');
  });

  it('fails fatally on an incoming notification method that is not allowlisted', () => {
    const { rpc, fatals } = setup();
    rpc.acceptStdout(line({ method: 'thread/fork/completed', params: {} }));
    expect(fatals).toHaveLength(1);
    expect((fatals[0] as CodexAppServerProtocolError).code).toBe('forbidden_method');
  });

  it('delivers an allowlisted incoming notification to onNotification', () => {
    const { rpc, notifications } = setup();
    rpc.acceptStdout(line({ method: 'turn/completed', params: { status: 'completed' } }));
    expect(notifications).toEqual([{ method: 'turn/completed', params: { status: 'completed' } }]);
  });

  it('fails fatally on a malformed envelope carrying both a method and a result', () => {
    const { rpc, fatals } = setup();
    rpc.acceptStdout(line({ method: 'turn/completed', result: {} }));
    expect(fatals).toHaveLength(1);
    expect((fatals[0] as CodexAppServerProtocolError).code).toBe('frame_invalid');
  });

  it('fails fatally on an empty line', () => {
    const { rpc, fatals } = setup();
    rpc.acceptStdout(Buffer.from('\n'));
    expect(fatals).toHaveLength(1);
    expect((fatals[0] as CodexAppServerProtocolError).code).toBe('frame_invalid');
  });

  it('buffers a frame split across multiple stdout chunks and still parses it correctly', () => {
    const { rpc, notifications } = setup();
    const full = line({ method: 'turn/started', params: { turnId: 't1' } });
    rpc.acceptStdout(full.subarray(0, 10));
    rpc.acceptStdout(full.subarray(10));
    expect(notifications).toEqual([{ method: 'turn/started', params: { turnId: 't1' } }]);
  });

  it('strips a trailing \\r before the \\n (CRLF line endings)', () => {
    const { rpc, notifications } = setup();
    const withCrlf = Buffer.from(`${JSON.stringify({ method: 'turn/started', params: { turnId: 't1' } })}\r\n`, 'utf8');
    rpc.acceptStdout(withCrlf);
    expect(notifications).toEqual([{ method: 'turn/started', params: { turnId: 't1' } }]);
  });

  it('strips a trailing \\r even when the \\r and \\n arrive in separate chunks', () => {
    const { rpc, notifications } = setup();
    const withCrlf = Buffer.from(`${JSON.stringify({ method: 'turn/started', params: { turnId: 't1' } })}\r\n`, 'utf8');
    // Split so the \r ends up in the first chunk and only the \n starts the second -- the
    // implementation must still recognize the frame ends in \r once the newline arrives, not
    // just when \r and \n arrive together.
    rpc.acceptStdout(withCrlf.subarray(0, withCrlf.byteLength - 1));
    rpc.acceptStdout(withCrlf.subarray(withCrlf.byteLength - 1));
    expect(notifications).toEqual([{ method: 'turn/started', params: { turnId: 't1' } }]);
  });
});

describe('CodexAppServerRpc: incoming server-initiated requests', () => {
  it('fails fatally on an incoming request method that is not allowlisted at all', () => {
    const { rpc, fatals } = setup();
    rpc.acceptStdout(line({ id: 'srv-1', method: 'thread/fork/completed', params: {} }));
    expect(fatals).toHaveLength(1);
    expect((fatals[0] as CodexAppServerProtocolError).code).toBe('forbidden_method');
  });

  it('accepts a notification-only method sent as a request (carrying an id), matching upstream\'s own general incoming-method gate', () => {
    // thread/status/changed is allowlisted as a notification (a real running session sends it
    // routinely), but never as a request -- isCodexAppServerIncomingMethod's own definition is the
    // union of both incoming lists, so this specifically proves handleIncomingRequest does not
    // treat "on the notification list" as license to also accept it with an id attached.
    const { rpc, fatals } = setup();
    rpc.acceptStdout(line({ id: 'srv-1b', method: 'thread/status/changed', params: {} }));
    expect(fatals).toHaveLength(0);
  });

  it('delivers an allowlisted server request to onRequest, and respond() writes a correctly-shaped response', async () => {
    const { rpc, requests, written } = setup();
    rpc.acceptStdout(line({ id: 'srv-1', method: 'item/commandExecution/requestApproval', params: { command: 'ls' } }));
    expect(requests).toHaveLength(1);
    const request = requests[0]!;
    expect(request).toMatchObject({ id: 'srv-1', method: 'item/commandExecution/requestApproval', params: { command: 'ls' } });
    await request.respond({ decision: 'approved' });
    expect(written).toHaveLength(1);
    expect(JSON.parse(written[0]!.toString('utf8'))).toEqual({ id: 'srv-1', result: { decision: 'approved' } });
  });

  it('reject() writes a correctly-shaped error response', async () => {
    const { rpc, requests, written } = setup();
    rpc.acceptStdout(line({ id: 'srv-2', method: 'mcpServer/elicitation/request', params: {} }));
    await requests[0]!.reject(-32001, 'denied by fixed policy');
    expect(JSON.parse(written[0]!.toString('utf8'))).toEqual({
      id: 'srv-2',
      error: { code: -32001, message: 'denied by fixed policy' },
    });
  });

  it('a second respond()/reject() call on the same request throws rather than double-answering', async () => {
    const { rpc, requests } = setup();
    rpc.acceptStdout(line({ id: 'srv-3', method: 'item/fileChange/requestApproval', params: {} }));
    await requests[0]!.respond({ decision: 'approved' });
    await expect(requests[0]!.respond({ decision: 'approved' })).rejects.toThrow(CodexAppServerProtocolError);
  });

  it('fails fatally on a duplicate incoming request id', () => {
    const { rpc, fatals } = setup();
    rpc.acceptStdout(line({ id: 'srv-4', method: 'item/permissions/requestApproval', params: {} }));
    rpc.acceptStdout(line({ id: 'srv-4', method: 'item/permissions/requestApproval', params: {} }));
    expect(fatals).toHaveLength(1);
    expect((fatals[0] as CodexAppServerProtocolError).code).toBe('response_invalid');
  });
});

describe('CodexAppServerRpc: shutdown and failure propagation', () => {
  it('shutdown() rejects every pending request and further calls fail closed', async () => {
    const { rpc } = setup();
    const pending = rpc.request('account/read', {});
    rpc.shutdown();
    await expect(pending).rejects.toThrow(CodexAppServerProtocolError);
    await expect(rpc.request('model/list', {})).rejects.toThrow(CodexAppServerProtocolError);
  });

  it('fail() rejects every pending request and calls onFatal exactly once', async () => {
    const { rpc, fatals } = setup();
    const pending = rpc.request('account/read', {});
    rpc.fail(new CodexAppServerProtocolError('process_failed', 'process died'));
    await expect(pending).rejects.toThrow('process died');
    expect(fatals).toHaveLength(1);
  });

  it('endStdout() fails fatally if a partial (incomplete) frame was buffered', () => {
    const { rpc, fatals } = setup();
    rpc.acceptStdout(Buffer.from('{"method":"turn/started"')); // no trailing newline
    rpc.endStdout();
    expect(fatals).toHaveLength(1);
    expect((fatals[0] as CodexAppServerProtocolError).code).toBe('frame_invalid');
  });

  it('endStdout() is a no-op when there is no buffered partial frame', () => {
    const { rpc, fatals } = setup();
    rpc.acceptStdout(line({ method: 'turn/started', params: {} }));
    rpc.endStdout();
    expect(fatals).toHaveLength(0);
  });
});
