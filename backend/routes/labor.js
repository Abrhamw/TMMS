'use strict';

const express = require('express');
const { db, get, insertRow, byClientRef } = require('../util');
const { can, audit, isCrewUser, isOnCrew } = require('../auth');
const { taskVisible } = require('../authority');
const { TIME_KINDS, computeHours, resolveRate, costFor, taskLaborSummary } = require('../labor');

const router = express.Router();

const ENTRY_STATUSES = new Set(['DRAFT', 'SUBMITTED', 'APPROVED', 'REJECTED']);

function canSeeTask(req, t) {
  return t && taskVisible(req.user, t);
}

function canRecordTime(req, t) {
  if (can(req, 'task:execute') || can(req, 'task:manage') || can(req, 'task:assign')) return true;
  return isCrewUser(req.user) && isOnCrew(req.user, t.crew_id);
}

function validDate(value) {
  return typeof value === 'string' && value.trim() !== '' && !Number.isNaN(Date.parse(value));
}

// ---- Effective-dated labor rates (append-only) ----

router.get('/labor-rates', (req, res) => {
  if (!can(req, 'task:read')) return res.status(403).json({ error: "Forbidden: requires 'task:read'" });
  const params = [];
  let sql = 'SELECT * FROM labor_rate';
  if (req.query.person_id) {
    sql += ' WHERE person_id = ? OR person_id IS NULL';
    params.push(Number(req.query.person_id));
  }
  sql += ' ORDER BY effective_from DESC, id DESC';
  res.json(db.prepare(sql).all(...params));
});

router.post('/labor-rates', (req, res) => {
  if (req.user.role !== 'ADMIN') return res.status(403).json({ error: 'Forbidden: requires ADMIN' });
  const body = req.body || {};
  const hourlyRate = Number(body.hourly_rate);
  if (!Number.isFinite(hourlyRate) || hourlyRate < 0) {
    return res.status(400).json({ error: 'hourly_rate must be a non-negative number' });
  }
  if (!validDate(body.effective_from)) {
    return res.status(400).json({ error: 'effective_from must be a valid date' });
  }
  if (body.person_id != null && !get('person', Number(body.person_id))) {
    return res.status(400).json({ error: 'person not found' });
  }
  const id = insertRow('labor_rate', {
    person_id: body.person_id != null ? Number(body.person_id) : null,
    grade: body.grade || null,
    currency: body.currency || 'USD',
    hourly_rate: hourlyRate,
    effective_from: body.effective_from,
    notes: body.notes || null,
    created_by: req.user.person_id || null,
    created_at: new Date().toISOString(),
  });
  audit(req.user, 'CREATE', 'labor_rate', id, { person_id: body.person_id || null, hourly_rate: hourlyRate, effective_from: body.effective_from });
  res.status(201).json(get('labor_rate', id));
});

router.get('/people/:id/labor-rate', (req, res) => {
  if (!can(req, 'task:read')) return res.status(403).json({ error: "Forbidden: requires 'task:read'" });
  const person = get('person', Number(req.params.id));
  if (!person) return res.status(404).json({ error: 'Person not found' });
  const at = typeof req.query.at === 'string' && req.query.at ? req.query.at : null;
  res.json({ person_id: person.id, at: at || new Date().toISOString(), rate: resolveRate(person.id, at) });
});

// ---- Transaction-level labor capture ----

router.get('/tasks/:id/time-entries', (req, res) => {
  const t = get('task', Number(req.params.id));
  if (!canSeeTask(req, t)) return res.status(404).json({ error: 'Task not found' });
  const entries = db.prepare('SELECT * FROM time_entry WHERE task_id = ? ORDER BY work_date, id').all(t.id);
  res.json({ task_id: t.id, entries, summary: taskLaborSummary(t.id, { include: ['APPROVED', 'SUBMITTED'] }) });
});

router.post('/tasks/:id/time-entries', (req, res) => {
  const t = get('task', Number(req.params.id));
  if (!canSeeTask(req, t)) return res.status(404).json({ error: 'Task not found' });
  if (!canRecordTime(req, t)) {
    return res.status(403).json({ error: 'Forbidden: requires task:execute/manage or crew membership' });
  }
  if (t.status === 'CANCELLED') return res.status(409).json({ error: 'Cannot record time against a cancelled task' });

  const body = req.body || {};
  if (body.client_ref) {
    const existing = byClientRef('time_entry', body.client_ref);
    if (existing) return res.status(200).json(existing);
  }
  const kind = body.kind || 'NORMAL';
  if (!TIME_KINDS.has(kind)) {
    return res.status(400).json({ error: `kind must be one of: ${[...TIME_KINDS].join(', ')}` });
  }
  const personId = body.person_id != null ? Number(body.person_id) : req.user.person_id;
  if (!personId || !get('person', personId)) return res.status(400).json({ error: 'A valid person is required' });
  const workDate = body.work_date || (validDate(body.started_at) ? String(body.started_at).slice(0, 10) : null);
  if (!validDate(workDate)) return res.status(400).json({ error: 'work_date must be a valid date' });

  const hours = computeHours(body);
  if (hours <= 0) return res.status(400).json({ error: 'The entry must capture a positive number of hours' });
  const rate = resolveRate(personId, body.started_at || workDate);
  const status = body.submit ? 'SUBMITTED' : 'DRAFT';
  const now = new Date().toISOString();
  const id = insertRow('time_entry', {
    task_id: t.id,
    person_id: personId,
    crew_id: t.crew_id || null,
    work_date: workDate,
    kind,
    started_at: body.started_at || null,
    ended_at: body.ended_at || null,
    break_minutes: Number(body.break_minutes) || 0,
    travel_minutes: Number(body.travel_minutes) || 0,
    standby_minutes: Number(body.standby_minutes) || 0,
    overtime_minutes: Number(body.overtime_minutes) || 0,
    hours,
    hourly_rate: rate ? Number(rate.hourly_rate) : null,
    currency: rate ? rate.currency : (body.currency || 'USD'),
    labor_rate_id: rate ? rate.id : null,
    labor_cost: costFor(hours, rate),
    status,
    notes: body.notes || null,
    client_ref: body.client_ref || null,
    created_by: req.user.person_id || null,
    created_at: now,
    updated_at: now,
  });
  audit(req.user, 'CREATE', 'time_entry', id, { task_id: t.id, person_id: personId, hours, status });
  res.status(201).json(get('time_entry', id));
});

router.put('/time-entries/:id', (req, res) => {
  const entry = get('time_entry', Number(req.params.id));
  if (!entry) return res.status(404).json({ error: 'Time entry not found' });
  const t = get('task', entry.task_id);
  if (!canSeeTask(req, t)) return res.status(404).json({ error: 'Time entry not found' });
  if (entry.status !== 'DRAFT') {
    return res.status(409).json({ error: 'An approved or submitted entry is immutable; record an adjustment instead' });
  }
  const own = req.user.person_id && entry.person_id === req.user.person_id;
  if (!own && !can(req, 'task:manage')) return res.status(403).json({ error: 'Forbidden: not the entry owner' });

  const body = req.body || {};
  const merged = { ...entry, ...body };
  const kind = merged.kind || 'NORMAL';
  if (!TIME_KINDS.has(kind)) return res.status(400).json({ error: `kind must be one of: ${[...TIME_KINDS].join(', ')}` });
  const hours = computeHours(merged);
  const rate = resolveRate(entry.person_id, merged.started_at || merged.work_date);
  db.prepare(
    `UPDATE time_entry SET work_date = ?, kind = ?, started_at = ?, ended_at = ?, break_minutes = ?, travel_minutes = ?,
       standby_minutes = ?, overtime_minutes = ?, hours = ?, hourly_rate = ?, labor_rate_id = ?, labor_cost = ?,
       notes = ?, updated_at = ?, revision = revision + 1 WHERE id = ?`
  ).run(
    merged.work_date, kind, merged.started_at ?? null, merged.ended_at ?? null,
    Number(merged.break_minutes) || 0, Number(merged.travel_minutes) || 0, Number(merged.standby_minutes) || 0,
    Number(merged.overtime_minutes) || 0, hours, rate ? Number(rate.hourly_rate) : null, rate ? rate.id : null,
    costFor(hours, rate), merged.notes ?? null, new Date().toISOString(), entry.id
  );
  audit(req.user, 'UPDATE', 'time_entry', entry.id, { hours });
  res.json(get('time_entry', entry.id));
});

function decide(req, res, status) {
  const entry = get('time_entry', Number(req.params.id));
  if (!entry) return res.status(404).json({ error: 'Time entry not found' });
  const t = get('task', entry.task_id);
  if (!canSeeTask(req, t)) return res.status(404).json({ error: 'Time entry not found' });
  if (!can(req, 'task:manage') && !can(req, 'task:verify')) {
    return res.status(403).json({ error: 'Forbidden: requires task:manage or task:verify' });
  }
  if (!['SUBMITTED', 'DRAFT'].includes(entry.status)) {
    return res.status(409).json({ error: `Cannot ${status === 'APPROVED' ? 'approve' : 'reject'} a ${entry.status} entry` });
  }
  // Segregation: a manager may not approve their own labor unless they are the
  // platform administrator.
  if (status === 'APPROVED' && req.user.role !== 'ADMIN' && req.user.person_id && entry.person_id === req.user.person_id) {
    return res.status(403).json({ error: 'Forbidden: a time entry must be approved by someone else' });
  }
  const reason = String((req.body && req.body.reason) || '').trim();
  if (status === 'REJECTED' && !reason) return res.status(400).json({ error: 'A rejection reason is required' });
  db.prepare(
    `UPDATE time_entry SET status = ?, approved_by = ?, approved_at = ?, rejected_reason = ?, updated_at = ?, revision = revision + 1 WHERE id = ?`
  ).run(status, req.user.person_id || null, new Date().toISOString(), status === 'REJECTED' ? reason : null, new Date().toISOString(), entry.id);
  audit(req.user, status === 'APPROVED' ? 'APPROVE' : 'REJECT', 'time_entry', entry.id, { reason: reason || null });
  res.json(get('time_entry', entry.id));
}

router.post('/time-entries/:id/approve', (req, res) => decide(req, res, 'APPROVED'));
router.post('/time-entries/:id/reject', (req, res) => decide(req, res, 'REJECTED'));

router.get('/tasks/:id/labor-summary', (req, res) => {
  const t = get('task', Number(req.params.id));
  if (!canSeeTask(req, t)) return res.status(404).json({ error: 'Task not found' });
  const include = typeof req.query.include === 'string' && req.query.include
    ? req.query.include.split(',').map((s) => s.trim().toUpperCase()).filter((s) => ENTRY_STATUSES.has(s))
    : ['APPROVED'];
  res.json(taskLaborSummary(t.id, { include }));
});

module.exports = router;
