import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import type { AtsRosterEntry, AtsRosterProvider } from './ats-roster-source.js';

const ROSTER_FILE_RELATIVE_PATH = path.join('.data', 'ats-roster-v1.json');

/**
 * Gitignored (`.data/`, see root `.gitignore`), unlike `config/global-remote-profile-v1.json` and
 * `config/candidate-profile-v1.json`: those are hand-reviewed business config, while this file is a
 * bulk, regenerable mirror of an external roster refreshed by `pnpm --filter
 * @open-vacancy-radar/vacancy-engine exec node dist/cli.js ats-roster:import` (see `pipeline/ats-roster-import.ts`
 * and `cli.ts`), not something a person edits by hand.
 */
export function atsRosterFilePath(projectRoot: string): string {
  return path.resolve(projectRoot, ROSTER_FILE_RELATIVE_PATH);
}

export type AtsRosterFile = {
  version: 1;
  importedAt: string;
  sourceCounts: Partial<Record<AtsRosterProvider, number>>;
  entries: AtsRosterEntry[];
};

/**
 * Never throws for a missing roster file (the import step is a separate, deliberate action -- see
 * issue #251's non-goals -- so a scan running before the first import, or against a fresh checkout,
 * must not fail; it simply has no roster-sourced companies to scan yet). Any other read/parse
 * failure (a corrupted file) is surfaced, since silently discarding a broken roster would hide a real
 * bug rather than the expected "not imported yet" state.
 */
export async function loadAtsRoster(projectRoot: string): Promise<AtsRosterEntry[]> {
  const file = atsRosterFilePath(projectRoot);
  let raw: string;
  try {
    raw = await readFile(file, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  const parsed = JSON.parse(raw) as Partial<AtsRosterFile>;
  if (!Array.isArray(parsed.entries)) {
    throw new Error(`ATS roster file at ${file} does not contain a valid entries array`);
  }
  return parsed.entries;
}

export async function writeAtsRoster(
  projectRoot: string,
  entries: readonly AtsRosterEntry[],
  sourceCounts: Partial<Record<AtsRosterProvider, number>>,
  importedAt = new Date(),
): Promise<string> {
  const file = atsRosterFilePath(projectRoot);
  await mkdir(path.dirname(file), { recursive: true });
  const sorted = [...entries].sort(
    (left, right) => left.provider.localeCompare(right.provider) || left.slug.localeCompare(right.slug),
  );
  const payload: AtsRosterFile = {
    version: 1,
    importedAt: importedAt.toISOString(),
    sourceCounts,
    entries: sorted,
  };
  await writeFile(file, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  return file;
}
