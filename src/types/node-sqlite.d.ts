declare module "node:sqlite" {
  export interface DatabaseSyncOptions {
    open?: boolean;
    readOnly?: boolean;
  }

  export interface StatementSync {
    get<T = unknown>(...params: unknown[]): T | undefined;
    all<T = unknown>(...params: unknown[]): T[];
    run(...params: unknown[]): { changes: number };
  }

  export class DatabaseSync {
    constructor(path?: string, options?: DatabaseSyncOptions);
    exec(sql: string): void;
    prepare(sql: string): StatementSync;
    close(): void;
  }
}
