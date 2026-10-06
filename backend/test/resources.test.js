process.env.TMMS_DB = require('node:path').join(require('node:os').tmpdir(), `tmms-res-${process.pid}-${Date.now()}.db`);

const test = require('node:test');
const assert = require('node:assert');

const { initSchema } = require('../db');
const { insertRow } = require('../util');
initSchema();

const { effectiveStatus, isUsable, findConflicts, usageHours, usageCost, taskResourceSummary } = require('../resources');
const { dispatchGate } = require('../readiness');

const NOW = '2026-10-06T00:00:00.000Z';

test('effectiveStatus reflects a lapsed calibration without overwriting terminal states', () => {
  assert.strictEqual(effectiveStatus({ status: 'AVAILABLE', calibration_expiry: '2026-01-01' }, NOW), 'CALIBRATION_DUE');
  assert.strictEqual(effectiveStatus({ status: 'AVAILABLE', calibration_expiry: '2027-01-01' }, NOW), 'AVAILABLE');
  assert.strictEqual(effectiveStatus({ status: 'RETIRED', calibration_expiry: '2026-01-01' }, NOW), 'RETIRED');
});

test('isUsable blocks maintenance, lapsed calibration and terminal resources', () => {
  assert.strictEqual(isUsable({ status: 'AVAILABLE', active: 1 }, NOW), true);
  assert.strictEqual(isUsable({ status: 'RESERVED', active: 1 }, NOW), true);
  assert.strictEqual(isUsable({ status: 'MAINTENANCE', active: 1 }, NOW), false);
  assert.strictEqual(isUsable({ status: 'OUT_OF_SERVICE', active: 1 }, NOW), false);
  assert.strictEqual(isUsable({ status: 'LOST', active: 1 }, NOW), false);
  assert.strictEqual(isUsable({ status: 'RETIRED', active: 1 }, NOW), false);
  assert.strictEqual(isUsable({ status: 'AVAILABLE', active: 1, calibration_expiry: '2026-01-01' }, NOW), false);
  assert.strictEqual(isUsable({ status: 'AVAILABLE', active: 0 }, NOW), false);
});

test('usageHours prefers explicit hours, otherwise measures the span; usageCost applies the rate', () => {
  assert.strictEqual(usageHours({ operating_hours: 3.5 }), 3.5);
  assert.strictEqual(usageHours({ started_at: '2026-10-06T08:00:00.000Z', ended_at: '2026-10-06T11:30:00.000Z' }), 3.5);
  assert.strictEqual(usageHours({}), 0);
  assert.strictEqual(usageCost({ operating_hours: 3 }, { cost_rate: 20 }), 60);
  assert.strictEqual(usageCost({ operating_hours: 3, cost_rate: 10 }, { cost_rate: 20 }), 30);
  assert.strictEqual(usageCost({ operating_hours: 3 }, null), null);
});

test('findConflicts treats reservations as half-open windows', () => {
  const resourceId = insertRow('maintenance_resource', { code: 'RES-CONF', name: 'Crane', category: 'CRANE', status: 'AVAILABLE', active: 1, created_at: NOW, updated_at: NOW });
  const now = new Date().toISOString();
  const reserve = (from, to) => insertRow('resource_reservation', { resource_id: resourceId, reserved_from: from, reserved_to: to, status: 'RESERVED', created_at: now, updated_at: now });
  reserve('2026-10-06T08:00:00.000Z', '2026-10-06T12:00:00.000Z');
  assert.strictEqual(findConflicts(resourceId, '2026-10-06T12:00:00.000Z', '2026-10-06T14:00:00.000Z').length, 0);
  assert.strictEqual(findConflicts(resourceId, '2026-10-06T11:00:00.000Z', '2026-10-06T13:00:00.000Z').length, 1);
  assert.strictEqual(findConflicts(resourceId, '2026-10-06T07:00:00.000Z', '2026-10-06T09:00:00.000Z').length, 1);
});

test('taskResourceSummary counts approved usage and groups by resource', () => {
  const regionId = insertRow('region', { code: 'RES-R', name: 'Res', type: 'CUSTOM', center_lat: 0, center_lng: 0, boundary: 1, status: 'ACTIVE', timezone: 'UTC' });
  const now = new Date().toISOString();
  const taskId = insertRow('task', {
    task_number: 'TK-2026-700002', title: 'Res task', task_type: 'INSPECTION', priority: 'LOW',
    status: 'IN_PROGRESS', region_id: regionId, due_date: now, created_at: now, updated_at: now, source: 'MANUAL',
  });
  const resourceId = insertRow('maintenance_resource', { code: 'RES-SUM', name: 'Test set', category: 'TEST_SET', status: 'AVAILABLE', active: 1, created_at: now, updated_at: now });
  const usage = (hours, cost, status) => insertRow('resource_usage', {
    resource_id: resourceId, task_id: taskId, operating_hours: hours, cost, status, created_at: now, updated_at: now,
  });
  usage(2, 40, 'APPROVED');
  usage(3, 60, 'SUBMITTED');

  const approved = taskResourceSummary(taskId);
  assert.strictEqual(approved.counted_entries, 1);
  assert.strictEqual(approved.resource_hours, 2);
  assert.strictEqual(approved.resource_cost, 40);
  assert.strictEqual(approved.by_resource.length, 1);

  const pending = taskResourceSummary(taskId, { include: ['APPROVED', 'SUBMITTED'] });
  assert.strictEqual(pending.resource_hours, 5);
  assert.strictEqual(pending.resource_cost, 100);
});

test('dispatchGate blocks a reservation on an out-of-service resource', () => {
  const regionId = insertRow('region', { code: 'RES-G', name: 'Gate', type: 'CUSTOM', center_lat: 0, center_lng: 0, boundary: 1, status: 'ACTIVE', timezone: 'UTC' });
  const now = new Date().toISOString();
  const taskId = insertRow('task', {
    task_number: 'TK-2026-700003', title: 'Gate task', task_type: 'INSPECTION', priority: 'LOW',
    status: 'ASSIGNED', region_id: regionId, due_date: now, created_at: now, updated_at: now, source: 'MANUAL',
  });
  const resourceId = insertRow('maintenance_resource', { code: 'RES-GATE', name: 'Bucket truck', category: 'BUCKET_TRUCK', status: 'OUT_OF_SERVICE', active: 1, created_at: now, updated_at: now });
  insertRow('resource_reservation', { resource_id: resourceId, task_id: taskId, reserved_from: now, reserved_to: now, status: 'RESERVED', created_at: now, updated_at: now });

  const gate = dispatchGate(require('../util').get('task', taskId));
  assert.ok(gate.blockers.some((b) => b.code === 'RESOURCE_UNAVAILABLE'));
});
