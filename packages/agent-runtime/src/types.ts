import type { AgentEvent, ProviderId, ProviderStatus } from '@agent-dock/shared';

export interface StartSessionOptions {
  /** Daemon-generated session UUID. Used only for logging/correlation, never as a process id. */
  sessionId: string;
  cwd: string;
  prompt: string;
  /** Provider-native session/thread id to resume, if the provider supports it. */
  resumeProviderSessionId?: string;
  /** One of the provider's `availableModels`, passed straight through to its CLI's model flag.
   * A provider with no model selection (no `availableModels`) ignores this field entirely. */
  model?: string;
  /**
   * Unset by every caller in this codebase today, and it no longer matters that it is.
   *
   * This used to be the *only* thing standing between a provider child and the daemon's entire
   * environment: unset meant full `process.env` inheritance. As of ADI-15 the child gets a
   * default-deny allowlist either way, and this field selects which environment is *filtered*
   * rather than whether filtering happens -- so leaving it unset is now the safe case rather than
   * the dangerous one. The old reasoning (a CLI needs `PATH`/`HOME`/etc. to find its own config and
   * credentials) still holds and is exactly what the allowlist grants; what changed is that the
   * required subset was measured against the real installed CLIs instead of assumed to be
   * unknowable. See `providers/common/provider-environment.ts` and
   * SECURITY.md#environment-allowlist-for-spawned-provider-processes.
   */
  env?: NodeJS.ProcessEnv;
  /**
   * Observation-only seam for the v2 session supervisor (ADI-04). Optional and unset by every
   * existing caller, so gaining this field breaks no v1 call site.
   *
   * @internal Not part of the daemon-facing API. `superviseProviderSession` is the only intended
   * producer; `runProviderSession` is the only intended consumer.
   */
  launchProbe?: SessionLaunchProbe;
  /**
   * Ask the provider adapter to restrict the CLI to a reviewed, non-customizable configuration
   * (ADI-08b). Optional, and **omitted by every v1 caller**, which is what makes the v1 argv
   * byte-identical before and after this field existed.
   *
   * This is a *request*, not a contract: an adapter with nothing to restrict ignores it. Codex
   * ignores it today. Claude honors it in `providers/claude/build-args.ts`, which is where the
   * exact flag set and the reasoning for each value live.
   *
   * The field is deliberately a plain boolean rather than a policy object. There is exactly one
   * reviewed hardening profile per provider, defined next to that provider's argv construction, so
   * a caller can ask for it but cannot compose a weaker variant of it -- the restriction set is not
   * request-derived, and a route that could tune it would be a route that could turn it off.
   */
  hardened?: boolean;
}

/**
 * The two things a supervisor cannot learn by watching the normalized `AgentEvent` stream alone:
 * *when* the provider process was actually launched and its prompt handed over, and *what output
 * this repo failed to understand*.
 *
 * Both must come from inside `runProviderSession`, because both concern moments and values that
 * are deliberately not represented as `AgentEvent`s. Threading them out as callbacks rather than
 * as new event types is what keeps ADI-04's hard constraint intact: the supervised event stream is
 * byte-identical to the unsupervised one.
 *
 * Every method is optional and every call site is wrapped so a throwing callback can never fail a
 * session — an observer must not be able to break the thing it observes.
 *
 * @internal
 */
export interface SessionLaunchProbe {
  /**
   * Fired immediately before the provider process is created, once the working directory and
   * executable have already been validated. For a CLI whose prompt lives in argv (Codex), this is
   * the last moment at which non-delivery is still provable.
   *
   * `evidence.viaStdin` is `runProviderSession`'s OWN `ProviderRunConfig.promptViaStdin` flag for
   * this call -- the same boolean that decides whether it writes the prompt to the child's stdin a
   * few lines later -- passed through rather than left for a caller to separately re-derive or
   * assume. A caller (the supervisor) that tracked this fact on its own, e.g. via a hand-maintained
   * per-provider table, could silently drift out of sync with a real adapter change; reporting the
   * actual value at the actual call site makes that impossible by construction.
   */
  onSpawnAttempt?(evidence: { viaStdin: boolean }): void;
  /**
   * Fired immediately after the prompt bytes have been written to the child's stdin. Only ever
   * fires for an adapter with `promptViaStdin` set (Claude today).
   */
  onPromptDelivered?(): void;
  /** Fired when the spawn itself failed, meaning the prompt provably never reached a process. */
  onSpawnFailed?(): void;
  /**
   * Fired once per provider stdout line this repo could not fully interpret. `rawLine` is the
   * undecoded source line; the supervisor hashes it and never retains it (see
   * `providers/common/unknown-frames.ts`).
   */
  onUnknownFrame?(
    kind: 'unrecognized_event_type' | 'unparseable_line' | 'frame_bounds_exceeded' | 'non_object_frame',
    rawLine: string,
    eventType?: string,
    boundsViolation?: string,
  ): void;
}

export interface ProviderSessionHandle {
  /** Normalized event stream. Always terminates with a session.completed/failed/cancelled event. */
  events: AsyncGenerator<AgentEvent, void, void>;
  /**
   * Request cancellation.
   *
   * As of ADI-04 this resolves only once the owned process **tree** has been confirmed reaped, not
   * merely signalled: on POSIX the process group is polled until it is gone, and on Windows the
   * Job Object owning every descendant has been torn down. It rejects if that confirmation cannot
   * be obtained within the termination deadline, which is the honest answer — a caller that
   * proceeds to delete the working directory after an unconfirmed cancel is racing a live process.
   */
  cancel(): Promise<void>;
}

/**
 * One AI CLI integration. Implementations own everything provider-specific: executable
 * discovery, command construction, process spawning, output parsing, and normalization into
 * AgentEvent. Nothing outside this package should need to know a provider's native event shape.
 */
export interface AgentProvider {
  readonly id: ProviderId;
  readonly name: string;
  detect(): Promise<ProviderStatus>;
  startSession(options: StartSessionOptions): ProviderSessionHandle;
}
