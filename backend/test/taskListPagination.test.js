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
