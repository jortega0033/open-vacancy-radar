import { noopLogger } from '@agent-dock/agent-runtime';
import { describe, expect, it } from 'vitest';
import { buildMcpManager } from '../src/index.js';
import { OsMcpCredentialStore } from '../src/mcp/credential-store.js';

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
