import { parseClaudeLine } from '../src/providers/claude/parser.js';
import { describeSupervisorContract } from './support/supervisor-contract.js';

describeSupervisorContract({
  providerId: 'claude',
  pinnedVersion: '2.1.228',
  parseLine: parseClaudeLine,
  // Mirrors providers/claude/adapter.ts. Selects the 'first-prompt-byte-to-stdin' boundary, so an
  // observed stdin flush is direct evidence of delivery: 'accepted', not merely 'unknown'.
  promptViaStdin: true,
  expectedAcceptedWorkAfterOutput: 'accepted',
  fixtures: {
    success: 'fake-claude-success.mjs',
    failure: 'fake-claude-failure.mjs',
    hang: 'fake-hang.mjs',
  },
});
