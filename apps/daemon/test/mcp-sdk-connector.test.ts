import { describe, expect, it, vi } from 'vitest';
import type { OAuthClientProvider } from '@modelcontextprotocol/client';
import { McpSdkConnectorFactory } from '../src/mcp/sdk-connector.js';
import { mcpProviderResultSchema, type McpCredentialStore, type McpProviderPolicy } from '../src/mcp/types.js';

const credentials: McpCredentialStore = {
  get: vi.fn(async () => null),
  set: vi.fn(async () => undefined),
  delete: vi.fn(async () => undefined),
};

function policy(transport: McpProviderPolicy['transport']): McpProviderPolicy {
  return {
    id: 'approved', displayName: 'Approved', transport, searchTool: 'search_jobs',
    mapSearchArguments: ({ query, limit }) => ({ query, limit }),
    parseResult: (value) => mcpProviderResultSchema.parse(value).jobs,
    sourceUrl: 'https://example.test/jobs', attribution: 'Example jobs', policyVersion: '1',
    policyReviewedAt: '2026-08-30', retentionMs: 1_000, timeoutMs: 1_000,
    maximumPayloadBytes: 10_000, killSwitches: { connection: true, search: true, persistence: true },
  };
}

describe('official MCP SDK connector wiring', () => {
  it('constructs the fixed local stdio transport without spawning before connect', async () => {
    const session = await new McpSdkConnectorFactory(credentials).create(
      policy({ kind: 'stdio', command: 'approved-command', args: ['--read-only'] }),
    );
    await expect(session.close()).resolves.toBeUndefined();
  });

  it('passes OAuth policies through the SDK OAuthClientProvider/PKCE path', async () => {
    const oauthProvider = {} as OAuthClientProvider;
    const oauthFactory = vi.fn(() => oauthProvider);
    const session = await new McpSdkConnectorFactory(credentials, oauthFactory).create(
      policy({ kind: 'streamable-http', endpoint: 'https://mcp.example.test/mcp', auth: 'oauth-pkce' }),
    );
    expect(oauthFactory).toHaveBeenCalledOnce();
    await expect(session.close()).resolves.toBeUndefined();
  });

  it('fails closed when an OAuth provider adapter has not supplied its PKCE state/token handler', async () => {
    await expect(new McpSdkConnectorFactory(credentials).create(
      policy({ kind: 'streamable-http', endpoint: 'https://mcp.example.test/mcp', auth: 'oauth-pkce' }),
    )).rejects.toThrow('OAuth authorization is not configured');
  });
});
