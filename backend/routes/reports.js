const express = require('express');
const { db, list, get, insertRow, nextCode } = require('../util');
const { can, isGlobal, audit } = require('../auth');
const { taskVisible, canViewCrew, commandScope } = require('../authority');
const { listForTask } = require('./attachments');
const { taskProgress } = require('../taskProgress');
const { computeRegionValuation, mergeValuations } = require('./register');
const { maintenanceCostForRegions, currencyCode, assetRegion } = require('../maintenanceCost');
const { deriveCrewStatus } = require('../crewStatus');
const { taskReadiness, crewReadiness, personPerformanceRows, crewRosterPersonIds } = require('../readiness');
const { targetHeadline, resolveTarget } = require('../target');
const { sendMail } = require('../mail');
const { buildAnalytics } = require('../analytics');
const { recentRevaluationData, revalueAssets, changesToData, monitorSummary } = require('../assetMonitor');

function moneyStr(v, code) {
  try {
    return new Intl.NumberFormat('en-US', { style: 'currency', currency: code, maximumFractionDigits: 0 }).format(v);
  } catch (_) {
    return `${code} ${Number(v).toLocaleString('en-US')}`;
  }
}

const router = express.Router();

function personLabel(id) {
  if (!id) return null;
  const p = db.prepare('SELECT first_name, last_name FROM person WHERE id = ?').get(id);
  return p ? [p.first_name, p.last_name].filter(Boolean).join(' ').trim() || null : null;
}

const OPEN_STATES = ['DRAFT', 'SCHEDULED', 'ASSIGNED', 'IN_PROGRESS', 'ON_HOLD', 'PENDING_VERIFICATION'];

// Drill-down documents: each maps to the compute() parameter that selects the
// entity. Used by the read-only /reports/document endpoint so a report reader
// can click a row to inspect the underlying asset/task/crew/line.
const DOCUMENT_ID_FIELDS = {
  ASSET_DETAIL: 'asset_id',
  CREW_DETAIL: 'crew_id',
  TASK_DETAIL: 'task_id',
  LINE_DETAIL: 'line_id',
  PERSON_DETAIL: 'person_id',
};

function classifyTask(t, now) {
  const isDone = ['COMPLETED', 'CANCELLED', 'FAILED'].includes(t.status) || (t.actual_end && t.actual_end <= now);
  return isDone ? 'past' : 'future';
}

function findingsForTask(taskId) {
  return db.prepare(
    `SELECT tf.id, tf.task_id, tf.execution_id, tf.crew_id, tf.created_by, tf.title, tf.detail,
            tf.severity, tf.lat, tf.lng, tf.captured_at, tf.revision,
            p.first_name || ' ' || p.last_name AS created_by_name
     FROM task_finding tf LEFT JOIN person p ON p.id = tf.created_by
     WHERE tf.task_id = ? ORDER BY tf.captured_at DESC`
  ).all(taskId);
}

function findingCountsForTaskIds(taskIds) {
  const out = {};
  if (!taskIds.length) return out;
  const rows = db.prepare(
    `SELECT task_id, COUNT(*) c FROM task_finding WHERE task_id IN (${taskIds.map(() => '?').join(',')}) GROUP BY task_id`
  ).all(...taskIds);
  for (const r of rows) out[r.task_id] = r.c;
  return out;
}

function taskExecutions(taskId) {
  return checklistsWithItems(
    db.prepare(
      `SELECT e.*, t.task_number FROM checklist_execution e LEFT JOIN task t ON t.id = e.task_id WHERE e.task_id = ? ORDER BY e.submitted_at DESC`
    ).all(taskId)
  );
}

function periodFilter(rows, start, end) {
  return rows.filter((r) => (!start || r.created_at >= new Date(start).toISOString()) && (!end || r.created_at <= new Date(end).toISOString()));
}

// Restrict every data source to the user's command scope (global roles see
// everything; managers see the crews/work of their chain of command; region
// roles degrade to their region).
function scopeTasks(user, scope, tasks) {
  return scope.global ? tasks : tasks.filter((t) => scope.taskIds.has(t.id));
}
function scopeAssets(user, scope, assets) {
  return scope.global ? assets : assets.filter((a) => scope.assetIds.has(a.id));
}
function scopeCrews(user, scope, crews) {
  return scope.global ? crews : crews.filter((c) => scope.crewIds.has(c.id));
}
function scopeExecutions(user, scope, executions) {
  return scope.global ? executions : executions.filter((e) => e.task_id && scope.taskIds.has(e.task_id));
}
function scopeGps(user, scope, rows) {
  return scope.global ? rows : rows.filter((v) => scope.validationIds.has(v.id));
}
function scopeSchedules(user, scope, rows) {
  return scope.global ? rows : rows.filter((s) => scope.scheduleIds.has(s.id));
}

// A person is readable when they are the caller, sit on a crew the caller can
// see, or are attached to the caller's region. Mirrors GET /people scoping.
function personVisible(user, scope, personId) {
  if (scope.global) return true;
  if (user.person_id && Number(user.person_id) === Number(personId)) return true;
  const crewIds = db.prepare('SELECT crew_id FROM crew_member WHERE person_id = ? AND active = 1').all(personId)
    .map((m) => m.crew_id)
    .concat(db.prepare('SELECT id AS crew_id FROM crew WHERE leader_person_id = ?').all(personId).map((c) => c.crew_id));
  if (crewIds.some((id) => scope.crewIds.has(id))) return true;
  return db.prepare('SELECT 1 FROM region_personnel WHERE person_id = ? AND region_id = ? LIMIT 1')
    .get(personId, user.region_id) != null;
}

// Attach the articulated checklist responses (items) recorded during each
// execution so a document reader can understand the observed condition from the
// tasks done, instead of only seeing an aggregate PASS/FAIL result.
function checklistsWithItems(executions) {
  return executions.map((e) => {
    const items = db.prepare('SELECT * FROM checklist_execution_item WHERE execution_id = ? ORDER BY sequence, id').all(e.id);
    const tpl = e.template_id ? get('checklist_template', e.template_id) : null;
    return {
      ...e,
      template_name: tpl ? tpl.name : null,
      items,
      item_count: items.length,
      pass_count: items.filter((i) => i.result === 'PASS').length,
      fail_count: items.filter((i) => i.result === 'FAIL').length,
    };
  });
}

// Attach a normalised analytics + expert-evaluation block to every report so
// charts, KPI tiles and the graded narrative are available to the viewer,
// exports and shared/printed copies alike.
function compute(reportType, params, user) {
  const data = computeRaw(reportType, params, user);
  try {
    const analytics = buildAnalytics(reportType, data);
    if (analytics) data.analytics = analytics;
  } catch (_) {
    // Analytics is best-effort: a report still renders if a rule throws.
  }
  return data;
}

function computeRaw(reportType, params, user) {
  const start = params.period_start || null;
  const end = params.period_end || null;
  const scope = commandScope(user);
  const tasks = scopeTasks(user, scope, list('task'));
  const scoped = periodFilter(tasks, start, end);
  const regionId = params.scope_region_id ? Number(params.scope_region_id) : null;
  const inRegion = (t) => !regionId || t.region_id === regionId;
  // Scope a single entity document to the report's region when one is set
  // (region roles always have one); global users may leave it open.
  const effectiveScope = () => (isGlobal(user) && !regionId ? null : regionId || user.region_id);
  const outOfScope = (rid) => {
    const scope = effectiveScope();
    return scope != null && rid !== scope;
  };
  const scopeError = (title) => ({ title, rows: [{ label: 'Error', value: 'Entity is outside the report region scope' }] });
  const open = ['DRAFT', 'SCHEDULED', 'ASSIGNED', 'IN_PROGRESS', 'ON_HOLD', 'PENDING_VERIFICATION'];
  const myRegions = () => (isGlobal(user) ? list('region') : list('region').filter((r) => r.id === user.region_id));
  const reportRegionIds = () => {
    const rid = params.scope_region_id ? Number(params.scope_region_id) : null;
    if (rid) return [rid];
    return scope.global
      ? db.prepare('SELECT id FROM region ORDER BY code').all().map((r) => r.id)
      : [...scope.regionIds];
  };

  switch (reportType) {
    case 'MAINTENANCE_COMPLETION': {
      const s = scoped.filter(inRegion);
      const completed = s.filter((t) => t.status === 'COMPLETED');
      const cancelled = s.filter((t) => t.status === 'CANCELLED');
      const failed = s.filter((t) => t.status === 'FAILED');
      const total = s.length;
      const done = completed.length;
      const rate = total ? Math.round((done / total) * 100) : 0;
      const onTime = completed.filter((t) => t.actual_end && t.actual_end <= t.due_date).length;
      const rows = [
        { label: 'Total tasks', value: total },
        { label: 'Completed', value: done },
        { label: 'Cancelled', value: cancelled.length },
        { label: 'Failed', value: failed.length },
        { label: 'Completion rate', value: `${rate}%` },
        { label: 'On-time rate', value: completed.length ? `${Math.round((onTime / completed.length) * 100)}%` : 'N/A' },
      ];
      return { title: 'Maintenance Completion Summary', rows, by_status: statusBreakdown(s) };
    }
    case 'ASSET_CONDITION': {
      const allAssets = list('asset').filter((a) => a.lifecycle_status !== 'REMOVED');
      const assetRegion = (a) => {
        if (a.substation_id) {
          const sub = get('substation', a.substation_id);
          if (sub) return sub.region_id;
        }
        if (a.line_id) {
          const l = get('transmission_line', a.line_id);
          if (l) return l.region_id;
        }
        if (a.tower_id) {
          const tw = get('tower', a.tower_id);
          if (tw) {
            const l = get('transmission_line', tw.line_id);
            if (l) return l.region_id;
          }
        }
        return null;
      };
      const assets = scopeAssets(user, scope, allAssets);
      const buckets = [
        { key: 'critical', label: 'Critical (1-3)', min: 1, max: 3, count: 0 },
        { key: 'poor', label: 'Poor (4-5)', min: 4, max: 5, count: 0 },
        { key: 'fair', label: 'Fair (6-7)', min: 6, max: 7, count: 0 },
        { key: 'good', label: 'Good (8-10)', min: 8, max: 10, count: 0 },
      ];
      for (const a of assets) {
        const b = buckets.find((x) => a.condition_rating >= x.min && a.condition_rating <= x.max);
        if (b) b.count++;
      }
      const byRegion = myRegions().map((r) => {
        const a = assets.filter((x) => assetRegion(x) === r.id);
        return { region: r.name, count: a.length, avg_condition: a.length ? Math.round((a.reduce((s, x) => s + x.condition_rating, 0) / a.length) * 10) / 10 : 0 };
      }).filter((x) => x.count > 0);
      return { title: 'Asset Condition Report', buckets, by_region: byRegion, total_assets: assets.length };
    }
    case 'CREW_UTILIZATION': {
      const crews = scopeCrews(user, scope, list('crew'));
      const estHours = (t) => {
        const c = t.checklist_template_id ? get('checklist_template', t.checklist_template_id) : null;
        if (c && Number(c.estimated_minutes)) return Number(c.estimated_minutes) / 60;
        if (t.scheduled_start && t.scheduled_end) {
          const h = (new Date(t.scheduled_end) - new Date(t.scheduled_start)) / 3600000;
          if (h > 0 && h < 200) return Math.round(h * 10) / 10;
        }
        return 4;
      };
      const detail = crews.map((c) => {
        const assigned = db.prepare('SELECT * FROM task WHERE crew_id = ?').all(c.id);
        const completed = assigned.filter((t) => t.status === 'COMPLETED');
        const available = 40 * 4; // weeks*40h model
        const estLaborHours = assigned.reduce((s, t) => s + estHours(t), 0);
        const usedHours = completed.reduce((s, t) => s + estHours(t), 0);
        return {
          crew_id: c.id,
          name: c.name,
          code: c.crew_code,
          assigned_tasks: assigned.length,
          completed_tasks: completed.length,
          est_labor_hours: Math.round(estLaborHours * 10) / 10,
          used_hours: Math.round(usedHours * 10) / 10,
          utilization: available ? Math.round((usedHours / available) * 100) : 0,
        };
      });
      return { title: 'Crew Utilization Report', rows: detail };
    }
    case 'CREW_READINESS': {
      const crews = scopeCrews(user, scope, list('crew')).filter((c) => !regionId || c.region_id === regionId);
      const rows = crews.map((c) => {
        const r = crewReadiness(c);
        const p = r.performance || {};
        return {
          crew_id: c.id, crew: c.name, code: c.crew_code, crew_type: c.crew_type,
          members: r.crew.member_count,
          valid_certs: r.cert_status.valid, expired_certs: r.cert_status.expired,
          open_tasks: r.open_tasks.length, at_risk_tasks: r.at_risk_tasks,
          completion_rate: p.completion_rate ?? 0, on_time_rate: p.on_time_rate ?? 0, findings: p.findings ?? 0,
        };
      }).sort((a, b) => b.at_risk_tasks - a.at_risk_tasks || a.crew.localeCompare(b.crew));
      return { title: 'Crew Readiness Report', rows };
    }
    case 'PERSON_PERFORMANCE': {
      const perfCrews = scopeCrews(user, scope, list('crew')).filter((c) => !regionId || c.region_id === regionId);
      const perfTasks = scoped.filter((t) => !regionId || t.region_id === regionId);
      const rows = personPerformanceRows(perfTasks, crewRosterPersonIds(perfCrews)).map((r) => ({
        person: r.name, tasks: r.tasks, completed: r.completed, completion_rate: r.completion_rate,
        on_time: r.on_time, on_time_rate: r.on_time_rate, findings: r.findings, gps_violations: r.gps_violations,
      }));
      return { title: 'Person Performance Report', rows };
    }
    case 'OUTAGE_INCIDENT': {
      const inc = scoped.filter(inRegion).filter((t) => ['EMERGENCY', 'CORRECTIVE'].includes(t.task_type));
      const outSubs = list('substation').filter((s) => (scope.global || scope.substationIds.has(s.id)) && ['MAINTENANCE', 'OUT_OF_SERVICE'].includes(s.operational_status));
      const outLines = list('transmission_line').filter((l) => (scope.global || scope.lineIds.has(l.id)) && ['UNDER_MAINTENANCE', 'DE_ENERGIZED'].includes(l.operational_status));
      return {
        title: 'Outage / Incident Report',
        incidents: inc,
        substations_out: outSubs,
        lines_out: outLines,
        totals: { incidents: inc.length, substations_out: outSubs.length, lines_out: outLines.length },
      };
    }
    case 'COMPLIANCE_AUDIT': {
      const executions = scopeExecutions(user, scope, list('checklist_execution'));
      const execRows = executions.map((e) => {
        const items = db.prepare('SELECT * FROM checklist_execution_item WHERE execution_id = ?').all(e.id);
        const pass = items.filter((i) => i.result === 'PASS').length;
        return { execution: e, total: items.length, pass, fail: items.filter((i) => i.result === 'FAIL').length };
      });
      const totalItems = execRows.reduce((s, x) => s + x.total, 0);
      const passedItems = execRows.reduce((s, x) => s + x.pass, 0);
      const validations = scopeGps(user, scope, list('gps_validation'));
      const failedValidations = validations.filter((v) => v.result === 'FAIL').length;
      let regionCerts;
      if (scope.global) {
        regionCerts = myRegions().map((r) => {
          const people = db.prepare('SELECT person_id FROM region_personnel WHERE region_id = ?').all(r.id).map((x) => x.person_id);
          const crewPeople = db.prepare(
            'SELECT p.id FROM crew c JOIN crew_member m ON m.crew_id = c.id JOIN person p ON p.id = m.person_id WHERE c.region_id = ? AND m.active = 1'
          ).all(r.id).map((x) => x.id);
          const ids = new Set([...people, ...crewPeople]);
          const certsIn = list('certification').filter((c) => ids.has(c.person_id));
          return { region: r.name, total: certsIn.length, expired: certsIn.filter((c) => c.status === 'EXPIRED').length };
        });
      } else {
        const certsIn = list('certification').filter((c) => scope.memberIds.has(c.person_id));
        regionCerts = [{
          region: get('region', user.region_id)?.name || '—',
          total: certsIn.length,
          expired: certsIn.filter((c) => c.status === 'EXPIRED').length,
        }];
      }
      // Missed certifications: expired already, or expiring within the next 90
      // days. The stored `status` can be stale, so validity is decided from the
      // expiry date (matching dispatch.certIsValid) rather than trusting status.
      const nowMs = Date.now();
      const certHorizonMs = nowMs + 90 * 864e5;
      const personInReportRegion = (personId) => {
        if (scope.global && !regionId) return true;
        if (!scope.global) return scope.memberIds.has(personId);
        return db.prepare('SELECT 1 FROM region_personnel WHERE person_id = ? AND region_id = ? LIMIT 1').get(personId, regionId) != null
          || db.prepare(
            'SELECT 1 FROM crew c JOIN crew_member m ON m.crew_id = c.id WHERE m.person_id = ? AND c.region_id = ? LIMIT 1'
          ).get(personId, regionId) != null;
      };
      const missed_certifications = list('certification')
        .filter((c) => c.person_id && personInReportRegion(c.person_id))
        .map((c) => ({ ...c, expires_ms: c.expires_at ? new Date(c.expires_at).getTime() : null }))
        .filter((c) => c.expires_ms != null && c.expires_ms <= certHorizonMs)
        .sort((a, b) => a.expires_ms - b.expires_ms)
        .map((c) => ({
          id: c.id,
          person_id: c.person_id,
          person_name: personLabel(c.person_id),
          cert_type: c.cert_type,
          issuing_body: c.issuing_body || null,
          expires_at: c.expires_at,
          status: c.expires_ms < nowMs ? 'EXPIRED' : 'EXPIRING',
          days: Math.round((c.expires_ms - nowMs) / 864e5),
        }));

      // Missed equipment is split two ways: an asset is *overdue* only when it
      // carries a maintenance date that has passed, while an in-service asset
      // with no date at all is a scheduling gap, not a missed deadline. Lumping
      // the ~12k undated assets in with genuine overdues drowned the signal, so
      // they are counted and reported separately.
      const regionOk = (a) => {
        if (!regionId) return true;
        return assetRegion(a) === regionId;
      };
      const inService = (a) => !['RETIRED', 'DECOMMISSIONED', 'DISPOSED'].includes(String(a.lifecycle_status || '').toUpperCase());
      const scopedAssets = scopeAssets(user, scope, list('asset')).filter(inService).filter(regionOk);
      const isOverdueDate = (v) => v && new Date(v).getTime() < nowMs;
      const assetOverdue = scopedAssets.filter((a) => isOverdueDate(a.next_maintenance_at));
      const assetNoDate = scopedAssets.filter((a) => !a.next_maintenance_at);
      const schedulesOverdue = scopeSchedules(user, scope, list('maintenance_schedule'))
        .filter((s) => s.is_active && (!regionId || s.region_id === regionId))
        .filter((s) => isOverdueDate(s.next_due_date));
      const missed_equipment_all = []
        .concat(assetOverdue.map((a) => ({
          kind: 'ASSET',
          id: a.id,
          asset_pk: a.id,
          label: a.name || a.asset_id,
          asset_type: a.asset_type || null,
          due: a.next_maintenance_at || null,
          detail: 'Maintenance overdue',
        })))
        .concat(schedulesOverdue.map((s) => ({
          kind: 'SCHEDULE',
          id: s.id,
          label: s.schedule_name,
          asset_type: s.asset_type || s.scope_type || null,
          due: s.next_due_date,
          detail: `Schedule overdue (${s.frequency})`,
        })))
        .sort((a, b) => new Date(a.due || 0) - new Date(b.due || 0));
      // Undated assets are deliberately excluded: they are a schedule gap, not a
      // passed due date, and there can be tens of thousands of them — listing
      // them by the hundred buried the genuine overdues. They are surfaced via
      // the missed_equipment_no_date KPI and its dedicated finding instead.
      const missed_equipment = missed_equipment_all.slice(0, 100);

      return {
        title: 'Compliance / Audit Report',
        checklist_compliance: totalItems ? `${Math.round((passedItems / totalItems) * 100)}%` : 'N/A',
        gps_pass_rate: validations.length ? `${Math.round(((validations.length - failedValidations) / validations.length) * 100)}%` : 'N/A',
        expired_certs: regionCerts.reduce((s, r) => s + r.expired, 0),
        total_certs: regionCerts.reduce((s, r) => s + r.total, 0),
        region_cert_status: regionCerts,
        execution_summary: execRows,
        missed_certifications,
        missed_equipment,
        missed_equipment_total: assetOverdue.length + schedulesOverdue.length,
        missed_equipment_no_date: assetNoDate.length,
        missed_equipment_by_kind: {
          assets: assetOverdue.length,
          schedules: schedulesOverdue.length,
        },
      };
    }
    case 'OVERDUE_TASK': {
      const now = new Date();
      const overdue = scoped.filter(inRegion).filter((t) => open.includes(t.status) && new Date(t.due_date) < now);
      const bucket = (min, max) => overdue.filter((t) => {
        const d = (now - new Date(t.due_date)) / (24 * 3600 * 1000);
        return d >= (min || 0) && d < (max || Infinity);
      }).length;
      const byStatus = statusBreakdown(scoped.filter(inRegion));
      return {
        title: 'Overdue Task Report',
        buckets: [
          { label: '0-7 days', count: bucket(0, 8) },
          { label: '8-30 days', count: bucket(8, 31) },
          { label: '31-90 days', count: bucket(31, 91) },
          { label: '>90 days', count: bucket(91) },
        ],
        total_overdue: overdue.length,
        by_status: byStatus,
        overdue_tasks: overdue.map((t) => ({ ...t, region: get('region', t.region_id) })),
      };
    }
    case 'SCHEDULE_ADHERENCE': {
      const schedules = scopeSchedules(user, scope, list('maintenance_schedule'));
      const rows = schedules.map((s) => {
        const gen = db.prepare('SELECT * FROM task WHERE schedule_id = ?').all(s.id);
        const openCount = gen.filter((t) => open.includes(t.status)).length;
        const lag = s.last_generated_at ? Math.round((new Date() - new Date(s.last_generated_at)) / (24 * 3600 * 1000)) : 0;
        return { name: s.schedule_name, code: s.schedule_code, frequency: s.frequency, next_due: s.next_due_date, generated: gen.length, open: openCount, is_active: s.is_active };
      });
      return { title: 'Schedule Adherence Report', rows };
    }
    case 'GPS_COVERAGE': {
      const gps = scopeGps(user, scope, list('gps_validation'));
      const byType = {};
      for (const v of gps) {
        byType[v.target_type] = byType[v.target_type] || { total: 0, pass: 0, fail: 0 };
        byType[v.target_type].total++;
        if (v.result === 'PASS') byType[v.target_type].pass++;
        else byType[v.target_type].fail++;
      }
      return {
        title: 'GPS Validation Coverage',
        by_type: Object.entries(byType).map(([k, v]) => ({ target_type: k, ...v, rate: v.total ? `${Math.round((v.pass / v.total) * 100)}%` : 'N/A' })),
        total: gps.length,
      };
    }
    case 'ASSET_DETAIL': {
      const a = get('asset', Number(params.asset_id), ['metadata']);
      if (!a) return { title: 'Asset Detail Profile', rows: [{ label: 'Error', value: 'Asset not found' }] };
      const hi = a.health_index ?? (a.condition_rating ? Math.max(1, Math.min(100, Math.round(a.condition_rating * 10))) : null);
      const rul = a.remaining_useful_life_years ?? (a.condition_rating ? Math.round((a.condition_rating / 10) * 40 * 10) / 10 : null);
      const aEnriched = { ...a, health_index: hi, remaining_useful_life_years: rul };
      const sub = a.substation_id ? get('substation', a.substation_id) : null;
      const line = a.line_id ? get('transmission_line', a.line_id, ['route_json']) : null;
      const tower = a.tower_id ? get('tower', a.tower_id) : null;
      const aRegion = sub ? sub.region_id : line ? line.region_id : tower ? (get('transmission_line', tower.line_id)?.region_id ?? null) : null;
      if (!scope.global && !scope.assetIds.has(a.id)) return scopeError('Asset Detail Profile');
      if (scope.global && outOfScope(aRegion)) return scopeError('Asset Detail Profile');
      // Carry the crew name so the printed maintenance history names the crew
      // instead of leaking a raw foreign-key id onto the page.
      const history = db.prepare(
        `SELECT m.*, c.name AS crew_name, c.crew_code AS crew_code
           FROM asset_maintenance_event m LEFT JOIN crew c ON c.id = m.crew_id
          WHERE m.asset_id = ? ORDER BY m.performed_at DESC`
      ).all(a.id);
      const executions = checklistsWithItems(
        db.prepare(
          `SELECT e.*, t.task_number FROM checklist_execution e LEFT JOIN task t ON t.id = e.task_id WHERE e.asset_id = ? ORDER BY e.submitted_at DESC`
        ).all(a.id)
      );
      const gps = db.prepare('SELECT * FROM gps_validation WHERE target_type = ? AND target_id = ? ORDER BY validated_at DESC').all('ASSET', a.id);
      const tasks = db.prepare('SELECT * FROM task WHERE asset_id = ? ORDER BY due_date').all(a.id);
      let components = [];
      if (tower) components = db.prepare('SELECT * FROM tower_component WHERE tower_id = ? ORDER BY component_type, name').all(tower.id);
      const now = new Date().toISOString();
      const gps_violations = gps.filter((v) => v.result === 'FAIL' || v.result === 'MANUAL_REVIEW');
      const findingCounts = findingCountsForTaskIds(tasks.map((t) => t.id));
      const enrichedTasks = tasks.map((t) => ({
        ...t,
        findings_count: findingCounts[t.id] || 0,
        crew: t.crew_id ? get('crew', t.crew_id) : null,
      }));
      const openNow = enrichedTasks.filter((t) => OPEN_STATES.includes(t.status));
      const tasks_past = enrichedTasks.filter((t) => classifyTask(t, now) === 'past');
      const tasks_future = enrichedTasks.filter((t) => classifyTask(t, now) === 'future');
      const rows = [
        { label: 'Asset ID', value: a.asset_id },
        { label: 'Type', value: `${a.asset_type}${a.sub_type ? ` (${a.sub_type})` : ''}` },
        { label: 'Location', value: sub ? sub.name : line ? line.name : tower ? `Tower ${tower.tower_id}` : 'Standalone' },
        { label: 'Place / Bay', value: `${a.location_type || 'OUTDOOR'}${a.bay ? ` · ${a.bay}` : ''}` },
        { label: 'Position', value: a.latitude != null ? `${a.latitude.toFixed(5)}, ${a.longitude.toFixed(5)}` : '—' },
        { label: 'Manufacturer / Model', value: `${a.manufacturer || '—'} / ${a.model || '—'}` },
        { label: 'Serial', value: a.serial_number || '—' },
        { label: 'Condition', value: `${a.condition_rating}/10` },
        { label: 'Health / RUL', value: `${hi}% / ${rul} yr` },
        { label: 'Criticality', value: a.criticality },
        { label: 'Lifecycle', value: a.lifecycle_status },
        { label: 'Operational status', value: a.operational_status },
        { label: 'Installed', value: a.installation_date || '—' },
        { label: 'Last maintenance', value: a.last_maintenance_at || '—' },
        { label: 'GPS validated', value: a.gps_validated ? 'Yes' : 'No' },
      ];
      const document = {
        entity: 'ASSET',
        entity_name: a.name || a.asset_id,
        asset: aEnriched,
        substation: sub,
        line,
        tower,
        history,
        executions,
        gps,
        gps_violations,
        tasks: enrichedTasks,
        tasks_past,
        tasks_future,
        open_tasks: openNow,
        components,
        totals: {
          executions: executions.length,
          open_tasks: openNow.length,
          completed_tasks: tasks_past.filter((t) => t.status === 'COMPLETED').length,
          gps_violations: gps_violations.length,
          findings: tasks.reduce((s, t) => s + (findingCounts[t.id] || 0), 0),
        },
      };
      for (const key of ['tasks', 'tasks_past', 'tasks_future']) {
        if (Array.isArray(document[key])) {
          document[key] = document[key].map((t) => ({ ...t, ...taskProgress(t.id) }));
        }
      }
      return { title: `Asset Detail Profile — ${a.name || a.asset_id}`, rows, document };
    }
    case 'TASK_DETAIL': {
      const t = get('task', Number(params.task_id));
      if (!t) return { title: 'Task Detail Profile', rows: [{ label: 'Error', value: 'Task not found' }] };
      if (!taskVisible(user, t)) return scopeError('Task Detail Profile');
      const crew = t.crew_id ? get('crew', t.crew_id) : null;
      const region = t.region_id ? get('region', t.region_id) : null;
      const resolved = resolveTarget({ task: t });
      const sub = resolved.substation;
      const line = resolved.line;
      const tower = resolved.tower;
      const asset = resolved.asset;
      const tpl = t.checklist_template_id ? get('checklist_template', t.checklist_template_id) : null;
      const executions = taskExecutions(t.id);
      const findings = findingsForTask(t.id);
      const attachments = listForTask(t.id);
      const gps_validations = db.prepare('SELECT * FROM gps_validation WHERE linked_task_id = ? ORDER BY validated_at DESC').all(t.id);
      const lineFrom = line && line.from_substation ? line.from_substation : null;
      const lineTo = line && line.to_substation ? line.to_substation : null;
      const executorRow = executions.find((e) => e.executed_by) || null;
      const executedBy = executorRow && executorRow.executed_by ? get('person', executorRow.executed_by) : null;
      const target = sub
        ? `Substation ${sub.name}${sub.substation_id ? ` (${sub.substation_id})` : ''}`
        : line
          ? `Line ${line.name}${line.voltage_kv ? ` · ${line.voltage_kv} kV` : ''}${lineFrom && lineTo ? ` · ${lineFrom.name} → ${lineTo.name}` : ''}${tower ? ` · Tower ${tower.tower_id}` : ''}`
          : asset
            ? `Asset ${asset.asset_id} — ${asset.name}`
            : '—';
      const rows = [
        { label: 'Task', value: t.task_number },
        { label: 'Title', value: t.title },
        { label: 'Type', value: t.task_type },
        { label: 'Priority', value: t.priority },
        { label: 'Status', value: t.status },
        { label: 'Result', value: t.result || '—' },
        { label: 'Region', value: region ? region.name : '—' },
        { label: 'Crew', value: crew ? `${crew.name} (${crew.crew_code})` : '—' },
        { label: 'Target', value: target },
        { label: 'Checklist', value: tpl ? tpl.name : '—' },
        { label: 'Due', value: t.due_date ? new Date(t.due_date).toISOString().slice(0, 10) : '—' },
        { label: 'Scheduled', value: t.scheduled_start ? `${new Date(t.scheduled_start).toISOString().slice(0, 16).replace('T', ' ')} → ${t.scheduled_end ? new Date(t.scheduled_end).toISOString().slice(0, 16).replace('T', ' ') : '—'}` : '—' },
        { label: 'Actual start', value: t.actual_start ? new Date(t.actual_start).toISOString().slice(0, 16).replace('T', ' ') : '—' },
        { label: 'Actual end', value: t.actual_end ? new Date(t.actual_end).toISOString().slice(0, 16).replace('T', ' ') : '—' },
        { label: 'Created by', value: personLabel(t.created_by) || '—' },
        { label: 'Assigned by', value: personLabel(t.assigned_by) || '—' },
        { label: 'Executed by', value: personLabel(executedBy && executedBy.id) || '—' },
        { label: 'Verified by', value: personLabel(t.verified_by) || '—' },
        { label: 'Revision', value: t.revision || 1 },
      ];
      if (t.cancel_reason) {
        rows.push({ label: 'Cancellation record', value: `${t.cancel_reason} · ${personLabel(t.cancelled_by) || 'Unknown user'} · ${t.cancelled_at ? new Date(t.cancelled_at).toISOString().slice(0, 16).replace('T', ' ') : '—'}` });
      }
      const summary = {
        executions: executions.length,
        pass: executions.filter((e) => e.result === 'PASS').length,
        fail: executions.filter((e) => e.result === 'FAIL').length,
        findings: findings.length,
        attachments: attachments.length,
        gps_validations: gps_validations.length,
        gps_fail: gps_validations.filter((v) => v.result === 'FAIL' || v.result === 'MANUAL_REVIEW').length,
      };
      return {
        title: `Task Detail Profile — ${targetHeadline({ taskType: t.task_type, taskTitle: t.title, target: resolved })}`,
        rows,
        document: {
          entity: 'TASK',
          entity_name: targetHeadline({ taskType: t.task_type, taskTitle: t.title, target: resolved }),
          task: { ...t, ...taskProgress(t.id) },
          crew,
          region,
          target: { type: sub ? 'SUBSTATION' : line ? (tower ? 'TOWER' : 'LINE') : asset ? 'ASSET' : null, ...resolved },
          template: tpl,
          executions,
          findings,
          attachments,
          gps_validations,
          summary,
          workflow: {
            created_by: t.created_by ? get('person', t.created_by) : null,
            assigned_by: t.assigned_by ? get('person', t.assigned_by) : null,
            executed_by: executedBy,
            verified_by: t.verified_by ? get('person', t.verified_by) : null,
          },
          dispatch_audit: taskReadiness(t),
        },
      };
    }
    case 'LINE_DETAIL': {
      const l = get('transmission_line', Number(params.line_id), ['route_json']);
      if (!l) return { title: 'Line Detail Profile', rows: [{ label: 'Error', value: 'Line not found' }] };
      if (!scope.global && !scope.lineIds.has(l.id)) return scopeError('Line Detail Profile');
      if (scope.global && outOfScope(l.region_id)) return scopeError('Line Detail Profile');
      const region = l.region_id ? get('region', l.region_id) : null;
      const fromSub = l.from_substation_id ? get('substation', l.from_substation_id) : null;
      const toSub = l.to_substation_id ? get('substation', l.to_substation_id) : null;
      const towers = db.prepare(
        `SELECT t.*, (SELECT COUNT(*) FROM tower_component tc WHERE tc.tower_id = t.id) AS component_count
         FROM tower t WHERE t.line_id = ? ORDER BY t.tower_id`
      ).all(l.id);
      const towerIds = towers.map((t) => t.id);
      const lineAssets = towerIds.length
        ? db.prepare(`SELECT * FROM asset WHERE line_id = ? OR tower_id IN (${towerIds.map(() => '?').join(',')}) ORDER BY asset_type, asset_id`).all(l.id, ...towerIds)
        : db.prepare('SELECT * FROM asset WHERE line_id = ? ORDER BY asset_type, asset_id').all(l.id);
      const directTasks = db.prepare('SELECT * FROM task WHERE line_id = ?').all(l.id);
      const towerTasks = towerIds.length
        ? db.prepare(`SELECT * FROM task WHERE tower_id IN (${towerIds.map(() => '?').join(',')}) ORDER BY COALESCE(due_date, created_at)`).all(...towerIds)
        : [];
      const now = new Date().toISOString();
      const byId = new Map([...directTasks, ...towerTasks].map((t) => [t.id, t]));
      const allTasks = [...byId.values()].map((t) => ({
        ...t,
        tower_label: t.tower_id ? (() => { const tw = towers.find((x) => x.id === t.tower_id); return tw ? tw.tower_id : null; })() : null,
        crew: t.crew_id ? get('crew', t.crew_id) : null,
      }));
      const findingCounts = findingCountsForTaskIds(allTasks.map((t) => t.id));
      const tasks = allTasks.map((t) => ({ ...t, findings_count: findingCounts[t.id] || 0 }));
      const open = tasks.filter((t) => OPEN_STATES.includes(t.status));
      const completed = tasks.filter((t) => t.status === 'COMPLETED');
      const overdue = tasks.filter((t) => OPEN_STATES.includes(t.status) && t.due_date < now);
      const completedExecs = completed.length
        ? checklistsWithItems(
          db.prepare(
            `SELECT e.*, t.task_number FROM checklist_execution e LEFT JOIN task t ON t.id = e.task_id WHERE e.task_id IN (${completed.map(() => '?').join(',')}) ORDER BY e.submitted_at DESC`
          ).all(...completed.map((t) => t.id))
        )
        : [];
      const towerGps = towerIds.length
        ? db.prepare(`SELECT * FROM gps_validation WHERE target_type = 'TOWER' AND target_id IN (${towerIds.map(() => '?').join(',')}) ORDER BY validated_at DESC`).all(...towerIds)
        : [];
      const gpsTotal = towerGps.length;
      const gpsFail = towerGps.filter((v) => v.result === 'FAIL' || v.result === 'MANUAL_REVIEW');
      const rows = [
        { label: 'Line', value: l.name },
        { label: 'Code', value: l.line_id },
        { label: 'Region', value: region ? region.name : '—' },
        { label: 'Voltage', value: l.voltage_kv ? `${l.voltage_kv} kV` : '—' },
        { label: 'Type', value: l.line_type || '—' },
        { label: 'Length', value: l.length_km ? `${l.length_km} km` : '—' },
        { label: 'Circuits', value: l.circuit_count || '—' },
        { label: 'Conductor', value: l.conductor_type || '—' },
        { label: 'Route', value: fromSub && toSub ? `${fromSub.name} ⇄ ${toSub.name}` : '—' },
        { label: 'Towers', value: towers.length },
        { label: 'Line assets', value: lineAssets.length },
        { label: 'Operational status', value: l.operational_status || '—' },
        { label: 'GPS validated', value: l.gps_validated ? 'Yes' : 'No' },
        { label: 'Vegetation clearance', value: l.veg_clearance_m ? `${l.veg_clearance_m} m` : '—' },
      ];
      const document = {
        entity: 'LINE',
        entity_name: l.name,
        line: l,
        from_substation: fromSub,
        to_substation: toSub,
        towers,
        assets: lineAssets,
        tasks,
        tasks_past: tasks.filter((t) => classifyTask(t, now) === 'past'),
        tasks_future: tasks.filter((t) => classifyTask(t, now) === 'future'),
        open_tasks: open,
        completed_tasks: completed,
        overdue_tasks: overdue,
        executions: completedExecs,
        gps: towerGps,
        gps_violations: gpsFail,
        totals: {
          towers: towers.length,
          assets: lineAssets.length,
          tasks: tasks.length,
          open_tasks: open.length,
          completed_tasks: completed.length,
          overdue_tasks: overdue.length,
          findings: tasks.reduce((s, t) => s + (t.findings_count || 0), 0),
          gps_validations: gpsTotal,
          gps_fail: gpsFail.length,
        },
      };
      for (const key of ['tasks', 'tasks_past', 'tasks_future']) {
        if (Array.isArray(document[key])) {
          document[key] = document[key].map((t) => ({ ...t, ...taskProgress(t.id) }));
        }
      }
      return { title: `Line Detail Profile — ${l.name}`, rows, document };
    }
    case 'CREW_DETAIL': {
      const c = get('crew', Number(params.crew_id));
      if (!c) return { title: 'Crew Detail Profile', rows: [{ label: 'Error', value: 'Crew not found' }] };
      if (!canViewCrew(user, c)) return scopeError('Crew Detail Profile');
      const leader = c.leader_person_id ? get('person', c.leader_person_id) : null;
      const members = db.prepare(
        `SELECT cm.*, p.first_name, p.last_name, p.title FROM crew_member cm JOIN person p ON p.id = cm.person_id WHERE cm.crew_id = ? AND cm.active = 1 ORDER BY cm.skill_level DESC`
      ).all(c.id);
      const memberIds = [c.leader_person_id, ...members.map((m) => m.person_id)].filter(Boolean);
      const certs = memberIds.length
        ? db.prepare(
          `SELECT c.*, p.first_name, p.last_name FROM certification c
             LEFT JOIN person p ON p.id = c.person_id
            WHERE c.person_id IN (${memberIds.map(() => '?').join(',')}) ORDER BY c.expires_at`
        ).all(...memberIds)
        : [];
      const tasks = db.prepare('SELECT * FROM task WHERE crew_id = ? ORDER BY COALESCE(actual_end, due_date) DESC').all(c.id);
      const findingCounts = findingCountsForTaskIds(tasks.map((t) => t.id));
      const crewRef = { id: c.id, name: c.name, crew_code: c.crew_code };
      const enrichedTasks = tasks.map((t) => ({ ...t, findings_count: findingCounts[t.id] || 0, crew: crewRef }));
      const openTasks = enrichedTasks.filter((t) => open.includes(t.status));
      const done = enrichedTasks.filter((t) => t.status === 'COMPLETED');
      const onTime = done.filter((t) => t.actual_end && t.actual_end <= t.due_date).length;
      const execRows = tasks.length
        ? checklistsWithItems(
          db.prepare(
            `SELECT e.*, t.task_number, a.name AS asset_name, a.asset_id AS asset_code FROM checklist_execution e
             LEFT JOIN task t ON t.id = e.task_id LEFT JOIN asset a ON a.id = e.asset_id
             WHERE e.task_id IN (${tasks.map(() => '?').join(',')}) ORDER BY e.submitted_at DESC`
          ).all(...tasks.map((t) => t.id))
        )
        : [];
      const rows = [
        { label: 'Crew', value: c.name },
        { label: 'Code', value: c.crew_code },
        { label: 'Type', value: c.crew_type },
        { label: 'Region', value: get('region', c.region_id)?.name || '—' },
        { label: 'Leader', value: leader ? `${leader.first_name} ${leader.last_name}` : '—' },
        { label: 'Home base', value: c.home_base || '—' },
        { label: 'Status', value: deriveCrewStatus(c.id) },
        { label: 'Members', value: members.length },
        { label: 'Open tasks', value: openTasks.length },
        { label: 'Completed', value: done.length },
        { label: 'On-time rate', value: done.length ? `${Math.round((onTime / done.length) * 100)}%` : 'N/A' },
      ];
      const document = {
        entity: 'CREW',
        entity_name: c.name,
        crew: c,
        members,
        certs,
        tasks: enrichedTasks,
        executions: execRows,
        readiness: crewReadiness(c),
      };
      for (const key of ['tasks', 'tasks_past', 'tasks_future']) {
        if (Array.isArray(document[key])) {
          document[key] = document[key].map((t) => ({ ...t, ...taskProgress(t.id) }));
        }
      }
      return { title: `Crew Detail Profile — ${c.name}`, rows, document };
    }
    case 'PERSON_DETAIL': {
      const p = get('person', Number(params.person_id));
      if (!p) return { title: 'Person Detail Profile', rows: [{ label: 'Error', value: 'Person not found' }] };
      if (!personVisible(user, scope, p.id)) return scopeError('Person Detail Profile');
      const crews = db.prepare(
        `SELECT c.id, c.name, c.crew_code, c.crew_type, cm.role, cm.skill_level, cm.active
           FROM crew_member cm JOIN crew c ON c.id = cm.crew_id
          WHERE cm.person_id = ? ORDER BY cm.active DESC, c.name`
      ).all(p.id);
      const ledCrews = db.prepare('SELECT id, name, crew_code FROM crew WHERE leader_person_id = ?').all(p.id);
      const certs = db.prepare('SELECT * FROM certification WHERE person_id = ? ORDER BY expires_at').all(p.id);
      const execs = checklistsWithItems(
        db.prepare(
          `SELECT e.*, t.task_number, t.title AS task_title, t.status AS task_status, t.actual_start, t.actual_end, t.due_date
             FROM checklist_execution e LEFT JOIN task t ON t.id = e.task_id
            WHERE e.executed_by = ? ORDER BY e.submitted_at DESC`
        ).all(p.id)
      );
      const visibleExecs = scope.global ? execs : execs.filter((e) => e.task_id == null || scope.taskIds.has(e.task_id));
      const findings = db.prepare(
        `SELECT tf.*, t.task_number FROM task_finding tf LEFT JOIN task t ON t.id = tf.task_id
          WHERE tf.created_by = ? ORDER BY tf.captured_at DESC`
      ).all(p.id);
      const gps = db.prepare('SELECT * FROM gps_validation WHERE validated_by = ? ORDER BY validated_at DESC').all(p.id);
      const perf = personPerformanceRows(scopeTasks(user, scope, list('task')), [p.id]).find((r) => r.id === p.id) || null;
      const regions = db.prepare(
        `SELECT r.name FROM region_personnel rp JOIN region r ON r.id = rp.region_id WHERE rp.person_id = ?`
      ).all(p.id).map((r) => r.name);
      const name = [p.first_name, p.last_name].filter(Boolean).join(' ');
      const rows = [
        { label: 'Name', value: name },
        { label: 'Role', value: p.role || '—' },
        { label: 'Title', value: p.title || '—' },
        { label: 'Regions', value: regions.join(', ') || '—' },
        { label: 'Crews', value: crews.map((c) => `${c.name} (${c.crew_code})${c.active ? '' : ' · inactive'}`).join(', ') || '—' },
        { label: 'Leads', value: ledCrews.map((c) => c.name).join(', ') || '—' },
        { label: 'Certifications', value: certs.length },
        { label: 'Executions', value: perf ? perf.tasks : visibleExecs.length },
        { label: 'Completed (submitted)', value: perf ? perf.completed : visibleExecs.filter((e) => e.result).length },
        { label: 'Checklist pass rate', value: perf ? `${perf.checklist_pass_rate}%` : '—' },
        { label: 'On-time rate', value: perf && perf.on_time_rate != null ? `${perf.on_time_rate}%` : '—' },
        { label: 'Findings', value: perf ? perf.findings : findings.length },
        { label: 'GPS violations', value: perf ? perf.gps_violations : 0 },
      ];
      const document = {
        entity: 'PERSON',
        entity_name: name,
        person: p,
        crews,
        led_crews: ledCrews,
        certs,
        executions: visibleExecs,
        findings,
        gps_validations: gps,
        performance: perf,
      };
      return { title: `Person Detail Profile — ${name}`, rows, document };
    }
    case 'ASSET_VALUATION': {
      const parts = reportRegionIds().map((rid) => computeRegionValuation(rid, scope));
      const merged = mergeValuations(parts);
      const t = merged.totals;
      const code = currencyCode();
      const scopeName = parts.length === 1 ? parts[0].region.name : parts.length > 1 ? `${parts.length} regions` : '—';
      return {
        title: `Asset Valuation Report — ${scopeName}`,
        rows: [
          { label: 'Population (assets)', value: t.count },
          { label: 'Replacement cost (RCN)', value: moneyStr(t.rcn, code) },
          { label: 'Condition-adjusted value', value: moneyStr(t.current, code) },
          { label: 'Unpriced assets', value: t.unpriced_count },
          { label: 'Average condition', value: `${Math.round(t.avg_condition * 10) / 10} / 10` },
        ],
        financial: {
          kind: 'valuation',
          currency: code,
          count: t.count,
          rcn: t.rcn,
          current: t.current,
          unpriced_count: t.unpriced_count,
          avg_condition: t.avg_condition,
          by_family: merged.by_family,
          by_type: merged.by_type,
          by_location: merged.by_location,
          unpriced_types: merged.unpriced_types,
        },
      };
    }
    case 'MAINTENANCE_COST': {
      const data = maintenanceCostForRegions(reportRegionIds(), { from: params.period_start, to: params.period_end });
      const code = data.currency.code;
      return {
        title: 'Maintenance Cost Report',
        rows: [
          { label: 'Period', value: `${params.period_start || 'trailing 12 months'} → ${params.period_end || 'today'}` },
          { label: 'Total spend', value: moneyStr(data.totals.spend, code) },
          { label: 'Maintenance events', value: data.totals.count },
          { label: 'Average per event', value: moneyStr(data.totals.avg, code) },
        ],
        financial: { kind: 'cost', ...data, currency: code },
      };
    }
    case 'ASSET_REVALUATION':
      return recentRevaluationData();
    case 'COST_ANALYTICS': {
      const regionIds = reportRegionIds();
      const regionSet = new Set(regionIds);
      const code = currencyCode();
      const startMs = params.period_start ? new Date(`${params.period_start}T00:00:00.000Z`).getTime() : Date.now() - 365 * 864e5;
      const endMs = params.period_end ? new Date(`${params.period_end}T23:59:59.999Z`).getTime() : Date.now();
      const valParts = regionIds.map((rid) => computeRegionValuation(rid, scope));
      const valByRegion = new Map(valParts.map((p) => [p.region_id, p]));
      const byAsset = new Map();
      const byCrew = new Map();
      const byRegionRaw = new Map();
      let spend = 0;
      let events = 0;
      let poorSpend = 0;
      let poorEvents = 0;
      const poorAssets = new Set();
      for (const e of db.prepare('SELECT * FROM asset_maintenance_event ORDER BY performed_at DESC').all()) {
        const at = new Date(e.performed_at).getTime();
        if (!Number.isFinite(at) || at < startMs || at > endMs) continue;
        const asset = e.asset_id ? get('asset', e.asset_id) : null;
        const rid = assetRegion(asset);
        if (!regionSet.has(rid)) continue;
        const cost = Number(e.cost) || 0;
        spend += cost;
        events += 1;
        const regionName = get('region', rid)?.name || 'Unassigned';
        if (asset) {
          const key = asset.id;
          if (!byAsset.has(key)) byAsset.set(key, { asset_pk: asset.id, asset_code: asset.asset_id, asset_name: asset.name || asset.asset_id, region: regionName, condition: asset.condition_rating, events: 0, spend: 0 });
          const a = byAsset.get(key);
          a.events += 1;
          a.spend += cost;
          if (asset.condition_rating != null && asset.condition_rating <= 5) {
            poorSpend += cost;
            poorEvents += 1;
            poorAssets.add(asset.id);
          }
        }
        const crewKey = e.crew_id || 0;
        if (!byCrew.has(crewKey)) byCrew.set(crewKey, { crew: e.crew_id ? (get('crew', e.crew_id)?.name || `Crew #${e.crew_id}`) : 'Unassigned', events: 0, spend: 0 });
        const c = byCrew.get(crewKey);
        c.events += 1;
        c.spend += cost;
        if (!byRegionRaw.has(rid)) byRegionRaw.set(rid, { rid, region: regionName, events: 0, spend: 0 });
        const r = byRegionRaw.get(rid);
        r.events += 1;
        r.spend += cost;
      }
      const totalValue = [...byRegionRaw.keys()].reduce((s, rid) => s + (valByRegion.get(rid) ? valByRegion.get(rid).current : 0), 0);
      const ratioPct = totalValue ? Math.round((spend / totalValue) * 1000) / 10 : null;
      const byRegion = [...byRegionRaw.values()].map((r) => {
        const p = valByRegion.get(r.rid);
        const value = p ? p.current : 0;
        return { region: r.region, events: r.events, spend: r.spend, value, ratio: value ? Math.round((r.spend / value) * 1000) / 10 : null };
      }).sort((a, b) => b.spend - a.spend);
      return {
        title: 'Cost Analytics Report',
        rows: [
          { label: 'Period', value: `${params.period_start || 'trailing 12 months'} → ${params.period_end || 'today'}` },
          { label: 'Total maintenance spend', value: moneyStr(spend, code) },
          { label: 'Maintenance events', value: events },
          { label: 'Average per event', value: moneyStr(events ? spend / events : 0, code) },
          { label: 'Registered asset value (condition-adjusted)', value: moneyStr(totalValue, code) },
          { label: 'Spend as % of asset value', value: ratioPct == null ? 'N/A' : `${ratioPct}%` },
          { label: 'Spend on poor-condition assets (1-5)', value: moneyStr(poorSpend, code) },
          { label: 'Poor-condition assets serviced', value: poorAssets.size },
        ],
        totals: { spend, events, avg: events ? spend / events : 0, asset_value: totalValue, ratio: ratioPct, poor_spend: poorSpend, poor_events: poorEvents, poor_assets: poorAssets.size, currency: code },
        by_asset: [...byAsset.values()].sort((a, b) => b.spend - a.spend).slice(0, 40),
        by_crew: [...byCrew.values()].sort((a, b) => b.spend - a.spend),
        by_region: byRegion,
      };
    }
    default:
      return { title: reportType, rows: [] };
  }
}

function statusBreakdown(tasks) {
  const counts = {};
  for (const t of tasks) counts[t.status] = (counts[t.status] || 0) + 1;
  return counts;
}

router.get('/report-templates', (req, res) => {
  if (!can(req, 'report:read')) return res.status(403).json({ error: 'Forbidden: requires report:read' });
  res.json(list('report_template'));
});

router.get('/reports', (req, res) => {
  if (!can(req, 'report:read')) return res.status(403).json({ error: 'Forbidden: requires report:read' });
  const rows = list('report').filter((r) => isGlobal(req.user) || !r.scope_region_id || r.scope_region_id === req.user.region_id);
  res.json(rows);
});

// Read-only entity drill-down for report rows. Unlike /reports/generate this
// does not persist a report or require report:write; it just runs the document
// computation under the caller's command scope.
router.get('/reports/document', (req, res) => {
  const type = String(req.query.type || '');
  const idField = DOCUMENT_ID_FIELDS[type];
  if (!idField) return res.status(400).json({ error: 'Unknown document type' });
  const id = Number(req.query.id);
  if (!Number.isFinite(id) || id <= 0) return res.status(400).json({ error: 'Invalid entity id' });
  const params = { [idField]: id };
  if (req.query.scope_region_id) params.scope_region_id = Number(req.query.scope_region_id);
  res.json({ data: compute(type, params, req.user) });
});

// Share a single entity profile (the drill-down documents opened from the
// reports library / field-team performance). There is no persisted report id,
// so the recipient gets a deep link that re-opens the profile on load. The
// document is computed under the sender's scope first, so a user can never
// share an entity they are not allowed to see.
router.post('/reports/document/share', (req, res) => {
  if (!can(req, 'report:read')) return res.status(403).json({ error: 'Forbidden: requires report:read' });
  const type = String(req.body.type || '');
  const idField = DOCUMENT_ID_FIELDS[type];
  if (!idField) return res.status(400).json({ error: 'Unknown document type' });
  const id = Number(req.body.id);
  if (!Number.isFinite(id) || id <= 0) return res.status(400).json({ error: 'Invalid entity id' });
  const recipients = Array.isArray(req.body.recipients) ? req.body.recipients.map(Number).filter((n) => n > 0) : [];
  if (!recipients.length) return res.status(400).json({ error: 'At least one recipient is required' });
  const data = compute(type, { [idField]: id }, req.user);
  if (!data.document) return res.status(403).json({ error: 'Entity is outside your access scope' });
  const title = data.title || 'Entity Profile';
  const note = String(req.body.note || '').slice(0, 2000);
  const path = `/reports?document=${encodeURIComponent(type)}&id=${id}`;
  let sent = 0;
  for (const pid of recipients) {
    try {
      sendMail({
        senderUserId: req.user.id,
        recipientPersonId: pid,
        subject: `Shared profile: ${title}`.slice(0, 200),
        body: `${note ? `${note}\n\n` : ''}${title}\nOpen the profile: ${path}`,
        category: 'REPORT',
        entityType: 'report',
        entityId: null,
        link: path,
      });
      sent += 1;
    } catch (_) { /* skip a bad recipient */ }
  }
  audit(req.user, 'SHARE', 'report', null, { document: type, entity_id: id, recipients: sent });
  res.json({ sent });
});

router.get('/reports/:id', (req, res) => {
  if (!can(req, 'report:read')) return res.status(403).json({ error: 'Forbidden: requires report:read' });
  const r = get('report', Number(req.params.id), ['parameters']);
  if (!r) return res.status(404).json({ error: 'Report not found' });
  if (!isGlobal(req.user) && r.scope_region_id && r.scope_region_id !== req.user.region_id) {
    return res.status(404).json({ error: 'Report not found' });
  }
  let params = r.parameters;
  try {
    params = typeof params === 'string' ? JSON.parse(params) : params;
  } catch (_) {
    params = null;
  }
  r.data = params?.data || null;
  r.parameters = params;
  res.json(r);
});

// Persist a generated report from a parameter set, using the caller's scope.
// Shared by the manual generate route and the recurring-schedule sweeper.
function createReport(params, user) {
  const reportType = params.report_type;
  const data = compute(reportType, params, user);
  const now = new Date().toISOString();
  const code = nextCode(`RPT-${now.slice(0, 4)}`, 'report', 'report_code', 4);
  const template = list('report_template').find((t) => t.report_type === reportType);
  const id = insertRow('report', {
    report_code: code,
    report_type: reportType,
    title: data.title,
    period_start: new Date(params.period_start || now).toISOString(),
    period_end: new Date(params.period_end || now).toISOString(),
    scope_region_id: params.scope_region_id || null,
    template_id: template ? template.id : null,
    status: 'READY',
    format: params.format || 'HTML',
    generated_at: now,
    parameters: JSON.stringify({ ...params, data }),
  });
  return { id, data };
}

// Persist a revaluation report from a change set produced by the monitoring
// agent. Unlike createReport this is a global, scope-less report (the agent is
// not tied to a region) and its data is built directly from the change set.
function createRevaluationReport(changes, meta = {}) {
  if (!changes || !changes.length) return null;
  const data = changesToData(changes, meta);
  const analytics = buildAnalytics('ASSET_REVALUATION', data);
  if (analytics) data.analytics = analytics;
  const now = new Date().toISOString();
  const code = nextCode(`RPT-${now.slice(0, 4)}`, 'report', 'report_code', 4);
  const template = list('report_template').find((t) => t.report_type === 'ASSET_REVALUATION');
  const id = insertRow('report', {
    report_code: code,
    report_type: 'ASSET_REVALUATION',
    title: data.title,
    period_start: now,
    period_end: now,
    scope_region_id: null,
    template_id: template ? template.id : null,
    status: 'READY',
    format: 'HTML',
    generated_at: now,
    parameters: JSON.stringify({ report_type: 'ASSET_REVALUATION', data }),
  });
  return { id, data };
}

// --- Asset-condition monitoring agent --------------------------------------

router.get('/asset-monitor', (req, res) => {
  if (!can(req, 'report:read')) return res.status(403).json({ error: 'Forbidden: requires report:read' });
  res.json({ summary: monitorSummary(), recent: recentRevaluationData({ days: 180 }).changes.slice(0, 25) });
});

router.post('/asset-monitor/run', (req, res) => {
  if (!can(req, 'report:write')) return res.status(403).json({ error: 'Forbidden: requires report:write' });
  const result = runAssetMonitor();
  audit(req.user, 'REVALUE', 'asset_monitor', null, { changed: result.changed, degraded: result.degraded.length });
  res.json({ ...result, summary: monitorSummary() });
});

// Shared by the manual trigger and the background sweeper. Injects the change
// set into a revaluation report when assets degrade and links the snapshot rows.
function runAssetMonitor() {
  return revalueAssets({
    source: 'AGENT',
    onDegraded: (degraded, meta) => {
      const r = createRevaluationReport(degraded, meta);
      return r ? r.id : null;
    },
  });
}

router.post('/reports/generate', (req, res) => {
  if (!can(req, 'report:write')) return res.status(403).json({ error: 'Forbidden: requires report:write' });
  const params = { ...req.body };
  if (!isGlobal(req.user)) params.scope_region_id = req.user.region_id;
  if (!params.scope_region_id) params.scope_region_id = null;
  const { id, data } = createReport(params, req.user);
  audit(req.user, 'GENERATE', 'report', id, { report_type: params.report_type });
  res.status(201).json({ ...get('report', id, ['parameters']), data });
});

// --- Report tooling: recurring schedules, sharing --------------------------

function addMonthsIso(iso, months) {
  const d = new Date(iso);
  const day = d.getUTCDate();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() + Number(months || 1));
  const dim = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
  d.setUTCDate(Math.min(day, dim));
  return d.toISOString();
}

// Rebuild a user-shaped record for a schedule's owner so compute() applies the
// same command scope they would see running the report by hand.
function userForSchedule(userId) {
  const u = db.prepare(
    `SELECT u.id, u.username, u.role, u.region_id, u.person_id, u.active, u.created_at,
            p.first_name, p.last_name, p.title, p.email
     FROM user u LEFT JOIN person p ON p.id = u.person_id WHERE u.id = ?`
  ).get(userId);
  return u && u.active ? u : null;
}

router.get('/report-schedules', (req, res) => {
  if (!can(req, 'report:read')) return res.status(403).json({ error: 'Forbidden: requires report:read' });
  const rows = list('report_schedule')
    .filter((s) => isGlobal(req.user) || !s.scope_region_id || s.scope_region_id === req.user.region_id);
  res.json(rows);
});

router.post('/report-schedules', (req, res) => {
  if (!can(req, 'report:write')) return res.status(403).json({ error: 'Forbidden: requires report:write' });
  const b = req.body || {};
  if (!b.report_type) return res.status(400).json({ error: 'report_type is required' });
  const months = [1, 3, 6, 12].includes(Number(b.months)) ? Number(b.months) : 1;
  const scopeRegion = isGlobal(req.user) ? (b.scope_region_id || null) : req.user.region_id;
  const shareTo = Array.isArray(b.share_to) ? b.share_to.map(Number).filter(Boolean) : [];
  const schedParams = { ...(b.params || {}) };
  if (b.period_start) schedParams.period_start = b.period_start;
  if (b.period_end) schedParams.period_end = b.period_end;
  const id = insertRow('report_schedule', {
    report_type: b.report_type,
    months,
    next_run_at: b.next_run_at ? new Date(b.next_run_at).toISOString() : addMonthsIso(new Date().toISOString(), months),
    last_run_at: null,
    active: 1,
    scope_region_id: scopeRegion,
    params: JSON.stringify(schedParams),
    share_to: JSON.stringify(shareTo),
    created_by: req.user.id,
    created_at: new Date().toISOString(),
  });
  audit(req.user, 'SCHEDULE', 'report_schedule', id, { report_type: b.report_type, months });
  res.status(201).json(get('report_schedule', id));
});

router.patch('/report-schedules/:id', (req, res) => {
  if (!can(req, 'report:write')) return res.status(403).json({ error: 'Forbidden: requires report:write' });
  const s = get('report_schedule', Number(req.params.id));
  if (!s) return res.status(404).json({ error: 'Schedule not found' });
  if (!isGlobal(req.user) && s.scope_region_id && s.scope_region_id !== req.user.region_id) {
    return res.status(404).json({ error: 'Schedule not found' });
  }
  const active = req.body && req.body.active !== undefined ? (req.body.active ? 1 : 0) : s.active;
  db.prepare('UPDATE report_schedule SET active = ? WHERE id = ?').run(active, s.id);
  res.json(get('report_schedule', s.id));
});

router.post('/reports/:id/share', (req, res) => {
  if (!can(req, 'report:read')) return res.status(403).json({ error: 'Forbidden: requires report:read' });
  const r = get('report', Number(req.params.id), ['parameters']);
  if (!r) return res.status(404).json({ error: 'Report not found' });
  if (!isGlobal(req.user) && r.scope_region_id && r.scope_region_id !== req.user.region_id) {
    return res.status(404).json({ error: 'Report not found' });
  }
  const recipients = Array.isArray(req.body?.recipients) ? req.body.recipients.map(Number).filter(Boolean) : [];
  if (!recipients.length) return res.status(400).json({ error: 'At least one recipient is required' });
  const note = String(req.body?.note || '').slice(0, 2000);
  const body = `${note ? `${note}\n\n` : ''}${r.title}\nOpen the report: /reports?report=${r.id}`;
  let sent = 0;
  for (const pid of recipients) {
    const m = sendMail({
      senderUserId: req.user.id,
      senderPersonId: req.user.person_id,
      recipientPersonId: pid,
      subject: `Report: ${r.title}`.slice(0, 200),
      body,
      category: 'REPORT',
      entityType: 'report',
      entityId: r.id,
      link: `/reports?report=${r.id}`,
    });
    if (m) sent += 1;
  }
  audit(req.user, 'SHARE', 'report', r.id, { recipients: sent });
  res.json({ sent });
});

// Generate every due scheduled report, then roll the schedule forward. Called
// at boot and on an interval; safe to run repeatedly.
function runReportSchedules(nowIso = new Date().toISOString()) {
  const now = new Date(nowIso);
  const due = list('report_schedule').filter((s) => s.active && s.next_run_at && new Date(s.next_run_at) <= now);
  const made = [];
  for (const s of due) {
    try {
      const owner = userForSchedule(s.created_by)
        || { id: s.created_by, role: 'ADMIN', region_id: s.scope_region_id, crew_ids: [] };
      const extra = typeof s.params === 'string' ? JSON.parse(s.params) : (s.params || {});
      const params = { ...extra, report_type: s.report_type, scope_region_id: s.scope_region_id || null };
      const { id } = createReport(params, owner);
      audit(owner, 'GENERATE', 'report', id, { report_type: s.report_type, scheduled: true });
      let shareTo = [];
      try { shareTo = typeof s.share_to === 'string' ? JSON.parse(s.share_to) : (s.share_to || []); } catch (_) { shareTo = []; }
      const fresh = get('report', id);
      for (const pid of (shareTo || [])) {
        sendMail({
          senderUserId: s.created_by,
          recipientPersonId: Number(pid),
          subject: `Scheduled report: ${fresh.title}`.slice(0, 200),
          body: `${fresh.title}\nOpen the report: /reports?report=${fresh.id}`,
          category: 'REPORT',
          entityType: 'report',
          entityId: fresh.id,
          link: `/reports?report=${fresh.id}`,
        });
      }
      db.prepare('UPDATE report_schedule SET last_run_at = ?, next_run_at = ? WHERE id = ?')
        .run(nowIso, addMonthsIso(s.next_run_at, s.months), s.id);
      made.push(id);
    } catch (_) {
      // Do not let one bad schedule stall the rest; push it forward a period.
      try {
        db.prepare('UPDATE report_schedule SET next_run_at = ? WHERE id = ?')
          .run(addMonthsIso(s.next_run_at, s.months), s.id);
      } catch (__) { /* non-fatal */ }
    }
  }
  return made;
}

module.exports = router;
module.exports.runReportSchedules = runReportSchedules;
module.exports.runAssetMonitor = runAssetMonitor;
module.exports.createRevaluationReport = createRevaluationReport;
