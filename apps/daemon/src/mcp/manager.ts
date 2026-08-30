import type { Logger } from '@agent-dock/agent-runtime';
import { McpResultCache } from './cache.js';
import {
  mcpProviderResultSchema,
  type McpConnectionStatus,
  type McpConnectorFactory,
  type McpCredentialStore,
  type McpProviderId,
  type McpProviderPolicy,
  type McpSearchRequest,
  type McpSession,
  type McpVacancyResult,
} from './types.js';

const MAX_POLICIES = 32;

function abortAfter(timeoutMs: number, external?: AbortSignal): { signal: AbortSignal; abort(reason: Error): void; dispose(): void } {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error('MCP operation timed out')), timeoutMs);
  const onAbort = () => controller.abort(external?.reason);
  if (external?.aborted) onAbort();
  else external?.addEventListener('abort', onAbort, { once: true });
  return {
    signal: controller.signal,
    abort(reason) {
      controller.abort(reason);
    },
    dispose() {
      clearTimeout(timer);
      external?.removeEventListener('abort', onAbort);
    },
  };
}

function serializedSize(value: unknown): number {
  try {
    return Buffer.byteLength(JSON.stringify(value), 'utf8');
  } catch {
    throw new Error('MCP result is not serializable');
  }
}

function safeProviderFailure(error: unknown, signal: AbortSignal): { category: string; error: Error } {
  if (signal.aborted) {
    const timedOut = signal.reason instanceof Error && signal.reason.message === 'MCP operation timed out';
    return { category: timedOut ? 'timeout' : 'cancelled', error: new Error(timedOut ? 'MCP operation timed out' : 'MCP operation cancelled') };
  }
  const message = error instanceof Error ? error.message : '';
  if (/oauth|authori[sz]|unauth|\b401\b/iu.test(message)) {
    return { category: 'authorization', error: new Error('MCP authorization failed') };
  }
  if (/rate.?limit|\b429\b/iu.test(message)) {
    return { category: 'rate_limited', error: new Error('MCP provider rate limited') };
  }
  const policyMessages = [
    'approved MCP search tool is unavailable',
    'MCP payload exceeds provider limit',
    'MCP result is not serializable',
  ];
  if (policyMessages.includes(message)) return { category: 'policy_rejection', error: new Error(message) };
  return { category: 'invalid_response', error: new Error('MCP provider returned an invalid response') };
}

export class McpConnectionManager {
  readonly #policies: ReadonlyMap<McpProviderId, McpProviderPolicy>;
  readonly #cache = new McpResultCache();
  readonly #active = new Map<McpProviderId, Set<{ abort(reason: Error): void }>>();
  readonly #sessions = new Map<McpProviderId, Set<McpSession>>();
  readonly #generation = new Map<McpProviderId, number>();
  readonly #removing = new Set<McpProviderId>();
  #closed = false;

  constructor(
    policies: readonly McpProviderPolicy[],
    private readonly connectors: McpConnectorFactory,
    private readonly credentials: McpCredentialStore,
    private readonly logger: Logger,
    private readonly now: () => Date = () => new Date(),
  ) {
    if (policies.length > MAX_POLICIES) throw new Error('too many MCP provider policies');
    const entries = policies.map((policy) => {
      if (policy.retentionMs <= 0 || policy.timeoutMs <= 0 || policy.maximumPayloadBytes <= 0) {
        throw new Error(`invalid limits for MCP provider ${policy.id}`);
      }
      return [policy.id, policy] as const;
    });
    if (new Set(entries.map(([id]) => id)).size !== entries.length) {
      throw new Error('duplicate MCP provider policy');
    }
    this.#policies = new Map(entries);
  }

  providerIds(): McpProviderId[] {
    return [...this.#policies.keys()];
  }

  async status(providerId: McpProviderId): Promise<McpConnectionStatus> {
    const policy = this.#policy(providerId);
    return {
      providerId,
      enabled: policy.killSwitches.connection && policy.killSwitches.search,
      connectionEnabled: policy.killSwitches.connection,
      searchEnabled: policy.killSwitches.search,
      persistenceEnabled: policy.killSwitches.persistence,
      connected: (this.#sessions.get(providerId)?.size ?? 0) > 0,
      credentialConfigured:
        policy.transport.kind === 'streamable-http' && policy.transport.auth !== 'none'
          ? (await this.credentials.get(providerId)) !== null
          : true,
    };
  }

  async statuses(): Promise<McpConnectionStatus[]> {
    return Promise.all(this.providerIds().map((id) => this.status(id)));
  }

  async setCredential(providerId: McpProviderId, credential: string): Promise<void> {
    const policy = this.#policy(providerId);
    if (policy.transport.kind !== 'streamable-http' || policy.transport.auth !== 'api-key') {
      throw new Error('provider does not accept an API key');
    }
    await this.credentials.set(providerId, credential);
  }

  async search(request: McpSearchRequest, externalSignal?: AbortSignal): Promise<McpVacancyResult[]> {
    const policy = this.#policy(request.providerId);
    if (this.#closed) throw new Error('MCP connection manager is closed');
    if (this.#removing.has(policy.id)) throw new Error('MCP provider connection is being removed');
    if (!policy.killSwitches.connection) throw new Error('MCP provider connection is disabled');
    if (!policy.killSwitches.search) throw new Error('MCP provider search is disabled');

    const operation = abortAfter(policy.timeoutMs, externalSignal);
    const generation = this.#generation.get(policy.id) ?? 0;
    const active = this.#active.get(policy.id) ?? new Set();
    active.add(operation);
    this.#active.set(policy.id, active);
    let session: McpSession | undefined;
    try {
      session = await this.connectors.create(policy);
      if (this.#removing.has(policy.id) || this.#closed) {
        throw new Error('MCP provider connection is unavailable');
      }
      const sessions = this.#sessions.get(policy.id) ?? new Set();
      sessions.add(session);
      this.#sessions.set(policy.id, sessions);
      operation.signal.throwIfAborted();
      await session.connect(operation.signal);
      const tools = await session.listTools(operation.signal);
      const approved = tools.find((tool) => tool.name === policy.searchTool);
      if (!approved) throw new Error('approved MCP search tool is unavailable');
      const raw = await session.callTool(
        policy.searchTool,
        policy.mapSearchArguments({ query: request.query, limit: request.limit }),
        operation.signal,
      );
      operation.signal.throwIfAborted();
      if (serializedSize(raw) > policy.maximumPayloadBytes) throw new Error('MCP payload exceeds provider limit');
      const parsedEnvelope = mcpProviderResultSchema.safeParse(raw);
      const vacancies = parsedEnvelope.success
        ? parsedEnvelope.data.jobs
        : mcpProviderResultSchema.parse({ jobs: policy.parseResult(raw) }).jobs;
      const fetchedAt = this.now();
      const expiresAt = new Date(fetchedAt.getTime() + policy.retentionMs);
      const rows = vacancies.slice(0, request.limit).map((vacancy) => ({
        ...vacancy,
        providerId: policy.id,
        sourceUrl: policy.sourceUrl,
        attribution: policy.attribution,
        policyVersion: policy.policyVersion,
        policyReviewedAt: policy.policyReviewedAt,
        fetchedAt: fetchedAt.toISOString(),
        expiresAt: expiresAt.toISOString(),
      }));
      if (policy.killSwitches.persistence && (this.#generation.get(policy.id) ?? 0) === generation) {
        this.#cache.replace(policy.id, rows);
      }
      this.logger.info('MCP provider search completed', { providerId: policy.id, resultCount: rows.length });
      return rows;
    } catch (error) {
      const failure = safeProviderFailure(error, operation.signal);
      this.logger.warn('MCP provider search failed', {
        providerId: policy.id,
        reason: failure.category,
      });
      throw failure.error;
    } finally {
      operation.dispose();
      active.delete(operation);
      if (active.size === 0) this.#active.delete(policy.id);
      if (session) {
        const sessions = this.#sessions.get(policy.id);
        sessions?.delete(session);
        if (sessions?.size === 0) this.#sessions.delete(policy.id);
      }
      await session?.close().catch(() => undefined);
    }
  }

  cached(providerId: McpProviderId): McpVacancyResult[] {
    this.#policy(providerId);
    return this.#cache.list(providerId, this.now());
  }

  purgeExpired(): number {
    return this.#cache.purgeExpired(this.now());
  }

  async remove(providerId: McpProviderId): Promise<void> {
    const policy = this.#policy(providerId);
    if (this.#removing.has(providerId)) throw new Error('MCP provider connection is already being removed');
    this.#removing.add(providerId);
    this.#generation.set(providerId, (this.#generation.get(providerId) ?? 0) + 1);
    for (const operation of this.#active.get(providerId) ?? []) {
      operation.abort(new Error('MCP provider connection removed'));
    }
    try {
      const credential = await this.credentials.get(providerId);
      let remoteRevocationFailed = false;
      try {
        if (credential !== null && policy.revokeCredential) await policy.revokeCredential(credential);
      } catch {
        remoteRevocationFailed = true;
      }
      await this.credentials.delete(providerId);
      if (remoteRevocationFailed) {
        this.logger.warn('MCP provider removed locally but remote revocation failed', { providerId });
        throw new Error('MCP provider removed locally; remote credential revocation failed');
      }
      this.logger.info('MCP provider connection removed', { providerId });
    } finally {
      this.#cache.deleteProvider(providerId);
      this.#removing.delete(providerId);
    }
  }

  async close(): Promise<void> {
    this.#closed = true;
    for (const operations of this.#active.values()) {
      for (const operation of operations) operation.abort(new Error('MCP connection manager closed'));
    }
    const sessions = [...this.#sessions.values()].flatMap((providerSessions) => [...providerSessions]);
    await Promise.allSettled(sessions.map((session) => session.close()));
  }

  #policy(providerId: McpProviderId): McpProviderPolicy {
    const policy = this.#policies.get(providerId);
    if (!policy) throw new Error('MCP provider is not allowlisted');
    return policy;
  }
}
