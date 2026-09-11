import { describe, expect, it } from 'vitest';
import { CLAUDE_CAPABILITIES } from '../src/providers/claude/capabilities.js';
import { CODEX_CAPABILITIES } from '../src/providers/codex/capabilities.js';
import { FAKE_PROVIDER_CAPABILITIES } from '../src/providers/fake/adapter.js';
import { buildClaudeArgs, CLAUDE_HARDENING_ARGS_NO_NETWORK } from '../src/providers/claude/build-args.js';
import { buildCodexArgs } from '../src/providers/codex/build-args.js';

const BASE = { sessionId: 'b2c3d4e5-0000-4000-8000-000000000001', cwd: '/workspace', prompt: 'map these fields' };

/**
 * `ProviderCapabilities.hardenedNoNetwork` (issue #284) exists so the stage router can refuse to
 * select a provider for the field-map stage without writing `if (provider.id === 'claude')` outside
 * this package. A capability that says something the adapter does not actually do would be worse
 * than no capability at all, so these tests pin the declaration against the argv it claims.
 *
 * Neither of these is an assertion about a model's abilities. They are assertions about two
 * `buildArgs` functions, which is what `ProviderCapabilities`' own doc comment says a capability
 * means.
 */
describe('hardenedNoNetwork matches what the adapters actually build', () => {
  it('Claude declares it, and its argv really changes when the profile is asked for', () => {
    expect(CLAUDE_CAPABILITIES.hardenedNoNetwork).toBe(true);

    const hardened = buildClaudeArgs({ ...BASE, hardened: 'no-network' });
    const plain = buildClaudeArgs(BASE);
    expect(hardened).not.toEqual(plain);
    for (const arg of CLAUDE_HARDENING_ARGS_NO_NETWORK) {
      expect(hardened).toContain(arg);
    }
  });

  it('Codex does not declare it, and its argv is genuinely identical either way', () => {
    // The fact the flag encodes: asking Codex for the profile changes nothing, so a router that
    // believed the declaration would be routing a scraped job description to a session with
    // WebFetch/WebSearch still allowed. `buildCodexArgs` never reads `opts.hardened`, deliberately
    // and permanently -- see its own doc comment.
    expect(CODEX_CAPABILITIES.hardenedNoNetwork).toBeUndefined();
    expect(buildCodexArgs({ ...BASE, hardened: 'no-network' })).toEqual(buildCodexArgs(BASE));
  });

  it('the in-process fake does not declare it either: it restricts nothing', () => {
    // FakeProvider spawns no process and builds no argv, so it implements no hardening profile. The
    // daemon suites that register it under the id 'claude' therefore prove the field-map route's own
    // literal provider check rather than this capability -- which is exactly the separation #284
    // requires: selection and admission are two independent layers.
    expect(FAKE_PROVIDER_CAPABILITIES.hardenedNoNetwork).toBeUndefined();
  });
});
