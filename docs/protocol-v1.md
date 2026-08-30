# Protocol v1

This is the daemon's public wire contract: the HTTP+SSE API shape and the `AgentEvent` /
`AgentEventEnvelope` event format every provider adapter normalizes into. `@agent-dock/client`
relies on this contract. If you change it, update the version constant and this file together.

`AGENT_DOCK_PROTOCOL_VERSION` (`packages/shared/src/protocol.ts`, currently `1`) is reported at
`GET /health`. `@agent-dock/client` checks it automatically before the first real request (see
[client-sdk.md](client-sdk.md)) and throws `ProtocolMismatchError` on a mismatch. It uses an
exact-match comparison instead of a semver range or negotiation handshake because the
desktop app ships one daemon and one client version together. Bump the constant only when you make
a *breaking* change to the route shapes below or the `AgentEvent` union.

## HTTP + SSE routes

All routes are relative to `http://127.0.0.1:<port>`. Every route except `GET /health` requires
`Authorization: Bearer <token>`. See [SECURITY.md](../SECURITY.md#local-auth-token). Full
request/response detail (status codes, error bodies) lives in [daemon.md](daemon.md#routes); this
section is the protocol-level shape.

| Route | Purpose |
|---|---|
| `GET /health` | `{ status: 'ok', uptimeSeconds, protocolVersion }`. No auth required |
| `GET /providers` | `{ providers: ProviderStatus[] }` |
| `GET /providers/:providerId` | One `ProviderStatus` |
| `POST /sessions` | Body: `CreateSessionRequest`. Creates and starts a session, returns `AgentSession` |
| `GET /sessions/:sessionId` | Current `AgentSession` record |
| `GET /sessions/:sessionId/events` | SSE stream of `AgentEventEnvelope`, replayed from the start (or from `Last-Event-ID`) |
| `POST /sessions/:sessionId/cancel` | Cancels an in-flight session (`404` if it's already terminal) |
| `POST /sessions/cancel-all` | Cancels every in-flight session. Used by the desktop app's shutdown path, not by normal session management |
| `DELETE /sessions/:sessionId` | Cancels (if running) and forgets a session |

## The `AgentEvent` union

Defined once, in `packages/shared/src/events.ts`. Every provider adapter normalizes its CLI's
native output into this union. Nothing above `packages/agent-runtime` (the daemon, the desktop UI,
a downstream client) should ever branch on which provider produced an event.

| Event | Fields | When it occurs | Capability gate |
|---|---|---|---|
| `session.started` | `sessionId`, `provider`, `providerSessionId?` | Always first, before anything else | none |
| `status` | `status`, `detail?` | Adapter-defined lifecycle status text. Claude emits `status: 'initialized'` on `system/init`; Codex emits `status: 'thread_started'` and `status: 'turn_started'`. Treat the value as informational and subject to change, not as a value to switch on | none |
| `assistant.message` | `text` | One complete assistant turn | none |
| `thinking.delta` | `text` | Reasoning/thinking content, only when the CLI itself already puts it in its own public output stream | `capabilities.thinking` |
| `tool.started` | `toolName`, `toolCallId?`, `input?` | A tool/command invocation begins | `capabilities.tools` |
| `tool.completed` | `toolName?`, `toolCallId?`, `result?`, `isError?` | A tool/command invocation finishes | `capabilities.tools` |
| `usage` | `inputTokens?`, `outputTokens?`, `cachedInputTokens?`, `cost?` | Token and cost accounting. The number of events depends on the provider. Codex emits one per completed turn; Claude emits one on every `assistant`/`user` line and again on the final `result` line. A single `usage` event is not necessarily a session total. See [providers.md](providers.md#claude-code-adapter) | `capabilities.usage` |
| `error` | `code?`, `message`, `recoverable` | A problem the session hit. `recoverable: true` means the session may still continue or complete normally (e.g. Codex's non-fatal item-level errors); `recoverable: false` always precedes a `session.failed` | none |
| `session.completed` | `providerSessionId?` | Terminal. The session finished successfully | none |
| `session.failed` | `message` | Terminal. The session ended in error | none |
| `session.cancelled` | *(none)* | Terminal. The session was cancelled before/while running | `capabilities.cancellation` |

`thinking.delta` is only ever emitted for reasoning content the CLI itself already puts in its
public, user-visible output stream (Claude Code's `thinking` content blocks; Codex's `reasoning`
items). Neither adapter attempts to reconstruct or expose anything the CLI treats as private.

Protocol v1 has no token-streaming event variant. An earlier `assistant.delta` placeholder was
removed because no adapter emitted it, no test exercised it, and it lacked the message-boundary id
needed to correlate deltas with the final `assistant.message`. Add a defined variant when an
adapter needs one. See
[providers.md](providers.md#claude-code-adapter) for why Claude Code specifically doesn't pass
`--include-partial-messages` today.

## `AgentEventEnvelope`: what crosses the wire

```ts
type AgentEventEnvelope = AgentEvent & {
  sequence: number; // per-session, zero-based, monotonically increasing; also the SSE `id:` field
  timestamp: string; // ISO 8601, when the daemon observed the event (not when the CLI produced it)
};
```

The daemon (`SessionManager`) adds these fields when it records and broadcasts an event. Provider
adapters do not produce them.

## Ordering guarantees

Upheld by `SessionManager` and enforced structurally by `runProviderSession()` (see
[architecture.md](architecture.md#runtime-flow-what-happens-when-a-user-presses-run) and
[providers.md](providers.md#executable-discovery)):

- Events within one session are emitted in `sequence` order. Every subscriber, whether live or
  replayed via `Last-Event-ID`, sees the same `sequence` and `timestamp` for an event.
- Exactly one of `session.completed` / `session.failed` / `session.cancelled` occurs per session.
- That terminal event is always last. Nothing is ever emitted after it.
- A fresh SSE subscriber (no `Last-Event-ID`) gets the full stored history replayed from `sequence`
  `0`, then live events as they arrive. A subscriber that sends `Last-Event-ID: <n>` resumes from
  `n + 1`. History *retained for replay* is capped at 5,000 events per session
  (`MAX_STORED_EVENTS_PER_SESSION` in `apps/daemon/src/session-manager.ts`). Beyond that, further
  events are no longer replayable to a new subscriber, and the daemon logs a warning, but they are
  still delivered live to every currently-connected subscriber, and `sequence` keeps incrementing
  from an independent counter rather than resetting or skipping at the cap boundary. The cap
  affects replay only, not live delivery or the terminal event. This behavior is tested in
  `apps/daemon/test/session-manager.test.ts`.
- `@agent-dock/client`'s `sessions.events()` iterator ends when the terminal event arrives; it does
  not reconnect automatically. See [client-sdk.md](client-sdk.md#design-decisions) for the
  reconnection behavior.

## Runtime validation

`packages/shared/src/schemas.ts` exports `agentEventEnvelopeSchema` (a Zod discriminated union on
`type`, mirroring the table above field-for-field) and `providerStatusSchema`,
`providerCapabilitiesSchema`, `agentSessionSchema`, `healthResponseSchema`. `@agent-dock/client`
validates every SSE frame and JSON response before returning it to a caller. A daemon contract
violation therefore produces a typed `ValidationError`. If you add an `AgentEvent` variant, add
its schema branch here too. The type and schema must be kept in sync manually.

## Public and internal API

**Public/stable, versioned together under `AGENT_DOCK_PROTOCOL_VERSION`:**

- The `AgentEvent` / `AgentEventEnvelope` union (`packages/shared/src/events.ts`)
- `ProviderStatus`, `AuthStatus`, `ProviderCapabilities`, `AgentSession`
  (`packages/shared/src/provider.ts`, `session.ts`). `ProviderCapabilities`' known keys are
  stable, but the shape is open (optional keys and an index signature) so a future
  capability is additive, not a breaking change; see [providers.md](providers.md#provider-capabilities)
- The Zod schemas in `packages/shared/src/schemas.ts`
- The route shapes above (`/health`, `/providers`, `/sessions`, `/sessions/:id/events`)

**Internal, not part of the protocol or exported from a package entry point:**

- `SessionManager`'s `RuntimeState` and its in-memory event buffer
- The exact `SessionStore` interface method signatures (`apps/daemon/src/session-store.ts`)
- Anything under `providers/*/parser.ts` or `providers/*/build-args.ts`, including the raw,
  provider-native JSONL shape a CLI emits before normalization. A downstream consumer should not
  parse this directly because it can change when Claude Code or Codex changes its output format.

The desktop UI handles `AgentEvent` with a single `switch (event.type)` in
`apps/desktop/src/components/cv/useAgentRun.ts`. It does not branch on which provider produced an
event, and other protocol consumers should follow the same pattern.
