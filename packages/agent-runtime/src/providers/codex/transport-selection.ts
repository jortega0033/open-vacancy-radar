import type { AgentEvent, ProviderStatus } from '@agent-dock/shared';
import { type Logger, noopLogger } from '../../logger.js';
import { AsyncChannel } from '../../process/async-channel.js';
import type { ProviderSessionHandle, StartSessionOptions } from '../../types.js';
import { overflowTerminalEvents, TERMINAL_AGENT_EVENT_TYPES } from '../common/agent-event-terminal.js';
import { FallbackGate } from '../common/fallback-gate.js';
import { freezeLaunchScope } from '../common/launch-scope.js';
import { runProviderSession } from '../common/run-session.js';
import {
  CODEX_APP_SERVER_TRANSPORT_ID,
  findProviderCompatibility,
  LEGACY_ONE_SHOT_TRANSPORT_ID,
} from '../compatibility-manifest.js';
import { createCodexAppServerTransport } from './app-server/transport.js';
import { buildCodexArgs } from './build-args.js';
import { detectCodex } from './detect.js';
import { parseCodexLine } from './parser.js';

function legacyExecTransport(options: StartSessionOptions, logger: Logger): ProviderSessionHandle {
  return runProviderSession(
    { providerId: 'codex', executableNames: ['codex'], buildArgs: buildCodexArgs, parseLine: parseCodexLine, promptViaStdin: true },
    options,
    logger,
  );
}

/**
 * Injectable seams, test-only: the real `detectCodex`/`createCodexAppServerTransport`/
 * `legacyExecTransport` all spawn real processes (or, for the legacy path, would if not stubbed),
 * so a unit test exercising this orchestration logic needs to substitute deterministic fakes for
 * all three rather than driving real `codex` binaries.
 */
export interface CodexTransportSelectionDeps {
  detect?(logger: Logger): Promise<ProviderStatus>;
  createAppServerTransport?: typeof createCodexAppServerTransport;
  createExecTransport?(options: StartSessionOptions, logger: Logger): ProviderSessionHandle;
}

/**
 * The actual "port lands" decision point for ADI-08 (#126). `adapter.ts` calls this only once an
 * operator has opted into `'app-server'` or `'auto'` transport mode (`resolveCodexTransportMode`,
 * `app-server-support.ts`) -- it handles `'exec'` mode itself, without ever calling into this file,
 * so the shipped default stays byte-identical to pre-ADI-08 behavior. This function does not take
 * the mode as a parameter: both non-`'exec'` modes behave identically here (see "Why 'app-server'
 * and 'auto' behave the same" below), so there is nothing for it to branch on.
 *
 * ## Why this lives outside `adapter.ts`'s `startSession`, which must stay synchronous
 *
 * `AgentProvider.startSession()` returns a `ProviderSessionHandle` synchronously (`types.ts`) --
 * `apps/daemon/src/session-manager.ts` documents exactly why: `detect()` cannot be awaited on the
 * session-creation path. But choosing app-server vs. exec genuinely needs fresh async information
 * (the CLI's current version and auth source), so this function returns its own
 * `ProviderSessionHandle` synchronously, backed by an `AsyncChannel` exactly like every other
 * transport in this repo (`app-server/transport.ts`, `run-session.ts`), and makes the real decision
 * inside the async work that channel is fed from.
 *
 * ## Why this calls `detectCodex()` itself instead of extending it
 *
 * The original plan for this stage said "extend `detect.ts` to run the scope probe." Re-checked
 * against the real call sites before writing this: `detectCodex()` is also called by
 * `routes/providers.ts`/`routes/v2-providers.ts` (listing provider status for the UI) and by
 * `session-manager.ts`'s `refineLaunchScope` (off the critical path, after every session starts,
 * v1 and v2 alike) -- neither of those callers has any use for app-server-specific scope evidence,
 * and `ProviderStatus` (`packages/shared/src/provider.ts`) has nowhere to put it without its own
 * wire-schema migration. Folding an extra process spawn into `detectCodex()` unconditionally would
 * add real latency to *every* provider-status listing, including the shipped-default `'exec'` mode
 * that never touches app-server at all -- exactly the "importing machinery with no reachable
 * caller" pattern this whole ticket has avoided at every prior stage. Calling `detectCodex()` from
 * here instead keeps that cost scoped to sessions that actually opted into `'app-server'`/`'auto'`,
 * and needs no `ProviderStatus` schema change at all.
 *
 * `probeCodexAppServerScope` (Stage 4) is deliberately NOT called from here either: it would add a
 * second real process spawn to every app-server session attempt for a check this function's own
 * fallback path already covers more cheaply -- if the account/model scope is wrong, `thread/start`
 * or `turn/start` itself fails, which is caught by the exact same startup-failure/fallback logic
 * below. The probe module stays fully built and tested (Stage 4) for a caller that needs to verify
 * scope *without* starting a session (e.g. a future settings/diagnostics surface); this one doesn't.
 *
 * ## Why 'app-server' and 'auto' behave the same
 *
 * An operator explicitly requesting `'app-server'` and one requesting `'auto'` degrade the same
 * way here: a compatibility miss or `api_key` auth is a zero-risk, pre-spawn fact that has nothing
 * to do with what the operator *asked* for, only with what this session can *safely do*. Silently
 * running a session over exec instead of erroring it out is strictly more useful in both cases --
 * there is no scenario where an operator would rather their session fail outright than fall back to
 * the transport this repo has always shipped. If a future need arises to make `'app-server'` a hard
 * requirement (fail rather than degrade), that is a new, separate decision with its own review, not
 * an accidental side effect of this function's current shape.
 *
 * ## The fallback decision itself
 *
 * `api_key` auth always routes straight to the legacy exec transport, unconditionally: the
 * app-server's resume/continuation identity binds to a ChatGPT account (`scope-evidence.ts`), which
 * an API-key session cannot provide, so there is nothing app-server offers that session and no
 * reason to pay its extra startup cost. Likewise a compatibility-manifest miss (unknown version, or
 * `detectCodex()` couldn't even find/run the CLI) routes straight to exec -- this happens before any
 * process is spawned, so there is no delivery risk to reason about, and consulting `FallbackGate`
 * for a decision that has nothing to do with delivery would be a category error, not extra safety.
 *
 * Once app-server is actually attempted, this function watches its own event stream (never
 * forwarding it to the caller yet) until either:
 *   - `turn/start`'s write is attempted (`transport.ts`'s `launchProbe.onPromptDelivered`, the
 *     `'turn-start-write-attempt'` accepted-work boundary `compatibility-manifest.ts` documents) --
 *     at that point the attempt is committed: everything buffered so far is flushed to the real
 *     caller, and every event from then on is forwarded live, verbatim, exactly like every other
 *     transport in this repo. No fallback is possible or considered past this point.
 *   - or the session ends in `session.failed` before that ever happens -- a real, provable
 *     "nothing was delivered" startup failure. This is the one case `FallbackGate.authorize()` is
 *     actually consulted: with `delivery: 'not_delivered'`, `acceptedWork: 'not_accepted'`, and
 *     `alternateTransportIds: [LEGACY_ONE_SHOT_TRANSPORT_ID]` -- the manifest's second real transport
 *     id (ADI-08 stage 6), used as a real fallback candidate for the first time anywhere in this
 *     repo. If authorized, the buffered (never-delivered) app-server events are discarded entirely
 *     and a fresh legacy exec session becomes this session's one and only transport, transparently
 *     to the caller -- which never sees more than one `session.started`, one terminal event, or any
 *     sign that a first attempt happened at all. If denied, for any of the gate's own structural
 *     reasons -- including `terminal: cancelled`, when the outer session's own `cancel()` already
 *     ran (`FallbackGate`'s `session_terminal` check: a session the caller already asked to stop
 *     must end stopped, not silently restart on another transport) -- the buffered failure is
 *     flushed as the real answer instead.
 *
 * `options.launchProbe`, if the caller supplied one (`session-manager.ts`'s accepted-work ledger),
 * is forwarded exactly once `onPromptDelivered` fires on WHICHEVER transport ultimately becomes the
 * committed one -- never for a discarded, safely-retried app-server attempt, which from the
 * caller's own accepted-work perspective never happened.
 */
export function createCodexTransportWithFallback(
  options: StartSessionOptions,
  logger: Logger = noopLogger,
  deps: CodexTransportSelectionDeps = {},
): ProviderSessionHandle {
  const detect = deps.detect ?? detectCodex;
  const createAppServer = deps.createAppServerTransport ?? createCodexAppServerTransport;
  const createExec = deps.createExecTransport ?? ((opts, log) => legacyExecTransport(opts, log));

  const channel = new AsyncChannel<AgentEvent>();
  let cancelled = false;
  let active: ProviderSessionHandle | undefined;

  function closeWithOverflow(): void {
    channel.closeWith(overflowTerminalEvents());
  }

  /** Pipes `handle`'s events verbatim into the outer channel, forever, from this point on. */
  async function pipeLive(handle: ProviderSessionHandle, alreadyBuffered: AgentEvent[]): Promise<void> {
    for (const event of alreadyBuffered) {
      if (!channel.push(event)) {
        closeWithOverflow();
        return;
      }
    }
    for await (const event of handle.events) {
      if (!channel.push(event)) {
        closeWithOverflow();
        return;
      }
    }
    channel.close();
  }

  function activate(handle: ProviderSessionHandle): void {
    active = handle;
    if (cancelled) {
      // Fire-and-forget, but not unhandled: cancel() is documented (types.ts) to reject when a
      // process-tree reap can't be confirmed within its deadline -- a real, expected failure mode,
      // not a bug -- and nothing else here awaits this call.
      handle.cancel().catch((error: unknown) => {
        logger.warn('codex transport-selection: cancel() of a not-yet-consumed handle did not confirm', {
          sessionId: options.sessionId,
          error,
        });
      });
    }
  }

  async function runExecOnly(): Promise<void> {
    const handle = createExec(options, logger);
    activate(handle);
    await pipeLive(handle, []);
  }

  /** Pushes each of `events` in order, closing the outer channel once they're all delivered. Used
   * only once the source generator they came from is already fully drained -- never re-iterates
   * it, unlike `pipeLive`, which is for a source whose *remaining* events still need forwarding. */
  function flushAndClose(events: readonly AgentEvent[]): void {
    for (const event of events) {
      if (!channel.push(event)) {
        closeWithOverflow();
        return;
      }
    }
    channel.close();
  }

  async function runAppServerWithFallback(status: ProviderStatus, executablePath: string): Promise<void> {
    const primaryScope = freezeLaunchScope(status, options, CODEX_APP_SERVER_TRANSPORT_ID);
    const gate = new FallbackGate(primaryScope);

    const buffered: AgentEvent[] = [];
    let promptDelivered = false;
    // Distinct from `promptDelivered`: that flag can flip to true asynchronously, from deep inside
    // `onPromptDelivered`'s callback, at any point between two loop iterations -- `committed` is
    // this loop's own, single-writer record of whether it has ALREADY flushed `buffered` in
    // response to that. Collapsing the two into one flag was the actual bug this fixes: without a
    // separate commit flag, the loop had no record of "have I flushed the buffer yet", so it never did.
    let committed = false;

    const handle = createAppServer({
      sessionId: options.sessionId,
      executable: executablePath,
      cwd: options.cwd,
      prompt: options.prompt,
      env: options.env,
      resumeProviderSessionId: options.resumeProviderSessionId,
      model: options.model,
      detectedAuthSource: status.authSource,
      launchProbe: {
        onPromptDelivered: () => {
          promptDelivered = true;
          options.launchProbe?.onPromptDelivered?.();
        },
      },
    });
    activate(handle);

    for await (const event of handle.events) {
      if (promptDelivered && !committed) {
        // The attempt just crossed the accepted-work boundary: flush everything buffered so far
        // (session.started, and anything else that arrived before turn/start was written) before
        // forwarding this or any later event live. Exactly once, ever, for this attempt.
        committed = true;
        for (const bufferedEvent of buffered) {
          if (!channel.push(bufferedEvent)) {
            closeWithOverflow();
            return;
          }
        }
        buffered.length = 0;
      }
      if (committed) {
        // Already committed: forward live, verbatim, from here on.
        if (!channel.push(event)) {
          closeWithOverflow();
          return;
        }
        continue;
      }
      buffered.push(event);
      if (!TERMINAL_AGENT_EVENT_TYPES.has(event.type)) continue;

      // A terminal event arrived before turn/start was ever attempted. Only `session.failed` is
      // eligible for fallback. `session.completed` genuinely cannot arrive here -- it requires a
      // turn/completed notification, which cannot fire before turn/start was ever sent.
      // `session.cancelled` CAN arrive here (this orchestrator's own cancel(), below, delegates to
      // `handle.cancel()` while it's still `active`, and `app-server/transport.ts`'s cancel() ends
      // in session.cancelled unconditionally once its wait window elapses, regardless of how far
      // the turn got) -- but it is correctly excluded from fallback anyway: a session the caller
      // already asked to stop must end stopped, not silently restart on another transport. The
      // `terminal: cancelled` below is what actually enforces that for the `session.failed` case
      // too (a process crash racing a requested cancellation), via FallbackGate's own
      // `session_terminal` check, rather than this file re-deriving the same rule ad hoc.
      if (event.type === 'session.failed') {
        const candidateScope = freezeLaunchScope(status, options, LEGACY_ONE_SHOT_TRANSPORT_ID);
        const decision = gate.authorize({
          candidate: candidateScope,
          acceptedWork: 'not_accepted',
          delivery: 'not_delivered',
          alternateTransportIds: [LEGACY_ONE_SHOT_TRANSPORT_ID],
          terminal: cancelled,
        });
        if (decision.allowed) {
          gate.consume();
          logger.info('codex app-server failed to start before any work was delivered; retrying over the legacy exec transport', {
            sessionId: options.sessionId,
          });
          const execHandle = createExec(options, logger);
          activate(execHandle);
          await pipeLive(execHandle, []);
          return;
        }
      }
      // Not eligible for fallback (or the gate denied): the buffered failure -- already including
      // this terminal event -- is the real answer. `handle.events` is already fully drained at this
      // point (this loop just consumed its last item), so there is nothing left to pipe from it.
      flushAndClose(buffered);
      return;
    }
    // The loop above only ever `return`s once it has fully handed off responsibility for closing
    // the outer channel (to `flushAndClose` or to `pipeLive`'s own channel.close() after the exec
    // fallback drains). Falling through to here means `handle.events` was exhausted naturally
    // instead -- the normal, successful-session shape once committed (every event, including the
    // terminal one, was already pushed live inside the loop above; `buffered` is empty and nothing
    // is a `flushAndClose` away, `channel` itself is just never explicitly closed yet), or, if
    // never committed, a genuine contract violation (every transport in this repo is supposed to
    // end with a terminal event as the last thing it emits, so buffered ending non-terminal here
    // should be unreachable) -- flushed rather than silently leaving every consumer's `for await`
    // loop hanging forever with no terminal event ever delivered.
    if (committed) channel.close();
    else flushAndClose(buffered);
  }

  async function run(): Promise<void> {
    let status: ProviderStatus;
    try {
      status = await detect(logger);
    } catch (error) {
      // detect() itself failed (e.g. the CLI vanished mid-probe): there is nothing left to decide
      // against, so fall back to the one transport that does its own, independent executable
      // discovery rather than failing the whole session over a status check.
      logger.warn('codex detect() failed while choosing a transport; falling back to the legacy exec transport', {
        sessionId: options.sessionId,
        error,
      });
      await runExecOnly();
      return;
    }
    if (cancelled) {
      channel.closeWith([{ type: 'session.cancelled' }]);
      return;
    }

    if (status.authSource === 'api_key') {
      await runExecOnly();
      return;
    }
    if (!status.executablePath) {
      await runExecOnly();
      return;
    }
    const compatible = findProviderCompatibility('codex', status.version, CODEX_APP_SERVER_TRANSPORT_ID);
    if (!compatible) {
      await runExecOnly();
      return;
    }

    await runAppServerWithFallback(status, status.executablePath);
  }

  void run().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : 'internal adapter error';
    channel.closeWith([
      { type: 'error', code: 'ADAPTER_CRASH', message, recoverable: false },
      { type: 'session.failed', message },
    ]);
  });

  return {
    events: channel[Symbol.asyncIterator](),
    cancel: async () => {
      cancelled = true;
      if (active) await active.cancel();
    },
  };
}
