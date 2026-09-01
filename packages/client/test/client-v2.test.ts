import { describe, expect, it, vi } from 'vitest';
import { AGENT_DOCK_PROTOCOL_VERSION, PROTOCOL_VERSION_V2 } from '@agent-dock/shared';
import { AgentDockClient } from '../src/client.js';
import { DaemonUnavailableError, ProtocolMismatchError, ValidationError } from '../src/errors.js';

const BASE_URL = 'http://127.0.0.1:9999';
const TOKEN = 'test-token';

function jsonResponse(status: number, body: unknown) {
  return { ok: status >= 200 && status < 300, status, headers: new Headers(), json: async () => body } as Response;
}

/** A daemon that speaks only protocol 1 -- exactly what this repo's own daemon emits today. */
function healthV1Only() {
  return jsonResponse(200, { status: 'ok', uptimeSeconds: 1, protocolVersion: AGENT_DOCK_PROTOCOL_VERSION });
}

/** A daemon that speaks 1 and 2. No such daemon exists in this repo yet -- this fixture IS the v1/v2 daemon. */
function healthV1V2() {
  return jsonResponse(200, {
    status: 'ok',
    uptimeSeconds: 1,
    protocolVersion: AGENT_DOCK_PROTOCOL_VERSION,
    supportedProtocolVersions: [AGENT_DOCK_PROTOCOL_VERSION, PROTOCOL_VERSION_V2],
  });
}

/** A hypothetical future daemon that dropped v1 entirely. */
function healthV2Only() {
  return jsonResponse(200, { status: 'ok', uptimeSeconds: 1, protocolVersion: PROTOCOL_VERSION_V2, supportedProtocolVersions: [PROTOCOL_VERSION_V2] });
}

function makeClient(fetchImpl: typeof fetch) {
  return new AgentDockClient({ baseUrl: BASE_URL, token: TOKEN, fetch: fetchImpl });
}

function urlsCalled(fetchImpl: ReturnType<typeof vi.fn>): string[] {
  return fetchImpl.mock.calls.map((call: unknown[]) => String(call[0]));
}

describe('client.v2: negotiation against a v1-only daemon', () => {
  it('isSupported() resolves false without throwing', async () => {
    const client = makeClient(vi.fn().mockResolvedValue(healthV1Only()));
    await expect(client.v2.isSupported()).resolves.toBe(false);
  });

  it('support() resolves with v1 as the only shared/selected version', async () => {
    const client = makeClient(vi.fn().mockResolvedValue(healthV1Only()));
    await expect(client.v2.support()).resolves.toMatchObject({ daemonVersions: [1], selected: 1 });
  });

  it('require() rejects with ProtocolMismatchError naming client v2 and the daemon\'s actual version', async () => {
    const client = makeClient(vi.fn().mockResolvedValue(healthV1Only()));
    const error = await client.v2.require().catch((err: unknown) => err);
    expect(error).toBeInstanceOf(ProtocolMismatchError);
    expect((error as ProtocolMismatchError).clientVersion).toBe(PROTOCOL_VERSION_V2);
    expect((error as ProtocolMismatchError).daemonVersion).toBe(1);
  });

  it('v1 top-level methods still work normally', async () => {
    const fetchImpl = vi.fn().mockImplementation(async (url: string) => {
      if (url.endsWith('/health')) return healthV1Only();
      return jsonResponse(200, { providers: [] });
    });
    const client = makeClient(fetchImpl);
    await expect(client.providers.list()).resolves.toEqual([]);
  });
});

describe('client.v2: negotiation against a v1/v2 daemon', () => {
  it('isSupported() resolves true', async () => {
    const client = makeClient(vi.fn().mockResolvedValue(healthV1V2()));
    await expect(client.v2.isSupported()).resolves.toBe(true);
  });

  it('support() resolves with 2 as the negotiated top, alongside both daemon versions', async () => {
    const client = makeClient(vi.fn().mockResolvedValue(healthV1V2()));
    await expect(client.v2.support()).resolves.toEqual({ clientVersions: [1, 2], daemonVersions: [1, 2], selected: 2 });
  });

  it('require() resolves instead of throwing', async () => {
    const client = makeClient(vi.fn().mockResolvedValue(healthV1V2()));
    await expect(client.v2.require()).resolves.toMatchObject({ selected: 2 });
  });

  it('every v1 top-level method still hits its v1 URL, never a /v2 path', async () => {
    const fetchImpl = vi.fn().mockImplementation(async (url: string) => {
      if (url.endsWith('/health')) return healthV1V2();
      return jsonResponse(200, { providers: [] });
    });
    const client = makeClient(fetchImpl);
    await client.providers.list();
    const urls = urlsCalled(fetchImpl);
    expect(urls.some((url) => url.includes('/v2'))).toBe(false);
    expect(urls).toContain(`${BASE_URL}/providers`);
  });

  it('client.v2 issues no request beyond the shared /health call -- no deferred route is introduced', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(healthV1V2());
    const client = makeClient(fetchImpl);

    await client.v2.isSupported();
    await client.v2.support();
    await client.v2.require();

    const urls = urlsCalled(fetchImpl);
    expect(urls.every((url) => url.endsWith('/health'))).toBe(true);
  });

  it('reuses the single cached compatibility check across v1 calls and client.v2 calls alike', async () => {
    const fetchImpl = vi.fn().mockImplementation(async (url: string) => {
      if (url.endsWith('/health')) return healthV1V2();
      return jsonResponse(200, { providers: [] });
    });
    const client = makeClient(fetchImpl);

    await client.health();
    await client.v2.isSupported();
    await client.v2.support();
    await client.providers.list();

    const healthCalls = urlsCalled(fetchImpl).filter((url) => url.endsWith('/health'));
    expect(healthCalls).toHaveLength(1);
  });
});

describe('client.v2: a daemon that dropped v1 entirely', () => {
  it('health() rejects with ProtocolMismatchError, unchanged from before v2 negotiation existed: health() has always meant "v1 works", not merely "some version is shared"', async () => {
    const client = makeClient(vi.fn().mockResolvedValue(healthV2Only()));
    await expect(client.health()).rejects.toBeInstanceOf(ProtocolMismatchError);
  });

  it('every v1 top-level method still rejects with ProtocolMismatchError, since v1 itself is not supported', async () => {
    const fetchImpl = vi.fn().mockImplementation(async (url: string) => {
      if (url.endsWith('/health')) return healthV2Only();
      return jsonResponse(200, { providers: [] });
    });
    const client = makeClient(fetchImpl);
    await expect(client.providers.list()).rejects.toBeInstanceOf(ProtocolMismatchError);
  });

  it('client.v2.require() resolves, since v2 is exactly what this daemon speaks', async () => {
    const client = makeClient(vi.fn().mockResolvedValue(healthV2Only()));
    await expect(client.v2.require()).resolves.toMatchObject({ selected: 2 });
  });
});

describe('client.v2: validation and reachability', () => {
  it('rejects a malformed /health response with ValidationError, not a TypeError', async () => {
    const client = makeClient(vi.fn().mockResolvedValue(jsonResponse(200, { status: 'ok' })));
    await expect(client.v2.support()).rejects.toBeInstanceOf(ValidationError);
  });

  it('rejects a /health response with duplicate supportedProtocolVersions entries', async () => {
    const client = makeClient(
      vi.fn().mockResolvedValue(jsonResponse(200, { status: 'ok', uptimeSeconds: 1, protocolVersion: 1, supportedProtocolVersions: [1, 1] })),
    );
    await expect(client.v2.support()).rejects.toBeInstanceOf(ValidationError);
  });

  it('rejects a /health response with an empty supportedProtocolVersions array', async () => {
    const client = makeClient(
      vi.fn().mockResolvedValue(jsonResponse(200, { status: 'ok', uptimeSeconds: 1, protocolVersion: 1, supportedProtocolVersions: [] })),
    );
    await expect(client.v2.support()).rejects.toBeInstanceOf(ValidationError);
  });

  it('rejects an unreachable daemon with DaemonUnavailableError from isSupported(), never resolving false for "cannot tell"', async () => {
    const client = makeClient(vi.fn().mockRejectedValue(new Error('ECONNREFUSED')));
    await expect(client.v2.isSupported()).rejects.toBeInstanceOf(DaemonUnavailableError);
  });

  it('rejects with ProtocolMismatchError naming the legacy client version and the daemon\'s own reported version, when the client and daemon share no version at all', async () => {
    const client = makeClient(
      vi.fn().mockResolvedValue(jsonResponse(200, { status: 'ok', uptimeSeconds: 1, protocolVersion: 9, supportedProtocolVersions: [9] })),
    );
    const error = await client.v2.support().catch((err: unknown) => err);
    expect(error).toBeInstanceOf(ProtocolMismatchError);
    expect((error as ProtocolMismatchError).clientVersion).toBe(AGENT_DOCK_PROTOCOL_VERSION);
    expect((error as ProtocolMismatchError).daemonVersion).toBe(9);
  });

  it('rejects a self-contradictory /health response where supportedProtocolVersions omits protocolVersion', async () => {
    const client = makeClient(
      vi.fn().mockResolvedValue(jsonResponse(200, { status: 'ok', uptimeSeconds: 1, protocolVersion: 1, supportedProtocolVersions: [2] })),
    );
    await expect(client.v2.support()).rejects.toBeInstanceOf(ValidationError);
  });

  it('every error path above issues no request beyond the single /health call, same as the happy path', async () => {
    const cases = [
      { status: 'ok' },
      { status: 'ok', uptimeSeconds: 1, protocolVersion: 1, supportedProtocolVersions: [1, 1] },
      { status: 'ok', uptimeSeconds: 1, protocolVersion: 9, supportedProtocolVersions: [9] },
    ];
    for (const body of cases) {
      const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(200, body));
      const client = makeClient(fetchImpl);
      await client.v2.support().catch(() => undefined);
      expect(urlsCalled(fetchImpl).every((url) => url.endsWith('/health'))).toBe(true);
    }
  });
});

describe('adding client.v2 moved nothing at the top level', () => {
  it('the client still exposes providers, sessions, and mcp unchanged, plus the new v2 namespace', () => {
    const client = makeClient(vi.fn());
    expect(Object.keys(client.providers).sort()).toEqual(['get', 'list'].sort());
    expect(Object.keys(client.sessions).sort()).toEqual(['cancel', 'cancelAll', 'create', 'delete', 'events', 'get'].sort());
    expect(Object.keys(client.mcp).sort()).toEqual(['remove', 'search', 'setCredential', 'statuses'].sort());
    expect(Object.keys(client.v2).sort()).toEqual(['isSupported', 'require', 'support'].sort());
  });
});
