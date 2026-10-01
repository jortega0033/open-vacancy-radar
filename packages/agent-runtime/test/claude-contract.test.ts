import { buildClaudeArgs } from '../src/providers/claude/build-args.js';
import { CLAUDE_CAPABILITIES } from '../src/providers/claude/capabilities.js';
import { parseClaudeLine } from '../src/providers/claude/parser.js';
import { describeProviderContract } from './support/provider-contract.js';

describeProviderContract({
  providerId: 'claude',
  capabilities: CLAUDE_CAPABILITIES,
  parseLine: parseClaudeLine,
  buildArgs: buildClaudeArgs,
  fixtures: {
    success: 'fake-claude-success.mjs',
    failure: 'fake-claude-failure.mjs',
    hang: 'fake-hang.mjs',
  },
  expectedAssistantText: 'hello from fixture',
  expectedProviderSessionId: 'claude-fixture-session-id',
  // ADI-04. `promptViaStdin` mirrors providers/claude/adapter.ts; `fixtureSet` mirrors
  // CLAUDE_LEGACY_COMPATIBILITY in providers/compatibility-manifest.ts.
  promptViaStdin: true,
  fixtureSet: 'claude-legacy-2.1.228-v1',
});
