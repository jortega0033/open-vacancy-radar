// Stands in for `codex app-server --stdio` for scope-probe tests: a minimal, real newline-delimited
// JSON-RPC responder. Answers `initialize` with an empty result, ignores the `initialized`
// notification, and answers `account/read`/`model/list` with the fixed responses configured via
// two JSON-encoded argv arguments (never environment variables: `spawnProcess()`'s allowlist-by-name
// filter would silently drop any custom env var before the fixture ever saw it) -- letting each
// test configure a specific account/model scenario without a richer control protocol. Any other
// request gets a generic error response, so an unexpected outgoing call fails visibly rather than
// hanging. `ManagedAppServerProcess` appends `app-server --stdio` after `executableArgs`, so these
// two config args must come first.
const accountResponse = JSON.parse(process.argv[2] ?? '{"requiresOpenaiAuth":true,"account":{"type":"chatgpt","email":"user@example.com"}}');
const modelResponse = JSON.parse(process.argv[3] ?? '{"data":[{"id":"gpt-5-codex","displayName":"GPT-5 Codex","isDefault":true}]}');

let buffered = '';
process.stdin.on('data', (chunk) => {
  buffered += chunk.toString('utf8');
  let newline;
  while ((newline = buffered.indexOf('\n')) !== -1) {
    const line = buffered.slice(0, newline);
    buffered = buffered.slice(newline + 1);
    if (!line) continue;
    const message = JSON.parse(line);
    if (message.id === undefined) continue; // a notification, e.g. `initialized`
    if (message.method === 'initialize') {
      process.stdout.write(`${JSON.stringify({ id: message.id, result: {} })}\n`);
    } else if (message.method === 'account/read') {
      process.stdout.write(`${JSON.stringify({ id: message.id, result: accountResponse })}\n`);
    } else if (message.method === 'model/list') {
      process.stdout.write(`${JSON.stringify({ id: message.id, result: modelResponse })}\n`);
    } else {
      process.stdout.write(`${JSON.stringify({ id: message.id, error: { code: -32601, message: `unexpected method: ${message.method}` } })}\n`);
    }
  }
});
