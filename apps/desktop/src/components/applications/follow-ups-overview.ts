import { dueStateOf } from '../../../electron/application-actions-core.js';
import type { OverviewResult } from '../../../electron/application-actions-types.js';

export type OverviewItem = Extract<OverviewResult, { ok: true }>['items'][number];

/** Index by Applications row id. */
export function indexOverview(result: OverviewResult): ReadonlyMap<string, OverviewItem> {
  return result.ok ? new Map(result.items.map((item) => [item.applicationId, item])) : new Map();
}

export interface OverviewTotals {
  overdue: number;
  dueToday: number;
  open: number;
}

/** Counts over the rows currently on screen, judged against `nowMs` (the same function the rows use). */
export function totalsFor(items: ReadonlyMap<string, OverviewItem>, applicationIds: readonly string[], nowMs: number): OverviewTotals {
  const totals: OverviewTotals = { overdue: 0, dueToday: 0, open: 0 };
  for (const id of applicationIds) {
    for (const action of items.get(id)?.openActions ?? []) {
      totals.open += 1;
      const state = dueStateOf(
        { state: action.state, dueKind: action.dueKind, dueDate: action.dueDate, dueLocal: action.dueLocal, dueTimeZone: action.dueTimeZone, dueAtMs: Date.parse(action.dueAt) },
        nowMs,
      );
      if (state === 'overdue') totals.overdue += 1;
      else if (state === 'due_today') totals.dueToday += 1;
    }
  }
  return totals;
}
