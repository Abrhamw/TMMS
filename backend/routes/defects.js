'use strict';

const express = require('express');
const { db, get, insertRow, byClientRef } = require('../util');
const { can, audit } = require('../auth');
const { taskVisible } = require('../authority');
const {
  DEFECT_SEVERITIES, DEFECT_LIKELIHOODS, ROOT_CAUSES, DISPOSITIONS,
  TERMINAL_STATUSES, TRANSITIONS, canTransition, riskScore, OPEN_DEFECT_STATUSES,
} = require('../defects');

const router = express.Router();

function canSeeTask(req, t) {
  return t && taskVisible(req.user, t);
}

function canManageDefects(req) {
  return req.user.role === 'ADMIN' || can(req, 'task:manage') || can(req, 'task:verify');
}

function listDefects(req) {
  const clauses = [];
  const params = [];
  if (req.query.status) { clauses.push('status = ?'); params.push(String(req.query.status)); }
  else if (req.query.open === '1') { clauses.push("status IN ('OPEN','IN_PROGRESS','MITIGATED','RESOLVED')"); }
  if (req.query.severity) { clauses.push('severity = ?'); params.push(String(req.query.severity)); }
  if (req.query.asset_id) { clauses.push('asset_id = ?'); params.push(Number(req.query.asset_id)); }
  if (req.query.region_id) { clauses.push('region_id = ?'); params.push(Number(req.query.region_id)); }
  if (req.query.owner_person_id) { clauses.push('owner_person_id = ?'); params.push(Number(req.query.owner_person_id)); }
  if (req.query.overdue === '1') { clauses.push("target_date IS NOT NULL AND target_date < ? AND status IN ('OPEN','IN_PROGRESS','MITIGATED','RESOLVED')"); params.push(new Date().toISOString()); }
  if (req.query.q) { clauses.push('(LOWER(title) LIKE ? OR LOWER(defect_number) LIKE ?)'); const q = `%${String(req.query.q).toLowerCase()}%`; params.push(q, q); }
  const sql = `SELECT * FROM defect${clauses.length ? ` WHERE ${clauses.join(' AND ')}` : ''} ORDER BY CASE severity WHEN 'CRITICAL' THEN 0 WHEN 'HIGH' THEN 1 WHEN 'MEDIUM' THEN 2 ELSE 3 END, id DESC`;
  return db.prepare(sql).all(...params);
}

router.get('/defects', (req, res) => {
  if (!can(req, 'task:read')) return res.status(403).json({ error: "Forbidden: requires 'task:read'" });
  const defects = listDefects(req).filter((d) => !d.task_id || canSeeTask(req, get('task', d.task_id)));
  res.json(defects);
});

router.post('/defects', (req, res) => {
  if (!canManageDefects(req)) return res.status(403).json({ error: "Forbidden: requires 'task:manage' or 'task:verify'" });
  const body = req.body || {};
  if (body.client_ref) {
    const existing = byClientRef('defect', body.client_ref);
    if (existing) return res.status(200).json(existing);
  }
  if (!body.title || String(body.title).trim() === '') return res.status(400).json({ error: 'title is required' });
  const severity = body.severity || 'MEDIUM';
  if (!DEFECT_SEVERITIES.has(severity)) return res.status(400).json({ error: `severity must be one of: ${[...DEFECT_SEVERITIES].join(', ')}` });
  const likelihood = body.likelihood || null;
  if (likelihood && !DEFECT_LIKELIHOODS.has(likelihood)) return res.status(400).json({ error: `likelihood must be one of: ${[...DEFECT_LIKELIHOODS].join(', ')}` });
  const taskId = body.task_id != null ? Number(body.task_id) : null;
  if (taskId != null && !get('task', taskId)) return res.status(400).json({ error: 'task not found' });
  const now = new Date().toISOString();
  const id = insertRow('defect', {
    defect_number: body.defect_number ? String(body.defect_number) : `DEF-${Date.now().toString(36).toUpperCase()}`,
    task_id: taskId,
    finding_id: body.finding_id != null ? Number(body.finding_id) : null,
    asset_id: body.asset_id != null ? Number(body.asset_id) : null,
    region_id: body.region_id != null ? Number(body.region_id) : null,
    title: String(body.title).trim(),
    description: body.description || null,
    severity,
    likelihood,
    risk_score: riskScore(severity, likelihood),
    status: 'OPEN',
    temporary_mitigation: body.temporary_mitigation || null,
    owner_person_id: body.owner_person_id != null ? Number(body.owner_person_id) : null,
    target_date: body.target_date || null,
    client_ref: body.client_ref || null,
    created_by: req.user.person_id || null,
    created_at: now,
    updated_at: now,
  });
  audit(req.user, 'CREATE', 'defect', id, { title: body.title, severity });
  res.status(201).json(get('defect', id));
});

router.get('/defects/:id', (req, res) => {
  if (!can(req, 'task:read')) return res.status(403).json({ error: "Forbidden: requires 'task:read'" });
  const d = get('defect', Number(req.params.id));
  if (!d) return res.status(404).json({ error: 'Defect not found' });
  if (d.task_id) {
    const t = get('task', d.task_id);
    if (!canSeeTask(req, t)) return res.status(404).json({ error: 'Defect not found' });
  }
  const corrective = d.corrective_task_id ? get('task', d.corrective_task_id) : null;
  res.json({ ...d, corrective_task: corrective, can_close: !!d.root_cause_category });
});

router.put('/defects/:id', (req, res) => {
  const d = get('defect', Number(req.params.id));
  if (!d) return res.status(404).json({ error: 'Defect not found' });
  if (d.task_id) {
    const t = get('task', d.task_id);
    if (!canSeeTask(req, t)) return res.status(404).json({ error: 'Defect not found' });
  }
  if (!canManageDefects(req)) return res.status(403).json({ error: "Forbidden: requires 'task:manage' or 'task:verify'" });
  if (TERMINAL_STATUSES.has(d.status)) return res.status(409).json({ error: `A ${d.status} defect is immutable; reopen it first` });
  const body = req.body || {};
  const patch = {
    title: body.title != null ? String(body.title).trim() : undefined,
    description: body.description,
    severity: body.severity,
    likelihood: body.likelihood,
    temporary_mitigation: body.temporary_mitigation,
    owner_person_id: body.owner_person_id != null ? Number(body.owner_person_id) : undefined,
    target_date: body.target_date,
    updated_at: new Date().toISOString(),
  };
  if (patch.severity != null && !DEFECT_SEVERITIES.has(patch.severity)) return res.status(400).json({ error: 'invalid severity' });
  if (patch.likelihood != null && patch.likelihood !== null && !DEFECT_LIKELIHOODS.has(patch.likelihood)) return res.status(400).json({ error: 'invalid likelihood' });
  const clean = Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined));
  if (clean.severity || clean.likelihood) {
    clean.risk_score = riskScore(clean.severity || d.severity, clean.likelihood !== undefined ? clean.likelihood : d.likelihood);
  }
  const sets = Object.keys(clean).map((k) => `${k} = ?`).join(', ');
  db.prepare(`UPDATE defect SET ${sets}, revision = revision + 1 WHERE id = ?`).run(...Object.values(clean), d.id);
  audit(req.user, 'UPDATE', 'defect', d.id, clean);
  res.json(get('defect', d.id));
});

router.post('/defects/:id/root-cause', (req, res) => {
  const d = get('defect', Number(req.params.id));
  if (!d) return res.status(404).json({ error: 'Defect not found' });
  if (d.task_id) {
    const t = get('task', d.task_id);
    if (!canSeeTask(req, t)) return res.status(404).json({ error: 'Defect not found' });
  }
  if (!canManageDefects(req)) return res.status(403).json({ error: "Forbidden: requires 'task:manage' or 'task:verify'" });
  const category = req.body && req.body.category;
  if (!ROOT_CAUSES.has(category)) return res.status(400).json({ error: `category must be one of: ${[...ROOT_CAUSES].join(', ')}` });
  db.prepare('UPDATE defect SET root_cause_category = ?, root_cause_detail = ?, updated_at = ?, revision = revision + 1 WHERE id = ?')
    .run(category, (req.body && req.body.detail) || null, new Date().toISOString(), d.id);
  audit(req.user, 'ROOT_CAUSE', 'defect', d.id, { category });
  res.json(get('defect', d.id));
});

router.post('/defects/:id/link-task', (req, res) => {
  const d = get('defect', Number(req.params.id));
  if (!d) return res.status(404).json({ error: 'Defect not found' });
  if (d.task_id) {
    const t = get('task', d.task_id);
    if (!canSeeTask(req, t)) return res.status(404).json({ error: 'Defect not found' });
  }
  if (!canManageDefects(req)) return res.status(403).json({ error: "Forbidden: requires 'task:manage' or 'task:verify'" });
  const correctiveTaskId = Number(req.body && req.body.task_id);
  if (!get('task', correctiveTaskId)) return res.status(400).json({ error: 'corrective task not found' });
  db.prepare("UPDATE defect SET corrective_task_id = ?, status = CASE WHEN status = 'OPEN' THEN 'IN_PROGRESS' ELSE status END, updated_at = ?, revision = revision + 1 WHERE id = ?")
    .run(correctiveTaskId, new Date().toISOString(), d.id);
  audit(req.user, 'LINK', 'defect', d.id, { corrective_task_id: correctiveTaskId });
  res.json(get('defect', d.id));
});

router.post('/defects/:id/status', (req, res) => {
  const d = get('defect', Number(req.params.id));
  if (!d) return res.status(404).json({ error: 'Defect not found' });
  if (d.task_id) {
    const t = get('task', d.task_id);
    if (!canSeeTask(req, t)) return res.status(404).json({ error: 'Defect not found' });
  }
  if (!canManageDefects(req)) return res.status(403).json({ error: "Forbidden: requires 'task:manage' or 'task:verify'" });
  const status = req.body && req.body.status;
  if (!canTransition(d.status, status)) return res.status(409).json({ error: `Cannot move defect from ${d.status} to ${status}`, allowed: TRANSITIONS[d.status] || [] });

  const body = req.body || {};
  if (status === 'RESOLVED' || status === 'CLOSED') {
    if (!d.root_cause_category) return res.status(409).json({ error: 'A root cause must be recorded before resolving or closing a defect', code: 'ROOT_CAUSE_REQUIRED' });
    if (d.corrective_task_id) {
      const ct = get('task', d.corrective_task_id);
      const verified = ct && (ct.status === 'COMPLETED' || ct.closure_state === 'CLOSED');
      if (!verified) return res.status(409).json({ error: 'The linked corrective task must be verified before the defect can be resolved', code: 'CORRECTIVE_TASK_OPEN' });
    }
  }
  if (status === 'CLOSED' || status === 'ACCEPTED') {
    const disposition = body.disposition || (status === 'ACCEPTED' ? (d.disposition || 'ACCEPTED_RISK') : null);
    if (!DISPOSITIONS.has(disposition)) {
      return res.status(400).json({ error: `A disposition is required; one of: ${[...DISPOSITIONS].join(', ')}` });
    }
  }
  const now = new Date().toISOString();
  const patch = { status, updated_at: now };
  if (status === 'RESOLVED') patch.verified_at = now;
  if (status === 'CLOSED') { patch.closed_at = now; patch.closed_by = req.user.person_id || null; if (body.disposition) patch.disposition = body.disposition; }
  if (status === 'ACCEPTED') patch.disposition = body.disposition || 'ACCEPTED_RISK';
  const sets = Object.keys(patch).map((k) => `${k} = ?`).join(', ');
  db.prepare(`UPDATE defect SET ${sets}, revision = revision + 1 WHERE id = ?`).run(...Object.values(patch), d.id);
  audit(req.user, 'STATUS', 'defect', d.id, { from: d.status, to: status, disposition: patch.disposition || null });
  res.json(get('defect', d.id));
});

router.get('/tasks/:id/defects', (req, res) => {
  const t = get('task', Number(req.params.id));
  if (!canSeeTask(req, t)) return res.status(404).json({ error: 'Task not found' });
  const defects = db.prepare('SELECT * FROM defect WHERE task_id = ? ORDER BY id').all(t.id);
  res.json({ task_id: t.id, total: defects.length, open: defects.filter((d) => OPEN_DEFECT_STATUSES.has(d.status)).length, defects });
});

module.exports = router;
