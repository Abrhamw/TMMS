process.env.TMMS_DB = require('node:path').join(require('node:os').tmpdir(), `tmms-cost-${process.pid}-${Date.now()}.db`);

const test = require('node:test');
const assert = require('node:assert');

const { initSchema, db } = require('../db');
const { insertRow, get } = require('../util');
initSchema();

const { taskCostSummary, closureGates } = require('../costing');

const NOW = new Date().toISOString();

function region(suffix) {
  return insertRow('region', { code: `CST-R-${suffix}`, name: 'Cost', type: 'CUSTOM', center_lat: 0, center_lng: 0, boundary: 1, status: 'ACTIVE', timezone: 'UTC' });
}

function task(regionId, number, status = 'COMPLETED', extra = {}) {
  return insertRow('task', {
    task_number: `TK-2026-72${number}`, title: `Cost ${number}`, task_type: 'INSPECTION', priority: 'LOW',
    status, result: status === 'COMPLETED' ? 'PASS' : null, region_id: regionId,
    due_date: NOW, created_at: NOW, updated_at: NOW, source: 'MANUAL', ...extra,
  });
}

test('taskCostSummary aggregates planned, committed and actual from the ledgers', () => {
  const regionId = region('1');
  const personId = insertRow('person', { first_name: 'Cost', last_name: 'Person', role: 'STAFF', active: 1 });
  const taskId = task(regionId, '0001', 'IN_PROGRESS');

  insertRow('time_entry', { task_id: taskId, person_id: personId, work_date: '2026-10-06', kind: 'NORMAL', hours: 10, labor_cost: 100, status: 'APPROVED', created_at: NOW, updated_at: NOW });
  const resourceId = insertRow('maintenance_resource', { code: 'CST-RES', name: 'Gen', category: 'GENERATOR', active: 1, created_at: NOW, updated_at: NOW });
  insertRow('resource_usage', { resource_id: resourceId, task_id: taskId, operating_hours: 5, cost: 50, status: 'APPROVED', created_at: NOW, updated_at: NOW });
  const itemId = insertRow('material_item', { code: 'CST-MAT', description: 'Spare', unit_cost: 20, criticality: 'LOW', active: 1, created_at: NOW, updated_at: NOW });
  insertRow('material_transaction', { item_id: itemId, task_id: taskId, type: 'CONSUMPTION', quantity: 2, unit_cost: 20, cost: 40, status: 'POSTED', created_at: NOW });
  insertRow('cost_estimate', { task_id: taskId, category: 'LABOR', amount: 300, created_at: NOW, updated_at: NOW });
  insertRow('cost_commitment', { task_id: taskId, category: 'CONTRACTOR', amount: 120, status: 'OPEN', created_at: NOW, updated_at: NOW });
  insertRow('cost_transaction', { task_id: taskId, category: 'TRAVEL', amount: 30, status: 'APPROVED', created_at: NOW, updated_at: NOW });
  const assetId = insertRow('asset', { asset_id: 'AST-CST-1', asset_type: 'TRANSFORMER', name: 'T1' });
  insertRow('asset_maintenance_event', { asset_id: assetId, task_id: taskId, event_type: 'INSPECTION', performed_at: NOW, cost: 10 });

  const s = taskCostSummary(taskId);
  assert.strictEqual(s.planned_cost, 300);
  assert.strictEqual(s.committed_cost, 120);
  assert.strictEqual(s.actual_cost, 230);
  assert.strictEqual(s.variance, -70);
  assert.strictEqual(s.by_category.LABOR, 100);
  assert.strictEqual(s.by_category.EQUIPMENT, 50);
  assert.strictEqual(s.by_category.MATERIAL, 40);
  assert.strictEqual(s.by_category.DIRECT, 30);
  assert.strictEqual(s.by_category.VERIFICATION, 10);
});

test('closure reports COST_PENDING when technology is done but cost is unreconciled', () => {
  const regionId = region('2');
  const taskId = task(regionId, '0002');
  const before = closureGates(get('task', taskId));
  assert.strictEqual(before.ready_to_close, false);
  assert.strictEqual(before.cost_pending, true);
  assert.strictEqual(before.gates.find((g) => g.gate === 'COST').satisfied, false);

  db.prepare('UPDATE task SET cost_reconciled_at = ? WHERE id = ?').run(NOW, taskId);
  const after = closureGates(get('task', taskId));
  assert.strictEqual(after.ready_to_close, true);
  assert.strictEqual(after.cost_pending, false);
});

test('pending labor keeps a task out of both closure and cost-pending', () => {
  const regionId = region('3');
  const personId = insertRow('person', { first_name: 'Pend', last_name: 'Labor', role: 'STAFF', active: 1 });
  const taskId = task(regionId, '0003');
  db.prepare('UPDATE task SET cost_reconciled_at = ? WHERE id = ?').run(NOW, taskId);
  insertRow('time_entry', { task_id: taskId, person_id: personId, work_date: '2026-10-06', kind: 'NORMAL', hours: 3, status: 'SUBMITTED', created_at: NOW, updated_at: NOW });

  const evaluation = closureGates(get('task', taskId));
  assert.strictEqual(evaluation.gates.find((g) => g.gate === 'LABOR').satisfied, false);
  assert.strictEqual(evaluation.ready_to_close, false);
  assert.strictEqual(evaluation.cost_pending, false);
});
