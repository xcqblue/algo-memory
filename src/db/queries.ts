/**
 * algo-memory v2.2.3 - Database Query Helpers
 */

export interface SqlJsDatabase {
  run(sql: string, params?: unknown[]): void;
  getRowsModified(): number;
  prepare(sql: string): SqlJsStatement;
  export(): Uint8Array;
  close(): void;
}

export interface SqlJsStatement {
  bind(params?: unknown[]): void;
  step(): boolean;
  getAsObject(): Record<string, unknown>;
  free(): void;
}

export interface AnyDatabase {
  run(sql: string, params?: unknown[]): void;
  getRowsModified(): number;
  prepare(sql: string): SqlJsStatement;
}

export type DbLike = {
  run(sql: string, params?: unknown[]): void;
  getRowsModified(): number;
  prepare(sql: string): SqlJsStatement;
};

/**
 * Execute a query and return all rows as objects.
 */
export function queryAll(db: DbLike, sql: string, params: unknown[] = []): Record<string, unknown>[] {
  try {
    const stmt = db.prepare(sql);
    if (params.length > 0) stmt.bind(params);
    const results: Record<string, unknown>[] = [];
    while (stmt.step()) {
      results.push(stmt.getAsObject());
    }
    stmt.free();
    return results;
  } catch (err) {
    return [];
  }
}

/**
 * Execute a query and return the first row as an object.
 */
export function queryOne(db: DbLike, sql: string, params: unknown[] = []): Record<string, unknown> | null {
  const results = queryAll(db, sql, params);
  return results.length > 0 ? results[0] : null;
}

/**
 * Execute an INSERT/UPDATE/DELETE statement.
 * Returns number of affected rows; logs errors instead of throwing so callers
 * can remain unaware of SQL failures (they treat any falsy return as "no effect").
 */
export function run(db: DbLike, sql: string, params: unknown[] = []): number {
  try {
    db.run(sql, params);
    return db.getRowsModified();
  } catch (err) {
    // Log but don't throw — callers that check the return value still work as-is,
    // and callers that ignore it won't crash the plugin on transient SQL errors.
    console.error('[algo-memory] SQL execution error:', err);
    return 0;
  }
}

/**
 * Strict version: throws on SQL error instead of swallowing it.
 * Use when continuing past a failure would be wrong (e.g. INSERT after validation).
 */
export function runOrThrow(db: DbLike, sql: string, params: unknown[] = []): number {
  try {
    db.run(sql, params);
    return db.getRowsModified();
  } catch (err) {
    throw err;
  }
}
