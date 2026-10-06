'use strict';

const express = require('express');
const { db, get, insertRow, nextCode, byClientRef } = require('../util');
const { can, audit, isCrewUser, isOnCrew } = require('../auth');
const { taskVisible } = require('../authority');
const {
  RESOURCE_CATEGORIES, RESOURCE_STATUSES, effectiveStatus, isUsable,
  findConflicts, usageHours, usageCost, taskResourceSummary,
} = require('../resources');

const router = express.Router();

function canSeeTask(req, t) {
  return t && taskVisible(req.user, t);
}

function canFieldCapture(req, t) {
  if (can(req, 'task:execute') || can(req, 'task:manage') || can(req, 'task:assign')) return true;
  return isCrewUser(req.user) && isOnCrew(req.user, t.crew_id);
}

function canManageResources(req) {
  return req.user.role === 'ADMIN' || can(req, 'task:manage');
}

function withStatus(r, at) {
  const when = at || new Date().toISOString();
  return { ...r, effective_status: effectiveStatus(r, when), usable: isUsable(r, when) };
}

// ---- Maintenance resource register ----

router.get('/resources', (req, res) => {
  if (!can(req, 'task:read')) return res.status(403).json({ error: "Forbidden: requires 'task:read'" });
  const clauses = [];
  const params = [];
  if (req.query.category) { clauses.push('category = ?'); params.push(String(req.query.category)); }
  if (req.query.status) { clauses.push('status = ?'); params.push(String(req.query.status)); }
  if (req.query.region_id) { clauses.push('home_region_id = ?'); params.push(Number(req.query.region_id)); }
  if (req.query.custodian_person_id) { clauses.push('custodian_person_id = ?'); params.push(Number(req.query.custodian_person_id)); }
  if (req.query.active === '0') clauses.push('active = 0');
  else if (req.query.active !== 'all') clauses.push('active = 1');
  if (req.query.q) { clauses.push('(LOWER(name) LIKE ? OR LOWER(code) LIKE ? OR LOWER(IFNULL(serial_number, \'\')) LIKE ?)'); const q = `%${String(req.query.q).toLowerCase()}%`; params.push(q, q, q); }
  const sql = `SELECT * FROM maintenance_resource${clauses.length ? ` WHERE ${clauses.join(' AND ')}` : ''} ORDER BY category, name`;
  const at = typeof req.query.at === 'string' && req.query.at ? req.query.at : null;
  res.json(db.prepare(sql).all(...params).map((r) => withStatus(r, at)));
});

router.post('/resources', (req, res) => {
  if (!canManageResources(req)) return res.status(403).json({ error: "Forbidden: requires 'task:manage' or ADMIN" });
  const body = req.body || {};
  if (!body.name || String(body.name).trim() === '') return res.status(400).json({ error: 'name is required' });
  const category = body.category || 'TOOL';
  if (!RESOURCE_CATEGORIES.has(category)) return res.status(400).json({ error: `category must be one of: ${[...RESOURCE_CATEGORIES].join(', ')}` });
  const status = body.status || 'AVAILABLE';
  if (!RESOURCE_STATUSES.has(status)) return res.status(400).json({ error: `status must be one of: ${[...RESOURCE_STATUSES].join(', ')}` });
  if (body.cost_rate != null && (!Number.isFinite(Number(body.cost_rate)) || Number(body.cost_rate) < 0)) {
    return res.status(400).json({ error: 'cost_rate must be a non-negative number' });
  }
  const now = new Date().toISOString();
  const id = insertRow('maintenance_resource', {
    code: body.code ? String(body.code) : nextCode('RES', 'maintenance_resource', 'code', 4),
    name: String(body.name).trim(),
    category,
    status,
    serial_number: body.serial_number || null,
    location: body.location || null,
    home_region_id: body.home_region_id != null ? Number(body.home_region_id) : null,
    custodian_person_id: body.custodian_person_id != null ? Number(body.custodian_person_id) : null,
    capacity: body.capacity || null,
    calibration_expiry: body.calibration_expiry || null,
    certification_required: body.certification_required || null,
    operating_hours: Number(body.operating_hours) || 0,
    odometer: Number(body.odometer) || 0,
    cost_rate: body.cost_rate != null ? Number(body.cost_rate) : null,
    currency: body.currency || 'USD',
    notes: body.notes || null,
    active: 1,
    created_at: now,
    updated_at: now,
  });
  audit(req.user, 'CREATE', 'maintenance_resource', id, { name: body.name, category });
  res.status(201).json(withStatus(get('maintenance_resource', id)));
});

router.get('/resources/:id', (req, res) => {
  if (!can(req, 'task:read')) return res.status(403).json({ error: "Forbidden: requires 'task:read'" });
  const r = get('maintenance_resource', Number(req.params.id));
  if (!r) return res.status(404).json({ error: 'Resource not found' });
  const at = typeof req.query.at === 'string' && req.query.at ? req.query.at : null;
  const reservations = db.prepare(
    "SELECT * FROM resource_reservation WHERE resource_id = ? AND status = 'RESERVED' ORDER BY reserved_from"
  ).all(r.id);
  const usage = db.prepare('SELECT COUNT(*) c, IFNULL(SUM(operating_hours),0) h, IFNULL(SUM(cost),0) cost FROM resource_usage WHERE resource_id = ? AND status = ?').get(r.id, 'APPROVED');
  res.json({ ...withStatus(r, at), reservations, usage_totals: { entries: usage.c, operating_hours: usage.h, cost: usage.cost } });
});

router.put('/resources/:id', (req, res) => {
  if (!canManageResources(req)) return res.status(403).json({ error: "Forbidden: requires 'task:manage' or ADMIN" });
  const r = get('maintenance_resource', Number(req.params.id));
  if (!r) return res.status(404).json({ error: 'Resource not found' });
  const body = req.body || {};
  if (body.category != null && !RESOURCE_CATEGORIES.has(body.category)) return res.status(400).json({ error: 'invalid category' });
  const patch = {
    name: body.name != null ? String(body.name).trim() : undefined,
    category: body.category,
    serial_number: body.serial_number,
    location: body.location,
    home_region_id: body.home_region_id != null ? Number(body.home_region_id) : undefined,
    custodian_person_id: body.custodian_person_id != null ? Number(body.custodian_person_id) : undefined,
    capacity: body.capacity,
    calibration_expiry: body.calibration_expiry,
    certification_required: body.certification_required,
    operating_hours: body.operating_hours != null ? Number(body.operating_hours) : undefined,
    odometer: body.odometer != null ? Number(body.odometer) : undefined,
    cost_rate: body.cost_rate != null ? Number(body.cost_rate) : undefined,
    currency: body.currency,
    notes: body.notes,
    active: body.active != null ? (body.active ? 1 : 0) : undefined,
    updated_at: new Date().toISOString(),
  };
  const clean = Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined));
  const sets = Object.keys(clean).map((k) => `${k} = ?`).join(', ');
  db.prepare(`UPDATE maintenance_resource SET ${sets}, revision = revision + 1 WHERE id = ?`).run(...Object.values(clean), r.id);
  audit(req.user, 'UPDATE', 'maintenance_resource', r.id, clean);
  res.json(withStatus(get('maintenance_resource', r.id)));
});

router.post('/resources/:id/status', (req, res) => {
  if (!canManageResources(req)) return res.status(403).json({ error: "Forbidden: requires 'task:manage' or ADMIN" });
  const r = get('maintenance_resource', Number(req.params.id));
  if (!r) return res.status(404).json({ error: 'Resource not found' });
  const status = req.body && req.body.status;
  if (!RESOURCE_STATUSES.has(status)) return res.status(400).json({ error: `status must be one of: ${[...RESOURCE_STATUSES].join(', ')}` });
  db.prepare('UPDATE maintenance_resource SET status = ?, updated_at = ?, revision = revision + 1 WHERE id = ?')
    .run(status, new Date().toISOString(), r.id);
  audit(req.user, 'STATUS', 'maintenance_resource', r.id, { status });
  res.json(withStatus(get('maintenance_resource', r.id)));
});

// ---- Reservation against a task ----

router.get('/tasks/:id/reservations', (req, res) => {
  const t = get('task', Number(req.params.id));
  if (!canSeeTask(req, t)) return res.status(404).json({ error: 'Task not found' });
  const reservations = db.prepare('SELECT * FROM resource_reservation WHERE task_id = ? ORDER BY reserved_from').all(t.id);
  res.json({ task_id: t.id, reservations });
});

router.post('/tasks/:id/reservations', (req, res) => {
  const t = get('task', Number(req.params.id));
  if (!canSeeTask(req, t)) return res.status(404).json({ error: 'Task not found' });
  if (!canManageResources(req) && !canFieldCapture(req, t)) {
    return res.status(403).json({ error: 'Forbidden: requires task:manage or crew membership' });
  }
  const body = req.body || {};
  if (body.client_ref) {
    const existing = byClientRef('resource_reservation', body.client_ref);
    if (existing) return res.status(200).json(existing);
  }
  const resource = get('maintenance_resource', Number(body.resource_id));
  if (!resource || resource.active === 0) return res.status(400).json({ error: 'A valid active resource is required' });
  if (!body.reserved_from || !body.reserved_to || Number.isNaN(Date.parse(body.reserved_from)) || Number.isNaN(Date.parse(body.reserved_to))) {
    return res.status(400).json({ error: 'reserved_from and reserved_to must be valid dates' });
  }
  if (Date.parse(body.reserved_to) <= Date.parse(body.reserved_from)) {
    return res.status(400).json({ error: 'reserved_to must be after reserved_from' });
  }
  if (!isUsable(resource, body.reserved_from)) {
    return res.status(409).json({ error: 'Resource is not available for the requested window', code: 'RESOURCE_UNAVAILABLE', effective_status: effectiveStatus(resource, body.reserved_from) });
  }
  const conflicts = findConflicts(resource.id, body.reserved_from, body.reserved_to);
  if (conflicts.length) {
    return res.status(409).json({ error: 'Resource already reserved for an overlapping window', code: 'RESOURCE_CONFLICT', conflicts });
  }
  const now = new Date().toISOString();
  const id = insertRow('resource_reservation', {
    resource_id: resource.id,
    task_id: t.id,
    reserved_from: body.reserved_from,
    reserved_to: body.reserved_to,
    status: 'RESERVED',
    reserved_by: req.user.person_id || null,
    notes: body.notes || null,
    client_ref: body.client_ref || null,
    created_at: now,
    updated_at: now,
  });
  audit(req.user, 'RESERVE', 'resource_reservation', id, { task_id: t.id, resource_id: resource.id, reserved_from: body.reserved_from, reserved_to: body.reserved_to });
  res.status(201).json(get('resource_reservation', id));
});

router.post('/reservations/:id/cancel', (req, res) => {
  const rv = get('resource_reservation', Number(req.params.id));
  if (!rv) return res.status(404).json({ error: 'Reservation not found' });
  const t = get('task', rv.task_id);
  if (!canSeeTask(req, t)) return res.status(404).json({ error: 'Reservation not found' });
  if (!canManageResources(req) && !canFieldCapture(req, t)) return res.status(403).json({ error: 'Forbidden' });
  if (rv.status !== 'RESERVED') return res.status(409).json({ error: `Cannot cancel a ${rv.status} reservation` });
  db.prepare('UPDATE resource_reservation SET status = ?, updated_at = ? WHERE id = ?').run('CANCELLED', new Date().toISOString(), rv.id);
  audit(req.user, 'CANCEL', 'resource_reservation', rv.id, {});
  res.json(get('resource_reservation', rv.id));
});

// ---- Actual usage against a task ----

router.get('/tasks/:id/resource-usage', (req, res) => {
  const t = get('task', Number(req.params.id));
  if (!canSeeTask(req, t)) return res.status(404).json({ error: 'Task not found' });
  const usage = db.prepare('SELECT * FROM resource_usage WHERE task_id = ? ORDER BY started_at, id').all(t.id);
  res.json({ task_id: t.id, usage, summary: taskResourceSummary(t.id, { include: ['APPROVED', 'SUBMITTED'] }) });
});

router.post('/tasks/:id/resource-usage', (req, res) => {
  const t = get('task', Number(req.params.id));
  if (!canSeeTask(req, t)) return res.status(404).json({ error: 'Task not found' });
  if (!canFieldCapture(req, t)) {
    return res.status(403).json({ error: 'Forbidden: requires task:execute/manage or crew membership' });
  }
  if (t.status === 'CANCELLED') return res.status(409).json({ error: 'Cannot record usage against a cancelled task' });
  const body = req.body || {};
  if (body.client_ref) {
    const existing = byClientRef('resource_usage', body.client_ref);
    if (existing) return res.status(200).json(existing);
  }
  const resource = get('maintenance_resource', Number(body.resource_id));
  if (!resource) return res.status(400).json({ error: 'A valid resource is required' });
  if (body.reservation_id) {
    const rv = get('resource_reservation', Number(body.reservation_id));
    if (!rv || rv.task_id !== t.id || rv.resource_id !== resource.id) {
      return res.status(400).json({ error: 'reservation_id does not match this task and resource' });
    }
  }
  const hours = usageHours(body);
  if (hours <= 0) return res.status(400).json({ error: 'usage must capture a positive number of operating hours' });
  const cost = usageCost({ ...body, operating_hours: hours }, resource);
  const now = new Date().toISOString();
  const id = insertRow('resource_usage', {
    resource_id: resource.id,
    reservation_id: body.reservation_id != null ? Number(body.reservation_id) : null,
    task_id: t.id,
    crew_id: t.crew_id || null,
    started_at: body.started_at || null,
    ended_at: body.ended_at || null,
    operating_hours: hours,
    odometer_start: body.odometer_start != null ? Number(body.odometer_start) : null,
    odometer_end: body.odometer_end != null ? Number(body.odometer_end) : null,
    cost_rate: body.cost_rate != null ? Number(body.cost_rate) : (resource.cost_rate != null ? Number(resource.cost_rate) : null),
    currency: resource.currency || body.currency || 'USD',
    cost,
    notes: body.notes || null,
    status: body.submit ? 'SUBMITTED' : 'DRAFT',
    client_ref: body.client_ref || null,
    created_by: req.user.person_id || null,
    created_at: now,
    updated_at: now,
  });
  audit(req.user, 'CREATE', 'resource_usage', id, { task_id: t.id, resource_id: resource.id, operating_hours: hours, cost });
  res.status(201).json(get('resource_usage', id));
});

router.put('/resource-usage/:id', (req, res) => {
  const u = get('resource_usage', Number(req.params.id));
  if (!u) return res.status(404).json({ error: 'Usage entry not found' });
  const t = get('task', u.task_id);
  if (!canSeeTask(req, t)) return res.status(404).json({ error: 'Usage entry not found' });
  if (u.status !== 'DRAFT') return res.status(409).json({ error: 'Use a new adjustment entry against a closed usage record' });
  const own = req.user.person_id && u.created_by === req.user.person_id;
  if (!own && !canManageResources(req)) return res.status(403).json({ error: 'Forbidden: not the entry owner' });
  const body = req.body || {};
  const merged = { ...u, ...body };
  const resource = get('maintenance_resource', u.resource_id);
  const hours = usageHours(merged);
  const cost = usageCost({ ...merged, operating_hours: hours }, resource);
  db.prepare(
    `UPDATE resource_usage SET started_at = ?, ended_at = ?, operating_hours = ?, odometer_start = ?, odometer_end = ?,
       cost_rate = ?, cost = ?, notes = ?, updated_at = ?, revision = revision + 1 WHERE id = ?`
  ).run(
    merged.started_at || null, merged.ended_at || null, hours,
    merged.odometer_start != null ? Number(merged.odometer_start) : null,
    merged.odometer_end != null ? Number(merged.odometer_end) : null,
    merged.cost_rate != null ? Number(merged.cost_rate) : (resource && resource.cost_rate != null ? Number(resource.cost_rate) : null),
    cost, merged.notes || null, new Date().toISOString(), u.id
  );
  audit(req.user, 'UPDATE', 'resource_usage', u.id, { operating_hours: hours, cost });
  res.json(get('resource_usage', u.id));
});

function decideUsage(req, res, status) {
  const u = get('resource_usage', Number(req.params.id));
  if (!u) return res.status(404).json({ error: 'Usage entry not found' });
  const t = get('task', u.task_id);
  if (!canSeeTask(req, t)) return res.status(404).json({ error: 'Usage entry not found' });
  if (!can(req, 'task:manage') && !can(req, 'task:verify')) {
    return res.status(403).json({ error: 'Forbidden: requires task:manage or task:verify' });
  }
  if (!['DRAFT', 'SUBMITTED'].includes(u.status)) {
    return res.status(409).json({ error: `Cannot ${status === 'APPROVED' ? 'approve' : 'reject'} a ${u.status} entry` });
  }
  if (status === 'APPROVED' && req.user.role !== 'ADMIN' && req.user.person_id && u.created_by === req.user.person_id) {
    return res.status(403).json({ error: 'Forbidden: a usage entry must be approved by someone else' });
  }
  const reason = String((req.body && req.body.reason) || '').trim();
  if (status === 'REJECTED' && !reason) return res.status(400).json({ error: 'A rejection reason is required' });
  db.prepare(
    'UPDATE resource_usage SET status = ?, approved_by = ?, approved_at = ?, rejected_reason = ?, updated_at = ?, revision = revision + 1 WHERE id = ?'
  ).run(status, req.user.person_id || null, new Date().toISOString(), status === 'REJECTED' ? reason : null, new Date().toISOString(), u.id);
  audit(req.user, status === 'APPROVED' ? 'APPROVE' : 'REJECT', 'resource_usage', u.id, { reason: reason || null });
  res.json(get('resource_usage', u.id));
}

router.post('/resource-usage/:id/approve', (req, res) => decideUsage(req, res, 'APPROVED'));
router.post('/resource-usage/:id/reject', (req, res) => decideUsage(req, res, 'REJECTED'));

router.get('/tasks/:id/resource-summary', (req, res) => {
  const t = get('task', Number(req.params.id));
  if (!canSeeTask(req, t)) return res.status(404).json({ error: 'Task not found' });
  const include = typeof req.query.include === 'string' && req.query.include
    ? req.query.include.split(',').map((s) => s.trim().toUpperCase()).filter((s) => ['DRAFT', 'SUBMITTED', 'APPROVED', 'REJECTED'].includes(s))
    : ['APPROVED'];
  res.json(taskResourceSummary(t.id, { include }));
});

module.exports = router;
