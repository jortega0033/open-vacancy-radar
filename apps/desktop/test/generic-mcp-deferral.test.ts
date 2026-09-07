// @vitest-environment node
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * ADI-10: this repo deliberately never ports upstream AgentDock's generic, renderer-configurable
 * provider-MCP and component-control surface (a server URL/command/tool-name/arguments the renderer
 * can choose) -- see docs/mcp-source-policy.md and docs/adr-generic-mcp-reconsideration.md. The
 * daemon-side half of this guard lives in apps/daemon/test/generic-mcp-deferral.test.ts; this file is
 * the bridge-key half, following the same source-reading convention ADI-16's
 * test/ipc-sender-guard.test.ts established: read main.ts/preload.ts as text and assert what is and
 * is not on the renderer-reachable surface, rather than trusting a human to notice a new bridge method
 * in review.
 */

const ELECTRON_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'electron');

function source(file: string): string {
  return readFileSync(join(ELECTRON_DIR, file), 'utf8');
}

/**
 * Every `.ts` file under electron/, recursively. A channel registered through a helper module (this
 * repo already has one: `agent-workspace-ipc.ts`'s `registerAgentWorkspaceHandlers(ipc, deps)`,
 * called from main.ts but calling `ipc.handle(...)` inside its own file) must not be invisible to
 * this scan just because it isn't literal text in main.ts.
 */
function electronSources(): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.ts')) out.push(readFileSync(full, 'utf8'));
    }
  };
  walk(ELECTRON_DIR);
  return out;
}

/** Every channel any file under electron/ answers, guarded or not -- the whole renderer-reachable
 * request surface, not just what main.ts itself spells out literally. */
function handledChannels(): string[] {
  return electronSources().flatMap((text) => [...text.matchAll(/(?:guardedIpc|ipc)\.handle\(\s*'([^']+)'/g)].map((m) => m[1] as string));
}

/** Every channel preload.ts asks main.ts to answer. */
function preloadInvokeChannels(): string[] {
  return [...source('preload.ts').matchAll(/ipcRenderer\.invoke\(\s*'([^']+)'/g)].map((m) => m[1] as string);
}

/**
 * The complete, reviewed set of MCP-shaped channels this repo exposes: the vacancy-source MCP
 * bridge (ADI's own policy-gated model, see docs/mcp-source-policy.md), not AgentDock's generic
 * provider-MCP. Each takes only an allowlisted providerId and an opaque credential string or search
 * query -- never a server URL, command, header, or tool name (enforced separately by
 * apps/daemon/test/mcp-routes.test.ts's "rejects arbitrary servers, tools, headers, and provider
 * arguments" case). Adding a channel here is exactly the review trigger this test exists to force.
 */
const APPROVED_MCP_CHANNELS = new Set(['daemon:mcp-statuses', 'daemon:mcp-search', 'daemon:mcp-set-credential', 'daemon:mcp-remove']);

describe('generic AgentDock MCP and component control stay off the bridge (ADI-10)', () => {
  it('exposes no MCP-shaped channel beyond the reviewed vacancy-source set', () => {
    const mcpShaped = handledChannels().filter((channel) => /mcp/i.test(channel));
    expect(new Set(mcpShaped)).toEqual(APPROVED_MCP_CHANNELS);
    // And the renderer only ever asks for exactly those four -- no unused generic channel sitting
    // registered-but-uncalled, and no preload call reaching past the approved set.
    const invoked = preloadInvokeChannels().filter((channel) => /mcp/i.test(channel));
    expect(new Set(invoked)).toEqual(APPROVED_MCP_CHANNELS);
  });

  it('registers and exposes no generic component-control or provider-integration channel', () => {
    const banned = /\b(component|integration)/i;
    const offendingHandled = handledChannels().filter((channel) => banned.test(channel));
    const offendingInvoked = preloadInvokeChannels().filter((channel) => banned.test(channel));
    expect(offendingHandled, 'a generic component/integration channel was registered somewhere under electron/').toEqual([]);
    expect(offendingInvoked, 'preload.ts invokes a generic component/integration channel').toEqual([]);
  });

  it('never asks the daemon\'s MCP bridge for a server URL, command, header, or tool name', () => {
    // The four approved channels take a providerId (an allowlisted string enum) and either an
    // opaque credential string or a McpSearchRequest (query/limit); neither the preload interface
    // nor its ipcRenderer.invoke calls carry a field shaped like the renderer-configurable surface
    // this ticket keeps deferred.
    //
    // Anchored on the invoke() call's own channel-name string literals, not a method name like
    // `listMcpProviders` -- that identifier appears twice in this file (once in the `AgentDockBridge`
    // interface's type signature, once in the real implementation below it), and `indexOf` finds the
    // *first* occurrence, i.e. the interface. A channel literal like `'daemon:mcp-statuses'` only
    // ever appears in the implementation, so anchoring there is what actually reaches the real
    // `ipcRenderer.invoke(...)` call sites and their arguments.
    const preloadText = source('preload.ts');
    const start = preloadText.indexOf("'daemon:mcp-statuses'");
    const end = preloadText.indexOf("'daemon:mcp-remove'");
    expect(start, 'daemon:mcp-statuses channel literal not found in preload.ts').toBeGreaterThan(-1);
    expect(end, 'daemon:mcp-remove channel literal not found in preload.ts').toBeGreaterThan(-1);
    const mcpBridgeSection = preloadText.slice(start, end + "'daemon:mcp-remove'".length + 50);
    for (const banned of ['serverUrl', 'command', 'toolName', 'headers', 'endpoint']) {
      expect(mcpBridgeSection, `${banned} appears near the MCP bridge implementation in preload.ts`).not.toContain(banned);
    }
  });
});
