import type { Logger } from 'pino';

import {
  ATS_ROSTER_PROVIDERS,
  atsRosterCsvUrl,
  parseAtsRosterCsv,
  type AtsRosterEntry,
  type AtsRosterProvider,
} from '../companies/ats-roster-source.js';
import { writeAtsRoster } from '../companies/ats-roster-repository.js';
import type { AppConfig } from '../config.js';
import {
  createSafeHttpClient,
  DatabaseHttpCache,
  safeErrorClassification,
  type SafeHttpClientDependencies,
} from '../crawler/index.js';
import type { Database } from '../db/client.js';

export type AtsRosterProviderImportResult = {
  provider: AtsRosterProvider;
  status: 'success' | 'error';
  rawRowCount: number;
  importedCount: number;
  invalidRowCount: number;
  duplicateRowCount: number;
  error: string | null;
};

export type AtsRosterImportResult = {
  file: string;
  importedAt: string;
  totalEntries: number;
  providers: AtsRosterProviderImportResult[];
};

/**
 * Re-runnable, deliberate import step (see issue #251's non-goals: "no live runtime dependency on
 * either upstream source repo at scan time"). Pulls each in-scope provider's CSV from
 * `kalil0321/ats-scrapers` (mirrored at `storage.stapply.ai`, the origin cited in the ticket),
 * verifies every row's URL against this repo's own `detect*Source` parser (see
 * `parseAtsRosterCsv`), and writes the filtered `(provider, slug)` set to the local roster file
 * (`companies/ats-roster-repository.ts`). One provider's CSV being unreachable or malformed is
 * isolated and reported per-provider, matching every other source in this pipeline
 * (docs/job-source-policy.md: "isolate failure so one unavailable source cannot block other source
 * scans") -- the roster is still written from whichever providers succeeded, rather than the whole
 * import failing over one bad feed.
 */
export async function runAtsRosterImport(
  database: Database,
  config: AppConfig,
  logger: Logger,
  projectRoot = process.cwd(),
  // Test-only injection seam (real callers never pass this), mirroring
  // `DatabaseBackedAtsHttpClientDependencies` in `pipeline/ats-http-client.ts`: lets tests stand in a
  // fake `fetchFn`/`resolver` for a hermetic run instead of reaching the real network or real DNS.
  dependencies: Pick<SafeHttpClientDependencies, 'fetchFn' | 'resolver'> = {},
): Promise<AtsRosterImportResult> {
  const client = createSafeHttpClient(config, {
    ...dependencies,
    cache: new DatabaseHttpCache(database),
    onCacheError: (error, operation, safeUrl) =>
      logger.warn(
        { ...safeErrorClassification(error), operation, url: safeUrl },
        'ATS roster import HTTP cache operation failed; continuing without it',
      ),
  });

  const allEntries: AtsRosterEntry[] = [];
  const providerResults: AtsRosterProviderImportResult[] = [];
  const sourceCounts: Partial<Record<AtsRosterProvider, number>> = {};

  for (const provider of ATS_ROSTER_PROVIDERS) {
    const url = atsRosterCsvUrl(provider);
    try {
      const response = await client.get(url, { allowedOrigins: [new URL(url).origin] });
      if (response.status < 200 || response.status >= 300) {
        throw new Error(`HTTP ${response.status}`);
      }
      const parsed = parseAtsRosterCsv(response.text(), provider);
      allEntries.push(...parsed.entries);
      sourceCounts[provider] = parsed.entries.length;
      providerResults.push({
        provider,
        status: 'success',
        rawRowCount: parsed.rawRowCount,
        importedCount: parsed.entries.length,
        invalidRowCount: parsed.invalidRowCount,
        duplicateRowCount: parsed.duplicateRowCount,
        error: null,
      });
      logger.info(
        {
          provider,
          rawRowCount: parsed.rawRowCount,
          importedCount: parsed.entries.length,
          invalidRowCount: parsed.invalidRowCount,
          duplicateRowCount: parsed.duplicateRowCount,
        },
        'ATS roster provider imported',
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      providerResults.push({
        provider,
        status: 'error',
        rawRowCount: 0,
        importedCount: 0,
        invalidRowCount: 0,
        duplicateRowCount: 0,
        error: message,
      });
      logger.warn({ provider, error: message }, 'ATS roster provider import failed; continuing with the rest');
    }
  }

  const importedAt = new Date();
  const file = await writeAtsRoster(projectRoot, allEntries, sourceCounts, importedAt);
  return {
    file,
    importedAt: importedAt.toISOString(),
    totalEntries: allEntries.length,
    providers: providerResults,
  };
}
