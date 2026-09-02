import { randomUUID } from 'node:crypto';
import type { AgentEvent, AgentEventEnvelope, AgentSession, ProviderId, TerminalReasonV2 } from '@agent-dock/shared';
import type { Logger, ProviderRegistry, ProviderSessionHandle, SessionLaunchProbe } from '@agent-dock/agent-runtime';
import { AcceptedWorkLatch, UnknownFrameLedger } from '@agent-dock/agent-runtime';
import { MemorySessionStore, type SessionStore } from './session-store.js';
import { ActiveSessionLimiter } from './active-session-limiter.js';
import { toV1Session, type PersistedSessionRecordV1 } from './persisted-session-schema.js';
import type { SessionLineageStore } from './session-lineage-store.js';
import type { WorkspaceTrustStore } from './workspace-trust-store.js';
import { revalidateWorkspaceIdentity } from './workspace-identity.js';

/**
 * Live, non-persistable state for one session: its process handle and buffered event history.
 * Deliberately kept out of SessionStore: see session-store.ts for why. Events are stored as the
 * protocol's public `AgentEventEnvelope` (event + sequence + timestamp), stamped once here so
 * every subscriber (live or replayed) sees the same sequence/timestamp for the same event.
 */
interface RuntimeState {
  handle: ProviderSessionHandle;
  events: AgentEventEnvelope[];
  listeners: Set<(index: number, event: AgentEventEnvelope) => void>;
  /**
   * Per-session monotonic counter for `AgentEventEnvelope.sequence`. Deliberately independent of
   * `events.length`: once the history cap is reached, `events` stops growing but this keeps
   * incrementing, so sequence numbers stay monotonic and live delivery never depends on how much
   * of the buffer is retained (AD-01: see the cap-guard note in `consume()` below).
   */
  nextSequence: number;
  /**
   * Resolves once `consume()` has drained this session's terminal event, i.e. the underlying
   * provider process has actually exited, not merely been asked to. `cancelAll()` awaits these
   * (with a bound) so daemon shutdown doesn't return before child processes are confirmed gone
   * (AD-12).
   */
  done: Promise<void>;
  /**
   * The bounded, content-free tally of provider output this repo could not interpret, fed by the
   * launch probe's `onUnknownFrame` seam. Present only when a durable store is active, because it
   * exists to be written into that session's final record and nothing else reads it.
   */
  unknownFrames?: UnknownFrameLedger;
}

const MAX_STORED_EVENTS_PER_SESSION = 5_000;

/**
 * Bounds how many terminal (completed/failed/cancelled) sessions' runtime state (event history
 * and listener set) stays retained for late-subscriber replay. Without this, a long-lived
 * daemon whose client never calls DELETE accumulates one RuntimeState per session for its entire
 * lifetime, unbounded (AD-11). Eviction is FIFO by completion order: the daemon is single-user
 * and local, so a simple bound is enough. This is not trying to be a cache-replacement policy.
 */
const MAX_RETAINED_COMPLETED_SESSIONS = 50;

/** How a v1 terminal event maps onto the durable store's v2 terminal vocabulary. */
const DURABLE_TERMINAL: Readonly<
  Record<string, { status: 'completed' | 'failed' | 'cancelled'; reason: TerminalReasonV2 }>
> = Object.freeze({
  'session.completed': { status: 'completed', reason: 'provider_completed' },
  'session.failed': { status: 'failed', reason: 'provider_error' },
  'session.cancelled': { status: 'cancelled', reason: 'cancelled_by_client' },
});

/**
 * Sorts recovered records into the order they *would* have entered `completedOrder` had the daemon
 * never stopped. `completedAt` is what the FIFO tracks, so a record missing one (a shape a strict
 * schema does not admit, but a defensive fallback costs nothing) falls back to its start time, and
 * an unparseable timestamp sorts oldest -- i.e. is evicted first, which is the safe direction for a
 * record we cannot place.
 */
function completionOrderKey(session: PersistedSessionRecordV1['session']): number {
  const stamp = Date.parse(session.completedAt ?? session.startedAt);
  return Number.isFinite(stamp) ? stamp : 0;
}

/**
 * Orchestrates session lifecycle: creates sessions via the provider registry, consumes their
 * normalized event stream, and keeps `AgentSession` records up to date in a `SessionStore` (see
 * session-store.ts, `MemorySessionStore` by default).
 *
 * ADI-05 adds two collaborators, both optional so every existing call site and test keeps working
 * unchanged:
 *
 * - an `ActiveSessionLimiter`, which admits or refuses a session **before** anything irreversible
 *   happens (see `create()`);
 * - an optional `SessionLineageStore`, the crash-safe on-disk record. When it is absent the daemon
 *   behaves exactly as it did before this ticket: memory-only, v1-only.
 */
/**
 * Thrown by `create()` for a workspace whose trust has been revoked. A distinct error type (not a
 * bare `Error`) so a route can answer 403 rather than flattening it into the generic 500 that an
 * unrecognized throw becomes.
 */
export class RevokedWorkspaceError extends Error {
  readonly code = 'workspace_revoked';

  constructor(readonly workspaceId: string) {
    super('this workspace is no longer trusted, so a new session cannot start in it');
    this.name = 'RevokedWorkspaceError';
  }
}

/**
 * The workspace-trust collaborators ADI-06 adds, as one optional bag rather than more positional
 * constructor parameters. Absent for every v1 call site and every existing test, which is why none
 * of them changed.
 */
export interface SessionManagerWorkspaceOptions {
  trustStore: WorkspaceTrustStore;
  /** Injection seam for the identity re-check. Defaults to the real `revalidateWorkspaceIdentity`. */
  revalidate?: (
    canonicalPath: string,
    expected: { workspaceId: string; incarnation: string },
  ) => Promise<boolean>;
}

/** Everything `workspaceIsTrusted` needs. See that method for why the path must come from the caller. */
export interface WorkspaceTrustCheck {
  workspaceId: string;
  incarnation: string;
  /** The caller's own canonical path. The trust store deliberately stores no paths. */
  canonicalPath: string;
  /** The epoch read *before* the caller started making its decision. See `workspaceEpoch`. */
  expectedEpoch: number;
}

export class SessionManager {
  private readonly runtime = new Map<string, RuntimeState>();
  /** FIFO of session ids in the order they reached a terminal state: see `MAX_RETAINED_COMPLETED_SESSIONS`. */
  private readonly completedOrder: string[] = [];

  /**
   * Workspaces that must not admit another session. Written **synchronously** by `blockWorkspace`,
   * before any persistence is even scheduled: that ordering is what makes revocation win every race,
   * because a concurrent admission decision reads this set with no await in between.
   */
  private readonly blockedWorkspaces = new Set<string>();
  /**
   * Per-workspace revocation counter. Bumped on every block and every allow, so any decision that
   * spans an `await` can prove nothing changed underneath it by comparing the epoch it started with.
   * A counter rather than a boolean because block-then-allow-then-block must not look like "no
   * change" to a decision that straddled all three.
   */
  private readonly workspaceRevocationEpochs = new Map<string, number>();
  /** workspaceId -> live session ids. The index that makes "cancel everything here" implementable. */
  private readonly sessionsByWorkspace = new Map<string, Set<string>>();
  /** sessionId -> workspaceId, so terminal cleanup can find the index entry to remove. */
  private readonly workspaceBySession = new Map<string, string>();

  private readonly workspaceTrust?: WorkspaceTrustStore;
  private readonly revalidateIdentity: (
    canonicalPath: string,
    expected: { workspaceId: string; incarnation: string },
  ) => Promise<boolean>;

  constructor(
    private readonly registry: ProviderRegistry,
    private readonly logger: Logger,
    private readonly store: SessionStore = new MemorySessionStore(),
    private readonly limiter: ActiveSessionLimiter = new ActiveSessionLimiter(),
    private readonly durable?: SessionLineageStore,
    workspace?: SessionManagerWorkspaceOptions,
  ) {
    this.workspaceTrust = workspace?.trustStore;
    this.revalidateIdentity =
      workspace?.revalidate ?? ((path, expected) => revalidateWorkspaceIdentity(path, expected));
    // Sessions recovered from disk are presented to v1 clients as `failed` with an explanatory
    // error string (see `toV1Session`), so a client that was mid-session when the daemon restarted
    // gets a definite answer from `GET /sessions/:id` instead of a 404 that looks like the session
    // never existed. Every recovered record is already terminal, so none of them holds a limiter
    // reservation and the full active-session budget is available immediately.
    if (this.durable) {
      const recovered = this.durable.allRecords();
      for (const record of recovered) this.store.create(toV1Session(record));

      // Recovered sessions join the same FIFO a live session joins when it completes, in the same
      // order (oldest completion first), and are then trimmed by the same eviction pass. Without
      // this, `MAX_RETAINED_COMPLETED_SESSIONS` would bound only sessions this process watched
      // finish: a durable store holding its full 500-record budget would seed all 500 into memory
      // and keep every one of them for the daemon's whole lifetime, which is precisely the
      // unbounded growth AD-11 exists to prevent -- just reached through a restart instead.
      // Durable retention is separate and deliberately more permissive (see docs/privacy.md), so
      // trimming here evicts nothing from disk.
      const oldestCompletedFirst = [...recovered].sort(
        (a, b) => completionOrderKey(a.session) - completionOrderKey(b.session),
      );
      for (const record of oldestCompletedFirst) this.completedOrder.push(record.session.id);
      this.evictOldestCompletedIfOverCap();
    }
  }

  /** The admission gate this manager reserves against. Exposed for the v2 capacity read view. */
  get activeSessionLimiter(): ActiveSessionLimiter {
    return this.limiter;
  }

  /**
   * Creates a session, or throws.
   *
   * **This method contains no `await`, deliberately.** Everything from the limiter reservation to
   * handing the provider its start options runs in one uninterrupted turn of the event loop, which
   * is what makes the reservation un-raceable: no second request can observe the counters between
   * the check and the increment. Adding an `await` anywhere above `startSession` -- including one
   * hidden inside a helper -- reintroduces exactly the over-admission bug the limiter exists to
   * prevent. `apps/daemon/test/server.limits.test.ts` fires genuinely concurrent requests through a
   * provider parked on a deferred to keep this honest.
   *
   * Order matters and is fixed:
   *
   * 1. resolve the provider (unchanged v1 behavior: an unknown provider is a caller error);
   * 2. mint the session id;
   * 3. **reserve** -- this throws `ActiveSessionLimitError` before any record is written and before
   *    any process is spawned, so a refused request leaves no trace at all;
   * 4. write the durable record, then start the provider. A throw from either releases the
   *    reservation and, if the record made it to disk, finalizes it as `launch_failed`.
   */
  create(
    provider: ProviderId,
    cwd: string,
    prompt: string,
    resumeProviderSessionId?: string,
    model?: string,
    protocolVersion: 1 | 2 = 1,
    workspaceId?: string,
  ): AgentSession {
    const providerImpl = this.registry.get(provider);
    if (!providerImpl) {
      throw new Error(`no provider registered for id: ${provider}`);
    }

    // ADI-06, and it is a synchronous read of a synchronously-written set, on purpose: a revoked
    // workspace must be refused with no window in which a concurrent request could slip past. v1
    // callers pass no `workspaceId` and are unaffected; ADI-13's v2 create path is what supplies one.
    if (workspaceId !== undefined && this.blockedWorkspaces.has(workspaceId)) {
      throw new RevokedWorkspaceError(workspaceId);
    }

    const id = randomUUID();
    const session: AgentSession = {
      id,
      provider,
      cwd,
      prompt,
      model,
      status: 'starting',
      startedAt: new Date().toISOString(),
    };

    // The atomic reservation point. Nothing before this can fail in a way that leaks a hold, and
    // nothing after it can proceed without one.
    this.limiter.reserve(provider, id);

    // Only when a durable store is active: the ledger exists to be written into that session's
    // final record, so without one it would accumulate entries nothing ever reads.
    const unknownFrames = this.durable ? new UnknownFrameLedger() : undefined;

    let recorded = false;
    let handle: ProviderSessionHandle;
    try {
      if (this.durable) {
        this.durable.create(session, {
          protocolVersion,
          // The honest synchronous scope. `provider.detect()` cannot be awaited here (see this
          // method's docstring), so the fields it would supply are refined below, off the critical
          // path, and default to the fail-closed 'unknown' until then.
          scope: { authenticated: 'unknown', platform: process.platform, accountEvidence: 'cli_owned' },
          ...(resumeProviderSessionId === undefined ? {} : { resumeProviderSessionId }),
        });
        recorded = true;
      }

      this.store.create(session);
      handle = providerImpl.startSession({
        sessionId: id,
        cwd,
        prompt,
        resumeProviderSessionId,
        model,
        ...(unknownFrames ? { launchProbe: this.buildLaunchProbe(id, unknownFrames) } : {}),
      });
    } catch (err) {
      this.limiter.release(id);
      // The record, if it exists, describes a session that never got a provider process. Closing it
      // out as `launch_failed` (and never touching `acceptedWork`, which stays at the fail-closed
      // 'unknown' it was created with) is what stops it being recovered as `interrupted` on the next
      // startup, which would imply a process had been running.
      if (recorded) this.durable?.finalize(id, 'failed', 'launch_failed');
      this.store.delete(id);
      throw err;
    }

    const runtimeEntry: RuntimeState = {
      handle,
      events: [],
      listeners: new Set(),
      nextSequence: 0,
      done: Promise.resolve(),
      ...(unknownFrames ? { unknownFrames } : {}),
    };
    this.runtime.set(id, runtimeEntry);
    // Indexed only once the session is genuinely live, so a launch that threw above leaves no entry
    // for `revokeWorkspace` to try to cancel.
    if (workspaceId !== undefined) this.indexWorkspaceSession(workspaceId, id);
    // `.catch` rather than a bare assignment: a provider generator that throws instead of ending
    // with a terminal event would otherwise make `done` a rejected promise nobody awaits until
    // `cancelAll()` does -- surfacing first as an unhandled rejection, and then as a rejection out
    // of the daemon's own shutdown handler, skipping the MCP/server/discovery-file cleanup that
    // follows it. The reservation and the retention bookkeeping are already released by `consume`'s
    // `finally`, so there is nothing left to do here but record why the stream ended badly.
    runtimeEntry.done = this.consume(id, handle).catch((error: unknown) => {
      this.logger.error('session event stream ended with an error', { sessionId: id, error });
    });

    // Deliberately after the session is fully live: this is a refinement of an already-written
    // record, never a precondition for starting one. It is also the only `detect()` call this path
    // makes, and only when a durable store is active, so v1-only operation spawns no extra probes.
    if (this.durable) this.refineLaunchScope(id, provider);

    this.logger.info('session created', { sessionId: id, provider, resumed: !!resumeProviderSessionId });
    return session;
  }

  /**
   * The accepted-work observation seam (ADI-04's `SessionLaunchProbe`), wired to the durable store.
   *
   * The first two callbacks encode the same boundary the supervisor does, for the same reason: a CLI
   * that receives its prompt in argv (`viaStdin: false`) has been handed the work atomically by
   * process creation, while a CLI that reads stdin has provably received nothing until the write
   * happens. Both end at `'accepted'`; only the moment differs. See
   * docs/adr-agentdock-v2-provenance.md#the-three-way-scope-split.
   *
   * `onUnknownFrame` fills the ledger whose entries become the record's `unknownFrames`. It is
   * recorded here rather than digested at write time because the ledger is what applies the bounds
   * *and* the content rule: it keeps a sha256 and a byte length per distinct kind, never the line
   * (see `UnknownFrameLedger`), which is why a field fed straight from provider stdout is safe to
   * persist at all.
   */
  private buildLaunchProbe(id: string, unknownFrames: UnknownFrameLedger): SessionLaunchProbe {
    const latch = new AcceptedWorkLatch();
    void latch.accepted.then(() => {
      this.durable?.markAcceptedWork(id, 'accepted');
    });
    return {
      onSpawnAttempt: (evidence) => {
        if (!evidence.viaStdin) latch.observe('accepted');
      },
      onPromptDelivered: () => {
        latch.observe('accepted');
      },
      onUnknownFrame: (kind, rawLine, eventType, boundsViolation) => {
        unknownFrames.record(kind, rawLine, eventType, boundsViolation);
      },
    };
  }

  private refineLaunchScope(id: string, provider: ProviderId): void {
    const providerImpl = this.registry.get(provider);
    if (!providerImpl) return;
    void providerImpl
      .detect()
      .then((status) => {
        this.durable?.setScope(id, {
          ...(status.executablePath === undefined ? {} : { executablePath: status.executablePath }),
          ...(status.version === undefined ? {} : { providerVersion: status.version }),
          authenticated: status.authenticated,
          platform: process.platform,
          accountEvidence: 'cli_owned',
        });
      })
      .catch((error: unknown) => {
        this.logger.warn('could not refine a session launch scope', { sessionId: id, error });
      });
  }

  private async consume(id: string, handle: ProviderSessionHandle): Promise<void> {
    const runtime = this.runtime.get(id);
    if (!runtime) {
      // No runtime state means create() never registered this id, so no reservation exists to
      // release either. Releasing anyway would be harmless (release is idempotent) but misleading.
      return;
    }

    this.mutateSession(id, (session) => {
      session.status = 'running';
    });

    try {
      for await (const event of handle.events) {
        this.mutateSession(id, (session) => this.applyStatusTransition(session, event));

        // AD-01 fix: listeners are notified unconditionally, every time: the cap below only
        // controls how much history is *retained for replay*. Before this fix, listener
        // notification lived inside the same `if` as the buffer push, so once history filled up,
        // live subscribers silently stopped receiving anything at all, including the terminal
        // event. Every SSE stream past that point hung forever. `sequence` comes from a counter
        // that keeps incrementing past the cap, never from `events.length`, so it stays monotonic
        // and consistent between what a live subscriber sees and what a replay subscriber sees for
        // the events that are still buffered.
        const sequence = runtime.nextSequence++;
        const envelope: AgentEventEnvelope = { ...event, sequence, timestamp: new Date().toISOString() };
        if (runtime.events.length < MAX_STORED_EVENTS_PER_SESSION) {
          runtime.events.push(envelope);
        } else {
          this.logger.warn('session event history full; further events will not be replayable', { sessionId: id });
        }
        this.persistEvent(id, envelope);
        for (const listener of runtime.listeners) listener(sequence, envelope);
      }
    } finally {
      // The SINGLE release site, and it is a `finally` on purpose. Every way a session can stop
      // being active passes through here: the terminal event closing the channel (completed,
      // failed, cancelled), the generator throwing, and a consumer abandoning the stream. A release
      // placed on the completion path alone would leak a reservation on the other two, and a leaked
      // reservation never expires -- it permanently shrinks the daemon's capacity until restart.
      this.limiter.release(id);

      // Same reasoning as the release above, and the same `finally`: a terminal session is no
      // longer running in its workspace, so leaving it in the index would make `revokeWorkspace`
      // try to cancel finished sessions forever and would keep the index growing without bound.
      this.unindexWorkspaceSession(id);

      // The loop only exits after the provider's terminal event closed its channel (exactly one,
      // always last: see run-session.ts), so reaching here means the session is now terminal.
      // Track it for bounded retention (AD-11) rather than keeping every RuntimeState forever.
      this.completedOrder.push(id);
      this.evictOldestCompletedIfOverCap();
    }
  }

  /**
   * Appends the redacted form of one event, and mirrors its terminal state, to the durable store.
   *
   * Failures are logged and swallowed, deliberately. Persistence is an observer of the session, not
   * a participant in it: a full disk, a revoked permission, or a state directory deleted underneath
   * a running daemon must degrade the *history* and nothing else. Letting the write throw here would
   * escape `consume()`'s `for await` as an unhandled rejection and tear down a live provider
   * session -- trading a lost record for a lost session, which is strictly the worse outcome, and
   * for the user the more surprising one.
   */
  private persistEvent(id: string, envelope: AgentEventEnvelope): void {
    if (!this.durable) return;
    try {
      this.durable.appendEvent(id, envelope);

      if (
        (envelope.type === 'session.started' || envelope.type === 'session.completed') &&
        envelope.providerSessionId
      ) {
        this.durable.setProviderSessionId(id, envelope.providerSessionId);
      }
      const terminal = DURABLE_TERMINAL[envelope.type];
      if (terminal) {
        // Immediately before finalization, and only if there is something to say. A provider emits
        // exactly one terminal event, always last (see run-session.ts), so no further frame can
        // arrive after this point and the record ends up describing the whole run. The empty case
        // -- overwhelmingly the common one -- is skipped rather than written as `[]`, which the
        // record already says, so an ordinary session costs no extra record replace or fsync.
        const frames = this.runtime.get(id)?.unknownFrames?.entries() ?? [];
        if (frames.length > 0) this.durable.setUnknownFrames(id, frames);
        this.durable.finalize(id, terminal.status, terminal.reason);
      }
    } catch (error: unknown) {
      this.logger.warn('could not persist a session event; the session itself is unaffected', {
        sessionId: id,
        type: envelope.type,
        error,
      });
    }
  }

  // -------------------------------------------------------------------------------------------
  // ADI-06: workspace admission, revocation, and the epoch-bracketed trust check
  // -------------------------------------------------------------------------------------------

  /** The current revocation epoch for a workspace. Read this *before* starting any decision. */
  workspaceEpoch(workspaceId: string): number {
    return this.workspaceRevocationEpochs.get(workspaceId) ?? 0;
  }

  /** True when this workspace is currently refused outright, with no filesystem or store lookup. */
  isWorkspaceBlocked(workspaceId: string): boolean {
    return this.blockedWorkspaces.has(workspaceId);
  }

  /**
   * Lifts a block. Synchronous, and it bumps the epoch like a block does: a decision that started
   * while the workspace was blocked must not silently become valid because it was unblocked
   * mid-flight, any more than the reverse.
   */
  allowWorkspace(workspaceId: string): void {
    this.blockedWorkspaces.delete(workspaceId);
    this.bumpWorkspaceEpoch(workspaceId);
  }

  /**
   * Refuses a workspace, immediately.
   *
   * **Fully synchronous, and the ordering is the security property.** The set membership and the
   * epoch bump both happen before this returns, so every concurrent decision either read the old
   * epoch (and will fail its post-await re-check) or reads the new state directly. Nothing is
   * persisted here: persistence is `WorkspaceTrustStore`'s job and it can fail, whereas this must
   * not be able to.
   */
  blockWorkspace(workspaceId: string): void {
    this.blockedWorkspaces.add(workspaceId);
    this.bumpWorkspaceEpoch(workspaceId);
  }

  /**
   * Blocks a workspace and cancels every session running in it.
   *
   * The block happens first and synchronously (see `blockWorkspace`); only the cancellation, which
   * genuinely has to wait for provider processes to die, is async. A caller that awaits this learns
   * the processes are gone; a caller that does not still gets the admission block, which is the half
   * that must never be skippable.
   */
  async revokeWorkspace(workspaceId: string): Promise<string[]> {
    this.blockWorkspace(workspaceId);
    const sessionIds = [...(this.sessionsByWorkspace.get(workspaceId) ?? [])];
    await Promise.all(
      sessionIds.map(async (sessionId) => {
        const runtime = this.runtime.get(sessionId);
        if (!runtime) return;
        await this.cancelRuntime(sessionId, runtime);
      }),
    );
    return sessionIds;
  }

  /**
   * Answers "may a session start in this workspace right now?", with the epoch re-checked after
   * every single await.
   *
   * The re-checks are the actual security property, not defensive decoration. Each `await` hands
   * control back to the event loop, and the only thing that happens on this loop that matters here
   * is `blockWorkspace` -- which is synchronous, so it always completes entirely inside one of these
   * gaps. Re-reading the epoch after each gap is therefore both necessary and sufficient: necessary
   * because a revocation in gap N is invisible to a check made before gap N, and sufficient because
   * a revocation cannot be half-done when we look.
   *
   * Removing any one of these four checks reintroduces a real window:
   *
   * - the entry check catches a revocation between the caller reading the epoch and calling here;
   * - the post-revalidation check catches one during the filesystem round trip;
   * - the post-inspection check catches one during the trust-store read;
   * - the final comparison is what the returned `true` actually means.
   */
  async workspaceIsTrusted(check: WorkspaceTrustCheck): Promise<boolean> {
    if (!this.workspaceTrust) return false;
    if (this.blockedWorkspaces.has(check.workspaceId)) return false;
    if (this.workspaceEpoch(check.workspaceId) !== check.expectedEpoch) return false;

    const stillTheSameWorkspace = await this.revalidateIdentity(check.canonicalPath, {
      workspaceId: check.workspaceId,
      incarnation: check.incarnation,
    });
    if (this.workspaceEpoch(check.workspaceId) !== check.expectedEpoch) return false;
    if (!stillTheSameWorkspace) return false;

    const inspection = await this.workspaceTrust.inspect(check.workspaceId);
    if (this.workspaceEpoch(check.workspaceId) !== check.expectedEpoch) return false;

    const trusted = inspection.state === 'trusted' && inspection.incarnation === check.incarnation;
    return (
      trusted &&
      !this.blockedWorkspaces.has(check.workspaceId) &&
      this.workspaceEpoch(check.workspaceId) === check.expectedEpoch
    );
  }

  /** Live session ids in one workspace. Exposed for revocation reporting and for tests. */
  sessionsInWorkspace(workspaceId: string): string[] {
    return [...(this.sessionsByWorkspace.get(workspaceId) ?? [])];
  }

  private bumpWorkspaceEpoch(workspaceId: string): void {
    this.workspaceRevocationEpochs.set(workspaceId, this.workspaceEpoch(workspaceId) + 1);
  }

  private indexWorkspaceSession(workspaceId: string, sessionId: string): void {
    const existing = this.sessionsByWorkspace.get(workspaceId) ?? new Set<string>();
    existing.add(sessionId);
    this.sessionsByWorkspace.set(workspaceId, existing);
    this.workspaceBySession.set(sessionId, workspaceId);
  }

  private unindexWorkspaceSession(sessionId: string): void {
    const workspaceId = this.workspaceBySession.get(sessionId);
    if (workspaceId === undefined) return;
    this.workspaceBySession.delete(sessionId);
    const set = this.sessionsByWorkspace.get(workspaceId);
    if (!set) return;
    set.delete(sessionId);
    if (set.size === 0) this.sessionsByWorkspace.delete(workspaceId);
  }

  private evictOldestCompletedIfOverCap(): void {
    while (this.completedOrder.length > MAX_RETAINED_COMPLETED_SESSIONS) {
      const staleId = this.completedOrder.shift();
      if (staleId === undefined) break;
      // Both deletes are unconditional and both are no-ops for anything already gone. A session
      // recovered from the durable store has a `SessionStore` entry but never had a `RuntimeState`
      // (no process, no event buffer), so a guard on `runtime.has()` here -- which is what this loop
      // used to open with -- would drop the FIFO entry and leave the store entry retained forever,
      // making the cap unenforceable for exactly the sessions the constructor seeds.
      this.runtime.delete(staleId);
      this.store.delete(staleId);
    }
  }

  /** Reads the current record from the store, applies `fn`, writes it back: the store is the source of truth, never a mutated-in-place reference held elsewhere. */
  private mutateSession(id: string, fn: (session: AgentSession) => void): void {
    const session = this.store.get(id);
    if (!session) return;
    fn(session);
    this.store.update(id, session);
  }

  private applyStatusTransition(session: AgentSession, event: AgentEvent): void {
    switch (event.type) {
      case 'session.completed':
        session.status = 'completed';
        session.completedAt = new Date().toISOString();
        session.providerSessionId = event.providerSessionId ?? session.providerSessionId;
        break;
      case 'session.failed':
        session.status = 'failed';
        session.completedAt = new Date().toISOString();
        session.error = event.message;
        break;
      case 'session.cancelled':
        session.status = 'cancelled';
        session.completedAt = new Date().toISOString();
        break;
      default:
        break;
    }
  }

  get(id: string): AgentSession | undefined {
    return this.store.get(id);
  }

  list(): AgentSession[] {
    return this.store.list();
  }

  /** Replays stored events from `sinceIndex` onward, then delivers live events as they arrive. */
  subscribe(
    id: string,
    sinceIndex: number,
    listener: (index: number, event: AgentEventEnvelope) => void,
  ): (() => void) | undefined {
    const runtime = this.runtime.get(id);
    if (!runtime) return undefined;

    for (let i = sinceIndex; i < runtime.events.length; i++) {
      listener(i, runtime.events[i] as AgentEventEnvelope);
    }

    runtime.listeners.add(listener);
    return () => runtime.listeners.delete(listener);
  }

  /** `false` for an unknown session AND for one that's already terminal (AD-11). Cancelling a
   * finished session is not a success, even though the previous version reported it as one. */
  async cancel(id: string): Promise<boolean> {
    const session = this.store.get(id);
    if (!session || (session.status !== 'starting' && session.status !== 'running')) return false;
    const runtime = this.runtime.get(id);
    if (!runtime) return false;
    await this.cancelRuntime(id, runtime);
    return true;
  }

  async remove(id: string): Promise<boolean> {
    const session = this.store.get(id);
    if (!session) return false;
    const runtime = this.runtime.get(id);
    if ((session.status === 'starting' || session.status === 'running') && runtime) {
      await this.cancelRuntime(id, runtime);
    }
    this.runtime.delete(id);
    this.store.delete(id);
    this.unindexWorkspaceSession(id);
    const orderIndex = this.completedOrder.indexOf(id);
    if (orderIndex !== -1) this.completedOrder.splice(orderIndex, 1);
    // The durable record is deliberately NOT deleted here. DELETE /sessions/:id removes a session
    // from the live, in-memory view; the durable store is governed by its own retention policy
    // (documented in docs/privacy.md), and letting an HTTP call erase an accepted-work record would
    // reopen the exact gap the store exists to close.
    return true;
  }

  /**
   * `handle.cancel()` can reject (e.g. a process-tree reap-confirmation timeout) rather than always
   * resolving once it merely initiated termination. The cancel signal was still sent either way, so
   * a caller here (an HTTP route, `remove()`, `cancelAll()`) must not see that as the request itself
   * having failed -- only that reap couldn't be confirmed within the budget, which is worth logging,
   * not surfacing as a 500.
   */
  private async cancelRuntime(id: string, runtime: RuntimeState): Promise<void> {
    await runtime.handle.cancel().catch((error: unknown) => {
      this.logger.warn('session cancel did not confirm a process-tree reap', { sessionId: id, error });
    });
  }

  /**
   * Cancels every in-flight session and waits (bounded) for their processes to actually exit.
   * Called on daemon shutdown to avoid orphaned CLI processes. `handle.cancel()` only *initiates*
   * termination (fires SIGTERM / taskkill and returns); without the bounded wait here, the daemon
   * could call `process.exit(0)` while a child is still mid-teardown (AD-12). If a child ignores
   * termination entirely, this still returns after `timeoutMs` rather than hanging shutdown
   * forever. The process-level SIGKILL escalation in spawnProcess is what ultimately reaps it.
   *
   * Reservations are released by each session's own `consume()` as it drains its terminal event,
   * never in bulk here: see `ActiveSessionLimiter` for why no `releaseAll()` exists.
   */
  async cancelAll(timeoutMs = 5_000): Promise<void> {
    const active = this.store
      .list()
      .filter((session) => session.status === 'starting' || session.status === 'running')
      .map((session) => ({ id: session.id, runtime: this.runtime.get(session.id) }))
      .filter((entry): entry is { id: string; runtime: RuntimeState } => !!entry.runtime);

    // This method's whole contract is best-effort and bounded -- one session's cancel failing to
    // confirm reap must never stop this from also cancelling every other active session, and must
    // never make the caller (including the daemon's own shutdown handler) see a rejection instead
    // of the documented bounded wait. See `cancelRuntime`.
    await Promise.all(active.map(({ id, runtime }) => this.cancelRuntime(id, runtime)));

    await Promise.race([
      Promise.all(active.map(({ runtime }) => runtime.done)),
      new Promise<void>((resolve) => setTimeout(resolve, timeoutMs)),
    ]);
  }
}
