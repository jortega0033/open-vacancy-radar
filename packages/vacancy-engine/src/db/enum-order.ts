import { sql, type Column, type SQL } from 'drizzle-orm';

/**
 * PostgreSQL enum columns sort by their declaration order, which several
 * status lists relied on to report workflow progression rather than the
 * alphabet. SQLite stores the same values as plain text and sorts them
 * lexicographically, so the declared order is rebuilt explicitly here.
 */
export function declaredEnumOrder(column: Column, values: readonly string[]): SQL {
  let expression = sql`case`;
  values.forEach((value, index) => {
    expression = sql`${expression} when ${column} = ${value} then ${index}`;
  });
  return sql`(${expression} else ${values.length} end)`;
}
