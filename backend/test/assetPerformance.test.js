const test = require('node:test');
const assert = require('node:assert');

const { evaluatePerformance, familyOf, READING_TYPES, EVENT_TYPES } = require('../assetPerformance');

const NOW = '2026-10-02T00:00:00.000Z';
const YOUNG = { id: 1, asset_id: 'AST-1', name: 'T1', asset_type: 'TRANSFORMER', installation_date: '2018-01-01T00:00:00.000Z', criticality: 'HIGH' };
const OLD = { id: 2, asset_id: 'AST-2', name: 'T2', asset_type: 'TRANSFORMER', installation_date: '1998-01-01T00:00:00.000Z', criticality: 'MEDIUM' };
const LINE = { id: 3, asset_id: 'AST-3', name: 'L1', asset_type: 'CONDUCTOR_SPAN', installation_date: '2018-01-01T00:00:00.000Z', criticality: 'HIGH' };

test('no performance data reproduces the age baseline with no delta', () => {
  const r = evaluatePerformance(YOUNG, [], [], { now: NOW });
  assert.strictEqual(r.performance_delta, 0);
  assert.strictEqual(r.combined_rating, r.base_rating);
  assert.strictEqual(r.factors.length, 0);
  assert.strictEqual(r.confidence, 'LOW');
});

test('nameplate overloading degrades the combined rating', () => {
  const reading = { reading_type: 'LOAD_PCT', value_num: 115, recorded_at: '2026-09-01T00:00:00.000Z' };
  const r = evaluatePerformance(YOUNG, [reading], [], { now: NOW });
  assert.ok(r.performance_delta < 0);
  assert.ok(r.combined_rating < r.base_rating);
  assert.ok(r.factors.some((f) => f.key === 'loading'));
  assert.strictEqual(r.confidence, 'HIGH');
});

test('loading thresholds are independent per asset category', () => {
  const loadAt = (asset, pct) => {
    const r = evaluatePerformance(asset, [{ reading_type: 'LOAD_PCT', value_num: pct, recorded_at: '2026-09-01T00:00:00.000Z' }], [], { now: NOW });
    return r.factors.find((f) => f.key === 'loading') || null;
  };
  assert.strictEqual(loadAt(YOUNG, 80), null);
  assert.strictEqual(loadAt(LINE, 70), null);
  assert.ok(loadAt(LINE, 80));
  assert.ok(loadAt(YOUNG, 90));
});

test('transformer loading cites declared MV capacity when present', () => {
  const rated = { ...YOUNG, metadata: JSON.stringify({ rating_mva: 120 }) };
  const reading = { reading_type: 'LOAD_PCT', value_num: 110, recorded_at: '2026-09-01T00:00:00.000Z' };
  const r = evaluatePerformance(rated, [reading], [], { now: NOW });
  const factor = r.factors.find((f) => f.key === 'loading');
  assert.ok(factor);
  assert.match(factor.reason, /120 MVA/);
});

test('through-fault events degrade a transformer', () => {
  const events = [
    { event_type: 'THROUGH_FAULT', severity: 'HIGH', occurred_at: '2026-08-01T00:00:00.000Z' },
    { event_type: 'THROUGH_FAULT', severity: 'MEDIUM', occurred_at: '2026-09-01T00:00:00.000Z' },
  ];
  const r = evaluatePerformance(YOUNG, [], events, { now: NOW });
  assert.ok(r.performance_delta < 0);
  assert.ok(r.factors.some((f) => f.key === 'faults'));
});

test('a numeric now produces finite factor contributions', () => {
  const events = [{ event_type: 'THROUGH_FAULT', severity: 'HIGH', occurred_at: new Date().toISOString() }];
  const r = evaluatePerformance(YOUNG, [], events, { now: Date.now() });
  const faults = r.factors.find((f) => f.key === 'faults');
  assert.ok(faults);
  assert.ok(Number.isFinite(faults.contribution));
});

test('combined rating is clamped to the 1-10 range', () => {
  const readings = [{ reading_type: 'LOAD_PCT', value_num: 200, recorded_at: '2026-09-01T00:00:00.000Z' }];
  const events = Array.from({ length: 8 }, () => ({ event_type: 'THROUGH_FAULT', severity: 'CRITICAL', occurred_at: '2026-09-01T00:00:00.000Z' }));
  const r = evaluatePerformance(OLD, readings, events, { now: NOW });
  assert.ok(r.combined_rating >= 1 && r.combined_rating <= 10);
  assert.ok(r.performance_delta >= -6);
});

test('families map to the right factor sets', () => {
  assert.strictEqual(familyOf({ asset_type: 'TRANSFORMER' }), 'TRANSFORMER');
  assert.strictEqual(familyOf({ asset_type: 'MV_CIRCUIT_BREAKER' }), 'BREAKER');
  assert.strictEqual(familyOf({ asset_type: 'CONDUCTOR_SPAN' }), 'LINE');
  assert.strictEqual(familyOf({ asset_type: 'TOWER' }), 'TOWER');
  assert.strictEqual(familyOf({ asset_type: 'SOMETHING_ELSE' }), 'GENERIC');
});

test('vocabularies are exposed for validation', () => {
  assert.ok(READING_TYPES.includes('LOAD_PCT'));
  assert.ok(EVENT_TYPES.includes('THROUGH_FAULT'));
});
