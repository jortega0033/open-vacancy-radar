import { desc, inArray, lt } from 'drizzle-orm';

import type { Database } from '../db/client.js';
import { discoveryRuns } from '../db/schema.js';

/**
 * Persistence for `discovery_runs`: a queryable index over the report files
 * `writeGlobalRemoteReport` already writes to disk, not a copy of their contents. Kept as its own
 * thin repository module, separate from `pipeline/global-remote.ts`'s own orchestration, for the
 * same reason `companies/worldwide-sponsor-lookup-cache.ts` is separate -- the read/write shape
 * stays unit-testable against a real database without standing up a whole scan.
 */

export type DiscoveryRunRecord = {
  id: string;
  generatedAt: Date;
  vacancyCount: number;
  reportJsonPath: string;
  reportHtmlPath: string;
};

/**
 * Records one completed scan's report files. Called from `runGlobalRemoteScan` only after
 * `writeGlobalRemoteReport` has returned, so a row here always names files that are actually on
 * disk -- a scan that fails before that point leaves no row, rather than a dangling one.
 */
export async function recordDiscoveryRun(
  database: Database,
  run: {
    generatedAt: Date;
    vacancyCount: number;
    reportJsonPath: string;
    reportHtmlPath: string;
  },
): Promise<DiscoveryRunRecord> {
  const [inserted] = await database.insert(discoveryRuns).values(run).returning();
  if (inserted === undefined) {
    throw new Error('Failed to insert discovery_runs row');
  }
  return inserted;
}

/**
 * The most recent scan's record, or `null` when no scan has ever completed -- the same "nothing
 * usable yet" shape `readGlobalRemoteReport` already returns for a fresh install, so a caller can
 * treat both the same way.
 */
export async function latestDiscoveryRun(database: Database): Promise<DiscoveryRunRecord | null> {
  const [latest] = await database
    .select()
    .from(discoveryRuns)
    .orderBy(desc(discoveryRuns.generatedAt))
    .limit(1);
  return latest ?? null;
}

/** Most recent scans first, capped at `limit` (default 20, matching a reasonable history view). */
export async function listRecentDiscoveryRuns(
  database: Database,
  limit = 20,
): Promise<DiscoveryRunRecord[]> {
  return database
    .select()
    .from(discoveryRuns)
    .orderBy(desc(discoveryRuns.generatedAt))
    .limit(limit);
}

/**
 * Rows for scans strictly older than `cutoff` -- the candidates `pruneGlobalRemoteReports`
 * (report.ts) deletes the report files for. Left as a plain read rather than a delete itself so the
 * caller can remove the files those rows name from disk first and only then drop the rows, the same
 * "disk first, index second" order `writeGlobalRemoteReport`/`recordDiscoveryRun` already write in.
 */
export async function discoveryRunsOlderThan(database: Database, cutoff: Date): Promise<DiscoveryRunRecord[]> {
  return database.select().from(discoveryRuns).where(lt(discoveryRuns.generatedAt, cutoff));
}

/**
 * Removes rows by id once their report files are gone from disk, so `discovery_runs` never keeps a
 * row pointing at a report `pruneGlobalRemoteReports` has already deleted. A no-op for an empty
 * list, since `inArray` with nothing to match is not a query worth sending.
 */
export async function deleteDiscoveryRuns(database: Database, ids: readonly string[]): Promise<void> {
  if (ids.length === 0) return;
  await database.delete(discoveryRuns).where(inArray(discoveryRuns.id, ids));
}
