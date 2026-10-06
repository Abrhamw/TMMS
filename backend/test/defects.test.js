process.env.TMMS_DB = require('node:path').join(require('node:os').tmpdir(), `tmms-def-${process.pid}-${Date.now()}.db`);

const test = require('node:test');
const assert = require('node:assert');

const { initSchema, db } = require('../db');
const { insertRow, get } = require('../util');
initSchema();

const { riskScore, canTransition, createDefectFromFinding } = require('../defects');
const { closureGates } = require('../costing');

const NOW = new Date().toISOString();

function makeTask(suffix) {
  const regionId = insertRow('region', { code: `DEF-R-${suffix}`, name: 'Def', type: 'CUSTOM', center_lat: 0, center_lng: 0, boundary: 1, status: 'ACTIVE', timezone: 'UTC' });
  return insertRow('task', {
    task_number: `TK-2026-73${suffix}`, title: `Def ${suffix}`, task_type: 'INSPECTION', priority: 'LOW',
    status: 'COMPLETED', result: 'FAIL', region_id: regionId, due_date: NOW, created_at: NOW, updated_at: NOW, source: 'MANUAL',
  });
}

test('riskScore combines severity and likelihood on a bounded scale', () => {
  assert.strictEqual(riskScore('CRITICAL', 'LIKELY'), 16);
  assert.strictEqual(riskScore('HIGH', 'POSSIBLE'), 9);
  assert.strictEqual(riskScore('LOW', 'RARE'), 1);
  assert.strictEqual(riskScore('CRITICAL', null), null);
});

test('defect transitions are forward-only with explicit reopen', () => {
  assert.strictEqual(canTransition('OPEN', 'IN_PROGRESS'), true);
  assert.strictEqual(canTransition('RESOLVED', 'CLOSED'), true);
  assert.strictEqual(canTransition('CLOSED', 'OPEN'), false);
  assert.strictEqual(canTransition('ACCEPTED', 'RESOLVED'), false);
});

test('createDefectFromFinding is limited to critical/high and is idempotent', () => {
  const taskId = makeTask('0001');
  const task = get('task', taskId);
  const low = get('task_finding', insertRow('task_finding', { task_id: taskId, title: 'Minor', severity: 'MEDIUM', captured_at: NOW }));
  assert.strictEqual(createDefectFromFinding(low, task, null, 1), null);

  const critical = get('task_finding', insertRow('task_finding', { task_id: taskId, title: 'Bushing cracked', severity: 'CRITICAL', detail: 'SF6 leak', captured_at: NOW }));
  const first = createDefectFromFinding(critical, task, null, null);
  const second = createDefectFromFinding(critical, task, null, null);
  assert.strictEqual(first, second);
  const count = db.prepare('SELECT COUNT(*) c FROM defect WHERE finding_id = ?').get(critical.id).c;
  assert.strictEqual(count, 1);
  const defect = get('defect', first);
  assert.strictEqual(defect.severity, 'CRITICAL');
  assert.strictEqual(defect.status, 'OPEN');
});

test('an open defect keeps the task out of closure until it is closed', () => {
  const taskId = makeTask('0002');
  db.prepare('UPDATE task SET cost_reconciled_at = ? WHERE id = ?').run(NOW, taskId);
  const finding = get('task_finding', insertRow('task_finding', { task_id: taskId, title: 'Oil leak', severity: 'HIGH', captured_at: NOW }));
  const defectId = createDefectFromFinding(finding, get('task', taskId), null, null);

  let evaluation = closureGates(get('task', taskId));
  assert.strictEqual(evaluation.gates.find((g) => g.gate === 'FOLLOW_UP').satisfied, false);
  assert.strictEqual(evaluation.ready_to_close, false);

  db.prepare("UPDATE defect SET status = 'CLOSED', root_cause_category = 'MATERIAL', disposition = 'CORRECTED' WHERE id = ?").run(defectId);
  evaluation = closureGates(get('task', taskId));
  assert.strictEqual(evaluation.gates.find((g) => g.gate === 'FOLLOW_UP').satisfied, true);
  assert.strictEqual(evaluation.ready_to_close, true);
});
