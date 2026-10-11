process.env.TMMS_DB = require('node:path').join(require('node:os').tmpdir(), `tmms-advisory-${process.pid}-${Date.now()}.db`);

const test = require('node:test');
const assert = require('node:assert');
const express = require('express');

const { initSchema, db } = require('../db');
const { insertRow } = require('../util');
const { requireAuth, auditMiddleware, createSession, hashPassword } = require('../auth');

initSchema();

const NOW = new Date().toISOString();

const regionId = insertRow('region', {
  code: 'ADV-R', name: 'Advisory R', type: 'CUSTOM', center_lat: 0, center_lng: 0,
  boundary: 1, status: 'ACTIVE', timezone: 'UTC',
});
const personId = insertRow('person', { first_name: 'Adv', last_name: 'Admin', role: 'STAFF', active: 1 });
const adminId = insertRow('user', {
  username: 'adv-admin', password_hash: hashPassword('x'), role: 'ADMIN',
  person_id: personId, active: 1, created_at: NOW,
});
const adminToken = createSession(adminId);

const templateId = insertRow('checklist_template', {
  name: 'Advisory Template', code: 'ADV-TPL', category: 'INSPECTION', status: 'ACTIVE',
  is_mandatory: 0, requires_supervisor_verification: 0, created_at: NOW, updated_at: NOW,
});

const app = express();
app.use(express.json({ limit: '12mb' }));
app.use(requireAuth, auditMiddleware);
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
async function makeAssigned({ crew = null, template = templateId } = {}) {
  seq += 1;
  const created = await call('POST', '/api/tasks', {
    task_type: 'INSPECTION', title: `Advisory task ${seq}`, priority: 'LOW', due_date: NOW, region_id: regionId,
  });
  assert.strictEqual(created.status, 201);
  const id = (await created.json()).id;
  if (template) insertRow('task_checklist_template', { task_id: id, template_id: template, sequence: 0 });
  db.prepare('UPDATE task SET status = ?, region_id = ?, crew_id = ?, checklist_template_id = ? WHERE id = ?')
    .run('ASSIGNED', regionId, crew, template, id);
  return id;
}

const getTask = (id) => db.prepare('SELECT * FROM task WHERE id = ?').get(id);

test('starting with blockers and no reason asks for a reason and names them', async () => {
  const id = await makeAssigned({ crew: null });
  const res = await call('POST', `/api/tasks/${id}/state`, { action: 'start' });
  assert.strictEqual(res.status, 409);
  const body = await res.json();
  assert.strictEqual(body.code, 'READINESS_REASON_REQUIRED');
  assert.ok(body.blockers.some((b) => b.code === 'NO_CREW'));
  assert.ok(body.blockers.every((b) => typeof b.recommendation === 'string' && b.recommendation.length > 0));
  assert.strictEqual(getTask(id).status, 'ASSIGNED');
});

test('starting with blockers and a reason proceeds and records the override', async () => {
  const id = await makeAssigned({ crew: null });
  const res = await call('POST', `/api/tasks/${id}/state`, {
    action: 'start', readiness_override_reason: 'Crew redirected en route',
  });
  assert.strictEqual(res.status, 200);
  const t = getTask(id);
  assert.strictEqual(t.status, 'IN_PROGRESS');
  assert.strictEqual(t.readiness_override_reason, 'Crew redirected en route');
  assert.ok(t.readiness_override_at);
});

test('a ready task starts without a reason', async () => {
  const leader = insertRow('person', { first_name: 'Ready', last_name: 'Lead', role: 'STAFF', active: 1 });
  const crew = insertRow('crew', {
    name: 'Advisory Crew', crew_code: `ADV-C-${++seq}`, crew_type: 'LINE',
    region_id: regionId, leader_person_id: leader, status: 'AVAILABLE',
  });
  const id = await makeAssigned({ crew });
  const res = await call('POST', `/api/tasks/${id}/state`, { action: 'start' });
  assert.strictEqual(res.status, 200);
  const t = getTask(id);
  assert.strictEqual(t.status, 'IN_PROGRESS');
  assert.strictEqual(t.readiness_override_reason, null);
});
