process.env.TMMS_DB = require('node:path').join(require('node:os').tmpdir(), `tmms-gate-${process.pid}-${Date.now()}.db`);

const test = require('node:test');
const assert = require('node:assert');

const { db, initSchema } = require('../db');
const { insertRow } = require('../util');
initSchema();

const { dispatchGate } = require('../readiness');

let seq = 0;
const regionId = insertRow('region', {
  code: 'GATE-R', name: 'Gate Region', type: 'CUSTOM', center_lat: 0, center_lng: 0,
  boundary: 1, status: 'ACTIVE', timezone: 'UTC',
});

function newPerson(first) {
  return insertRow('person', { first_name: first, last_name: 'Gate', role: 'STAFF', active: 1 });
}

function newCrew(leaderId, type = 'LINE') {
  return insertRow('crew', {
    name: `Gate Crew ${++seq}`, crew_code: `GATE-C-${seq}`, crew_type: type,
    region_id: regionId, leader_person_id: leaderId, status: 'AVAILABLE',
  });
}

function newTemplate(overrides = {}) {
  return insertRow('checklist_template', {
    name: `Gate Template ${++seq}`, code: `GATE-TPL-${seq}`, category: 'INSPECTION',
    task_type: 'INSPECTION', status: 'ACTIVE', ...overrides,
  });
}

function newTask(fields) {
  const now = new Date().toISOString();
  return insertRow('task', {
    task_number: `TK-2026-9${String(++seq).padStart(5, '0')}`,
    title: `Gate Task ${seq}`, task_type: 'INSPECTION', priority: 'MEDIUM', status: 'ASSIGNED',
    region_id: regionId, due_date: now, created_at: now, updated_at: now, source: 'MANUAL',
    ...fields,
  });
}

const getTask = (id) => db.prepare('SELECT * FROM task WHERE id = ?').get(id);
const codes = (gate) => gate.blockers.map((b) => b.code);

test('a fully resourced task is ready with no blockers', () => {
  const leader = newPerson('Ready');
  const crew = newCrew(leader);
  const tpl = newTemplate();
  const task = newTask({ crew_id: crew, checklist_template_id: tpl });
  const gate = dispatchGate(getTask(task));
  assert.strictEqual(gate.ready, true);
  assert.deepStrictEqual(gate.blockers, []);
});

test('a task with no resolvable crew is hard-blocked', () => {
  const tpl = newTemplate();
  const task = newTask({ checklist_template_id: tpl });
  const gate = dispatchGate(getTask(task));
  assert.strictEqual(gate.ready, false);
  assert.deepStrictEqual(codes(gate), ['NO_CREW']);
});

test('missing required certification hard-blocks the crew', () => {
  const leader = newPerson('NoCert');
  const crew = newCrew(leader);
  const tpl = newTemplate({ name: 'SF6 gas density check', safety_notes: 'Handle SF6 gas' });
  const task = newTask({ crew_id: crew, checklist_template_id: tpl });
  const gate = dispatchGate(getTask(task));
  assert.strictEqual(gate.ready, false);
  assert.ok(codes(gate).includes('MISSING_CERT'));
});

test('holding the required certification clears the blocker', () => {
  const leader = newPerson('WithCert');
  const crew = newCrew(leader);
  const tpl = newTemplate({ name: 'SF6 gas density check', safety_notes: 'Handle SF6 gas' });
  insertRow('certification', {
    person_id: leader, cert_type: 'SF6_HANDLING', issued_at: '2026-01-01',
    expires_at: '2030-01-01', status: 'VALID',
  });
  const task = newTask({ crew_id: crew, checklist_template_id: tpl });
  const gate = dispatchGate(getTask(task));
  assert.strictEqual(gate.ready, true);
});

test('unconfirmed required equipment hard-blocks until it is checked', () => {
  const leader = newPerson('Equip');
  const crew = newCrew(leader);
  const tpl = newTemplate({ materials: 'Insulated glove' });
  const task = newTask({ crew_id: crew, checklist_template_id: tpl });
  let gate = dispatchGate(getTask(task));
  assert.ok(codes(gate).includes('EQUIPMENT_UNCONFIRMED'));

  insertRow('task_equipment_check', {
    task_id: task, equipment_name: 'Insulated glove', is_available: 1,
    checked_by: leader, checked_at: new Date().toISOString(),
  });
  gate = dispatchGate(getTask(task));
  assert.strictEqual(gate.ready, true);
});

test('a permit-governed task is blocked until the permit is approved', () => {
  const leader = newPerson('Permit');
  const crew = newCrew(leader);
  const tpl = newTemplate();
  insertRow('certification', {
    person_id: leader, cert_type: 'SWITCHING_AUTHORITY', issued_at: '2026-01-01',
    expires_at: '2030-01-01', status: 'VALID',
  });
  const task = newTask({ crew_id: crew, checklist_template_id: tpl, permit_required: 1 });
  let gate = dispatchGate(getTask(task));
  assert.deepStrictEqual(codes(gate), ['PERMIT_NOT_APPROVED']);

  db.prepare('UPDATE task SET permit_approved_at = ? WHERE id = ?').run(new Date().toISOString(), task);
  gate = dispatchGate(getTask(task));
  assert.strictEqual(gate.ready, true);
});

test('an unmapped skill is a warning, not a blocker', () => {
  const leader = newPerson('Unmapped');
  const crew = newCrew(leader);
  const tpl = newTemplate({ required_personnel: 'Skill: Turbo Encabulator.' });
  const task = newTask({ crew_id: crew, checklist_template_id: tpl });
  const gate = dispatchGate(getTask(task));
  assert.strictEqual(gate.ready, true);
  assert.ok(gate.warnings.some((w) => w.code === 'UNMAPPED_SKILL'));
});
