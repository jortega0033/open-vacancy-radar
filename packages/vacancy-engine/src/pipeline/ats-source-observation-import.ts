import { readFile } from 'node:fs/promises';
import path from 'node:path';

import type { Logger } from 'pino';

import { createVacancyAdapter } from '../ats/factory.js';
import {
  atsSourceKey,
  classifyAtsSourceFailure,
  loadAtsSourceObservations,
  parseAtsSourceObservationImport,
  recordAtsSourceObservation,
  writeAtsSourceObservations,
  type AtsSourceFailureCategory,
} from '../companies/ats-source-observation-repository.js';
import { loadAtsRoster, writeAtsRoster } from '../companies/ats-roster-repository.js';
import type { AppConfig } from '../config.js';
import type { Database } from '../db/client.js';
import {
  createDatabaseBackedHttpClients,
  type DatabaseBackedAtsHttpClientDependencies,
} from './ats-http-client.js';

export type AtsSourceObservationImportResult = {
  file: string;
  generatedAt: string;
  processedCount: number;
  acceptedCount: number;
  duplicateCount: number;
  invalidCount: number;
  rejectedCount: number;
  failuresByCategory: Partial<Record<AtsSourceFailureCategory, number>>;
  acceptedSources: { provider: string; slug: string; company: string }[];
};

function hasStableVacancyIdentity(vacancy: { externalId: string; url: string }): boolean {
  if (vacancy.externalId.trim().length === 0) return false;
  try {
    return new URL(vacancy.url).protocol === 'https:';
  } catch {
    return false;
  }
}

/**
 * Imports a versioned deterministic scout artifact. Every new tenant is re-read through OVR's
 * existing adapter and safe HTTP client before it can enter the active roster.
 */
export async function runAtsSourceObservationImport(
  database: Database,
  appConfig: AppConfig,
  logger: Logger,
  inputFile: string,
  projectRoot = process.cwd(),
  dependencies: DatabaseBackedAtsHttpClientDependencies = {},
): Promise<AtsSourceObservationImportResult> {
  const resolvedInputFile = path.resolve(inputFile);
  const parsed = parseAtsSourceObservationImport(
    JSON.parse(await readFile(resolvedInputFile, 'utf8')) as unknown,
  );
  const existingRoster = await loadAtsRoster(projectRoot);
  const existingKeys = new Set(existingRoster.map(atsSourceKey));
  const acceptedEntries = [] as typeof existingRoster;
  const acceptedSources: AtsSourceObservationImportResult['acceptedSources'] = [];
  const failuresByCategory: Partial<Record<AtsSourceFailureCategory, number>> = {};
  let observationState = await loadAtsSourceObservations(projectRoot);
  let duplicateCount = parsed.duplicateCount;
  let rejectedCount = 0;
  const { atsClient } = createDatabaseBackedHttpClients(appConfig, database, {
    ...dependencies,
    onCacheError(error, operation, url) {
      dependencies.onCacheError?.(error, operation, url);
      logger.warn({ error, operation, url }, 'ATS source import HTTP cache operation failed');
    },
  });

  for (const record of parsed.records) {
    const key = atsSourceKey(record.entry);
    if (existingKeys.has(key)) {
      duplicateCount += 1;
      continue;
    }
    const adapter = createVacancyAdapter(record.entry.provider, atsClient);
    if (adapter === null) {
      rejectedCount += 1;
      failuresByCategory.invalid_response = (failuresByCategory.invalid_response ?? 0) + 1;
      continue;
    }
    try {
      const result = await adapter.listVacancies({
        id: key,
        companyId: key,
        companyName: record.entry.company,
        provider: record.entry.provider,
        baseUrl: record.entry.baseUrl,
        boardIdentifier: record.entry.slug,
        lifecycleAuthoritative: false,
      });
      const schemaValid =
        result.vacancies.length > 0 && result.vacancies.every(hasStableVacancyIdentity);
      if (!schemaValid) {
        rejectedCount += 1;
        observationState = recordAtsSourceObservation(observationState, {
          entry: record.entry,
          status: result.vacancies.length === 0 ? 'empty' : 'error',
          errorCategory: result.vacancies.length === 0 ? null : 'invalid_response',
          vacancies: result.vacancies,
          evidence: [record.evidence],
          decisionReason:
            result.vacancies.length === 0
              ? 'Validated adapter returned an empty board; source remains observed but is not promoted.'
              : 'Adapter returned one or more vacancies without stable HTTPS identity.',
        });
        continue;
      }
      acceptedEntries.push(record.entry);
      existingKeys.add(key);
      acceptedSources.push({
        provider: record.entry.provider,
        slug: record.entry.slug,
        company: record.entry.company,
      });
      observationState = recordAtsSourceObservation(observationState, {
        entry: record.entry,
        status: 'verified',
        errorCategory: null,
        vacancies: result.vacancies,
        evidence: [record.evidence],
        decisionReason:
          'Imported source passed canonical detection, safe HTTP, adapter schema, and vacancy identity validation.',
      });
    } catch (error) {
      rejectedCount += 1;
      const category = classifyAtsSourceFailure(error);
      failuresByCategory[category] = (failuresByCategory[category] ?? 0) + 1;
      observationState = recordAtsSourceObservation(observationState, {
        entry: record.entry,
        status: ['authentication', 'blocked', 'rate_limited'].includes(category)
          ? 'blocked'
          : 'error',
        errorCategory: category,
        vacancies: [],
        evidence: [record.evidence],
        decisionReason: `Import validation failed with category ${category}; source was not promoted.`,
      });
      logger.warn(
        { provider: record.entry.provider, slug: record.entry.slug, category },
        'ATS source import candidate rejected',
      );
    }
  }

  const file = await writeAtsRoster(
    projectRoot,
    [...existingRoster, ...acceptedEntries],
    {},
    new Date(),
  );
  await writeAtsSourceObservations(projectRoot, observationState);
  return {
    file,
    generatedAt: parsed.generatedAt,
    processedCount: parsed.records.length,
    acceptedCount: acceptedEntries.length,
    duplicateCount,
    invalidCount: parsed.invalidCount,
    rejectedCount,
    failuresByCategory,
    acceptedSources,
  };
}
