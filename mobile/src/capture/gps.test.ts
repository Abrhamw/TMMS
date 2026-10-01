import { beforeEach, describe, expect, it } from 'vitest';
import { createNodeDriver } from '../test/nodeDriver';
import type { SqlDriver } from '../db/driver';
import { listOutbox } from '../db/outbox';
import { migrate } from '../db/schema';
import { queueGps } from './gps';

describe('gps capture', () => {
  let driver: SqlDriver;

  beforeEach(async () => {
    driver = createNodeDriver();
    await migrate(driver);
  });

  it('queues a bulk validation with the measured point as the fallback target', async () => {
    await queueGps(driver, {
      targetType: 'ASSET',
      targetId: 701,
      measuredLat: 9.02,
      measuredLng: 38.74,
      accuracyM: 5,
    });

    const items = await listOutbox(driver, ['pending']);
    expect(items).toHaveLength(1);
    expect(items[0]?.type).toBe('gps');
    const payload = JSON.parse(items[0]!.payload) as Record<string, unknown>;
    expect(payload.target_type).toBe('ASSET');
    expect(payload.target_id).toBe(701);
    expect(payload.expected_lat).toBe(9.02);
    expect(payload.measured_lng).toBe(38.74);
  });

  it('keeps an explicit expected location when supplied', async () => {
    await queueGps(driver, {
      targetType: 'TOWER',
      targetId: 12,
      measuredLat: 9.5,
      measuredLng: 38.9,
      expectedLat: 9.51,
      expectedLng: 38.91,
    });

    const items = await listOutbox(driver, ['pending']);
    const payload = JSON.parse(items[0]!.payload) as Record<string, unknown>;
    expect(payload.expected_lat).toBe(9.51);
    expect(payload.expected_lng).toBe(38.91);
  });
});
