import { openExpoDriver } from './expoDriver';
import { migrate } from './schema';
import type { SqlDriver } from './driver';

let driverPromise: Promise<SqlDriver> | null = null;

export function getDb(): Promise<SqlDriver> {
  if (!driverPromise) {
    driverPromise = openExpoDriver()
      .then(async (driver) => {
        await migrate(driver);
        return driver;
      })
      .catch((error: unknown) => {
        driverPromise = null;
        throw error;
      });
  }
  return driverPromise;
}
