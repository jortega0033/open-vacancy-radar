/**
 * #692: which applications have a follow-up draft being written right now. Process-local, like the
 * critique and preparation fences: one in-flight run per application, a cancel reaches its controller,
 * and a data reset aborts every run so none can save into data that has been removed.
 */
const runs = new Map<string, { runId: string; controller: AbortController }>();

export function reserveRun(applicationId: string, runId: string, controller: AbortController): boolean {
  if (runs.has(applicationId)) return false;
  runs.set(applicationId, { runId, controller });
  return true;
}

export function releaseRun(applicationId: string, runId: string): void {
  if (runs.get(applicationId)?.runId === runId) runs.delete(applicationId);
}

export function isRunLive(applicationId: string, runId: string): boolean {
  return runs.get(applicationId)?.runId === runId;
}

export function isFollowUpRunning(applicationId: string): boolean {
  return runs.has(applicationId);
}

/** Aborts a running draft. True when something was running. */
export function cancelFollowUp(applicationId: string): boolean {
  const run = runs.get(applicationId);
  if (!run) return false;
  run.controller.abort();
  return true;
}

export function cancelAllFollowUps(): void {
  for (const run of runs.values()) run.controller.abort();
}