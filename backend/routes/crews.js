const express = require('express');
const { db, list, get, insertRow, updateRow, safeDelete } = require('../util');
const { hasPerm, can, checkRegion, scopeRows, isGlobal, isCrewUser, audit } = require('../auth');
const { taskProgress } = require('../taskProgress');
const { deriveCrewStatus, syncCrewStatus, CREW_STATUS_OVERRIDES } = require('../crewStatus');
const { authorizedCrewIds, readCrewIds, regionWideRead, canAssignCrew, canViewCrew, canManageUnit, isManager } = require('../authority');
const { buildRequirements, evaluateCrew } = require('../dispatch');
const { resolveTaskCrewId, taskCrewSource } = require('../readiness');

const router = express.Router();

function crewDetail(c, user = null) {
  const members = db.prepare('SELECT * FROM crew_member WHERE crew_id = ? AND active = 1 ORDER BY sort_order ASC, id ASC').all(c.id);
  const out = { ...c, member_count: members.length, members: members.map((m) => ({ ...m, person: get('person', m.person_id) })) };
  out.certifications = [];
  for (const m of members) {
    const certs = db.prepare('SELECT * FROM certification WHERE person_id = ?').all(m.person_id);
    out.certifications.push(...certs.map((crt) => ({ ...crt, person_id: m.person_id, person_name: m.person ? `${m.person.first_name} ${m.person.last_name}` : '' })));
  }
  const openTasks = db.prepare(
    "SELECT COUNT(*) c FROM task WHERE crew_id = ? AND status NOT IN ('COMPLETED','CANCELLED','FAILED')"
  ).get(c.id).c;
  out.open_task_count = openTasks;
  out.status_override = c.status_override || null;
  out.derived_status = deriveCrewStatus(c.id, false);
  out.status = deriveCrewStatus(c.id);
  out.org_unit = c.org_unit_id ? get('org_unit', c.org_unit_id) : null;
  out.assignable = user ? canAssignCrew(user, c.id) : true;
  return out;
}

function overrideError(value) {
  if (value === undefined || value === null || value === '') return null;
  return CREW_STATUS_OVERRIDES.includes(value) ? null : `Invalid status_override: ${value}`;
}

function setCrewOverride(crewId, value) {
  if (value === null || value === undefined || value === '') {
    db.prepare('UPDATE crew SET status_override = NULL WHERE id = ?').run(crewId);
  } else {
    db.prepare('UPDATE crew SET status_override = ? WHERE id = ?').run(value, crewId);
  }
}

const CREW_ROLES = ['CREW_LEADER', 'LINEMAN', 'TECHNICIAN', 'SAFETY_OFFICER', 'INSPECTOR', 'APPRENTICE'];
const CREW_SKILLS = ['JUNIOR', 'INTERMEDIATE', 'SENIOR', 'MASTER'];

function withTx(fn) {
  db.exec('BEGIN');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

function reconcileMembers(crewId, members) {
  const seen = new Set();
  const existing = db.prepare('SELECT * FROM crew_member WHERE crew_id = ? AND active = 1').all(crewId);
  const byPerson = new Map(existing.map((m) => [m.person_id, m]));
  const keep = new Set();
  (members || []).forEach((m, idx) => {
    const pid = Number(m.person_id);
    if (!pid) throw new Error('Each crew member must have a person_id');
    if (seen.has(pid)) throw new Error('Person is listed more than once in the crew roster');
    seen.add(pid);
    const person = get('person', pid);
    if (!person) throw new Error(`Person ${pid} not found`);
    const role = CREW_ROLES.includes(m.role) ? m.role : CREW_ROLES.includes((m.role || '').toUpperCase()) ? m.role.toUpperCase() : 'LINEMAN';
    const skill = CREW_SKILLS.includes((m.skill_level || '').toUpperCase()) ? m.skill_level.toUpperCase() : 'JUNIOR';
    if (byPerson.has(pid)) {
      const row = byPerson.get(pid);
      updateRow('crew_member', row.id, { role, skill_level: skill, sort_order: idx, active: 1 });
    } else {
      insertRow('crew_member', { crew_id: crewId, person_id: pid, role, skill_level: skill, sort_order: idx, active: 1 });
    }
    keep.add(pid);
  });
  const crew = get('crew', crewId);
  const leaderId = crew && crew.leader_person_id ? Number(crew.leader_person_id) : null;
  if (leaderId && !seen.has(leaderId)) {
    const row = byPerson.get(leaderId);
    if (row) {
      updateRow('crew_member', row.id, { role: 'CREW_LEADER', sort_order: 0, active: 1 });
    } else {
      insertRow('crew_member', { crew_id: crewId, person_id: leaderId, role: 'CREW_LEADER', skill_level: 'SENIOR', sort_order: 0, active: 1 });
    }
    keep.add(leaderId);
  }
  for (const row of existing) {
    if (!keep.has(row.person_id)) {
      db.prepare('UPDATE crew_member SET active = 0, sort_order = 0 WHERE id = ?').run(row.id);
    }
  }
}

router.get('/crews', (req, res) => {
  // Reading the crew list is region-wide for a region manager (they oversee the
  // region), while the crews they may actually assign stay their department
  // (`authorizedCrewIds`, surfaced per row as `assignable`).
  const ids = readCrewIds(req.user);
  let rows = list('crew').filter((c) => ids.has(c.id));
  const { region_id, q } = req.query;
  if (region_id) rows = rows.filter((c) => c.region_id === Number(region_id));
  if (q) rows = rows.filter((c) => c.name.toLowerCase().includes(q.toLowerCase()));
  res.json(rows.map((c) => crewDetail(c, req.user)));
});

// Resolves the checklist that governs a dispatch decision, from an explicit
// checklist_template_id or the task's own checklist. Returns null when the
// caller is checking against the legacy task_type rule only.
function dispatchRequirements(query) {
  let template = null;
  let context = {};
  if (query.checklist_template_id) {
    template = get('checklist_template', Number(query.checklist_template_id));
  } else if (query.task_id) {
    const t = get('task', Number(query.task_id));
    if (t && t.checklist_template_id) template = get('checklist_template', t.checklist_template_id);
    if (t) context = { is_energized_work: !!t.is_energized_work, permit_required: !!t.permit_required };
  }
  if (!template) return null;
  const items = db.prepare('SELECT instruction, pass_criteria, test_equipment, section FROM checklist_item WHERE template_id = ?').all(template.id);
  return buildRequirements(template, items, context);
}

// A candidate is "related" to a checklist when its functional crew type is one
// the checklist calls for; if the checklist has no crew-type signal, fall back
// to matching a required member role. With neither signal, everything is
// related (legacy task-type-only checks keep their candidate list).
function crewIsRelevant(crew, reqs) {
  if (!crew || !reqs) return true;
  if (reqs.crew_types.length) return reqs.crew_types.includes(crew.crew_type);
  if (reqs.roles.length) {
    const members = db.prepare('SELECT role FROM crew_member WHERE crew_id = ? AND active = 1').all(crew.id);
    return members.some((m) => reqs.roles.includes(m.role));
  }
  return true;
}

// Crew eligibility check for a task (dispatch decision support)
// NOTE: must be declared before /crews/:id so Express does not capture "eligibility" as an id.
router.get('/crews/eligibility', (req, res) => {
  if (!can(req, 'task:assign')) return res.status(403).json({ error: 'Forbidden: requires task:assign' });
  const { region_id, task_type } = req.query;
  let rows = scopeRows(req.user, list('crew'), (c) => c.region_id);
  if (region_id) rows = rows.filter((c) => c.region_id === Number(region_id));
  if (isManager(req.user)) {
    const ids = authorizedCrewIds(req.user);
    rows = rows.filter((c) => ids.has(c.id));
  }
  const reqs = dispatchRequirements(req.query);
  // Scope the check to the crew(s) actually related to the request. A selected
  // task pins the single crew it points at; otherwise a checklist narrows the
  // candidates to its required crew type(s), never all crews.
  const focusTask = req.query.task_id ? get('task', Number(req.query.task_id)) : null;
  const focusCrewId = resolveTaskCrewId(focusTask);
  const focusVia = focusCrewId ? taskCrewSource(focusTask, focusCrewId) : null;
  if (focusCrewId) rows = rows.filter((c) => c.id === focusCrewId);
  else if (reqs) rows = rows.filter((c) => crewIsRelevant(c, reqs));
  const legacyCerts = task_type === 'PREVENTIVE' ? ['SF6_HANDLING'] : task_type === 'INSPECTION' ? [] : ['LIVE_LINE'];
  const result = rows.map((c) => {
    const detail = crewDetail(c, req.user);
    const certTypes = new Set(detail.certifications.filter((x) => x.status === 'VALID').map((x) => x.cert_type));
    const neededCerts = reqs ? reqs.required_certs : legacyCerts;
    const missing = neededCerts.filter((nc) => !certTypes.has(nc));
    const certScore = missing.length === 0 ? 1 : missing.length === neededCerts.length ? 0 : 0.5;
    const loadFactor = Math.max(0, 1 - detail.open_task_count / 8);
    const selectable = detail.status !== 'OFF_DUTY' && detail.status !== 'UNAVAILABLE';
    const evaluation = reqs ? evaluateCrew(detail, reqs) : null;
    const skillFactor = evaluation ? (evaluation.eligible ? 1 : Math.max(0, 1 - (evaluation.missing_skills.length + evaluation.unmapped_skills.length + (evaluation.team_shortfall ? 1 : 0)) / Math.max(1, reqs.skills.length + 1))) : 1;
    const score = reqs
      ? Math.round((certScore * 0.4 + loadFactor * 0.3 + skillFactor * 0.3) * 100) / 100
      : Math.round((certScore * 0.5 + loadFactor * 0.5) * 100) / 100;
    return {
      ...detail,
      assignable: true,
      eligible: evaluation ? evaluation.eligible : missing.length === 0,
      missing_certs: evaluation ? evaluation.missing_certs : missing,
      ...(evaluation ? {
        covered_skills: evaluation.covered_skills,
        missing_skills: evaluation.missing_skills,
        unmapped_skills: evaluation.unmapped_skills,
        held_certs: evaluation.held_certs,
        recommended_certs: evaluation.recommended_certs,
        certs_to_obtain: evaluation.certs_to_obtain,
        recommendations: evaluation.recommendations,
        min_team_size: evaluation.min_team_size,
        team_shortfall: evaluation.team_shortfall,
        equipment_to_secure: evaluation.equipment_to_secure,
        warnings: evaluation.warnings,
      } : {}),
      selectable,
      busy: detail.status === 'ON_TASK',
      score,
      resolved_via: focusCrewId ? focusVia : null,
      dispatch_requirements: reqs ? {
        template_id: reqs.template_id,
        template_code: reqs.template_code,
        template_name: reqs.template_name,
        team: reqs.team,
        min_team_size: reqs.min_team_size,
        skills: reqs.skills.map((s) => s.label),
        cert_requirements: reqs.cert_requirements,
        required_certs: reqs.required_certs,
        recommended_certs: reqs.recommended_certs,
        equipment_to_secure: reqs.equipment,
      } : null,
    };
  }).sort((a, b) => b.score - a.score);
  res.json(result);
});

router.get('/crews/:id', (req, res) => {
  const c = get('crew', Number(req.params.id));
  if (!c) return res.status(404).json({ error: 'Crew not found' });
  if (!canViewCrew(req.user, c)) return res.status(403).json({ error: 'Forbidden: crew is outside your scope' });
  const detail = crewDetail(c, req.user);
  detail.region = get('region', c.region_id);
  detail.leader = c.leader_person_id ? get('person', c.leader_person_id) : null;
  detail.tasks = db.prepare("SELECT * FROM task WHERE crew_id = ? ORDER BY created_at DESC").all(c.id);
  detail.tasks = detail.tasks.map((t) => ({ ...t, ...taskProgress(t.id) }));
  res.json(detail);
});

router.post('/crews', (req, res) => {
  if (!can(req, 'crew:write')) return res.status(403).json({ error: 'Forbidden: requires crew:write' });
  if (!isGlobal(req.user)) req.body.region_id = req.user.region_id;
  const { members, status, status_override, ...fields } = req.body || {};
  if (fields.org_unit_id !== undefined && fields.org_unit_id !== null && !canManageUnit(req.user, fields.org_unit_id)) {
    return res.status(403).json({ error: 'Forbidden: org unit is outside your authority' });
  }
  const invalid = overrideError(status_override);
  if (invalid) return res.status(400).json({ error: invalid });
  try {
    const id = withTx(() => {
      const crewId = insertRow('crew', { ...fields, status_override: status_override || null, revision: 1 });
      reconcileMembers(crewId, members);
      return crewId;
    });
    syncCrewStatus(id);
    audit(req.user, 'CREATE', 'crew', id, { ...fields, status_override, members });
    res.status(201).json(crewDetail(get('crew', id), req.user));
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

router.put('/crews/:id', (req, res) => {
  if (!can(req, 'crew:write')) return res.status(403).json({ error: 'Forbidden: requires crew:write' });
  const c = get('crew', Number(req.params.id));
  if (!c) return res.status(404).json({ error: 'Crew not found' });
  if (!canViewCrew(req.user, c)) return res.status(403).json({ error: 'Forbidden: crew is outside your scope' });
  const { members, status, status_override, ...fields } = req.body || {};
  if (fields.org_unit_id !== undefined && fields.org_unit_id !== null && !canManageUnit(req.user, fields.org_unit_id)) {
    return res.status(403).json({ error: 'Forbidden: org unit is outside your authority' });
  }
  const invalid = overrideError(status_override);
  if (invalid) return res.status(400).json({ error: invalid });
  try {
    withTx(() => {
      updateRow('crew', Number(req.params.id), { ...fields }, [], 'revision');
      if (status_override !== undefined) setCrewOverride(Number(req.params.id), status_override);
      if (members !== undefined) reconcileMembers(Number(req.params.id), members);
    });
    syncCrewStatus(Number(req.params.id));
    audit(req.user, 'UPDATE', 'crew', Number(req.params.id), { ...fields, status_override, members });
    res.json(crewDetail(get('crew', Number(req.params.id)), req.user));
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

router.post('/crews/:id/members', (req, res) => {
  if (!can(req, 'crew:write')) return res.status(403).json({ error: 'Forbidden: requires crew:write' });
  const c = get('crew', Number(req.params.id));
  if (!c) return res.status(404).json({ error: 'Crew not found' });
  if (!checkRegion(req, res, c.region_id)) return;
  const pid = Number(req.body.person_id);
  if (!pid || !get('person', pid)) return res.status(400).json({ error: 'A valid person_id is required' });
  if (db.prepare('SELECT id FROM crew_member WHERE crew_id = ? AND person_id = ? AND active = 1').get(Number(req.params.id), pid)) {
    return res.status(409).json({ error: 'Person is already an active member of this crew' });
  }
  const row = db.prepare('SELECT COALESCE(MAX(sort_order), -1) AS m FROM crew_member WHERE crew_id = ?').get(Number(req.params.id));
  const sort_order = req.body.sort_order !== undefined && req.body.sort_order !== null ? Number(req.body.sort_order) : row.m + 1;
  const role = req.body.role || 'LINEMAN';
  const skill_level = req.body.skill_level || 'JUNIOR';
  try {
    const id = insertRow('crew_member', { crew_id: Number(req.params.id), person_id: pid, role, skill_level, sort_order, active: 1 });
    audit(req.user, 'CREATE', 'crew_member', id, { crew_id: Number(req.params.id), person_id: pid });
    res.status(201).json(get('crew_member', id));
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

router.delete('/crews/:id/members/:memberId', (req, res) => {
  if (!can(req, 'crew:write')) return res.status(403).json({ error: 'Forbidden: requires crew:write' });
  const c = get('crew', Number(req.params.id));
  if (!c) return res.status(404).json({ error: 'Crew not found' });
  if (!checkRegion(req, res, c.region_id)) return;
  db.prepare('UPDATE crew_member SET active = 0 WHERE id = ?').run(Number(req.params.memberId));
  audit(req.user, 'DELETE', 'crew_member', Number(req.params.memberId), { crew_id: Number(req.params.id) });
  res.json({ ok: true });
});

router.get('/people', (req, res) => {
  let rows = list('person');
  const links = db.prepare('SELECT * FROM region_personnel').all();
  const byPerson = {};
  for (const l of links) {
    const r = get('region', l.region_id);
    if (!r) continue;
    (byPerson[l.person_id] = byPerson[l.person_id] || []).push({ id: r.id, name: r.name, role: l.role, is_primary: !!l.is_primary });
  }
  if (!isGlobal(req.user)) {
    const crewIds = [...(regionWideRead(req.user) ? readCrewIds(req.user) : authorizedCrewIds(req.user))];
    const crews = list('crew').filter((c) => crewIds.includes(c.id));
    const memberPersonIds = new Set(crewIds.length
      ? db.prepare(`SELECT person_id FROM crew_member WHERE active = 1 AND crew_id IN (${crewIds.map(() => '?').join(',')})`)
        .all(...crewIds).map((m) => m.person_id)
      : []);
    for (const c of crews) if (c.leader_person_id) memberPersonIds.add(c.leader_person_id);
    const ids = new Set(memberPersonIds);
    if (isManager(req.user) || isCrewUser(req.user)) {
      // Managers and field crews see only their own team's people, except a
      // region manager, who reads everyone attached to the region.
      if (regionWideRead(req.user)) {
        for (const p of list('region_personnel').filter((p) => p.region_id === req.user.region_id)) ids.add(p.person_id);
      }
      if (req.user.person_id) ids.add(req.user.person_id);
    } else {
      for (const p of list('region_personnel').filter((p) => p.region_id === req.user.region_id)) ids.add(p.person_id);
      if (req.user.person_id) ids.add(req.user.person_id);
    }
    rows = rows.filter((p) => ids.has(p.id));
  }
  for (const p of rows) p.regions = byPerson[p.id] || [];
  res.json(rows);
});

router.post('/people', (req, res) => {
  if (!can(req, 'people:write')) return res.status(403).json({ error: 'Forbidden: requires people:write' });
  if (!req.body.first_name || !req.body.last_name || !req.body.role) {
    return res.status(400).json({ error: 'first_name, last_name, role required' });
  }
  const id = insertRow('person', { ...req.body, active: req.body.active ?? 1 });
  audit(req.user, 'CREATE', 'person', id, req.body);
  const regionId = req.body.region_id;
  if (regionId) {
    if (!isGlobal(req.user) && req.user.region_id !== Number(regionId)) return res.status(403).json({ error: 'Forbidden: region outside your scope' });
    db.prepare('INSERT OR IGNORE INTO region_personnel (region_id, person_id, role, is_primary) VALUES (?,?,?,0)')
      .run(Number(regionId), Number(id), req.body.role || 'MEMBER');
    db.prepare('UPDATE region_personnel SET role = ? WHERE region_id = ? AND person_id = ?')
      .run(req.body.role || 'MEMBER', Number(regionId), Number(id));
  }
  res.status(201).json(get('person', id));
});

router.patch('/people/:id', (req, res) => {
  if (!can(req, 'people:write')) return res.status(403).json({ error: 'Forbidden: requires people:write' });
  const existing = get('person', req.params.id);
  if (!existing) return res.status(404).json({ error: 'Not found' });
  const { first_name, last_name, role, phone, email, title, active, region_id } = req.body || {};
  const updates = {};
  if (first_name !== undefined) updates.first_name = first_name;
  if (last_name !== undefined) updates.last_name = last_name;
  if (role !== undefined) updates.role = role;
  if (phone !== undefined) updates.phone = phone;
  if (email !== undefined) updates.email = email;
  if (title !== undefined) updates.title = title;
  if (active !== undefined) updates.active = active ? 1 : 0;
  if (Object.keys(updates).length) updateRow('person', Number(req.params.id), updates);
  if (region_id !== undefined && region_id !== null && region_id !== '') {
    if (!isGlobal(req.user) && req.user.region_id !== Number(region_id)) return res.status(403).json({ error: 'Forbidden: region outside your scope' });
    const existingLink = db.prepare('SELECT id FROM region_personnel WHERE region_id = ? AND person_id = ?')
      .get(Number(region_id), Number(req.params.id));
    if (existingLink) {
      db.prepare('UPDATE region_personnel SET role = ?, is_primary = 1 WHERE id = ?')
        .run(role || existing.role || 'MEMBER', existingLink.id);
    } else {
      db.prepare('INSERT INTO region_personnel (region_id, person_id, role, is_primary) VALUES (?,?,?,1)')
        .run(Number(region_id), Number(req.params.id), role || existing.role || 'MEMBER');
    }
  }
  audit(req.user, 'UPDATE', 'person', Number(req.params.id), updates);
  res.json(get('person', Number(req.params.id)));
});

router.delete('/people/:id', (req, res) => {
  if (!can(req, 'people:write')) return res.status(403).json({ error: 'Forbidden: requires people:write' });
  const existing = get('person', req.params.id);
  if (!existing) return res.status(404).json({ error: 'Not found' });
  if (db.prepare('SELECT id FROM user WHERE person_id = ?').get(Number(req.params.id))) {
    return res.status(409).json({ error: 'Person is linked to a user account' });
  }
  db.prepare('DELETE FROM region_personnel WHERE person_id = ?').run(Number(req.params.id));
  db.prepare('DELETE FROM crew_member WHERE person_id = ?').run(Number(req.params.id));
  db.prepare('DELETE FROM certification WHERE person_id = ?').run(Number(req.params.id));
  safeDelete('person', Number(req.params.id));
  audit(req.user, 'DELETE', 'person', Number(req.params.id), { name: `${existing.first_name} ${existing.last_name}` });
  res.json({ ok: true });
});

router.get('/certifications', (req, res) => {
  let rows = list('certification');
  const { status, person_id } = req.query;
  if (!isGlobal(req.user)) {
    const crewIds = [...(regionWideRead(req.user) ? readCrewIds(req.user) : authorizedCrewIds(req.user))];
    const crews = list('crew').filter((c) => crewIds.includes(c.id));
    const validPeople = new Set(crewIds.length
      ? db.prepare(`SELECT person_id FROM crew_member WHERE active = 1 AND crew_id IN (${crewIds.map(() => '?').join(',')})`).all(...crewIds).map((x) => x.person_id)
      : []);
    for (const c of crews) if (c.leader_person_id) validPeople.add(c.leader_person_id);
    if ((!isManager(req.user) && !isCrewUser(req.user)) || regionWideRead(req.user)) {
      for (const p of list('region_personnel').filter((p) => p.region_id === req.user.region_id)) validPeople.add(p.person_id);
    }
    if (req.user.person_id) validPeople.add(req.user.person_id);
    rows = rows.filter((c) => validPeople.has(c.person_id));
  }
  if (status) rows = rows.filter((c) => c.status === status);
  if (person_id) rows = rows.filter((c) => c.person_id === Number(person_id));
  for (const c of rows) c.person = get('person', c.person_id);
  res.json(rows);
});

router.post('/certifications', (req, res) => {
  if (!can(req, 'cert:write')) return res.status(403).json({ error: 'Forbidden: requires cert:write' });
  const id = insertRow('certification', req.body);
  audit(req.user, 'CREATE', 'certification', id, req.body);
  res.status(201).json(get('certification', id));
});

router.put('/certifications/:id', (req, res) => {
  if (!can(req, 'cert:write')) return res.status(403).json({ error: 'Forbidden: requires cert:write' });
  const id = Number(req.params.id);
  const existing = get('certification', id);
  if (!existing) return res.status(404).json({ error: 'Certification not found' });
  updateRow('certification', id, req.body);
  audit(req.user, 'UPDATE', 'certification', id, req.body);
  res.json(get('certification', id));
});

router.delete('/certifications/:id', (req, res) => {
  if (!can(req, 'cert:write')) return res.status(403).json({ error: 'Forbidden: requires cert:write' });
  const id = Number(req.params.id);
  if (!get('certification', id)) return res.status(404).json({ error: 'Certification not found' });
  safeDelete('certification', id);
  audit(req.user, 'DELETE', 'certification', id, {});
  res.json({ ok: true });
});

router.post('/certifications/check-status', (req, res) => {
  if (!can(req, 'cert:write')) return res.status(403).json({ error: 'Forbidden: requires cert:write' });
  const now = new Date();
  const rows = list('certification');
  let updated = 0;
  for (const c of rows) {
    const target = new Date(c.expires_at) < now ? 'EXPIRED' : 'VALID';
    if (c.status !== target) {
      updateRow('certification', c.id, { status: target });
      updated++;
    }
  }
  audit(req.user, 'UPDATE', 'certification', 0, { action: 'check-status', updated });
  res.json({ ok: true, updated, total: rows.length });
});

module.exports = router;
