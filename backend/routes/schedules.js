const express = require('express');
const { db, list, get, insertRow, updateRow } = require('../util');
const { can, isGlobal, audit } = require('../auth');
const { canAssignCrew, commandScope } = require('../authority');
const { taskRequirements } = require('../readiness');
const { autoAssignCrewId } = require('../assignment');
const recurrence = require('../recurrence');
const { nextTaskNumber } = require('../taskNumber');

const router = express.Router();

const TASK_TYPES = ['PREVENTIVE', 'CORRECTIVE', 'EMERGENCY', 'INSPECTION', 'REPLACEMENT', 'TESTING', 'REPAIR'];

const OPEN_STATUSES = ["DRAFT", "SCHEDULED", "ASSIGNED", "IN_PROGRESS", "ON_HOLD", "PENDING_VERIFICATION"];

// Scan existing task numbers instead of parsing the newest row: legacy rows
// like TK-SCRATCH-CAP must not poison the next number.
function robustTaskNumber() {
  return nextTaskNumber();
}

function resolveTaskType(s) {
  if (s.task_type && TASK_TYPES.includes(s.task_type)) return s.task_type;
  return s.checklist_template_id ? 'INSPECTION' : 'PREVENTIVE';
}

function scheduleDetail(s) {
  const out = { ...s };
  out.checklist_template = s.checklist_template_id ? get('checklist_template', s.checklist_template_id) : null;
  out.responsible_crew = s.responsible_crew_id ? get('crew', s.responsible_crew_id) : null;
  out.task_type = resolveTaskType(s);
  let rule = null;
  try { rule = recurrence.ruleFromSchedule(s); } catch { rule = null; }
  out.recurrence = rule;
  out.recurrence_summary = rule ? recurrence.describe(rule) : '';
  out.occurrences_generated = s.occurrences_generated || 0;
  out.targets = expandTargets(s);
  const open = db.prepare(
    `SELECT COUNT(*) c FROM task WHERE schedule_id = ? AND status IN (${OPEN_STATUSES.map(() => '?').join(',')})`
  ).get(s.id, ...OPEN_STATUSES).c;
  out.open_generated_tasks = open;
  return out;
}

function expandTargets(s) {
  if (s.scope_type === 'ASSET_CLASS') {
    return db.prepare('SELECT * FROM asset WHERE asset_type = ? AND lifecycle_status IN (?, ?)').all(s.asset_type, 'IN_SERVICE', 'UNDER_MAINTENANCE');
  }
  if (s.scope_type === 'ASSET') return s.asset_id ? [get('asset', s.asset_id)].filter(Boolean) : [];
  if (s.scope_type === 'SUBSTATION') return s.substation_id ? [get('substation', s.substation_id)].filter(Boolean) : [];
  if (s.scope_type === 'LINE') return s.line_id ? [get('transmission_line', s.line_id)].filter(Boolean) : [];
  if (s.scope_type === 'LINE_TOWERS') return s.line_id ? db.prepare('SELECT * FROM tower WHERE line_id = ? ORDER BY km_marker').all(s.line_id) : [];
  if (s.scope_type === 'TOWER') return s.tower_id ? [get('tower', s.tower_id)].filter(Boolean) : [];
  if (s.scope_type === 'REGION') return db.prepare('SELECT * FROM substation WHERE region_id = ?').all(s.region_id);
  return [];
}

// Resolve the region a generated task belongs to. Targets (assets, towers, lines)
// do not carry region_id directly, so derive it from their parent.
function targetRegion(target, scheduleRegion) {
  if (target.region_id) return target.region_id;
  if (target.substation_id) {
    const s = db.prepare('SELECT region_id FROM substation WHERE id = ?').get(target.substation_id);
    if (s) return s.region_id;
  }
  if (target.line_id) {
    const l = db.prepare('SELECT region_id FROM transmission_line WHERE id = ?').get(target.line_id);
    if (l) return l.region_id;
  }
  if (target.tower_id !== undefined && target.line_id) {
    const l = db.prepare('SELECT region_id FROM transmission_line WHERE id = ?').get(target.line_id);
    if (l) return l.region_id;
  }
  if (target.asset_type) {
    const a = db.prepare('SELECT * FROM asset WHERE id = ?').get(target.id);
    if (a) {
      if (a.substation_id) {
        const s = db.prepare('SELECT region_id FROM substation WHERE id = ?').get(a.substation_id);
        if (s) return s.region_id;
      }
      if (a.line_id) {
        const l = db.prepare('SELECT region_id FROM transmission_line WHERE id = ?').get(a.line_id);
        if (l) return l.region_id;
      }
    }
  }
  return scheduleRegion;
}

router.get('/schedules', (req, res) => {
  const scope = commandScope(req.user);
  let rows = list('maintenance_schedule').filter((s) => scope.global || scope.scheduleIds.has(s.id));
  const { is_active, q } = req.query;
  if (is_active !== undefined) rows = rows.filter((s) => s.is_active === Number(is_active));
  if (q) rows = rows.filter((s) => s.schedule_name.toLowerCase().includes(q.toLowerCase()));
  res.json(rows.map(scheduleDetail));
});

router.get('/schedules/:id', (req, res) => {
  const s = get('maintenance_schedule', Number(req.params.id));
  if (!s) return res.status(404).json({ error: 'Schedule not found' });
  const scope = commandScope(req.user);
  if (!scope.global && !scope.scheduleIds.has(s.id)) {
    return res.status(404).json({ error: 'Schedule not found' });
  }
  const detail = scheduleDetail(s);
  detail.generated_tasks = db.prepare('SELECT * FROM task WHERE schedule_id = ? ORDER BY created_at DESC').all(s.id);
  res.json(detail);
});

router.post('/schedules', (req, res) => {
  if (!can(req, 'schedule:write')) return res.status(403).json({ error: 'Forbidden: requires schedule:write' });
  const body = { ...req.body, revision: 1 };
  if (body.task_type && !TASK_TYPES.includes(body.task_type)) return res.status(400).json({ error: 'Invalid task_type' });
  if (body.frequency === 'CUSTOM') {
    try { body.frequency_config = JSON.stringify(recurrence.parseRule(body.frequency_config)); }
    catch (e) { return res.status(400).json({ error: e.message }); }
  }
  if (!body.region_id && !isGlobal(req.user)) body.region_id = req.user.region_id;
  if (!body.region_id) {
    const probe = { scope_type: body.scope_type, line_id: body.line_id, tower_id: body.tower_id, substation_id: body.substation_id, asset_id: body.asset_id, asset_type: body.asset_type };
    body.region_id = targetRegion(probe, null) ?? undefined;
  }
  if (body.responsible_crew_id !== null && body.responsible_crew_id !== undefined && !canAssignCrew(req.user, body.responsible_crew_id)) {
    return res.status(403).json({ error: 'Forbidden: crew is outside your authority' });
  }
  try {
    const id = insertRow('maintenance_schedule', body);
    audit(req.user, 'CREATE', 'schedule', id, req.body);
    res.status(201).json(scheduleDetail(get('maintenance_schedule', id)));
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

router.put('/schedules/:id', (req, res) => {
  if (!can(req, 'schedule:write')) return res.status(403).json({ error: 'Forbidden: requires schedule:write' });
  const s = get('maintenance_schedule', Number(req.params.id));
  if (!s) return res.status(404).json({ error: 'Schedule not found' });
  const scope = commandScope(req.user);
  if (!scope.global && !scope.scheduleIds.has(s.id)) {
    return res.status(404).json({ error: 'Schedule not found' });
  }
  if (req.body.responsible_crew_id !== null && req.body.responsible_crew_id !== undefined && !canAssignCrew(req.user, req.body.responsible_crew_id)) {
    return res.status(403).json({ error: 'Forbidden: crew is outside your authority' });
  }
  if (req.body.task_type && !TASK_TYPES.includes(req.body.task_type)) return res.status(400).json({ error: 'Invalid task_type' });
  const effectiveFrequency = req.body.frequency !== undefined ? req.body.frequency : s.frequency;
  if (effectiveFrequency === 'CUSTOM' && (req.body.frequency !== undefined || req.body.frequency_config !== undefined)) {
    try { req.body.frequency_config = JSON.stringify(recurrence.parseRule(req.body.frequency_config)); }
    catch (e) { return res.status(400).json({ error: e.message }); }
  }
  updateRow('maintenance_schedule', Number(req.params.id), { ...req.body }, [], 'revision');
  audit(req.user, 'UPDATE', 'schedule', Number(req.params.id), req.body);
  res.json(scheduleDetail(get('maintenance_schedule', Number(req.params.id))));
});

// Dry-run preview of next generation
router.get('/schedules/:id/preview', (req, res) => {
  const s = get('maintenance_schedule', Number(req.params.id));
  if (!s) return res.status(404).json({ error: 'Schedule not found' });
  const scope = commandScope(req.user);
  if (!scope.global && !scope.scheduleIds.has(s.id)) {
    return res.status(404).json({ error: 'Schedule not found' });
  }
  const targets = expandTargets(s);
  let rule = null;
  try { rule = recurrence.ruleFromSchedule(s); } catch { rule = null; }
  res.json({
    schedule: s,
    target_count: targets.length,
    targets: targets.map((x) => ({ id: x.id, name: x.name || x.tower_id || x.substation_id || x.line_id || x.asset_id, type: s.scope_type })),
    next_due_date: s.next_due_date,
    next_occurrences: rule ? recurrence.preview(s.next_due_date, rule, 5) : [],
  });
});

// Run generation for all due schedules (or a specific one)
router.post('/schedules/run', (req, res) => {
  if (!can(req, 'schedule:run')) return res.status(403).json({ error: 'Forbidden: requires schedule:run' });
  const onlyId = req.body.schedule_id ? Number(req.body.schedule_id) : null;
  const scope = commandScope(req.user);
  const results = { generated: 0, skipped_duplicate: 0, not_due: 0, tasks: [], errors: [] };
  let schedules = list('maintenance_schedule').filter((s) => s.is_active === 1);
  if (!scope.global) schedules = schedules.filter((s) => scope.scheduleIds.has(s.id));
  if (onlyId) {
    // A run explicitly targeting one schedule must never silently do nothing:
    // surface an authority error when the schedule is out of scope.
    const exists = get('maintenance_schedule', onlyId);
    if (exists && !schedules.some((s) => s.id === onlyId)) {
      results.errors.push({ schedule_id: onlyId, error: 'schedule is outside your authority' });
    }
    schedules = schedules.filter((s) => s.id === onlyId);
  }
  const now = new Date().toISOString();
  const today = new Date().toISOString();

  for (const s of schedules) {
    try {
      if (s.next_due_date > today) { results.not_due++; continue; }
      if (s.responsible_crew_id && !canAssignCrew(req.user, s.responsible_crew_id)) {
        results.errors.push({ schedule_id: s.id, error: 'responsible crew is outside your authority' });
        continue;
      }
      const targets = expandTargets(s);
      // Requirements are the same for every target of this schedule, so resolve
      // them once and let auto-assignment pick the best eligible crew below.
      const taskType = resolveTaskType(s);
      const reqs = s.checklist_template_id
        ? taskRequirements({ checklist_template_id: s.checklist_template_id, is_energized_work: s.is_energized_work, permit_required: s.permit_required })
        : null;
      const neededCerts = reqs
        ? reqs.required_certs
        : taskType === 'PREVENTIVE' ? ['SF6_HANDLING'] : taskType === 'INSPECTION' ? [] : ['LIVE_LINE'];
      // duplicate guard: existing open task for this schedule
      const existing = db.prepare(
        `SELECT COUNT(*) c FROM task WHERE schedule_id = ? AND status IN (${OPEN_STATUSES.map(() => '?').join(',')})`
      ).get(s.id, ...OPEN_STATUSES).c;
      if (existing > 0) { results.skipped_duplicate++; continue; }
      for (const target of targets) {
        // The schedule/asset intends a crew; keep it when it is eligible and
        // otherwise borrow the best eligible crew from the same department. With
        // no intended crew the task stays uncrewed (SCHEDULED) for dispatch.
        const intendedCrewId = (target.asset_type ? target.default_crew_id || s.responsible_crew_id : s.responsible_crew_id) || null;
        const crewId = autoAssignCrewId(intendedCrewId, { reqs, neededCerts });
        if (crewId && !canAssignCrew(req.user, crewId)) {
          results.errors.push({ schedule_id: s.id, error: 'crew is outside your authority' });
          continue;
        }
        const taskNumber = robustTaskNumber();
        const isTower = target.tower_id != null;
        const isAsset = target.asset_type !== undefined;
        const title = `${s.schedule_name} — ${target.name || target.tower_id || target.substation_id || target.line_id || target.asset_id || ''}`.trim();
        const t = {
          task_number: taskNumber,
          title,
          description: s.instructions || `Auto-generated from schedule ${s.schedule_code}`,
          task_type: resolveTaskType(s),
          priority: s.priority,
          // A schedule that names a responsible crew pre-assigns the work:
          // generate it ASSIGNED so it does not need a second manual handoff.
          // Without a crew it stays SCHEDULED awaiting dispatch.
          status: crewId ? 'ASSIGNED' : 'SCHEDULED',
          region_id: targetRegion(target, s.region_id),
          // FKs must be numeric row ids — never the textual business codes
          // (substation_id / line_id / tower_id / asset_id on the parent rows).
          substation_id: s.scope_type === 'SUBSTATION' ? target.id : (target.substation_id != null ? target.substation_id : null),
          line_id: isTower ? target.line_id : (s.scope_type === 'LINE' || s.scope_type === 'LINE_TOWERS' ? s.line_id : (target.line_id != null ? target.line_id : null)),
          tower_id: isTower ? target.id : null,
          asset_id: isAsset ? target.id : null,
          checklist_template_id: s.checklist_template_id,
          crew_id: crewId,
          due_date: s.next_due_date,
          source: 'SCHEDULE_GENERATED',
          schedule_id: s.id,
          created_by: req.user.person_id || null,
          assigned_by: crewId ? (req.user.person_id || null) : null,
          created_at: now,
          updated_at: now,
          revision: 1,
        };
        const tid = insertRow('task', t);
        results.generated++;
        results.tasks.push(get('task', tid));
      }
      const step = recurrence.advanceAfterGeneration(s);
      updateRow('maintenance_schedule', s.id, {
        last_generated_at: now,
        next_due_date: step.next_due_date,
        occurrences_generated: step.occurrences_generated,
        is_active: step.is_active,
        ...(step.frequency ? { frequency: step.frequency, frequency_config: step.frequency_config } : {}),
      });
    } catch (e) {
      results.errors.push({ schedule_id: s.id, error: e.message });
    }
  }
  res.json(results);
});

module.exports = router;
