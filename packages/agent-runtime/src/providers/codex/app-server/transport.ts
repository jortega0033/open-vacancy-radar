import type { AgentEvent, AuthSource } from '@agent-dock/shared';
import { overflowTerminalEvents, TERMINAL_AGENT_EVENT_TYPES } from '../../common/agent-event-terminal.js';
import { AsyncChannel } from '../../../process/async-channel.js';
import type { ProviderSessionHandle, SessionLaunchProbe } from '../../../types.js';
import { asObject, CodexAppServerProtocolError } from './errors.js';
import { ManagedAppServerProcess } from './managed-process.js';
import { CodexAppServerRpc } from './rpc.js';
import { CodexAppServerNormalizer } from './normalizer.js';
import { parseCodexModelCatalog, resolveCodexSelectedModel } from './scope-evidence.js';
import { deferred } from './deferred.js';

export interface CodexAppServerTransportOptions {
  sessionId: string;
  executable: string;
  executableArgs?: readonly string[];
  cwd: string;
  prompt: string;
  env?: NodeJS.ProcessEnv;
  /** A prior turn's provider-native thread id to resume, if the caller has one. */
  resumeProviderSessionId?: string;
  /** One of the provider's `availableModels`. Absent means resolve the CLI's own single default. */
  model?: string;
  /** Only used by scope-probe.ts today; kept here for a later stage that may want to re-verify
   * account identity inline. Currently unused by this transport's own lifecycle. */
  detectedAuthSource?: AuthSource;
  /** Test seam only. */
  windowsJobHostPath?: string;
  /** Test seam only. */
  processPlatform?: NodeJS.Platform;
  /**
   * Only `onPromptDelivered` is wired -- narrowed from the full `SessionLaunchProbe` shape rather
   * than accepting all of it, because the other callbacks don't mean anything for this transport.
   * `onSpawnAttempt` exists to mark accepted-work the instant an argv-embedded prompt hands itself
   * over atomically at process creation (see `types.ts`'s own doc comment); spawning the app-server
   * *process* carries no prompt content at all here, so firing it would be actively misleading, not
   * merely unused. `onUnknownFrame` is about the exec transport's line-based JSONL parsing
   * (`parser.ts`); this transport's protocol violations already surface as a proper `AgentEvent`
   * (`PROTOCOL_VIOLATION`), so there is nothing for it to report.
   *
   * `onPromptDelivered` fires immediately before the `turn/start` request is written -- the exact
   * `'turn-start-write-attempt'` boundary `compatibility-manifest.ts` documents (ADI-08 stage 6) as
   * this transport's accepted-work line: everything up through a successful `thread/start` is
   * provably retryable, and this is the one moment after which that stops being true. ADI-08 stage 7
   * (`transport-selection.ts`) is what actually consumes this, to decide whether an app-server
   * startup failure is still safe to retry over the legacy exec transport.
   */
  launchProbe?: Pick<SessionLaunchProbe, 'onPromptDelivered'>;
}

/**
 * Fixed, non-negotiable turn policy for every session this transport drives -- not a
 * caller-configurable option, matching this repo's one-prompt-in/events-out design (see the
 * central architectural decision recorded on issue #126's staged-plan comment: this transport
 * produces the same plain `AgentEvent` stream the legacy exec transport does, with no mid-turn
 * interactive surface for a human to answer a real approval prompt through).
 *
 * `sandbox: 'workspace-write'` matches the exec transport's own real behavior as closely as
 * verifiable: `providers/codex/build-args.ts` passes no explicit `--sandbox` flag, relying on
 * `codex exec`'s own undeclared default, which is `workspace-write` for a coding agent. This repo
 * makes NO independent claim of sandbox enforcement here -- it relies entirely on Codex's own
 * sandboxing and does not itself verify network/writable-root restriction. This is a real,
 * deliberate relaxation from this transport's original design goal, recorded explicitly here (and
 * in docs/providers.md's AD-21 section once this port ships) rather than left implicit.
 *
 * `approvalPolicy: 'never'` tells Codex itself never to block a turn waiting for human approval.
 * Any approval/elicitation request that still arrives despite this (see `onRequest` below) is
 * auto-denied -- fail-closed, never auto-approved -- since nothing here can meaningfully answer one.
 *
 * A known, currently open gap: the exec transport hardcodes `--ignore-user-config`
 * (`providers/codex/build-args.ts`'s `CODEX_IGNORE_USER_CONFIG_ARG`) so a session can't be
 * silently reconfigured by whatever `$CODEX_HOME/config.toml` happens to say. Nothing here does
 * the equivalent for `codex app-server --stdio` -- upstream AgentDock's own app-server invocation
 * doesn't either, and there is no way to confirm from the vendored schema alone whether an
 * app-server-specific flag or config override even exists for this. Left as an explicit, recorded
 * gap rather than a guessed, untested flag added on spec; revisit once real-CLI verification
 * (this dev environment cannot run an authenticated `codex` install -- see ADI-19's own live-smoke
 * harness for the same constraint) confirms what's actually available.
 */
const FIXED_SANDBOX = 'workspace-write';
const FIXED_APPROVAL_POLICY = 'never';

/** How long `cancel()` waits for the interrupted turn's own `turn/completed` notification to
 * arrive naturally before it gives up and closes the session itself. Bounded so `cancel()` can
 * never hang indefinitely on a process that stops responding after acknowledging the interrupt. */
const CANCEL_TERMINAL_WAIT_MS = 5_000;

function extractThreadId(result: unknown): string {
  const thread = asObject(asObject(result, 'thread start/resume response').thread, 'thread');
  if (typeof thread.id !== 'string' || thread.id.length === 0) {
    throw new CodexAppServerProtocolError('frame_invalid', 'thread start/resume response has no valid thread id');
  }
  return thread.id;
}

function extractTurnId(result: unknown): string {
  const turn = asObject(asObject(result, 'turn/start response').turn, 'turn');
  if (typeof turn.id !== 'string' || turn.id.length === 0) {
    throw new CodexAppServerProtocolError('frame_invalid', 'turn/start response has no valid turn id');
  }
  return turn.id;
}

/**
 * Drives one real Codex app-server session end to end and produces a `ProviderSessionHandle` --
 * the same contract every other provider transport satisfies (`packages/agent-runtime/src/
 * types.ts`), not upstream's richer `InteractiveProviderTransport`. Internally this manages a
 * long-lived JSON-RPC connection (Stages 1-4), but externally it looks exactly like "start one
 * session, get one `AsyncGenerator<AgentEvent>`, call `cancel()`" -- one process per session,
 * matching the daemon's existing lifecycle and workspace-lease model exactly.
 */
export function createCodexAppServerTransport(options: CodexAppServerTransportOptions): ProviderSessionHandle {
  const channel = new AsyncChannel<AgentEvent>();
  const normalizer = new CodexAppServerNormalizer();
  const terminalDeferred = deferred<void>();

  let cancelled = false;
  let terminalEmitted = false;
  let managedProcess: ManagedAppServerProcess | undefined;
  let rpc: CodexAppServerRpc | undefined;
  let threadId: string | undefined;
  let turnId: string | undefined;

  /** The single place any code path ends the session. Idempotent: only the first caller's events
   * are delivered, matching `AsyncChannel.closeWith`'s own "exactly one terminal event" guarantee. */
  function finish(events: AgentEvent[]): void {
    if (terminalEmitted) return;
    terminalEmitted = true;
    channel.closeWith(events);
    terminalDeferred.resolve();
  }

  function closeWithOverflow(): void {
    finish(overflowTerminalEvents());
  }

  async function run(): Promise<void> {
    if (!channel.push({ type: 'session.started', sessionId: options.sessionId, provider: 'codex' })) {
      closeWithOverflow();
      return;
    }

    const rpcRef: { current?: CodexAppServerRpc } = {};
    managedProcess = new ManagedAppServerProcess({
      executable: options.executable,
      executableArgs: options.executableArgs,
      cwd: options.cwd,
      env: options.env,
      platform: options.processPlatform,
      windowsJobHostPath: options.windowsJobHostPath,
      onStdout: (chunk) => rpcRef.current?.acceptStdout(chunk),
      onStdoutEnd: () => rpcRef.current?.endStdout(),
      onFailure: (error) => {
        // finish() first, then rpc.fail(): finish() is idempotent (first caller wins), and
        // rpc.fail() itself synchronously calls this rpc's onFatal callback below (to reject any
        // still-pending request), which also calls finish() -- with PROTOCOL_VIOLATION. Calling
        // rpc.fail() first would let that second, less accurate finish() win the race, mislabeling
        // an ordinary process crash as a protocol violation. Order here is what makes
        // PROCESS_FAILED the code callers actually see for this path.
        finish([
          { type: 'error', code: 'PROCESS_FAILED', message: error.message, recoverable: false },
          { type: 'session.failed', message: error.message },
        ]);
        // Also fails the RPC itself, not just the transport-level session: without this, a request
        // still awaiting a response when the process dies (e.g. cancel()'s own forced teardown
        // racing an in-flight thread/start) never settles -- rpc.ts's Deferred for that request sits
        // forever unresolved, and run()'s corresponding `await rpc.request(...)` never returns, so
        // it never reaches its `finally` block to call rpc.shutdown(). endStdout() alone does not
        // cover this: it only fails the RPC when a partial frame was buffered, which is not the
        // common case for a killed process (a clean EOF with nothing partial buffered is a no-op
        // there). Uses rpcRef, not the outer `rpc` variable: this callback can fire before the
        // CodexAppServerRpc below has even been constructed (a very early process failure), so the
        // outer variable may still be unassigned at that moment.
        rpcRef.current?.fail(error);
      },
    });
    rpc = new CodexAppServerRpc({
      write: (frame) => managedProcess!.write(frame),
      onNotification: (method, params) => {
        if (terminalEmitted) return;
        let events: AgentEvent[];
        try {
          events = normalizer.normalize(method, params);
        } catch (error) {
          const message = error instanceof Error ? error.message : 'Codex app-server notification could not be normalized';
          finish([
            { type: 'error', code: 'PROTOCOL_VIOLATION', message, recoverable: false },
            { type: 'session.failed', message },
          ]);
          return;
        }
        const terminalIndex = events.findIndex((event) => TERMINAL_AGENT_EVENT_TYPES.has(event.type));
        const deliverable = terminalIndex === -1 ? events : events.slice(0, terminalIndex);
        for (const event of deliverable) {
          if (!channel.push(event)) {
            closeWithOverflow();
            return;
          }
        }
        if (terminalIndex !== -1) finish(events.slice(terminalIndex));
      },
      // approvalPolicy: 'never' means Codex should not send these in practice; if one still
      // arrives, deny it rather than leave it (and the turn behind it) hanging forever.
      onRequest: (request) => {
        void request.reject(-32000, 'automatically denied: no human approval is available for this session').catch(() => undefined);
      },
      onFatal: (error) => finish([
        { type: 'error', code: 'PROTOCOL_VIOLATION', message: error.message, recoverable: false },
        { type: 'session.failed', message: error.message },
      ]),
    });
    rpcRef.current = rpc;

    try {
      await rpc.request('initialize', { clientInfo: { name: 'agent_dock', title: 'Agent Dock', version: '0.1.0' }, capabilities: null });
      await rpc.notify('initialized');

      const catalog = parseCodexModelCatalog(await rpc.request('model/list', { limit: 1_024, includeHidden: false }));
      const selectedModel = resolveCodexSelectedModel(catalog, options.model);

      if (cancelled) {
        finish([{ type: 'session.cancelled' }]);
        return;
      }

      const threadResult = options.resumeProviderSessionId
        ? await rpc.request('thread/resume', {
            threadId: options.resumeProviderSessionId,
            model: selectedModel,
            sandbox: FIXED_SANDBOX,
            approvalPolicy: FIXED_APPROVAL_POLICY,
          })
        : await rpc.request('thread/start', {
            cwd: options.cwd,
            model: selectedModel,
            sandbox: FIXED_SANDBOX,
            approvalPolicy: FIXED_APPROVAL_POLICY,
          });
      threadId = extractThreadId(threadResult);
      normalizer.setProviderSessionId(threadId);

      if (cancelled) {
        finish([{ type: 'session.cancelled' }]);
        return;
      }

      const turnResult = await rpc.request(
        'turn/start',
        { threadId, input: [{ type: 'text', text: options.prompt }] },
        () => options.launchProbe?.onPromptDelivered?.(),
      );
      turnId = extractTurnId(turnResult);

      // cancel() may have already run and given up on sending turn/interrupt, because turnId was
      // still undefined at the moment it checked (a cancellation that races the in-flight
      // turn/start request above). turnId is known now, so this is the one remaining chance to ask
      // Codex to stop gracefully instead of falling through to cancel()'s own forced-kill fallback.
      if (cancelled) {
        await rpc.request('turn/interrupt', { threadId, turnId }).catch(() => undefined);
      }

      // From here, the terminal event is delivered entirely by the onNotification handler above,
      // driven by turn/completed once Codex actually finishes (or the interrupt above, or cancel()
      // below, ends it).
      await terminalDeferred.promise;
    } catch (error) {
      const message = error instanceof Error ? error.message : 'internal adapter error';
      finish([
        { type: 'error', code: 'ADAPTER_CRASH', message, recoverable: false },
        { type: 'session.failed', message },
      ]);
    } finally {
      rpc.shutdown();
      await managedProcess.close().catch(() => undefined);
    }
  }

  run().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : 'internal adapter error';
    finish([
      { type: 'error', code: 'ADAPTER_CRASH', message, recoverable: false },
      { type: 'session.failed', message },
    ]);
  });

  return {
    events: channel[Symbol.asyncIterator](),
    cancel: async () => {
      cancelled = true;
      if (!terminalEmitted) {
        // Both the turn/interrupt request itself and the subsequent wait for its confirmation
        // notification are bounded by ONE shared CANCEL_TERMINAL_WAIT_MS deadline, not two
        // sequential ones: `rpc.request()` has no timeout of its own, so an app-server that never
        // answers turn/interrupt would otherwise hang this whole function forever, well before ever
        // reaching the deferred-wait race below it used to be bounded by. That was a real deadlock,
        // not a hypothetical -- the fixture-driven regression test for it is what found this.
        const timedOut = new Promise<'timed-out'>((resolve) => setTimeout(() => resolve('timed-out'), CANCEL_TERMINAL_WAIT_MS));
        const waitForGracefulEnd = (async () => {
          if (rpc && threadId && turnId) {
            await rpc.request('turn/interrupt', { threadId, turnId }).catch(() => undefined);
          }
          await terminalDeferred.promise;
        })();
        await Promise.race([waitForGracefulEnd, timedOut]);
      }
      // Authoritative fallback: whether the interrupt's own confirmation notification made it
      // through in time or not, the session must end in session.cancelled once cancel() has been
      // called -- finish() is a no-op if the notification path already closed it first.
      finish([{ type: 'session.cancelled' }]);
      await managedProcess?.close().catch(() => undefined);
    },
  };
}
