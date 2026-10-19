const express = require('express');
const { db, list, get, insertRow, updateRow } = require('../util');
const { can, isGlobal, audit } = require('../auth');
const { canAssignCrew, commandScope, userHasFunctionalScope } = require('../authority');
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

// batch_size is optional: null/blank/0 means no cap. Returns false on invalid input.
function normalizeBatchSize(body) {
  if (body.batch_size === undefined) return true;
  if (body.batch_size === null || body.batch_size === '') { body.batch_size = null; return true; }
  const n = Number(body.batch_size);
  if (!Number.isInteger(n) || n < 0) return false;
  body.batch_size = n;
  return true;
}

const SCOPES = ['ASSET', 'ASSET_CLASS', 'SUBSTATION', 'LINE', 'LINE_TOWERS', 'TOWER', 'REGION', 'LINE_GROUP', 'SUBSTATION_GROUP', 'ASSET_GROUP'];
const GROUP_TABLES = { LINE_GROUP: 'transmission_line', SUBSTATION_GROUP: 'substation', ASSET_GROUP: 'asset' };
const SCOPE_FIELDS = ['asset_type', 'asset_id', 'substation_id', 'line_id', 'tower_id'];

function defaultScopeFilter() {
  return { mode: 'FILTER', voltages: [], ids: [] };
}

// Accepts a stored JSON string or a request object; returns null when invalid.
function parseScopeFilterInput(raw) {
  if (raw == null || raw === '') return defaultScopeFilter();
  let value = raw;
  if (typeof value === 'string') {
    try { value = JSON.parse(value); } catch { return null; }
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const mode = String(value.mode || 'FILTER').toUpperCase();
  if (!['FILTER', 'SPECIFIC'].includes(mode)) return null;
  const voltages = Array.isArray(value.voltages) ? [...new Set(value.voltages.map(Number))] : [];
  if (voltages.some((n) => !Number.isFinite(n) || n <= 0)) return null;
  voltages.sort((a, b) => b - a);
  let ids = Array.isArray(value.ids) ? value.ids.map(Number) : [];
  if (ids.some((n) => !Number.isInteger(n) || n <= 0)) return null;
  ids = [...new Set(ids)];
  if (mode === 'FILTER') ids = [];
  return { mode, voltages: mode === 'SPECIFIC' ? [] : voltages, ids };
}

function storedFilter(s) {
  return parseScopeFilterInput(s.scope_filter) || defaultScopeFilter();
}

// Keep exactly one canonical target per scope. Group scopes instead carry a
// validated filter object in scope_filter; every other target field is cleared.
function normalizeScheduleScope(body, user) {
  const scope = String(body.scope_type || '').toUpperCase();
  if (!SCOPES.includes(scope)) return { error: `scope_type must be one of ${SCOPES.join(', ')}` };
  body.scope_type = scope;
  const keep = {};
  for (const f of SCOPE_FIELDS) keep[f] = body[f];
  for (const f of SCOPE_FIELDS) body[f] = null;

  if (GROUP_TABLES[scope]) {
    if (scope === 'ASSET_GROUP' && !keep.asset_type) return { error: 'ASSET_GROUP scope requires an asset type' };
    if (keep.asset_type) body.asset_type = String(keep.asset_type);
    const filter = parseScopeFilterInput(body.scope_filter);
    if (!filter) return { error: 'scope_filter must contain a valid mode, voltages, and ids' };
    if (filter.mode === 'SPECIFIC') {
      if (!filter.ids.length) return { error: 'SPECIFIC mode requires at least one entity' };
      const table = GROUP_TABLES[scope];
      const rows = filter.ids.map((id) => get(table, id));
      if (rows.some((r) => !r)) return { error: `${scope} selection includes an unknown entity` };
      if (scope === 'ASSET_GROUP' && rows.some((r) => r.asset_type !== body.asset_type)) {
        return { error: 'Selected assets must match the chosen asset type' };
      }
      if (scope === 'ASSET_GROUP' && rows.some((r) => !['IN_SERVICE', 'UNDER_MAINTENANCE'].includes(r.lifecycle_status))) {
        return { error: 'Selected assets must be in service' };
      }
      if (user && !isGlobal(user) && user.region_id && !userHasFunctionalScope(user)) {
        if (rows.some((r) => targetRegion(r, null) !== user.region_id)) {
          return { error: 'Selected entities are outside your region' };
        }
      }
    }
    body.scope_filter = JSON.stringify(filter);
    return { ok: true };
  }

  body.scope_filter = null;
  switch (scope) {
    case 'ASSET':
      if (!keep.asset_id) return { error: 'ASSET scope requires an asset' };
      if (!get('asset', Number(keep.asset_id))) return { error: 'Asset not found' };
      body.asset_id = Number(keep.asset_id);
      break;
    case 'ASSET_CLASS':
      if (!keep.asset_type) return { error: 'ASSET_CLASS scope requires an asset type' };
      body.asset_type = String(keep.asset_type);
      break;
    case 'SUBSTATION':
      if (!keep.substation_id) return { error: 'SUBSTATION scope requires a substation' };
      if (!get('substation', Number(keep.substation_id))) return { error: 'Substation not found' };
      body.substation_id = Number(keep.substation_id);
      break;
    case 'LINE':
    case 'LINE_TOWERS':
      if (!keep.line_id) return { error: `${scope} scope requires a line` };
      if (!get('transmission_line', Number(keep.line_id))) return { error: 'Line not found' };
      body.line_id = Number(keep.line_id);
      break;
    case 'TOWER': {
      if (!keep.tower_id) return { error: 'TOWER scope requires a tower' };
      const tower = get('tower', Number(keep.tower_id));
      if (!tower) return { error: 'Tower not found' };
      body.tower_id = Number(keep.tower_id);
      // The line is derived so tower schedules always carry a consistent parent.
      body.line_id = tower.line_id;
      break;
    }
    case 'REGION':
      if (!body.region_id) return { error: 'REGION scope requires a region' };
      if (!get('region', Number(body.region_id))) return { error: 'Region not found' };
      break;
  }
  return { ok: true };
}

function scopeSummary(s) {
  const labels = { LINE_GROUP: 'Lines', SUBSTATION_GROUP: 'Substations', ASSET_GROUP: 'Assets' };
  const label = labels[s.scope_type];
  if (!label) {
    if (s.scope_type === 'ASSET_CLASS') return `Assets · ${s.asset_type || 'all types'}`;
    if (s.scope_type === 'REGION') {
      const r = s.region_id ? get('region', s.region_id) : null;
      return r ? `Region · ${r.name}` : 'Region';
    }
    return s.scope_type;
  }
  const filter = storedFilter(s);
  const parts = [label];
  if (s.scope_type === 'ASSET_GROUP' && s.asset_type) parts.push(s.asset_type);
  if (filter.mode === 'SPECIFIC') {
    parts.push(`${filter.ids.length} specific`);
  } else {
    if (s.region_id) {
      const r = get('region', s.region_id);
      if (r) parts.push(r.name);
    }
    if (filter.voltages.length) parts.push(`${filter.voltages.join('/')} kV`);
  }
  return parts.join(' · ');
}

function scheduleDetail(s, { sample = true } = {}) {
  const out = { ...s };
  out.checklist_template = s.checklist_template_id ? get('checklist_template', s.checklist_template_id) : null;
  out.responsible_crew = s.responsible_crew_id ? get('crew', s.responsible_crew_id) : null;
  out.task_type = resolveTaskType(s);
  let rule = null;
  try { rule = recurrence.ruleFromSchedule(s); } catch { rule = null; }
  out.recurrence = rule;
  out.recurrence_summary = rule ? recurrence.describe(rule) : '';
  out.occurrences_generated = s.occurrences_generated || 0;
  out.batch_size = s.batch_size != null ? Number(s.batch_size) : null;
  out.scope_filter = storedFilter(s);
  out.scope_summary = scopeSummary(s);
  // The expanded target list can be huge (a REGION scope covers every asset), so
  // lists use a COUNT and only the detail view materialises a capped sample.
  out.target_count = countTargets(s);
  // Remaining is computed for every caller (the list needs it for due_state) but
  // the target sample is only materialised for the detail view.
  out.remaining = countRemaining(s);
  if (sample) {
    out.targets = expandTargets(s).slice(0, 200);
  }
  const lead = Math.max(0, Number(s.lead_time_days) || 0);
  out.lead_time_days = lead;
  const dueMs = s.next_due_date ? new Date(s.next_due_date).getTime() : NaN;
  if (!Number.isNaN(dueMs)) {
    out.generate_by = new Date(dueMs - lead * 86400000).toISOString();
    out.days_until_due = Math.ceil((dueMs - Date.now()) / 86400000);
    out.next_occurrences = rule ? recurrence.preview(s.next_due_date, rule, 3) : [];
  }
  out.due_state = computeDueState(s, out, dueMs, lead);
  const open = db.prepare(
    `SELECT COUNT(*) c FROM task WHERE schedule_id = ? AND status IN (${OPEN_STATUSES.map(() => '?').join(',')})`
  ).get(s.id, ...OPEN_STATUSES).c;
  out.open_generated_tasks = open;
  return out;
}

const LIFECYCLE_LIVE = "lifecycle_status IN ('IN_SERVICE','UNDER_MAINTENANCE')";

// The `asset` predicate a schedule selects, or null when it targets towers.
// Shared so counting and expansion agree on what "in scope" means.
function assetScopeFilter(s) {
  switch (s.scope_type) {
    case 'ASSET_CLASS':
      return s.asset_type ? { sql: `asset_type = ? AND ${LIFECYCLE_LIVE}`, params: [s.asset_type] } : null;
    case 'ASSET':
      return s.asset_id ? { sql: 'id = ?', params: [s.asset_id] } : null;
    case 'SUBSTATION':
      return s.substation_id ? { sql: `substation_id = ? AND ${LIFECYCLE_LIVE}`, params: [s.substation_id] } : null;
    case 'LINE':
      return s.line_id ? { sql: `line_id = ? AND ${LIFECYCLE_LIVE}`, params: [s.line_id] } : null;
    case 'REGION':
      return s.region_id ? {
        sql: `${LIFECYCLE_LIVE} AND (
           EXISTS (SELECT 1 FROM substation ss WHERE ss.id = asset.substation_id AND ss.region_id = ?)
           OR EXISTS (SELECT 1 FROM transmission_line l WHERE l.id = asset.line_id AND l.region_id = ?)
           OR EXISTS (SELECT 1 FROM tower t JOIN transmission_line l ON l.id = t.line_id WHERE t.id = asset.tower_id AND l.region_id = ?)
         )`,
        params: [s.region_id, s.region_id, s.region_id],
      } : null;
    default:
      return null;
  }
}

function towerScopeFilter(s) {
  if (s.scope_type === 'LINE_TOWERS') return s.line_id ? { sql: 'line_id = ?', params: [s.line_id] } : null;
  if (s.scope_type === 'TOWER') return s.tower_id ? { sql: 'id = ?', params: [s.tower_id] } : null;
  return null;
}

// Predicate for the grouped scopes. FILTER mode uses region + voltage; SPECIFIC
// mode uses the validated id list. Counting and expansion share this predicate.
function groupFilter(s, table) {
  const filter = storedFilter(s);
  if (filter.mode === 'SPECIFIC') {
    return { sql: `id IN (${filter.ids.map(() => '?').join(',')})`, params: [...filter.ids] };
  }
  const clauses = [];
  const params = [];
  if (s.region_id != null) {
    if (table === 'asset') {
      clauses.push(`(
        EXISTS (SELECT 1 FROM substation ss WHERE ss.id = asset.substation_id AND ss.region_id = ?)
        OR EXISTS (SELECT 1 FROM transmission_line l WHERE l.id = asset.line_id AND l.region_id = ?)
        OR EXISTS (SELECT 1 FROM tower t JOIN transmission_line l ON l.id = t.line_id WHERE t.id = asset.tower_id AND l.region_id = ?)
      )`);
      params.push(s.region_id, s.region_id, s.region_id);
    } else {
      clauses.push('region_id = ?');
      params.push(s.region_id);
    }
  }
  if (table === 'asset') {
    clauses.push('asset_type = ?');
    params.push(s.asset_type);
    clauses.push(LIFECYCLE_LIVE);
  }
  if (filter.voltages.length) {
    const marks = filter.voltages.map(() => '?').join(',');
    if (table === 'transmission_line') {
      clauses.push(`voltage_kv IN (${marks})`);
      params.push(...filter.voltages);
    } else if (table === 'substation') {
      clauses.push(`EXISTS (
        SELECT 1 FROM json_each(CASE WHEN json_valid(voltage_levels) THEN voltage_levels ELSE '[]' END) v
         WHERE CAST(REPLACE(TRIM(v.value), 'kV', '') AS REAL) IN (${marks}))`);
      params.push(...filter.voltages);
    } else {
      clauses.push(`(
        EXISTS (SELECT 1 FROM transmission_line l WHERE l.id = asset.line_id AND l.voltage_kv IN (${marks}))
        OR EXISTS (SELECT 1 FROM substation ss
                    WHERE ss.id = asset.substation_id
                      AND EXISTS (SELECT 1 FROM json_each(CASE WHEN json_valid(ss.voltage_levels) THEN ss.voltage_levels ELSE '[]' END) v
                                   WHERE CAST(REPLACE(TRIM(v.value), 'kV', '') AS REAL) IN (${marks})))
        OR EXISTS (SELECT 1 FROM tower t JOIN transmission_line l ON l.id = t.line_id
                    WHERE t.id = asset.tower_id AND l.voltage_kv IN (${marks}))
      )`);
      params.push(...filter.voltages, ...filter.voltages, ...filter.voltages);
    }
  }
  return { sql: clauses.length ? clauses.join(' AND ') : '1=1', params };
}

const TARGET_PREFIX = { line: 'l', substation: 's', asset: 'a', tower: 't' };
const TARGET_ANCHOR = { line: 'line_id', substation: 'substation_id', asset: 'asset_id', tower: 'tower_id' };

// The table, anchor kind, and predicate a schedule selects. Every scope resolves
// through here so counting, expansion, and coverage cannot drift apart.
function targetSource(s) {
  if (s.scope_type === 'LINE_GROUP') return { table: 'transmission_line', kind: 'line', ...groupFilter(s, 'transmission_line') };
  if (s.scope_type === 'SUBSTATION_GROUP') return { table: 'substation', kind: 'substation', ...groupFilter(s, 'substation') };
  if (s.scope_type === 'ASSET_GROUP') return { table: 'asset', kind: 'asset', ...groupFilter(s, 'asset') };
  const asset = assetScopeFilter(s);
  if (asset) return { table: 'asset', kind: 'asset', sql: asset.sql, params: asset.params };
  const tower = towerScopeFilter(s);
  if (tower) return { table: 'tower', kind: 'tower', sql: tower.sql, params: tower.params };
  return null;
}

function countTargets(s) {
  const src = targetSource(s);
  if (!src) return 0;
  return db.prepare(`SELECT COUNT(*) c FROM ${src.table} WHERE ${src.sql}`).get(...src.params).c;
}

// Targets in this sweep that still have no task. Counted in SQL so the list view
// does not have to materialise a whole region's register just to show a state.
// A null-occurrence task counts as covered for occurrence 0 (legacy schedules).
function countRemaining(s) {
  const src = targetSource(s);
  if (!src) return 0;
  const occurrence = Number(s.occurrences_generated) || 0;
  const cover = '(schedule_occurrence = ? OR (schedule_occurrence IS NULL AND ? = 0))';
  const anchor = TARGET_ANCHOR[src.kind];
  return db.prepare(
    `SELECT COUNT(*) c FROM ${src.table} WHERE ${src.sql}
       AND id NOT IN (SELECT ${anchor} FROM task WHERE schedule_id = ? AND ${anchor} IS NOT NULL AND ${cover})`
  ).get(...src.params, s.id, occurrence, occurrence).c;
}

function computeDueState(s, out, dueMs, lead) {
  if (s.is_active === 0) return 'ENDED';
  if (out.target_count === 0) return 'NO_TARGETS';
  // Partially generated sweep: some targets already have tasks, others do not.
  // A sweep that has not started (remaining == target_count) is not "in progress".
  if (out.remaining > 0 && out.remaining < out.target_count) return 'SWEEP_IN_PROGRESS';
  if (Number.isNaN(dueMs)) return 'SCHEDULED';
  if (dueMs < Date.now()) return 'OVERDUE';
  return dueMs - lead * 86400000 <= Date.now() ? 'GENERATING' : 'SCHEDULED';
}

function expandTargets(s) {
  const src = targetSource(s);
  if (!src) return [];
  const order = src.kind === 'tower' ? 'km_marker' : 'name';
  return db.prepare(`SELECT * FROM ${src.table} WHERE ${src.sql} ORDER BY ${order}`).all(...src.params);
}

// A target is keyed by the anchor row its task will carry.
function targetKey(target, kind = 'asset') {
  return `${TARGET_PREFIX[kind]}:${target.id}`;
}

// The current sweep's targets and those still missing a task. A task with a null
// occurrence counts as covered for occurrence 0 so schedules authored before the
// occurrence marker do not regenerate their first sweep.
function remainingTargets(s) {
  const occurrence = Number(s.occurrences_generated) || 0;
  const src = targetSource(s);
  if (!src) return { targets: [], remaining: [], occurrence, kind: null };
  const targets = expandTargets(s);
  if (!targets.length) return { targets, remaining: [], occurrence, kind: src.kind };
  const anchor = TARGET_ANCHOR[src.kind];
  const rows = db.prepare(
    `SELECT ${anchor} AS anchor FROM task
      WHERE schedule_id = ? AND ${anchor} IS NOT NULL
        AND (schedule_occurrence = ? OR (schedule_occurrence IS NULL AND ? = 0))`
  ).all(s.id, occurrence, occurrence);
  const covered = new Set(rows.map((r) => `${TARGET_PREFIX[src.kind]}:${r.anchor}`));
  return { targets, remaining: targets.filter((t) => !covered.has(targetKey(t, src.kind))), occurrence, kind: src.kind };
}

// Open tasks left behind by earlier occurrences; they block starting a new sweep.
function sweepBacklog(s, occurrence) {
  return db.prepare(
    `SELECT COUNT(*) c FROM task WHERE schedule_id = ? AND status IN (${OPEN_STATUSES.map(() => '?').join(',')})
       AND (schedule_occurrence IS NULL OR schedule_occurrence < ?)`
  ).get(s.id, ...OPEN_STATUSES, occurrence).c;
}

// A sweep is complete only when every target exists; then the recurrence rolls on.
function advanceSweep(s, now) {
  const step = recurrence.advanceAfterGeneration(s);
  updateRow('maintenance_schedule', s.id, {
    last_generated_at: now,
    next_due_date: step.next_due_date,
    occurrences_generated: step.occurrences_generated,
    is_active: step.is_active,
    ...(step.frequency ? { frequency: step.frequency, frequency_config: step.frequency_config } : {}),
  });
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
  res.json(rows.map((s) => scheduleDetail(s, { sample: false })));
});

// Calendar/timeline feed: every active schedule's upcoming occurrences inside a
// window, tagged with the lead-time "generate by" date so planners can see when
// the next task batch will materialise (not just when it is due).
router.get('/schedules/upcoming', (req, res) => {
  const days = Math.max(1, Math.min(365, Number(req.query.days) || 45));
  const nowMs = Date.now();
  const horizonMs = nowMs + days * 86400000;
  const scope = commandScope(req.user);
  const schedules = list('maintenance_schedule').filter((s) => scope.global || scope.scheduleIds.has(s.id));
  const occurrences = [];
  for (const s of schedules) {
    if (s.is_active !== 1 || !s.next_due_date) continue;
    let rule = null;
    try { rule = recurrence.ruleFromSchedule(s); } catch { rule = null; }
    if (!rule) continue;
    const targetCount = countTargets(s);
    const crew = s.responsible_crew_id ? get('crew', s.responsible_crew_id) : null;
    const lead = Math.max(0, Number(s.lead_time_days) || 0);
    let cursor = s.next_due_date;
    for (let guard = 0; cursor && guard < 60; guard++) {
      const dueMs = new Date(cursor).getTime();
      if (Number.isNaN(dueMs) || dueMs > horizonMs) break;
      const generateByMs = dueMs - lead * 86400000;
      occurrences.push({
        schedule_id: s.id,
        schedule_code: s.schedule_code,
        schedule_name: s.schedule_name,
        scope_type: s.scope_type,
        asset_type: s.asset_type || null,
        task_type: resolveTaskType(s),
        priority: s.priority,
        due_date: cursor,
        lead_time_days: lead,
        generate_by: new Date(generateByMs).toISOString(),
        generate_now: generateByMs <= nowMs,
        overdue: dueMs < nowMs,
        target_count: targetCount,
        crew_name: crew ? crew.name : null,
        region_id: s.region_id,
      });
      cursor = recurrence.nextAfter(cursor, rule);
    }
  }
  occurrences.sort((a, b) => a.due_date.localeCompare(b.due_date));
  res.json({
    days,
    from: new Date(nowMs).toISOString(),
    to: new Date(horizonMs).toISOString(),
    count: occurrences.length,
    overdue_count: occurrences.filter((o) => o.overdue).length,
    generate_now_count: occurrences.filter((o) => o.generate_now).length,
    occurrences,
  });
});

// Adherence: how faithfully the generated work matched the plan over a window.
// For every schedule we compare tasks whose due date landed in the window with
// how many were completed (and completed on time) plus what is still overdue.
router.get('/schedules/adherence', (req, res) => {
  const days = Math.max(7, Math.min(365, Number(req.query.days) || 90));
  const until = new Date().toISOString();
  const since = new Date(Date.now() - days * 86400000).toISOString();
  const openPlaceholders = OPEN_STATUSES.map(() => '?').join(',');
  const scope = commandScope(req.user);
  const schedules = list('maintenance_schedule').filter((s) => scope.global || scope.scheduleIds.has(s.id));
  const rows = [];
  const totals = { due: 0, completed: 0, on_time: 0, overdue_open: 0, pending: 0 };
  for (const s of schedules) {
    const due = db.prepare(
      "SELECT COUNT(*) c FROM task WHERE schedule_id = ? AND due_date >= ? AND due_date <= ? AND status != 'CANCELLED'"
    ).get(s.id, since, until).c;
    const completed = db.prepare(
      "SELECT COUNT(*) c FROM task WHERE schedule_id = ? AND due_date >= ? AND due_date <= ? AND status = 'COMPLETED'"
    ).get(s.id, since, until).c;
    const onTime = db.prepare(
      "SELECT COUNT(*) c FROM task WHERE schedule_id = ? AND due_date >= ? AND due_date <= ? AND status = 'COMPLETED' AND actual_end IS NOT NULL AND actual_end <= due_date"
    ).get(s.id, since, until).c;
    const overdueOpen = db.prepare(
      `SELECT COUNT(*) c FROM task WHERE schedule_id = ? AND due_date < ? AND status IN (${openPlaceholders})`
    ).get(s.id, until, ...OPEN_STATUSES).c;
    const generated = db.prepare('SELECT COUNT(*) c FROM task WHERE schedule_id = ? AND created_at >= ?').get(s.id, since).c;
    const pending = Math.max(0, due - completed - overdueOpen);
    totals.due += due; totals.completed += completed; totals.on_time += onTime;
    totals.overdue_open += overdueOpen; totals.pending += pending;
    rows.push({
      schedule_id: s.id,
      schedule_code: s.schedule_code,
      schedule_name: s.schedule_name,
      scope_type: s.scope_type,
      is_active: s.is_active,
      next_due_date: s.next_due_date,
      generated,
      due,
      completed,
      on_time: onTime,
      overdue_open: overdueOpen,
      pending,
      completion_rate: due ? Math.round((completed / due) * 100) : null,
      on_time_rate: due ? Math.round((onTime / due) * 100) : null,
    });
  }
  rows.sort((a, b) => (a.completion_rate ?? 101) - (b.completion_rate ?? 101));
  const pct = (n, d) => (d ? Math.round((n / d) * 100) : null);
  res.json({
    days,
    from: since,
    to: until,
    totals: {
      ...totals,
      schedules: rows.length,
      completion_rate: pct(totals.completed, totals.due),
      on_time_rate: pct(totals.on_time, totals.due),
    },
    rows,
  });
});

// Live count for the grouped-scope form before the schedule is saved.
router.get('/schedules/scope-preview', (req, res) => {
  if (!can(req, 'schedule:read')) return res.status(403).json({ error: 'Forbidden: requires schedule:read' });
  const list = (v) => {
    if (v == null || v === '') return [];
    if (Array.isArray(v)) return v;
    try { const parsed = JSON.parse(v); return Array.isArray(parsed) ? parsed : [parsed]; }
    catch { return String(v).split(',').map((x) => x.trim()).filter(Boolean); }
  };
  const body = {
    scope_type: String(req.query.scope_type || '').toUpperCase(),
    region_id: req.query.region_id ? Number(req.query.region_id) : null,
    asset_type: req.query.asset_type || null,
    scope_filter: {
      mode: req.query.mode || 'FILTER',
      voltages: list(req.query.voltages).map(Number),
      ids: list(req.query.ids).map(Number),
    },
  };
  if (!GROUP_TABLES[body.scope_type]) return res.status(400).json({ error: 'scope_type must be a grouped scope' });
  if (!body.region_id && !isGlobal(req.user) && req.user.region_id && !userHasFunctionalScope(req.user)) {
    body.region_id = req.user.region_id;
  }
  const norm = normalizeScheduleScope(body, req.user);
  if (norm.error) return res.status(400).json({ error: norm.error });
  res.json({
    count: countTargets(body),
    sample: expandTargets(body).slice(0, 10).map((x) => x.name),
    scope_summary: scopeSummary(body),
    scope_filter: storedFilter(body),
  });
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
  if (!normalizeBatchSize(body)) return res.status(400).json({ error: 'batch_size must be a non-negative integer' });
  if (body.frequency === 'CUSTOM') {
    try { body.frequency_config = JSON.stringify(recurrence.parseRule(body.frequency_config)); }
    catch (e) { return res.status(400).json({ error: e.message }); }
  }
  // Region fallback first so a REGION-scoped user can omit region_id; then pin the
  // single target that matches scope_type.
  if (!body.region_id && !isGlobal(req.user)) body.region_id = req.user.region_id;
  const scope = normalizeScheduleScope(body, req.user);
  if (scope.error) return res.status(400).json({ error: scope.error });
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
  if (!normalizeBatchSize(req.body)) return res.status(400).json({ error: 'batch_size must be a non-negative integer' });
  const effectiveFrequency = req.body.frequency !== undefined ? req.body.frequency : s.frequency;
  if (effectiveFrequency === 'CUSTOM' && (req.body.frequency !== undefined || req.body.frequency_config !== undefined)) {
    try { req.body.frequency_config = JSON.stringify(recurrence.parseRule(req.body.frequency_config)); }
    catch (e) { return res.status(400).json({ error: e.message }); }
  }
  // Only re-align the scope when the request actually touches it, so a partial
  // update (e.g. pause/resume) never rewrites or rejects the existing target.
  let canonical = null;
  const touchesScope = ['scope_type', 'scope_filter', ...SCOPE_FIELDS].some((k) => req.body[k] !== undefined);
  if (touchesScope) {
    canonical = { ...s, ...req.body };
    if (!canonical.region_id && !isGlobal(req.user)) canonical.region_id = req.user.region_id;
    const norm = normalizeScheduleScope(canonical, req.user);
    if (norm.error) return res.status(400).json({ error: norm.error });
    if (!canonical.region_id) canonical.region_id = targetRegion(canonical, null) ?? null;
  }
  const patch = { ...req.body };
  if (canonical) delete patch.scope_filter;
  updateRow('maintenance_schedule', Number(req.params.id), patch, [], 'revision');
  if (canonical) {
    // updateRow skips nulls, so write the canonical target set explicitly to clear
    // fields that no longer apply to the scope.
    db.prepare(
      `UPDATE maintenance_schedule
          SET scope_type = ?, asset_type = ?, asset_id = ?, substation_id = ?, line_id = ?, tower_id = ?, region_id = ?, scope_filter = ?
        WHERE id = ?`
    ).run(canonical.scope_type, canonical.asset_type, canonical.asset_id, canonical.substation_id, canonical.line_id, canonical.tower_id, canonical.region_id, canonical.scope_filter, s.id);
  }
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
  const { remaining } = remainingTargets(s);
  let rule = null;
  try { rule = recurrence.ruleFromSchedule(s); } catch { rule = null; }
  res.json({
    schedule: s,
    target_count: countTargets(s),
    remaining: remaining.length,
    batch_size: s.batch_size != null ? Number(s.batch_size) : null,
    targets: remaining.slice(0, 200).map((x) => ({ id: x.id, name: x.name || x.tower_id || x.substation_id || x.line_id || x.asset_id, type: s.scope_type })),
    next_due_date: s.next_due_date,
    next_occurrences: rule ? recurrence.preview(s.next_due_date, rule, 5) : [],
  });
});

// Run generation for all due schedules (or a specific one)
router.post('/schedules/run', (req, res) => {
  if (!can(req, 'schedule:run')) return res.status(403).json({ error: 'Forbidden: requires schedule:run' });
  const onlyId = req.body.schedule_id ? Number(req.body.schedule_id) : null;
  const scope = commandScope(req.user);
  const results = { generated: 0, skipped_duplicate: 0, not_due: 0, no_targets: 0, tasks: [], errors: [] };
  let schedules = list('maintenance_schedule').filter((s) => s.is_active === 1);
  if (!scope.global) schedules = schedules.filter((s) => scope.scheduleIds.has(s.id));
  if (onlyId) {
    // A run explicitly targeting one schedule must never silently do nothing:
    // surface why it was skipped (out of authority vs paused) instead of a bare
    // empty result.
    const target = get('maintenance_schedule', onlyId);
    if (target) {
      if (!scope.global && !scope.scheduleIds.has(target.id)) {
        results.errors.push({ schedule_id: onlyId, error: 'schedule is outside your authority' });
      } else if (target.is_active !== 1) {
        results.errors.push({ schedule_id: onlyId, error: 'schedule is not active' });
      }
    }
    schedules = schedules.filter((s) => s.id === onlyId);
  }
  const now = new Date().toISOString();
  const nowMs = Date.now();

  for (const s of schedules) {
    try {
      // Lead-time generation: a schedule can materialise its next task batch up
      // to `lead_time_days` before the due date so crews get advance notice.
      const dueMs = s.next_due_date ? new Date(s.next_due_date).getTime() : NaN;
      const leadMs = Math.max(0, Number(s.lead_time_days) || 0) * 86400000;
      if (Number.isNaN(dueMs) || dueMs - leadMs > nowMs) { results.not_due++; continue; }
      if (s.responsible_crew_id && !canAssignCrew(req.user, s.responsible_crew_id)) {
        results.errors.push({ schedule_id: s.id, error: 'responsible crew is outside your authority' });
        continue;
      }
      // Requirements are the same for every target of this schedule, so resolve
      // them once and let auto-assignment pick the best eligible crew below.
      const taskType = resolveTaskType(s);
      const reqs = s.checklist_template_id
        ? taskRequirements({ checklist_template_id: s.checklist_template_id, is_energized_work: s.is_energized_work, permit_required: s.permit_required })
        : null;
      const neededCerts = reqs
        ? reqs.required_certs
        : taskType === 'PREVENTIVE' ? ['SF6_HANDLING'] : taskType === 'INSPECTION' ? [] : ['LIVE_LINE'];
      const { targets, remaining, occurrence, kind } = remainingTargets(s);
      // A scope with no register assets cannot be costed or condition-evaluated,
      // so generate nothing rather than an uncostable placeholder.
      if (!targets.length) { results.no_targets++; continue; }
      // Everything for this occurrence is already generated: complete the sweep.
      if (!remaining.length) { advanceSweep(s, now); results.skipped_duplicate++; continue; }
      // Backlog guard: never start a fresh sweep while a prior occurrence's tasks
      // are still open. Resuming a partially generated sweep is always allowed.
      if (remaining.length === targets.length && sweepBacklog(s, occurrence) > 0) {
        results.skipped_duplicate++;
        continue;
      }
      const cap = Number(s.batch_size) > 0 ? Number(s.batch_size) : Infinity;
      const batch = remaining.slice(0, cap);
      for (const target of batch) {
        try {
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
          // A target anchors to exactly one row: a register asset, a tower, a
          // line, or a substation. Asset and tower targets keep their parent
          // refs; line and substation targets use their own row id.
          const isAsset = kind === 'asset';
          const isTower = kind === 'tower';
          const isLine = kind === 'line';
          const isSubstation = kind === 'substation';
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
            substation_id: isSubstation ? target.id : (target.substation_id != null ? target.substation_id : null),
            line_id: isLine ? target.id : (target.line_id != null ? target.line_id : null),
            tower_id: isTower ? target.id : null,
            asset_id: isAsset ? target.id : null,
            checklist_template_id: s.checklist_template_id,
            crew_id: crewId,
            due_date: s.next_due_date,
            source: 'SCHEDULE_GENERATED',
            schedule_id: s.id,
            schedule_occurrence: occurrence,
            created_by: req.user.person_id || null,
            assigned_by: crewId ? (req.user.person_id || null) : null,
            created_at: now,
            updated_at: now,
            revision: 1,
          };
          const tid = insertRow('task', t);
          // Mirror the schedule's template into the task's checklist join table so
          // generated tasks carry the same authoritative selection as manual ones.
          if (s.checklist_template_id) {
            db.prepare('INSERT OR IGNORE INTO task_checklist_template (task_id, template_id, sequence) VALUES (?,?,0)').run(tid, s.checklist_template_id);
          }
          results.generated++;
          results.tasks.push(get('task', tid));
        } catch (e) {
          // One bad target must not abort the rest of the sweep.
          results.errors.push({ schedule_id: s.id, error: e.message });
        }
      }
      // Only advance the occurrence once every target of this sweep exists.
      // Re-read coverage rather than trusting batch length: a target can be
      // skipped mid-loop (crew outside authority), leaving the sweep incomplete.
      if (remainingTargets(s).remaining.length === 0) advanceSweep(s, now);
    } catch (e) {
      results.errors.push({ schedule_id: s.id, error: e.message });
    }
  }
  res.json(results);
});

module.exports = router;
