export { mcpJobDetailRequestSchema, mcpProviderIdSchema, mcpProviderResultSchema, mcpSearchRequestSchema } from '@agent-dock/shared';
export type {
  McpConnectionStatus,
  McpJobDetailRequest,
  McpProviderId,
  McpSearchRequest,
  McpVacancy,
  McpVacancyResult,
} from '@agent-dock/shared';
import type { McpJobDetailRequest, McpProviderId, McpSearchRequest, McpVacancy } from '@agent-dock/shared';

export type McpTool = { name: string; inputSchema?: unknown };
export interface McpSession {
  connect(signal: AbortSignal): Promise<void>;
  listTools(signal: AbortSignal): Promise<McpTool[]>;
  callTool(name: string, args: Record<string, unknown>, signal: AbortSignal): Promise<unknown>;
  close(): Promise<void>;
}

export interface McpConnectorFactory {
  create(policy: McpProviderPolicy): Promise<McpSession>;
}

export interface McpCredentialStore {
  get(providerId: McpProviderId): Promise<string | null>;
  set(providerId: McpProviderId, value: string): Promise<void>;
  delete(providerId: McpProviderId): Promise<void>;
}

export type McpTransportPolicy =
  | { kind: 'streamable-http'; endpoint: string; auth: 'none' | 'api-key' | 'oauth-pkce' }
  | { kind: 'stdio'; command: string; args: readonly string[] };

export type McpProviderPolicy = {
  id: McpProviderId;
  displayName: string;
  transport: McpTransportPolicy;
  searchTool: string;
  mapSearchArguments(request: Pick<McpSearchRequest, 'query' | 'limit'>): Record<string, unknown>;
  parseResult(value: unknown): McpVacancy[];
  /**
   * Optional second allowlisted tool ("get_job" and equivalents) for an on-demand single-listing
   * lookup. All three of `detailTool`/`mapDetailArguments`/`parseDetailResult` are provided together
   * or not at all -- a policy that never sets them simply has no detail capability, and
   * `McpConnectionManager#getJob` refuses to call anything for it. This is still exactly two
   * hardcoded, policy-authored tool names ever reachable per provider, never a caller-suppliable one.
   */
  detailTool?: string;
  mapDetailArguments?(request: Pick<McpJobDetailRequest, 'externalId'>): Record<string, unknown>;
  parseDetailResult?(value: unknown): unknown;
  sourceUrl: string;
  attribution: string;
  policyVersion: string;
  policyReviewedAt: string;
  retentionMs: number;
  timeoutMs: number;
  maximumPayloadBytes: number;
  killSwitches: { connection: boolean; search: boolean; persistence: boolean };
  revokeCredential?: (credential: string) => Promise<void>;
};
