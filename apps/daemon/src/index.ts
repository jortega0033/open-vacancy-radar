import { createConsoleLogger } from '@agent-dock/agent-runtime';
import { generateToken } from './auth-token.js';
import {
  DEFAULT_APP_ID,
  assertNoLiveDaemon,
  discoveryFilePath,
  removeDiscoveryFile,
  writeDiscoveryFile,
} from './discovery-file.js';
import { buildProviderRegistry } from './providers.js';
import { buildServer } from './server.js';
import { SessionManager } from './session-manager.js';
import { OsMcpCredentialStore } from './mcp/credential-store.js';
import { McpConnectionManager } from './mcp/manager.js';
import { McpSdkConnectorFactory } from './mcp/sdk-connector.js';

async function main() {
  const logger = createConsoleLogger('daemon', process.env.AGENT_DOCK_LOG_LEVEL === 'debug' ? 'debug' : 'info');
  // Namespaces the discovery rendezvous per application (AD-02) so two different products built
  // on this boilerplate can each run their own daemon at once instead of colliding on one
  // machine-global path. The reference desktop app never sets this — it only matters for a fork
  // that wants to coexist with another AgentDock-based app on the same machine.
  const appId = process.env.AGENT_DOCK_APP_ID?.trim() || DEFAULT_APP_ID;
  assertNoLiveDaemon(appId);
  const registry = buildProviderRegistry(logger);
  const sessionManager = new SessionManager(registry, logger);
  const token = generateToken();
  const mcpCredentials = new OsMcpCredentialStore();
  // Provider-specific policies (starting with #29) inject their OAuthClientProvider here. Keeping
  // the registry empty means an OAuth server can never be contacted before its redirect URI,
  // PKCE/token persistence, terms, tool, and retention policy have all been reviewed together.
  const mcpManager = new McpConnectionManager(
    [],
    new McpSdkConnectorFactory(mcpCredentials),
    mcpCredentials,
    logger,
  );

  const app = buildServer({ registry, sessionManager, token, logger, mcpManager });

  const requestedPort = Number(process.env.AGENT_DOCK_PORT ?? '0');
  await app.listen({ port: requestedPort, host: '127.0.0.1' });

  const address = app.server.address();
  const port = typeof address === 'object' && address ? address.port : requestedPort;

  const filePath = writeDiscoveryFile({ port, token, pid: process.pid, startedAt: new Date().toISOString() }, appId);
  logger.info('daemon listening', { url: `http://127.0.0.1:${port}`, appId, discoveryFile: filePath });

  let shuttingDown = false;
  async function shutdown(signal: string) {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info('shutting down', { signal });
    await sessionManager.cancelAll();
    await mcpManager.close();
    await app.close();
    removeDiscoveryFile(appId);
    process.exit(0);
  }

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((err) => {
  console.error('daemon failed to start:', err instanceof Error ? err.message : err);
  process.exit(1);
});

export { discoveryFilePath };
