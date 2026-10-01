import { chmodSync, existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { fileURLToPath } from 'node:url';
import * as schema from './schema.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export type WorkspaceDb = BetterSQLite3Database<typeof schema>;

/**
 * `workspace.db` holds a user's CV text, contact info, cover letters, application answers, and
 * full job-posting text in plaintext, unencrypted SQLite -- the single most sensitive store this
 * app owns. `better-sqlite3`'s `Database` constructor has no file-mode argument, and WAL mode's
 * own `-wal`/`-shm` sidecars are created by SQLite itself, not by this module's `writeFileSync`,
 * so neither can be locked down at creation the way `discoveryFilePath`'s `writeFileSync(...,
 * {mode: 0o600})` can. Chmod-ing every known artifact right after they exist is the only way to
 * get the same restrictive-by-construction guarantee this codebase's other sensitive stores
 * already have (`discovery-file.ts`, `application-queue-store.ts`). POSIX-only in effect: on
 * Windows these mode bits are a no-op and Electron's per-user `userData` directory is already
 * protected by NTFS ACL inheritance, same posture as `SECURITY.md` already documents for the
 * daemon's discovery file.
 */
function secureDatabaseFiles(databasePath: string): void {
  for (const candidate of [databasePath, `${databasePath}-wal`, `${databasePath}-shm`]) {
    if (existsSync(candidate)) chmodSync(candidate, 0o600);
  }
}

/**
 * Opens (creating if absent) the personal-workspace SQLite file under Electron's per-user app
 * data directory and applies migrations. Mirrors the pragmas vacancy-engine's client uses for the
 * same reasons: WAL for a single long-lived writer/reader in one process, foreign keys on since
 * this schema relies on `onDelete` behavior (e.g. deleting a CV nulls out `letters.cv_id`).
 */
export function createWorkspaceDb(userDataPath: string): { db: WorkspaceDb; close: () => void } {
  const databasePath = path.join(userDataPath, 'workspace.db');
  mkdirSync(userDataPath, { recursive: true, mode: 0o700 });
  const connection = new Database(databasePath);
  connection.pragma('journal_mode = WAL');
  connection.pragma('foreign_keys = ON');
  secureDatabaseFiles(databasePath);
  const db = drizzle(connection, { schema });
  migrate(db, { migrationsFolder: path.join(__dirname, 'drizzle') });
  secureDatabaseFiles(databasePath); // migrate() can (re)create the -wal/-shm sidecars again
  return { db, close: () => connection.close() };
}
