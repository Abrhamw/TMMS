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
const lineOther = insertRow('transmission_line', {
  line_id: 'SL-O', name: 'Other Line', region_id: otherRegion,
  from_substation_id: subOther, to_substation_id: subOther, voltage_kv: 66,
});
const towerOther = insertRow('tower', { tower_id: 'ST-O-1', line_id: lineOther, tower_number: 1, latitude: 5.1, longitude: 5.1, corrosion_rating: 6 });
// A tower register mirror whose asset id deliberately differs from its tower id.
const mirrorOther = insertRow('asset', { asset_id: 'TWR-ST-O-1', asset_type: 'TOWER', tower_id: towerOther, line_id: lineOther, name: 'ST-O-1', condition_rating: 6, lifecycle_status: 'IN_SERVICE' });

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

test('an asset target anchors by asset_id and never copies the asset id into tower_id', async () => {
  // mirrorOther is a TOWER asset whose asset id differs from its tower id, so the
  // old `tower_id: target.id` bug referenced a non-existent tower (FK failure) or
  // an unrelated tower.
  assert.notStrictEqual(mirrorOther, towerOther);
  const s = makeSchedule({ scope_type: 'ASSET', asset_id: mirrorOther });
  const r = await run(s);
  assert.deepStrictEqual(r.errors, []);
  assert.strictEqual(r.generated, 1);
  const task = generatedFor(s)[0];
  assert.strictEqual(task.asset_id, mirrorOther);
  assert.strictEqual(task.tower_id, null, 'asset targets must not set tower_id');
});

test('the schedule list reports SWEEP_IN_PROGRESS while a sweep is only partly generated', async () => {
  const s = makeSchedule({ scope_type: 'LINE', line_id: line, batch_size: 1 });
  await run(s);
  await run(s);
  const res = await call('GET', '/api/schedules');
  const rows = await res.json();
  const row = rows.find((x) => x.id === s);
  assert.strictEqual(row.remaining, 1, 'one target is still ungenerated');
  assert.strictEqual(row.due_state, 'SWEEP_IN_PROGRESS');
});

test('running an inactive schedule reports it is inactive, not outside authority', async () => {
  const s = makeSchedule({ scope_type: 'ASSET', asset_id: xfr });
  updateRow('maintenance_schedule', s, { is_active: 0 });
  const r = await run(s);
  assert.strictEqual(r.generated, 0);
  assert.strictEqual(r.errors.length, 1);
  assert.match(r.errors[0].error, /not active/i);
});

test('one target that fails to insert does not abort the rest of the sweep', async () => {
  // Corrupt the first target (lowest id) so its task insert is rejected, then
  // prove the remaining targets still generate instead of the whole run aborting.
  db.prepare('PRAGMA foreign_keys = OFF').run();
  db.prepare('UPDATE asset SET substation_id = 999999 WHERE id = ?').run(mirror1);
  db.prepare('PRAGMA foreign_keys = ON').run();

  const s = makeSchedule({ scope_type: 'LINE', line_id: line });
  const r = await run(s);
  assert.ok(r.errors.length >= 1, 'the rejected target is reported');
  assert.ok(r.generated >= 2, 'the other targets still generate');
  const ids = generatedFor(s).map((t) => t.asset_id);
  assert.ok(ids.includes(mirror2) && ids.includes(jointBox));
});

test('create keeps only the target field that matches the scope', async () => {
  const res = await call('POST', '/api/schedules', {
    schedule_name: 'Canonical scope', schedule_code: `CAN-${Date.now()}`,
    scope_type: 'LINE', line_id: line,
    asset_type: 'TRANSFORMER', asset_id: xfr, substation_id: sub1, tower_id: tower1,
    frequency: 'MONTHLY', frequency_config: '{}', next_due_date: PAST, region_id: regionId,
  });
  assert.strictEqual(res.status, 201);
  const row = await res.json();
  assert.strictEqual(row.scope_type, 'LINE');
  assert.strictEqual(row.line_id, line);
  assert.strictEqual(row.asset_type, null);
  assert.strictEqual(row.asset_id, null);
  assert.strictEqual(row.substation_id, null);
  assert.strictEqual(row.tower_id, null);
});

test('ASSET_CLASS scope requires an asset type', async () => {
  const res = await call('POST', '/api/schedules', {
    schedule_name: 'No class', schedule_code: `NOC-${Date.now()}`,
    scope_type: 'ASSET_CLASS', frequency: 'MONTHLY', frequency_config: '{}',
    next_due_date: PAST, region_id: regionId,
  });
  assert.strictEqual(res.status, 400);
  assert.match((await res.json()).error, /asset type/i);
});

test('TOWER scope derives its parent line', async () => {
  const res = await call('POST', '/api/schedules', {
    schedule_name: 'Tower scope', schedule_code: `TW-${Date.now()}`,
    scope_type: 'TOWER', tower_id: tower1, frequency: 'MONTHLY', frequency_config: '{}',
    next_due_date: PAST, region_id: regionId,
  });
  assert.strictEqual(res.status, 201);
  const row = await res.json();
  assert.strictEqual(row.tower_id, tower1);
  assert.strictEqual(row.line_id, line);
});

test('changing scope clears the previous target fields', async () => {
  const s = makeSchedule({ scope_type: 'ASSET', asset_id: xfr, asset_type: 'TRANSFORMER' });
  const res = await call('PUT', `/api/schedules/${s}`, { scope_type: 'LINE', line_id: line });
  assert.strictEqual(res.status, 200);
  const row = await res.json();
  assert.strictEqual(row.scope_type, 'LINE');
  assert.strictEqual(row.line_id, line);
  assert.strictEqual(row.asset_id, null);
  assert.strictEqual(row.asset_type, null);
});

function filter(mode, voltages = [], ids = []) {
  return JSON.stringify({ mode, voltages, ids });
}

test('LINE_GROUP generates one anchored task per matching line', async () => {
  const s = makeSchedule({
    scope_type: 'LINE_GROUP', region_id: regionId,
    scope_filter: filter('FILTER', [132]),
  });
  const r = await run(s);
  assert.strictEqual(r.generated, 1);
  const tasks = generatedFor(s);
  assert.strictEqual(tasks[0].line_id, line);
  assert.strictEqual(tasks[0].asset_id, null);
  assert.strictEqual(tasks[0].substation_id, null);
  assert.strictEqual(tasks[0].tower_id, null);
  assert.strictEqual(tasks[0].region_id, regionId);
  assert.match(tasks[0].title, /Schedule Line/);

  const again = await run(s);
  assert.strictEqual(again.generated, 0, 'a completed sweep does not duplicate lines');
});

test('LINE_GROUP re-evaluates the filter on the next occurrence', async () => {
  const s = makeSchedule({
    scope_type: 'LINE_GROUP', region_id: regionId,
    scope_filter: filter('FILTER', [132]),
  });
  const r = await run(s);
  assert.strictEqual(r.generated, 1);

  const extra = insertRow('transmission_line', {
    line_id: 'SL-NEW', name: 'New 132 Line', region_id: regionId,
    from_substation_id: sub1, to_substation_id: sub2, voltage_kv: 132,
  });

  db.prepare("UPDATE task SET status = 'COMPLETED' WHERE schedule_id = ?").run(s);
  db.prepare('UPDATE maintenance_schedule SET next_due_date = ? WHERE id = ?').run(PAST, s);

  const r2 = await run(s);
  assert.strictEqual(r2.generated, 2, 'existing and newly matching lines are both generated');
  const lineIds = db.prepare('SELECT line_id FROM task WHERE schedule_id = ? AND schedule_occurrence = 1').all(s).map((t) => t.line_id).sort();
  assert.deepStrictEqual(lineIds, [line, extra].sort());
});

test('SUBSTATION_GROUP filters substations by region and voltage level', async () => {
  updateRow('substation', sub1, { voltage_levels: '["132kV","15kV"]' });
  updateRow('substation', sub2, { voltage_levels: '["33kV"]' });

  const s = makeSchedule({
    scope_type: 'SUBSTATION_GROUP', region_id: regionId,
    scope_filter: filter('FILTER', [132]),
  });
  const r = await run(s);
  assert.strictEqual(r.generated, 1);
  const task = generatedFor(s)[0];
  assert.strictEqual(task.substation_id, sub1);
  assert.strictEqual(task.line_id, null);
  assert.strictEqual(task.asset_id, null);
  assert.strictEqual(task.region_id, regionId);
  assert.match(task.title, /Sub One/);
});

test('ASSET_GROUP filters by type, region, and parent voltage', async () => {
  updateRow('substation', sub1, { voltage_levels: '["132kV","15kV"]' });
  const xfr2 = insertRow('asset', {
    asset_id: 'XFR-SS-2', asset_type: 'TRANSFORMER', substation_id: sub2,
    name: 'Second transformer', condition_rating: 6, lifecycle_status: 'IN_SERVICE',
  });
  updateRow('substation', sub2, { voltage_levels: '["33kV"]' });

  const s = makeSchedule({
    scope_type: 'ASSET_GROUP', asset_type: 'TRANSFORMER', region_id: regionId,
    scope_filter: filter('FILTER', [132]),
  });
  const r = await run(s);
  assert.strictEqual(r.generated, 1);
  assert.strictEqual(generatedFor(s)[0].asset_id, xfr);
  assert.ok(!generatedFor(s).some((t) => t.asset_id === xfr2), 'lower-voltage transformer is excluded');
});

test('ASSET_GROUP specific picks are anchored and validated', async () => {
  const ok = makeSchedule({
    scope_type: 'ASSET_GROUP', asset_type: 'TRANSFORMER', region_id: regionId,
    scope_filter: filter('SPECIFIC', [], [xfr]),
  });
  const r = await run(ok);
  assert.strictEqual(r.generated, 1);
  assert.strictEqual(generatedFor(ok)[0].asset_id, xfr);

  const wrongType = await call('POST', '/api/schedules', {
    schedule_name: 'Wrong type', schedule_code: `WT-${Date.now()}`,
    scope_type: 'ASSET_GROUP', asset_type: 'TRANSFORMER', region_id: regionId,
    scope_filter: { mode: 'SPECIFIC', voltages: [], ids: [jointBox] },
    frequency: 'MONTHLY', frequency_config: '{}', next_due_date: PAST,
  });
  assert.strictEqual(wrongType.status, 400);
  assert.match((await wrongType.json()).error, /asset type/i);
});

test('grouped scopes reject invalid filters and preview the match count', async () => {
  const emptySpecific = await call('POST', '/api/schedules', {
    schedule_name: 'Empty specific', schedule_code: `ES-${Date.now()}`,
    scope_type: 'LINE_GROUP', region_id: regionId,
    scope_filter: { mode: 'SPECIFIC', voltages: [], ids: [] },
    frequency: 'MONTHLY', frequency_config: '{}', next_due_date: PAST,
  });
  assert.strictEqual(emptySpecific.status, 400);

  const noType = await call('POST', '/api/schedules', {
    schedule_name: 'No type', schedule_code: `NT-${Date.now()}`,
    scope_type: 'ASSET_GROUP', region_id: regionId,
    scope_filter: { mode: 'FILTER', voltages: [], ids: [] },
    frequency: 'MONTHLY', frequency_config: '{}', next_due_date: PAST,
  });
  assert.strictEqual(noType.status, 400);
  assert.match((await noType.json()).error, /asset type/i);

  const preview = await call('GET', `/api/schedules/scope-preview?scope_type=LINE_GROUP&region_id=${regionId}&mode=FILTER&voltages=132`);
  assert.strictEqual(preview.status, 200);
  const body = await preview.json();
  assert.strictEqual(body.count, 2, 'the original and the added 132 kV line');
  assert.deepStrictEqual(body.scope_filter, { mode: 'FILTER', voltages: [132], ids: [] });
  assert.match(body.scope_summary, /Lines/);
});

test('updating a grouped scope re-normalises its filter', async () => {
  const s = makeSchedule({
    scope_type: 'LINE_GROUP', region_id: regionId,
    scope_filter: filter('FILTER', [132]),
  });
  const res = await call('PUT', `/api/schedules/${s}`, {
    scope_filter: { mode: 'SPECIFIC', voltages: [400], ids: [line] },
  });
  assert.strictEqual(res.status, 200);
  const row = await res.json();
  assert.strictEqual(row.scope_type, 'LINE_GROUP');
  assert.deepStrictEqual(row.scope_filter, { mode: 'SPECIFIC', voltages: [], ids: [line] });
  assert.match(row.scope_summary, /1 specific/);

  const bad = await call('PUT', `/api/schedules/${s}`, {
    scope_filter: { mode: 'SPECIFIC', voltages: [], ids: [999999] },
  });
  assert.strictEqual(bad.status, 400);
});

test('new plans start as drafts, are skipped by runs, and need approval', async () => {
  const res = await call('POST', '/api/schedules', {
    schedule_name: 'Draft plan', schedule_code: `DRF-${Date.now()}`,
    scope_type: 'ASSET', asset_id: xfr, frequency: 'MONTHLY', frequency_config: '{}',
    next_due_date: PAST, region_id: regionId,
  });
  assert.strictEqual(res.status, 201);
  const row = await res.json();
  assert.strictEqual(row.approval_status, 'DRAFT');
  assert.strictEqual(row.approved, false);

  const blocked = await run(row.id);
  assert.strictEqual(blocked.generated, 0);
  assert.strictEqual(blocked.not_approved, 1);
  assert.match(blocked.errors[0].error, /not approved/);

  const approved = await call('POST', `/api/schedules/${row.id}/approval`, { approved: true });
  assert.strictEqual(approved.status, 200);
  const ok = await approved.json();
  assert.strictEqual(ok.approval_status, 'APPROVED');
  assert.ok(ok.approved_at);

  const generated = await run(row.id);
  assert.strictEqual(generated.generated, 1);

  const edited = await call('PUT', `/api/schedules/${row.id}`, { priority: 'HIGH' });
  assert.strictEqual(edited.status, 200);
  const reopened = await edited.json();
  assert.strictEqual(reopened.approval_status, 'DRAFT');
  assert.strictEqual(reopened.approved_by, null);
  assert.strictEqual(reopened.approved_at, null);
});

test('planners cannot approve their own plans', async () => {
  const plannerPerson = insertRow('person', { first_name: 'Plan', last_name: 'Ner', role: 'STAFF', active: 1 });
  const plannerUser = insertRow('user', { username: `planner-${Date.now()}`, password_hash: hashPassword('x'), role: 'PLANNER', person_id: plannerPerson, active: 1, created_at: NOW });
  const token = createSession(plannerUser);
  const s = makeSchedule({ scope_type: 'ASSET', asset_id: xfr });
  const res = await fetch(`${base}/api/schedules/${s}/approval`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ approved: true }),
  });
  assert.strictEqual(res.status, 403);
});

const capCrew = insertRow('crew', { name: 'Capacity Crew', crew_code: `CR-CAP-${Date.now()}`, crew_type: 'MAINTENANCE', region_id: regionId, status: 'AVAILABLE' });
insertRow('crew_member', { crew_id: capCrew, person_id: personId, role: 'LINEMAN', active: 1 });

test('saving a plan that would overbook the crew week is blocked', async () => {
  const res = await call('POST', '/api/schedules', {
    schedule_name: 'Overbooked', schedule_code: `OVR-${Date.now()}`,
    scope_type: 'ASSET', asset_id: xfr, frequency: 'MONTHLY', frequency_config: '{}',
    next_due_date: PAST, region_id: regionId, responsible_crew_id: capCrew,
    expected_duration_hours: 50,
  });
  assert.strictEqual(res.status, 409);
  assert.match((await res.json()).error, /capacity|needs/i);

  const check = await call('POST', '/api/schedules/capacity-check', {
    scope_type: 'ASSET', asset_id: xfr, region_id: regionId,
    responsible_crew_id: capCrew, next_due_date: PAST, expected_duration_hours: 50,
  });
  assert.strictEqual(check.status, 200);
  const body = await check.json();
  assert.strictEqual(body.capacity.over, true);
  assert.strictEqual(body.capacity.capacity_hours, 40);
});

test('run defers targets beyond the crew weekly capacity', async () => {
  const s = makeSchedule({
    scope_type: 'LINE', line_id: line, task_type: 'INSPECTION',
    responsible_crew_id: capCrew, expected_duration_hours: 30,
  });
  const r = await run(s);
  assert.strictEqual(r.generated, 1);
  assert.strictEqual(r.deferred_capacity, 2);
  assert.ok(r.capacity_notes.length >= 1);
  assert.strictEqual(generatedFor(s).length, 1);
});
