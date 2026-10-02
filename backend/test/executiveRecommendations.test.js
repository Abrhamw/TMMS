const test = require('node:test');
const assert = require('node:assert');

const { buildRecommendations } = require('../executiveRecommendations');

test('empty inputs return no recommendations', () => {
  assert.deepStrictEqual(buildRecommendations({}), []);
});

test('many overdue tasks rank high and come first', () => {
  const recs = buildRecommendations({
    overdue_tasks: Array.from({ length: 6 }, (_, i) => ({ id: i + 1, task_number: `TK-${i}`, due_date: `2026-09-0${i + 1}`, priority: 'HIGH' })),
    equipment: { missed: 2, tasks_with_gaps: 1 },
  });
  assert.strictEqual(recs[0].id, 'overdue-work');
  assert.strictEqual(recs[0].severity, 'high');
});

test('critical low-condition assets escalate severity', () => {
  const recs = buildRecommendations({ low_condition: [{ asset_id: 'A1', condition_rating: 2 }] });
  assert.strictEqual(recs[0].id, 'low-condition');
  assert.strictEqual(recs[0].severity, 'high');
});

test('degradation signals map to severity by delta', () => {
  const recs = buildRecommendations({
    degradation: [
      { asset_id: 10, asset_code: 'A-10', delta: -4, recommendation: 'REPLACE' },
      { asset_id: 11, asset_code: 'A-11', performance_delta: -1, recommendation: 'MONITOR' },
    ],
  });
  const ids = recs.map((r) => r.id);
  assert.ok(ids.includes('degradation-10'));
  assert.ok(ids.includes('degradation-11'));
  const high = recs.find((r) => r.id === 'degradation-10');
  assert.strictEqual(high.severity, 'high');
  assert.strictEqual(recs.find((r) => r.id === 'degradation-11').severity, 'low');
});

test('recommendations are unique by id', () => {
  const recs = buildRecommendations({
    overdue_tasks: [{ id: 1, task_number: 'TK-1', due_date: '2026-01-01', priority: 'HIGH' }],
    equipment: { missed: 1, tasks_with_gaps: 1 },
  });
  const ids = recs.map((r) => r.id);
  assert.strictEqual(new Set(ids).size, ids.length);
});

test('cost concentration only fires above the threshold', () => {
  assert.deepStrictEqual(buildRecommendations({ cost_concentration: [{ owner: 'X', spend: 100 }], total_spend: 1000 }), []);
  const recs = buildRecommendations({ cost_concentration: [{ owner: 'X', spend: 800 }], total_spend: 1000 });
  assert.strictEqual(recs[0].id, 'cost-concentration');
});

test('ordering prefers higher severity then larger impact', () => {
  const recs = buildRecommendations({
    overdue_tasks: [{ id: 1, task_number: 'TK-1', due_date: '2026-01-01', priority: 'LOW' }],
    expired_certifications: [{ id: 1 }],
    cost_concentration: [{ owner: 'X', spend: 400, share: 40 }],
    total_spend: 1000,
  });
  const ranks = recs.map((r) => r.severity);
  const order = { high: 0, medium: 1, low: 2 };
  for (let i = 1; i < ranks.length; i += 1) {
    assert.ok(order[ranks[i - 1]] <= order[ranks[i]]);
  }
});

test('certifications without expiry signals produce nothing', () => {
  assert.deepStrictEqual(buildRecommendations({ expired_certifications: [], expiring_certifications: [] }), []);
});
