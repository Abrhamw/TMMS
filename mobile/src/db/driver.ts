export interface RunResult {
  lastInsertRowId: number;
  changes: number;
}

export interface SqlDriver {
  exec(sql: string): Promise<void>;
  run(sql: string, params?: readonly unknown[]): Promise<RunResult>;
  all<T>(sql: string, params?: readonly unknown[]): Promise<T[]>;
  first<T>(sql: string, params?: readonly unknown[]): Promise<T | null>;
  transaction<T>(fn: () => Promise<T>): Promise<T>;
}
