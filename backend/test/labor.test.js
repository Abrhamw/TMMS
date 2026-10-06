process.env.TMMS_DB = require('node:path').join(require('node:os').tmpdir(), `tmms-labor-${process.pid}-${Date.now()}.db`);

const test = require('node:test');
const assert = require('node:assert');

const { initSchema } = require('../db');
const { insertRow } = require('../util');
initSchema();

const { computeHours, costFor, resolveRate, taskLaborSummary } = require('../labor');

test('computeHours uses explicit hours and deducts breaks', () => {
  assert.strictEqual(computeHours({ hours: 8, break_minutes: 60 }), 7);
  assert.strictEqual(computeHours({ hours: '6.5', break_minutes: 30 }), 6);
});

test('computeHours derives hours from a start/end span', () => {
  assert.strictEqual(computeHours({ started_at: '2026-10-06T08:00:00.000Z', ended_at: '2026-10-06T16:30:00.000Z', break_minutes: 30 }), 8);
});

test('computeHours clamps nonsensical spans to zero, never negative', () => {
  assert.strictEqual(computeHours({ started_at: '2026-10-06T16:00:00.000Z', ended_at: '2026-10-06T08:00:00.000Z' }), 0);
  assert.strictEqual(computeHours({ hours: 1, break_minutes: 600 }), 0);
  assert.strictEqual(computeHours({}), 0);
});

test('costFor multiplies hours by rate and rounds to cents', () => {
  assert.strictEqual(costFor(7, { hourly_rate: 12.5 }), 87.5);
  assert.strictEqual(costFor(1, { hourly_rate: 33.3333 }), 33.33);
  assert.strictEqual(costFor(2, null), null);
});

test('resolveRate picks the rate in force and falls back to the global default', () => {
  const personId = insertRow('person', { first_name: 'Rate', last_name: 'Test', role: 'STAFF', active: 1 });
  const mk = (from, rate, forPerson) => insertRow('labor_rate', {
    person_id: forPerson ? personId : null, currency: 'USD', hourly_rate: rate,
    effective_from: from, created_at: new Date().toISOString(),
  });
  mk('2025-01-01', 5, false);
  mk('2026-01-01', 10, true);
  mk('2026-06-01', 12, true);

  assert.strictEqual(resolveRate(personId, '2025-06-01T00:00:00.000Z').hourly_rate, 5);
  assert.strictEqual(resolveRate(personId, '2026-03-01T00:00:00.000Z').hourly_rate, 10);
  assert.strictEqual(resolveRate(personId, '2026-07-01T00:00:00.000Z').hourly_rate, 12);
  assert.strictEqual(resolveRate(999999, '2025-06-01T00:00:00.000Z').hourly_rate, 5);
});

test('taskLaborSummary counts approved actuals and groups by person and kind', () => {
  const personId = insertRow('person', { first_name: 'Sum', last_name: 'Test', role: 'STAFF', active: 1 });
  const regionId = insertRow('region', { code: 'LAB-R', name: 'Labor', type: 'CUSTOM', center_lat: 0, center_lng: 0, boundary: 1, status: 'ACTIVE', timezone: 'UTC' });
  const now = new Date().toISOString();
  const taskId = insertRow('task', {
    task_number: 'TK-2026-700001', title: 'Labor task', task_type: 'INSPECTION', priority: 'LOW',
    status: 'IN_PROGRESS', region_id: regionId, due_date: now, created_at: now, updated_at: now, source: 'MANUAL',
  });
  const entry = (hours, cost, status, kind) => insertRow('time_entry', {
    task_id: taskId, person_id: personId, work_date: '2026-10-06', kind, hours,
    labor_cost: cost, status, created_at: now, updated_at: now,
  });
  entry(4, 48, 'APPROVED', 'NORMAL');
  entry(2, 36, 'APPROVED', 'OVERTIME');
  entry(5, 60, 'SUBMITTED', 'NORMAL');

  const approved = taskLaborSummary(taskId);
  assert.strictEqual(approved.counted_entries, 2);
  assert.strictEqual(approved.entries, 3);
  assert.strictEqual(approved.hours, 6);
  assert.strictEqual(approved.labor_cost, 84);
  assert.strictEqual(approved.by_kind.NORMAL, 4);
  assert.strictEqual(approved.by_kind.OVERTIME, 2);
  assert.strictEqual(approved.by_person.length, 1);
  assert.strictEqual(approved.by_person[0].labor_cost, 84);

  const includingPending = taskLaborSummary(taskId, { include: ['APPROVED', 'SUBMITTED'] });
  assert.strictEqual(includingPending.hours, 11);
  assert.strictEqual(includingPending.labor_cost, 144);
});
