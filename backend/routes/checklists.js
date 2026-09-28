const express = require('express');
const { db, list, get, insertRow, updateRow, safeDelete } = require('../util');
const { can, isGlobal, audit } = require('../auth');
const { taskVisible } = require('../authority');
const { resolveTarget } = require('../target');
const { taskReadiness } = require('../readiness');

const router = express.Router();

function execVisible(user, e) {
  if (isGlobal(user)) return true;
  const t = e.task_id ? get('task', e.task_id) : null;
  return !!t && taskVisible(user, t);
}

function personName(id) {
  if (!id) return null;
  const p = get('person', id);
  if (p) {
    const name = [p.first_name, p.last_name].filter(Boolean).join(' ').trim();
    if (name) return name;
  }
  return `person #${id}`;
}

router.get('/checklists', (req, res) => {
  let rows = list('checklist_template');
  const { status, category } = req.query;
  if (status) rows = rows.filter((c) => c.status === status);
  if (category) rows = rows.filter((c) => c.category === category);
  for (const c of rows) {
    c.item_count = db.prepare('SELECT COUNT(*) n FROM checklist_item WHERE template_id = ?').get(c.id).n;
    c.usage_count = db.prepare('SELECT COUNT(*) n FROM task WHERE checklist_template_id = ?').get(c.id).n;
  }
  res.json(rows);
});

router.get('/checklists/:id', (req, res) => {
  const c = get('checklist_template', Number(req.params.id));
  if (!c) return res.status(404).json({ error: 'Checklist not found' });
  c.items = db.prepare('SELECT * FROM checklist_item WHERE template_id = ? ORDER BY sequence').all(c.id);
  c.associated_tasks = db.prepare('SELECT * FROM task WHERE checklist_template_id = ? ORDER BY created_at DESC LIMIT 20')
    .all(c.id)
    .filter((t) => taskVisible(req.user, t));
  res.json(c);
});

router.post('/checklists', (req, res) => {
  if (!can(req, 'checklist:write')) return res.status(403).json({ error: 'Forbidden: requires checklist:write' });
  try {
    const body = { ...req.body, version: 1, status: 'DRAFT', revision: 1 };
    if (!body.code) body.code = `CL-${Date.now().toString(36).toUpperCase()}`;
    const id = insertRow('checklist_template', body);
    audit(req.user, 'CREATE', 'checklist_template', id, req.body);
    res.status(201).json(get('checklist_template', id));
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

router.put('/checklists/:id', (req, res) => {
  if (!can(req, 'checklist:write')) return res.status(403).json({ error: 'Forbidden: requires checklist:write' });
  const allowed = ['name', 'code', 'category', 'asset_type', 'task_type', 'applicable_voltage_kv', 'status', 'is_mandatory', 'requires_supervisor_verification', 'requires_gps_confirmation', 'estimated_minutes', 'safety_notes', 'materials', 'required_personnel'];
  const body = {};
  for (const k of allowed) if (req.body?.[k] !== undefined) body[k] = req.body[k];
  updateRow('checklist_template', Number(req.params.id), body, [], 'revision');
  audit(req.user, 'UPDATE', 'checklist_template', Number(req.params.id), body);
  res.json(get('checklist_template', Number(req.params.id)));
});

router.delete('/checklists/:id', (req, res) => {
  if (!can(req, 'checklist:write')) return res.status(403).json({ error: 'Forbidden: requires checklist:write' });
  const c = get('checklist_template', Number(req.params.id));
  if (!c) return res.status(404).json({ error: 'Checklist not found' });
  const usage = db.prepare('SELECT COUNT(*) n FROM task WHERE checklist_template_id = ?').get(Number(req.params.id)).n;
  if (usage > 0) return res.status(409).json({ error: 'Checklist is referenced by tasks and cannot be deleted' });
  db.prepare('DELETE FROM checklist_item WHERE template_id = ?').run(Number(req.params.id));
  safeDelete('checklist_template', Number(req.params.id));
  audit(req.user, 'DELETE', 'checklist_template', Number(req.params.id), { name: c.name });
  res.json({ ok: true });
});

router.post('/checklists/:id/items', (req, res) => {
  if (!can(req, 'checklist:write')) return res.status(403).json({ error: 'Forbidden: requires checklist:write' });
  const item = insertRow('checklist_item', { ...req.body, template_id: Number(req.params.id) });
  audit(req.user, 'CREATE', 'checklist_item', item, req.body);
  res.status(201).json(get('checklist_item', item));
});

router.put('/checklists/:id/items/:itemId', (req, res) => {
  if (!can(req, 'checklist:write')) return res.status(403).json({ error: 'Forbidden: requires checklist:write' });
  const existing = db.prepare('SELECT id FROM checklist_item WHERE id = ? AND template_id = ?')
    .get(Number(req.params.itemId), Number(req.params.id));
  if (!existing) return res.status(404).json({ error: 'Item not found' });
  const { sequence, section, instruction, response_type, required, pass_criteria, critical_step, test_equipment } = req.body || {};
  const updates = { template_id: Number(req.params.id) };
  if (sequence !== undefined) updates.sequence = Number(sequence);
  if (section !== undefined) updates.section = section;
  if (instruction !== undefined) updates.instruction = instruction;
  if (response_type !== undefined) updates.response_type = response_type;
  if (required !== undefined) updates.required = required ? 1 : 0;
  if (pass_criteria !== undefined) updates.pass_criteria = pass_criteria;
  if (critical_step !== undefined) updates.critical_step = critical_step ? 1 : 0;
  if (test_equipment !== undefined) updates.test_equipment = test_equipment;
  updateRow('checklist_item', Number(req.params.itemId), updates);
  audit(req.user, 'UPDATE', 'checklist_item', Number(req.params.itemId), { template_id: Number(req.params.id), ...updates });
  res.json(get('checklist_item', Number(req.params.itemId)));
});

router.delete('/checklists/:id/items/:itemId', (req, res) => {
  if (!can(req, 'checklist:write')) return res.status(403).json({ error: 'Forbidden: requires checklist:write' });
  db.prepare('DELETE FROM checklist_item WHERE id = ? AND template_id = ?').run(Number(req.params.itemId), Number(req.params.id));
  audit(req.user, 'DELETE', 'checklist_item', Number(req.params.itemId), { template_id: Number(req.params.id) });
  res.json({ ok: true });
});

router.post('/checklists/:id/activate', (req, res) => {
  if (!can(req, 'checklist:write')) return res.status(403).json({ error: 'Forbidden: requires checklist:write' });
  db.prepare("UPDATE checklist_template SET status = 'ACTIVE', revision = revision + 1 WHERE id = ?").run(Number(req.params.id));
  audit(req.user, 'ACTIVATE', 'checklist_template', Number(req.params.id), {});
  res.json(get('checklist_template', Number(req.params.id)));
});

router.get('/checklist-executions', (req, res) => {
  let rows = list('checklist_execution').filter((e) => execVisible(req.user, e));
  const { task_id, result } = req.query;
  if (task_id) rows = rows.filter((e) => e.task_id === Number(task_id));
  if (result) rows = rows.filter((e) => e.result === result);
  const itemQ = db.prepare(
    `SELECT i.*, ci.critical_step, ci.pass_criteria, ci.test_equipment, ci.section
       FROM checklist_execution_item i
       LEFT JOIN checklist_item ci ON ci.id = i.template_item_id
      WHERE i.execution_id = ? ORDER BY i.sequence, i.id`
  );
  for (const e of rows) {
    e.template = get('checklist_template', e.template_id);
    e.task = e.task_id ? get('task', e.task_id) : null;
    // What the field crew worked on: the execution's own asset, else the task's.
    e.asset = get('asset', e.asset_id || (e.task ? e.task.asset_id : null)) || null;
    const crewId = e.task ? e.task.crew_id : null;
    e.crew = crewId ? get('crew', crewId) : null;
    // The asset plus the infrastructure (substation / line / tower) the task
    // names, so the printed execution states where the work happened.
    e.target = resolveTarget({ task: e.task, asset: e.asset });
    e.task_type = e.task ? e.task.task_type : null;
    e.task_number = e.task ? e.task.task_number : null;
    e.task_title = e.task ? e.task.title : null;
    e.task_description = e.task ? e.task.description : null;
    e.task_status = e.task ? e.task.status : null;
    // Who owned each step of the workflow, for the printed record.
    e.created_by_name = e.task ? personName(e.task.created_by) : null;
    e.assigned_by_name = e.task ? personName(e.task.assigned_by) : null;
    e.verified_by_name = e.task ? personName(e.task.verified_by) : null;
    // Eligibility gaps at dispatch time (missed certs, equipment to secure).
    e.readiness = e.task ? taskReadiness(e.task) : null;
    e.executed_by_name = personName(e.executed_by);
    e.item_results = itemQ.all(e.id);
    e.pass_count = e.item_results.filter((i) => i.result === 'PASS').length;
    e.fail_count = e.item_results.filter((i) => i.result === 'FAIL').length;
    e.critical_fail_count = e.item_results.filter((i) => i.result === 'FAIL' && i.critical_step).length;
  }
  res.json(rows);
});

module.exports = router;
