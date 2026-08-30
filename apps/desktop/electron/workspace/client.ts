import { mkdirSync } from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { fileURLToPath } from 'node:url';
import * as schema from './schema.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export type WorkspaceDb = BetterSQLite3Database<typeof schema>;

/**
 * Opens (creating if absent) the personal-workspace SQLite file under Electron's per-user app
 * data directory and applies migrations. Mirrors the pragmas vacancy-engine's client uses for the
 * same reasons: WAL for a single long-lived writer/reader in one process, foreign keys on since
 * this schema relies on `onDelete` behavior (e.g. deleting a CV nulls out `letters.cv_id`).
 */
export function createWorkspaceDb(userDataPath: string): { db: WorkspaceDb; close: () => void } {
  const databasePath = path.join(userDataPath, 'workspace.db');
  mkdirSync(userDataPath, { recursive: true });
  const connection = new Database(databasePath);
  connection.pragma('journal_mode = WAL');
  connection.pragma('foreign_keys = ON');
  const db = drizzle(connection, { schema });
  migrate(db, { migrationsFolder: path.join(__dirname, 'drizzle') });
  return { db, close: () => connection.close() };
}
