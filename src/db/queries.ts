/**
 * Database query wrappers — compatible with better-sqlite3 API.
 * better-sqlite3 is fully synchronous, no async/await needed.
 * Persistence is automatic (SQLite writes to disk directly).
 */

import { type Database as DatabaseType } from 'better-sqlite3';

// Re-export for use in other modules
export type DbLike = DatabaseType;
export type SqlJsDatabase = DbLike;
export type AnyDatabase = DbLike;

// Convert a raw row (array) to an object keyed by column names
function rowToObject(row: unknown[], cols: string[]): Record<string, unknown> {
  const obj: Record<string, unknown> = {};
  cols.forEach((col: string, i: number) => { obj[col] = row[i]; });
  return obj;
}

/**
 * Run a SELECT query, return all rows as objects.
 * @example queryAll(db, 'SELECT * FROM memories WHERE id = ?', ['mem_abc'])
 */
export function queryAll(db: DbLike, sql: string, params: unknown[] = []): Record<string, unknown>[] {
  try {
    const stmt = db.prepare(sql);
    stmt.bind(params as []);
    const cols = stmt.columns().map(c => c.name);
    const rows: Record<string, unknown>[] = [];
    // better-sqlite3: iterate over results with stmt.step() equivalent via get()
    // Use all() directly for simple case
    const results = stmt.all() as unknown[][];
    for (const row of results) {
      rows.push(rowToObject(row, cols));
    }
    return rows;
  } catch (err) {
    console.error('[algo-memory] SQL query error:', err);
    return [];
  }
}

/**
 * Run a SELECT query, return the first row as an object (or null).
 */
export function queryOne(db: DbLike, sql: string, params: unknown[] = []): Record<string, unknown> | null {
  try {
    const stmt = db.prepare(sql);
    stmt.bind(params as []);
    const cols = stmt.columns().map(c => c.name);
    const row = stmt.get() as unknown[] | undefined;
    return row ? rowToObject(row, cols) : null;
  } catch (err) {
    console.error('[algo-memory] SQL query error:', err);
    return null;
  }
}

/**
 * Execute an INSERT/UPDATE/DELETE statement.
 * Returns number of affected rows.
 */
export function run(db: DbLike, sql: string, params: unknown[] = []): number {
  try {
    const result = db.prepare(sql).run(...(params as []));
    return result.changes;
  } catch (err) {
    console.error('[algo-memory] SQL execution error:', err);
    return 0;
  }
}

/**
 * Strict version: throws on SQL error instead of swallowing it.
 * Use when continuing past a failure would be wrong (e.g. INSERT after validation).
 */
export function runOrThrow(db: DbLike, sql: string, params: unknown[] = []): number {
  const result = db.prepare(sql).run(...(params as []));
  return result.changes;
}
