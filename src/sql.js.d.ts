declare module 'sql.js' {
  interface SqlJsStatic {
    Database: new (data?: ArrayLike<number>) => SqlJsDatabase;
  }
  interface SqlJsDatabase {
    run(sql: string, params?: unknown[]): void;
    exec(sql: string): { columns: string[]; values: unknown[][] }[];
    getRowsModified(): number;
    prepare(sql: string): SqlJsStatement;
    export(): Uint8Array;
    close(): void;
  }
  interface SqlJsStatement {
    bind(params?: unknown[]): void;
    step(): boolean;
    getAsObject(): Record<string, unknown>;
    free(): void;
  }
  function initSqlJs(): Promise<SqlJsStatic>;
  export = initSqlJs;
}
