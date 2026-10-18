process.env.TMMS_DB = require('node:path').join(require('node:os').tmpdir(), `tmms-completion-${process.pid}-${Date.now()}.db`);

const test = require('node:test');
const assert = require('node:assert');
const express = require('express');

const { initSchema, db } = require('../db');
const { insertRow, get, updateRow } = require('../util');
const { requireAuth, auditMiddleware, createSession, hashPassword } = require('../auth');
const { maintenanceCostForRegions } = require('../maintenanceCost');
const { repairConditionRatings, backfillTowerMaintenance, repairScheduleAssetAnchors } = require('../scripts/fixRuntimeData');

initSchema();

const NOW = new Date().toISOString();

const regionId = insertRow('region', {
  code: 'CM-R', name: 'Completion R', type: 'CUSTOM', center_lat: 0, center_lng: 0,
  boundary: 1, status: 'ACTIVE', timezone: 'UTC',
});
const subA = insertRow('substation', { substation_id: 'CM-S-A', name: 'A', region_id: regionId, latitude: 1, longitude: 1 });
const subB = insertRow('substation', { substation_id: 'CM-S-B', name: 'B', region_id: regionId, latitude: 2, longitude: 2 });
const lineId = insertRow('transmission_line', {
  line_id: 'CM-L-1', name: 'Completion Line', region_id: regionId,
  from_substation_id: subA, to_substation_id: subB, voltage_kv: 132,
});
const towerId = insertRow('tower', {
  tower_id: 'CM-T-1', line_id: lineId, tower_number: 1, latitude: 1.5, longitude: 1.5,
  corrosion_rating: 8, tower_type: 'SUSPENSION',
});
const mirrorId = insertRow('asset', {
  asset_id: 'TWR-CM-T-1', asset_type: 'TOWER', tower_id: towerId, line_id: lineId,
  name: 'CM-T-1', condition_rating: 8, lifecycle_status: 'IN_SERVICE',
});

const personId = insertRow('person', { first_name: 'Cm', last_name: 'Admin', role: 'STAFF', active: 1 });
const adminId = insertRow('user', {
  username: 'cm-admin', password_hash: hashPassword('x'), role: 'ADMIN', person_id: personId, active: 1, created_at: NOW,
});
const adminToken = createSession(adminId);

const app = express();
app.use(express.json({ limit: '12mb' }));
app.use(requireAuth, auditMiddleware);
app.use('/api', require('../routes/tasks'));
app.use('/api', require('../routes/assets'));

let server;
let base;
test.before(() => new Promise((resolve) => {
  server = app.listen(0, '127.0.0.1', () => { base = `http://127.0.0.1:${server.address().port}`; resolve(); });
}));
test.after(() => new Promise((resolve) => server.close(resolve)));

function call(method, path, body) {
  return fetch(`${base}${path}`, {
    method,
    headers: { Authorization: `Bearer ${adminToken}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
}

function pendingTowerTask(number) {
  return insertRow('task', {
    task_number: `TK-CM-${number}`, title: `Tower work ${number}`, task_type: 'INSPECTION', priority: 'LOW',
    status: 'PENDING_VERIFICATION', region_id: regionId, line_id: lineId, tower_id: towerId,
    due_date: NOW, created_at: NOW, updated_at: NOW, source: 'MANUAL',
  });
}

test('completing a tower task records a maintenance event on the tower mirror asset', async () => {
  const id = pendingTowerTask('001');
  const res = await call('POST', `/api/tasks/${id}/state`, { action: 'verify', result: 'PASS' });
  assert.strictEqual(res.status, 200);

  const events = db.prepare('SELECT * FROM asset_maintenance_event WHERE task_id = ?').all(id);
  assert.strictEqual(events.length, 1);
  assert.strictEqual(events[0].asset_id, mirrorId);
  assert.strictEqual(events[0].event_type, 'INSPECTION');

  const mirror = get('asset', mirrorId);
  assert.ok(mirror.last_maintenance_at, 'tower mirror last_maintenance_at is set');
});

test('tower work appears in the maintenance cost report under TOWER', async () => {
  const id = pendingTowerTask('002');
  await call('POST', `/api/tasks/${id}/state`, { action: 'verify', result: 'PASS', cost: 250 });

  const report = maintenanceCostForRegions([regionId], {});
  assert.ok(report.totals.count >= 1, 'report counts the tower work event');
  assert.ok(report.totals.spend >= 250, 'report includes the recorded spend');
  const tower = report.by_asset_type.find((r) => r.asset_type === 'TOWER');
  assert.ok(tower, 'TOWER asset type is present in the report');
  assert.ok(tower.spend >= 250);
});

test('maintenance event rejects an out-of-range condition_after', async () => {
  const before = get('asset', mirrorId).condition_rating;

  const bad = await call('POST', '/api/maintenance-events', {
    asset_id: mirrorId, event_type: 'INSPECTION', condition_after: 1500000,
  });
  assert.strictEqual(bad.status, 400);
  assert.strictEqual(get('asset', mirrorId).condition_rating, before);

  const ok = await call('POST', '/api/maintenance-events', {
    asset_id: mirrorId, event_type: 'INSPECTION', condition_after: 6, performed_at: new Date().toISOString(),
  });
  assert.strictEqual(ok.status, 201);
  assert.strictEqual(get('asset', mirrorId).condition_rating, 6);
});

test('runtime repair clamps out-of-range asset condition ratings', () => {
  updateRow('asset', mirrorId, { condition_rating: 1500000 });
  assert.ok(repairConditionRatings(false).count >= 1);
  repairConditionRatings(true);
  assert.strictEqual(get('asset', mirrorId).condition_rating, 8);
});

test('runtime backfill gives completed tower tasks their maintenance history', () => {
  const id = insertRow('task', {
    task_number: 'TK-CM-900', title: 'Legacy tower work', task_type: 'CORRECTIVE', priority: 'LOW',
    status: 'COMPLETED', region_id: regionId, line_id: lineId, tower_id: towerId,
    actual_end: NOW, due_date: NOW, created_at: NOW, updated_at: NOW, source: 'MANUAL',
  });
  assert.strictEqual(db.prepare('SELECT COUNT(*) c FROM asset_maintenance_event WHERE task_id = ?').get(id).c, 0);

  backfillTowerMaintenance(true);

  const events = db.prepare('SELECT * FROM asset_maintenance_event WHERE task_id = ?').all(id);
  assert.strictEqual(events.length, 1);
  assert.strictEqual(events[0].asset_id, mirrorId);
});

test('runtime repair clears a stray tower_id on schedule-generated asset tasks only', () => {
  const tower2 = insertRow('tower', {
    tower_id: 'CM-T-2', line_id: lineId, tower_number: 2, latitude: 1.6, longitude: 1.6, corrosion_rating: 7,
  });
  const generated = insertRow('task', {
    task_number: 'TK-CM-901', title: 'Generated asset work', task_type: 'INSPECTION', priority: 'LOW',
    status: 'SCHEDULED', region_id: regionId, asset_id: mirrorId, tower_id: tower2,
    due_date: NOW, created_at: NOW, updated_at: NOW, source: 'SCHEDULE_GENERATED',
  });
  const manual = insertRow('task', {
    task_number: 'TK-CM-902', title: 'Manual tower asset work', task_type: 'INSPECTION', priority: 'LOW',
    status: 'SCHEDULED', region_id: regionId, asset_id: mirrorId, tower_id: towerId,
    due_date: NOW, created_at: NOW, updated_at: NOW, source: 'MANUAL',
  });

  assert.ok(repairScheduleAssetAnchors(false).count >= 1);
  repairScheduleAssetAnchors(true);

  assert.strictEqual(get('task', generated).tower_id, null);
  assert.strictEqual(get('task', manual).tower_id, towerId, 'manual tasks are left untouched');
});
