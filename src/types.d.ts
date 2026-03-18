// 类型声明文件 - 解决模块导入类型问题
declare module 'lru-cache' {
  export default class LRUCache<K, V> {
    constructor(options?: { max?: number; ttl?: number });
    get(key: K): V | undefined;
    set(key: K, value: V): void;
    delete(key: K): boolean;
    has(key: K): boolean;
    clear(): void;
  }
}

declare module 'sql.js' {
  export interface Database {
    run(sql: string, params?: any[]): void;
    exec(sql: string): void;
    prepare(sql: string): Statement;
    export(): Uint8Array;
    close(): void;
    getRowsModified(): number;
  }

  export interface Statement {
    bind(params?: any[]): boolean;
    step(): boolean;
    getAsObject(params?: any): any;
    free(): boolean;
  }

  export interface SqlJsStatic {
    Database: new (data?: ArrayLike<number> | Buffer | null) => Database;
  }

  export default function initSqlJs(): Promise<SqlJsStatic>;
}
