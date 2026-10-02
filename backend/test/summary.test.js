const test = require('node:test');
const assert = require('node:assert');

const {
  conditionDistribution,
  costComposition,
  fillMonths,
  crewReadiness,
  certificationReadiness,
} = require('../summary');

test('conditionDistribution buckets ratings and ignores nulls', () => {
  const assets = [
    { condition_rating: 2 }, { condition_rating: 3 },
    { condition_rating: 4 }, { condition_rating: 5 },
    { condition_rating: 6 }, { condition_rating: 7 },
    { condition_rating: 8 }, { condition_rating: 10 },
    { condition_rating: null }, {},
  ];
  const r = conditionDistribution(assets);
  assert.deepStrictEqual(r, { critical: 2, poor: 2, fair: 2, good: 2, assessed: 8, total: 10 });
});

test('conditionDistribution handles an empty list', () => {
  assert.deepStrictEqual(conditionDistribution([]), { critical: 0, poor: 0, fair: 0, good: 0, assessed: 0, total: 0 });
});

test('costComposition maps event types into four buckets', () => {
  const r = costComposition([
    { event_type: 'PREVENTIVE', count: 7, spend: 164040 },
    { event_type: 'INSPECTION', count: 5, spend: 33522 },
    { event_type: 'CORRECTIVE', count: 5, spend: 90844 },
    { event_type: 'REPAIR', count: 2, spend: 82000 },
    { event_type: 'EMERGENCY', count: 4, spend: 7890 },
    { event_type: 'REPLACEMENT', count: 1, spend: 0 },
    { event_type: 'UNKNOWN', count: 9, spend: 9999 },
  ]);
  assert.strictEqual(r.total, 378296);
  const by = Object.fromEntries(r.buckets.map((b) => [b.key, b]));
  assert.strictEqual(by.planned.spend, 197562);
  assert.strictEqual(by.unplanned.spend, 172844);
  assert.strictEqual(by.emergency.spend, 7890);
  assert.strictEqual(by.capital.spend, 0);
  assert.strictEqual(r.buckets.length, 4);
});

test('fillMonths returns exactly N zero-filled months ending at now', () => {
  const r = fillMonths([{ month: '2026-09', spend: 50 }], '2026-10-15T00:00:00.000Z', { months: 3, value: 'spend' });
  assert.deepStrictEqual(r, [
    { month: '2026-08', spend: 0 },
    { month: '2026-09', spend: 50 },
    { month: '2026-10', spend: 0 },
  ]);
});

test('fillMonths defaults to 12 months', () => {
  const r = fillMonths([], '2026-10-15T00:00:00.000Z', { value: 'spend' });
  assert.strictEqual(r.length, 12);
  assert.strictEqual(r[11].month, '2026-10');
});

test('crewReadiness counts active and available', () => {
  const r = crewReadiness([
    { status: 'AVAILABLE' }, { status: 'ON_TASK' }, { status: 'ON_TASK' }, { status: 'OFF_DUTY' },
  ]);
  assert.deepStrictEqual(r, { total: 4, active: 3, available: 1, percent: 75 });
});

test('crewReadiness returns null percent with no crews', () => {
  assert.strictEqual(crewReadiness([]).percent, null);
});

test('certificationReadiness classifies valid, expiring and expired', () => {
  const now = '2026-10-02T00:00:00.000Z';
  const r = certificationReadiness([
    { status: 'VALID', expires_at: '2027-01-01T00:00:00.000Z' },
    { status: 'VALID', expires_at: '2026-11-01T00:00:00.000Z' },
    { status: 'VALID', expires_at: '2026-01-01T00:00:00.000Z' },
    { status: 'REVOKED', expires_at: '2026-01-01T00:00:00.000Z' },
  ], now);
  assert.strictEqual(r.total, 4);
  assert.strictEqual(r.valid, 2);
  assert.strictEqual(r.expiring, 1);
  assert.strictEqual(r.expired, 1);
  assert.strictEqual(r.percent, 50);
});

test('certificationReadiness returns null percent with no certifications', () => {
  assert.strictEqual(certificationReadiness([], '2026-10-02T00:00:00.000Z').percent, null);
});
