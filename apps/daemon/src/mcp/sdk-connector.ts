import {
  Client,
  StreamableHTTPClientTransport,
  type AuthProvider,
  type OAuthClientProvider,
} from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import type { McpConnectorFactory, McpCredentialStore, McpProviderPolicy, McpSession } from './types.js';

/** Provider adapters supply redirect/token persistence; the official SDK owns OAuth 2.1 discovery and PKCE. */
export type McpOAuthProviderFactory = (policy: McpProviderPolicy) => OAuthClientProvider;

export class McpSdkConnectorFactory implements McpConnectorFactory {
  constructor(
    private readonly credentials: McpCredentialStore,
    private readonly oauthProviderFactory?: McpOAuthProviderFactory,
  ) {}

  async create(policy: McpProviderPolicy): Promise<McpSession> {
    const client = new Client({ name: 'open-vacancy-radar', version: '0.1.0' });
    const transport = await this.#transport(policy);
    return {
      async connect(signal) {
        await client.connect(transport, { signal });
      },
      async listTools(signal) {
        const result = await client.listTools(undefined, { signal });
        return result.tools.map((tool) => ({ name: tool.name, inputSchema: tool.inputSchema }));
      },
      async callTool(name, args, signal) {
        return client.callTool({ name, arguments: args }, { signal });
      },
      async close() {
        await client.close();
      },
    };
  }

  async #transport(policy: McpProviderPolicy) {
    if (policy.transport.kind === 'stdio') {
      return new StdioClientTransport({
        command: policy.transport.command,
        args: [...policy.transport.args],
        stderr: 'pipe',
      });
    }
    const endpoint = new URL(policy.transport.endpoint);
    if (endpoint.protocol !== 'https:' || endpoint.username || endpoint.password) {
      throw new Error('remote MCP endpoint must be credential-free HTTPS');
    }
    let authProvider: AuthProvider | OAuthClientProvider | undefined;
    if (policy.transport.auth === 'api-key') {
      authProvider = { token: async () => (await this.credentials.get(policy.id)) ?? '' };
    } else if (policy.transport.auth === 'oauth-pkce') {
      if (!this.oauthProviderFactory) throw new Error('OAuth authorization is not configured');
      authProvider = this.oauthProviderFactory(policy);
    }
    return new StreamableHTTPClientTransport(endpoint, {
      ...(authProvider ? { authProvider } : {}),
      onInsufficientScope: 'throw',
      maxStepUpRetries: 0,
    });
  }
}
