import type { SqlDriver } from '../db/driver';
import { enqueue } from '../db/outbox';

export interface QueueGpsInput {
  targetType: string;
  targetId: number;
  measuredLat: number;
  measuredLng: number;
  expectedLat?: number | null;
  expectedLng?: number | null;
  accuracyM?: number | null;
  toleranceM?: number | null;
  regionId?: number | null;
  validatedAt?: string;
}

export async function queueGps(driver: SqlDriver, input: QueueGpsInput): Promise<void> {
  await enqueue(driver, {
    type: 'gps',
    entity: `gps:${input.targetType}:${input.targetId}`,
    payload: {
      target_type: input.targetType,
      target_id: input.targetId,
      expected_lat: input.expectedLat ?? input.measuredLat,
      expected_lng: input.expectedLng ?? input.measuredLng,
      measured_lat: input.measuredLat,
      measured_lng: input.measuredLng,
      accuracy_m: input.accuracyM ?? null,
      tolerance_m: input.toleranceM ?? null,
      region_id: input.regionId ?? null,
      validated_at: input.validatedAt ?? new Date().toISOString(),
    },
  });
}
