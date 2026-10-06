process.env.TMMS_DB = require('node:path').join(require('node:os').tmpdir(), `tmms-tower-${process.pid}-${Date.now()}.db`);

const test = require('node:test');
const assert = require('node:assert');

const { initSchema } = require('../db');
const { insertRow, list } = require('../util');
initSchema();

const tower = require('../controlTower');

const NOW = new Date().toISOString();
const PAST = new Date(Date.now() - 3 * 86400000).toISOString();

test('control tower aggregates readiness, resources, materials, cost, defects and reliability', () => {
  const regionId = insertRow('region', { code: 'CT-R', name: 'CT', type: 'CUSTOM', center_lat: 0, center_lng: 0, boundary: 1, status: 'ACTIVE', timezone: 'UTC' });
  const t = (number, status, extra) => insertRow('task', {
    task_number: `TK-2026-74${number}`, title: `Tower ${number}`, task_type: 'INSPECTION', priority: 'LOW',
    status, region_id: regionId, due_date: PAST, created_at: NOW, updated_at: NOW, source: 'MANUAL', ...extra,
  });

  const overdueTask = t('0001', 'ASSIGNED', {});
  t('0002', 'IN_PROGRESS', { due_date: new Date(Date.now() + 2 * 86400000).toISOString() });
  t('0003', 'COMPLETED', { result: 'PASS', actual_end: NOW, due_date: NOW });
  const assetId = insertRow('asset', { asset_id: 'AST-CT-9', asset_type: 'TRANSFORMER', name: 'T9' });
  t('0004', 'COMPLETED', { result: 'FAIL', actual_end: NOW, due_date: NOW, asset_id: assetId });
  t('0005', 'COMPLETED', { result: 'FAIL', actual_end: NOW, due_date: NOW, asset_id: assetId });

  insertRow('cost_estimate', { task_id: overdueTask, category: 'LABOR', amount: 100, created_at: NOW, updated_at: NOW });
  const personId = insertRow('person', { first_name: 'Tower', last_name: 'Person', role: 'STAFF', active: 1 });
  insertRow('time_entry', { task_id: overdueTask, person_id: personId, work_date: NOW.slice(0, 10), kind: 'NORMAL', hours: 5, labor_cost: 50, status: 'APPROVED', created_at: NOW, updated_at: NOW });

  const resourceId = insertRow('maintenance_resource', { code: 'CT-RES', name: 'Test set', category: 'TEST_SET', status: 'AVAILABLE', calibration_expiry: PAST, active: 1, created_at: NOW, updated_at: NOW });
  insertRow('resource_reservation', { resource_id: resourceId, reserved_from: NOW, reserved_to: new Date(Date.now() + 86400000).toISOString(), status: 'RESERVED', created_at: NOW, updated_at: NOW });
  insertRow('resource_reservation', { resource_id: resourceId, reserved_from: new Date(Date.now() + 3600000).toISOString(), reserved_to: new Date(Date.now() + 2 * 86400000).toISOString(), status: 'RESERVED', created_at: NOW, updated_at: NOW });

  insertRow('material_item', { code: 'CT-MAT', description: 'Critical spare', unit_cost: 10, criticality: 'CRITICAL', reorder_point: 5, active: 1, created_at: NOW, updated_at: NOW });
  insertRow('defect', { defect_number: 'DEF-CT-1', title: 'Open defect', severity: 'HIGH', status: 'OPEN', created_at: NOW, updated_at: NOW });

  const tasks = list('task');
  const payload = tower.build(tasks, { days: 30 });

  assert.strictEqual(payload.tasks.total, 5);
  assert.strictEqual(payload.tasks.open, 2);
  assert.strictEqual(payload.tasks.overdue, 1);
  assert.strictEqual(payload.tasks.overdue_rate_pct, 50);
  assert.strictEqual(payload.tasks.completed_in_window, 3);
  assert.strictEqual(payload.tasks.first_time_right_pct, 33.3);

  assert.ok(payload.readiness.blocked >= 1);
  assert.ok(payload.readiness.blocked_tasks.some((b) => b.blockers.includes('NO_CREW')));
  assert.ok(payload.readiness.heatmap.length >= 1);

  assert.ok(payload.resources.calibration_due >= 1);
  assert.ok(payload.resources.conflicts >= 1);

  assert.strictEqual(payload.materials.critical_short, 1);
  assert.ok(payload.materials.below_reorder >= 1);

  assert.strictEqual(payload.defects.open, 1);
  assert.strictEqual(payload.costs.planned, 100);
  assert.strictEqual(payload.costs.by_category.LABOR, 50);
  assert.strictEqual(payload.labor.hours, 5);
  assert.ok(payload.reliability.repeat_failure_assets.some((r) => r.asset_id === assetId));
});
