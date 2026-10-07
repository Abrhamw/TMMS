'use strict';

const express = require('express');
const { db, get, insertRow, list } = require('../util');
const { requirePerm, audit } = require('../auth');
const { taskVisible } = require('../authority');
const budget = require('../budget');

const router = express.Router();
const PERIOD_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

function loadTaskFor(req, res) {
  const t = get('task', Number(req.params.id));
  if (!t || !taskVisible(req.user, t)) { res.status(404).json({ error: 'Task not found' }); return null; }
  return t;
}

// ---- Cost centers ----

router.get('/cost-centers', requirePerm('task:read'), (req, res) => {
  res.json({ cost_centers: list('cost_center') });
});

router.post('/cost-centers', requirePerm('task:manage'), (req, res) => {
  const body = req.body || {};
  const code = String(body.code || '').trim();
  const name = String(body.name || '').trim();
  if (!code || !name) return res.status(400).json({ error: 'code and name are required' });
  if (db.prepare('SELECT id FROM cost_center WHERE code = ?').get(code)) return res.status(409).json({ error: 'A cost center with that code already exists' });
  const now = new Date().toISOString();
  const id = insertRow('cost_center', {
    code, name, region_id: body.region_id != null ? Number(body.region_id) : null,
    active: body.active === undefined ? 1 : (body.active ? 1 : 0), created_at: now, updated_at: now,
  });
  audit(req.user, 'CREATE', 'cost_center', id, { code, name });
  res.status(201).json(get('cost_center', id));
});

router.put('/cost-centers/:id', requirePerm('task:manage'), (req, res) => {
  const cc = get('cost_center', Number(req.params.id));
  if (!cc) return res.status(404).json({ error: 'Cost center not found' });
  const body = req.body || {};
  const patch = {
    name: body.name != null ? String(body.name).trim() : undefined,
    region_id: body.region_id !== undefined ? (body.region_id != null ? Number(body.region_id) : null) : undefined,
    active: body.active !== undefined ? (body.active ? 1 : 0) : undefined,
    updated_at: new Date().toISOString(),
  };
  const clean = Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined));
  const sets = Object.keys(clean).map((k) => `${k} = ?`).join(', ');
  db.prepare(`UPDATE cost_center SET ${sets}, revision = revision + 1 WHERE id = ?`).run(...Object.values(clean), cc.id);
  audit(req.user, 'UPDATE', 'cost_center', cc.id, clean);
  res.json(get('cost_center', cc.id));
});

// ---- Budgets (upsert per cost center + period) ----

router.get('/budgets', requirePerm('task:read'), (req, res) => {
  const period = req.query.period ? String(req.query.period) : null;
  const ccId = req.query.cost_center_id ? Number(req.query.cost_center_id) : null;
  let rows = list('budget');
  if (period) rows = rows.filter((b) => b.period === period);
  if (ccId) rows = rows.filter((b) => b.cost_center_id === ccId);
  res.json({ budgets: rows });
});

router.put('/budgets', requirePerm('task:manage'), (req, res) => {
  const body = req.body || {};
  const costCenterId = Number(body.cost_center_id);
  const cc = get('cost_center', costCenterId);
  if (!cc) return res.status(404).json({ error: 'Cost center not found' });
  const period = String(body.period || '');
  if (!PERIOD_RE.test(period)) return res.status(400).json({ error: 'period must be in YYYY-MM format' });
  const amount = Number(body.amount);
  if (!Number.isFinite(amount) || amount < 0) return res.status(400).json({ error: 'a non-negative amount is required' });
  const now = new Date().toISOString();
  const existing = db.prepare('SELECT * FROM budget WHERE cost_center_id = ? AND period = ?').get(costCenterId, period);
  if (existing) {
    db.prepare('UPDATE budget SET amount = ?, currency = ?, notes = ?, updated_at = ?, revision = revision + 1 WHERE id = ?')
      .run(Math.round(amount * 100) / 100, body.currency || existing.currency || 'USD', body.notes !== undefined ? body.notes : existing.notes, now, existing.id);
    audit(req.user, 'UPDATE', 'budget', existing.id, { cost_center_id: costCenterId, period, amount });
    return res.json(get('budget', existing.id));
  }
  const id = insertRow('budget', {
    cost_center_id: costCenterId, period, amount: Math.round(amount * 100) / 100,
    currency: body.currency || 'USD', notes: body.notes || null,
    created_by: req.user.person_id || null, created_at: now, updated_at: now,
  });
  audit(req.user, 'CREATE', 'budget', id, { cost_center_id: costCenterId, period, amount });
  res.status(201).json(get('budget', id));
});

router.get('/budgets/status', requirePerm('task:read'), (req, res) => {
  const ccId = Number(req.query.cost_center_id);
  const period = String(req.query.period || '');
  if (!ccId || !PERIOD_RE.test(period)) return res.status(400).json({ error: 'cost_center_id and a YYYY-MM period are required' });
  const status = budget.budgetStatus(ccId, period);
  if (!status) return res.status(404).json({ error: 'Cost center not found' });
  res.json(status);
});

// ---- Task attribution ----

router.get('/tasks/:id/budget', (req, res) => {
  const t = loadTaskFor(req, res);
  if (!t) return;
  res.json({ task_id: t.id, ...budget.taskBudget(t) });
});

router.put('/tasks/:id/cost-center', requirePerm('task:manage'), (req, res) => {
  const t = loadTaskFor(req, res);
  if (!t) return;
  const raw = req.body ? req.body.cost_center_id : undefined;
  const costCenterId = raw === null || raw === '' ? null : Number(raw);
  if (costCenterId !== null) {
    if (!get('cost_center', costCenterId)) return res.status(404).json({ error: 'Cost center not found' });
  }
  const now = new Date().toISOString();
  db.prepare('UPDATE task SET cost_center_id = ?, updated_at = ?, revision = revision + 1 WHERE id = ?').run(costCenterId, now, t.id);
  audit(req.user, 'ASSIGN_COST_CENTER', 'task', t.id, { cost_center_id: costCenterId });
  res.json({ task_id: t.id, ...budget.taskBudget(get('task', t.id)) });
});

module.exports = router;
