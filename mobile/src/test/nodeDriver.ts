import { DatabaseSync } from 'node:sqlite';
import type { SqlDriver } from '../db/driver';

export function createNodeDriver(): SqlDriver {
  const db = new DatabaseSync(':memory:');
  return {
    exec: async (sql: string) => {
      db.exec(sql);
    },
    run: async (sql: string, params: readonly unknown[] = []) => {
      const result = db.prepare(sql).run(...(params as never[]));
      return {
        lastInsertRowId: Number(result.lastInsertRowid),
        changes: Number(result.changes),
      };
    },
    all: async <T>(sql: string, params: readonly unknown[] = []) =>
      db.prepare(sql).all(...(params as never[])) as T[],
    first: async <T>(sql: string, params: readonly unknown[] = []) =>
      (db.prepare(sql).get(...(params as never[])) as T | undefined) ?? null,
    transaction: async <T>(fn: () => Promise<T>) => {
      db.exec('BEGIN');
      try {
        const value = await fn();
        db.exec('COMMIT');
        return value;
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
    },
  };
}
