# Client SDK

`@agent-dock/client` (`packages/client`) is the typed client for the daemon. It can be used by
Electron's main process, a Node CLI, or a VS Code extension. It handles HTTP requests and
responses, bearer-token authentication, incremental SSE parsing, and protocol-version checks, so
callers do not need to construct daemon URLs, headers, or event-stream parsers.

It has no Electron or browser dependency and uses Node 18+'s global `fetch`. Its `package.json`
declares an `"exports"` map with only `"."`:

```json
{ "exports": { ".": "./src/index.ts" } }
```

Only the symbols exported from `index.ts` are public. There is no supported
`@agent-dock/client/src/internal/...` import path.

## Public exports

```ts
import { AgentDockClient } from '@agent-dock/client';
import type { AgentDockClientOptions, HealthResponse, SessionEventsOptions } from '@agent-dock/client';
import {
  AgentDockClientError, // base class every error below extends
  DaemonError,          // any other non-2xx response
  DaemonUnavailableError, // fetch itself failed, or the daemon didn't respond
  ProtocolMismatchError,  // GET /health reported a different AGENT_DOCK_PROTOCOL_VERSION
  ProviderUnavailableError, // 404 on a /providers/:id route
  SessionNotFoundError,     // 404 on a /sessions/:id route
  UnauthorizedError,        // 401: bad or missing token
  ValidationError,          // 400, or a response/SSE frame that failed its Zod schema
} from '@agent-dock/client';
```

The seven error classes cover conditions that callers need to distinguish with `instanceof`.

## Usage

```ts
import { AgentDockClient } from '@agent-dock/client';

const client = new AgentDockClient({ baseUrl: 'http://127.0.0.1:PORT', token });

const providers = await client.providers.list();       // ProviderStatus[]
const provider = await client.providers.get('claude');  // ProviderStatus

const session = await client.sessions.create({
  provider: 'claude',
  cwd: '/path/to/project',
  prompt: 'Inspect this repository',
  // resumeProviderSessionId: session.providerSessionId, // to continue a prior thread
});

for await (const event of client.sessions.events(session.id)) {
  console.log(event); // AgentEventEnvelope: normalized event plus sequence and timestamp
}

const current = await client.sessions.get(session.id); // re-fetch the AgentSession record
await client.sessions.cancel(session.id);               // cancel an in-flight session
await client.sessions.delete(session.id);                // cancel (if running) and forget it
await client.sessions.cancelAll();                       // cancel every in-flight session
```

Errors are typed, so a caller can branch on `instanceof` instead of parsing strings:

```ts
try {
  await client.sessions.create({ provider: 'claude', cwd, prompt });
} catch (err) {
  if (err instanceof DaemonUnavailableError) {
    // daemon isn't running / isn't reachable yet
  } else if (err instanceof ProtocolMismatchError) {
    // this client and the running daemon disagree on protocol version
  } else if (err instanceof ValidationError) {
    // request or response didn't match the expected shape
  }
}
```

Full API: `providers.list()`, `providers.get(id)`, `sessions.create(input)`, `sessions.get(id)`,
`sessions.events(id, options?)`, `sessions.cancel(id)`, `sessions.delete(id)`,
`sessions.cancelAll()`, and `health()`. `SessionEventsOptions` accepts an `AbortSignal` (to stop
consuming early) and a `lastEventId` (to resume a stream instead of replaying from the start; see
[protocol-v1.md](protocol-v1.md#ordering-guarantees)). `sessions.cancelAll()` supports the desktop
shutdown path (Electron calls it before force-killing the daemon on Windows, where a
process signal alone cannot reach the daemon's graceful-shutdown handler; see
[daemon.md#shutdown](daemon.md#shutdown)); most callers only ever need `sessions.cancel(id)`.

## Design decisions

The client follows these rules:

- **The compatibility check is lazy, not in the constructor.** `new AgentDockClient(...)` is
  synchronous and does no I/O. The first call to `health()` or any other method runs the
  `GET /health` + protocol-version check once, caches the result for the client's lifetime, and
  retries on the next call if it failed. A failed startup check is not cached.
- **No automatic reconnect.** `sessions.events()` opens exactly one SSE connection and ends when
  the daemon closes it (the session's terminal event) or the caller's `AbortSignal` fires. If the
  connection drops for any other reason, the generator throws and the caller decides whether to
  retry. A new call reconnects because the daemon replays its stored event history to a new
  subscriber or resumes from `lastEventId`. See
  [protocol-v1.md#ordering-guarantees](protocol-v1.md#ordering-guarantees).
- **Errors are typed by transport-level category, not by inspecting message strings.** See the
  seven classes above.
- **The token never appears in a URL.** `sessions.events()` sends it as an `Authorization` header
  like every other call, via `fetch` + a manual `ReadableStream` reader (`src/sse.ts`) rather than
  the browser `EventSource` API, which can't set custom headers at all.
- **Every response is validated against the shared Zod schemas** (`@agent-dock/shared`) before it
  reaches the caller. A daemon-side bug that produces a malformed response surfaces as
  `ValidationError`, not a runtime crash somewhere downstream in application code.

## Where it's used in this repo

Electron's main process (`apps/desktop/electron/main.ts`) creates one `AgentDockClient` after the
daemon's discovery file is readable. It is the only part of the
desktop app that imports `@agent-dock/client`. The renderer only ever reaches it through seven IPC
handlers in `main.ts`, and the preload bridge (`electron/preload.ts`) exposes those seven functions
and no generic request method. See
[SECURITY.md](../SECURITY.md#renderer-never-talks-to-the-daemon-directly) for this boundary,
and [electron.md](electron.md) for how the main process wires this client to IPC.

## Using it from a workspace/fork, not from outside the repo

`@agent-dock/client` does not depend on Electron. A Node script, CLI, or editor extension can use it
like `main.ts` does. The package is not a
published npm package: it's `private: true`, and its `main`/`types` point at raw TypeScript source
(`./src/index.ts`), not a built `dist/`. This works today only because everything that imports it
is in the same pnpm workspace or in a copy of this repository. An external
project outside this repo's workspace **cannot** `npm install @agent-dock/client` and get something
resolvable. See [architecture.md#project-identity](architecture.md#project-identity) for the
publication decision.

To build a new client, such as a CLI or editor extension, add it as another package in this
workspace and import the client:

```ts
import { AgentDockClient } from '@agent-dock/client';

const client = new AgentDockClient({ baseUrl: 'http://127.0.0.1:5173', token: '...' });
const health = await client.health(); // throws ProtocolMismatchError / DaemonUnavailableError early
```

See [architecture.md#why-a-separate-daemon-instead-of-running-the-cli-logic-in-electrons-main-process](architecture.md#why-a-separate-daemon-instead-of-running-the-cli-logic-in-electrons-main-process)
for why a non-Electron client does not require changes to the daemon or provider adapters.
