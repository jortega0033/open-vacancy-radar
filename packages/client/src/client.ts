import {
  AGENT_DOCK_PROTOCOL_VERSION,
  AGENT_DOCK_SUPPORTED_PROTOCOL_VERSIONS,
  PROTOCOL_VERSION_V2,
  agentSessionSchema,
  createSessionRequestSchema,
  daemonProtocolVersions,
  healthResponseSchema,
  negotiateProtocolVersion,
  providerStatusSchema,
  supportsProtocolVersion,
  mcpConnectionStatusSchema,
  mcpCredentialInputSchema,
  mcpProviderIdSchema,
  mcpSearchRequestSchema,
  mcpVacancyResultSchema,
  type AgentEventEnvelope,
  type AgentSession,
  type CreateSessionRequest,
  type ProtocolNegotiation,
  type ProviderId,
  type ProviderStatus,
  type McpConnectionStatus,
  type McpCredentialInput,
  type McpProviderId,
  type McpSearchRequest,
  type McpVacancyResult,
} from '@agent-dock/shared';
import {
  DaemonError,
  DaemonUnavailableError,
  ProtocolMismatchError,
  ProviderUnavailableError,
  SessionNotFoundError,
  UnauthorizedError,
  ValidationError,
  type AgentDockClientError,
} from './errors.js';
import { parseSseStream } from './sse.js';

/**
 * Trims trailing `/` characters without a regex. `baseUrl` is caller-supplied, and a
 * quantifier-anchored pattern here (`/\/+$/`) is exactly the shape CodeQL's polynomial-ReDoS query
 * flags on unbounded input — a plain backward scan is O(n) with no backtracking possible at all,
 * so this closes the finding structurally rather than arguing the input happens to be trusted today.
 */
function stripTrailingSlashes(url: string): string {
  let end = url.length;
  while (end > 0 && url.charCodeAt(end - 1) === 47 /* '/' */) end--;
  return url.slice(0, end);
}

export interface AgentDockClientOptions {
  /** e.g. `http://127.0.0.1:54321` (no trailing slash required). */
  baseUrl: string;
  token: string;
  /** Injectable for tests; defaults to the ambient global `fetch`. */
  fetch?: typeof fetch;
}

export interface HealthResponse {
  status: 'ok';
  uptimeSeconds: number;
  protocolVersion: number;
  /** Absent from a pre-v2 daemon. See `ProtocolSupport` and `client.v2`. */
  supportedProtocolVersions?: readonly number[];
}

export interface SessionEventsOptions {
  signal?: AbortSignal;
  /** Resume from the SSE `id:` after this value, instead of a full replay from the start. */
  lastEventId?: string;
}

/** What this client and the connected daemon negotiated, derived entirely from one `GET /health` call. */
export type ProtocolSupport = ProtocolNegotiation;

interface CompatibilityResult {
  health: HealthResponse;
  support: ProtocolSupport;
}

/**
 * Typed client for the AgentDock daemon's HTTP + SSE API. Owns everything a caller shouldn't
 * have to hand-write: the daemon URL, the bearer token, JSON request/response handling,
 * incremental SSE parsing, and a protocol-version compatibility check performed automatically
 * before the first real request. See docs/protocol-v1.md.
 *
 * No reconnect logic: `sessions.events()` opens exactly one stream and ends when the daemon
 * closes it (at the session's terminal event) or `signal` aborts. If the connection drops for any
 * other reason, the generator throws: call `sessions.events()` again to resume; because the
 * daemon replays its full stored event history to a fresh subscriber (or from `lastEventId`
 * onward), a bare retry is a complete, correct "reconnect" with no separate resume protocol needed.
 */
export class AgentDockClient {
  private readonly baseUrl: string;
  private readonly token: string;
  private readonly fetchImpl: typeof fetch;
  private compatibilityCheck: Promise<CompatibilityResult> | undefined;

  readonly providers = {
    list: (): Promise<ProviderStatus[]> => this.listProviders(),
    get: (id: ProviderId): Promise<ProviderStatus> => this.getProvider(id),
  };

  readonly sessions = {
    create: (input: CreateSessionRequest): Promise<AgentSession> => this.createSession(input),
    get: (id: string): Promise<AgentSession> => this.getSession(id),
    events: (id: string, options?: SessionEventsOptions): AsyncGenerator<AgentEventEnvelope, void, void> =>
      this.streamSessionEvents(id, options),
    cancel: (id: string): Promise<void> => this.cancelSession(id),
    delete: (id: string): Promise<void> => this.deleteSession(id),
    /** Cancels every in-flight session on the daemon. Used by the desktop shutdown path so
     * quitting the app doesn't orphan any session besides the one it happens to be tracking
     * (see electron/main.ts#killDaemon). */
    cancelAll: (): Promise<void> => this.cancelAllSessions(),
  };

  readonly mcp = {
    statuses: (): Promise<McpConnectionStatus[]> => this.listMcpStatuses(),
    search: (input: McpSearchRequest): Promise<McpVacancyResult[]> => this.searchMcp(input),
    setCredential: (input: McpCredentialInput): Promise<void> => this.setMcpCredential(input),
    remove: (providerId: McpProviderId): Promise<void> => this.removeMcpProvider(providerId),
  };

  /**
   * Protocol-v2 negotiation only -- this daemon has no `/v2` routes yet, so this issues no request
   * of its own beyond the one `/health` call every method already makes. It exists as the real gate
   * a later change adds v2 routes behind (each new v2 method opens with `client.v2.require()`),
   * not as a stub: a v2 method added without going through this gate would be the "deferred route"
   * this repo's AgentDock port is explicitly required not to introduce.
   */
  readonly v2 = {
    /** True once this client and the daemon negotiate protocol 2. Resolves `false`, never throws, for a reachable daemon that simply doesn't support it. */
    isSupported: (): Promise<boolean> => this.isProtocolV2Supported(),
    /** The negotiated view of `/health`. Throws only if the daemon is unreachable, or its response is malformed or shares no version with this client at all. */
    support: (): Promise<ProtocolSupport> => this.protocolSupport(),
    /** Asserts protocol 2 is usable; throws `ProtocolMismatchError` otherwise. */
    require: (): Promise<ProtocolSupport> => this.requireProtocolV2(),
  };

  constructor(options: AgentDockClientOptions) {
    this.baseUrl = stripTrailingSlashes(options.baseUrl);
    this.token = options.token;
    this.fetchImpl = options.fetch ?? globalThis.fetch.bind(globalThis);
  }

  /**
   * Checks the daemon is reachable and speaks protocol 1. Also the check every v1 method runs
   * before its own request. Its throwing behavior is unchanged from before v2 negotiation existed:
   * it throws `ProtocolMismatchError` whenever this daemon does not support v1, exactly as it did
   * when `protocolVersion` was compared directly -- callers that use `health()` as a readiness gate
   * (see apps/desktop/electron/main.ts#waitForDaemonReady) keep the same guarantee.
   */
  async health(): Promise<HealthResponse> {
    return (await this.ensureProtocolVersion(AGENT_DOCK_PROTOCOL_VERSION)).health;
  }

  private async protocolSupport(): Promise<ProtocolSupport> {
    return (await this.ensureCompatible()).support;
  }

  private async isProtocolV2Supported(): Promise<boolean> {
    const { support } = await this.ensureCompatible();
    return supportsProtocolVersion(support, PROTOCOL_VERSION_V2);
  }

  private async requireProtocolV2(): Promise<ProtocolSupport> {
    return (await this.ensureProtocolVersion(PROTOCOL_VERSION_V2)).support;
  }

  /**
   * Fetches and validates `/health`, then negotiates every version this client and the daemon
   * share. Throws only when the daemon is unreachable, its response is malformed, or the two sides
   * share NO version at all -- a specific version's availability (e.g. "does this daemon support
   * v1?") is a separate check, `ensureProtocolVersion`, since a daemon can share some version
   * without sharing the one a particular caller actually needs.
   */
  private ensureCompatible(): Promise<CompatibilityResult> {
    if (!this.compatibilityCheck) {
      this.compatibilityCheck = this.checkCompatibility().catch((err: unknown) => {
        // Don't let a transient failure (daemon still starting up, briefly unreachable) poison
        // every future call: the next one gets a fresh check.
        this.compatibilityCheck = undefined;
        throw err;
      });
    }
    return this.compatibilityCheck;
  }

  private async checkCompatibility(): Promise<CompatibilityResult> {
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.baseUrl}/health`);
    } catch (err) {
      throw new DaemonUnavailableError(`could not reach the daemon at ${this.baseUrl}: ${errorMessage(err)}`, {
        cause: err,
      });
    }
    if (!res.ok) {
      throw new DaemonUnavailableError(`daemon health check failed with status ${res.status}`);
    }
    const json = await res.json().catch(() => undefined);
    const parsed = healthResponseSchema.safeParse(json);
    if (!parsed.success) {
      throw new ValidationError(`daemon /health response did not match the expected shape: ${parsed.error.message}`);
    }
    const daemonVersions = daemonProtocolVersions(parsed.data);
    const support = negotiateProtocolVersion(AGENT_DOCK_SUPPORTED_PROTOCOL_VERSIONS, daemonVersions);
    if (!support) {
      // Matches the pre-negotiation error exactly: report the legacy version this client has
      // always claimed, against the daemon's own headline protocolVersion, not a derived max of
      // either side's full version set (which could name a version neither side actually uses).
      throw new ProtocolMismatchError(AGENT_DOCK_PROTOCOL_VERSION, parsed.data.protocolVersion);
    }
    return { health: parsed.data, support };
  }

  /** Asserts a specific protocol version is usable against this daemon, throwing `ProtocolMismatchError` otherwise. */
  private async ensureProtocolVersion(version: number): Promise<CompatibilityResult> {
    const result = await this.ensureCompatible();
    if (!supportsProtocolVersion(result.support, version)) {
      // Reports the daemon's own headline protocolVersion, not a derived max of its full
      // advertised set: the latter can name a version neither side actually selected (e.g. a
      // daemon listing [1, 3] that negotiated down to 1 with this client would otherwise report
      // "the daemon reports protocol 3", which is technically true but answers a different
      // question than "why did my request for version X just fail").
      throw new ProtocolMismatchError(version, result.health.protocolVersion);
    }
    return result;
  }

  private async request<T>(
    path: string,
    init: RequestInit = {},
    opts: { notFound?: () => AgentDockClientError } = {},
  ): Promise<T> {
    await this.ensureProtocolVersion(AGENT_DOCK_PROTOCOL_VERSION);

    let res: Response;
    try {
      res = await this.fetchImpl(`${this.baseUrl}${path}`, {
        ...init,
        headers: { ...(init.headers ?? {}), Authorization: `Bearer ${this.token}` },
      });
    } catch (err) {
      throw new DaemonUnavailableError(`could not reach the daemon at ${this.baseUrl}: ${errorMessage(err)}`, {
        cause: err,
      });
    }

    if (res.status === 401) throw new UnauthorizedError();
    if (res.status === 404 && opts.notFound) throw opts.notFound();

    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      const message = body.error ?? `daemon request failed with status ${res.status}`;
      if (res.status === 400) throw new ValidationError(message);
      throw new DaemonError(message, res.status);
    }

    if (res.status === 204) return undefined as T;
    return (await res.json()) as T;
  }

  private async listProviders(): Promise<ProviderStatus[]> {
    const body = await this.request<{ providers: unknown[] }>('/providers');
    return body.providers.map((raw) => validate(providerStatusSchema, raw, 'provider status'));
  }

  private async listMcpStatuses(): Promise<McpConnectionStatus[]> {
    const body = await this.request<{ providers: unknown[] }>('/mcp/providers');
    return body.providers.map((raw) => validate(mcpConnectionStatusSchema, raw, 'MCP provider status'));
  }

  private async searchMcp(input: McpSearchRequest): Promise<McpVacancyResult[]> {
    const parsed = mcpSearchRequestSchema.parse(input);
    const body = await this.request<{ results: unknown[] }>('/mcp/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(parsed),
    });
    return body.results.map((raw) => validate(mcpVacancyResultSchema, raw, 'MCP vacancy result'));
  }

  private async setMcpCredential(input: McpCredentialInput): Promise<void> {
    const parsed = mcpCredentialInputSchema.parse(input);
    await this.request<void>(`/mcp/providers/${encodeURIComponent(parsed.providerId)}/credential`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ credential: parsed.credential }),
    });
  }

  private async removeMcpProvider(providerId: McpProviderId): Promise<void> {
    const parsed = mcpProviderIdSchema.parse(providerId);
    await this.request<void>(`/mcp/providers/${encodeURIComponent(parsed)}`, { method: 'DELETE' });
  }

  private async getProvider(id: ProviderId): Promise<ProviderStatus> {
    const raw = await this.request<unknown>(`/providers/${encodeURIComponent(id)}`, undefined, {
      notFound: () => new ProviderUnavailableError(`provider not registered: ${id}`),
    });
    return validate(providerStatusSchema, raw, 'provider status');
  }

  private async createSession(input: CreateSessionRequest): Promise<AgentSession> {
    createSessionRequestSchema.parse(input); // fail fast client-side before ever making the request
    const raw = await this.request<unknown>('/sessions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    });
    return validate(agentSessionSchema, raw, 'session');
  }

  private async getSession(id: string): Promise<AgentSession> {
    const raw = await this.request<unknown>(`/sessions/${encodeURIComponent(id)}`, undefined, {
      notFound: () => new SessionNotFoundError(id),
    });
    return validate(agentSessionSchema, raw, 'session');
  }

  private async *streamSessionEvents(
    id: string,
    options: SessionEventsOptions = {},
  ): AsyncGenerator<AgentEventEnvelope, void, void> {
    await this.ensureProtocolVersion(AGENT_DOCK_PROTOCOL_VERSION);

    const headers: Record<string, string> = { Authorization: `Bearer ${this.token}` };
    if (options.lastEventId) headers['Last-Event-ID'] = options.lastEventId;

    let res: Response;
    try {
      res = await this.fetchImpl(`${this.baseUrl}/sessions/${encodeURIComponent(id)}/events`, {
        headers,
        signal: options.signal,
      });
    } catch (err) {
      if (options.signal?.aborted) return; // caller cancelled before/while connecting; not an error
      throw new DaemonUnavailableError(`could not reach the daemon at ${this.baseUrl}: ${errorMessage(err)}`, {
        cause: err,
      });
    }

    if (res.status === 401) throw new UnauthorizedError();
    if (res.status === 404) throw new SessionNotFoundError(id);
    if (!res.ok || !res.body) {
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      throw new DaemonError(body.error ?? `failed to open event stream (status ${res.status})`, res.status);
    }

    yield* parseSseStream(res.body, options.signal);
  }

  private async cancelSession(id: string): Promise<void> {
    await this.request<unknown>(
      `/sessions/${encodeURIComponent(id)}/cancel`,
      { method: 'POST' },
      { notFound: () => new SessionNotFoundError(id) },
    );
  }

  private async deleteSession(id: string): Promise<void> {
    await this.request<void>(
      `/sessions/${encodeURIComponent(id)}`,
      { method: 'DELETE' },
      { notFound: () => new SessionNotFoundError(id) },
    );
  }

  private async cancelAllSessions(): Promise<void> {
    await this.request<unknown>('/sessions/cancel-all', { method: 'POST' });
  }
}

function validate<T>(schema: { safeParse: (v: unknown) => { success: boolean; data?: T; error?: { message: string } } }, raw: unknown, label: string): T {
  const result = schema.safeParse(raw);
  if (!result.success) {
    throw new ValidationError(`daemon returned a ${label} that does not match the protocol: ${result.error?.message}`);
  }
  return result.data as T;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
