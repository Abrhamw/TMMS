// Dispatch readiness and crew/person performance.
//
// One shared place for the "can this crew actually do this task" audit and the
// execution KPIs that back the crew/person document sections and the readiness
// reports. Dispatch is decision support: it warns, it never blocks, and the
// equipment a checklist calls for is surfaced as an advisory list because the
// schema holds no crew equipment inventory.

const { db, list, get } = require('./util');
const { buildRequirements, mergeRequirements, evaluateCrew, certIsValid } = require('./dispatch');

const OPEN_TASK_STATES = ['DRAFT', 'SCHEDULED', 'ASSIGNED', 'IN_PROGRESS', 'ON_HOLD', 'PENDING_VERIFICATION'];

function personName(id) {
  if (!id) return null;
  const p = get('person', id);
  return p ? [p.first_name, p.last_name].filter(Boolean).join(' ').trim() || `person #${id}` : `person #${id}`;
}

function ratePct(part, whole) {
  return whole ? Math.round((part / whole) * 100) : 0;
}

// The crew a task actually points at: the assigned crew, else the target
// asset's default crew, else the responsible crew on the schedule that raised
// the task. Null when the task names no crew anywhere.
function resolveTaskCrewId(t) {
  if (!t) return null;
  if (t.crew_id) return Number(t.crew_id);
  if (t.asset_id) {
    const a = get('asset', t.asset_id);
    if (a && a.default_crew_id) return Number(a.default_crew_id);
  }
  if (t.schedule_id) {
    const s = get('maintenance_schedule', t.schedule_id);
    if (s && s.responsible_crew_id) return Number(s.responsible_crew_id);
  }
  return null;
}

function taskCrewSource(t, crewId) {
  if (!t || !crewId) return null;
  if (t.crew_id && Number(t.crew_id) === crewId) return 'ASSIGNED';
  if (t.asset_id) {
    const a = get('asset', t.asset_id);
    if (a && a.default_crew_id && Number(a.default_crew_id) === crewId) return 'ASSET_DEFAULT';
  }
  if (t.schedule_id) {
    const s = get('maintenance_schedule', t.schedule_id);
    if (s && s.responsible_crew_id && Number(s.responsible_crew_id) === crewId) return 'SCHEDULE_RESPONSIBLE';
  }
  return 'RELATED';
}

// The checklist requirements a task imposes, or null when it names no template.
// A task governed by several templates yields a merged requirement profile.
function taskRequirements(t) {
  if (!t) return null;
  const ids = [];
  if (t.id) {
    for (const r of db.prepare('SELECT template_id FROM task_checklist_template WHERE task_id = ? ORDER BY sequence, template_id').all(t.id)) {
      ids.push(r.template_id);
    }
  }
  if (!ids.length && t.checklist_template_id) ids.push(t.checklist_template_id);
  if (!ids.length) return null;
  const context = { is_energized_work: !!t.is_energized_work, permit_required: !!t.permit_required };
  const reqs = [];
  for (const tid of ids) {
    const tpl = get('checklist_template', tid);
    if (!tpl) continue;
    const items = db.prepare('SELECT instruction, pass_criteria, test_equipment, section FROM checklist_item WHERE template_id = ?').all(tpl.id);
    reqs.push(buildRequirements(tpl, items, context));
  }
  return mergeRequirements(reqs);
}

// A crew shaped for the dispatch evaluator (crew_type + members + valid certs)
// plus the roster/certification detail the readiness views render.
function crewSnapshot(crewId) {
  const c = get('crew', Number(crewId));
  if (!c) return null;
  const members = db.prepare('SELECT * FROM crew_member WHERE crew_id = ? AND active = 1 ORDER BY sort_order ASC, id ASC').all(c.id);
  const memberIds = [...new Set([c.leader_person_id, ...members.map((m) => m.person_id)].filter(Boolean))];
  const certifications = memberIds.length
    ? db.prepare(`SELECT * FROM certification WHERE person_id IN (${memberIds.map(() => '?').join(',')})`).all(...memberIds)
    : [];
  const membersOut = members.map((m) => {
    const mine = certifications.filter((cr) => cr.person_id === m.person_id);
    return {
      id: m.id,
      person_id: m.person_id,
      name: personName(m.person_id),
      role: m.role,
      skill_level: m.skill_level,
      valid_certs: mine.filter(certIsValid).map((cr) => cr.cert_type),
      certifications: mine.map((cr) => ({ id: cr.id, cert_type: cr.cert_type, status: cr.status, expires_at: cr.expires_at, valid: certIsValid(cr) })),
    };
  });
  const certsOut = certifications.map((cr) => ({
    id: cr.id, person_id: cr.person_id, person_name: personName(cr.person_id),
    cert_type: cr.cert_type, status: cr.status, expires_at: cr.expires_at, valid: certIsValid(cr),
  }));
  return {
    id: c.id, name: c.name, crew_code: c.crew_code, crew_type: c.crew_type, region_id: c.region_id,
    member_count: members.length,
    members: membersOut,
    certifications: certsOut,
    valid_cert_types: [...new Set(certsOut.filter((x) => x.valid).map((x) => x.cert_type))],
    expired_certifications: certsOut.filter((x) => x.status === 'EXPIRED' || (!x.valid && x.status === 'VALID')),
    skill_levels: membersOut.map((m) => m.skill_level),
  };
}

// Whether a crew is ready for a task: the evaluated requirements plus the
// advisory equipment list. `eligible` is null when the task has no checklist.
function taskReadiness(t) {
  if (!t) return null;
  const requirements = taskRequirements(t);
  const equipmentChecks = requirements
    ? new Map(db.prepare('SELECT equipment_name, is_available FROM task_equipment_check WHERE task_id = ?').all(t.id)
      .map((row) => [row.equipment_name, row.is_available === 1]))
    : new Map();
  const crewId = resolveTaskCrewId(t);
  const snapshot = crewId ? crewSnapshot(crewId) : null;
  const evaluation = snapshot && requirements ? evaluateCrew(snapshot, requirements) : null;
  const equipmentList = requirements ? requirements.equipment : [];
  return {
    task_id: t.id,
    task_number: t.task_number,
    template: requirements ? { id: requirements.template_id, code: requirements.template_code, name: requirements.template_name } : null,
    requirements: requirements ? {
      team: requirements.team,
      min_team_size: requirements.min_team_size,
      skills: requirements.skills.map((s) => s.label),
      required_certs: requirements.required_certs,
      recommended_certs: requirements.recommended_certs,
      cert_requirements: requirements.cert_requirements,
      equipment_to_secure: requirements.equipment,
    } : null,
    crew: snapshot ? {
      id: snapshot.id, name: snapshot.name, crew_code: snapshot.crew_code,
      crew_type: snapshot.crew_type, member_count: snapshot.member_count,
      resolved_via: taskCrewSource(t, snapshot.id),
    } : null,
    eligible: evaluation ? evaluation.eligible : null,
    covered_skills: evaluation ? evaluation.covered_skills : [],
    missing_skills: evaluation ? evaluation.missing_skills : [],
    unmapped_skills: evaluation ? evaluation.unmapped_skills : [],
    held_certs: evaluation ? evaluation.held_certs : [],
    missing_certs: evaluation ? evaluation.missing_certs : [],
    certs_to_obtain: evaluation ? evaluation.certs_to_obtain : [],
    team_shortfall: evaluation ? evaluation.team_shortfall : 0,
    equipment_to_secure: equipmentList.filter((name) => !equipmentChecks.get(name)),
    equipment_checks: equipmentList.map((name) => ({
      equipment: name,
      available: equipmentChecks.get(name) === true,
      status: equipmentChecks.get(name) === true ? 'USED' : 'MISSED',
    })),
    warnings: evaluation ? evaluation.warnings.map((w) => w.message) : [],
  };
}

// Execution KPIs per crew over an already-scoped task set.
function cycleHours(t) {
  if (!t.actual_start || !t.actual_end) return null;
  const a = Date.parse(t.actual_start);
  const b = Date.parse(t.actual_end);
  if (Number.isNaN(a) || Number.isNaN(b) || b < a) return null;
  return (b - a) / 3600000;
}

function avgNum(nums) {
  const xs = nums.filter((n) => n != null);
  return xs.length ? Math.round((xs.reduce((s, n) => s + n, 0) / xs.length) * 10) / 10 : null;
}

function crewPerformanceRows(crews, tasks) {
  const now = new Date().toISOString();
  return crews.map((c) => {
    const owned = tasks.filter((t) => t.crew_id === c.id);
    const completed = owned.filter((t) => t.status === 'COMPLETED');
    const onTime = completed.filter((t) => t.actual_end && t.due_date && t.actual_end <= t.due_date);
    const failed = owned.filter((t) => t.result === 'FAIL' || t.status === 'FAILED');
    const open = owned.filter((t) => OPEN_TASK_STATES.includes(t.status));
    const overdue = open.filter((t) => t.due_date && t.due_date < now);
    const findings = db.prepare('SELECT COUNT(*) c FROM task_finding WHERE crew_id = ?').get(c.id).c;
    const gps = db.prepare(
      `SELECT COUNT(*) c FROM gps_validation v JOIN task t ON t.id = v.linked_task_id
       WHERE v.result = 'FAIL' AND t.crew_id = ?`
    ).get(c.id).c;
    const exec = db.prepare(
      `SELECT SUM(CASE WHEN i.result = 'PASS' THEN 1 ELSE 0 END) AS pass,
              SUM(CASE WHEN i.result = 'FAIL' THEN 1 ELSE 0 END) AS fail
         FROM checklist_execution_item i
         JOIN checklist_execution e ON e.id = i.execution_id
         JOIN task t ON t.id = e.task_id
        WHERE t.crew_id = ? AND e.submitted_at IS NOT NULL`
    ).get(c.id);
    const pass = Number(exec.pass) || 0;
    const fail = Number(exec.fail) || 0;
    const lastActivity = owned.reduce((m, t) => {
      const d = t.actual_end || t.created_at;
      return d && d > m ? d : m;
    }, '');
    return {
      id: c.id, name: c.name,
      tasks: owned.length, completed: completed.length, completion_rate: ratePct(completed.length, owned.length),
      on_time: onTime.length, on_time_rate: ratePct(onTime.length, completed.length),
      failed: failed.length, open: open.length, overdue: overdue.length,
      checklist_pass: pass, checklist_fail: fail, checklist_pass_rate: ratePct(pass, pass + fail),
      avg_cycle_hours: avgNum(completed.map(cycleHours)),
      last_activity: lastActivity || null,
      findings, gps_violations: gps,
    };
  });
}

// Execution KPIs per executor over an already-scoped task set.
function personPerformanceRows(tasks) {
  const now = new Date().toISOString();
  const taskIds = new Set(tasks.map((t) => t.id));
  const byExec = {};
  const q = db.prepare('SELECT id, executed_by, result, submitted_at FROM checklist_execution WHERE task_id = ?');
  for (const t of tasks) {
    for (const ex of q.all(t.id)) {
      if (!ex.executed_by) continue;
      (byExec[ex.executed_by] = byExec[ex.executed_by] || []).push({ t, ex });
    }
  }
  return Object.entries(byExec).map(([pidStr, arr]) => {
    const pid = Number(pidStr);
    const done = arr.filter(({ ex }) => ex.result);
    const onTime = done.filter(({ t }) => t.status === 'COMPLETED' && t.actual_end && t.due_date && t.actual_end <= t.due_date);
    const execIds = arr.map(({ ex }) => ex.id);
    const findings = execIds.length
      ? db.prepare(`SELECT COUNT(*) c FROM task_finding WHERE execution_id IN (${execIds.map(() => '?').join(',')})`).get(...execIds).c
      : 0;
    const gpsViol = db.prepare("SELECT linked_task_id FROM gps_validation WHERE validated_by = ? AND result = 'FAIL'").all(pid)
      .filter((v) => v.linked_task_id != null && taskIds.has(v.linked_task_id)).length;
    const itemAgg = execIds.length
      ? db.prepare(
        `SELECT SUM(CASE WHEN result = 'PASS' THEN 1 ELSE 0 END) AS pass,
                SUM(CASE WHEN result = 'FAIL' THEN 1 ELSE 0 END) AS fail
           FROM checklist_execution_item WHERE execution_id IN (${execIds.map(() => '?').join(',')})`
      ).get(...execIds)
      : null;
    const pass = itemAgg ? Number(itemAgg.pass) || 0 : 0;
    const fail = itemAgg ? Number(itemAgg.fail) || 0 : 0;
    const open = arr.filter(({ t }) => OPEN_TASK_STATES.includes(t.status));
    const overdue = open.filter(({ t }) => t.due_date && t.due_date < now);
    const lastActivity = arr.reduce((m, { ex }) => (ex.submitted_at && ex.submitted_at > m ? ex.submitted_at : m), '');
    return {
      id: pid, name: personName(pid),
      tasks: arr.length, completed: done.length, completion_rate: ratePct(done.length, arr.length),
      on_time: onTime.length, on_time_rate: ratePct(onTime.length, done.length),
      checklist_pass: pass, checklist_fail: fail, checklist_pass_rate: ratePct(pass, pass + fail),
      open: open.length, overdue: overdue.length,
      last_activity: lastActivity || null,
      findings, gps_violations: gpsViol,
    };
  }).sort((a, b) => b.tasks - a.tasks);
}

// Crew-level readiness: roster/cert coverage, KPIs, and the per-open-task
// dispatch audit with the equipment a crew would need to secure.
function crewReadiness(crewOrId) {
  const crewId = crewOrId && typeof crewOrId === 'object' ? crewOrId.id : Number(crewOrId);
  const snapshot = crewSnapshot(crewId);
  if (!snapshot) return null;
  const performance = crewPerformanceRows([snapshot], list('task'))[0] || null;
  const openTasks = db.prepare(
    `SELECT * FROM task WHERE crew_id = ? AND status IN (${OPEN_TASK_STATES.map(() => '?').join(',')}) ORDER BY COALESCE(due_date, created_at)`
  ).all(crewId, ...OPEN_TASK_STATES);
  const taskAudits = openTasks.map((t) => {
    const r = taskReadiness(t);
    return {
      task_id: t.id, task_number: t.task_number, title: t.title, status: t.status, due_date: t.due_date,
      eligible: r.eligible, missing_certs: r.missing_certs, missing_skills: r.missing_skills,
      equipment_to_secure: r.equipment_to_secure, warnings: r.warnings,
    };
  });
  const equipment = [...new Set(taskAudits.flatMap((a) => a.equipment_to_secure))].sort();
  const warnings = [];
  if (!snapshot.member_count) warnings.push('No active crew members');
  if (snapshot.expired_certifications.length) warnings.push(`${snapshot.expired_certifications.length} certification(s) expired`);
  const atRisk = taskAudits.filter((a) => a.eligible === false).length;
  if (atRisk) warnings.push(`${atRisk} open task(s) with unmet requirements`);
  return {
    crew: { id: snapshot.id, name: snapshot.name, crew_code: snapshot.crew_code, crew_type: snapshot.crew_type, member_count: snapshot.member_count },
    members: snapshot.members,
    certifications: snapshot.certifications,
    valid_cert_types: snapshot.valid_cert_types,
    roles: [...new Set(snapshot.members.map((m) => m.role))],
    cert_status: {
      total: snapshot.certifications.length,
      valid: snapshot.certifications.filter((x) => x.valid).length,
      expired: snapshot.expired_certifications.length,
    },
    performance,
    open_tasks: taskAudits,
    at_risk_tasks: atRisk,
    equipment_to_secure: equipment,
    warnings,
  };
}

// Person-level readiness: KPIs over an already-scoped task set, certification
// validity and the crews the person belongs to.
function personReadiness(personId, tasks) {
  const person = get('person', Number(personId));
  if (!person) return null;
  const scoped = tasks || list('task');
  const performance = personPerformanceRows(scoped).find((r) => r.id === Number(personId))
    || { id: Number(personId), name: personName(personId), tasks: 0, completed: 0, completion_rate: 0, on_time: 0, on_time_rate: 0, findings: 0, gps_violations: 0 };
  const certifications = db.prepare('SELECT * FROM certification WHERE person_id = ? ORDER BY expires_at').all(personId)
    .map((cr) => ({ ...cr, valid: certIsValid(cr) }));
  const crews = db.prepare(
    `SELECT c.id, c.name, c.crew_code, m.role, m.skill_level
     FROM crew_member m JOIN crew c ON c.id = m.crew_id WHERE m.active = 1 AND m.person_id = ?`
  ).all(personId);
  return { person, performance, certifications, crews };
}

module.exports = {
  OPEN_TASK_STATES,
  resolveTaskCrewId,
  taskCrewSource,
  taskRequirements,
  crewSnapshot,
  taskReadiness,
  crewPerformanceRows,
  personPerformanceRows,
  crewReadiness,
  personReadiness,
};
