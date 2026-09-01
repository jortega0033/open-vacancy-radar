import type { ProviderId } from './provider.js';

export type SessionStatus = 'starting' | 'running' | 'completed' | 'failed' | 'cancelled';

/**
 * One agent execution. `id` is a daemon-generated UUID and is the only identifier clients should
 * key off of: it is never a process id. `providerSessionId` is whatever session/thread id the
 * underlying CLI reports (if any); pass it back as `resumeProviderSessionId` in a new
 * `POST /sessions` request to continue that thread, for providers whose `capabilities.resume` is
 * true (see docs/providers.md#provider-capabilities).
 *
 * Sessions live behind the daemon's SessionStore (in-memory, see
 * docs/daemon.md#session-lifecycle-sessionmanager-sessionstore). A daemon with the v2 durable store
 * enabled (ADI-05) additionally recovers a session that was still running when it stopped, and
 * presents it here as `status: 'failed'` with an explanatory `error` -- v1's status vocabulary has
 * no `interrupted` member and is frozen, so that is the nearest honest projection. The richer state
 * is available on the v2 read routes; see docs/daemon.md#durable-session-state.
 */
export interface AgentSession {
  id: string;
  provider: ProviderId;
  cwd: string;
  prompt: string;
  /** Provider-native model id/alias this session ran with, when the provider supports selection. */
  model?: string;
  status: SessionStatus;
  providerSessionId?: string;
  error?: string;
  startedAt: string;
  completedAt?: string;
}
