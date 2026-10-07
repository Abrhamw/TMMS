process.env.TMMS_DB = require('node:path').join(require('node:os').tmpdir(), `tmms-finance-auth-${process.pid}-${Date.now()}.db`);

const test = require('node:test');
const assert = require('node:assert');
const express = require('express');

const { initSchema } = require('../db');
const { insertRow } = require('../util');
const { requireAuth, createSession, hashPassword } = require('../auth');

initSchema();

const NOW = new Date().toISOString();

function tokenFor(role, regionId = null) {
  const id = insertRow('user', {
    username: `auth-${role}-${Math.random().toString(16).slice(2)}`,
    password_hash: hashPassword('x'), role, region_id: regionId, active: 1, created_at: NOW,
  });
  return createSession(id);
}

const regionId = insertRow('region', {
  code: 'AUTH-R1', name: 'Auth Region', type: 'CUSTOM', center_lat: 0, center_lng: 0,
  boundary: 1, status: 'ACTIVE', timezone: 'UTC',
});
const taskId = insertRow('task', {
  task_number: 'TK-2026-9999', title: 'Auth task', task_type: 'INSPECTION', priority: 'LOW',
  status: 'OPEN', result: null, region_id: regionId, due_date: NOW,
  created_at: NOW, updated_at: NOW, source: 'MANUAL',
});

const app = express();
app.use(express.json());
app.use(requireAuth);
app.use('/api', require('../routes/budget'));
app.use('/api', require('../routes/procurement'));
app.use('/api', require('../routes/costing'));

let server;
let base;

test.before(() => new Promise((resolve) => {
  server = app.listen(0, '127.0.0.1', () => { base = `http://127.0.0.1:${server.address().port}`; resolve(); });
}));
test.after(() => new Promise((resolve) => server.close(resolve)));

function call(method, path, token, body) {
  return fetch(`${base}${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
}

test('read routes accept task:read and reject anonymous tokens', async () => {
  const viewer = tokenFor('VIEWER');
  assert.strictEqual((await call('GET', '/api/cost-centers', viewer)).status, 200);
  assert.strictEqual((await call('GET', '/api/budgets', viewer)).status, 200);
  assert.strictEqual((await call('GET', '/api/suppliers', viewer)).status, 200);
  assert.strictEqual((await call('GET', '/api/purchase-orders', viewer)).status, 200);
  assert.strictEqual((await call('GET', '/api/cost-centers', 'not-a-token')).status, 401);
});

test('master-data mutations require task:manage', async () => {
  const viewer = tokenFor('VIEWER');
  assert.strictEqual((await call('POST', '/api/cost-centers', viewer, { code: 'AUTH-CC-DENY', name: 'Denied' })).status, 403);
  assert.strictEqual((await call('POST', '/api/suppliers', viewer, { name: 'Denied' })).status, 403);
  assert.strictEqual((await call('POST', '/api/purchase-orders', viewer, { supplier_id: 1 })).status, 403);

  const planner = tokenFor('PLANNER');
  assert.strictEqual((await call('POST', '/api/cost-centers', planner, { code: 'AUTH-CC-OK', name: 'Allowed' })).status, 201);
  const executive = tokenFor('EXECUTIVE');
  assert.strictEqual((await call('POST', '/api/suppliers', executive, { name: 'Exec Supplier' })).status, 201);
});

test('task-scoped cost writes honor manage/verify permissions and region scope', async () => {
  const crew = tokenFor('CREW_MEMBER');
  assert.strictEqual((await call('POST', `/api/tasks/${taskId}/cost-estimates`, crew, { amount: 10 })).status, 403);

  const director = tokenFor('REGION_DIRECTOR', regionId);
  assert.strictEqual((await call('POST', `/api/tasks/${taskId}/cost-estimates`, director, { amount: 10 })).status, 201);
  assert.strictEqual((await call('POST', `/api/tasks/${taskId}/cost-transactions`, director, { amount: 5 })).status, 201);

  const auditor = tokenFor('AUDITOR');
  assert.strictEqual((await call('POST', `/api/tasks/${taskId}/cost-transactions`, auditor, { amount: 5 })).status, 403);
});
