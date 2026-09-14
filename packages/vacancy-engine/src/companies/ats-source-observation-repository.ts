import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { z } from 'zod';

import { detectAtsSource } from '../ats/detection.js';
import { AtsResponseError } from '../ats/http.js';
import { normalizeCountry } from '../geo/countries.js';
import {
  ATS_ROSTER_PROVIDERS,
  type AtsRosterEntry,
  type AtsRosterProvider,
} from './ats-roster-source.js';

const OBSERVATION_FILE_RELATIVE_PATH = path.join('.data', 'ats-source-observations-v1.json');

const observationStatusSchema = z.enum(['verified', 'empty', 'blocked', 'error']);
const refreshTierSchema = z.enum(['hot', 'warm', 'cold', 'quarantined']);
const failureCategorySchema = z.enum([
  'authentication',
  'blocked',
  'not_found',
  'rate_limited',
  'timeout',
  'invalid_response',
  'network',
  'unknown',
]);

export type AtsSourceObservationStatus = z.infer<typeof observationStatusSchema>;
export type AtsSourceRefreshTier = z.infer<typeof refreshTierSchema>;
export type AtsSourceFailureCategory = z.infer<typeof failureCategorySchema>;

const observationSchema = z.object({
  provider: z.enum(ATS_ROSTER_PROVIDERS),
  slug: z.string().min(1),
  company: z.string().min(1),
  canonicalBoardUrl: z.url().startsWith('https://'),
  lastAttemptAt: z.iso.datetime(),
  lastSuccessAt: z.iso.datetime().nullable(),
  status: observationStatusSchema,
  errorCategory: failureCategorySchema.nullable(),
  vacancyCount: z.number().int().nonnegative(),
  observedCountries: z.array(z.string().min(1)),
  observedRemoteScopes: z.array(z.string().min(1)),
  observedRoleFamilies: z.array(z.string().min(1)),
  evidence: z.array(z.string().min(1)),
  decisionReason: z.string().min(1),
  consecutiveEmptyOrFailureCount: z.number().int().nonnegative(),
  nextDueAt: z.iso.datetime(),
  refreshTier: refreshTierSchema,
  promotedAt: z.iso.datetime().nullable(),
});

export type AtsSourceObservation = z.infer<typeof observationSchema>;

const observationFileSchema = z.object({
  version: z.literal(1),
  updatedAt: z.iso.datetime(),
  cursor: z.object({
    nextIndex: z.number().int().nonnegative(),
    generation: z.number().int().nonnegative(),
  }),
  observations: z.array(observationSchema),
});

const legacyObservationFileSchema = z.object({
  version: z.literal(0),
  updatedAt: z.iso.datetime(),
  cursor: z.number().int().nonnegative(),
  observations: z.array(observationSchema.omit({ evidence: true, decisionReason: true })),
});

export type AtsSourceObservationFile = z.infer<typeof observationFileSchema>;

export function emptyAtsSourceObservationFile(now = new Date()): AtsSourceObservationFile {
  return {
    version: 1,
    updatedAt: now.toISOString(),
    cursor: { nextIndex: 0, generation: 0 },
    observations: [],
  };
}

export function atsSourceObservationFilePath(projectRoot: string): string {
  return path.resolve(projectRoot, OBSERVATION_FILE_RELATIVE_PATH);
}

export function atsSourceKey(entry: Pick<AtsRosterEntry, 'provider' | 'slug'>): string {
  return `${entry.provider}:${entry.slug.trim().toLowerCase()}`;
}

export function canonicalAtsBoardUrl(entry: AtsRosterEntry): string {
  const slug = encodeURIComponent(entry.slug);
  switch (entry.provider) {
    case 'greenhouse':
      return `https://job-boards.greenhouse.io/${slug}`;
    case 'lever':
      return `${entry.baseUrl.includes('eu.lever.co') ? 'https://jobs.eu.lever.co' : 'https://jobs.lever.co'}/${slug}`;
    case 'ashby':
      return `https://jobs.ashbyhq.com/${slug}`;
    case 'recruitee':
    case 'personio':
      return entry.baseUrl;
  }
}

export async function loadAtsSourceObservations(
  projectRoot: string,
): Promise<AtsSourceObservationFile> {
  const file = atsSourceObservationFilePath(projectRoot);
  let raw: string;
  try {
    raw = await readFile(file, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return emptyAtsSourceObservationFile();
    throw error;
  }
  const input = JSON.parse(raw) as unknown;
  const parsed = observationFileSchema.safeParse(input);
  if (!parsed.success) {
    const legacy = legacyObservationFileSchema.safeParse(input);
    if (legacy.success) {
      const migrated: AtsSourceObservationFile = {
        version: 1,
        updatedAt: legacy.data.updatedAt,
        cursor: { nextIndex: legacy.data.cursor, generation: 0 },
        observations: legacy.data.observations.map((observation) => ({
          ...observation,
          evidence: ['Migrated from ATS source observation store version 0.'],
          decisionReason:
            'Preserved during the version 0 to version 1 observation-store migration.',
        })),
      };
      await writeAtsSourceObservations(projectRoot, migrated);
      return migrated;
    }
  }
  if (!parsed.success) {
    throw new Error(
      `ATS source observation file at ${file} is invalid: ${z.prettifyError(parsed.error)}`,
    );
  }
  return parsed.data;
}

export async function writeAtsSourceObservations(
  projectRoot: string,
  state: AtsSourceObservationFile,
): Promise<string> {
  const file = atsSourceObservationFilePath(projectRoot);
  const parsed = observationFileSchema.parse(state);
  const sorted: AtsSourceObservationFile = {
    ...parsed,
    observations: [...parsed.observations].sort((left, right) =>
      atsSourceKey(left).localeCompare(atsSourceKey(right)),
    ),
  };
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(sorted, null, 2)}\n`, 'utf8');
  await rename(temporary, file);
  return file;
}

export type AtsRosterPlanEntry = {
  entry: AtsRosterEntry;
  reason: 'focused_due' | 'exploration' | 'due';
};

export type AtsRosterScanPlan = {
  mode: 'complete' | 'incremental';
  entries: AtsRosterPlanEntry[];
  totalRosterSize: number;
  dueSourceCount: number;
  skippedNotDue: number;
  checkpoint: number;
  nextState: AtsSourceObservationFile;
};

export type AtsRosterScanPlanOptions = {
  roleQuery: string;
  country: string;
  maxSources: number;
  explorationBudget: number;
  now?: Date;
};

function normalizedRoster(roster: readonly AtsRosterEntry[]): AtsRosterEntry[] {
  const byKey = new Map<string, AtsRosterEntry>();
  for (const entry of roster) {
    const key = atsSourceKey(entry);
    if (!byKey.has(key)) byKey.set(key, entry);
  }
  return [...byKey.values()].sort((left, right) =>
    atsSourceKey(left).localeCompare(atsSourceKey(right)),
  );
}

function roleFamilies(value: string): string[] {
  const text = value.toLowerCase();
  const families = new Set<string>();
  if (/\bfront[ -]?end\b|\breact\b|\bangular\b|\bvue\b|\bsvelte\b/u.test(text))
    families.add('frontend');
  if (/\bback[ -]?end\b|\bserver[- ]side\b/u.test(text)) families.add('backend');
  if (/\bfull[ -]?stack\b/u.test(text)) families.add('fullstack');
  if (/\bmobile\b|\bios\b|\bandroid\b|\breact native\b|\bflutter\b/u.test(text))
    families.add('mobile');
  if (/\bdata\b|\banalytics\b|\bmachine learning\b|\bml\b/u.test(text)) families.add('data');
  if (/\bdevops\b|\bplatform\b|\binfrastructure\b|\bsre\b/u.test(text)) families.add('platform');
  if (/\bdesign\b|\bux\b|\bui\b/u.test(text)) families.add('design');
  return [...families];
}

function observationMatchesFocus(
  observation: AtsSourceObservation,
  roleQuery: string,
  country: string,
): boolean {
  const requestedFamilies = roleFamilies(roleQuery);
  const normalizedRequestedCountry = normalizeCountry(country) ?? country.trim();
  const countryMatches =
    normalizedRequestedCountry.length === 0 ||
    observation.observedCountries.some(
      (value) => value.toLowerCase() === normalizedRequestedCountry.toLowerCase(),
    ) ||
    observation.observedRemoteScopes.some((value) =>
      ['worldwide', 'europe', 'emea'].includes(value.toLowerCase()),
    );
  const roleMatches =
    requestedFamilies.length === 0 ||
    requestedFamilies.some((value) => observation.observedRoleFamilies.includes(value));
  return countryMatches && roleMatches;
}

function due(observation: AtsSourceObservation | undefined, now: Date): boolean {
  return observation === undefined || Date.parse(observation.nextDueAt) <= now.valueOf();
}

export function planAtsRosterScan(
  roster: readonly AtsRosterEntry[],
  state: AtsSourceObservationFile,
  options: AtsRosterScanPlanOptions,
): AtsRosterScanPlan {
  const entries = normalizedRoster(roster);
  const focused = options.roleQuery.trim().length > 0 || options.country.trim().length > 0;
  if (!focused) {
    return {
      mode: 'complete',
      entries: entries.map((entry) => ({ entry, reason: 'due' })),
      totalRosterSize: entries.length,
      dueSourceCount: entries.length,
      skippedNotDue: 0,
      checkpoint: state.cursor.nextIndex,
      nextState: state,
    };
  }

  const now = options.now ?? new Date();
  const byKey = new Map(
    state.observations.map((observation) => [atsSourceKey(observation), observation]),
  );
  const dueEntries = entries.filter((entry) => due(byKey.get(atsSourceKey(entry)), now));
  const maxSources = Math.max(1, Math.min(Math.floor(options.maxSources), entries.length || 1));
  const explorationBudget = Math.min(
    Math.max(1, Math.floor(options.explorationBudget)),
    maxSources,
  );
  const focusedBudget = Math.max(0, maxSources - explorationBudget);
  const selected = new Set<string>();
  const planned: AtsRosterPlanEntry[] = [];

  const focusedDue = dueEntries
    .filter((entry) => {
      const observation = byKey.get(atsSourceKey(entry));
      return (
        observation !== undefined &&
        observationMatchesFocus(observation, options.roleQuery, options.country)
      );
    })
    .sort((left, right) => {
      const leftObservation = byKey.get(atsSourceKey(left));
      const rightObservation = byKey.get(atsSourceKey(right));
      return (
        Date.parse(leftObservation?.nextDueAt ?? '') - Date.parse(rightObservation?.nextDueAt ?? '')
      );
    });
  for (const entry of focusedDue.slice(0, focusedBudget)) {
    selected.add(atsSourceKey(entry));
    planned.push({ entry, reason: 'focused_due' });
  }

  let inspected = 0;
  let index = entries.length === 0 ? 0 : state.cursor.nextIndex % entries.length;
  let explored = 0;
  while (inspected < entries.length && explored < explorationBudget) {
    const entry = entries[index];
    index = entries.length === 0 ? 0 : (index + 1) % entries.length;
    inspected += 1;
    if (
      entry === undefined ||
      selected.has(atsSourceKey(entry)) ||
      !due(byKey.get(atsSourceKey(entry)), now)
    )
      continue;
    selected.add(atsSourceKey(entry));
    planned.push({ entry, reason: 'exploration' });
    explored += 1;
  }

  for (const entry of dueEntries) {
    if (planned.length >= maxSources) break;
    if (selected.has(atsSourceKey(entry))) continue;
    selected.add(atsSourceKey(entry));
    planned.push({ entry, reason: 'due' });
  }

  const nextState: AtsSourceObservationFile = {
    ...state,
    updatedAt: now.toISOString(),
    cursor: {
      nextIndex: index,
      generation:
        state.cursor.generation +
        (entries.length > 0 && index <= state.cursor.nextIndex % entries.length ? 1 : 0),
    },
  };
  return {
    mode: 'incremental',
    entries: planned,
    totalRosterSize: entries.length,
    dueSourceCount: dueEntries.length,
    skippedNotDue: entries.length - dueEntries.length,
    checkpoint: index,
    nextState,
  };
}

function remoteScopes(
  vacancies: readonly { location: string | null; description: string | null }[],
): string[] {
  const scopes = new Set<string>();
  for (const vacancy of vacancies) {
    const text = `${vacancy.location ?? ''} ${vacancy.description ?? ''}`.toLowerCase();
    if (/\bworldwide\b|\bglobal remote\b|\bwork from anywhere\b/u.test(text))
      scopes.add('worldwide');
    if (/\bemea\b/u.test(text)) scopes.add('emea');
    if (/\beurope\b|\beu remote\b/u.test(text)) scopes.add('europe');
    if (/\bremote\b/u.test(text)) scopes.add('remote');
    if (/\bhybrid\b/u.test(text)) scopes.add('hybrid');
    if (/\bon[ -]?site\b|\bin office\b/u.test(text)) scopes.add('onsite');
  }
  return [...scopes].sort();
}

function nextRefresh(
  status: AtsSourceObservationStatus,
  consecutiveCount: number,
  now: Date,
): { nextDueAt: string; refreshTier: AtsSourceRefreshTier } {
  let hours: number;
  let refreshTier: AtsSourceRefreshTier;
  if (status === 'verified') {
    hours = 24;
    refreshTier = 'hot';
  } else if (status === 'empty') {
    hours = consecutiveCount >= 3 ? 24 * 14 : 24 * 3;
    refreshTier = consecutiveCount >= 3 ? 'cold' : 'warm';
  } else if (status === 'blocked') {
    hours = 24 * 7;
    refreshTier = 'quarantined';
  } else {
    hours = Math.min(24 * 7, 6 * 2 ** Math.max(0, consecutiveCount - 1));
    refreshTier = consecutiveCount >= 4 ? 'cold' : 'warm';
  }
  return {
    nextDueAt: new Date(now.valueOf() + hours * 60 * 60 * 1_000).toISOString(),
    refreshTier,
  };
}

export type AtsSourceObservationOutcome = {
  entry: AtsRosterEntry;
  status: AtsSourceObservationStatus;
  errorCategory: AtsSourceFailureCategory | null;
  vacancies: readonly { title: string; location: string | null; description: string | null }[];
  evidence?: readonly string[];
  decisionReason?: string;
  attemptedAt?: Date;
};

export function classifyAtsSourceFailure(error: unknown): AtsSourceFailureCategory {
  const message =
    error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();
  const statusMatch = /\b(?:http|status)\s+(\d{3})\b/u.exec(message);
  const status =
    error instanceof AtsResponseError
      ? error.status
      : statusMatch?.[1] === undefined
        ? null
        : Number(statusMatch[1]);
  if (status === 401 || status === 407) return 'authentication';
  if (status === 404 || status === 410) return 'not_found';
  if (status === 429) return 'rate_limited';
  if (status !== null && [403, 406, 451].includes(status)) return 'blocked';
  if (/timeout|timed out|abort/u.test(message)) return 'timeout';
  if (/json|schema|parse|invalid response/u.test(message)) return 'invalid_response';
  if (/network|dns|fetch|socket|connect/u.test(message)) return 'network';
  return 'unknown';
}

export function recordAtsSourceObservation(
  state: AtsSourceObservationFile,
  outcome: AtsSourceObservationOutcome,
): AtsSourceObservationFile {
  const attemptedAt = outcome.attemptedAt ?? new Date();
  const key = atsSourceKey(outcome.entry);
  const existing = state.observations.find((observation) => atsSourceKey(observation) === key);
  const consecutiveCount =
    outcome.status === 'verified' ? 0 : (existing?.consecutiveEmptyOrFailureCount ?? 0) + 1;
  const countries = new Set(existing?.observedCountries ?? []);
  const roles = new Set(existing?.observedRoleFamilies ?? []);
  for (const vacancy of outcome.vacancies) {
    const country = normalizeCountry(vacancy.location);
    if (country !== null) countries.add(country);
    for (const family of roleFamilies(vacancy.title)) roles.add(family);
  }
  const observedScopes = new Set(existing?.observedRemoteScopes ?? []);
  for (const scope of remoteScopes(outcome.vacancies)) observedScopes.add(scope);
  const refresh = nextRefresh(outcome.status, consecutiveCount, attemptedAt);
  const observation: AtsSourceObservation = {
    provider: outcome.entry.provider,
    slug: outcome.entry.slug,
    company: outcome.entry.company,
    canonicalBoardUrl: canonicalAtsBoardUrl(outcome.entry),
    lastAttemptAt: attemptedAt.toISOString(),
    lastSuccessAt:
      outcome.status === 'verified' || outcome.status === 'empty'
        ? attemptedAt.toISOString()
        : (existing?.lastSuccessAt ?? null),
    status: outcome.status,
    errorCategory: outcome.errorCategory,
    vacancyCount: outcome.vacancies.length,
    observedCountries: [...countries].sort(),
    observedRemoteScopes: [...observedScopes].sort(),
    observedRoleFamilies: [...roles].sort(),
    evidence: [...new Set([...(existing?.evidence ?? []), ...(outcome.evidence ?? [])])],
    decisionReason:
      outcome.decisionReason ??
      (outcome.status === 'verified'
        ? 'Adapter returned at least one schema-valid vacancy.'
        : outcome.status === 'empty'
          ? 'Adapter completed successfully but returned no vacancies.'
          : `Adapter attempt failed with category ${outcome.errorCategory ?? 'unknown'}.`),
    consecutiveEmptyOrFailureCount: consecutiveCount,
    ...refresh,
    promotedAt:
      outcome.status === 'verified'
        ? (existing?.promotedAt ?? attemptedAt.toISOString())
        : (existing?.promotedAt ?? null),
  };
  return {
    ...state,
    updatedAt: attemptedAt.toISOString(),
    observations: [...state.observations.filter((item) => atsSourceKey(item) !== key), observation],
  };
}

const sourceImportSchema = z.object({
  version: z.literal(1),
  generatedAt: z.iso.datetime(),
  sources: z
    .array(
      z.object({
        company: z.string().trim().min(1),
        url: z.url().startsWith('https://'),
        evidence: z.string().trim().min(1),
      }),
    )
    .max(50_000),
});

export type AtsSourceImportRecord = {
  entry: AtsRosterEntry;
  evidence: string;
};

export type AtsSourceImportParseResult = {
  generatedAt: string;
  records: AtsSourceImportRecord[];
  invalidCount: number;
  duplicateCount: number;
};

export function parseAtsSourceObservationImport(input: unknown): AtsSourceImportParseResult {
  const parsed = sourceImportSchema.parse(input);
  const records: AtsSourceImportRecord[] = [];
  const seen = new Set<string>();
  let invalidCount = 0;
  let duplicateCount = 0;
  for (const source of parsed.sources) {
    const detected = detectAtsSource(source.url);
    if (
      detected === null ||
      !ATS_ROSTER_PROVIDERS.includes(detected.provider as AtsRosterProvider)
    ) {
      invalidCount += 1;
      continue;
    }
    const entry: AtsRosterEntry = {
      provider: detected.provider as AtsRosterProvider,
      slug: detected.boardIdentifier,
      baseUrl: detected.baseUrl,
      company: source.company,
    };
    const key = atsSourceKey(entry);
    if (seen.has(key)) {
      duplicateCount += 1;
      continue;
    }
    seen.add(key);
    records.push({ entry, evidence: source.evidence });
  }
  return { generatedAt: parsed.generatedAt, records, invalidCount, duplicateCount };
}
