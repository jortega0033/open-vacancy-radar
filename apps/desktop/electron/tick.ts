/**
 * A recurring background worker's one turn: an in-flight reentrancy guard, an optional hard-timeout
 * ceiling on the whole turn, and consistent error logging -- pulled out of `main.ts`, where
 * `automaticSubmissionTickInFlight` and `applicationPipelineTickInFlight` used to be two separately
 * hand-written copies of the same three lines, with duplicated "same reasoning as..." comments and,
 * critically, no shared test coverage. This is the exact code class that already caused one silent
 * production incident: a hung turn left `applicationPipelineTickInFlight` `true` forever, so every
 * later tick silently no-op'd with no error ever logged. Nothing here previously had a test that
 * could catch a repeat of that -- see `tick.test.ts`'s hang-simulation case.
 *
 * `scheduleBackgroundScanTick` in `main.ts` deliberately does NOT use this: it solves a different
 * problem (checking a long, drift-prone period against a real last-run timestamp, so it survives
 * system sleep) rather than "don't let one turn overlap the next," and forcing it into this shape
 * would not remove any duplication -- there is nothing here it would actually reuse.
 */

function withHardTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
}

export interface TickOptions {
  /** Identifies this tick in its default error log line and its default hard-timeout message. */
  label: string;
  /** One turn's real work. Rejecting (or, with `hardTimeoutMs` set, simply never resolving) is
   * expected and handled -- it does not propagate out of `runOnce`. */
  run: () => Promise<void>;
  /** A ceiling on one whole turn, independent of any timeout `run` itself may or may not have.
   * Exists so that whichever step turns out to hang -- an external call with no timeout of its own,
   * a page load that never settles, anything not yet hardened -- can never wedge this tick's
   * in-flight guard permanently. Omit only when `run` already bounds its own worst case. */
  hardTimeoutMs?: number;
  /** Defaults to `console.error('[${label}] tick failed', error)`. */
  onError?: (error: unknown) => void;
}

export interface Tick {
  /** Runs one turn now, honoring the in-flight guard: a call that arrives while a previous turn is
   * still running (or still waiting out its hard timeout) is a deliberate, silent no-op -- the next
   * scheduled call will find the same work still waiting, at no cost. Never rejects. */
  runOnce: () => Promise<void>;
  /** True from the moment a turn starts until it settles. With `hardTimeoutMs` set, a hung `run()`
   * still flips this back to `false` once the timeout elapses, freeing the next scheduled call to
   * proceed -- even though the abandoned `run()` call itself may still be running in the background.
   * With no `hardTimeoutMs`, a hung `run()` leaves this `true` forever, exactly like the two
   * hand-rolled flags this replaces did before the fix this module exists to carry. */
  readonly inFlight: boolean;
}

export function createTick(options: TickOptions): Tick {
  let inFlight = false;
  const onError = options.onError ?? ((error: unknown) => console.error(`[${options.label}] tick failed`, error));

  return {
    get inFlight() {
      return inFlight;
    },
    async runOnce() {
      if (inFlight) return;
      inFlight = true;
      try {
        const work = options.run();
        await (options.hardTimeoutMs === undefined
          ? work
          : withHardTimeout(work, options.hardTimeoutMs, `${options.label} tick exceeded its hard timeout`));
      } catch (error) {
        onError(error);
      } finally {
        inFlight = false;
      }
    },
  };
}
