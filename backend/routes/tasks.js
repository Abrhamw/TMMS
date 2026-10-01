const express = require('express');
const { db, list, get, insertRow, updateRow, withTx, parseRow, byClientRef } = require('../util');
const { haversine } = require('../geo');
const { evaluateViolation, flag } = require('../geofence');
const { can, isGlobal, audit, isCrewUser, isOnCrew, scopeRows } = require('../auth');
const { listForTask } = require('./attachments');
const { taskProgress } = require('../taskProgress');
const { syncCrewStatus } = require('../crewStatus');
const recurrence = require('../recurrence');
const { validatePoints, coverage } = require('../inspectionTrace');
const { projectPointToRoute } = require('../lineGeometry');
const { maxTaskSeq, formatTaskNumber, nextTaskNumber } = require('../taskNumber');
const { canAssignCrew, taskVisible, authorizedCrewIds } = require('../authority');
const { taskReadiness, taskRequirements, resolveTaskCrewId, taskCrewSource } = require('../readiness');
const { readyCrew, scoreCrewFit } = require('../assignment');
const { resolveTarget, infraName, assetName } = require('../target');
const { sendMail, primaryUserForPerson, immediateBossForTask } = require('../mail');

const router = express.Router();

const OPEN = ["DRAFT", "SCHEDULED", "ASSIGNED", "IN_PROGRESS", "ON_HOLD", "PENDING_VERIFICATION"];

// Non-blocking dispatch advisory shown before committing a crew to a
// checklist-governed task. Null when the task has no checklist template.
function taskDispatchAdvisory(task, crewId) {
  if (!task || !task.checklist_template_id || !crewId) return null;
  const audit = taskReadiness({ ...task, crew_id: crewId });
  if (!audit || !audit.requirements) return null;
  return {
    checklist_template_id: audit.template.id,
    template_code: audit.template.code,
    template_name: audit.template.name,
    eligible: audit.eligible,
    missing_skills: audit.missing_skills,
    unmapped_skills: audit.unmapped_skills,
    missing_certs: audit.missing_certs,
    recommended_certs: audit.requirements.recommended_certs,
    certs_to_obtain: audit.certs_to_obtain,
    recommendations: audit.certs_to_obtain.map((c) => ({
      cert: c.cert, reason: c.reason, required: c.required,
      message: `${c.required ? 'Obtain' : 'Recommended'}: ${c.cert} — ${c.reason}`,
    })),
    team_shortfall: audit.team_shortfall,
    equipment_to_secure: audit.equipment_to_secure,
    warnings: audit.warnings.map((message) => ({ type: 'DISPATCH', message })),
  };
}

// Notify the assigned crew (leader + active members) of the equipment their
// checklist calls for. This is an instruction only: it is sent after the
// assignment is committed and never blocks or gates starting the task. Tasks
// with no checklist have nothing to instruct and produce no mail.
function sendAssignmentInstruction(req, task, crewId) {
  if (!task || !crewId) return null;
  const crew = get('crew', Number(crewId));
  if (!crew) return null;
  const readiness = taskReadiness({ ...task, crew_id: Number(crewId) });
  if (!readiness || !readiness.requirements) return null;

  const recipients = new Set();
  // Every active crew member plus the designated lead receives the instruction.
  if (crew.leader_person_id) recipients.add(Number(crew.leader_person_id));
  for (const m of db.prepare('SELECT person_id FROM crew_member WHERE crew_id = ? AND active = 1').all(crew.id)) {
    if (m.person_id) recipients.add(Number(m.person_id));
  }
  recipients.delete(0);
  if (req.user.person_id) recipients.delete(Number(req.user.person_id));
  if (!recipients.size) return null;

  const target = resolveTarget({ task });
  const place = [infraName(target), assetName(target)].filter(Boolean).join(' · ');
  const equipment = readiness.equipment_checks || [];
  const notes = [];
  if (readiness.team_shortfall) notes.push(`Team short by ${readiness.team_shortfall}`);
  for (const w of (readiness.warnings || [])) notes.push(w);

  const body = [
    `You have been assigned ${task.task_number} — ${task.title}.`,
    place ? `Where: ${place}` : null,
    task.scheduled_start ? `Scheduled: ${task.scheduled_start}` : null,
    task.due_date ? `Due: ${task.due_date}` : null,
    '',
    'Required equipment for this task (from the checklist):',
    ...(equipment.length
      ? equipment.map((e) => `  [${e.available ? 'x' : ' '}] ${e.equipment}${e.available ? ' (confirmed available)' : ' (to secure)'}`)
      : ['  (none listed)']),
    ...(notes.length ? ['', 'Notes:', ...notes.map((n) => `  - ${n}`)] : []),
    '',
    `Open the task: /tasks/${task.id}`,
  ].filter((x) => x != null).join('\n');

  const sent = [];
  for (const pid of recipients) {
    const id = sendMail({
      senderUserId: req.user.id,
      senderPersonId: req.user.person_id || null,
      recipientPersonId: pid,
      subject: `Assigned: ${task.task_number} — equipment to bring`,
      body,
      category: ['HIGH', 'CRITICAL'].includes(task.priority) ? 'ALERT' : 'REQUEST',
      priority: ['HIGH', 'CRITICAL'].includes(task.priority) ? 'HIGH' : 'NORMAL',
      entityType: 'task',
      entityId: task.id,
      link: `/tasks/${task.id}`,
    });
    if (id) sent.push(id);
  }
  return sent;
}

// Columns a client may set when creating/editing a task. Everything else
// (task_number, status, result, verified_by, actual_*, revision, source,
// schedule_id, created_by...) is server-controlled and must not be
// mass-assigned from the request body.
const TASK_WRITABLE = [
  'title', 'description', 'task_type', 'priority', 'priority_reason', 'due_date',
  'scheduled_start', 'scheduled_end', 'region_id', 'substation_id', 'line_id',
  'tower_id', 'asset_id', 'checklist_template_id', 'checklist_template_ids', 'crew_id',
  'permit_required', 'is_energized_work',
];

function pickTaskFields(body) {
  const out = {};
  for (const k of TASK_WRITABLE) {
    if (body && body[k] !== undefined) out[k] = body[k];
  }
  return out;
}

// A task may be governed by more than one checklist template. The
// task_checklist_template join table is the source of truth; the legacy
// task.checklist_template_id column mirrors the first selection so schedule
// generation, follow-up carry and older consumers keep working unchanged.
function taskTemplateIds(taskId) {
  const rows = db.prepare(
    'SELECT template_id FROM task_checklist_template WHERE task_id = ? ORDER BY sequence, template_id'
  ).all(taskId);
  if (rows.length) return rows.map((r) => r.template_id);
  const t = get('task', taskId);
  return t && t.checklist_template_id ? [t.checklist_template_id] : [];
}

function taskTemplateIdsMap() {
  const map = new Map();
  for (const r of db.prepare(
    'SELECT task_id, template_id FROM task_checklist_template ORDER BY task_id, sequence, template_id'
  ).all()) {
    if (!map.has(r.task_id)) map.set(r.task_id, []);
    map.get(r.task_id).push(r.template_id);
  }
  return map;
}

// Replace a task's checklist templates. Every id must reference an existing
// template; duplicates are dropped and order is preserved as the selection
// sequence. task.checklist_template_id is kept in sync with the first choice.
function setTaskTemplates(taskId, ids) {
  const clean = [...new Set((ids || []).map(Number).filter((n) => Number.isInteger(n) && n > 0))];
  for (const tid of clean) {
    if (!get('checklist_template', tid)) throw new Error(`Checklist template ${tid} not found`);
  }
  db.prepare('DELETE FROM task_checklist_template WHERE task_id = ?').run(taskId);
  clean.forEach((tid, i) => {
    db.prepare('INSERT INTO task_checklist_template (task_id, template_id, sequence) VALUES (?,?,?)').run(taskId, tid, i);
  });
  db.prepare('UPDATE task SET checklist_template_id = ? WHERE id = ?').run(clean[0] || null, taskId);
  return clean;
}

// Normalise the several shapes a caller may send for checklist selection into a
// single ordered id array: an explicit checklist_template_ids array, a lone
// checklist_template_ids value, or the legacy single checklist_template_id.
function requestedTemplateIds(fields) {
  if (Array.isArray(fields.checklist_template_ids)) return fields.checklist_template_ids;
  if (fields.checklist_template_ids !== undefined) {
    return fields.checklist_template_ids === null || fields.checklist_template_ids === ''
      ? []
      : [fields.checklist_template_ids];
  }
  if (fields.checklist_template_id === null || fields.checklist_template_id === '') return [];
  if (fields.checklist_template_id !== undefined) return [fields.checklist_template_id];
  return null;
}

function taskDetail(t) {
  if (!t) return t;
  const out = { ...t, ...taskProgress(t.id) };
  out.region = t.region_id ? get('region', t.region_id) : null;
  out.substation = t.substation_id ? get('substation', t.substation_id) : null;
  out.line = t.line_id ? get('transmission_line', t.line_id, ['route_json']) : null;
  out.tower = t.tower_id ? get('tower', t.tower_id) : null;
  out.asset = t.asset_id ? get('asset', t.asset_id) : null;
  out.crew = t.crew_id ? get('crew', t.crew_id) : null;
  out.checklist_template = t.checklist_template_id ? get('checklist_template', t.checklist_template_id) : null;
  out.checklist_templates = taskTemplateIds(t.id)
    .map((tid) => get('checklist_template', tid))
    .filter(Boolean);
  out.schedule = t.schedule_id ? get('maintenance_schedule', t.schedule_id) : null;
  out.links = db.prepare('SELECT * FROM task_link WHERE task_id = ?').all(t.id);
  return out;
}

// Batched variant of taskDetail for list endpoints. Loads every lookup table
// once and computes checklist progress for all tasks in a single aggregate
// query instead of running ~11 queries per row.
function indexById(rows) {
  const m = new Map();
  for (const r of rows) m.set(r.id, r);
  return m;
}

function taskProgressMap() {
  const rows = db.prepare(
    `SELECT m.task_id,
            SUM(CASE WHEN i.result = 'PASS' THEN 1 ELSE 0 END) AS passed,
            SUM(CASE WHEN i.result IN ('PASS','FAIL') THEN 1 ELSE 0 END) AS graded
     FROM (SELECT task_id, template_id, MAX(id) AS exec_id
             FROM checklist_execution
            WHERE submitted_at IS NOT NULL
            GROUP BY task_id, template_id) m
     JOIN checklist_execution_item i ON i.execution_id = m.exec_id
     GROUP BY m.task_id`
  ).all();
  const m = new Map();
  for (const r of rows) {
    const graded = Number(r.graded) || 0;
    const passed = Number(r.passed) || 0;
    m.set(r.task_id, {
      progress_pct: graded > 0 ? Math.round((passed / graded) * 100) : 0,
      progress_graded: graded,
      progress_passed: passed,
    });
  }
  return m;
}

function taskDetails(rows) {
  const regions = indexById(list('region'));
  const substations = indexById(list('substation'));
  const lines = indexById(db.prepare('SELECT * FROM transmission_line').all());
  for (const l of lines.values()) {
    if (typeof l.route_json === 'string') {
      try { l.route_json = JSON.parse(l.route_json); } catch { /* keep raw */ }
    }
  }
  const towers = indexById(list('tower'));
  const assets = indexById(list('asset'));
  const crews = indexById(list('crew'));
  const templates = indexById(list('checklist_template'));
  const taskTemplates = taskTemplateIdsMap();
  const schedules = indexById(list('maintenance_schedule'));
  const progress = taskProgressMap();
  const links = new Map();
  for (const l of db.prepare('SELECT * FROM task_link').all()) {
    if (!links.has(l.task_id)) links.set(l.task_id, []);
    links.get(l.task_id).push(l);
  }
  return rows.map((t) => {
    const p = progress.get(t.id) || { progress_pct: 0, progress_graded: 0, progress_passed: 0 };
    const out = {
      ...t,
      ...p,
      region: t.region_id ? regions.get(t.region_id) || null : null,
      substation: t.substation_id ? substations.get(t.substation_id) || null : null,
      line: t.line_id ? lines.get(t.line_id) || null : null,
      tower: t.tower_id ? towers.get(t.tower_id) || null : null,
      asset: t.asset_id ? assets.get(t.asset_id) || null : null,
      crew: t.crew_id ? crews.get(t.crew_id) || null : null,
      checklist_template: t.checklist_template_id ? templates.get(t.checklist_template_id) || null : null,
      checklist_templates: (taskTemplates.get(t.id) || (t.checklist_template_id ? [t.checklist_template_id] : []))
        .map((tid) => templates.get(tid) || null).filter(Boolean),
      schedule: t.schedule_id ? schedules.get(t.schedule_id) || null : null,
      links: links.get(t.id) || [],
    };
    return out;
  });
}

function listWorkItems(taskId) {
  return db.prepare('SELECT * FROM task_work_item WHERE task_id = ? ORDER BY sequence').all(taskId);
}

function personLabel(id) {
  if (!id) return null;
  const p = get('person', id);
  if (p) {
    const name = [p.first_name, p.last_name].filter(Boolean).join(' ').trim();
    if (name) return name;
  }
  return `person #${id}`;
}

// Checklist executions for one task with the executing crew and person
// resolved and every recorded step attached, so the task page can show *who*
// did the work and the item-by-item pass/fail rather than a bare execution id.
function executionsForTask(t) {
  const crew = t && t.crew_id ? get('crew', t.crew_id) : null;
  const rows = db.prepare(
    `SELECT e.*, p.first_name || ' ' || p.last_name AS executed_by_name
       FROM checklist_execution e
       LEFT JOIN person p ON p.id = e.executed_by
      WHERE e.task_id = ? ORDER BY e.submitted_at DESC, e.id DESC`
  ).all(t.id);
  const itemQ = db.prepare(
    `SELECT i.*, ci.critical_step
       FROM checklist_execution_item i
       LEFT JOIN checklist_item ci ON ci.id = i.template_item_id
      WHERE i.execution_id = ? ORDER BY i.sequence, i.id`
  );
  const readiness = taskReadiness(t);
  return rows.map((e) => {
    const items = itemQ.all(e.id);
    const tpl = e.template_id ? get('checklist_template', e.template_id) : null;
    return {
      ...e,
      crew_id: e.crew_id != null ? e.crew_id : (crew ? crew.id : null),
      crew_name: crew ? crew.name : null,
      crew_code: crew ? crew.crew_code : null,
      executed_by_name: e.executed_by_name || personLabel(e.executed_by),
      // The asset and the infrastructure this execution was carried out on.
      target: resolveTarget({ task: t, asset: e.asset_id ? get('asset', e.asset_id) : null }),
      task_type: t.task_type,
      task_number: t.task_number,
      task_title: t.title,
      task_description: t.description,
      task_status: t.status,
      // Who owned each step of the workflow, for the printed record.
      created_by_name: personLabel(t.created_by),
      assigned_by_name: personLabel(t.assigned_by),
      verified_by_name: personLabel(t.verified_by),
      // Eligibility gaps at dispatch time (missed certs, equipment to secure).
      readiness,
      template_name: tpl ? tpl.name : null,
      items,
      item_count: items.length,
      pass_count: items.filter((i) => i.result === 'PASS').length,
      fail_count: items.filter((i) => i.result === 'FAIL').length,
    };
  });
}

// Derive the ordered work-item list a follow-up task should carry, from the
// evidence recorded on a completed source task. Ordering: failed critical
// checklist steps (in template order), then HIGH/CRITICAL findings (critical
// first), then one GPS item, then a defensive REMEDIATE fallback.
function deriveWorkItems(source) {
  const items = [];
  const failedCritical = db.prepare(
    `SELECT ci.id AS template_item_id, ci.sequence, ci.instruction
     FROM checklist_execution_item i
     JOIN checklist_item ci ON ci.id = i.template_item_id
     JOIN checklist_execution e ON e.id = i.execution_id
     WHERE e.task_id = ? AND i.result = 'FAIL' AND ci.critical_step = 1
     GROUP BY ci.id ORDER BY ci.sequence`
  ).all(source.id);
  for (const s of failedCritical) {
    items.push({ kind: 'CHECKLIST', title: s.instruction, source_type: 'checklist_item', source_id: s.template_item_id });
  }
  const findings = db.prepare(
    `SELECT id, title, detail, severity FROM task_finding
     WHERE task_id = ? AND severity IN ('HIGH','CRITICAL') ORDER BY CASE severity WHEN 'CRITICAL' THEN 0 ELSE 1 END, id`
  ).all(source.id);
  for (const f of findings) {
    items.push({ kind: 'FINDING', title: f.title, detail: f.detail || null, source_type: 'task_finding', source_id: f.id });
  }
  const gpsItemFail = db.prepare(
    `SELECT COUNT(*) c FROM checklist_execution_item i JOIN checklist_execution e ON e.id = i.execution_id
     WHERE e.task_id = ? AND i.result = 'FAIL' AND i.response_type = 'GPS_POINT'`
  ).get(source.id).c;
  const gpsFail = db.prepare("SELECT COUNT(*) c FROM gps_validation WHERE linked_task_id = ? AND result = 'FAIL'").get(source.id).c;
  if (gpsItemFail > 0 || gpsFail > 0) {
    items.push({ kind: 'GPS', title: 'GPS location mismatch — re-verify position', source_type: 'gps_validation', source_id: null });
  }
  if (items.length === 0 && (source.result === 'FAIL' || source.status === 'FAILED')) {
    items.push({ kind: 'REMEDIATE', title: 'Inspect and remediate the affected asset', source_type: null, source_id: null });
  }
  return items;
}

function scopedTasks(req) {
  let rows = list('task').filter((t) => taskVisible(req.user, t));
  const { status, region_id, task_type, priority, overdue, q, crew_id, line_id, tower_id, asset_id, substation_id } = req.query;
  if (status) rows = rows.filter((t) => t.status === status);
  if (region_id) rows = rows.filter((t) => t.region_id === Number(region_id));
  if (task_type) rows = rows.filter((t) => t.task_type === task_type);
  if (priority) rows = rows.filter((t) => t.priority === priority);
  if (crew_id) rows = rows.filter((t) => t.crew_id === Number(crew_id));
  if (line_id) rows = rows.filter((t) => t.line_id === Number(line_id));
  if (tower_id) rows = rows.filter((t) => t.tower_id === Number(tower_id));
  if (asset_id) rows = rows.filter((t) => t.asset_id === Number(asset_id));
  if (substation_id) rows = rows.filter((t) => t.substation_id === Number(substation_id));
  if (q) rows = rows.filter((t) => (t.title + t.task_number).toLowerCase().includes(q.toLowerCase()));
  if (overdue === 'true') {
    const now = new Date().toISOString();
    rows = rows.filter((t) => OPEN.includes(t.status) && t.due_date < now);
  }
  return rows;
}

router.get('/tasks', (req, res) => {
  res.json(taskDetails(scopedTasks(req)));
});

function csvField(v) {
  const s = v === null || v === undefined ? '' : String(v);
  return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

function taskTarget(t) {
  if (t.asset_id) return { type: 'ASSET', name: get('asset', t.asset_id)?.name || '' };
  if (t.tower_id) return { type: 'TOWER', name: get('tower', t.tower_id)?.tower_id || '' };
  if (t.substation_id) return { type: 'SUBSTATION', name: get('substation', t.substation_id)?.name || '' };
  if (t.line_id) return { type: 'LINE', name: get('transmission_line', t.line_id)?.name || '' };
  return { type: 'NONE', name: '' };
}

router.get('/tasks/export.csv', (req, res) => {
  if (!can(req, 'task:read')) return res.status(403).json({ error: 'Forbidden: requires task:read' });
  const rows = scopedTasks(req);
  const headers = ['task_number', 'title', 'task_type', 'priority', 'status', 'result', 'region', 'crew',
    'target_type', 'target_name', 'checklist_template', 'due_date', 'scheduled_start', 'actual_start',
    'actual_end', 'created_by', 'assigned_by', 'verified_by', 'progress_pct'];
  const personName = (id) => {
    const p = id ? get('person', id) : null;
    return p ? `${p.first_name} ${p.last_name}`.trim() : '';
  };
  const lines = rows.map((t) => {
    const target = taskTarget(t);
    const progress = taskProgress(t.id);
    const crew = t.crew_id ? get('crew', t.crew_id) : null;
    const tpl = taskTemplateIds(t.id).map((tid) => get('checklist_template', tid)).filter(Boolean);
    const region = t.region_id ? get('region', t.region_id) : null;
    return [
      t.task_number, t.title, t.task_type, t.priority, t.status, t.result || '', region?.name || '',
      crew?.name || '', target.type, target.name, tpl.map((x) => x.name).join('; '), t.due_date || '', t.scheduled_start || '',
      t.actual_start || '', t.actual_end || '', personName(t.created_by), personName(t.assigned_by),
      personName(t.verified_by), progress.progress_pct,
    ].map(csvField).join(',');
  });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename=tasks_${stamp}.csv`);
  audit(req.user, 'EXPORT', 'task', null, { scope: 'tasks_export', count: rows.length });
  res.send('\uFEFF' + [headers.join(','), ...lines].join('\n'));
});

const BULK_ACTIONS = new Set(['priority', 'due_date', 'schedule_start', 'assign']);
const PRIORITIES = new Set(['CRITICAL', 'HIGH', 'MEDIUM', 'LOW']);

router.post('/tasks/bulk', (req, res) => {
  if (!can(req, 'task:bulk')) return res.status(403).json({ error: 'Forbidden: requires task:bulk' });
  const ids = Array.isArray(req.body.ids) ? req.body.ids.map(Number) : [];
  const { action, value } = req.body;
  if (!ids.length || !BULK_ACTIONS.has(action)) {
    return res.status(400).json({ error: 'ids[] and action (priority|due_date|schedule_start|assign) are required' });
  }
  if (action === 'priority' && !PRIORITIES.has(value)) {
    return res.status(400).json({ error: 'priority must be CRITICAL|HIGH|MEDIUM|LOW' });
  }
  if ((action === 'due_date' || action === 'schedule_start') && (typeof value !== 'string' || Number.isNaN(Date.parse(value)))) {
    return res.status(400).json({ error: `${action} must be an ISO datetime string` });
  }
  if (action === 'assign' && !get('crew', Number(value))) {
    return res.status(400).json({ error: 'assign value must be an existing crew id' });
  }
  for (const id of ids) {
    if (!get('task', id)) return res.status(404).json({ error: `Task ${id} not found` });
    if (!taskVisible(req.user, get('task', id))) {
      return res.status(403).json({ error: `Task ${id} is outside your scope` });
    }
    if (action === 'assign' && !canAssignCrew(req.user, Number(value))) {
      return res.status(403).json({ error: `Crew ${value} is outside your authority` });
    }
  }
  const patch = {};
  if (action === 'priority') patch.priority = value;
  if (action === 'due_date') patch.due_date = value;
  if (action === 'schedule_start') patch.schedule_start = value;
  if (action === 'assign') { patch.crew_id = Number(value); patch.assigned_by = req.user.person_id || null; }
  withTx(() => {
    for (const id of ids) {
      updateRow('task', id, { ...patch, updated_at: new Date().toISOString() }, [], 'revision');
    }
  });
  audit(req.user, 'BULK', 'task', null, { action, value, count: ids.length });
  const advisories = action === 'assign'
    ? ids.map((id) => ({ task_id: id, dispatch: taskDispatchAdvisory(get('task', id), Number(value)) })).filter((x) => x.dispatch)
    : [];
  if (action === 'assign') {
    for (const id of ids) {
      try { sendAssignmentInstruction(req, get('task', id), Number(value)); } catch (e) { console.error('assignment instruction mail failed', e); }
    }
  }
  res.json({ updated: ids.length, ids, advisories });
});

function isoWeekStart(d) {
  const x = new Date(d);
  const day = (x.getUTCDay() + 6) % 7;
  x.setUTCDate(x.getUTCDate() - day);
  x.setUTCHours(0, 0, 0, 0);
  return x.toISOString();
}

router.get('/tasks/kpi', (req, res) => {
  if (!can(req, 'task:read')) return res.status(403).json({ error: 'Forbidden: requires task:read' });
  const rows = scopedTasks(req);
  const now = new Date().toISOString();
  const weekStart = isoWeekStart(new Date());
  const completed = rows.filter((t) => t.status === 'COMPLETED');
  const overdue = rows.filter((t) => OPEN.includes(t.status) && t.due_date < now);
  const withCycle = completed.filter((t) => t.actual_end && t.scheduled_start);
  const avgCycle = withCycle.length
    ? Math.round((withCycle.reduce((s, t) => s + (new Date(t.actual_end) - new Date(t.scheduled_start)), 0) / withCycle.length) / 3600000)
    : null;
  const byStatus = {};
  const byType = {};
  for (const t of rows) {
    byStatus[t.status] = (byStatus[t.status] || 0) + 1;
    byType[t.task_type] = (byType[t.task_type] || 0) + 1;
  }
  res.json({
    total: rows.length,
    open: rows.filter((t) => OPEN.includes(t.status)).length,
    completed: completed.length,
    overdue: overdue.length,
    critical_overdue: overdue.filter((t) => t.priority === 'CRITICAL').length,
    completion_rate: rows.length ? Math.round((completed.length / rows.length) * 100) : 0,
    avg_cycle_hours: avgCycle,
    completed_this_week: completed.filter((t) => t.actual_end && t.actual_end >= weekStart).length,
    by_status: byStatus,
    by_type: byType,
  });
});

router.get('/tasks/:id', (req, res) => {
  const t = taskDetail(get('task', Number(req.params.id)));
  if (!t) return res.status(404).json({ error: 'Task not found' });
  if (!taskVisible(req.user, t)) return res.status(404).json({ error: 'Task not found' });
  t.executions = executionsForTask(t);
  t.gps_validations = db.prepare('SELECT * FROM gps_validation WHERE linked_task_id = ? ORDER BY validated_at DESC LIMIT 20').all(t.id);
  t.findings = db.prepare(
    `SELECT tf.id, tf.task_id, tf.execution_id, tf.crew_id, tf.created_by, tf.title, tf.detail,
            tf.severity, tf.lat, tf.lng, tf.captured_at, tf.revision,
            tf.asset_id, tf.tower_id, tf.equipment_name, tf.checklist_item_id,
            p.first_name || ' ' || p.last_name AS created_by_name,
            a.name AS asset_name, tw.tower_id AS tower_code, ci.instruction AS checklist_item_instruction
     FROM task_finding tf
     LEFT JOIN person p ON p.id = tf.created_by
     LEFT JOIN asset a ON a.id = tf.asset_id
     LEFT JOIN tower tw ON tw.id = tf.tower_id
     LEFT JOIN checklist_item ci ON ci.id = tf.checklist_item_id
     WHERE tf.task_id = ? ORDER BY tf.captured_at DESC`
  ).all(t.id);
  t.work_items = listWorkItems(t.id);
  t.attachments = listForTask(t.id);
  t.assigned_by_name = personLabel(t.assigned_by);
  t.verified_by_name = personLabel(t.verified_by);
  t.created_by_name = personLabel(t.created_by);
  t.cancelled_by_name = personLabel(t.cancelled_by);
  t.readiness = taskReadiness(t);
  t.target = resolveTarget({ task: t });
  const fu = taskFollowUpView(t);
  t.follow_ups = fu.followUps;
  t.recommended_follow_ups = fu.recommended;
  res.json(t);
});

// Read-only readiness audit for a task: the checklist's team/skill/cert
// requirements, the resolved crew's coverage, and the advisory equipment list.
// Decision support only; it never blocks and requires no extra permission
// beyond being able to see the task.
router.get('/tasks/:id/readiness', (req, res) => {
  const t = get('task', Number(req.params.id));
  if (!t) return res.status(404).json({ error: 'Task not found' });
  if (!taskVisible(req.user, t)) return res.status(404).json({ error: 'Task not found' });
  res.json(taskReadiness(t));
});

router.put('/tasks/:id/equipment-checks', (req, res) => {
  const id = Number(req.params.id);
  const t = get('task', id);
  if (!t) return res.status(404).json({ error: 'Task not found' });
  if (!taskVisible(req.user, t)) return res.status(404).json({ error: 'Task not found' });
  if (!can(req, 'task:assign') && !can(req, 'task:manage')) {
    return res.status(403).json({ error: 'Forbidden: requires task:assign or task:manage' });
  }
  if (!['DRAFT', 'SCHEDULED', 'ASSIGNED'].includes(t.status)) {
    return res.status(409).json({ error: 'Equipment availability must be checked before work starts' });
  }
  const checks = req.body && req.body.checks;
  if (!Array.isArray(checks)) return res.status(400).json({ error: 'checks must be an array' });
  const required = new Set((taskRequirements(t) || {}).equipment || []);
  const seen = new Set();
  for (const check of checks) {
    const name = String(check && check.equipment || '').trim();
    if (!name || !required.has(name) || seen.has(name) || typeof check.available !== 'boolean') {
      return res.status(400).json({ error: 'Each check must name a unique recommended item and set available to true or false' });
    }
    seen.add(name);
  }

  const now = new Date().toISOString();
  withTx(() => {
    db.prepare('DELETE FROM task_equipment_check WHERE task_id = ?').run(id);
    const insert = db.prepare(
      'INSERT INTO task_equipment_check (task_id, equipment_name, is_available, checked_by, checked_at) VALUES (?, ?, ?, ?, ?)'
    );
    for (const check of checks) {
      insert.run(id, String(check.equipment).trim(), check.available ? 1 : 0, req.user.person_id || null, now);
    }
  });
  audit(req.user, 'UPDATE', 'task_equipment_check', id, { checks, checked_at: now });
  res.json(taskReadiness(t));
});

// Semi-automatic crew assignment: rank the crews the user may actually assign
// against the task's checklist requirements, best first. This is the same
// scoring the dispatch advisory uses (certifications, current load, skill
// coverage) but over every authorized crew instead of only the implied one, so
// a dispatcher can pick a substitute with eyes open. Decision support: it never
// assigns anything on its own.
router.get('/tasks/:id/assign-options', (req, res) => {
  if (!can(req, 'task:assign')) return res.status(403).json({ error: 'Forbidden: requires task:assign' });
  const t = get('task', Number(req.params.id));
  if (!t) return res.status(404).json({ error: 'Task not found' });
  if (!taskVisible(req.user, t)) return res.status(404).json({ error: 'Task not found' });

  const reqs = taskRequirements(t);
  const allowed = authorizedCrewIds(req.user);
  const defaultCrewId = resolveTaskCrewId(t);
  const defaultVia = defaultCrewId ? taskCrewSource(t, defaultCrewId) : null;
  const legacyCerts = t.task_type === 'PREVENTIVE' ? ['SF6_HANDLING'] : t.task_type === 'INSPECTION' ? [] : ['LIVE_LINE'];
  const neededCerts = reqs ? reqs.required_certs : legacyCerts;

  const candidates = list('crew')
    .filter((c) => allowed.has(c.id))
    .map((c) => {
      const detail = readyCrew(c.id);
      const fit = scoreCrewFit(detail, reqs, neededCerts);
      return {
        id: c.id,
        crew_code: c.crew_code,
        name: c.name,
        crew_type: c.crew_type,
        region_id: c.region_id,
        member_count: detail.member_count,
        open_task_count: detail.open_task_count,
        status: detail.status,
        selectable: detail.selectable,
        busy: detail.status === 'ON_TASK',
        eligible: fit.eligible,
        score: fit.score,
        is_default: defaultCrewId === c.id,
        resolved_via: defaultCrewId === c.id ? defaultVia : null,
        missing_skills: fit.evaluation ? fit.evaluation.missing_skills : [],
        unmapped_skills: fit.evaluation ? fit.evaluation.unmapped_skills : [],
        missing_certs: fit.evaluation ? fit.evaluation.missing_certs : fit.missing,
        certs_to_obtain: fit.evaluation ? fit.evaluation.certs_to_obtain : [],
        team_shortfall: fit.evaluation ? fit.evaluation.team_shortfall : 0,
        equipment_to_secure: fit.evaluation ? fit.evaluation.equipment_to_secure : [],
        warnings: fit.evaluation ? fit.evaluation.warnings : [],
      };
    })
    .sort((a, b) => (Number(b.eligible) - Number(a.eligible)) || (b.score - a.score));

  res.json({
    task_id: t.id,
    task_number: t.task_number,
    status: t.status,
    current_crew_id: t.crew_id || null,
    default_crew_id: defaultCrewId || null,
    default_via: defaultVia,
    checklist: reqs ? { id: reqs.template_id, code: reqs.template_code, name: reqs.template_name } : null,
    requirements: reqs ? {
      team: reqs.team,
      min_team_size: reqs.min_team_size,
      skills: reqs.skills.map((s) => s.label),
      required_certs: reqs.required_certs,
      recommended_certs: reqs.recommended_certs,
      cert_requirements: reqs.cert_requirements,
      equipment_to_secure: reqs.equipment,
    } : null,
    candidates,
    suggested_crew_id: (candidates.find((c) => c.is_default && c.selectable) || candidates.find((c) => c.eligible && c.selectable) || candidates.find((c) => c.selectable) || {}).id || null,
  });
});

router.post('/tasks', (req, res) => {
  if (!can(req, 'task:create')) return res.status(403).json({ error: 'Forbidden: requires task:create' });
  const fields = pickTaskFields(req.body);
  if (!isGlobal(req.user)) fields.region_id = req.user.region_id;
  if (fields.crew_id !== undefined && fields.crew_id !== null && !canAssignCrew(req.user, fields.crew_id)) {
    return res.status(403).json({ error: 'Forbidden: crew is outside your authority' });
  }
  if (fields.priority !== undefined && !PRIORITIES.has(fields.priority)) {
    return res.status(400).json({ error: 'priority must be CRITICAL|HIGH|MEDIUM|LOW' });
  }
  if (!validateTargets(req, res, fields)) return;
  try {
    const now = new Date().toISOString();
    const n = maxTaskSeq() + 1;
    const body = {
      task_number: formatTaskNumber(n),
      ...fields,
      status: fields.task_type === 'EMERGENCY' ? 'ASSIGNED' : 'DRAFT',
      created_by: req.user.person_id || null,
      created_at: now,
      updated_at: now,
      revision: 1,
    };
    const id = insertRow('task', body);
    if (req.body.checklist_template_ids !== undefined || req.body.checklist_template_id !== undefined) {
      setTaskTemplates(id, requestedTemplateIds(fields) || []);
    }
    audit(req.user, 'CREATE', 'task', id, fields);
    const created = taskDetail(get('task', id));
    const advisory = taskDispatchAdvisory(created, created.crew_id);
    if (advisory) created.dispatch = advisory;
    res.status(201).json(created);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

router.put('/tasks/:id', (req, res) => {
  const t = get('task', Number(req.params.id));
  if (!t) return res.status(404).json({ error: 'Task not found' });
  if (!taskVisible(req.user, t)) return res.status(404).json({ error: 'Task not found' });
  if (!can(req, 'task:manage')) return res.status(403).json({ error: 'Forbidden: requires task:manage' });
  const fields = pickTaskFields(req.body);
  if (!isGlobal(req.user)) fields.region_id = req.user.region_id;
  if (fields.priority !== undefined && !PRIORITIES.has(fields.priority)) {
    return res.status(400).json({ error: 'priority must be CRITICAL|HIGH|MEDIUM|LOW' });
  }
  if (fields.crew_id !== undefined && fields.crew_id !== null) {
    const crew = get('crew', Number(fields.crew_id));
    if (!crew) return res.status(400).json({ error: 'Crew not found' });
    if (!canAssignCrew(req.user, crew.id)) {
      return res.status(403).json({ error: 'Forbidden: crew is outside your authority' });
    }
  }
  if (!validateTargets(req, res, { ...t, ...fields })) return;
  updateRow('task', Number(req.params.id), { ...fields, updated_at: new Date().toISOString() }, [], 'revision');
  // updateRow drops null values, but clearing a reference is a meaningful edit
  // (detach a crew or a checklist template from a task). Apply those explicitly.
  const handledTemplates = fields.checklist_template_ids !== undefined || fields.checklist_template_id !== undefined;
  const clears = ['crew_id'].filter((k) => fields[k] === null);
  if (!handledTemplates && fields.checklist_template_id === null) clears.push('checklist_template_id');
  if (clears.length) {
    db.prepare(`UPDATE task SET ${clears.map((k) => `${k} = NULL`).join(', ')} WHERE id = ?`).run(Number(req.params.id));
  }
  // The join table is authoritative for which templates govern the task; sync it
  // (and the legacy primary column) whenever the caller touched the selection.
  if (handledTemplates) {
    try {
      setTaskTemplates(Number(req.params.id), requestedTemplateIds(fields) || []);
    } catch (e) {
      return res.status(400).json({ error: e.message });
    }
  }
  audit(req.user, 'UPDATE', 'task', Number(req.params.id), fields);
  res.json(taskDetail(get('task', Number(req.params.id))));
});

function validateTargets(req, res, t = req.body) {
  const regionId = Number(t.region_id);
  if (t.substation_id) {
    const s = get('substation', Number(t.substation_id));
    if (!s) { res.status(400).json({ error: 'Substation not found' }); return false; }
    if (s.region_id !== regionId) { res.status(400).json({ error: 'Substation does not belong to the task region' }); return false; }
  }
  if (t.line_id) {
    const l = get('transmission_line', Number(t.line_id));
    if (!l) { res.status(400).json({ error: 'Line not found' }); return false; }
    if (l.region_id !== regionId) { res.status(400).json({ error: 'Line does not belong to the task region' }); return false; }
  }
  if (t.tower_id) {
    const tw = get('tower', Number(t.tower_id));
    if (!tw) { res.status(400).json({ error: 'Tower not found' }); return false; }
    const l = get('transmission_line', tw.line_id);
    if (!l || l.region_id !== regionId) { res.status(400).json({ error: 'Tower does not belong to the task region' }); return false; }
    if (t.line_id && Number(t.line_id) !== tw.line_id) { res.status(400).json({ error: 'Tower does not belong to the selected line' }); return false; }
  }
  if (t.asset_id) {
    const a = get('asset', Number(t.asset_id));
    if (!a) { res.status(400).json({ error: 'Asset not found' }); return false; }
    if (t.substation_id && a.substation_id !== Number(t.substation_id)) { res.status(400).json({ error: 'Asset does not belong to the selected substation' }); return false; }
    if (Number.isFinite(regionId)) {
      const aRegion = assetRegion(a);
      if (aRegion != null && aRegion !== regionId) { res.status(400).json({ error: 'Asset does not belong to the task region' }); return false; }
    }
  }
  return true;
}

// Resolve the region an asset belongs to via its place (substation, line or
// tower->line), so scoped tasks cannot reference an out-of-region asset.
function assetRegion(a) {
  if (a.substation_id) {
    const s = get('substation', a.substation_id);
    return s ? s.region_id : null;
  }
  if (a.line_id) {
    const l = get('transmission_line', a.line_id);
    return l ? l.region_id : null;
  }
  if (a.tower_id) {
    const tw = get('tower', a.tower_id);
    const l = tw ? get('transmission_line', tw.line_id) : null;
    return l ? l.region_id : null;
  }
  return null;
}

// A task governed by a checklist template may only move to verification once a
// submitted execution has every required item graded. Returns a reason string
// when the checklist is not finished, or null when the transition is allowed.
function checklistCompletionBlocker(t) {
  const ids = taskTemplateIds(t.id);
  if (!ids.length) return null;
  const missing = [];
  for (const tid of ids) {
    const exec = db.prepare(
      "SELECT result FROM checklist_execution WHERE task_id = ? AND template_id = ? AND submitted_at IS NOT NULL ORDER BY id DESC LIMIT 1"
    ).get(t.id, tid);
    if (!exec) { missing.push({ tid, reason: 'no checklist execution has been submitted' }); continue; }
    if (!exec.result || exec.result === 'INCOMPLETE') missing.push({ tid, reason: 'required checklist items are still unanswered' });
  }
  if (!missing.length) return null;
  return missing.map((m) => {
    const tpl = get('checklist_template', m.tid);
    return `${tpl ? tpl.name : `template #${m.tid}`}: ${m.reason}`;
  }).join('; ');
}

// ---------------- State machine ----------------
const TRANSITIONS = {
  schedule: { from: ['DRAFT'], to: 'SCHEDULED' },
  assign: { from: ['SCHEDULED', 'DRAFT'], to: 'ASSIGNED' },
  start: { from: ['ASSIGNED'], to: 'IN_PROGRESS', needsCrew: true },
  hold: { from: ['IN_PROGRESS'], to: 'ON_HOLD' },
  resume: { from: ['ON_HOLD'], to: 'IN_PROGRESS' },
  submit: { from: ['IN_PROGRESS'], to: 'PENDING_VERIFICATION' },
  reopen: { from: ['PENDING_VERIFICATION'], to: 'IN_PROGRESS' },
  cancel: { from: OPEN, to: 'CANCELLED' },
  // Retrieval restores a cancelled task to the status it held before
  // cancellation. ADMIN-only: cleared later in this handler.
  retrieve: { from: ['CANCELLED'], to: null },
  verify: { from: ['PENDING_VERIFICATION'], to: 'COMPLETED' },
};

const ACTION_PERM = {
  schedule: 'task:assign',
  assign: 'task:assign',
  cancel: 'task:manage',
  retrieve: 'task:manage',
  verify: 'task:verify',
};

// Field run-control transitions (start/hold/resume/submit) are driven by the
// crew lead (task:lead / task:start); supervisors & management can force them
// via task:manage. CREW_MEMBER has neither and cannot drive the workflow.
const CREW_CONTROL = new Set(['start', 'hold', 'resume', 'submit', 'reopen']);

function canControlWorkflow(req, action) {
  if (can(req, 'task:manage')) return true;
  if (action === 'start' && can(req, 'task:start')) return true;
  if (can(req, 'task:lead')) return true;
  if (action === 'reopen' && can(req, 'task:verify')) return true;
  return false;
}

router.post('/tasks/:id/state', (req, res) => {
  const id = Number(req.params.id);
  const t = get('task', id);
  if (!t) return res.status(404).json({ error: 'Task not found' });
  if (!taskVisible(req.user, t)) return res.status(404).json({ error: 'Task not found' });
  const action = req.body.action;
  const tr = TRANSITIONS[action];
  if (!tr) return res.status(400).json({ error: `Unknown action: ${action}` });
  const allowed = CREW_CONTROL.has(action)
    ? canControlWorkflow(req, action)
    : action === 'schedule'
      ? (can(req, 'task:assign') || can(req, 'task:manage'))
      : action === 'retrieve'
        ? req.user.role === 'ADMIN'
        : can(req, ACTION_PERM[action] || 'task:manage');
  if (!allowed) {
    const required = CREW_CONTROL.has(action)
      ? 'task:lead/task:start (crew lead) or task:manage'
      : action === 'schedule'
        ? 'task:assign or task:manage'
        : action === 'retrieve'
          ? 'ADMIN'
          : ACTION_PERM[action] || 'task:manage';
    return res.status(403).json({ error: `Forbidden: requires ${required}` });
  }
  // Crew users (lead & member) may only act on tasks assigned to their own crew.
  if (isCrewUser(req.user) && !isOnCrew(req.user, t.crew_id)) {
    return res.status(403).json({ error: 'Forbidden: not your assigned task' });
  }
  // An EMERGENCY task is born ASSIGNED (see POST /tasks) but may have no crew
  // yet, so `assign` must still be able to attach one. A task that already has a
  // crew is left alone here; changing its crew before work starts is done via
  // PUT /tasks/:id (task:manage).
  const assignable = action === 'assign' && t.status === 'ASSIGNED' && !t.crew_id;
  if (!tr.from.includes(t.status) && !assignable) return res.status(409).json({ error: `Cannot ${action} from status ${t.status}` });
  if (tr.needsCrew && !t.crew_id) return res.status(409).json({ error: 'Task requires an assigned crew first' });

  // Cancelling is a deliberate, recorded act: the caller must supply a comment
  // explaining why, which is kept on the task for the retrieved/closed record.
  const cancelReason = action === 'cancel' ? String(req.body.reason || req.body.comment || '').trim() : '';
  if (action === 'cancel' && !cancelReason) {
    return res.status(400).json({ error: 'A cancellation comment is required' });
  }

  // A task with a checklist template cannot be submitted for verification or
  // completed until the checklist run is finished (every required item graded).
  // This applies to supervisors/managers forcing the transition too.
  if (action === 'submit' || action === 'verify') {
    const blocker = checklistCompletionBlocker(t);
    if (blocker) {
      return res.status(409).json({
        error: `Checklist incomplete: ${blocker}. Finish and submit the checklist before ${action === 'verify' ? 'completing' : 'submitting'} the task.`,
      });
    }
  }

  // GPS enforcement at verification: when the checklist template requires GPS
  // confirmation, a device-vs-finishing-place validation must exist on record
  // before the task can be completed. An out-of-range (FAIL) reading is never
  // silently dropped — it is kept on record and the verifier reviews the
  // captured coordinates and decides the outcome.
  if (action === 'verify') {
    const gpsRequired = taskTemplateIds(t.id)
      .map((tid) => get('checklist_template', tid))
      .some((tpl) => tpl && tpl.requires_gps_confirmation);
    if (gpsRequired) {
      const any = db.prepare(
        "SELECT COUNT(*) c FROM gps_validation WHERE linked_task_id = ?"
      ).get(id).c;
      if (any === 0) {
        return res.status(409).json({
          error: 'GPS confirmation required: no device-vs-finishing-place GPS validation recorded for this task. Capture GPS via the checklist before verifying.',
        });
      }
    }
  }

  // Segregation of duties: whoever performed any submitted checklist run on this
  // task cannot also verify/complete it.
  if (action === 'verify') {
    const mine = db.prepare(
      "SELECT COUNT(*) c FROM checklist_execution WHERE task_id = ? AND submitted_at IS NOT NULL AND executed_by = ?"
    ).get(id, req.user.person_id || null).c;
    if (mine > 0) {
      return res.status(409).json({
        error: 'Segregation of duties: the verifier cannot be the person who executed the checklist',
      });
    }
  }

  // Validate referenced entities before mutating so a bad reference cannot
  // corrupt the task row (or abort the whole transaction on an FK constraint).
  if (action === 'assign' && req.body.crew_id) {
    const crew = get('crew', Number(req.body.crew_id));
    if (!crew) return res.status(400).json({ error: 'Crew not found' });
    if (!canAssignCrew(req.user, crew.id)) {
      return res.status(403).json({ error: 'Forbidden: crew is outside your authority' });
    }
  }
  if (action === 'verify' && req.body.result !== undefined) {
    const allowed = ['PASS', 'FAIL', 'PARTIAL', 'DEFERRED'];
    if (!allowed.includes(req.body.result)) {
      return res.status(400).json({ error: `Invalid result; expected one of ${allowed.join(', ')}` });
    }
  }

  const now = new Date().toISOString();
  // Retrieval restores the status the task held before it was cancelled. Rows
  // cancelled before this was tracked fall back to a safe planning status.
  const priorStatus = OPEN.includes(t.status_before_cancel) ? t.status_before_cancel : (t.crew_id ? 'ASSIGNED' : 'DRAFT');
  // A task that already carries a crew is assigned work, so "scheduling" it
  // must land on ASSIGNED rather than the impossible SCHEDULED-with-crew state
  // that no role's task list would show.
  const toStatus = action === 'retrieve' ? priorStatus : action === 'schedule' && t.crew_id ? 'ASSIGNED' : tr.to;
  const patch = { status: toStatus, updated_at: now, revision: 1 };
  if (action === 'schedule') {
    patch.scheduled_start = t.scheduled_start || req.body.scheduled_start || now;
    if (t.crew_id && !t.assigned_by) patch.assigned_by = req.user.person_id || null;
  }
  if (action === 'assign') { patch.crew_id = req.body.crew_id || t.crew_id; patch.assigned_by = req.user.person_id || null; }
  if (action === 'start') { patch.actual_start = now; }
  if (action === 'verify') {
    patch.actual_end = now;
    patch.result = req.body.result || t.result || 'PASS';
    patch.completion_summary = req.body.completion_summary || t.completion_summary;
    patch.verified_by = req.body.verified_by || req.user.person_id || t.verified_by;
  }
  // Optional spend recorded against the maintenance event raised on completion.
  let completionCost = null;
  if (action === 'verify') {
    const c = req.body.cost;
    if (c !== undefined && c !== null && c !== '') {
      const n = Number(c);
      if (Number.isFinite(n) && n >= 0) completionCost = n;
    }
  }
  if (action === 'cancel') {
    patch.completion_summary = cancelReason;
    patch.cancel_reason = cancelReason;
    patch.cancelled_by = req.user.person_id || null;
    patch.cancelled_at = now;
    patch.status_before_cancel = t.status;
  }
  const updatedTask = withTx(() => {
    db.prepare(
      `UPDATE task SET status = ?, updated_at = ?, scheduled_start = COALESCE(?, scheduled_start), crew_id = COALESCE(?, crew_id),
       assigned_by = COALESCE(?, assigned_by), actual_start = COALESCE(?, actual_start), actual_end = COALESCE(?, actual_end),
       result = COALESCE(?, result), completion_summary = COALESCE(?, completion_summary), verified_by = COALESCE(?, verified_by),
       cancel_reason = CASE WHEN ? = 'cancel' THEN ? ELSE cancel_reason END,
       cancelled_by = CASE WHEN ? = 'cancel' THEN ? ELSE cancelled_by END,
       cancelled_at = CASE WHEN ? = 'cancel' THEN ? ELSE cancelled_at END,
       status_before_cancel = CASE WHEN ? = 'cancel' THEN ? ELSE status_before_cancel END,
       revision = revision + 1 WHERE id = ?`
    ).run(toStatus, now, patch.scheduled_start ?? null, patch.crew_id ?? null, patch.assigned_by ?? null, patch.actual_start ?? null, patch.actual_end ?? null, patch.result ?? null, patch.completion_summary ?? null, patch.verified_by ?? null,
      action, patch.cancel_reason ?? null, action, patch.cancelled_by ?? null, action, patch.cancelled_at ?? null, action, patch.status_before_cancel ?? null, id);
    if (action === 'retrieve') db.prepare('UPDATE task SET completion_summary = NULL WHERE id = ?').run(id);
    if (action === 'verify') applyCompletionSideEffects(req, get('task', id), completionCost);
    return get('task', id);
  });
  const auditDetail = { from: t.status, to: toStatus };
  if (action === 'cancel') auditDetail.reason = cancelReason;
  if (action === 'retrieve') auditDetail.restored_from = t.status_before_cancel || null;
  audit(req.user, action.toUpperCase(), 'task', id, auditDetail);
  if (updatedTask.crew_id) {
    try { syncCrewStatus(updatedTask.crew_id); } catch (e) { console.error('crew status sync failed', e); }
  }
  const payload = taskDetail(updatedTask);
  if (action === 'assign') {
    const advisory = taskDispatchAdvisory(payload, payload.crew_id);
    if (advisory) payload.dispatch = advisory;
    try { sendAssignmentInstruction(req, updatedTask, updatedTask.crew_id); } catch (e) { console.error('assignment instruction mail failed', e); }
  }
  res.json(payload);
});

// On completion, file the execution report into the mailbox of the crew's
// immediate line manager (crew lead -> region manager -> org-unit manager), so
// the person accountable for the work is notified without a manual send.
function sendExecutionReport(req, t) {
  const bossId = immediateBossForTask(t);
  if (!bossId || bossId === req.user.person_id) return null;
  if (!primaryUserForPerson(bossId)) return null;
  const actorPerson = req.user.person_id ? get('person', req.user.person_id) : null;
  const actor = actorPerson ? ([actorPerson.first_name, actorPerson.last_name].filter(Boolean).join(' ') || req.user.username) : req.user.username;
  const crew = t.crew_id ? get('crew', t.crew_id) : null;
  const findings = db.prepare('SELECT COUNT(*) c FROM task_finding WHERE task_id = ?').get(t.id).c;
  const body = [
    `Task ${t.task_number} — ${t.title}`,
    `Result: ${t.result || 'COMPLETED'}`,
    `Crew: ${crew ? crew.name : '—'}`,
    `Completed by: ${actor}`,
    t.completion_summary ? `Summary: ${t.completion_summary}` : null,
    findings ? `Findings raised: ${findings}` : null,
    `Open the task: /tasks/${t.id}`,
  ].filter(Boolean).join('\n');
  const executions = db.prepare('SELECT id FROM checklist_execution WHERE task_id = ? ORDER BY id').all(t.id);
  return sendMail({
    senderUserId: req.user.id,
    senderPersonId: req.user.person_id || null,
    recipientPersonId: bossId,
    subject: `Task ${t.task_number} completed`,
    body,
    category: 'EXECUTION',
    priority: ['HIGH', 'CRITICAL'].includes(t.priority) ? 'HIGH' : 'NORMAL',
    entityType: 'task',
    entityId: t.id,
    link: `/tasks/${t.id}`,
    attachments: executions.map((e) => ({
      kind: 'EXECUTION',
      entity_type: 'CHECKLIST_EXECUTION',
      entity_id: e.id,
      label: `Execution EX-${String(e.id).padStart(5, '0')}`,
      link: `/tasks/${t.id}`,
    })),
  });
}

function applyCompletionSideEffects(req, t, cost = null) {
  const now = new Date().toISOString();
  try { sendExecutionReport(req, t); } catch (e) { console.error('execution report mail failed', e); }
  if (t.asset_id) {
    updateRow('asset', t.asset_id, { last_maintenance_at: now });
    insertRow('asset_maintenance_event', {
      asset_id: t.asset_id,
      task_id: t.id,
      event_type: t.task_type,
      performed_at: now,
      crew_id: t.crew_id,
      work_summary: t.completion_summary || 'Completed via task ' + t.task_number,
      cost,
    });
  }
  if (t.schedule_id) {
    const s = get('maintenance_schedule', t.schedule_id);
    if (s && s.is_active === 1 && (!t.due_date || s.next_due_date <= t.due_date)) {
      const step = recurrence.advanceAfterGeneration(s);
      updateRow('maintenance_schedule', s.id, {
        last_generated_at: now,
        next_due_date: step.next_due_date,
        occurrences_generated: step.occurrences_generated,
        is_active: step.is_active,
        ...(step.frequency ? { frequency: step.frequency, frequency_config: step.frequency_config } : {}),
      });
    }
  }
  // Never let a follow-up task spawn another follow-up: that produces an
  // unbounded auto-generation chain (TK-…87 -> 88 -> 89 -> …). Only the
  // original task escalates automatically.
  if (isFollowUpTask(t)) return;
  // Result-based follow-up: a FAIL (or critical finding / critical-step / GPS
  // failure) automatically raises an EMERGENCY corrective task on the same target.
  const created = applyAutoFollowUps(req, t);
  if (created.length) {
    console.log(`[follow-up] auto-created EMERGENCY task(s) ${created.join(', ')} for completed task ${t.task_number} (${t.result || 'FAIL'})`);
  }
}

// A task is a follow-up if it was auto-generated (source AUTO) or is linked as
// the child of another task. These are terminal: they must not auto-generate
// more follow-ups.
function isFollowUpTask(t) {
  if (!t) return false;
  if (t.source === 'AUTO') return true;
  return db.prepare("SELECT COUNT(*) c FROM task_link WHERE task_id = ? AND link_type = 'FOLLOW_UP'").get(t.id).c > 0;
}

// ---- Result-based follow-up work (EMERGENCY auto + corrective recommend) ----
const FOLLOW_TARGET_KEYS = ['substation_id', 'line_id', 'tower_id', 'asset_id'];
// Auto-raise a corrective task only when more than this share of checklist
// items failed; at or below it the follow-up is offered to the user to decide.
const FOLLOW_UP_FAILURE_THRESHOLD = 0.4;

function checklistFailureRatio(taskId) {
  const row = db.prepare(
    `SELECT COUNT(*) total,
            SUM(CASE WHEN i.result = 'FAIL' THEN 1 ELSE 0 END) failed
     FROM checklist_execution_item i
     JOIN checklist_execution e ON e.id = i.execution_id
     WHERE e.task_id = ?`
  ).get(taskId);
  const total = row.total || 0;
  return total > 0 ? (row.failed || 0) / total : 0;
}

function sameTarget(a, b) {
  return FOLLOW_TARGET_KEYS.every((k) => (a[k] ?? null) === (b[k] ?? null));
}

function openTaskLike(source, taskType) {
  return list('task').find(
    (o) => o.task_type === taskType && OPEN.includes(o.status) && o.id !== source.id && sameTarget(o, source)
  ) || null;
}

function followUpSignals(t) {
  const findings = db.prepare('SELECT severity, title, detail FROM task_finding WHERE task_id = ?').all(t.id);
  const execFail = db.prepare(
    `SELECT COUNT(*) c FROM checklist_execution_item i
     JOIN checklist_item ci ON ci.id = i.template_item_id
     JOIN checklist_execution e ON e.id = i.execution_id
     WHERE e.task_id = ? AND i.result = 'FAIL' AND ci.critical_step = 1`
  ).get(t.id).c;
  const gpsItemFail = db.prepare(
    `SELECT COUNT(*) c FROM checklist_execution_item i JOIN checklist_execution e ON e.id = i.execution_id
     WHERE e.task_id = ? AND i.result = 'FAIL' AND i.response_type = 'GPS_POINT'`
  ).get(t.id).c;
  const gpsFail = db.prepare("SELECT COUNT(*) c FROM gps_validation WHERE linked_task_id = ? AND result = 'FAIL'").get(t.id).c;
  const sev = findings.map((f) => f.severity);
  const checklistTotal = db.prepare(
    `SELECT COUNT(*) c FROM checklist_execution_item i
     JOIN checklist_execution e ON e.id = i.execution_id
     WHERE e.task_id = ?`
  ).get(t.id).c;
  return {
    result: t.result || null,
    status: t.status,
    critical: sev.filter((s) => s === 'CRITICAL').length,
    high: sev.filter((s) => s === 'HIGH').length,
    mediumLow: sev.filter((s) => s === 'MEDIUM' || s === 'LOW').length,
    execFail,
    gpsItemFail,
    gpsFail,
    checklistTotal,
    failureRatio: checklistFailureRatio(t.id),
  };
}

function followUpReason(s) {
  const r = [];
  if (s.failureRatio > 0 && s.checklistTotal > 0) {
    r.push(`${Math.round(s.failureRatio * 100)}% checklist failure (${Math.round(s.failureRatio * s.checklistTotal)}/${s.checklistTotal} items)`);
  }
  if (s.result === 'FAIL') r.push(`task result ${s.result}`);
  else if (s.result === 'PARTIAL' || s.result === 'DEFERRED') r.push(`task result ${s.result}`);
  if (s.critical) r.push(`${s.critical} CRITICAL finding(s)`);
  if (s.high) r.push(`${s.high} HIGH finding(s)`);
  if (s.mediumLow) r.push(`${s.mediumLow} low/medium finding(s)`);
  if (s.execFail) r.push(`${s.execFail} critical checklist step failure(s)`);
  if (s.gpsItemFail || s.gpsFail) r.push('GPS location mismatch (FAIL)');
  return r.join('; ');
}

function hasFollowUpSignal(s) {
  return s.failureRatio > 0 || s.result === 'FAIL' || s.result === 'PARTIAL' || s.result === 'DEFERRED' ||
    s.critical > 0 || s.high > 0 || s.mediumLow > 0 || s.execFail > 0 || s.gpsItemFail > 0 || s.gpsFail > 0;
}

// Only a checklist that failed above the threshold is auto-escalated;
// anything at or below it is surfaced for the user to decide.
function isEmergency(s) {
  return s.failureRatio > FOLLOW_UP_FAILURE_THRESHOLD;
}

function baseFollowUpTask(source) {
  return {
    substation_id: source.substation_id || null,
    line_id: source.line_id || null,
    tower_id: source.tower_id || null,
    asset_id: source.asset_id || null,
    region_id: source.region_id,
    crew_id: source.crew_id || null,
    source: 'AUTO',
  };
}

// Auto = EMERGENCY tasks raised automatically on verification.
// Recommend = CORRECTIVE/other tasks offered to a planner for one-click creation.
function buildFollowUpPlans(source) {
  const s = followUpSignals(source);
  const auto = [];
  const recommend = [];
  const reason = followUpReason(s);
  const carriedItems = deriveWorkItems(source);
  const sourceTemplateIds = taskTemplateIds(source.id);
  const sourceTemplates = sourceTemplateIds.map((tid) => get('checklist_template', tid)).filter(Boolean);
  const carry = {
    carry_count: carriedItems.length,
    carry_checklist_template_id: sourceTemplateIds[0] || null,
    carry_checklist_template_ids: sourceTemplateIds,
    carry_checklist_name: sourceTemplates.map((tpl) => tpl.name).join(', ') || null,
  };
  if (isEmergency(s)) {
    const due = new Date();
    due.setHours(due.getHours() + 48);
    auto.push({
      key: 'emergency',
      task_type: 'EMERGENCY',
      priority: 'HIGH',
      status: 'ASSIGNED',
      title: `EMERGENCY follow-up — ${source.task_number}`,
      description: `Automatic emergency corrective task raised from ${source.task_number} after ${s.result || 'completion'}${reason ? `: ${reason}.` : '.'} Inspect and remediate the affected asset immediately.`,
      reason: reason || 'Failed inspection result',
      due_date: due.toISOString(),
      ...carry,
    });
  } else if (hasFollowUpSignal(s)) {
    const due = new Date();
    due.setDate(due.getDate() + 7);
    recommend.push({
      key: 'corrective',
      task_type: 'CORRECTIVE',
      priority: 'MEDIUM',
      status: 'DRAFT',
      title: `Corrective follow-up — ${source.task_number}`,
      description: `Planned corrective task generated from ${source.task_number} (result ${s.result || 'PASS'})${reason ? `: ${reason}.` : '.'} Below the automatic emergency threshold — confirm to create.`,
      reason: reason || `result ${s.result || 'PASS'} below auto threshold`,
      due_date: due.toISOString(),
      ...carry,
    });
  }
  return { auto, recommend };
}

function createFollowUpTask(req, source, plan) {
  if (isFollowUpTask(source)) return null;
  if (openTaskLike(source, plan.task_type)) return null;
  const now = new Date().toISOString();
  // Which checklist templates the new task carries: an explicit override wins,
  // otherwise the source task's full selection is carried over.
  const templateIds = Array.isArray(plan.checklist_template_ids)
    ? plan.checklist_template_ids
    : plan.checklist_template_id !== undefined
      ? (plan.checklist_template_id ? [plan.checklist_template_id] : [])
      : taskTemplateIds(source.id);
  const templateId = templateIds[0] || null;
  const id = insertRow('task', {
    ...baseFollowUpTask(source),
    task_number: nextTaskNumber(),
    title: plan.title,
    description: plan.description || null,
    task_type: plan.task_type,
    priority: plan.priority,
    priority_reason: plan.reason || null,
    status: plan.status,
    due_date: plan.due_date || null,
    checklist_template_id: templateId,
    created_by: req.user.person_id || null,
    assigned_by: plan.status === 'ASSIGNED' ? req.user.person_id || null : null,
    created_at: now,
    updated_at: now,
    revision: 1,
  });
  setTaskTemplates(id, templateIds);
  const derived = deriveWorkItems(source);
  derived.forEach((item, idx) => {
    insertRow('task_work_item', {
      task_id: id,
      sequence: idx + 1,
      kind: item.kind,
      title: item.title,
      detail: item.detail || null,
      source_type: item.source_type || null,
      source_id: item.source_id ?? null,
      status: 'OPEN',
      created_at: now,
    });
  });
  db.prepare("INSERT INTO task_link (task_id, linked_task_id, link_type) VALUES (?, ?, 'FOLLOW_UP')").run(id, source.id);
  audit(req.user, 'CREATE', 'task', id, { follow_up: true, source_task: source.id, task_type: plan.task_type, reason: plan.reason || null, checklist_template_id: templateId, checklist_template_ids: templateIds, work_items: derived.length });
  return id;
}

function applyAutoFollowUps(req, source) {
  if (isFollowUpTask(source)) return [];
  const { auto } = buildFollowUpPlans(source);
  return auto.map((p) => createFollowUpTask(req, source, p)).filter(Boolean);
}

function taskFollowUpView(source) {
  if (!source || !['COMPLETED', 'FAILED'].includes(source.status)) {
    return { followUps: [], recommended: [] };
  }
  const children = db.prepare(
    `SELECT task.* FROM task JOIN task_link l ON l.task_id = task.id
     WHERE l.linked_task_id = ? AND l.link_type = 'FOLLOW_UP' ORDER BY task.id`
  ).all(source.id);
  const followUps = children.map((c) => ({ ...taskDetail(c), work_items: listWorkItems(c.id) }));
  // Follow-up tasks are terminal: never offer another follow-up from them.
  if (isFollowUpTask(source)) return { followUps, recommended: [] };
  const { auto, recommend } = buildFollowUpPlans(source);
  const recommended = [...auto, ...recommend].filter((p) => !openTaskLike(source, p.task_type));
  return { followUps, recommended };
}

// Materialise a specific recommended follow-up (used by the one-click create UI).
router.post('/tasks/:id/follow-ups', (req, res) => {
  const source = get('task', Number(req.params.id));
  if (!source) return res.status(404).json({ error: 'Task not found' });
  if (!taskVisible(req.user, source)) return res.status(404).json({ error: 'Task not found' });
  if (!can(req, 'task:create')) return res.status(403).json({ error: 'Forbidden: requires task:create' });
  if (isFollowUpTask(source)) return res.status(409).json({ error: 'A follow-up task cannot spawn another follow-up' });
  const { auto, recommend } = buildFollowUpPlans(source);
  const plans = [...auto, ...recommend];
  const plan = req.body.key ? plans.find((p) => p.key === req.body.key) : plans[0];
  if (!plan) return res.status(409).json({ error: 'No follow-up work is warranted from this task result' });
  // Which checklist(s) the follow-up carries. undefined = carry the source
  // task's whole selection; an explicit list (or a lone id) is validated here.
  let templateIdsChoice;
  const validateTemplate = (v) => {
    const requested = Number(v);
    const tpl = Number.isInteger(requested) ? get('checklist_template', requested) : null;
    if (!tpl || tpl.status !== 'ACTIVE') return null;
    return tpl.id;
  };
  if (req.body.checklist_template_ids !== undefined) {
    const raw = req.body.checklist_template_ids;
    const arr = Array.isArray(raw) ? raw : (raw === null || raw === '' ? [] : [raw]);
    const clean = [];
    for (const v of arr) {
      const tid = validateTemplate(v);
      if (!tid) return res.status(400).json({ error: 'checklist_template_ids must reference existing ACTIVE templates' });
      if (!clean.includes(tid)) clean.push(tid);
    }
    templateIdsChoice = clean;
  } else if (req.body.checklist_template_id !== undefined && req.body.checklist_template_id !== null && req.body.checklist_template_id !== '') {
    const tid = validateTemplate(req.body.checklist_template_id);
    if (!tid) return res.status(400).json({ error: 'checklist_template_id must reference an existing ACTIVE template' });
    templateIdsChoice = [tid];
  } else if (req.body.checklist_template_id === null) {
    templateIdsChoice = [];
  }
  let created;
  try {
    created = withTx(() => createFollowUpTask(req, source, { ...plan, checklist_template_ids: templateIdsChoice, status: req.body.status || plan.status }));
  } catch (e) {
    return res.status(400).json({ error: e.message });
  }
  if (!created) return res.status(409).json({ error: 'An open follow-up of this type already targets the same asset — nothing duplicated' });
  res.status(201).json(taskDetail(get('task', created)));
});

// ---------------- Checklist execution ----------------
function parseCriteria(v) {
  if (v === null || v === undefined || v === '') return null;
  try { return JSON.parse(v); } catch (_) { return v; }
}

router.get('/tasks/:id/checklist', (req, res) => {
  const t = get('task', Number(req.params.id));
  if (!t) return res.status(404).json({ error: 'Task not found' });
  if (!taskVisible(req.user, t)) return res.status(404).json({ error: 'Task not found' });
  if (!can(req, 'task:execute')) return res.status(403).json({ error: 'Forbidden: requires task:execute' });
  const ids = taskTemplateIds(t.id);
  if (!ids.length) return res.status(400).json({ error: 'Task has no checklist template' });
  const itemQ = db.prepare('SELECT * FROM checklist_item WHERE template_id = ? ORDER BY sequence');
  // The signed-in person's saved drafts, so a partially-filled run resumes where
  // it was left off. Drafts are keyed per person so two crew members do not
  // overwrite each other's captures.
  const draftByTemplate = new Map();
  if (req.user.person_id) {
    for (const d of db.prepare(
      'SELECT * FROM checklist_draft WHERE task_id = ? AND executed_by = ?'
    ).all(t.id, req.user.person_id)) {
      draftByTemplate.set(d.template_id, parseRow(d, ['items_json']));
    }
  }
  const templates = ids.map((tid) => {
    const tpl = get('checklist_template', tid);
    if (!tpl) return null;
    const items = itemQ.all(tpl.id).map((it) => ({ ...it, pass_criteria: parseCriteria(it.pass_criteria) }));
    const last = db.prepare(
      "SELECT * FROM checklist_execution WHERE task_id = ? AND template_id = ? AND submitted_at IS NOT NULL ORDER BY id DESC LIMIT 1"
    ).get(t.id, tpl.id) || null;
    const draft = draftByTemplate.get(tpl.id) || null;
    return {
      ...tpl,
      items,
      last_execution: last,
      draft: draft ? { id: draft.id, notes: draft.notes, updated_at: draft.updated_at, items: draft.items_json || [] } : null,
    };
  }).filter(Boolean);
  // `template` stays the primary template for callers written against the
  // single-template shape; `templates` carries every governed template.
  res.json({ task: t, template: templates[0] || null, templates });
});

// Save a partially-filled checklist run without submitting it. The capture is
// held in checklist_draft (never as a real execution) so it cannot advance the
// task, count as work, or create GPS validations; submitting the run discards
// the draft. Keyed per task+template+person so a crew member can resume later.
router.post('/tasks/:id/checklist/draft', (req, res) => {
  const t = get('task', Number(req.params.id));
  if (!t) return res.status(404).json({ error: 'Task not found' });
  if (!taskVisible(req.user, t)) return res.status(404).json({ error: 'Task not found' });
  if (!can(req, 'task:execute')) return res.status(403).json({ error: 'Forbidden: requires task:execute' });
  if (isCrewUser(req.user) && !isOnCrew(req.user, t.crew_id)) {
    return res.status(403).json({ error: 'Forbidden: not your assigned task' });
  }
  const ids = taskTemplateIds(t.id);
  if (!ids.length) return res.status(400).json({ error: 'Task has no checklist template' });
  const requestedId = (req.body.template_id !== undefined && req.body.template_id !== null && req.body.template_id !== '')
    ? Number(req.body.template_id)
    : ids[0];
  if (!ids.includes(requestedId)) {
    return res.status(400).json({ error: 'template_id is not one of this task\'s checklist templates' });
  }
  const tpl = get('checklist_template', requestedId);
  if (!tpl) return res.status(400).json({ error: 'Checklist template not found' });
  const executedBy = req.user.person_id || null;
  if (!executedBy) return res.status(400).json({ error: 'A draft must be owned by an authenticated person' });

  const items = (Array.isArray(req.body.items) ? req.body.items : []).map((i) => ({
    template_item_id: i.template_item_id != null ? Number(i.template_item_id) : null,
    sequence: i.sequence != null ? Number(i.sequence) : null,
    response_value: i.response_value !== undefined ? i.response_value : null,
    comment: i.comment || null,
  }));
  const now = new Date().toISOString();
  const existing = db.prepare(
    'SELECT id FROM checklist_draft WHERE task_id = ? AND template_id = ? AND executed_by = ?'
  ).get(t.id, tpl.id, executedBy);
  withTx(() => {
    const fields = {
      notes: req.body.notes != null ? String(req.body.notes) : null,
      items_json: items,
      crew_id: req.body.crew_id || t.crew_id || null,
      updated_at: now,
    };
    if (existing) {
      updateRow('checklist_draft', existing.id, fields, ['items_json']);
    } else {
      insertRow('checklist_draft', { task_id: t.id, template_id: tpl.id, executed_by: executedBy, created_at: now, ...fields }, ['items_json']);
    }
  });
  const saved = parseRow(db.prepare(
    'SELECT * FROM checklist_draft WHERE task_id = ? AND template_id = ? AND executed_by = ?'
  ).get(t.id, tpl.id, executedBy), ['items_json']);
  audit(req.user, 'DRAFT', 'checklist_draft', saved.id, { task_id: t.id, template_id: tpl.id, count: items.length });
  res.json({ ...saved, items: saved.items_json || [] });
});

router.post('/tasks/:id/checklist', (req, res) => {
  const t = get('task', Number(req.params.id));
  if (!t) return res.status(404).json({ error: 'Task not found' });
  if (!taskVisible(req.user, t)) return res.status(404).json({ error: 'Task not found' });
  if (!can(req, 'task:execute')) return res.status(403).json({ error: 'Forbidden: requires task:execute' });
  if (isCrewUser(req.user) && !isOnCrew(req.user, t.crew_id)) {
    return res.status(403).json({ error: 'Forbidden: not your assigned task' });
  }
  const ids = taskTemplateIds(t.id);
  if (!ids.length) return res.status(400).json({ error: 'Task has no checklist template' });
  const requestedId = (req.body.template_id !== undefined && req.body.template_id !== null && req.body.template_id !== '')
    ? Number(req.body.template_id)
    : ids[0];
  if (!ids.includes(requestedId)) {
    return res.status(400).json({ error: 'template_id is not one of this task\'s checklist templates' });
  }
  const tpl = get('checklist_template', requestedId);
  if (!tpl) return res.status(400).json({ error: 'Checklist template not found' });
  const items = db.prepare('SELECT * FROM checklist_item WHERE template_id = ? ORDER BY sequence').all(tpl.id);
  const now = new Date().toISOString();

  const clientRef = req.body.client_ref ? String(req.body.client_ref) : null;
  if (clientRef) {
    const existing = byClientRef('checklist_execution', clientRef);
    if (existing) {
      return res.status(200).json({
        execution_id: existing.id,
        result: existing.result,
        advanced: false,
        templates_done: null,
        gps_validations_created: 0,
        execution: existing,
        already_submitted: true,
      });
    }
  }

  // Only a lead / supervisor can submit the run and move the task forward — a
  // crew-member capture (who may now start the task) saves the execution
  // readings/GPS/photos but leaves the task in progress for the lead to submit.
  const canSubmitRun = can(req, 'task:lead') || can(req, 'task:manage');

  let outcome;
  try {
    outcome = withTx(() => {
      // Submitting the run supersedes any saved draft for this task/template/person.
      db.prepare('DELETE FROM checklist_draft WHERE task_id = ? AND template_id = ? AND executed_by = ?')
        .run(t.id, tpl.id, req.user.person_id || null);
      const execId = insertRow('checklist_execution', {
        template_id: tpl.id,
        template_version: tpl.version,
        task_id: t.id,
        asset_id: t.asset_id,
        tower_id: t.tower_id,
        crew_id: req.body.crew_id || t.crew_id || null,
        started_at: now,
        submitted_at: now,
        // Who executed the run is derived from the authenticated user, never
        // trusted from the request body.
        executed_by: req.user.person_id || t.crew_id || null,
        notes: req.body.notes || null,
        // Finishing-place GPS (where the maintenance work was actually completed),
        // captured by the crew on submission and compared against the installed
        // device location — never silently dropped.
        gps_lat: req.body.finish_gps?.lat ?? null,
        gps_lng: req.body.finish_gps?.lng ?? null,
        gps_accuracy_m: req.body.finish_gps?.accuracy_m ?? null,
        client_ref: clientRef,
      });

      const submitted = (req.body.items || []).reduce((m, i) => { m[i.template_item_id || i.sequence] = i; return m; }, {});
      let hasFail = false;
      let hasCriticalFail = false;
      let hasRequiredMissing = false;
      let gpsCreated = 0;
      let gpsFailed = false;

      const itemResult = (item, responseValue) => {
        // An unanswered item is never graded PASS or FAIL — a required item is
        // left NOT_RUN so the run reports INCOMPLETE instead of looking finished.
        const answered = responseValue !== undefined && responseValue !== null && responseValue !== '';
        if (!answered) return item.required ? 'NOT_RUN' : 'NA';
        if (item.response_type === 'GPS_POINT') {
          if (!responseValue) return item.required ? 'NOT_RUN' : 'NA';
          let pos = responseValue;
          if (typeof responseValue === 'string') {
            try { pos = JSON.parse(responseValue); } catch (_) { return item.required ? 'NOT_RUN' : 'NA'; }
          }
          const r = validateGps(t, pos, {
            execId, itemId: item.id, notes: `Checklist item ${item.id} GPS confirmation`,
          });
          if (r && r.created) gpsCreated += 1;
          if (r && (r.result === 'FAIL' || (r.violation && r.result !== 'MANUAL_REVIEW'))) {
            gpsFailed = true;
            return 'FAIL';
          }
          return 'PASS';
        }
        if (item.response_type === 'NUMERIC' && responseValue !== undefined && responseValue !== null) {
          const pc = parseCriteria(item.pass_criteria);
          const val = Number(responseValue);
          return pc && val >= pc.min && val <= pc.max ? 'PASS' : 'FAIL';
        }
        if (item.response_type === 'PASS_FAIL' || item.response_type === 'YES_NO') {
          return responseValue === true || responseValue === 'true' || responseValue === 'PASS' || responseValue === 'YES' ? 'PASS' : 'FAIL';
        }
        if (item.response_type === 'SELECT') {
          const pc = parseCriteria(item.pass_criteria);
          if (pc && Array.isArray(pc.pass)) return pc.pass.includes(responseValue) ? 'PASS' : 'FAIL';
          return responseValue ? 'PASS' : 'FAIL';
        }
        if (item.response_type === 'TEXT' || item.response_type === 'PHOTO') return responseValue ? 'PASS' : (item.required ? 'NOT_RUN' : 'NA');
        return 'PASS';
      };

      for (const item of items) {
        const sub = submitted[item.id] || submitted[item.sequence] || {};
        const responseValue = sub.response_value;
        // The item result is derived from the captured response, never trusted
        // from the request body — otherwise a caller could force PASS/NOT_RUN.
        const result = itemResult(item, responseValue);
        if (result === 'FAIL' && item.critical_step) hasCriticalFail = true;
        if (result === 'FAIL') hasFail = true;
        if (item.required && (result === 'NOT_RUN' || result === 'INCOMPLETE' || !result)) hasRequiredMissing = true;

        insertRow('checklist_execution_item', {
          execution_id: execId,
          template_item_id: item.id,
          sequence: item.sequence,
          instruction: item.instruction,
          response_type: item.response_type,
          response_value: responseValue !== undefined ? JSON.stringify(responseValue) : null,
          result: result || 'NOT_RUN',
          comment: sub.comment || null,
          completed_at: now,
        });
      }

      // Even when the template has no GPS_POINT item, the crew's finishing-place
      // GPS must be compared to the installed device location so the comparison
      // is never missed. Record a validation row whenever a finishing position
      // was captured without one already being created above.
      if (req.body.finish_gps && gpsCreated === 0) {
        const r = validateGps(t, req.body.finish_gps, {
          execId: null, itemId: null, notes: 'Finishing-place GPS vs installed device location',
        });
        if (r && r.created) gpsCreated += 1;
        if (r && r.result === 'FAIL') gpsFailed = true;
      }

      const overall = hasCriticalFail || gpsFailed ? 'FAIL' : hasRequiredMissing ? 'INCOMPLETE' : hasFail ? 'FAIL' : 'PASS';
      updateRow('checklist_execution', execId, { result: overall });

      // The task advances only once *every* governed template has a finished
      // run. The task-level result fails if any template's latest run failed.
      const allTemplatesDone = !checklistCompletionBlocker(t);
      const latest = db.prepare(
        `SELECT e.result FROM checklist_execution e
          JOIN (SELECT template_id, MAX(id) AS exec_id FROM checklist_execution
                 WHERE task_id = ? AND submitted_at IS NOT NULL GROUP BY template_id) m
            ON m.exec_id = e.id`
      ).all(t.id);
      const taskResult = latest.some((r) => r.result === 'FAIL') ? 'FAIL' : 'PASS';
      const advanced = canSubmitRun && overall !== 'INCOMPLETE' && allTemplatesDone
        && (t.status === 'IN_PROGRESS' || t.status === 'ASSIGNED');
      if (advanced) {
        db.prepare('UPDATE task SET status = ?, updated_at = ?, actual_start = COALESCE(actual_start, ?), result = ?, revision = revision + 1 WHERE id = ?')
          .run('PENDING_VERIFICATION', now, now, taskResult, t.id);
      }
      return { execId, overall, gpsCreated, advanced, templates_done: allTemplatesDone };
    });
  } catch (e) {
    return res.status(400).json({ error: e.message });
  }
  res.status(201).json({ execution_id: outcome.execId, result: outcome.overall, advanced: outcome.advanced, templates_done: outcome.templates_done, gps_validations_created: outcome.gpsCreated, execution: get('checklist_execution', outcome.execId) });
});

// Resolve the installed device location for a task target. Returns
// {targetType, targetId, expectedLat, expectedLng, tolerance} or null.
function deviceTarget(t) {
  const TOLERANCE = 500;
  if (t.asset_id) {
    const a = get('asset', t.asset_id);
    if (a && a.latitude != null && a.longitude != null) {
      return { targetType: 'ASSET', targetId: a.id, expectedLat: a.latitude, expectedLng: a.longitude, tolerance: TOLERANCE };
    }
    if (a && a.substation_id) {
      const s = get('substation', a.substation_id);
      if (s) return { targetType: 'ASSET', targetId: a.id, expectedLat: s.latitude, expectedLng: s.longitude, tolerance: TOLERANCE };
    }
  }
  if (t.tower_id) {
    const tw = get('tower', t.tower_id);
    if (tw && typeof tw.latitude === 'number' && typeof tw.longitude === 'number') {
      return { targetType: 'TOWER', targetId: tw.id, expectedLat: tw.latitude, expectedLng: tw.longitude, tolerance: 50 };
    }
  }
  if (t.substation_id) {
    const s = get('substation', t.substation_id);
    if (s) return { targetType: 'SUBSTATION', targetId: s.id, expectedLat: s.latitude, expectedLng: s.longitude, tolerance: TOLERANCE };
  }
  if (t.line_id) {
    const l = get('transmission_line', t.line_id, ['route_json']);
    if (l) return { targetType: 'LINE', targetId: l.id, expectedLat: null, expectedLng: null, tolerance: TOLERANCE, route: l.route_json };
  }
  return null;
}

// Compare the measured (finishing-place) GPS against the installed device GPS
// and ALWAYS persist a gps_validation row so a violation can never be missed.
// Returns {created, result, violation, distance, vid} or null if the measured
// position was unusable.
function validateGps(t, pos, { execId, itemId, notes } = {}) {
  if (!pos || pos.lat === undefined || pos.lng === undefined) return null;
  const target = deviceTarget(t);
  const now = new Date().toISOString();
  const measuredLat = Number(pos.lat);
  const measuredLng = Number(pos.lng);

  let expectedLat = target?.expectedLat ?? null;
  let expectedLng = target?.expectedLng ?? null;
  let distance;
  let result;
  let violation = null;
  let ev = null;

  if (target && expectedLat != null && expectedLng != null) {
    distance = haversine(expectedLat, expectedLng, measuredLat, measuredLng);
    result = distance <= target.tolerance ? 'PASS' : 'FAIL';
    ev = evaluateViolation({
      targetType: target.targetType, targetId: target.targetId, regionId: t.region_id,
      measuredLat, measuredLng, distance, tolerance: target.tolerance,
    });
    violation = ev.violation;
  } else if (target && target.targetType === 'LINE' && Array.isArray(target.route) && target.route.length > 1) {
    expectedLat = measuredLat; expectedLng = measuredLng;
    distance = nearestRouteDistance(target.route, measuredLat, measuredLng);
    result = distance <= target.tolerance ? 'PASS' : 'FAIL';
    ev = evaluateViolation({
      targetType: 'LINE', targetId: target.targetId, regionId: t.region_id,
      measuredLat, measuredLng, distance, tolerance: target.tolerance,
    });
    violation = ev.violation;
  } else {
    // Device location unknown (no coordinates on record / no route): persist a
    // MANUAL_REVIEW row instead of silently passing, so it surfaces for review.
    expectedLat = measuredLat; expectedLng = measuredLng;
    distance = 0;
    result = 'MANUAL_REVIEW';
    violation = null;
  }

  const pass = result === 'PASS' && !violation;

  const vid = insertRow('gps_validation', {
    target_type: target?.targetType || 'ASSET',
    target_id: target?.targetId || null,
    region_id: t.region_id,
    expected_lat: expectedLat,
    expected_lng: expectedLng,
    measured_lat: measuredLat,
    measured_lng: measuredLng,
    accuracy_m: pos.accuracy_m || 5,
    distance_m: distance,
    tolerance_m: target?.tolerance ?? 50,
    result,
    inside_geofence: ev ? flag(ev.inGeofence) : null,
    in_region_boundary: ev ? flag(ev.inRegion) : null,
    violation,
    geofence_id: ev?.geofenceId ?? null,
    review_status: violation || result !== 'PASS' ? 'OPEN' : 'NOT_REQUIRED',
    validation_method: 'APP_CAPTURE',
    validated_by: t.crew_id,
    validated_at: now,
    linked_task_id: t.id,
    notes: notes || `GPS confirmation for task ${t.task_number}`,
  });

  if (target && target.targetType === 'ASSET' && target.targetId) {
    updateRow('asset', target.targetId, { gps_validated: pass ? 1 : 0, last_gps_validation_at: now });
  } else if (target && target.targetType === 'SUBSTATION') {
    updateRow('substation', target.targetId, { gps_validated: pass ? 1 : 0, last_gps_validation_at: now });
  } else if (target && target.targetType === 'TOWER') {
    updateRow('tower', target.targetId, { gps_validated: pass ? 1 : 0 });
    db.prepare('UPDATE asset SET gps_validated = ?, last_gps_validation_at = ? WHERE tower_id = ?')
      .run(pass ? 1 : 0, now, target.targetId);
  }

  if (itemId) {
    // Link the execution item so reviewers can trace the device-vs-finish check.
    db.prepare("UPDATE checklist_execution_item SET comment = COALESCE(comment, '') || ' GPS:' || ? || ' dist:' || ROUND(?,1) || 'm' WHERE id = ?")
      .run(result, distance, itemId);
  }

  return { created: true, result, violation, distance, vid };
}

// Minimum great-circle distance from a point to a polyline route (in meters),
// using a local equirectangular projection for the point-to-segment foot.
function nearestRouteDistance(route, lat, lng) {
  let best = Infinity;
  for (let i = 0; i < route.length - 1; i++) {
    const a = route[i];
    const b = route[i + 1];
    if (!Array.isArray(a) || !Array.isArray(b) || a.length < 2 || b.length < 2) continue;
    best = Math.min(best, pointToSegmentMeters(a[0], a[1], b[0], b[1], lat, lng));
  }
  return best === Infinity ? null : best;
}

function pointToSegmentMeters(ax, ay, bx, by, px, py) {
  const mPerDegLat = 111320;
  const mPerDegLng = 111320 * Math.cos((py * Math.PI) / 180);
  const Ax = ax * mPerDegLat, Ay = ay * mPerDegLng;
  const Bx = bx * mPerDegLat, By = by * mPerDegLng;
  const Px = px * mPerDegLat, Py = py * mPerDegLng;
  const ABx = Bx - Ax, ABy = By - Ay;
  const lenSq = ABx * ABx + ABy * ABy || 1;
  const t = Math.max(0, Math.min(1, ((Px - Ax) * ABx + (Py - Ay) * ABy) / lenSq));
  return Math.hypot(Px - (Ax + t * ABx), Py - (Ay + t * ABy));
}

router.patch('/tasks/:id/work-items/:itemId', (req, res) => {
  const t = get('task', Number(req.params.id));
  if (!t) return res.status(404).json({ error: 'Task not found' });
  if (!taskVisible(req.user, t)) return res.status(404).json({ error: 'Task not found' });
  const allowed = can(req, 'task:execute') || can(req, 'task:lead') || can(req, 'task:manage');
  if (!allowed) return res.status(403).json({ error: 'Forbidden: requires task:execute, task:lead or task:manage' });
  if (isCrewUser(req.user) && !isOnCrew(req.user, t.crew_id)) {
    return res.status(403).json({ error: 'Forbidden: not your assigned task' });
  }
  const item = get('task_work_item', Number(req.params.itemId));
  if (!item || item.task_id !== t.id) return res.status(404).json({ error: 'Work item not found' });
  const status = req.body.status;
  if (status !== 'OPEN' && status !== 'DONE') return res.status(400).json({ error: 'status must be OPEN or DONE' });
  updateRow('task_work_item', item.id, { status, updated_at: new Date().toISOString() });
  audit(req.user, 'UPDATE', 'task_work_item', item.id, { task_id: t.id, status });
  res.json(get('task_work_item', item.id));
});

function lineCoverageFor(lineId, route) {
  const towers = db.prepare('SELECT id, km_marker, latitude, longitude FROM tower WHERE line_id = ? ORDER BY km_marker, id').all(lineId);
  const tasks = db.prepare('SELECT id, status, tower_id FROM task WHERE line_id = ? OR tower_id IN (SELECT id FROM tower WHERE line_id = ?)').all(lineId, lineId);
  const traceTaskIds = db.prepare('SELECT DISTINCT task_id FROM inspection_trace_point WHERE line_id = ?').all(lineId).map((r) => r.task_id);
  return coverage({ lineId, route, towers, tasks, traceTaskIds });
}

router.post('/tasks/:id/trace', (req, res) => {
  const t = get('task', Number(req.params.id));
  if (!t) return res.status(404).json({ error: 'Task not found' });
  if (!taskVisible(req.user, t)) return res.status(404).json({ error: 'Task not found' });
  if (!can(req, 'task:execute')) return res.status(403).json({ error: 'Forbidden: requires task:execute' });
  if (isCrewUser(req.user) && !isOnCrew(req.user, t.crew_id)) {
    return res.status(403).json({ error: 'Forbidden: not your assigned task' });
  }
  if (!t.line_id) return res.status(400).json({ error: 'Task is not associated with a transmission line' });
  let points;
  try { points = validatePoints(req.body.points); }
  catch (e) { return res.status(400).json({ error: e.message }); }
  const line = get('transmission_line', t.line_id, ['route_json']);
  const route = line && Array.isArray(line.route_json) ? line.route_json : [];
  const now = new Date().toISOString();
  const crewId = req.body.crew_id || t.crew_id || null;
  let inserted;
  try {
    inserted = withTx(() => {
      let n = 0;
      for (const p of points) {
        // A retried offline batch must not duplicate ground positions it
        // already recorded, so a point carrying a seen client_ref is skipped.
        if (p.client_ref && byClientRef('inspection_trace_point', p.client_ref)) continue;
        const proj = route.length >= 2 ? projectPointToRoute(route, p.lat, p.lng) : null;
        insertRow('inspection_trace_point', {
          task_id: t.id,
          line_id: t.line_id,
          lat: p.lat,
          lng: p.lng,
          accuracy_m: p.accuracy_m,
          km: proj ? proj.km : null,
          recorded_at: p.recorded_at || now,
          created_at: now,
          crew_id: crewId,
          client_ref: p.client_ref || null,
        });
        n += 1;
      }
      return n;
    });
  } catch (e) {
    return res.status(400).json({ error: e.message });
  }
  audit(req.user, 'TRACE', 'task', t.id, { inserted });
  res.status(201).json({ inserted });
});

router.get('/tasks/:id/trace', (req, res) => {
  const t = get('task', Number(req.params.id));
  if (!t) return res.status(404).json({ error: 'Task not found' });
  if (!taskVisible(req.user, t)) return res.status(404).json({ error: 'Task not found' });
  const points = db.prepare(
    'SELECT lat, lng, km, accuracy_m, recorded_at FROM inspection_trace_point WHERE task_id = ? ORDER BY recorded_at, id'
  ).all(t.id);
  let cov = null;
  if (t.line_id) {
    const line = get('transmission_line', t.line_id, ['route_json']);
    const route = line && Array.isArray(line.route_json) ? line.route_json : [];
    cov = lineCoverageFor(t.line_id, route);
  }
  res.json({ points, coverage: cov });
});

module.exports = router;
