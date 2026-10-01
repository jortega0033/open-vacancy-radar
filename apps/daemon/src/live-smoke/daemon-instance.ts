import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createConsoleLogger, type Logger } from '@agent-dock/agent-runtime';
import { generateToken } from '../auth-token.js';
import { buildProviderRegistry } from '../providers.js';
import { buildServer } from '../server.js';
import { SessionManager } from '../session-manager.js';

export interface LiveSmokeDaemonInstance {
  baseUrl: string;
  token: string;
  logger: Logger;
  close(): Promise<void>;
}

/**
 * Builds and starts a real daemon -- the actual `buildServer`/`SessionManager`/provider registry
 * this repo ships, not a stand-in -- on an ephemeral port. Deliberately v1-only (ADI-19's scope:
 * see `types.ts`'s own doc comment on why): `buildServer`'s `v2` option is omitted entirely, which
 * is the real downgrade mechanism this repo already has (see `server.ts`'s own doc comment on
 * `BuildServerV2Options`) -- no durable store, workspace-trust store, audit store, or execution
 * lease manager needs constructing at all, since none of them exist without `v2` and v1's own
 * `POST /sessions` route needs none of them either.
 *
 * Deliberately does not touch the real desktop app's discovery file or state directory: a live
 * smoke run must never collide with (or be mistaken for) the user's real running daemon. The temp
 * directory it does create is for the `mkdtemp` guarantee alone (an ephemeral, private, PID-unique
 * name) -- nothing is actually written into it, since v1 needs no persisted state.
 */
export async function startLiveSmokeDaemon(): Promise<LiveSmokeDaemonInstance> {
  const stateDirectory = await mkdtemp(join(tmpdir(), 'agent-dock-live-smoke-daemon-'));
  const logger = createConsoleLogger('live-smoke', 'info');
  const registry = buildProviderRegistry(logger);
  const sessionManager = new SessionManager(registry, logger);
  const token = generateToken();
  const app = buildServer({ registry, sessionManager, token, logger });
  await app.listen({ port: 0, host: '127.0.0.1' });
  const address = app.server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    token,
    logger,
    async close() {
      try {
        await sessionManager.cancelAll().catch(() => {});
        await app.close().catch(() => {});
      } finally {
        // Nothing is actually written under `stateDirectory` (see the doc comment above), but it
        // is still removed unconditionally -- ADI-19 requires this harness to never leak temporary
        // state, and there is no reason to special-case "this run happened to write nothing" over
        // just always cleaning up the directory `mkdtemp` created.
        await rm(stateDirectory, { recursive: true, force: true, maxRetries: 3 });
      }
    },
  };
}
