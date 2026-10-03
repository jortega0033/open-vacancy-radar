import { access, rename } from 'node:fs/promises';
import { basename } from 'node:path';

/**
 * Recovery for a damaged local vacancy engine database (#441).
 *
 * The engine database holds only downloaded vacancies and the sponsor register. CVs, applications
 * and letters live in the separate workspace database, which nothing in this module opens, reads
 * or names: a rebuild moves one file family aside and asks for a new one, nothing more.
 */

export type VacancyEngineFailureCategory = 'corrupt' | 'locked' | 'migration_failed' | 'unknown';

/** Where in start-up the failure happened, which only matters when the error itself is not telling. */
export type VacancyEngineFailureStage = 'open' | 'migrate';

/**
 * What `vacancy:get-status` returns. `error` is the plain-language sentence, `details` the raw text
 * (data folder removed) that only a "Show technical details" disclosure may render.
 */
export type VacancyEngineStatus = {
  ready: boolean;
  error?: string;
  category?: VacancyEngineFailureCategory;
  canRebuild?: boolean;
  details?: string;
};

export type VacancyCacheRebuildResult =
  | { ok: true; retainedFileName: string; sponsorRefresh: 'ok' | 'failed'; sponsorError?: string }
  | { ok: false; reason: 'scan_running' | 'not_corrupt' | 'rebuild_failed'; detail: string };

export interface VacancyEngineFailure {
  category: VacancyEngineFailureCategory;
  /** Plain-language sentence for the person. Never contains SQL, a stack or a file path. */
  message: string;
  /** Whether "Rebuild job cache" is a safe answer. True for a confirmed corrupt database only. */
  canRebuild: boolean;
  /** Raw error text with the user's data folder removed, for "Show technical details" only. */
  details: string;
}

const CORRUPT_CODES = /^SQLITE_(CORRUPT|NOTADB)/u;
const CORRUPT_TEXT = /database disk image is malformed|file is not a database|SQLITE_CORRUPT|SQLITE_NOTADB/iu;
const LOCKED_CODES = /^SQLITE_(BUSY|LOCKED)/u;
const LOCKED_TEXT = /database is locked|SQLITE_BUSY|SQLITE_LOCKED/iu;

/**
 * Sorts a start-up error into the four recovery paths. Corrupt and locked are decided by the error
 * itself, because a damaged file surfaces mid-migration (a `CREATE INDEX` that cannot be applied)
 * and the stage alone would call that a migration problem. Only a failure that is neither falls
 * back to the stage, and anything unrecognised stays `unknown` so it is never offered a
 * destructive-looking fix.
 */
export function classifyVacancyEngineError(
  error: unknown,
  stage: VacancyEngineFailureStage,
): VacancyEngineFailureCategory {
  const texts: string[] = [];
  const codes: string[] = [];
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current instanceof Error; depth += 1) {
    texts.push(current.message);
    const code = (current as { code?: unknown }).code;
    if (typeof code === 'string') codes.push(code);
    current = (current as { cause?: unknown }).cause;
  }
  if (codes.some((code) => CORRUPT_CODES.test(code)) || texts.some((text) => CORRUPT_TEXT.test(text))) return 'corrupt';
  if (codes.some((code) => LOCKED_CODES.test(code)) || texts.some((text) => LOCKED_TEXT.test(text))) return 'locked';
  return stage === 'migrate' ? 'migration_failed' : 'unknown';
}

const MESSAGES: Record<VacancyEngineFailureCategory, string> = {
  corrupt:
    'The local job cache is damaged and cannot be opened. It only holds downloaded vacancies and the sponsor register. Your CVs, applications and letters are stored separately and are safe.',
  locked:
    'The local job cache is in use by another process. Close any other copy of this app or a running command-line scan, then check again.',
  migration_failed:
    'The local job cache could not be updated to this version of the app. Your CVs, applications and letters are stored separately and are not affected.',
  unknown:
    'The local job cache could not be started. Your CVs, applications and letters are stored separately and are not affected.',
};

/** Removes the user's data folder from raw error text so a path never reaches the screen unasked. */
export function redactTechnicalDetails(raw: string, dataDirs: readonly string[]): string {
  let text = raw;
  for (const dir of dataDirs) {
    if (dir.length === 0) continue;
    text = text.split(dir).join('<data folder>');
  }
  return text;
}

export function describeVacancyEngineFailure(
  error: unknown,
  stage: VacancyEngineFailureStage,
  dataDirs: readonly string[],
): VacancyEngineFailure {
  const category = classifyVacancyEngineError(error, stage);
  const raw = error instanceof Error ? error.message : String(error);
  return {
    category,
    message: MESSAGES[category],
    canRebuild: category === 'corrupt',
    details: redactTechnicalDetails(raw, dataDirs),
  };
}

const SIDE_CARS = ['-wal', '-shm'] as const;

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

export interface SetAsideResult {
  /** Final file name of the retained copy (never a full path). */
  retainedFileName: string;
  /** Moves the retained files back where they were. Used only to undo a rebuild that failed. */
  restore: () => Promise<void>;
}

/**
 * Renames the database and its write-ahead sidecars to a name that does not exist yet. It renames
 * and never deletes, and it never overwrites: a second rebuild gets `-2`, a third `-3`, so the first
 * retained copy is still there afterwards.
 */
export async function setAsideDamagedDatabase(databasePath: string, now: Date): Promise<SetAsideResult> {
  const stamp = now.toISOString().replace(/[:.]/gu, '-');
  let suffix = `.damaged-${stamp}`;
  for (let attempt = 2; attempt < 1000; attempt += 1) {
    const taken = await Promise.all(['', ...SIDE_CARS].map((tail) => exists(`${databasePath}${tail}${suffix}`)));
    if (!taken.some(Boolean)) break;
    suffix = `.damaged-${stamp}-${attempt}`;
  }

  const moved: Array<[from: string, to: string]> = [];
  async function restore(): Promise<void> {
    for (const [from, to] of [...moved].reverse()) {
      await rename(to, from);
    }
    moved.length = 0;
  }

  try {
    for (const tail of ['', ...SIDE_CARS]) {
      const from = `${databasePath}${tail}`;
      if (!(await exists(from))) continue;
      const to = `${from}${suffix}`;
      await rename(from, to);
      moved.push([from, to]);
    }
  } catch (error) {
    await restore();
    throw error;
  }
  if (moved.length === 0) throw new Error('there is no job cache file to set aside');

  return { retainedFileName: basename(moved[0]![1]), restore };
}

export interface RebuildOptions {
  databasePath: string;
  now: () => Date;
  /** Creates and migrates the new database at `databasePath`. */
  createFresh: () => Promise<void>;
  /** Removes whatever a failed `createFresh` left at `databasePath`, so the old file can go back. */
  discardFresh: () => Promise<void>;
  /**
   * Best-effort refresh of the sponsor register into the fresh database. Its failure never undoes
   * the rebuild: the fresh cache is already usable, and the damaged copy is already safe.
   */
  refreshSponsors: () => Promise<void>;
}

export type RebuildOutcome =
  | { ok: true; retainedFileName: string; sponsorRefresh: 'ok' | 'failed'; sponsorError?: string }
  | { ok: false; detail: string };

/**
 * Sets the damaged file aside, builds a fresh database, then refreshes the sponsor register.
 *
 * If the fresh database cannot be created, the new partial files are discarded and the damaged file
 * is renamed back, leaving the machine exactly as it was.
 */
export async function rebuildVacancyEngineDatabase(options: RebuildOptions): Promise<RebuildOutcome> {
  let aside: SetAsideResult;
  try {
    aside = await setAsideDamagedDatabase(options.databasePath, options.now());
  } catch (error) {
    return { ok: false, detail: `could not set the damaged job cache aside: ${error instanceof Error ? error.message : String(error)}` };
  }

  try {
    await options.createFresh();
  } catch (error) {
    let restored = true;
    try {
      await options.discardFresh();
      await aside.restore();
    } catch {
      restored = false;
    }
    return {
      ok: false,
      detail: `could not build a fresh job cache: ${error instanceof Error ? error.message : String(error)}${restored ? '' : '. The damaged copy was kept next to it.'}`,
    };
  }

  try {
    await options.refreshSponsors();
    return { ok: true, retainedFileName: aside.retainedFileName, sponsorRefresh: 'ok' };
  } catch (error) {
    return {
      ok: true,
      retainedFileName: aside.retainedFileName,
      sponsorRefresh: 'failed',
      sponsorError: error instanceof Error ? error.message : String(error),
    };
  }
}
