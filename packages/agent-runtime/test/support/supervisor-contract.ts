import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AgentEvent, ProviderId, ProviderStatus } from '@agent-dock/shared';
import { noopLogger, type Logger } from '../../src/logger.js';
import { runProviderSession, type ParsedLine } from '../../src/providers/common/run-session.js';
import {
  superviseProviderSession,
  type SupervisedSessionHandle,
} from '../../src/providers/common/session-supervisor.js';
import { FallbackGate } from '../../src/providers/common/fallback-gate.js';
import {
  acceptedWorkBoundaryFor,
  findProviderCompatibility,
  LEGACY_ONE_SHOT_TRANSPORT_ID,
} from '../../src/providers/compatibility-manifest.js';
import type { AcceptedWorkState } from '../../src/providers/common/accepted-work.js';
import type { AgentProvider, SessionLaunchProbe, StartSessionOptions } from '../../src/types.js';

const fixturesDir = fileURLToPath(new URL('../fixtures', import.meta.url));

export interface SupervisorContractSpec {
  providerId: ProviderId;
  /** The exact CLI version string pinned in providers/compatibility-manifest.ts for this provider. */
  pinnedVersion: string;
  /** The adapter's real parser: this suite exercises real normalization, not a stand-in. */
  parseLine: (raw: unknown, logger: Logger) => ParsedLine;
  /** Mirrors the adapter's own `promptViaStdin`, which is what selects the accepted-work boundary. */
  promptViaStdin: boolean;
  fixtures: { success: string; failure: string; hang: string };
  /**
   * What `acceptedWork` must equal once the session has produced output. Derived from the
   * provider's manifest boundary, and asserted rather than inferred so the two boundaries are
   * demonstrably *different* at runtime rather than merely different in a table.
   */
  expectedAcceptedWorkAfterOutput: 'accepted' | 'unknown';
}

async function collect(events: AsyncGenerator<AgentEvent, void, void>): Promise<AgentEvent[]> {
  const out: AgentEvent[] = [];
  for await (const event of events) out.push(event);
  return out;
}

/**
 * Conformance suite for the ADI-04 session supervisor, run per provider against that provider's
 * real parser and real fixtures.
 *
 * Kept separate from `provider-contract.ts` rather than merged into it: that suite is the v1
 * adapter contract and must keep passing untouched (acceptance criterion 7), and mixing a v2
 * supervisor's assertions into it would make a failure ambiguous about which contract broke.
 */
export function describeSupervisorContract(spec: SupervisorContractSpec): void {
  describe(`supervisor contract: ${spec.providerId}`, () => {
    let cwd: string;

    beforeEach(() => {
      cwd = mkdtempSync(join(tmpdir(), `ovr-supervisor-${spec.providerId}-`));
    });

    afterEach(() => {
      // Retried: on Windows a directory cannot be removed while any process still has it as its
      // working directory, and a test that failed mid-cancellation can briefly leave one there.
      // Without the retries the cleanup error masks the real assertion failure in the report.
      rmSync(cwd, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    });

    /**
     * A real `AgentProvider` whose `startSession` is the genuine shared engine, aimed at a fixture.
     *
     * `wrapProbe` is an optional interceptor for the supervisor's own `launchProbe`. It exists for
     * the boundary-timing section below, which has to observe the latch *between* two callbacks
     * that `runProviderSession` fires back to back; nothing else can see that interval. It is a
     * pass-through by default, so every other test in this suite runs the unmodified probe.
     */
    function fixtureProvider(
      fixtureName: string,
      wrapProbe?: (probe: SessionLaunchProbe | undefined) => SessionLaunchProbe | undefined,
    ): AgentProvider {
      return {
        id: spec.providerId,
        name: spec.providerId,
        detect: () => Promise.resolve(status()),
        startSession: (options: StartSessionOptions) =>
          runProviderSession(
            {
              providerId: spec.providerId,
              executableNames: [process.execPath],
              buildArgs: () => [join(fixturesDir, fixtureName)],
              parseLine: spec.parseLine,
              promptViaStdin: spec.promptViaStdin,
            },
            wrapProbe ? { ...options, launchProbe: wrapProbe(options.launchProbe) } : options,
            noopLogger,
          ),
      };
    }

    function status(): ProviderStatus {
      return {
        id: spec.providerId,
        name: spec.providerId,
        installed: true,
        authenticated: 'authenticated',
        capabilities: {},
        executablePath: process.execPath,
        version: spec.pinnedVersion,
      };
    }

    function supervise(fixtureName: string, sessionId = 'supervised-session'): SupervisedSessionHandle {
      return superviseProviderSession({
        provider: fixtureProvider(fixtureName),
        status: status(),
        start: { sessionId, cwd, prompt: 'hello' },
      });
    }

    describe('manifest binding', () => {
      it('resolves the reviewed manifest entry for the pinned version and shipped transport', () => {
        const handle = supervise(spec.fixtures.success);
        expect(handle.transportId).toBe(LEGACY_ONE_SHOT_TRANSPORT_ID);
        expect(handle.compatibility).toBe(
          findProviderCompatibility(spec.providerId, spec.pinnedVersion, LEGACY_ONE_SHOT_TRANSPORT_ID),
        );
        expect(handle.compatibility?.providerVersion).toBe(spec.pinnedVersion);
        return collect(handle.events).then(() => undefined);
      });

      it('freezes a launch scope describing what was actually launched', async () => {
        const handle = supervise(spec.fixtures.success);
        expect(Object.isFrozen(handle.frozenScope)).toBe(true);
        expect(handle.frozenScope).toMatchObject({
          provider: spec.providerId,
          cwd,
          providerVersion: spec.pinnedVersion,
          transportId: LEGACY_ONE_SHOT_TRANSPORT_ID,
          accountEvidence: 'cli_owned',
        });
        await collect(handle.events);
      });

      it("derives the boundary the provider's manifest entry declares", () => {
        const handle = supervise(spec.fixtures.success);
        const boundary = acceptedWorkBoundaryFor(handle.compatibility);
        expect(boundary).toBe(
          spec.promptViaStdin ? 'first-prompt-byte-to-stdin' : 'process-spawn-attempt',
        );
        return collect(handle.events).then(() => undefined);
      });
    });

    /**
     * The *timing* half of the accepted-work contract, as opposed to the terminal-value half the
     * "success path" section already covers.
     *
     * Both providers finish a successful session at `'accepted'`, so asserting the final value
     * alone cannot distinguish a stdin-boundary adapter from an argv-boundary one — which is
     * precisely the distinction ADI-14 changed for Codex. This section instead samples the latch
     * from *inside* the two probe callbacks `runProviderSession` fires back to back, which is the
     * only interval in which the two boundaries look different, and it does so against the real
     * engine and the real supervisor rather than a stand-in.
     */
    describe('accepted-work boundary timing', () => {
      /** `'handle-unset'` would mean a probe fired before `superviseProviderSession` returned. */
      type Mark = { at: string; state: AcceptedWorkState | 'handle-unset' };

      async function recordTimeline(): Promise<{ marks: Mark[]; evidence: boolean[] }> {
        const marks: Mark[] = [];
        const evidence: boolean[] = [];
        // A holder rather than a bare `let`, because the probe callbacks below close over it and
        // run before `superviseProviderSession` has returned the handle to assign.
        const supervised: { handle?: SupervisedSessionHandle } = {};
        // Deliberately not a throw when unset: `runProviderSession` swallows a throwing probe
        // callback by design, so throwing here would silently skip the observation instead of
        // failing. A sentinel value that no assertion accepts fails loudly instead.
        const peek = (): AcceptedWorkState | 'handle-unset' =>
          supervised.handle?.acceptedWork() ?? 'handle-unset';

        const provider = fixtureProvider(spec.fixtures.success, (probe) => ({
          ...probe,
          onSpawnAttempt: (spawnEvidence) => {
            evidence.push(spawnEvidence.viaStdin);
            marks.push({ at: 'before onSpawnAttempt', state: peek() });
            probe?.onSpawnAttempt?.(spawnEvidence);
            marks.push({ at: 'after onSpawnAttempt', state: peek() });
          },
          onPromptDelivered: () => {
            marks.push({ at: 'before onPromptDelivered', state: peek() });
            probe?.onPromptDelivered?.();
            marks.push({ at: 'after onPromptDelivered', state: peek() });
          },
        }));

        supervised.handle = superviseProviderSession({
          provider,
          status: status(),
          start: { sessionId: 'boundary-timing-session', cwd, prompt: 'hello' },
        });
        await collect(supervised.handle.events);
        return { marks, evidence };
      }

      it('reports its real transport as spawn evidence, and observes the latch at both callbacks', async () => {
        const { marks, evidence } = await recordTimeline();

        expect(evidence).toEqual([spec.promptViaStdin]);
        // Never sampled before the handle existed, so every state below is a real reading.
        expect(marks.map((m) => m.state)).not.toContain('handle-unset');
        // Nothing has been observed yet at the very first callback, under either boundary.
        expect(marks[0]).toEqual({ at: 'before onSpawnAttempt', state: 'not_accepted' });
      });

      if (spec.promptViaStdin) {
        it('is still not_accepted immediately after the spawn attempt, and only latches on the stdin flush', async () => {
          const { marks } = await recordTimeline();

          // The behavioral change ADI-14 makes for Codex, stated as the two adjacent readings that
          // straddle the spawn: creating the process is NOT delivery when the prompt is on stdin.
          expect(marks.find((m) => m.at === 'after onSpawnAttempt')?.state).toBe('not_accepted');
          expect(marks.find((m) => m.at === 'before onPromptDelivered')?.state).toBe('not_accepted');
          expect(marks.find((m) => m.at === 'after onPromptDelivered')?.state).toBe('accepted');

          // And the stdin flush really did happen after the spawn, not merely somewhere else.
          const lastSpawnMark = marks.map((m) => m.at).lastIndexOf('after onSpawnAttempt');
          const firstDeliveryMark = marks.map((m) => m.at).indexOf('before onPromptDelivered');
          expect(firstDeliveryMark).toBeGreaterThan(lastSpawnMark);
        });
      } else {
        it('latches at the spawn attempt itself, with no stdin flush to wait for', async () => {
          const { marks } = await recordTimeline();

          expect(marks.find((m) => m.at === 'after onSpawnAttempt')?.state).toBe('accepted');
          expect(marks.some((m) => m.at.endsWith('onPromptDelivered'))).toBe(false);
        });
      }
    });

    /**
     * The concrete proof of "no v1 launch behavior change": the same fixture, run bare and run
     * supervised, must produce deep-equal event sequences. If the supervisor ever added,
     * dropped, reordered, or rewrote an event, this fails.
     */
    describe('event stream identity', () => {
      it('yields an AgentEvent sequence deep-equal to the unsupervised one, for the success fixture', async () => {
        const bare = await collect(
          fixtureProvider(spec.fixtures.success).startSession({
            sessionId: 'identity-session',
            cwd,
            prompt: 'hello',
          }).events,
        );
        const supervised = await collect(supervise(spec.fixtures.success, 'identity-session').events);

        expect(supervised).toEqual(bare);
        expect(supervised.length).toBeGreaterThan(1);
      });

      it('yields an identical sequence for the failure fixture too', async () => {
        const bare = await collect(
          fixtureProvider(spec.fixtures.failure).startSession({
            sessionId: 'identity-failure',
            cwd,
            prompt: 'hello',
          }).events,
        );
        const supervised = await collect(supervise(spec.fixtures.failure, 'identity-failure').events);
        expect(supervised).toEqual(bare);
      });
    });

    describe('success path', () => {
      it('settles completed, with work accepted and nothing left to reap', async () => {
        const handle = supervise(spec.fixtures.success);
        await collect(handle.events);
        const outcome = await handle.settled;

        expect(outcome.terminal).toBe('completed');
        expect(outcome.acceptedWork).toBe(spec.expectedAcceptedWorkAfterOutput);
        expect(outcome.delivery).toBe('delivered');
        expect(outcome.failureReasonCode).toBeUndefined();
        // True because the process exited on its own: there was never a tree to reap.
        expect(outcome.reaped).toBe(true);
      });

      it('settles `accepted` and reports the same state through acceptedWork()', async () => {
        const handle = supervise(spec.fixtures.success);
        await collect(handle.events);
        await expect(handle.accepted).resolves.toBe(spec.expectedAcceptedWorkAfterOutput);
        expect(handle.acceptedWork()).toBe(spec.expectedAcceptedWorkAfterOutput);
      });

      it('tallies the fixture\'s deliberately unrecognized event type without retaining it', async () => {
        const handle = supervise(spec.fixtures.success);
        await collect(handle.events);
        const frames = (await handle.settled).unknownFrames;

        const unrecognized = frames.find((f) => f.kind === 'unrecognized_event_type');
        expect(unrecognized).toBeDefined();
        expect(unrecognized!.eventType).toBe('totally_unrecognized_future_event');
        expect(unrecognized!.occurrences).toBe(1);
        expect(JSON.stringify(frames)).not.toContain('goes here');
        expect(handle.unknownFrames()).toEqual(frames);
      });
    });

    describe('failure path', () => {
      it('settles failed, carrying the first error code as the failure reason', async () => {
        const handle = supervise(spec.fixtures.failure);
        await collect(handle.events);
        const outcome = await handle.settled;

        expect(outcome.terminal).toBe('failed');
        expect(outcome.failureReasonCode).toBe('PROCESS_EXIT');
        expect(outcome.reaped).toBe(true);
      });
    });

    describe('cancellation before any work was accepted', () => {
      /**
       * Cancelled synchronously, before `runProviderSession` has finished resolving its executable.
       * That path reaches its pre-spawn cancellation check and never spawns, so no launch probe
       * fires — which is exactly the state in which retrying is provably safe.
       */
      it('reports not_accepted when cancelled before the process was ever spawned', async () => {
        const handle = supervise(spec.fixtures.hang);
        await handle.cancel();
        const events = await collect(handle.events);
        const outcome = await handle.settled;

        expect(events.at(-1)).toEqual({ type: 'session.cancelled' });
        expect(outcome.terminal).toBe('cancelled');
        expect(outcome.acceptedWork).toBe('not_accepted');
        expect(outcome.delivery).toBe('not_delivered');
        expect(outcome.reaped).toBe(true);
      }, 20_000);

      it('would be authorized for fallback at that point, were a second transport to exist', async () => {
        const handle = supervise(spec.fixtures.hang);
        await handle.cancel();
        await collect(handle.events);
        const outcome = await handle.settled;

        const gate = new FallbackGate(handle.frozenScope);
        // `terminal: false` and a hypothetical alternate transport, to isolate the work/delivery
        // conditions from the structural ones. This is the only state in this suite that clears them.
        expect(
          gate.authorize({
            candidate: handle.frozenScope,
            acceptedWork: outcome.acceptedWork,
            delivery: outcome.delivery,
            alternateTransportIds: ['hypothetical-transport'],
            terminal: false,
          }),
        ).toMatchObject({ allowed: true, attempt: 1 });
      }, 20_000);
    });

    describe('cancellation after work was accepted', () => {
      async function cancelAfterAcceptance() {
        const handle = supervise(spec.fixtures.hang);
        // Waiting on the latch rather than on N events: the accepted-work boundary is the thing
        // under test, and it is not observable in the event stream (that is the whole reason the
        // launch probe exists). Counting events would also be provider-dependent — the hang
        // fixture's single line normalizes to a `status` event for Codex's parser but to nothing
        // at all for Claude's, so "drain two events" blocks forever for one of them.
        await handle.accepted;
        await handle.cancel();
        const rest: AgentEvent[] = [];
        for await (const event of handle.events) rest.push(event);
        return { handle, rest, outcome: await handle.settled };
      }

      it('reports the boundary-appropriate accepted-work state, never not_accepted', async () => {
        const { rest, outcome } = await cancelAfterAcceptance();

        expect(rest.at(-1)).toEqual({ type: 'session.cancelled' });
        expect(outcome.terminal).toBe('cancelled');
        expect(outcome.acceptedWork).toBe(spec.expectedAcceptedWorkAfterOutput);
        expect(outcome.acceptedWork).not.toBe('not_accepted');
      }, 20_000);

      it('confirms a full process-tree reap, so `reaped` stays true', async () => {
        const { outcome } = await cancelAfterAcceptance();
        expect(outcome.reaped).toBe(true);
      }, 20_000);

      it('would be DENIED for fallback at that point, on the work state alone', async () => {
        const { handle, outcome } = await cancelAfterAcceptance();

        const gate = new FallbackGate(handle.frozenScope);
        const decision = gate.authorize({
          candidate: handle.frozenScope,
          acceptedWork: outcome.acceptedWork,
          delivery: outcome.delivery,
          alternateTransportIds: ['hypothetical-transport'],
          terminal: false,
        });

        expect(decision.allowed).toBe(false);
        expect(decision).toMatchObject({
          reason: outcome.delivery === 'delivered' ? 'delivery_confirmed' : 'delivery_ambiguous',
        });
      }, 20_000);

      it('is denied in the actually-shipped configuration regardless, since no alternate exists', async () => {
        const { handle, outcome } = await cancelAfterAcceptance();
        const gate = new FallbackGate(handle.frozenScope);
        expect(
          gate.authorize({
            candidate: handle.frozenScope,
            acceptedWork: outcome.acceptedWork,
            delivery: outcome.delivery,
            alternateTransportIds: [],
            terminal: true,
          }),
        ).toEqual({ allowed: false, reason: 'no_alternate_transport' });
      }, 20_000);
    });
  });
}
