// Stands in for `codex app-server --stdio` for CodexAppServerTransport tests: a real newline-
// delimited JSON-RPC responder that plays out one whole thread/turn lifecycle. `process.argv[2]`
// selects the scenario:
//   'success'   -- thread/start -> turn/start -> item/started+completed (agentMessage) ->
//                  turn/completed(status:'completed').
//   'failure'   -- same shape, but turn/completed(status:'failed').
//   'interrupt' -- turn/start succeeds, then the fixture waits: only once it receives a real
//                  turn/interrupt request does it emit turn/completed(status:'interrupted'). If no
//                  interrupt ever arrives, it stays silent (used to prove cancel() actually drives
//                  the interrupted outcome, not a fixed timer).
//   'interrupt-unresponsive' -- turn/start succeeds and emits item/started(commandExecution), so a
//                  test has a real AgentEvent proving the turn is genuinely in flight, but the
//                  fixture never answers turn/interrupt and never sends turn/completed. Used to
//                  prove cancel() really waits out CANCEL_TERMINAL_WAIT_MS and self-resolves, not
//                  just that some fast path happens to also end in session.cancelled.
//   'malformed-thread' -- thread/start's response omits `thread.id` entirely (frame_invalid path).
//   'hang'      -- answers initialize/model/list but never responds to thread/start (adapter-crash/
//                  cancellation-before-thread path).
//   'crash-mid-turn-start' -- answers thread/start normally, then exits(1) instead of ever
//                  answering turn/start -- a real in-flight, unanswered RPC request orphaned by a
//                  process death, exercising ManagedAppServerProcess's onFailure path with a
//                  genuinely pending request (not just a clean, nothing-in-flight exit).
// Only `process.argv[2]` (the scenario) is read, deliberately: `ManagedAppServerProcess` always
// appends `'app-server', '--stdio'` after whatever `executableArgs` the caller supplies, so a
// second config argument here would actually receive the literal string `'app-server'` instead of
// `undefined` -- and `JSON.parse('app-server')` throws, crashing this fixture before it even sets
// up its stdin listener. (This is exactly what happened here during development: an earlier
// version of this fixture tried to accept an optional model-response override the same way
// fake-app-server-rpc.mjs does, which only works there because that fixture is given *two* real
// config arguments, both landing before the appended trailer.) Nothing in this file's test suite
// needs a configurable model catalog, so there is no second argument to read.
const scenario = process.argv[2] ?? 'success';
const modelResponse = { data: [{ id: 'gpt-5-codex', displayName: 'GPT-5 Codex', isDefault: true }] };

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

let buffered = '';
process.stdin.on('data', (chunk) => {
  buffered += chunk.toString('utf8');
  let newline;
  while ((newline = buffered.indexOf('\n')) !== -1) {
    const line = buffered.slice(0, newline);
    buffered = buffered.slice(newline + 1);
    if (!line) continue;
    handle(JSON.parse(line));
  }
});

function handle(message) {
  if (message.id === undefined) return; // a notification, e.g. initialized

  switch (message.method) {
    case 'initialize':
      send({ id: message.id, result: {} });
      return;
    case 'model/list':
      send({ id: message.id, result: modelResponse });
      return;
    case 'thread/start':
    case 'thread/resume':
      if (scenario === 'hang') return; // never respond
      if (scenario === 'malformed-thread') {
        send({ id: message.id, result: { thread: {} } });
        return;
      }
      // The returned thread id encodes which method was actually called, so a test can assert on
      // it via the terminal event's providerSessionId rather than trusting both methods behave
      // identically (they don't have to, and this distinguishes a wrong-method bug from a
      // no-op-either-way false pass).
      send({ id: message.id, result: { thread: { id: message.method === 'thread/resume' ? 'thread-fixture-1-via-resume' : 'thread-fixture-1-via-start' } } });
      return;
    case 'turn/start':
      if (scenario === 'crash-mid-turn-start') {
        // Deliberately never respond -- this request is genuinely in flight when the process dies.
        process.exit(1);
      }
      send({ id: message.id, result: { turn: { id: 'turn-fixture-1' } } });
      if (scenario === 'success' || scenario === 'failure') {
        send({ method: 'item/started', params: { threadId: 'thread-fixture-1', turnId: 'turn-fixture-1', item: { id: 'item-1', type: 'agentMessage' } } });
        send({
          method: 'item/completed',
          params: { threadId: 'thread-fixture-1', turnId: 'turn-fixture-1', item: { id: 'item-1', type: 'agentMessage', text: 'hello from codex' } },
        });
        send({
          method: 'turn/completed',
          params: { threadId: 'thread-fixture-1', turn: { id: 'turn-fixture-1', status: scenario === 'success' ? 'completed' : 'failed' } },
        });
      } else if (scenario === 'interrupt-unresponsive') {
        // A real, observable AgentEvent (tool.started) proves to the test that turn/start's
        // response landed and the turn is genuinely running, without the test having to guess at
        // subprocess/IPC timing. Deliberately sends nothing else, ever: no turn/interrupt response,
        // no turn/completed -- cancel() must fall all the way through to its own
        // CANCEL_TERMINAL_WAIT_MS timeout to end the session.
        send({ method: 'item/started', params: { threadId: 'thread-fixture-1', turnId: 'turn-fixture-1', item: { id: 'item-1', type: 'commandExecution', command: 'sleep 999' } } });
      }
      // 'interrupt' scenario: send nothing further here -- wait for a real turn/interrupt request.
      return;
    case 'turn/interrupt':
      if (scenario === 'interrupt-unresponsive') return; // never respond, never complete the turn
      send({ id: message.id, result: {} });
      send({ method: 'turn/completed', params: { threadId: 'thread-fixture-1', turn: { id: 'turn-fixture-1', status: 'interrupted' } } });
      return;
    default:
      send({ id: message.id, error: { code: -32601, message: `unexpected method: ${message.method}` } });
  }
}
