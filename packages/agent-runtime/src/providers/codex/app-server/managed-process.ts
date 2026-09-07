import { spawnProcess } from '../../../process/spawn-process.js';
import { CodexAppServerProtocolError } from './errors.js';

export interface ManagedAppServerProcessOptions {
  executable: string;
  executableArgs?: readonly string[];
  cwd: string;
  env?: NodeJS.ProcessEnv;
  /** Test/embedding seam. Production resolves the helper relative to the daemon bundle. */
  windowsJobHostPath?: string;
  /** Test seam only. */
  platform?: NodeJS.Platform;
  onStdout(chunk: Buffer): void;
  onStdoutEnd(): void;
  onFailure(error: Error): void;
}

const MAX_STDERR_SUMMARIES = 128;

/**
 * Owns a single `codex app-server --stdio` process and never exposes raw stderr bytes.
 *
 * Unlike upstream AgentDock's equivalent class (which re-implements process spawning, Windows Job
 * Host routing, readiness-handshake parsing, and process-tree termination from scratch, ~340 lines
 * -- see the upstream clone's `providers/codex/app-server/managed-process.ts`), this repo already
 * has all of that in `process/spawn-process.ts`'s `spawnProcess()`, built for exactly this need (a
 * long-lived, cancellable, tree-reaped child process) and already exercised by every real provider
 * session today via `providers/common/run-session.ts`. This class is a thin adapter around it, not
 * a reimplementation.
 *
 * There is no `ready` promise or pre-ready-stdout-buffering, unlike upstream: reading
 * `AgentDock.JobHost.cs` directly confirms the provider process is created **suspended**
 * (`CREATE_SUSPENDED`) and is not resumed until *after* the `ADJH/1 READY <pid>` handshake is
 * written to stderr -- so no real provider stdout byte can exist before `spawnProcess()` returns a
 * live child in the first place. Upstream's readiness machinery guards a race that is structurally
 * impossible here, not a race this class chose to ignore.
 */
export class ManagedAppServerProcess {
  private readonly stderrSummaries: string[] = [];
  private readonly spawned: ReturnType<typeof spawnProcess>;
  private closing = false;
  private exited = false;

  constructor(private readonly options: ManagedAppServerProcessOptions) {
    const args = [...(options.executableArgs ?? []), 'app-server', '--stdio'];
    this.spawned = spawnProcess(options.executable, args, {
      cwd: options.cwd,
      env: options.env,
      windowsJobHostPath: options.windowsJobHostPath,
      platform: options.platform,
    });
    const { child, exit } = this.spawned;

    child.stdout.on('data', (chunk: Buffer | string) => {
      try {
        options.onStdout(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      } catch (error) {
        this.reportFailure(this.callbackError(error));
      }
    });
    child.stdout.once('end', () => {
      try {
        options.onStdoutEnd();
      } catch (error) {
        this.reportFailure(this.callbackError(error));
      }
    });
    child.stdout.once('error', (error: Error) => this.reportFailure(this.processError(error)));
    child.stdin.once('error', (error: Error) => this.reportFailure(this.processError(error)));
    // Without this listener, an 'error' on the raw POSIX stderr stream (the Windows path never
    // re-emits one -- see filterWindowsJobHostStderr) is an unhandled EventEmitter error, which
    // Node throws as an uncaught exception and crashes the whole daemon process rather than
    // routing through onFailure like every other I/O failure this class reports.
    child.stderr.once('error', (error: Error) => this.reportFailure(this.processError(error)));
    child.stderr.on('data', (chunk: Buffer | string) => this.redactStderr(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));

    void exit.then(({ code, signal }) => {
      this.exited = true;
      if (!this.closing) {
        this.reportFailure(new CodexAppServerProtocolError('process_failed', `Codex app-server exited unexpectedly (${signal ?? code ?? 'unknown'})`));
      }
    });
  }

  async write(frame: Buffer): Promise<void> {
    if (this.closing || this.exited || this.spawned.child.stdin.destroyed) {
      throw new CodexAppServerProtocolError('closed', 'app-server stdin is closed');
    }
    await new Promise<void>((resolve, reject) => {
      this.spawned.child.stdin.write(frame, (error) => {
        if (error) reject(this.processError(error));
        else resolve();
      });
    });
  }

  /** Ends stdin and waits for the full process tree to be confirmed reaped -- the same guarantee
   * every other provider session's cancellation already relies on (`spawnProcess()`'s `kill()`). */
  async close(): Promise<void> {
    this.closing = true;
    if (!this.spawned.child.stdin.destroyed) this.spawned.child.stdin.end();
    await this.spawned.kill();
  }

  async forceClose(): Promise<void> {
    this.closing = true;
    await this.spawned.kill();
  }

  /** Bounded, redacted-only summaries of stderr activity -- never provider text that could carry
   * credentials or prompt content, see `redactStderr` -- for diagnostics only. */
  get stderrSummary(): readonly string[] {
    return this.stderrSummaries;
  }

  private redactStderr(chunk: Buffer): void {
    if (this.stderrSummaries.length >= MAX_STDERR_SUMMARIES) this.stderrSummaries.shift();
    // Preserve only a bounded fact, never provider text that could contain credentials/prompts.
    this.stderrSummaries.push(`Codex app-server stderr redacted (${chunk.byteLength} bytes)`);
  }

  private reportFailure(error: Error): void {
    if (!this.closing) this.options.onFailure(error);
  }

  private processError(error: Error): CodexAppServerProtocolError {
    const code = (error as NodeJS.ErrnoException).code;
    return new CodexAppServerProtocolError('process_failed', `Codex app-server process I/O failed (${code ?? 'unknown'})`);
  }

  private callbackError(error: unknown): CodexAppServerProtocolError {
    return error instanceof CodexAppServerProtocolError ? error : new CodexAppServerProtocolError('frame_invalid', 'App-server stream handling failed');
  }
}
