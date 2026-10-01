import type { AgentEvent, ProviderStatus } from '@agent-dock/shared';
import type { Logger } from '../../logger.js';
import { noopLogger } from '../../logger.js';
import type { AgentProvider, SessionLaunchProbe, StartSessionOptions } from '../../types.js';
import {
  acceptedWorkBoundaryFor,
  findProviderCompatibility,
  LEGACY_ONE_SHOT_TRANSPORT_ID,
  type ProviderCompatibilityManifestEntry,
  type ProviderImplementation,
} from '../compatibility-manifest.js';
import { AcceptedWorkLatch, type AcceptedWorkState } from './accepted-work.js';
import { freezeLaunchScope, type FrozenLaunchScope } from './launch-scope.js';
import type { ProviderDeliveryState } from './fallback-gate.js';
import { UnknownFrameLedger, type NormalizedUnknownFrame } from './unknown-frames.js';

/**
 * The v2 session supervisor: a thin, observation-only wrapper around a v1 `AgentProvider` that
 * adds the safety state ADI-04 is about, without changing a single byte of what the provider does
 * or emits.
 *
 * ## What this is, and what it is not
 *
 * This is **not** a port of upstream AgentDock's `session-supervisor.ts`. That file is ~1,400
 * lines and is built around rich interactive transports, mid-turn commands, approval round-trips,
 * and an execution-graph store — none of which exist in this repo. Porting it would have meant
 * importing a large amount of machinery with no reachable caller, and then maintaining it. Instead
 * this is a much smaller supervisor built to the same *contracts* (accepted-work boundary,
 * launch-scope freezing, fallback authorization, bounded unknown-frame accounting) over the one
 * transport this repo actually has. When rich transports land, ADI-06+ replaces the internals of
 * this file; the exported shapes are the part intended to survive that.
 *
 * ## The hard constraint
 *
 * `SupervisedSessionHandle.events` re-yields the underlying provider's events **unchanged and
 * unreordered**. No event is added, dropped, rewritten, or delayed. This is asserted directly by
 * `test/support/supervisor-contract.ts`, which deep-equals the full event sequence from a bare
 * `provider.startSession()` against the one from `superviseProviderSession()` for the same
 * fixture. Everything the supervisor learns, it learns through the `launchProbe` side channel
 * (see `SessionLaunchProbe` in types.ts) or by *reading* events it is passing through anyway.
 *
 * ## Not wired into the daemon
 *
 * Exactly like ADI-03's `model-select.ts`, this ships with no caller. `apps/daemon/src/session-manager.ts`
 * is deliberately untouched. Wiring it in is a later ticket, and doing it here would have meant
 * changing live session behavior in the same change that introduced the mechanism.
 */

export interface SupervisorLimits {
  /** Budget for `cancel()` to confirm a full process-tree reap before giving up. */
  cancelTimeoutMs?: number;
  maxUnknownFrameKinds?: number;
  maxUnknownFrameObservations?: number;
}

const DEFAULT_CANCEL_TIMEOUT_MS = 10_000;

export interface SuperviseProviderSessionOptions {
  provider: AgentProvider;
  /**
   * The already-resolved `provider.detect()` result. Taken as an argument rather than awaited
   * internally so this function can stay synchronous (matching `startSession`) and so the caller
   * controls when detection happens — re-detecting here would both duplicate work and let the
   * frozen scope disagree with the status the caller made its own decisions from.
   */
  status: ProviderStatus;
  start: StartSessionOptions;
  transportId?: string;
  limits?: SupervisorLimits;
  logger?: Logger;
}

export type SupervisedTerminal = 'completed' | 'failed' | 'cancelled';

export interface SupervisedOutcome {
  readonly terminal: SupervisedTerminal;
  readonly acceptedWork: AcceptedWorkState;
  readonly delivery: ProviderDeliveryState;
  readonly providerSessionId?: string;
  readonly failureReasonCode?: string;
  readonly unknownFrames: readonly NormalizedUnknownFrame[];
  /**
   * Whether the owned process tree is known to be gone.
   *
   * `true` when the session ended on its own (the process exited, so there is nothing to reap) or
   * when `cancel()` obtained a confirmed reap. `false` **only** when a cancellation was requested
   * and the reap could not be confirmed within `cancelTimeoutMs` — which is the one case a caller
   * must not treat as "safe to clean up the working directory", because something may still be
   * running in it.
   */
  readonly reaped: boolean;
}

export interface SupervisedSessionHandle {
  readonly sessionId: string;
  readonly transportId: string;
  /** `undefined` when the provider/version/transport triple is not in the reviewed manifest. */
  readonly compatibility: ProviderCompatibilityManifestEntry | undefined;
  readonly frozenScope: FrozenLaunchScope;
  /**
   * The provider's own event stream, re-yielded verbatim.
   *
   * Draining this is what drives the session: the supervisor deliberately does not buffer or
   * pre-drain it, so `settled` resolves only once the consumer has consumed the stream (or
   * abandoned it). Buffering internally would change backpressure behavior for every event, which
   * is exactly the kind of "invisible" difference the byte-identity constraint forbids.
   */
  readonly events: AsyncGenerator<AgentEvent, void, void>;
  acceptedWork(): AcceptedWorkState;
  /** Settles the first time work stops being provably un-delivered. May never settle. */
  readonly accepted: Promise<AcceptedWorkState>;
  readonly settled: Promise<SupervisedOutcome>;
  /** Resolves only once the owned process tree is confirmed reaped. Never rejects; see `reaped`. */
  cancel(): Promise<void>;
  unknownFrames(): readonly NormalizedUnknownFrame[];
}

const TERMINAL_BY_EVENT: Readonly<Record<string, SupervisedTerminal>> = Object.freeze({
  'session.completed': 'completed',
  'session.failed': 'failed',
  'session.cancelled': 'cancelled',
});

/**
 * `ProviderId` is a subset of `ProviderImplementation`, but the manifest is keyed by the wider
 * type. A cast is avoided by narrowing explicitly, so a future `ProviderId` value that the
 * manifest does not model produces a clean manifest miss (and therefore the fail-closed boundary)
 * rather than a lookup against a value the manifest's type says cannot occur.
 */
function asProviderImplementation(id: string): ProviderImplementation | undefined {
  return id === 'claude' || id === 'codex' || id === 'fake' ? id : undefined;
}

export function superviseProviderSession(
  options: SuperviseProviderSessionOptions,
): SupervisedSessionHandle {
  const logger = options.logger ?? noopLogger;
  const transportId = options.transportId ?? LEGACY_ONE_SHOT_TRANSPORT_ID;
  const limits = options.limits ?? {};
  const cancelTimeoutMs = limits.cancelTimeoutMs ?? DEFAULT_CANCEL_TIMEOUT_MS;

  const implementation = asProviderImplementation(options.status.id);
  const compatibility = implementation
    ? findProviderCompatibility(implementation, options.status.version, transportId)
    : undefined;
  // Fail-closed on a manifest miss: an unverified CLI version gets the most conservative boundary.
  // See `acceptedWorkBoundaryFor` for why that direction and not the other.
  const boundary = acceptedWorkBoundaryFor(compatibility);

  const frozenScope = freezeLaunchScope(options.status, options.start, transportId);
  const latch = new AcceptedWorkLatch();
  const ledger = new UnknownFrameLedger({
    maxKinds: limits.maxUnknownFrameKinds,
    maxObservations: limits.maxUnknownFrameObservations,
  });

  let delivery: ProviderDeliveryState = 'not_delivered';
  // Starts true: a session that ends on its own has no tree left to reap. Only a cancellation
  // whose reap could not be confirmed ever flips this to false.
  let reaped = true;
  let providerSessionId: string | undefined;
  let failureReasonCode: string | undefined;

  let settleOutcome!: (outcome: SupervisedOutcome) => void;
  const settled = new Promise<SupervisedOutcome>((resolve) => {
    settleOutcome = resolve;
  });
  let alreadySettled = false;

  /**
   * The accepted-work observations, driven by `evidence.viaStdin` -- `runProviderSession`'s own,
   * real `promptViaStdin` flag for this exact call, reported at the actual call site -- rather than
   * by `boundary` (the manifest's `acceptedWorkBoundary`, which is a separately-maintained fact
   * about a *verified CLI version*, not about which transport OUR OWN adapter code uses). Using the
   * manifest field here was a real bug: if an adapter's `promptViaStdin` config ever drifted out of
   * sync with the manifest (e.g. `build-args.ts` changed to write stdin but nobody updated
   * `compatibility-manifest.ts`), the boundary lookup would keep confidently reporting the OLD
   * transport, and a `'first-prompt-byte-to-stdin'`-classified session whose adapter actually
   * embeds the prompt in argv would sit at `'not_accepted'` for its entire life even after
   * definitely delivering the prompt -- a manifest *hit* failing open, which is worse than a
   * manifest *miss* (a miss already fails closed via `acceptedWorkBoundaryFor`). Deriving from
   * `evidence.viaStdin` instead makes that drift structurally impossible: there is only one flag
   * governing both what `runProviderSession` actually does and what the supervisor assumes it did.
   *
   * - `viaStdin: true` (Claude): nothing is observed at spawn, because a CLI reading its prompt
   *   from stdin has provably received nothing until we write. The stdin write is a direct
   *   observation of delivery, so it records `'accepted'`.
   * - `viaStdin: false` (Codex, and every provider whose adapter embeds the prompt in argv): the
   *   prompt is already in the command line, so process creation hands it over unconditionally and
   *   atomically -- there is no in-flight window analogous to a pipe write that could fail after
   *   the process already exists. This is `'accepted'`, not `'unknown'`: the prompt's *delivery* is
   *   certain even though whether the CLI has *acted* on it yet is not, and `AcceptedWorkState`
   *   measures delivery (retry-safety), never completion.
   *
   * `boundary`/`compatibility` remain useful for fixture-set classification and the
   * unrecognized-version fail-closed diagnostic surfaced on the handle, just not for this decision
   * -- except as a consistency check: a mismatch between what the manifest claims and what
   * ground truth reports is exactly the drift that made the manifest unsafe to use directly, so
   * rather than silently discard `boundary` once it stopped being the source of truth, a mismatch
   * is logged. It never changes behavior; it only makes a stale manifest entry loud instead of
   * invisible the next time someone edits an adapter's transport without updating this table.
   *
   * `onSpawnFailed` records nothing at all. A failed spawn means no process was created, so the
   * prompt provably reached nothing and `'not_accepted'` must stand.
   */
  const launchProbe: SessionLaunchProbe = {
    onSpawnAttempt: (evidence) => {
      const expectedViaStdin = boundary === 'first-prompt-byte-to-stdin';
      if (evidence.viaStdin !== expectedViaStdin) {
        logger.warn('compatibility manifest boundary disagrees with the adapter\'s actual transport', {
          sessionId: options.start.sessionId,
          provider: options.status.id,
          manifestBoundary: boundary,
          actualViaStdin: evidence.viaStdin,
        });
      }
      if (evidence.viaStdin) return;
      delivery = 'delivered';
      latch.observe('accepted');
    },
    onPromptDelivered: () => {
      delivery = 'delivered';
      latch.observe('accepted');
    },
    onSpawnFailed: () => {
      // Never downgrades `delivery` from 'delivered': if it was already latched as delivered (an
      // argv-embedded prompt whose process then failed for some OTHER reason after creation), that
      // fact is real and permanent, not something a later failure can retroactively undo.
      if (delivery !== 'delivered') delivery = 'not_delivered';
    },
    onUnknownFrame: (kind, rawLine, eventType, boundsViolation) => {
      ledger.record(kind, rawLine, eventType, boundsViolation);
    },
  };

  const handle = options.provider.startSession({ ...options.start, launchProbe });

  function finish(terminal: SupervisedTerminal): void {
    if (alreadySettled) return;
    alreadySettled = true;
    settleOutcome({
      terminal,
      acceptedWork: latch.state,
      delivery,
      ...(providerSessionId === undefined ? {} : { providerSessionId }),
      ...(failureReasonCode === undefined ? {} : { failureReasonCode }),
      unknownFrames: ledger.entries(),
      reaped,
    });
  }

  /**
   * Shared by the returned handle's `cancel()` and by stream abandonment below. Idempotent: the
   * underlying `handle.cancel()` (see `run-session.ts`) already treats a second call as a no-op
   * once cancellation has been requested, and `spawned.kill()` beneath it is itself memoized.
   */
  async function performCancel(): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      // `handle.cancel()` resolves only on a confirmed process-tree reap as of ADI-04 (see
      // run-session.ts and process/spawn-process.ts). The extra race here is belt-and-braces: it
      // bounds the supervisor's own promise even if a provider implementation's cancel does not
      // bound itself, so a stuck adapter cannot wedge a caller forever.
      await Promise.race([
        handle.cancel(),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(
            () => reject(new Error('supervised cancel exceeded its reap budget')),
            cancelTimeoutMs,
          );
          // Unref'd so a pending reap budget cannot by itself keep a daemon process alive.
          timer.unref?.();
        }),
      ]);
    } catch (err) {
      // Recorded, not rethrown. Cancellation *was* requested; what failed is the confirmation.
      // That belongs in the outcome, where it can be acted on, rather than as an exception a caller
      // is likely to log and discard — and rethrowing would also make `cancel()` reject in exactly
      // the situation where the caller most needs to keep going and read `reaped`.
      reaped = false;
      logger.warn('supervised session could not confirm a process-tree reap', {
        sessionId: options.start.sessionId,
        message: (err as Error).message,
      });
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  async function* supervise(): AsyncGenerator<AgentEvent, void, void> {
    let terminal: SupervisedTerminal | undefined;
    try {
      for await (const event of handle.events) {
        // Read-only inspection of an event that is yielded below exactly as received. Nothing in
        // this block constructs, clones, or modifies an event.
        const mapped = TERMINAL_BY_EVENT[event.type];
        if (mapped) terminal = mapped;
        if (event.type === 'session.completed' && event.providerSessionId) {
          providerSessionId = event.providerSessionId;
        }
        if (event.type === 'error' && failureReasonCode === undefined) {
          // First error wins: it is the proximate cause. A later error is usually a consequence
          // (a stream teardown following the real failure), so overwriting would report the
          // symptom instead of the cause.
          failureReasonCode = event.code ?? 'PROVIDER_ERROR';
        }
        yield event;
      }
    } finally {
      // `finally`, not a post-loop statement, so a consumer that breaks out of its `for await`
      // (or is torn down by an exception) still settles the outcome rather than leaving `settled`
      // pending forever. The synthetic reason code makes that case distinguishable from a real
      // provider failure.
      if (terminal === undefined) {
        failureReasonCode ??= 'SUPERVISED_STREAM_ABANDONED';
        // A consumer that stops iterating (an SSE client disconnecting, a route handler returning
        // early) is not the same thing as the underlying process actually stopping: `run()` keeps
        // running unless told to cancel, and could still spawn the process and deliver the prompt
        // AFTER this function would otherwise have frozen a `not_accepted` snapshot -- an outcome a
        // caller could then read as "safe to retry" for a session that goes on to do real work
        // moments later, entirely unobserved. Awaiting a real cancel here, before settling, closes
        // that: either it wins the race (nothing was ever spawned, and the latch is correctly still
        // `not_accepted`), or the spawn had already happened by the time this runs, in which case
        // `onSpawnAttempt`/`onPromptDelivered` already latched `'accepted'` and this cancel's only
        // job is making sure the resulting process is actually reaped. Either way, `finish()` below
        // reads `latch.state` only after this has resolved, never before.
        await performCancel();
      }
      finish(terminal ?? 'failed');
    }
  }

  const events = supervise();

  return {
    sessionId: options.start.sessionId,
    transportId,
    compatibility,
    frozenScope,
    events,
    acceptedWork: () => latch.state,
    accepted: latch.accepted,
    settled,
    cancel: performCancel,
    unknownFrames: () => ledger.entries(),
  };
}
