import type { StartSessionDenialReason } from './workspace-grant.js';

/**
 * The AI Workspace's renderer-facing vocabulary (ADI-07), in a module that imports nothing from
 * Electron and nothing from Node.
 *
 * It exists for the same reason `workspace/types.ts` does: `src/window.d.ts` and the renderer
 * components need to name these shapes, and neither may reference `preload.ts` (which imports
 * `electron`) or `main.ts` (which starts a daemon on load). Everything here is a type; the module
 * emits no runtime code except the two frozen constant arrays at the bottom, which the renderer's
 * copy tables and the sanitizer's tests both read so there is one inventory rather than three.
 *
 * ## What is deliberately absent from every shape below
 *
 * - **no `cwd`, and no path-shaped field of any kind.** A v2 session's working directory has
 *   exactly one legitimate source in this system: the canonical path behind a `workspaceGrant`
 *   ref, resolved in the main process. The renderer never learns it, so these types have nowhere
 *   to put it.
 * - **no `providerSessionId`.** That is the provider CLI's own native thread identifier.
 * - **no native `toolCallId`.** A tool call is correlated by a locally-minted alias (`t1`, `t2`)
 *   instead, so a start/end pair is still pairable in the UI without the native id crossing.
 * - **no `scope.executablePath`.** A filesystem path by another name.
 */

/** A content-free description of some content: how much of it there was, and what it was. */
export interface ActivityDigest {
  bytes: number;
  sha256: string;
}

/**
 * One entry in a session's timeline, already sanitized.
 *
 * `origin` is load-bearing for the merge in `src/components/agent-workspace/timeline.ts`: the same
 * `seq` can arrive twice, once live (carrying real prose) and once from the durable history page
 * (carrying only a digest of that same prose, because the daemon's store is content-free by
 * design). When they collide, live wins -- replacing a live entry with its history counterpart
 * would make refreshing a session *lose* information.
 */
export type ActivityEntry = {
  /** The daemon's per-session, zero-based `sequence`. The timeline is kept sorted on this. */
  seq: number;
  /** When the daemon observed the event. A bounded string, never parsed here. */
  at: string;
  origin: 'live' | 'history';
} & ActivityBody;

/**
 * The per-variant payload. One member per `AgentEvent` variant, plus `session.interrupted`, which
 * has no live counterpart at all: it is synthesized by the daemon's crash-recovery pass and exists
 * only in the durable log (see `apps/daemon/src/persisted-session-schema.ts`).
 */
export type ActivityBody =
  | { kind: 'session.started'; provider: string }
  | { kind: 'status'; status: string }
  | ({ kind: 'assistant.message' } & ActivityText)
  | ({ kind: 'thinking.delta' } & ActivityText)
  | { kind: 'tool.started'; toolName: string; toolAlias?: string; input?: ActivityDigest }
  | {
      kind: 'tool.completed';
      toolName?: string;
      toolAlias?: string;
      isError?: boolean;
      result?: ActivityDigest;
    }
  | {
      kind: 'usage';
      inputTokens?: number;
      outputTokens?: number;
      cachedInputTokens?: number;
      cost?: number;
    }
  | { kind: 'error'; code?: string; recoverable: boolean }
  | { kind: 'session.completed' }
  | { kind: 'session.failed' }
  | { kind: 'session.cancelled' }
  | { kind: 'session.interrupted' };

/**
 * The one place real model prose survives sanitization, and the three ways it can be missing.
 *
 * - `text` present: a live entry, within budget. This is what the user actually reads.
 * - `textTruncated`: the entry itself exceeded `MAX_TEXT_BYTES_PER_ENTRY`; `text` is the capped
 *   prefix, not the whole message, and the UI must say so.
 * - `digest` present with no `text`: a history entry. The daemon never stored the prose, so this
 *   is genuinely all there is, and the UI says that rather than rendering a blank message.
 * - `textOmitted`: the *session* exceeded `MAX_TIMELINE_TEXT_BYTES_PER_SESSION`, so the renderer's
 *   timeline dropped this entry's text after the fact. Set by the renderer, never by the sanitizer.
 */
export interface ActivityText {
  text?: string;
  textTruncated?: boolean;
  digest?: ActivityDigest;
  textOmitted?: boolean;
}

/** A history page's entries are ordinary activity entries that happen to carry `origin: 'history'`. */
export type HistoryEntry = ActivityEntry & { origin: 'history' };

/** The read-view projection of `FrozenLaunchScope`, minus `executablePath`. */
export interface SessionScopeSummary {
  providerVersion?: string;
  authenticated: string;
  platform: string;
  accountEvidence: 'cli_owned';
}

/**
 * One v2 session as the renderer sees it: a field-by-field rebuild of `AgentSessionV2View` with
 * `cwd`, `providerSessionId`, and `scope.executablePath` **absent as keys**, not merely undefined.
 */
export interface SessionSummary {
  id: string;
  provider: string;
  protocolVersion: number;
  transportId: string;
  model?: string;
  status: string;
  terminalReason?: string;
  acceptedWork: string;
  rootSessionId: string;
  parentSessionId?: string;
  continuationKind: string;
  startedAt: string;
  completedAt?: string;
  earliestSequence: number;
  eventCount: number;
  eventsTruncated: boolean;
  scope: SessionScopeSummary;
  /**
   * A count, not the frames. `NormalizedUnknownFrame` is already content-free, but it carries a
   * per-frame hash and byte count that nothing in this UI acts on, and the conservative rule for
   * this boundary is that a field with no reader does not cross it.
   */
  unknownFrameCount: number;
}

/** How much of the daemon's active-session budget is spoken for. Mirrors `ActiveSessionCapacityView`. */
export interface SessionCapacity {
  global: { active: number; limit: number };
  provider: { active: number; limit: number };
}

export interface SessionListPage {
  sessions: SessionSummary[];
  nextCursor?: string;
  capacity: SessionCapacity;
}

export interface SessionEventsPage {
  sessionId: string;
  events: HistoryEntry[];
  nextCursor?: string;
}

/** Why a live attach was refused. Reason-only, from a closed set. */
export type AttachRefusal = 'attach_limit' | 'daemon_unavailable' | 'invalid_session_id';

export type AttachResult = { ok: true } | { ok: false; reason: AttachRefusal };

/**
 * What arrives on the `agent-workspace:activity` push channel.
 *
 * `closed` is not decoration: a session that the durable store knows about but whose live SSE
 * stream no longer exists (the common case after an app restart) produces **no terminal event at
 * all**, because the v1 `SessionManager` that would have emitted one is gone with the previous
 * daemon process. Without an explicit close the renderer would sit in `attaching` forever and then
 * have to guess whether that is an error. It is not an error, and this says so.
 */
export type ActivityPush =
  | { sessionId: string; entry: ActivityEntry }
  | { sessionId: string; closed: { reason: ActivityCloseReason } };

export type ActivityCloseReason = 'stream_ended' | 'stream_unavailable';

/** Paging arguments shared by the list and events reads. Both are bounded in main. */
export interface PageRequest {
  cursor?: string;
  limit?: number;
}

/**
 * The `window.agentWorkspace` capability list: exactly six functions, no `invoke`, no `channel`,
 * and no argument anywhere that could name a location.
 */
export interface AgentWorkspaceBridge {
  listSessions(page?: PageRequest): Promise<SessionListPage>;
  getSession(sessionId: string): Promise<SessionSummary | null>;
  getSessionEvents(sessionId: string, page?: PageRequest): Promise<SessionEventsPage>;
  /** Starts a live, sanitized relay of one session's SSE stream. Idempotent per session id. */
  attachActivity(sessionId: string, lastSeq?: number): Promise<AttachResult>;
  detachActivity(sessionId: string): Promise<void>;
  onActivity(callback: (push: ActivityPush) => void): () => void;
}

export type { StartSessionDenialReason };

/**
 * Every reason a session start can be refused, as a runtime array.
 *
 * The type union in `workspace-grant.ts` is the source of truth; this is the runtime shadow of it,
 * pinned to that union by the `satisfies` below so a member added there without being added here
 * is a compile error. `refusal-copy.ts` maps each of these to a sentence, and its test walks this
 * array, so "every refusal has copy" is checked against the real inventory rather than a list the
 * test wrote for itself.
 */
export const START_SESSION_DENIAL_REASONS = [
  'timeout',
  'navigation',
  'webcontents_destroyed',
  'daemon_generation',
  'trust_revoked',
  'wrong_webcontents',
  'unknown_handle',
  'already_consumed',
  'identity_drift',
  'not_trusted',
  'audit_failure',
  'unknown_workspace_ref',
  'daemon_unavailable',
  'workspace_lease_conflict',
  'unc_workspace_unsupported',
  'invalid_workspace_path',
  'unknown_resume_target',
  'resume_not_allowed',
  'active_session_limit',
  'storage_full',
  'invalid_request',
  'refused',
] as const satisfies readonly StartSessionDenialReason[];

/** Compile-time exhaustiveness in the other direction: a new reason must appear in the array. */
type MissingDenialReason = Exclude<StartSessionDenialReason, (typeof START_SESSION_DENIAL_REASONS)[number]>;
const _allDenialReasonsListed: MissingDenialReason extends never ? true : MissingDenialReason = true;
void _allDenialReasonsListed;
