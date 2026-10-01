import * as SQLite from 'expo-sqlite';
import type { SqlDriver } from './driver';

export async function openExpoDriver(name = 'tmms.db'): Promise<SqlDriver> {
  const db = await SQLite.openDatabaseAsync(name);
  await db.execAsync('PRAGMA journal_mode = WAL;');
  await db.execAsync('PRAGMA foreign_keys = ON;');

  return {
    exec: (sql) => db.execAsync(sql),
    run: async (sql, params = []) => {
      const result = await db.runAsync(sql, params as SQLite.SQLiteBindParams);
      return {
        lastInsertRowId: Number(result.lastInsertRowId),
        changes: Number(result.changes),
      };
    },
    all: (sql, params = []) => db.getAllAsync(sql, params as SQLite.SQLiteBindParams),
    first: (sql, params = []) => db.getFirstAsync(sql, params as SQLite.SQLiteBindParams),
    transaction: async <T>(fn: () => Promise<T>) => {
      let value: T | undefined;
      await db.withTransactionAsync(async () => {
        value = await fn();
      });
      return value as T;
    },
  };
}
