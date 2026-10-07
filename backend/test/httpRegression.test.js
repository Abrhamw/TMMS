process.env.TMMS_DB = require('node:path').join(require('node:os').tmpdir(), `tmms-http-${process.pid}-${Date.now()}.db`);

const test = require('node:test');
const assert = require('node:assert');
const express = require('express');

const { initSchema } = require('../db');
const { insertRow } = require('../util');
const { requireAuth, auditMiddleware, createSession, hashPassword } = require('../auth');

initSchema();

const NOW = new Date().toISOString();

function region(code) {
  return insertRow('region', {
    code, name: code, type: 'CUSTOM', center_lat: 0, center_lng: 0,
    boundary: 1, status: 'ACTIVE', timezone: 'UTC',
  });
}

function person(first, last) {
  return insertRow('person', { first_name: first, last_name: last, role: 'STAFF', active: 1 });
}

function tokenFor(role, { regionId = null, personId = null } = {}) {
  const id = insertRow('user', {
    username: `http-${role}-${Math.random().toString(16).slice(2)}`,
    password_hash: hashPassword('x'), role, region_id: regionId, person_id: personId,
    active: 1, created_at: NOW,
  });
  return createSession(id);
}

const regionA = region('HTTP-A');
const regionB = region('HTTP-B');
const managerPerson = person('Man', 'Ager');
const adminToken = tokenFor('ADMIN');
const managerToken = tokenFor('REGION_MANAGER', { regionId: regionA, personId: managerPerson });
const viewerToken = tokenFor('VIEWER');
const otherDirectorToken = tokenFor('REGION_DIRECTOR', { regionId: regionB });

const app = express();
app.use(express.json({ limit: '12mb' }));
app.use(requireAuth, auditMiddleware);
app.use('/api', require('../routes/tasks'));
app.use('/api', require('../routes/admin'));
app.use('/api', require('../routes/attachments').router);
app.use((err, req, res, next) => {
  if (res.headersSent) return next(err);
  if (err && err.type === 'entity.too.large') return res.status(413).json({ error: 'Request body too large' });
  res.status(500).json({ error: err && err.message ? err.message : 'Internal error' });
});

let server;
let base;

test.before(() => new Promise((resolve) => {
  server = app.listen(0, '127.0.0.1', () => { base = `http://127.0.0.1:${server.address().port}`; resolve(); });
}));
test.after(() => new Promise((resolve) => server.close(resolve)));

function call(method, path, token, body) {
  return fetch(`${base}${path}`, {
    method,
    headers: token ? { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' } : { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
}

let taskId;

test('task creation enforces task:create and assigns a task number', async () => {
  const denied = await call('POST', '/api/tasks', viewerToken, { task_type: 'INSPECTION', title: 'Denied' });
  assert.strictEqual(denied.status, 403);

  const created = await call('POST', '/api/tasks', managerToken, { task_type: 'INSPECTION', title: 'HTTP task', priority: 'LOW', due_date: NOW });
  assert.strictEqual(created.status, 201);
  const body = await created.json();
  assert.ok(body.task_number);
  assert.strictEqual(body.title, 'HTTP task');
  taskId = body.id;
});

test('task updates enforce task:manage and region scope', async () => {
  const denied = await call('PUT', `/api/tasks/${taskId}`, viewerToken, { title: 'Nope' });
  assert.strictEqual(denied.status, 403);

  const updated = await call('PUT', `/api/tasks/${taskId}`, managerToken, { title: 'Updated title' });
  assert.strictEqual(updated.status, 200);
  assert.strictEqual((await updated.json()).title, 'Updated title');

  const scoped = await call('GET', `/api/tasks/${taskId}`, otherDirectorToken);
  assert.strictEqual(scoped.status, 404);
});

test('admin routes are ADMIN-only', async () => {
  assert.strictEqual((await call('GET', '/api/settings', viewerToken)).status, 200);
  assert.strictEqual((await call('PUT', '/api/settings', managerToken, { currency: 'ETB' })).status, 403);

  const settings = await call('PUT', '/api/settings', adminToken, { currency: 'ETB' });
  assert.strictEqual(settings.status, 200);
  assert.strictEqual((await settings.json()).currency, 'ETB');

  assert.strictEqual((await call('GET', '/api/users', managerToken)).status, 403);
  const users = await call('GET', '/api/users', adminToken);
  assert.strictEqual(users.status, 200);
  assert.ok(Array.isArray(await users.json()));

  assert.strictEqual((await call('POST', '/api/users', managerToken, { username: 'x-1', password: 'password1', role: 'VIEWER' })).status, 403);
  const created = await call('POST', '/api/users', adminToken, { username: 'made-by-admin', password: 'password1', role: 'VIEWER' });
  assert.strictEqual(created.status, 201);

  assert.strictEqual((await call('GET', '/api/audit', managerToken)).status, 403);
  assert.strictEqual((await call('GET', '/api/audit', adminToken)).status, 200);
});

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d]);

test('attachment upload validates permission, type and idempotency', async () => {
  const denied = await call('POST', `/api/tasks/${taskId}/attachments`, viewerToken, { data: PNG_SIGNATURE.toString('base64'), file_name: 'a.png' });
  assert.strictEqual(denied.status, 403);

  const unsupported = await call('POST', `/api/tasks/${taskId}/attachments`, managerToken, {
    data: Buffer.from('plain text, not an image').toString('base64'), file_name: 'notes.txt',
  });
  assert.strictEqual(unsupported.status, 415);

  const first = await call('POST', `/api/tasks/${taskId}/attachments`, managerToken, {
    data: PNG_SIGNATURE.toString('base64'), file_name: 'shot.png', kind: 'PHOTO', client_ref: 'http-ref-1',
  });
  assert.strictEqual(first.status, 201);
  const uploaded = await first.json();
  assert.strictEqual(uploaded.mime, 'image/png');
  assert.strictEqual(uploaded.size_bytes, PNG_SIGNATURE.length);

  const replay = await call('POST', `/api/tasks/${taskId}/attachments`, managerToken, {
    data: PNG_SIGNATURE.toString('base64'), file_name: 'shot.png', kind: 'PHOTO', client_ref: 'http-ref-1',
  });
  assert.strictEqual(replay.status, 200);
  assert.strictEqual((await replay.json()).id, uploaded.id);
});
