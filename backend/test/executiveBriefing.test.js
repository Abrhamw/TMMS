const test = require('node:test');
const assert = require('node:assert');

const {
  regionEffectiveness,
  summarizeRegion,
  buildRegionLoad,
  buildInterventions,
  valueConcentration,
} = require('../summary');

test('regionEffectiveness combines availability, delivery and condition', () => {
  const r = regionEffectiveness({
    lines: [{ operational_status: 'ENERGIZED' }, { operational_status: 'DE_ENERGIZED' }],
    substations: [{ operational_status: 'OPERATIONAL' }],
    tasks: [{ status: 'COMPLETED' }, { status: 'OPEN' }],
    assets: [{ condition_rating: 8 }, { condition_rating: 4 }],
  });
  assert.strictEqual(r.availability, 67);
  assert.strictEqual(r.delivery, 50);
  assert.strictEqual(r.condition, 60);
  assert.strictEqual(r.index, 60);
});

test('regionEffectiveness renormalises when a component has no denominator', () => {
  const r = regionEffectiveness({
    lines: [{ operational_status: 'ENERGIZED' }],
    substations: [{ operational_status: 'OPERATIONAL' }],
    tasks: [],
    assets: [{ condition_rating: 10 }, { condition_rating: 10 }],
  });
  assert.strictEqual(r.delivery, null);
  assert.strictEqual(r.availability, 100);
  assert.strictEqual(r.condition, 100);
  assert.strictEqual(r.index, 100);
});

test('summarizeRegion reports substation, line and effectiveness detail', () => {
  const region = { id: 1, code: 'NE', name: 'North East' };
  const r = summarizeRegion(region, {
    substations: [
      { id: 11, region_id: 1, voltage_levels: JSON.stringify(['220kV', '138kV']), operational_status: 'OPERATIONAL' },
      { id: 12, region_id: 1, voltage_levels: JSON.stringify(['138kV']), operational_status: 'MAINTENANCE' },
    ],
    lines: [
      { id: 21, region_id: 1, voltage_kv: 220, length_km: 42, circuit_count: 2, operational_status: 'ENERGIZED' },
      { id: 22, region_id: 1, voltage_kv: 138, length_km: 8, circuit_count: 1, operational_status: 'ENERGIZED' },
    ],
    assets: [{ condition_rating: 9 }, { condition_rating: 2 }],
    tasks: [{ status: 'COMPLETED' }],
    bayCountOf: (id) => (id === 11 ? 8 : 4),
  });
  assert.strictEqual(r.id, 1);
  assert.strictEqual(r.substations.count, 2);
  assert.strictEqual(r.substations.total_bays, 12);
  assert.strictEqual(r.substations.avg_bays, 6);
  assert.strictEqual(r.substations.by_voltage['220 kV'], 1);
  assert.strictEqual(r.substations.by_voltage['138 kV'], 2);
  assert.strictEqual(r.substations.by_status.OPERATIONAL, 1);
  assert.strictEqual(r.lines.count, 2);
  assert.strictEqual(r.lines.route_km, 50);
  assert.strictEqual(r.lines.circuit_km, 92);
  assert.strictEqual(r.lines.by_voltage['220 kV'].count, 1);
  assert.strictEqual(r.lines.by_voltage['220 kV'].km, 42);
  assert.strictEqual(r.assets.condition.critical, 1);
  assert.strictEqual(r.assets.condition.good, 1);
  assert.strictEqual(r.effectiveness.availability, 75);
  assert.strictEqual(r.effectiveness.delivery, 100);
  assert.strictEqual(r.effectiveness.condition, 55);
  assert.strictEqual(r.effectiveness.index, 77);
});

test('buildRegionLoad maps each region through its context accessors', () => {
  const regions = [{ id: 1, name: 'A' }, { id: 2, name: 'B' }];
  const r = buildRegionLoad(regions, {
    substationsFor: (id) => (id === 1 ? [{ id: 10, region_id: 1, voltage_levels: ['500kV'], operational_status: 'OPERATIONAL' }] : []),
    linesFor: () => [],
    assetsFor: () => [],
    tasksFor: () => [],
    bayCountOf: () => 3,
  });
  assert.strictEqual(r.length, 2);
  assert.strictEqual(r[0].substations.total_bays, 3);
  assert.strictEqual(r[1].substations.count, 0);
  assert.strictEqual(r[1].effectiveness.index, null);
});

test('buildInterventions de-duplicates by asset and keeps the strongest action', () => {
  const rows = buildInterventions([
    { asset_id: 1, asset_code: 'A1', action: 'REPAIR', current_rating: 2, reason: 'Critical condition' },
    { asset_id: 1, asset_code: 'A1', action: 'REPLACE', current_rating: 2, reason: 'Renewal' },
    { asset_id: 2, asset_code: 'A2', action: 'UPGRADE', current_rating: 6, reason: 'Degrading' },
    { asset_id: 3, asset_code: 'A3', action: 'REPAIR', current_rating: 5, reason: 'Poor condition' },
  ]);
  assert.strictEqual(rows.length, 3);
  const byCode = Object.fromEntries(rows.map((row) => [row.asset_code, row]));
  assert.strictEqual(byCode.A1.action, 'REPLACE');
  assert.strictEqual(byCode.A1.urgency, 'high');
  assert.strictEqual(byCode.A2.urgency, 'medium');
  assert.strictEqual(byCode.A3.urgency, 'low');
  assert.strictEqual(rows[0].urgency, 'high');
});

test('buildInterventions ignores unknown actions and honours the limit', () => {
  const candidates = Array.from({ length: 5 }, (_, i) => ({
    asset_id: i + 1, asset_code: `A${i + 1}`, action: 'REPAIR', current_rating: 5,
  }));
  candidates.push({ asset_id: 99, action: 'DELETE', current_rating: 1 });
  const rows = buildInterventions(candidates, { limit: 3 });
  assert.strictEqual(rows.length, 3);
  assert.ok(rows.every((row) => row.action === 'REPAIR'));
});

test('valueConcentration ranks buckets and reports top shares', () => {
  const c = valueConcentration([
    { label: 'A', value: 50 },
    { label: 'B', value: 30 },
    { label: 'C', value: 20 },
  ]);
  assert.strictEqual(c.total, 100);
  assert.strictEqual(c.count, 3);
  assert.strictEqual(c.top[0].label, 'A');
  assert.strictEqual(c.top[0].share, 0.5);
  assert.strictEqual(c.top_share, 0.5);
  assert.strictEqual(c.top5_share, 1);
});

test('valueConcentration is zero-safe and coerces missing values', () => {
  const empty = valueConcentration([]);
  assert.strictEqual(empty.total, 0);
  assert.strictEqual(empty.top_share, 0);
  assert.strictEqual(empty.top5_share, 0);
  assert.deepStrictEqual(empty.top, []);

  const c = valueConcentration([{ label: null, value: 'n/a' }, { value: 10 }]);
  assert.strictEqual(c.total, 10);
  assert.strictEqual(c.top[0].label, 'Unspecified');
  assert.strictEqual(c.top[0].share, 1);
});
