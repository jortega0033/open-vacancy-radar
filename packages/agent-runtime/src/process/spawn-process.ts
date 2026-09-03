import { spawn } from 'node:child_process';
import type { ChildProcessByStdio } from 'node:child_process';
import { PassThrough } from 'node:stream';
import type { Readable, Writable } from 'node:stream';
import { buildProviderEnvironment } from '../providers/common/provider-environment.js';
import { encodeWindowsJobHostArguments, resolveWindowsJobHostPath } from './windows-job-host.js';

export interface ProcessExitResult {
  code: number | null;
  signal: NodeJS.Signals | null;
}

/**
 * The subset of a child process this package actually uses. Introduced by ADI-04 because the
 * Windows path no longer hands back Node's raw `ChildProcess`: its `stderr` is wrapped to strip
 * the Job Host handshake line. Structurally satisfied by `ChildProcessByStdio`, so the POSIX path
 * still returns the real child unchanged and no caller needed to change.
 */
export interface SpawnedProcess {
  stdin: Writable;
  stdout: Readable;
  stderr: Readable;
  pid?: number;
  kill(signal?: NodeJS.Signals | number): boolean;
}

type NativeProcess = ChildProcessByStdio<Writable, Readable, Readable>;

/** Outer bound on a full terminate-and-confirm cycle. Kept well under a caller's own cancel budget. */
const TREE_TERMINATION_TIMEOUT_MS = 4_000;
/** How long a POSIX group gets to handle SIGTERM before SIGKILL. */
const POSIX_GRACE_MS = 250;
const PROCESS_GROUP_POLL_MS = 25;
/** A valid handshake is ~24 bytes. This ceiling exists to bound a *malformed* one. */
const MAX_WINDOWS_HANDSHAKE_BYTES = 512;

export interface TerminateProcessTreeOptions {
  platform?: NodeJS.Platform;
  timeoutMs?: number;
}

export interface SpawnResult {
  child: SpawnedProcess;
  exit: Promise<ProcessExitResult>;
  /**
   * Kills the complete owned process tree and resolves only after it is **confirmed** reaped.
   * Idempotent: concurrent and repeated calls all receive the same promise, so a cancel racing a
   * timeout cannot start two termination sequences against the same pid.
   */
  kill: () => Promise<void>;
}

export interface SpawnOptions {
  cwd: string;
  /**
   * The environment to **filter**, not the environment to use. Defaults to `process.env`.
   *
   * ADI-15 changed what this field means, and the change is deliberate. It used to be a full
   * replacement (`env: opts.env ?? process.env`), which made the safe default depend on every call
   * site remembering to pass something -- and no call site ever did, so every provider child
   * inherited the daemon's entire environment. Whatever is supplied here now goes through
   * `buildProviderEnvironment` on its way to the child, so there is exactly one place the policy is
   * decided and no argument a caller can pass that escapes it.
   *
   * There is no opt-out, because there is no caller that needs one: every use of `spawnProcess` in
   * this repo is a provider CLI or a `where`/`which` lookup performed on behalf of one (see
   * `detect-executable.ts`, `exec-capture.ts`, `run-session.ts`). A future non-provider caller
   * wanting a different environment should get its own reviewed policy, not a flag that turns this
   * one off.
   *
   * **The filter is by name, so the values passed here are trusted.** Supplying an env cannot smuggle
   * an unlisted *variable* through, but it fully controls the values of the listed ones -- and
   * `PATH`, `CLAUDE_CONFIG_DIR`, `CODEX_HOME`, `NODE_EXTRA_CA_CERTS`, `SSL_CERT_FILE` and the proxy
   * variables are respectively code execution in the child, redirection of the CLI's credential
   * directory, TLS trust, and traffic interception. Nothing populates this field today (it is
   * `undefined` at every call site, and no wire schema carries an env field), and it must never be
   * populated from a client-supplied or workspace-supplied source. Said explicitly because the
   * sentence above -- "no argument a caller can pass that escapes it" -- is true of names only, and
   * is otherwise easy to read as a broader assurance than it is.
   */
  env?: NodeJS.ProcessEnv;
  /** Test/embedding seam. Production resolves the helper relative to the daemon bundle. */
  windowsJobHostPath?: string;
  /** Test seam only. */
  platform?: NodeJS.Platform;
  /**
   * Set `false` to bypass the Windows Job Host entirely and spawn directly, even on win32.
   * Defaults to `true` (used) for every real provider session, which is what needs process-tree
   * cancellation.
   *
   * The Job Host requires `command` to already be an absolute, rooted path (see
   * `AgentDock.JobHost.cs`'s `Path.IsPathRooted` check) -- it does not perform its own PATH search.
   * `execCapture` uses this to run short-lived utility commands like `where`/`which` with a bare
   * command name specifically so the OS resolves it via PATH, which is the whole point of calling
   * them. Routing that through the Job Host would require already knowing the absolute path of the
   * very thing being looked up -- and did, until this option was added: every Windows provider
   * detection call silently failed except for a fixed, narrow set of hardcoded fallback
   * directories, since `where`/`which` themselves could no longer run. Short utility commands don't
   * need process-tree protection in the first place (they're bounded by `execCapture`'s own timeout
   * and don't legitimately spawn a tree of their own), so bypassing the host for them costs nothing.
   */
  useJobHostOnWindows?: boolean;
}

async function bounded<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(message)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function remainingMs(deadlineMs: number): number {
  return Math.max(0, deadlineMs - Date.now());
}

/**
 * Every wait in a termination sequence shares one absolute deadline rather than getting its own
 * fresh timeout. Otherwise a three-stage kill with a "4s timeout" could legitimately take 12s,
 * and the caller's own cancel budget would be blown by a mechanism that reported success.
 */
async function boundedUntil<T>(promise: Promise<T>, deadlineMs: number, message: string): Promise<T> {
  return bounded(promise, remainingMs(deadlineMs), message);
}

/**
 * Terminates a provider's whole owned process tree and does not resolve until it is gone.
 *
 * The two platforms need genuinely different mechanisms, not one mechanism with a flag:
 *
 * **POSIX** — the child was spawned `detached`, making it the leader of its own process group, so
 * signalling `-pid` reaches every descendant regardless of intermediate exits. SIGTERM first (a
 * CLI may need to flush or clean up), then SIGKILL after a short grace period. Crucially, the
 * sequence does not end at `await exit`: a leader's exit says nothing about its group, so the
 * group is then *polled* with `kill(-pid, 0)` until it reports `ESRCH`. That poll is the actual
 * guarantee this function's contract rests on.
 *
 * **Windows** — there is no such group, and `taskkill /T` walks the live parent-PID chain, which
 * cannot reach a grandchild whose intermediate parent already exited (see
 * `test/spawn-process.test.ts`'s negative control, which demonstrates exactly that failure). So on
 * Windows the direct child is not the provider at all: it is the shipped Job Host, which holds the
 * only handle to an unnamed Job Object created with `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE` and
 * containing the provider. Killing the host closes that handle, and the kernel terminates every
 * job member atomically — including orphans. So `child.kill()` plus a confirmed host exit *is* the
 * whole-tree guarantee here, with no descendant enumeration needed or possible.
 */
export async function terminateProcessTree(
  child: SpawnedProcess,
  exit: Promise<ProcessExitResult>,
  isExited: () => boolean,
  options: TerminateProcessTreeOptions = {},
): Promise<void> {
  const deadlineMs = Date.now() + (options.timeoutMs ?? TREE_TERMINATION_TIMEOUT_MS);
  const platform = options.platform ?? process.platform;
  const pid = child.pid;

  if (platform === 'win32') {
    if (pid === undefined) throw new Error('Windows provider Job Host has no process id');
    // The host lives *outside* its own job and owns its only handle, so Windows closes that handle
    // as part of tearing the host down and does not report the host exited until it has. Waiting
    // on the host's exit is therefore already a wait on the job being emptied.
    if (!isExited()) child.kill('SIGKILL');
    await boundedUntil(exit, deadlineMs, 'Windows provider Job Host could not be confirmed reaped');
    return;
  }

  // Note the absence of an early return on `isExited()`: a naturally-exited leader can still have
  // a live detached group behind it, which is the entire orphan scenario. Only a child with no pid
  // at all (spawn never happened) has nothing left to verify.
  if (isExited() && pid === undefined) return;

  if (pid !== undefined) {
    try {
      process.kill(-pid, 'SIGTERM');
    } catch {
      child.kill('SIGTERM');
    }
  } else {
    child.kill('SIGTERM');
  }
  if (!isExited()) {
    await new Promise<void>((resolve) => setTimeout(resolve, POSIX_GRACE_MS));
  }
  if (pid !== undefined) {
    try {
      process.kill(-pid, 'SIGKILL');
    } catch {
      if (!isExited()) child.kill('SIGKILL');
    }
  } else if (!isExited()) {
    child.kill('SIGKILL');
  }
  try {
    await boundedUntil(exit, deadlineMs, 'provider process could not be confirmed reaped');
  } catch {
    if (!isExited()) child.kill('SIGKILL');
    await boundedUntil(exit, deadlineMs, 'provider process could not be confirmed reaped');
  }
  if (pid !== undefined && !(await waitForProcessGroupGone(pid, deadlineMs))) {
    throw new Error('POSIX provider process group could not be confirmed reaped');
  }
}

function processGroupExists(pid: number): boolean {
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    // Only ESRCH proves absence. EPERM means the group exists but belongs to another user, which
    // is emphatically not "gone" — treating any error as absence is the classic version of this
    // bug and would make the whole confirmation vacuous.
    return (error as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

async function waitForProcessGroupGone(pid: number, deadlineMs: number): Promise<boolean> {
  while (processGroupExists(pid)) {
    if (Date.now() >= deadlineMs) return false;
    await new Promise<void>((resolve) => setTimeout(resolve, PROCESS_GROUP_POLL_MS));
  }
  return true;
}

/**
 * Strips the Job Host's one-line `ADJH/1 READY <pid>` handshake from stderr, so callers see
 * provider stderr and nothing else.
 *
 * The failure mode is handled deliberately: if the first line is *not* a well-formed READY, or is
 * implausibly long, the stream is not merely passed through — it is ended and every later byte
 * suppressed. A host that failed before arming emits diagnostics that can quote the launch
 * configuration it was given (executable path, arguments), and this repo's public provider stderr
 * is surfaced in error messages and logs. Suppressing is the conservative choice; `onInvalid` lets
 * the caller react (it kills the child) rather than silently continuing with a stream it cannot trust.
 */
export function filterWindowsJobHostStderr(
  source: Readable,
  onInvalid: () => void = () => undefined,
): Readable {
  const output = new PassThrough();
  let handshake = Buffer.alloc(0);
  let state: 'pending' | 'ready' | 'blocked' = 'pending';

  source.on('data', (chunk: Buffer | string) => {
    if (state === 'ready') {
      output.write(chunk);
      return;
    }
    if (state === 'blocked') return;
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    const combined = Buffer.concat([handshake, buffer]);
    const newline = combined.indexOf(0x0a);
    if (newline < 0 && combined.byteLength > MAX_WINDOWS_HANDSHAKE_BYTES) {
      state = 'blocked';
      handshake = Buffer.alloc(0);
      output.end();
      onInvalid();
      return;
    }
    if (newline < 0) {
      handshake = combined;
      return;
    }
    const controlLine = combined.subarray(0, newline + 1);
    const remainder = combined.subarray(newline + 1);
    handshake = Buffer.alloc(0);
    state = 'blocked';
    if (
      controlLine.byteLength <= MAX_WINDOWS_HANDSHAKE_BYTES &&
      /^ADJH\/1 READY [1-9]\d*\r?\n$/u.test(controlLine.toString('ascii'))
    ) {
      state = 'ready';
      // The handshake and the first real provider bytes routinely arrive in one chunk, so the
      // remainder must be forwarded here rather than waiting for a subsequent 'data' event.
      if (remainder.byteLength > 0) output.write(remainder);
      return;
    }
    output.end();
    onInvalid();
  });
  source.once('end', () => {
    if (state === 'pending') onInvalid();
    output.end();
  });
  source.once('error', () => {
    if (state === 'pending') onInvalid();
    output.end();
  });
  return output;
}

function publicWindowsProcess(child: NativeProcess): SpawnedProcess {
  const stderr = filterWindowsJobHostStderr(child.stderr, () => {
    if (child.exitCode === null) child.kill('SIGKILL');
  });
  return {
    stdin: child.stdin,
    stdout: child.stdout,
    stderr,
    get pid() {
      return child.pid;
    },
    kill: (signal) => child.kill(signal),
  };
}

/**
 * Spawns a command with an argv array (never a shell string) and no shell interpolation, and with a
 * default-deny environment (ADI-15): the child sees only `buildProviderEnvironment`'s allowlisted
 * subset, never the daemon's own environment. Every other subprocess entry point in this package
 * (`exec-capture.ts`, `detect-executable.ts`, `run-session.ts`, both providers' `detect.ts`) reaches
 * the OS through this function, so that policy is inherited structurally rather than re-implemented
 * per call site. On Windows the provider is created by the Job Host with `lpEnvironment = NULL`,
 * i.e. it inherits the host's own block -- and the host got this filtered environment, so the
 * restriction survives the extra hop rather than being undone by it.
 *
 * POSIX launches the provider detached, in its own process group. Windows launches the shipped Job
 * Object host, which creates the provider as a job member at process-creation time (suspended,
 * then resumed, via `PROC_THREAD_ATTRIBUTE_JOB_LIST`) so there is no window in which the provider
 * exists outside the job. Either way, cancelling a session reaps every descendant this mechanism
 * can see -- which is every ordinary child/grandchild a provider or its tools spawn directly. The
 * one confirmed exception (Windows only): a descendant created through an out-of-process broker
 * that itself never joined the job (verified against a WMI `Win32_Process.Create()` call, which
 * runs the new process under `WmiPrvSE.exe`, a non-member process) escapes this guarantee -- an
 * inherent limit of Job Objects, not a bug in this code, but real enough that "cannot leave any
 * child orphaned" would overstate it.
 */
export function spawnProcess(command: string, args: string[], opts: SpawnOptions): SpawnResult {
  const platform = opts.platform ?? process.platform;
  const usesWindowsJobHost = platform === 'win32' && opts.useJobHostOnWindows !== false;
  const actualCommand = usesWindowsJobHost ? resolveWindowsJobHostPath(opts.windowsJobHostPath) : command;
  const actualArgs = usesWindowsJobHost
    ? encodeWindowsJobHostArguments({ ownerPid: process.pid, executable: command, cwd: opts.cwd, args })
    : args;
  // ADI-15: the single point where the provider environment policy is applied. Note it uses the
  // real `process.platform` rather than `opts.platform`: that seam exists to exercise the Job Host
  // branch, and the environment a child needs is a fact about the machine actually running it, not
  // about which branch a test is driving.
  const { env } = buildProviderEnvironment(opts.env ?? process.env);
  const nativeChild = spawn(actualCommand, actualArgs, {
    cwd: opts.cwd,
    env,
    shell: false,
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
    detached: !usesWindowsJobHost,
  });
  const child: SpawnedProcess = usesWindowsJobHost ? publicWindowsProcess(nativeChild) : nativeChild;

  let settled = false;
  const exit = new Promise<ProcessExitResult>((resolve) => {
    nativeChild.once('exit', (code, signal) => {
      settled = true;
      resolve({ code, signal });
    });
    nativeChild.once('error', () => {
      if (!settled) {
        settled = true;
        resolve({ code: null, signal: null });
      }
    });
  });

  // Memoized rather than guarded by a boolean: a boolean would make the second caller resolve
  // immediately while the first sequence is still running, i.e. report "reaped" before anything
  // was. Sharing the promise makes every caller wait for the same real confirmation.
  let killPromise: Promise<void> | undefined;
  function kill(): Promise<void> {
    if (killPromise) return killPromise;
    killPromise = terminateProcessTree(child, exit, () => settled, { platform });
    return killPromise;
  }

  return { child, exit, kill };
}
