import { sql, type Column, type SQL } from 'drizzle-orm';

const SAFE_JSON_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/u;

/**
 * SQLite equivalent of PostgreSQL's `coalesce(column, '{}'::jsonb) || patch`.
 *
 * PostgreSQL's `||` merges two JSON objects one level deep, replacing whole
 * top-level values. SQLite's `json_patch` would instead merge recursively (RFC
 * 7386), which is a different result whenever both sides hold an object under
 * the same key, so this builds one `json_set` per top-level key to reproduce
 * the original shallow-merge semantics exactly.
 *
 * Keys are restricted to plain identifiers because they are interpolated into
 * a JSON path literal; every current caller passes fixed, code-defined keys.
 */
export function mergeJsonObject(column: Column, patch: Record<string, unknown>): SQL {
  let expression: SQL = sql`coalesce(${column}, '{}')`;
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue;
    if (!SAFE_JSON_KEY.test(key)) {
      throw new Error(`Unsupported JSON merge key: ${key}`);
    }
    expression = sql`json_set(${expression}, ${sql.raw(`'$.${key}'`)}, json(${JSON.stringify(value)}))`;
  }
  return expression;
}
