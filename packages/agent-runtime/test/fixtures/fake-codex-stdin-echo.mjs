// The Codex-shaped counterpart to fake-stdin-echo.mjs (ADI-14). Simulates `codex exec - --json`:
// the `-` placeholder means the real CLI reads its instructions from stdin, so this reads stdin to
// completion and echoes it back verbatim inside a normal Codex JSONL `thread.started` /
// `item.completed`(agent_message) / `turn.completed` sequence, which parseCodexLine normalizes
// exactly like a real response.
//
// It echoes back TWO things, in this order, as two agent_message items:
//   1. its own argv (everything after the script path), as JSON
//   2. everything it received on stdin, verbatim
//
// Together those prove both halves of why the prompt moved off argv: that it survives
// spawnProcess -> child.stdin.write()/.end() byte-for-byte at sizes that could never have fitted
// in a Windows command line (~32,767 characters total), and that the spawned process's real,
// observable argv never contains the prompt text at all.
const argv = process.argv.slice(2);
const chunks = [];
process.stdin.on('data', (chunk) => chunks.push(chunk));
process.stdin.on('end', () => {
  const received = Buffer.concat(chunks).toString('utf8');
  const lines = [
    JSON.stringify({ type: 'thread.started', thread_id: 'codex-stdin-echo-thread-id' }),
    JSON.stringify({ type: 'turn.started' }),
    JSON.stringify({
      type: 'item.completed',
      item: { id: 'item_argv', type: 'agent_message', text: JSON.stringify(argv) },
    }),
    JSON.stringify({
      type: 'item.completed',
      item: { id: 'item_stdin', type: 'agent_message', text: received },
    }),
    JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 1 } }),
  ];
  process.stdout.write(lines.join('\n') + '\n');
});
