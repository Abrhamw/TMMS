process.env.TMMS_DB = require('node:path').join(require('node:os').tmpdir(), `tmms-schedules-${process.pid}-${Date.now()}.db`);

const test = require('node:test');
const assert = require('node:assert');
const express = require('express');

const { initSchema, db } = require('../db');
const { insertRow, get, updateRow } = require('../util');
const { requireAuth, auditMiddleware, createSession, hashPassword } = require('../auth');

initSchema();

const NOW = new Date().toISOString();
const PAST = new Date(Date.now() - 86400000).toISOString();

const regionId = insertRow('region', {
  code: 'SR', name: 'Schedule Region', type: 'CUSTOM', center_lat: 0, center_lng: 0,
  boundary: 1, status: 'ACTIVE', timezone: 'UTC',
});
const sub1 = insertRow('substation', { substation_id: 'SS-SR-1', name: 'Sub One', region_id: regionId, latitude: 1, longitude: 1 });
const sub2 = insertRow('substation', { substation_id: 'SS-SR-2', name: 'Sub Two', region_id: regionId, latitude: 2, longitude: 2 });
const otherRegion = insertRow('region', {
  code: 'SR2', name: 'Other Region', type: 'CUSTOM', center_lat: 5, center_lng: 5, boundary: 1, status: 'ACTIVE', timezone: 'UTC',
});
const subOther = insertRow('substation', { substation_id: 'SS-SR-O', name: 'Out of region', region_id: otherRegion, latitude: 5, longitude: 5 });

const line = insertRow('transmission_line', {
  line_id: 'SL-1', name: 'Schedule Line', region_id: regionId,
  from_substation_id: sub1, to_substation_id: sub2, voltage_kv: 132,
});
const tower1 = insertRow('tower', { tower_id: 'ST-1', line_id: line, tower_number: 1, latitude: 1.1, longitude: 1.1, corrosion_rating: 8 });
const tower2 = insertRow('tower', { tower_id: 'ST-2', line_id: line, tower_number: 2, latitude: 1.2, longitude: 1.2, corrosion_rating: 7 });

const mirror1 = insertRow('asset', { asset_id: 'TWR-ST-1', asset_type: 'TOWER', tower_id: tower1, line_id: line, name: 'ST-1', condition_rating: 8, lifecycle_status: 'IN_SERVICE' });
const mirror2 = insertRow('asset', { asset_id: 'TWR-ST-2', asset_type: 'TOWER', tower_id: tower2, line_id: line, name: 'ST-2', condition_rating: 7, lifecycle_status: 'IN_SERVICE' });
const jointBox = insertRow('asset', { asset_id: 'JB-ST-1', asset_type: 'JOINT_BOX', line_id: line, name: 'Joint Box', condition_rating: 6, lifecycle_status: 'IN_SERVICE' });
const retiredSpan = insertRow('asset', { asset_id: 'CS-ST-OLD', asset_type: 'CONDUCTOR_SPAN', line_id: line, name: 'Retired span', condition_rating: 4, lifecycle_status: 'DECOMMISSIONED' });
const xfr = insertRow('asset', { asset_id: 'XFR-SS-1', asset_type: 'TRANSFORMER', substation_id: sub1, name: 'Transformer', condition_rating: 5, lifecycle_status: 'IN_SERVICE' });
const otherAsset = insertRow('asset', { asset_id: 'XFR-SS-O', asset_type: 'TRANSFORMER', substation_id: subOther, name: 'Other region xf', condition_rating: 8, lifecycle_status: 'IN_SERVICE' });

const personId = insertRow('person', { first_name: 'Sch', last_name: 'Admin', role: 'STAFF', active: 1 });
const adminId = insertRow('user', { username: 'sch-admin', password_hash: hashPassword('x'), role: 'ADMIN', person_id: personId, active: 1, created_at: NOW });
const adminToken = createSession(adminId);

const app = express();
app.use(express.json({ limit: '12mb' }));
app.use(requireAuth, auditMiddleware);
app.use('/api', require('../routes/schedules'));
app.use('/api', require('../routes/tasks'));

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

let seq = 0;
function makeSchedule(overrides = {}) {
  seq += 1;
  return insertRow('maintenance_schedule', {
    schedule_name: `Sched ${seq}`, schedule_code: `SCH-${seq}-${Date.now()}`,
    scope_type: 'ASSET', frequency: 'MONTHLY', frequency_config: '{}',
    region_id: regionId, next_due_date: PAST, is_active: 1, lead_time_days: 7, ...overrides,
  });
}

async function run(scheduleId) {
  const res = await call('POST', '/api/schedules/run', { schedule_id: scheduleId });
  assert.strictEqual(res.status, 200);
  return res.json();
}

function generatedFor(scheduleId) {
  return db.prepare('SELECT * FROM task WHERE schedule_id = ?').all(scheduleId);
}

test('LINE scope generates one task per in-service register asset on the line', async () => {
  const s = makeSchedule({ scope_type: 'LINE', line_id: line });
  const r = await run(s);
  assert.strictEqual(r.generated, 3, 'tower mirrors + joint box, decommissioned span excluded');
  const assetIds = generatedFor(s).map((t) => t.asset_id).sort();
  assert.deepStrictEqual(assetIds, [jointBox, mirror1, mirror2].sort());
  assert.ok(!assetIds.includes(retiredSpan));
});

test('SUBSTATION scope generates one task per equipment asset in the substation', async () => {
  const s = makeSchedule({ scope_type: 'SUBSTATION', substation_id: sub1 });
  const r = await run(s);
  const tasks = generatedFor(s);
  assert.strictEqual(tasks.length, 1);
  assert.strictEqual(tasks[0].asset_id, xfr);
  assert.strictEqual(tasks[0].substation_id, sub1, 'task anchors to the real substation, not the asset id');
});

test('REGION scope generates one task per register asset in the region', async () => {
  const s = makeSchedule({ scope_type: 'REGION' });
  const r = await run(s);
  const assetIds = generatedFor(s).map((t) => t.asset_id).sort();
  assert.deepStrictEqual(assetIds, [jointBox, mirror1, mirror2, xfr].sort());
  assert.ok(!assetIds.includes(otherAsset), 'asset outside the region is excluded');
});

test('a scope with no register assets generates nothing and reports NO_TARGETS', async () => {
  const s = makeSchedule({ scope_type: 'SUBSTATION', substation_id: sub2 });
  const r = await run(s);
  assert.strictEqual(r.generated, 0);
  assert.strictEqual(generatedFor(s).length, 0);
  const preview = await call('GET', `/api/schedules/${s}/preview`);
  const body = await preview.json();
  assert.strictEqual(body.target_count, 0);
});

test('batch_size caps each run and holds the occurrence until the sweep is complete', async () => {
  const s = makeSchedule({ scope_type: 'LINE', line_id: line, batch_size: 1 });
  const before = get('maintenance_schedule', s);

  const r1 = await run(s);
  assert.strictEqual(r1.generated, 1);
  assert.strictEqual(get('maintenance_schedule', s).occurrences_generated, before.occurrences_generated, 'occurrence held');
  assert.strictEqual(get('maintenance_schedule', s).next_due_date, before.next_due_date, 'due date held');

  const r2 = await run(s);
  assert.strictEqual(r2.generated, 1);
  assert.strictEqual(get('maintenance_schedule', s).next_due_date, before.next_due_date, 'still held');

  const r3 = await run(s);
  assert.strictEqual(r3.generated, 1);
  const after = get('maintenance_schedule', s);
  assert.strictEqual(after.occurrences_generated, before.occurrences_generated + 1, 'sweep complete advances occurrence');
  assert.ok(after.next_due_date > before.next_due_date, 'due date rolls forward');

  const tasks = generatedFor(s);
  assert.strictEqual(tasks.length, 3);
  assert.strictEqual(new Set(tasks.map((t) => t.asset_id)).size, 3, 'no duplicates across runs');

  const r4 = await run(s);
  assert.strictEqual(r4.generated, 0);
  assert.strictEqual(r4.not_due, 1);
});

test('a fresh sweep waits while a prior occurrence still has open tasks', async () => {
  const s = makeSchedule({ scope_type: 'SUBSTATION', substation_id: sub1 });
  await run(s);
  assert.strictEqual(generatedFor(s).length, 1);

  // Make the schedule due again without closing the generated task.
  updateRow('maintenance_schedule', s, { next_due_date: PAST });
  const r = await run(s);
  assert.strictEqual(r.generated, 0);
  assert.strictEqual(r.skipped_duplicate, 1);
  assert.strictEqual(generatedFor(s).length, 1, 'no new task while the previous sweep is open');
});

test('completing a generated asset task records maintenance history against the asset', async () => {
  const s = makeSchedule({ scope_type: 'ASSET', asset_id: xfr });
  const r = await run(s);
  assert.strictEqual(r.generated, 1);
  const task = generatedFor(s)[0];
  assert.strictEqual(task.asset_id, xfr);

  db.prepare("UPDATE task SET status = 'PENDING_VERIFICATION' WHERE id = ?").run(task.id);
  const res = await call('POST', `/api/tasks/${task.id}/state`, { action: 'verify', result: 'PASS', cost: 100 });
  assert.strictEqual(res.status, 200);

  const events = db.prepare('SELECT * FROM asset_maintenance_event WHERE task_id = ?').all(task.id);
  assert.strictEqual(events.length, 1);
  assert.strictEqual(events[0].asset_id, xfr);
  assert.ok(get('asset', xfr).last_maintenance_at, 'asset last_maintenance_at updated');
});
