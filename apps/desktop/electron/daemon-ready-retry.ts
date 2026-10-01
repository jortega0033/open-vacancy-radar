/**
 * `waitForDaemonReady` (`main.ts`) throws only when its own poll deadline elapses with the daemon
 * process still alive: a real crash is reported independently, and usually first, by the child's
 * `exit` handler. A first-attempt timeout therefore means "still starting", not "failed". A
 * slow-but-healthy boot (first-run module resolution, an antivirus-scanned fresh build, a loaded
 * machine) can legitimately take a little over one 15s window, and reporting that as a failure
 * schedules a respawn that throws the half-started daemon away and restarts the clock, so the
 * bounded respawn budget can burn out on a daemon that would have been ready a few seconds later.
 *
 * This gives the same wait exactly one more window before the timeout is treated as a failure.
 * Lives here, not in `main.ts`, for the same reason `daemon-lock-attach.ts` does: `main.ts` cannot
 * be imported by a test.
 *
 * Tracks agentdock#174 (the upstream fix for the same wedge); this repo's `main.ts` already
 * respawns instead of reporting a terminal status, so only the retry is ported.
 */

export async function waitWithOneRetry(
  attempt: () => Promise<void>,
  /** True while the spawn attempt that started this wait still owns the daemon. A superseded
   * attempt must not retry: its replacement reports for itself. */
  stillCurrent: () => boolean,
): Promise<void> {
  try {
    await attempt();
  } catch {
    if (!stillCurrent()) return;
    // The second failure is the one reported, now after the full extended budget.
    await attempt();
  }
}
