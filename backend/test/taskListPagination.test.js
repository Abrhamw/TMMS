process.env.TMMS_DB = require('node:path').join(require('node:os').tmpdir(), `tmms-tasklist-${process.pid}-${Date.now()}.db`);

const test = require('node:test');
const assert = require('node:assert');
const express = require('express');

const { initSchema } = require('../db');
const { insertRow } = require('../util');
initSchema();

const router = require('../routes/tasks');

const REGION_A = insertRow('region', { code: 'TL-A', name: 'Task List A', type: 'CUSTOM', center_lat: 0, center_lng: 0, boundary: 1, status: 'ACTIVE', timezone: 'UTC' });
const REGION_B = insertRow('region', { code: 'TL-B', name: 'Task List B', type: 'CUSTOM', center_lat: 0, center_lng: 0, boundary: 1, status: 'ACTIVE', timezone: 'UTC' });
insertRow('person', { id: 1, first_name: 'Test', last_name: 'Admin', role: 'ADMIN' });
insertRow('person', { id: 2, first_name: 'Test', last_name: 'Region', role: 'REGION_DIRECTOR' });

let seq = 0;
function seedTask(regionId, status) {
  const now = new Date().toISOString();
  return insertRow('task', {
    task_number: `TK-2026-7${String(++seq).padStart(5, '0')}`,
    title: `List task ${seq}`, task_type: 'INSPECTION', priority: 'LOW', status,
    region_id: regionId, due_date: now, created_at: now, updated_at: now, source: 'MANUAL',
  });
}
for (let i = 0; i < 5; i += 1) seedTask(REGION_A, i % 2 === 0 ? 'DRAFT' : 'ASSIGNED');
for (let i = 0; i < 3; i += 1) seedTask(REGION_B, 'DRAFT');

const app = express();
app.use(express.json());
app.use((req, _res, next) => {
  req.user = req.headers['x-test-role'] === 'region'
    ? { id: 2, person_id: 2, role: 'REGION_DIRECTOR', region_id: REGION_A }
    : { id: 1, person_id: 1, role: 'ADMIN', region_id: null };
  next();
});
app.use('/api', router);

let server;
let base;
test.before(async () => {
  await new Promise((resolve) => { server = app.listen(0, resolve); });
  base = `http://127.0.0.1:${server.address().port}/api`;
});
test.after(() => { if (server) server.close(); });

async function get(path, headers = {}) {
  const res = await fetch(`${base}${path}`, { headers });
  return { status: res.status, body: await res.json() };
}

test('paginated list returns the requested slice and full total', async () => {
  const { status, body } = await get('/tasks?page=1&page_size=2');
  assert.strictEqual(status, 200);
  assert.strictEqual(body.items.length, 2);
  assert.strictEqual(body.total, 8);
  assert.strictEqual(body.page, 1);
  assert.strictEqual(body.page_size, 2);
});

test('unpaginated list returns every visible task as an array', async () => {
  const { body } = await get('/tasks');
  assert.ok(Array.isArray(body));
  assert.strictEqual(body.length, 8);
});

test('status filter is applied before pagination', async () => {
  const { body } = await get('/tasks?status=DRAFT&page=1&page_size=100');
  assert.strictEqual(body.total, 6);
  assert.ok(body.items.every((t) => t.status === 'DRAFT'));
});

test('a region-scoped user never sees another region task', async () => {
  const { body } = await get('/tasks?page=1&page_size=100', { 'x-test-role': 'region' });
  assert.strictEqual(body.total, 5);
  assert.ok(body.items.every((t) => t.region_id === REGION_A));
});

test('lists newest tasks first and paginates in that order', async () => {
  const all = (await get('/tasks')).body;
  const ids = all.map((t) => t.id);
  assert.deepStrictEqual(ids, [...ids].sort((a, b) => b - a));
  const first = (await get('/tasks?page=1&page_size=3')).body;
  const second = (await get('/tasks?page=2&page_size=3')).body;
  assert.deepStrictEqual(first.items.map((t) => t.id), ids.slice(0, 3));
  assert.deepStrictEqual(second.items.map((t) => t.id), ids.slice(3, 6));
});

test('an asset task detail resolves the asset parent line and substation', async () => {
  const sub = insertRow('substation', { substation_id: 'TL-SUB', name: 'Task List Substation', region_id: REGION_A, latitude: 1, longitude: 1 });
  const line = insertRow('transmission_line', { line_id: 'TL-LINE', name: 'Task List Line', region_id: REGION_A, from_substation_id: sub, to_substation_id: sub, voltage_kv: 132 });
  const asset = insertRow('asset', { asset_id: 'TL-ASSET', asset_type: 'TRANSFORMER', substation_id: sub, line_id: line, name: 'Task List Transformer', condition_rating: 7, lifecycle_status: 'IN_SERVICE' });
  const now = new Date().toISOString();
  const taskId = insertRow('task', {
    task_number: 'TK-2026-799999', title: 'Asset parent lookup', task_type: 'INSPECTION',
    priority: 'LOW', status: 'DRAFT', region_id: REGION_A, asset_id: asset,
    due_date: now, created_at: now, updated_at: now, source: 'MANUAL',
  });
  const { status, body } = await get(`/tasks/${taskId}`);
  assert.strictEqual(status, 200);
  assert.strictEqual(body.asset.line.name, 'Task List Line');
  assert.strictEqual(body.asset.substation.name, 'Task List Substation');
});

test('a single-tower task records its parent line', async () => {
  const sub = insertRow('substation', { substation_id: 'TL-SUB2', name: 'Tower Parent Substation', region_id: REGION_A, latitude: 2, longitude: 2 });
  const line = insertRow('transmission_line', { line_id: 'TL-LINE2', name: 'Tower Parent Line', region_id: REGION_A, from_substation_id: sub, to_substation_id: sub, voltage_kv: 230 });
  const tower = insertRow('tower', { tower_id: 'TL-TWR2', line_id: line, tower_number: 1, latitude: 2.1, longitude: 2.1 });
  const res = await fetch(`${base}/tasks`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      title: 'Tower-only task', task_type: 'INSPECTION', priority: 'LOW',
      region_id: REGION_A, tower_id: tower, due_date: new Date().toISOString(),
    }),
  });
  const body = await res.json();
  assert.strictEqual(res.status, 201, JSON.stringify(body));
  assert.strictEqual(body.tower_id, tower);
  assert.strictEqual(body.line_id, line);
});

test('switching a section task to a single tower updates the target cleanly', async () => {
  const sub = insertRow('substation', { substation_id: 'TL-SUB3', name: 'Section Switch Substation', region_id: REGION_A, latitude: 3, longitude: 3 });
  const line = insertRow('transmission_line', { line_id: 'TL-LINE3', name: 'Section Switch Line', region_id: REGION_A, from_substation_id: sub, to_substation_id: sub, voltage_kv: 230 });
  const from = insertRow('tower', { tower_id: 'TL-TWR3A', line_id: line, tower_number: 1, km_marker: 1, latitude: 3.1, longitude: 3.1 });
  const to = insertRow('tower', { tower_id: 'TL-TWR3B', line_id: line, tower_number: 2, km_marker: 2, latitude: 3.2, longitude: 3.2 });
  const createRes = await fetch(`${base}/tasks`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      title: 'Section task', task_type: 'INSPECTION', priority: 'LOW',
      region_id: REGION_A, tower_from_id: from, tower_to_id: to, due_date: new Date().toISOString(),
    }),
  });
  const created = await createRes.json();
  assert.strictEqual(createRes.status, 201, JSON.stringify(created));
  const res = await fetch(`${base}/tasks/${created.id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ tower_id: from }),
  });
  const body = await res.json();
  assert.strictEqual(res.status, 200, JSON.stringify(body));
  assert.strictEqual(body.tower_id, from);
  assert.strictEqual(body.tower_from_id, null);
  assert.strictEqual(body.tower_to_id, null);
  assert.strictEqual(body.line_id, line);
});
