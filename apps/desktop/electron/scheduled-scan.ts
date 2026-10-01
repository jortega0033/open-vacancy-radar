/**
 * Whether enough wall-clock time has passed since the last successful scan to run another one
 * (#195). A pure, directly testable decision -- kept separate from the `setInterval` that calls
 * it so "did enough time pass" can be unit-tested with an injected clock instead of requiring a
 * real elapsed interval in a test, and so the periodic tick itself can stay cheap (an ordinary
 * timestamp comparison) while only the decision it feeds is ever expensive (the scan itself).
 */
export function shouldRunScheduledScan(lastGeneratedAt: string | undefined, now: Date, intervalMs: number): boolean {
  if (lastGeneratedAt === undefined) return true;
  const last = new Date(lastGeneratedAt).getTime();
  if (Number.isNaN(last)) return true;
  return now.getTime() - last >= intervalMs;
}
