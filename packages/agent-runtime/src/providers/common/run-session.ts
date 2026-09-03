import { existsSync, statSync } from 'node:fs';
import type { AgentEvent, ProviderId } from '@agent-dock/shared';
import { AsyncChannel } from '../../process/async-channel.js';
import { readLines } from '../../process/line-reader.js';
import { spawnProcess } from '../../process/spawn-process.js';
import { findExecutable } from '../../detect-executable.js';
import type { Logger } from '../../logger.js';
import type { ProviderSessionHandle, StartSessionOptions } from '../../types.js';
import { checkProviderFrameBounds, PROVIDER_FRAME_BOUNDS } from './unknown-frames.js';

export interface ParsedLine {
  events: AgentEvent[];
  providerSessionId?: string;
  /**
   * Set by a parser whose `default:` branch was reached, i.e. the provider emitted an event type
   * this repo does not model. Purely diagnostic: it does not change `events` (which stays empty,
   * exactly as before ADI-04) and never reaches an `AgentEvent`. `runProviderSession` forwards it
   * to `StartSessionOptions.launchProbe` when a supervisor is attached, and ignores it otherwise.
   */
  unrecognized?: { eventType: string };
}

export interface ProviderRunConfig {
  providerId: ProviderId;
  executableNames: string[];
  buildArgs(options: StartSessionOptions): string[];
  parseLine(raw: unknown, logger: Logger): ParsedLine;
  describeFailure?(stderr: string, code: number | null, signal: NodeJS.Signals | null): string;
  /**
   * When true, the prompt is written to the child's stdin instead of appearing anywhere in argv
   * (AD-05): set by an adapter whose CLI supports reading its prompt from stdin. Adapters that
   * don't set this keep the previous behavior (`buildArgs` embeds the prompt itself; stdin is
   * closed immediately with nothing written).
   */
  promptViaStdin?: boolean;
}

/**
 * Shared spawn/parse/normalize skeleton used by every provider adapter: validates the working
 * directory, resolves the executable, spawns it with an argv array (never a shell string), turns
 * stdout into normalized AgentEvents via the provider's parseLine, and always terminates the
 * event stream with exactly one of session.completed / session.failed / session.cancelled.
 */
export function runProviderSession(
  config: ProviderRunConfig,
  options: StartSessionOptions,
  logger: Logger,
): ProviderSessionHandle {
  const channel = new AsyncChannel<AgentEvent>();
  let spawned: ReturnType<typeof spawnProcess> | undefined;
  let cancelled = false;

  /**
   * ADI-04's observation seam. `undefined` for every v1 caller, and every use below is guarded by
   * that, so an unsupervised session executes exactly the code path it did before this ticket —
   * including skipping the frame bounds check, which is the only added per-line work.
   *
   * A probe callback is an observer, so it is never allowed to affect the session it observes: a
   * throwing callback is swallowed and logged at debug rather than propagated into `run()`, where
   * it would surface to the user as a spurious ADAPTER_CRASH.
   */
  const probe = options.launchProbe;
  function notify(fn: (() => void) | undefined): void {
    if (!fn) return;
    try {
      fn();
    } catch {
      logger.debug(`${config.providerId}: launch probe callback threw`);
    }
  }

  /**
   * Enqueues an EVENT_OVERFLOW error followed by session.failed, bypassing the channel's normal
   * cap (see AsyncChannel.closeWith), the fix for AD-10: an overflowed channel must still
   * deliver exactly one terminal event, not silently strand every subscriber in "running".
   */
  function closeWithOverflow(): void {
    channel.closeWith([
      { type: 'error', code: 'EVENT_OVERFLOW', message: 'session event buffer overflowed', recoverable: false },
      { type: 'session.failed', message: 'session event buffer overflowed' },
    ]);
  }

  async function run() {
    if (!channel.push({ type: 'session.started', sessionId: options.sessionId, provider: config.providerId })) {
      closeWithOverflow();
      return;
    }

    if (!existsSync(options.cwd) || !statSync(options.cwd).isDirectory()) {
      channel.closeWith([
        {
          type: 'error',
          code: 'INVALID_CWD',
          message: `working directory does not exist: ${options.cwd}`,
          recoverable: false,
        },
        { type: 'session.failed', message: 'invalid working directory' },
      ]);
      return;
    }

    const exePath = await findExecutable(config.executableNames);
    if (!exePath) {
      channel.closeWith([
        {
          type: 'error',
          code: 'PROVIDER_NOT_INSTALLED',
          message: `${config.executableNames[0]} executable not found on this machine`,
          recoverable: false,
        },
        { type: 'session.failed', message: 'provider executable not found' },
      ]);
      return;
    }

    if (cancelled) {
      channel.closeWith([{ type: 'session.cancelled' }]);
      return;
    }

    const args = config.buildArgs(options);
    logger.info(`${config.providerId}: starting session`, { sessionId: options.sessionId });
    // Fired before the process exists, and only after cwd + executable validation have passed, so
    // it marks exactly the moment an argv-embedded prompt (Codex) stops being provably undelivered.
    // Reports this call's own promptViaStdin flag as ground truth -- see SessionLaunchProbe's doc
    // comment on why the caller must not have to separately track or assume it.
    notify(() => probe?.onSpawnAttempt?.({ viaStdin: config.promptViaStdin === true }));
    try {
      // `options.env` is undefined at every caller (see StartSessionOptions.env). Since ADI-15 that
      // means the child gets `buildProviderEnvironment(process.env)` rather than `process.env`
      // itself; passing an env here would select what gets filtered, not bypass the filter.
      spawned = spawnProcess(exePath, args, { cwd: options.cwd, env: options.env });
    } catch (err) {
      // A synchronous spawn throw proves no process was created, so the prompt provably never
      // reached one. Re-thrown unchanged: the existing `run().catch` turns it into the same
      // ADAPTER_CRASH events it always did.
      notify(probe?.onSpawnFailed);
      throw err;
    }
    // AD-05: when the adapter supports it, the prompt travels over stdin rather than argv. See
    // ProviderRunConfig.promptViaStdin and build-args.ts for why. `.write()` followed immediately
    // by `.end()` is safe and standard: Node buffers and flushes the write before actually
    // closing the stream, no explicit wait needed here, and preserves the string exactly
    // (spaces, quotes, newlines, unicode) since it's a plain UTF-8 write, not shell-parsed.
    if (config.promptViaStdin) {
      spawned.child.stdin.write(options.prompt, 'utf8');
      // Fired after the write call, which is the point at which the bytes are irrevocably queued
      // for the child: Node buffers and flushes them without further action from us, and there is
      // no later observable moment (no per-write ack from the CLI) to wait for.
      notify(probe?.onPromptDelivered);
    }
    spawned.child.stdin.end();

    let providerSessionId: string | undefined;
    const stderrChunks: string[] = [];
    let stderrBytes = 0;
    spawned.child.stderr.on('data', (chunk: Buffer) => {
      if (stderrBytes < 200_000) {
        stderrChunks.push(chunk.toString('utf8'));
        stderrBytes += chunk.length;
      }
    });

    let overflowed = false;
    try {
      for await (const line of readLines(spawned.child.stdout)) {
        // A cheap byte-length check on the raw line, before the more expensive shape/depth walk
        // inside `checkProviderFrameBounds` runs: a frame between `PROVIDER_FRAME_BOUNDS.maxBytes`
        // and `readLines`'s own much larger hard line cap is already known to be a violation from
        // its raw length alone, so there's no need to pay for `validateJsonBounds`'s recursive walk
        // (which itself re-serializes the value via `JSON.stringify` as its final check) just to
        // re-derive a fact `Buffer.byteLength` on the unparsed string already tells us for free.
        // `raw` is still parsed and still handed to `parseLine` exactly as before: only the
        // redundant re-validation of an already-known oversized frame is skipped, so no emitted
        // event changes for a session that happens to be supervised.
        const lineOversized = Buffer.byteLength(line, 'utf8') > PROVIDER_FRAME_BOUNDS.maxBytes;
        let raw: unknown;
        try {
          raw = JSON.parse(line);
        } catch {
          logger.debug(`${config.providerId}: skipped unparseable line`);
          if (probe?.onUnknownFrame) notify(() => probe.onUnknownFrame!('unparseable_line', line));
          continue;
        }
        if (probe?.onUnknownFrame) {
          // Observation only, deliberately placed *before* parseLine and with no `continue`: a
          // frame that is oversized or non-object is still handed to the parser exactly as it was
          // pre-ADI-04, so no emitted event changes. The supervisor learns about it; the session
          // does not behave differently because of it.
          if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
            notify(() => probe.onUnknownFrame!('non_object_frame', line));
          } else if (lineOversized) {
            notify(() =>
              probe.onUnknownFrame!(
                'frame_bounds_exceeded',
                line,
                undefined,
                `encoded JSON exceeds ${PROVIDER_FRAME_BOUNDS.maxBytes} bytes`,
              ),
            );
          } else {
            const violation = checkProviderFrameBounds(raw);
            if (violation) notify(() => probe.onUnknownFrame!('frame_bounds_exceeded', line, undefined, violation));
          }
        }
        const parsed = config.parseLine(raw, logger);
        if (parsed.unrecognized && probe?.onUnknownFrame) {
          const eventType = parsed.unrecognized.eventType;
          notify(() => probe.onUnknownFrame!('unrecognized_event_type', line, eventType));
        }
        if (parsed.providerSessionId) providerSessionId = parsed.providerSessionId;
        for (const event of parsed.events) {
          if (!channel.push(event)) {
            overflowed = true;
            break;
          }
        }
        if (overflowed) break;
      }
    } catch (err) {
      channel.push({
        type: 'error',
        code: 'STREAM_READ_FAILED',
        message: `failed reading ${config.providerId} output: ${(err as Error).message}`,
        recoverable: false,
      });
    }

    if (overflowed) {
      // Awaited (ADI-04): `kill()` now resolves only once the whole owned tree is confirmed gone.
      // A rejection here must not replace the EVENT_OVERFLOW terminal events with an ADAPTER_CRASH,
      // so it is logged and swallowed — the overflow is the user-relevant failure, not the reap.
      await spawned.kill().catch((err: unknown) => {
        logger.warn(`${config.providerId}: process tree reap failed after event overflow`, {
          message: (err as Error).message,
        });
      });
      closeWithOverflow();
      return;
    }

    const { code, signal } = await spawned.exit;
    logger.info(`${config.providerId}: process exited`, { sessionId: options.sessionId, code, signal });

    if (cancelled) {
      channel.closeWith([{ type: 'session.cancelled' }]);
    } else if (code === 0) {
      channel.closeWith([{ type: 'session.completed', providerSessionId }]);
    } else {
      const stderrText = stderrChunks.join('');
      if (stderrText.trim()) {
        // Bounded and at warn (shown by default): a session failure with no visible reason is
        // unusable for debugging. This is the CLI's own diagnostic output, not daemon secrets.
        // Still capped, since we can't guarantee a third-party CLI never echoes something
        // sensitive to stderr.
        logger.warn(`${config.providerId}: process exited non-zero`, {
          sessionId: options.sessionId,
          code,
          signal,
          stderrSnippet: stderrText.slice(0, 2000),
        });
      }
      const message = config.describeFailure?.(stderrText, code, signal) ?? defaultFailureMessage(config.providerId, stderrText, code, signal);
      channel.closeWith([
        { type: 'error', code: 'PROCESS_EXIT', message, recoverable: false },
        { type: 'session.failed', message },
      ]);
    }
  }

  run().catch((err) => {
    logger.error(`${config.providerId}: adapter crashed`, { message: (err as Error).message });
    channel.closeWith([
      { type: 'error', code: 'ADAPTER_CRASH', message: 'internal adapter error', recoverable: false },
      { type: 'session.failed', message: 'internal adapter error' },
    ]);
  });

  return {
    events: channel[Symbol.asyncIterator](),
    cancel: async () => {
      cancelled = true;
      // Awaited rather than fire-and-forget (ADI-04). Before this, `cancel()` resolved as soon as
      // a signal had been *sent*, so a caller that immediately cleaned up the working directory
      // was racing a still-running process tree. `kill()` now resolves only on confirmed reap and
      // rejects on a reap timeout; that rejection is propagated rather than swallowed, because
      // "cancelled, but we cannot prove anything is dead" is not a success.
      await spawned?.kill();
    },
  };
}

/**
 * Falls back to this when an adapter doesn't provide its own `describeFailure`. A bare "exited
 * with code 1" tells a developer nothing actionable: include a short stderr snippet so a session
 * failure is debuggable without needing to run the daemon with debug logging just to see why.
 */
function defaultFailureMessage(
  providerId: string,
  stderr: string,
  code: number | null,
  signal: NodeJS.Signals | null,
): string {
  const base = `${providerId} exited with code ${code ?? 'null'}${signal ? ` (signal ${signal})` : ''}`;
  const snippet = stderr.trim().slice(0, 500);
  return snippet ? `${base}: ${snippet}` : base;
}
