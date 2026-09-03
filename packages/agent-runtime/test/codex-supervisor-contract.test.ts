import { parseCodexLine } from '../src/providers/codex/parser.js';
import { describeSupervisorContract } from './support/supervisor-contract.js';

describeSupervisorContract({
  providerId: 'codex',
  pinnedVersion: '0.147.0',
  parseLine: parseCodexLine,
  // Mirrors providers/codex/adapter.ts as of ADI-14, which now sets `promptViaStdin: true`.
  // Selects the 'first-prompt-byte-to-stdin' boundary, so an observed stdin flush -- not the spawn
  // attempt -- is what makes work 'accepted'. The terminal value is unchanged ('accepted'); what
  // changed is *when* the latch gets there, which the suite's "accepted-work boundary timing"
  // section proves directly rather than leaving to this comment.
  promptViaStdin: true,
  expectedAcceptedWorkAfterOutput: 'accepted',
  fixtures: {
    success: 'fake-codex-success.mjs',
    failure: 'fake-claude-failure.mjs',
    hang: 'fake-hang.mjs',
  },
});
