import { mkdirSync } from 'node:fs';
import path from 'node:path';

import SqliteDatabase, { type Database as SqliteConnection } from 'better-sqlite3';
import { sql } from 'drizzle-orm';
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';

import * as schema from './schema.js';

export type Database = BetterSQLite3Database<typeof schema>;

export type DatabaseClient = {
  db: Database;
  /** Underlying synchronous connection, exposed for pragmas and diagnostics. */
  connection: SqliteConnection;
  databasePath: string;
  /** Releases the embedded database file. Replaces the former pool teardown. */
  close: () => void;
};

function isInMemoryPath(databasePath: string): boolean {
  return databasePath === ':memory:' || databasePath.startsWith('file::memory:');
}

export function createDatabaseClient(databasePath: string): DatabaseClient {
  if (!isInMemoryPath(databasePath)) {
    mkdirSync(path.dirname(path.resolve(databasePath)), { recursive: true });
  }
  const connection = new SqliteDatabase(databasePath);
  // Write-ahead logging keeps readers from blocking the single writer, and
  // SQLite disables foreign keys by default while this schema depends on
  // cascade/restrict/set-null behaviour.
  connection.pragma('journal_mode = WAL');
  connection.pragma('foreign_keys = ON');
  connection.pragma('busy_timeout = 10000');

  return {
    db: drizzle(connection, { schema }),
    connection,
    databasePath,
    close: () => {
      connection.close();
    },
  };
}

export async function migrateDatabase(
  database: Database,
  migrationsFolder = 'drizzle',
): Promise<void> {
  migrate(database, { migrationsFolder });
}

const activeTransactions = new WeakSet<object>();
const transactionQueues = new WeakMap<object, Promise<unknown>>();
let savepointCounter = 0;

/**
 * Unwinds a failed transaction without masking the failure that caused it.
 *
 * SQLite may already have rolled the statement back itself, in which case the
 * explicit rollback reports that no transaction is active. That is not new
 * information, and the original error is the one worth surfacing.
 */
function unwind(database: Database, statements: readonly string[]): void {
  for (const statement of statements) {
    try {
      database.run(sql.raw(statement));
    } catch {
      // Already unwound by SQLite; keep the originating error.
    }
  }
}

/**
 * Runs an operation inside a single SQLite transaction.
 *
 * better-sqlite3 is synchronous, so drizzle-orm's own `database.transaction()`
 * refuses an async callback (better-sqlite3 throws "Transaction function cannot
 * return a promise" *after* already emitting the statements, silently losing
 * atomicity). This wrapper keeps the previous async repository call shape by
 * driving `begin immediate`/`commit`/`rollback` explicitly on the one embedded
 * connection.
 *
 * Because every caller shares that connection, overlapping top-level
 * transactions are queued rather than interleaved, which preserves the
 * isolation the pooled PostgreSQL client used to provide. A transaction opened
 * while another is already active on the same database nests through a
 * savepoint instead of deadlocking on the queue.
 */
export async function withTransaction<T>(
  database: Database,
  operation: (transaction: Database) => Promise<T>,
): Promise<T> {
  if (activeTransactions.has(database)) {
    savepointCounter += 1;
    const savepoint = `vacancy_engine_sp_${savepointCounter}`;
    database.run(sql.raw(`savepoint ${savepoint}`));
    try {
      const value = await operation(database);
      database.run(sql.raw(`release savepoint ${savepoint}`));
      return value;
    } catch (error) {
      unwind(database, [
        `rollback to savepoint ${savepoint}`,
        `release savepoint ${savepoint}`,
      ]);
      throw error;
    }
  }

  const previous = transactionQueues.get(database) ?? Promise.resolve();
  const running = previous.then(async () => {
    database.run(sql.raw('begin immediate'));
    activeTransactions.add(database);
    try {
      const value = await operation(database);
      activeTransactions.delete(database);
      database.run(sql.raw('commit'));
      return value;
    } catch (error) {
      activeTransactions.delete(database);
      unwind(database, ['rollback']);
      throw error;
    }
  });
  transactionQueues.set(
    database,
    running.then(
      () => undefined,
      () => undefined,
    ),
  );
  return running;
}
