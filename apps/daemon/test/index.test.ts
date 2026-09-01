import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { noopLogger } from '@agent-dock/agent-runtime';
import { afterAll, describe, expect, it } from 'vitest';
import { removeDiscoveryFile } from '../src/discovery-file.js';
import { STATE_DIR_ENV_VAR } from '../src/state-directory.js';

/**
 * Importing `../src/index.js` runs `main()`, because that module calls it at import time. That is
 * what the assertion below wants (it checks the real, constructed MCP manager rather than a regex
 * over `main()`'s source), but `main()` also opens the durable session store -- and with no
 * override it resolves to the *machine's* per-user application-data root
 * (`%LOCALAPPDATA%\agent-dock\sessions-v1`, or the platform equivalent). Running the daemon's own
 * unit tests must not create, recover, or apply retention to a developer's or a CI runner's actual
 * daemon state, so the state directory is redirected into a temp dir here, before the import that
 * triggers it.
 *
 * The env vars are set by plain assignment and the module is loaded with a dynamic `import()`, both
 * for one reason: ESM hoists every static import above the module body, so an override written in a
 * `beforeAll` -- or even at the top of this file, ahead of a static import -- would run *after*
 * `main()` had already read the environment.
 */
const stateRoot = mkdtempSync(join(tmpdir(), 'agent-dock-daemon-bootstrap-'));
const appId = `agent-dock-test-${process.pid}`;
process.env[STATE_DIR_ENV_VAR] = stateRoot;
// A per-run app id keeps this out of the way of a daemon the developer may genuinely have running:
// on the shared default id, `assertNoLiveDaemon` would find it and `main()` would answer with
// `process.exit(1)` from inside the test worker.
process.env.AGENT_DOCK_APP_ID = appId;

const { buildMcpManager } = await import('../src/index.js');
const { OsMcpCredentialStore } = await import('../src/mcp/credential-store.js');

afterAll(() => {
  removeDiscoveryFile(appId);
  rmSync(stateRoot, { recursive: true, force: true });
  delete process.env[STATE_DIR_ENV_VAR];
  delete process.env.AGENT_DOCK_APP_ID;
});

describe('daemon bootstrap: MCP policy gate', () => {
  it('wires McpConnectionManager with an empty policy array, so no MCP provider is reachable until a policy is reviewed', () => {
    // Asserts against the real, constructed manager -- not a regex over main()'s source text --
    // so a refactor that preserves the empty-policy invariant (e.g. naming the array, reordering
    // constructor args) can't silently defeat this test the way a source-text pin could. A
    // provider-specific policy (#29+) must be an explicit, reviewed change to buildMcpManager's own
    // body. See docs/adr-agentdock-v2-provenance.md#the-mcp-foundation-ships-dormant-on-purpose.
    const manager = buildMcpManager(new OsMcpCredentialStore(), noopLogger);
    expect(manager.providerIds()).toEqual([]);
  });
});

describe('daemon bootstrap: state stays inside the configured state directory', () => {
  it('opened the durable store under AGENT_DOCK_STATE_DIR, not the machine default', () => {
    // `main()` runs synchronously as far as its first `await` (the port bind), and
    // `openDurableStore()` is well before that, so by the time the dynamic import above resolved the
    // store had already been constructed. Finding its manifest here is direct evidence that the
    // override took effect -- if a future edit hoists the import back above the assignment, or drops
    // the override, this fails rather than quietly seeding a real store on the machine running CI.
    expect(existsSync(join(stateRoot, 'sessions-v1', 'manifest.json'))).toBe(true);
  });
});
