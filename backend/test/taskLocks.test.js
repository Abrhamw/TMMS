process.env.TMMS_DB = require('node:path').join(require('node:os').tmpdir(), `tmms-locks-${process.pid}-${Date.now()}.db`);

const test = require('node:test');
const assert = require('node:assert');
const express = require('express');

const { initSchema, db } = require('../db');
const { insertRow } = require('../util');
const { requireAuth, auditMiddleware, createSession, hashPassword } = require('../auth');

initSchema();

const NOW = new Date().toISOString();

const regionId = insertRow('region', {
  code: 'LOCK-R', name: 'Lock R', type: 'CUSTOM', center_lat: 0, center_lng: 0,
  boundary: 1, status: 'ACTIVE', timezone: 'UTC',
});
const personId = insertRow('person', { first_name: 'Lock', last_name: 'Admin', role: 'STAFF', active: 1 });
const adminId = insertRow('user', {
  username: 'lock-admin', password_hash: hashPassword('x'), role: 'ADMIN',
  person_id: personId, active: 1, created_at: NOW,
});
const adminToken = createSession(adminId);

const templateId = insertRow('checklist_template', {
  name: 'Lock Template', code: 'LOCK-TPL', category: 'INSPECTION', status: 'ACTIVE',
  is_mandatory: 0, requires_supervisor_verification: 0, created_at: NOW, updated_at: NOW,
});
insertRow('checklist_item', {
  template_id: templateId, sequence: 1, instruction: 'Confirm lock', response_type: 'PASS_FAIL', required: 1,
});

const app = express();
app.use(express.json({ limit: '12mb' }));
app.use(requireAuth, auditMiddleware);
app.use('/api', require('../routes/tasks'));
app.use('/api', require('../routes/attachments').router);

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
async function makeTask(status, { withTemplate = false } = {}) {
  seq += 1;
  const created = await call('POST', '/api/tasks', {
    task_type: 'INSPECTION', title: `Lock task ${seq}`, priority: 'LOW', due_date: NOW, region_id: regionId,
  });
  assert.strictEqual(created.status, 201);
  const id = (await created.json()).id;
  if (withTemplate) insertRow('task_checklist_template', { task_id: id, template_id: templateId, sequence: 0 });
  db.prepare('UPDATE task SET status = ?, region_id = ? WHERE id = ?').run(status, regionId, id);
  return id;
}

function setStatus(id, status) {
  db.prepare('UPDATE task SET status = ? WHERE id = ?').run(status, id);
}

const LOCKED = ['PENDING_VERIFICATION', 'COMPLETED'];
const EDITABLE = ['IN_PROGRESS', 'ON_HOLD'];

test('checklist draft and submit are rejected once the task is locked', async () => {
  const draftBody = { template_id: templateId, items: [{ template_item_id: null, sequence: 1, response_value: true }] };
  for (const status of LOCKED) {
    const id = await makeTask(status, { withTemplate: true });
    const draft = await call('POST', `/api/tasks/${id}/checklist/draft`, draftBody);
    assert.strictEqual(draft.status, 409, `draft should lock at ${status}`);
    assert.strictEqual((await draft.json()).code, 'TASK_LOCKED');

    const submit = await call('POST', `/api/tasks/${id}/checklist`, {
      template_id: templateId,
      items: [{ template_item_id: db.prepare('SELECT id FROM checklist_item WHERE template_id = ?').get(templateId).id, sequence: 1, response_value: true }],
    });
    assert.strictEqual(submit.status, 409, `submit should lock at ${status}`);
    assert.strictEqual((await submit.json()).code, 'TASK_LOCKED');
  }
});

test('checklist draft is accepted while the task is in progress', async () => {
  const id = await makeTask('IN_PROGRESS', { withTemplate: true });
  const draft = await call('POST', `/api/tasks/${id}/checklist/draft`, {
    template_id: templateId,
    items: [{ template_item_id: null, sequence: 1, response_value: true }],
  });
  assert.strictEqual(draft.status, 200);
});

test('reopening a submitted task unlocks the checklist', async () => {
  const id = await makeTask('PENDING_VERIFICATION', { withTemplate: true });
  setStatus(id, 'IN_PROGRESS');
  const draft = await call('POST', `/api/tasks/${id}/checklist/draft`, {
    template_id: templateId,
    items: [{ template_item_id: null, sequence: 1, response_value: true }],
  });
  assert.strictEqual(draft.status, 200);
});

test('equipment checks stay open in progress and lock after submission', async () => {
  for (const status of EDITABLE) {
    const id = await makeTask(status);
    const res = await call('PUT', `/api/tasks/${id}/equipment-checks`, { checks: [] });
    assert.strictEqual(res.status, 200, `equipment should be editable at ${status}`);
  }
  for (const status of LOCKED) {
    const id = await makeTask(status);
    const res = await call('PUT', `/api/tasks/${id}/equipment-checks`, { checks: [] });
    assert.strictEqual(res.status, 409, `equipment should lock at ${status}`);
    assert.strictEqual((await res.json()).code, 'TASK_LOCKED');
  }
});

test('work-items, metadata, findings and permit are locked after submission', async () => {
  const lockedId = await makeTask('PENDING_VERIFICATION');
  const editableId = await makeTask('IN_PROGRESS');

  const lockedItem = insertRow('task_work_item', { task_id: lockedId, sequence: 1, kind: 'REMEDIATE', title: 'Do', status: 'OPEN', created_at: NOW });
  const openItem = insertRow('task_work_item', { task_id: editableId, sequence: 1, kind: 'REMEDIATE', title: 'Do', status: 'OPEN', created_at: NOW });

  const workLocked = await call('PATCH', `/api/tasks/${lockedId}/work-items/${lockedItem}`, { status: 'DONE' });
  assert.strictEqual(workLocked.status, 409);
  assert.strictEqual((await workLocked.json()).code, 'TASK_LOCKED');
  const workOpen = await call('PATCH', `/api/tasks/${editableId}/work-items/${openItem}`, { status: 'DONE' });
  assert.strictEqual(workOpen.status, 200);

  const metaLocked = await call('PUT', `/api/tasks/${lockedId}`, { title: 'Nope' });
  assert.strictEqual(metaLocked.status, 409);
  const metaOpen = await call('PUT', `/api/tasks/${editableId}`, { title: 'Renamed' });
  assert.strictEqual(metaOpen.status, 200);

  const findLocked = await call('POST', `/api/tasks/${lockedId}/findings`, { title: 'Nope' });
  assert.strictEqual(findLocked.status, 409);
  const findOpen = await call('POST', `/api/tasks/${editableId}/findings`, { title: 'Observed' });
  assert.strictEqual(findOpen.status, 201);

  const permitLocked = await call('POST', `/api/tasks/${lockedId}/permit`, { reference: 'P-1' });
  assert.strictEqual(permitLocked.status, 409);
  const permitOpen = await call('POST', `/api/tasks/${editableId}/permit`, { reference: 'P-1' });
  assert.strictEqual(permitOpen.status, 200);
});

test('checklist GET exposes whether the task is editable', async () => {
  const open = await makeTask('IN_PROGRESS', { withTemplate: true });
  const openBody = await (await call('GET', `/api/tasks/${open}/checklist`)).json();
  assert.strictEqual(openBody.editable, true);

  const locked = await makeTask('PENDING_VERIFICATION', { withTemplate: true });
  const lockedBody = await (await call('GET', `/api/tasks/${locked}/checklist`)).json();
  assert.strictEqual(lockedBody.editable, false);
});
