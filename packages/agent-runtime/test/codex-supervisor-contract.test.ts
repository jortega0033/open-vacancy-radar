import { parseCodexLine } from '../src/providers/codex/parser.js';
import { describeSupervisorContract } from './support/supervisor-contract.js';

describeSupervisorContract({
  providerId: 'codex',
  pinnedVersion: '0.147.0',
  parseLine: parseCodexLine,
  // Mirrors providers/codex/adapter.ts, which sets no `promptViaStdin`: buildCodexArgs embeds the
  // prompt in argv. Selects the 'process-spawn-attempt' boundary: process creation hands the prompt
  // over unconditionally, so the spawn attempt itself is 'accepted', not a weaker 'unknown'.
  promptViaStdin: false,
  expectedAcceptedWorkAfterOutput: 'accepted',
  fixtures: {
    success: 'fake-codex-success.mjs',
    failure: 'fake-claude-failure.mjs',
    hang: 'fake-hang.mjs',
  },
});
