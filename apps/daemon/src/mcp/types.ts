export { mcpProviderIdSchema, mcpProviderResultSchema, mcpSearchRequestSchema } from '@agent-dock/shared';
export type {
  McpConnectionStatus,
  McpProviderId,
  McpSearchRequest,
  McpVacancy,
  McpVacancyResult,
} from '@agent-dock/shared';
import type { McpProviderId, McpSearchRequest, McpVacancy } from '@agent-dock/shared';

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
