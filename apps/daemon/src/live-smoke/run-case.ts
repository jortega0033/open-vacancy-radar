import type { AgentSession, CreateSessionRequest, ProviderId } from '@agent-dock/shared';
import { consumeSmokeStream } from './stream.js';
import type { LiveSmokeResultCode } from './types.js';

/** The narrow slice of `AgentDockClient`'s v1 `sessions` namespace this harness actually uses --
 * real callers pass `client.sessions` (from `@agent-dock/client`) directly; tests inject a fake
 * satisfying this shape. No `workspaces`/capability-negotiation surface, unlike upstream's v2-based
 * harness: this repo's v1 `POST /sessions` route checks neither (see `routes/sessions.ts`). */
export interface LiveSmokeClient {
  create(input: CreateSessionRequest): Promise<AgentSession>;
  get(id: string): Promise<AgentSession>;
  events(id: string): AsyncIterable<unknown>;
  cancel(id: string): Promise<void>;
}

export interface LiveSmokeCaseInput {
  provider: ProviderId;
  cwd: string;
  prompt: string;
  timeoutMs: number;
  /** Set only for the follow-up continuation case (ADI-19), never the fresh one. */
  resumeProviderSessionId?: string;
}

export interface LiveSmokeCaseOutcome {
  resultCode: LiveSmokeResultCode;
  reason?: string;
}

/**
 * Drives exactly one real Protocol v1 session to a terminal completion: normalized content,
 * exactly one terminal event, no per-event delivery guarantee to negotiate (v1 has none to ask
 * for, unlike upstream's v2 capability request). Resume is a separate, explicit follow-up case
 * (see `resumeProviderSessionId`), run only when the fresh session actually reported a
 * `providerSessionId` and the provider's own `detect()` capabilities claim resume support -- see
 * `cli.ts`'s own gating on that, never assumed here.
 */
export async function runFreshRunCase(client: LiveSmokeClient, input: LiveSmokeCaseInput): Promise<LiveSmokeCaseOutcome & { session?: AgentSession }> {
  const session = await client.create({
    provider: input.provider,
    cwd: input.cwd,
    prompt: input.prompt,
    ...(input.resumeProviderSessionId ? { resumeProviderSessionId: input.resumeProviderSessionId } : {}),
  });
  const outcome = await consumeSmokeStream(client.events(session.id), { timeoutMs: input.timeoutMs });
  if (outcome.outcome === 'timeout') {
    return { resultCode: 'failed_timeout', session };
  }
  if (outcome.outcome === 'protocol_violation') {
    return { resultCode: 'failed_protocol_violation', reason: outcome.reason, session };
  }
  if (!outcome.hasContent) {
    return { resultCode: 'failed_protocol_violation', reason: 'session reached a terminal event with no normalized content', session };
  }
  // `session` above is the object `create()` returned, captured before the provider process even
  // started -- `providerSessionId` is only populated later, asynchronously, once the daemon's own
  // SessionStore observes this session's `session.completed` event. By this point that event has
  // already been consumed (the stream just reported a successful terminal outcome), so re-fetching
  // now is what actually picks up a populated `providerSessionId` for the resume case to use;
  // returning the stale `create()` object here would leave that field permanently undefined.
  const completed = await client.get(session.id);
  return { resultCode: 'success', session: completed };
}

/** Only runs when `providerImpl.detect()`'s capabilities report `cancellation: true` -- this
 * harness never assumes a capability it didn't see the daemon's own provider adapter actually
 * report (see `cli.ts`'s gating). */
export async function runCancellationCase(client: LiveSmokeClient, freshSession: AgentSession, timeoutMs: number): Promise<LiveSmokeCaseOutcome> {
  const events = client.events(freshSession.id);
  const cancelSoon = client.cancel(freshSession.id).catch(() => {});
  const outcome = await consumeSmokeStream(events, { timeoutMs });
  await cancelSoon;
  if (outcome.outcome !== 'success') {
    return { resultCode: outcome.outcome === 'timeout' ? 'failed_timeout' : 'failed_protocol_violation', reason: outcome.outcome === 'protocol_violation' ? outcome.reason : undefined };
  }
  if (outcome.terminalType !== 'session.cancelled') {
    return { resultCode: 'failed_protocol_violation', reason: `expected session.cancelled after cancel, got ${outcome.terminalType}` };
  }
  return { resultCode: 'success' };
}
