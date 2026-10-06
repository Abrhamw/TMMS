'use strict';

const express = require('express');
const { db, get, insertRow, list, byClientRef } = require('../util');
const { can, audit } = require('../auth');
const { taskVisible } = require('../authority');
const { COST_CATEGORIES, COMMITMENT_STATUSES, taskCostSummary, closureGates } = require('../costing');

const router = express.Router();

function canSeeTask(req, t) {
  return t && taskVisible(req.user, t);
}

function canManageCost(req) {
  return req.user.role === 'ADMIN' || can(req, 'task:manage');
}

function loadTaskFor(req, res) {
  const t = get('task', Number(req.params.id));
  if (!canSeeTask(req, t)) { res.status(404).json({ error: 'Task not found' }); return null; }
  return t;
}

router.get('/tasks/:id/cost', (req, res) => {
  const t = loadTaskFor(req, res);
  if (!t) return;
  res.json(taskCostSummary(t.id));
});

router.get('/tasks/:id/closure', (req, res) => {
  const t = loadTaskFor(req, res);
  if (!t) return;
  const evaluation = closureGates(t);
  res.json({ task_id: t.id, status: t.status, closure_state: t.closure_state || 'OPEN', ...evaluation, cost: taskCostSummary(t.id) });
});

// ---- Planned cost (estimates) ----

router.get('/tasks/:id/cost-estimates', (req, res) => {
  const t = loadTaskFor(req, res);
  if (!t) return;
  res.json({ task_id: t.id, planned_cost: taskCostSummary(t.id).planned_cost, estimates: list('cost_estimate', [], 'id').filter((e) => e.task_id === t.id) });
});

router.post('/tasks/:id/cost-estimates', (req, res) => {
  const t = loadTaskFor(req, res);
  if (!t) return;
  if (!canManageCost(req)) return res.status(403).json({ error: "Forbidden: requires 'task:manage' or ADMIN" });
  const body = req.body || {};
  const category = body.category || 'OTHER';
  if (!COST_CATEGORIES.has(category)) return res.status(400).json({ error: `category must be one of: ${[...COST_CATEGORIES].join(', ')}` });
  let amount = body.amount != null ? Number(body.amount) : NaN;
  if (!Number.isFinite(amount) && body.quantity != null && body.unit_cost != null) amount = Number(body.quantity) * Number(body.unit_cost);
  if (!Number.isFinite(amount) || amount < 0) return res.status(400).json({ error: 'a non-negative amount (or quantity and unit_cost) is required' });
  const now = new Date().toISOString();
  const id = insertRow('cost_estimate', {
    task_id: t.id, category, description: body.description || null,
    quantity: body.quantity != null ? Number(body.quantity) : null,
    unit_cost: body.unit_cost != null ? Number(body.unit_cost) : null,
    amount: Math.round(amount * 100) / 100, currency: body.currency || 'USD',
    created_by: req.user.person_id || null, created_at: now, updated_at: now,
  });
  audit(req.user, 'CREATE', 'cost_estimate', id, { task_id: t.id, category, amount });
  res.status(201).json(get('cost_estimate', id));
});

router.put('/cost-estimates/:id', (req, res) => {
  const e = get('cost_estimate', Number(req.params.id));
  if (!e) return res.status(404).json({ error: 'Estimate not found' });
  const t = get('task', e.task_id);
  if (!canSeeTask(req, t)) return res.status(404).json({ error: 'Estimate not found' });
  if (!canManageCost(req)) return res.status(403).json({ error: "Forbidden: requires 'task:manage' or ADMIN" });
  const body = req.body || {};
  const patch = {
    category: body.category, description: body.description,
    quantity: body.quantity != null ? Number(body.quantity) : undefined,
    unit_cost: body.unit_cost != null ? Number(body.unit_cost) : undefined,
    amount: body.amount != null ? Number(body.amount) : undefined,
    currency: body.currency, updated_at: new Date().toISOString(),
  };
  const clean = Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined));
  if (clean.category != null && !COST_CATEGORIES.has(clean.category)) return res.status(400).json({ error: 'invalid category' });
  const sets = Object.keys(clean).map((k) => `${k} = ?`).join(', ');
  db.prepare(`UPDATE cost_estimate SET ${sets}, revision = revision + 1 WHERE id = ?`).run(...Object.values(clean), e.id);
  audit(req.user, 'UPDATE', 'cost_estimate', e.id, clean);
  res.json(get('cost_estimate', e.id));
});

// ---- Committed cost ----

router.get('/tasks/:id/cost-commitments', (req, res) => {
  const t = loadTaskFor(req, res);
  if (!t) return;
  res.json({ task_id: t.id, committed_cost: taskCostSummary(t.id).committed_cost, commitments: list('cost_commitment', [], 'id').filter((c) => c.task_id === t.id) });
});

router.post('/tasks/:id/cost-commitments', (req, res) => {
  const t = loadTaskFor(req, res);
  if (!t) return;
  if (!canManageCost(req)) return res.status(403).json({ error: "Forbidden: requires 'task:manage' or ADMIN" });
  const body = req.body || {};
  const category = body.category || 'OTHER';
  if (!COST_CATEGORIES.has(category)) return res.status(400).json({ error: `category must be one of: ${[...COST_CATEGORIES].join(', ')}` });
  const amount = Number(body.amount);
  if (!Number.isFinite(amount) || amount < 0) return res.status(400).json({ error: 'a non-negative amount is required' });
  const now = new Date().toISOString();
  const id = insertRow('cost_commitment', {
    task_id: t.id, category, description: body.description || null,
    amount: Math.round(amount * 100) / 100, currency: body.currency || 'USD',
    reference: body.reference || null, status: body.status || 'OPEN',
    committed_by: req.user.person_id || null, created_at: now, updated_at: now,
  });
  audit(req.user, 'CREATE', 'cost_commitment', id, { task_id: t.id, category, amount });
  res.status(201).json(get('cost_commitment', id));
});

router.post('/cost-commitments/:id/status', (req, res) => {
  const c = get('cost_commitment', Number(req.params.id));
  if (!c) return res.status(404).json({ error: 'Commitment not found' });
  const t = get('task', c.task_id);
  if (!canSeeTask(req, t)) return res.status(404).json({ error: 'Commitment not found' });
  if (!canManageCost(req)) return res.status(403).json({ error: "Forbidden: requires 'task:manage' or ADMIN" });
  const status = req.body && req.body.status;
  if (!COMMITMENT_STATUSES.has(status)) return res.status(400).json({ error: `status must be one of: ${[...COMMITMENT_STATUSES].join(', ')}` });
  db.prepare('UPDATE cost_commitment SET status = ?, updated_at = ?, revision = revision + 1 WHERE id = ?').run(status, new Date().toISOString(), c.id);
  audit(req.user, 'STATUS', 'cost_commitment', c.id, { status });
  res.json(get('cost_commitment', c.id));
});

// ---- Actual direct cost transactions ----

router.get('/tasks/:id/cost-transactions', (req, res) => {
  const t = loadTaskFor(req, res);
  if (!t) return;
  res.json({ task_id: t.id, transactions: list('cost_transaction', [], 'id').filter((c) => c.task_id === t.id) });
});

router.post('/tasks/:id/cost-transactions', (req, res) => {
  const t = loadTaskFor(req, res);
  if (!t) return;
  if (!canManageCost(req) && !can(req, 'task:verify')) return res.status(403).json({ error: "Forbidden: requires 'task:manage', 'task:verify' or ADMIN" });
  const body = req.body || {};
  if (body.client_ref) {
    const existing = byClientRef('cost_transaction', body.client_ref);
    if (existing) return res.status(200).json(existing);
  }
  const category = body.category || 'OTHER';
  if (!COST_CATEGORIES.has(category)) return res.status(400).json({ error: `category must be one of: ${[...COST_CATEGORIES].join(', ')}` });
  const amount = Number(body.amount);
  if (!Number.isFinite(amount) || amount < 0) return res.status(400).json({ error: 'a non-negative amount is required' });
  const now = new Date().toISOString();
  const id = insertRow('cost_transaction', {
    task_id: t.id, category, description: body.description || null,
    amount: Math.round(amount * 100) / 100, currency: body.currency || 'USD',
    incurred_on: body.incurred_on || null, status: 'DRAFT',
    client_ref: body.client_ref || null, created_by: req.user.person_id || null,
    created_at: now, updated_at: now,
  });
  audit(req.user, 'CREATE', 'cost_transaction', id, { task_id: t.id, category, amount });
  res.status(201).json(get('cost_transaction', id));
});

function decideCost(req, res, status) {
  const c = get('cost_transaction', Number(req.params.id));
  if (!c) return res.status(404).json({ error: 'Cost transaction not found' });
  const t = get('task', c.task_id);
  if (!canSeeTask(req, t)) return res.status(404).json({ error: 'Cost transaction not found' });
  if (!canManageCost(req) && !can(req, 'task:verify')) return res.status(403).json({ error: "Forbidden: requires 'task:manage' or 'task:verify'" });
  if (c.status !== 'DRAFT') return res.status(409).json({ error: `Cannot decide a ${c.status} transaction` });
  if (status === 'APPROVED' && req.user.role !== 'ADMIN' && req.user.person_id && c.created_by === req.user.person_id) {
    return res.status(403).json({ error: 'Forbidden: a cost transaction must be approved by someone else' });
  }
  const reason = String((req.body && req.body.reason) || '').trim();
  if (status === 'REJECTED' && !reason) return res.status(400).json({ error: 'A rejection reason is required' });
  db.prepare('UPDATE cost_transaction SET status = ?, approved_by = ?, approved_at = ?, rejected_reason = ?, updated_at = ?, revision = revision + 1 WHERE id = ?')
    .run(status, req.user.person_id || null, new Date().toISOString(), status === 'REJECTED' ? reason : null, new Date().toISOString(), c.id);
  audit(req.user, status === 'APPROVED' ? 'APPROVE' : 'REJECT', 'cost_transaction', c.id, { reason: reason || null });
  res.json(get('cost_transaction', c.id));
}

router.post('/cost-transactions/:id/approve', (req, res) => decideCost(req, res, 'APPROVED'));
router.post('/cost-transactions/:id/reject', (req, res) => decideCost(req, res, 'REJECTED'));

// ---- Reconciliation and closure ----

router.post('/tasks/:id/cost-reconcile', (req, res) => {
  const t = loadTaskFor(req, res);
  if (!t) return;
  if (!canManageCost(req)) return res.status(403).json({ error: "Forbidden: requires 'task:manage' or ADMIN" });
  const reason = String((req.body && req.body.variance_reason) || '').trim();
  const summary = taskCostSummary(t.id);
  const tolerance = Math.max(1, Math.abs(summary.planned_cost) * 0.05);
  if (Math.abs(summary.variance) > tolerance && !reason) {
    return res.status(400).json({ error: 'A variance_reason is required to reconcile a material variance', variance: summary.variance });
  }
  const now = new Date().toISOString();
  db.prepare('UPDATE task SET cost_reconciled_at = ?, cost_reconciled_by = ?, variance_reason = ?, updated_at = ?, revision = revision + 1 WHERE id = ?')
    .run(now, req.user.person_id || null, reason || null, now, t.id);
  audit(req.user, 'RECONCILE', 'task', t.id, { variance: summary.variance, variance_reason: reason || null });
  res.json({ task_id: t.id, ...taskCostSummary(t.id), closure: closureGates(get('task', t.id)) });
});

router.post('/tasks/:id/management-acceptance', (req, res) => {
  const t = loadTaskFor(req, res);
  if (!t) return;
  if (!canManageCost(req) && req.user.role !== 'EXECUTIVE') return res.status(403).json({ error: "Forbidden: requires 'task:manage' or EXECUTIVE" });
  const now = new Date().toISOString();
  db.prepare('UPDATE task SET management_acceptance_at = ?, management_acceptance_by = ?, updated_at = ?, revision = revision + 1 WHERE id = ?')
    .run(now, req.user.person_id || null, now, t.id);
  audit(req.user, 'ACCEPT', 'task', t.id, {});
  res.json({ task_id: t.id, management_acceptance_at: now, closure: closureGates(get('task', t.id)) });
});

router.post('/tasks/:id/close', (req, res) => {
  const t = loadTaskFor(req, res);
  if (!t) return;
  if (!canManageCost(req)) return res.status(403).json({ error: "Forbidden: requires 'task:manage' or ADMIN" });
  const evaluation = closureGates(t);
  const now = new Date().toISOString();
  if (!evaluation.ready_to_close) {
    db.prepare('UPDATE task SET closure_state = ?, updated_at = ? WHERE id = ?')
      .run(evaluation.cost_pending ? 'COST_PENDING' : 'OPEN', now, t.id);
    return res.status(409).json({
      error: 'Task is not ready for financial closure',
      code: 'CLOSURE_BLOCKED',
      closure_state: evaluation.cost_pending ? 'COST_PENDING' : 'OPEN',
      unmet: evaluation.gates.filter((g) => g.blocking && !g.satisfied),
    });
  }
  db.prepare("UPDATE task SET closure_state = 'CLOSED', closed_at = ?, closed_by = ?, updated_at = ?, revision = revision + 1 WHERE id = ?")
    .run(now, req.user.person_id || null, now, t.id);
  audit(req.user, 'CLOSE', 'task', t.id, {});
  res.json({ task_id: t.id, closure_state: 'CLOSED', closed_at: now, cost: taskCostSummary(t.id), closure: closureGates(get('task', t.id)) });
});

module.exports = router;
