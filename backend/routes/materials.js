'use strict';

const express = require('express');
const { db, get, insertRow, nextCode, byClientRef, withTx } = require('../util');
const { can, audit, isCrewUser, isOnCrew } = require('../auth');
const { taskVisible } = require('../authority');
const {
  MATERIAL_CATEGORIES, CRITICALITIES,
  onHand, reservedQty, availableQty, taskMaterialSummary,
} = require('../materials');

const router = express.Router();

const STORE_TYPES = new Set(['RECEIPT', 'ISSUE', 'RETURN', 'ADJUSTMENT']);
const FIELD_TYPES = new Set(['CONSUMPTION', 'SCRAP', 'RETURN']);

function canSeeTask(req, t) {
  return t && taskVisible(req.user, t);
}

function canManageMaterials(req) {
  return req.user.role === 'ADMIN' || can(req, 'task:manage');
}

function canFieldCapture(req, t) {
  if (can(req, 'task:execute') || can(req, 'task:manage') || can(req, 'task:assign')) return true;
  return isCrewUser(req.user) && isOnCrew(req.user, t.crew_id);
}

function stockView(item, location) {
  const hand = onHand(item.id, location);
  const reserved = reservedQty(item.id, location);
  return {
    ...item,
    on_hand: hand,
    reserved,
    available: Math.round((hand - reserved) * 1000) / 1000,
    below_reorder: item.reorder_point != null && hand <= Number(item.reorder_point),
  };
}

// ---- Material / spare register ----

router.get('/materials', (req, res) => {
  if (!can(req, 'task:read')) return res.status(403).json({ error: "Forbidden: requires 'task:read'" });
  const clauses = [];
  const params = [];
  if (req.query.category) { clauses.push('category = ?'); params.push(String(req.query.category)); }
  if (req.query.criticality) { clauses.push('criticality = ?'); params.push(String(req.query.criticality)); }
  if (req.query.active === '0') clauses.push('active = 0');
  else if (req.query.active !== 'all') clauses.push('active = 1');
  if (req.query.q) { clauses.push('(LOWER(code) LIKE ? OR LOWER(description) LIKE ?)'); const q = `%${String(req.query.q).toLowerCase()}%`; params.push(q, q); }
  const sql = `SELECT * FROM material_item${clauses.length ? ` WHERE ${clauses.join(' AND ')}` : ''} ORDER BY category, code`;
  const location = typeof req.query.location === 'string' && req.query.location ? req.query.location : null;
  res.json(db.prepare(sql).all(...params).map((m) => stockView(m, location)));
});

router.post('/materials', (req, res) => {
  if (!canManageMaterials(req)) return res.status(403).json({ error: "Forbidden: requires 'task:manage' or ADMIN" });
  const body = req.body || {};
  if (!body.description || String(body.description).trim() === '') return res.status(400).json({ error: 'description is required' });
  const category = body.category || 'SPARE';
  if (!MATERIAL_CATEGORIES.has(category)) return res.status(400).json({ error: `category must be one of: ${[...MATERIAL_CATEGORIES].join(', ')}` });
  const criticality = body.criticality || 'MEDIUM';
  if (!CRITICALITIES.has(criticality)) return res.status(400).json({ error: `criticality must be one of: ${[...CRITICALITIES].join(', ')}` });
  const now = new Date().toISOString();
  const id = insertRow('material_item', {
    code: body.code ? String(body.code) : nextCode('MAT', 'material_item', 'code', 4),
    description: String(body.description).trim(),
    category,
    unit: body.unit || 'EA',
    unit_cost: body.unit_cost != null ? Number(body.unit_cost) : null,
    currency: body.currency || 'USD',
    min_stock: Number(body.min_stock) || 0,
    max_stock: body.max_stock != null ? Number(body.max_stock) : null,
    reorder_point: Number(body.reorder_point) || 0,
    supplier: body.supplier || null,
    lead_time_days: body.lead_time_days != null ? Number(body.lead_time_days) : null,
    criticality,
    shelf_life_days: body.shelf_life_days != null ? Number(body.shelf_life_days) : null,
    substitute_item_id: body.substitute_item_id != null ? Number(body.substitute_item_id) : null,
    default_location: body.default_location || null,
    active: 1,
    notes: body.notes || null,
    created_at: now,
    updated_at: now,
  });
  audit(req.user, 'CREATE', 'material_item', id, { code: body.code || null, description: body.description, criticality });
  res.status(201).json(stockView(get('material_item', id)));
});

router.get('/materials/:id', (req, res) => {
  if (!can(req, 'task:read')) return res.status(403).json({ error: "Forbidden: requires 'task:read'" });
  const item = get('material_item', Number(req.params.id));
  if (!item) return res.status(404).json({ error: 'Material not found' });
  const locations = db.prepare(
    'SELECT DISTINCT location FROM material_transaction WHERE item_id = ? AND location IS NOT NULL ORDER BY location'
  ).all(item.id).map((r) => r.location);
  const transactions = db.prepare('SELECT * FROM material_transaction WHERE item_id = ? ORDER BY created_at DESC, id DESC LIMIT 100').all(item.id);
  res.json({
    ...stockView(item, null),
    locations: locations.map((loc) => ({ location: loc, on_hand: onHand(item.id, loc), reserved: reservedQty(item.id, loc) })),
    transactions,
  });
});

router.put('/materials/:id', (req, res) => {
  if (!canManageMaterials(req)) return res.status(403).json({ error: "Forbidden: requires 'task:manage' or ADMIN" });
  const item = get('material_item', Number(req.params.id));
  if (!item) return res.status(404).json({ error: 'Material not found' });
  const body = req.body || {};
  if (body.category != null && !MATERIAL_CATEGORIES.has(body.category)) return res.status(400).json({ error: 'invalid category' });
  if (body.criticality != null && !CRITICALITIES.has(body.criticality)) return res.status(400).json({ error: 'invalid criticality' });
  const patch = {
    description: body.description != null ? String(body.description).trim() : undefined,
    category: body.category,
    unit: body.unit,
    unit_cost: body.unit_cost != null ? Number(body.unit_cost) : undefined,
    currency: body.currency,
    min_stock: body.min_stock != null ? Number(body.min_stock) : undefined,
    max_stock: body.max_stock != null ? Number(body.max_stock) : undefined,
    reorder_point: body.reorder_point != null ? Number(body.reorder_point) : undefined,
    supplier: body.supplier,
    lead_time_days: body.lead_time_days != null ? Number(body.lead_time_days) : undefined,
    criticality: body.criticality,
    shelf_life_days: body.shelf_life_days != null ? Number(body.shelf_life_days) : undefined,
    substitute_item_id: body.substitute_item_id != null ? Number(body.substitute_item_id) : undefined,
    default_location: body.default_location,
    active: body.active != null ? (body.active ? 1 : 0) : undefined,
    notes: body.notes,
    updated_at: new Date().toISOString(),
  };
  const clean = Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined));
  const sets = Object.keys(clean).map((k) => `${k} = ?`).join(', ');
  db.prepare(`UPDATE material_item SET ${sets}, revision = revision + 1 WHERE id = ?`).run(...Object.values(clean), item.id);
  audit(req.user, 'UPDATE', 'material_item', item.id, clean);
  res.json(stockView(get('material_item', item.id)));
});

// ---- Stores transactions (receipt / issue / return / adjustment) ----

router.get('/materials/:id/transactions', (req, res) => {
  if (!can(req, 'task:read')) return res.status(403).json({ error: "Forbidden: requires 'task:read'" });
  const item = get('material_item', Number(req.params.id));
  if (!item) return res.status(404).json({ error: 'Material not found' });
  const rows = db.prepare('SELECT * FROM material_transaction WHERE item_id = ? ORDER BY created_at DESC, id DESC LIMIT 200').all(item.id);
  res.json({ item_id: item.id, on_hand: onHand(item.id, null), transactions: rows });
});

router.post('/materials/:id/transactions', (req, res) => {
  if (!canManageMaterials(req)) return res.status(403).json({ error: "Forbidden: requires 'task:manage' or ADMIN" });
  const item = get('material_item', Number(req.params.id));
  if (!item) return res.status(404).json({ error: 'Material not found' });
  const body = req.body || {};
  if (body.client_ref) {
    const existing = byClientRef('material_transaction', body.client_ref);
    if (existing) return res.status(200).json(existing);
  }
  const type = body.type;
  if (!STORE_TYPES.has(type)) return res.status(400).json({ error: `type must be one of: ${[...STORE_TYPES].join(', ')}` });
  const quantity = Number(body.quantity);
  if (!Number.isFinite(quantity) || quantity === 0) return res.status(400).json({ error: 'quantity must be a non-zero number' });
  if (type !== 'ADJUSTMENT' && quantity < 0) return res.status(400).json({ error: `${type} quantity must be positive` });
  const location = body.location || item.default_location || null;
  if (type === 'ISSUE' && !can(req, 'task:manage') && !req.user.person_id) {
    return res.status(403).json({ error: 'Forbidden' });
  }
  if (type === 'ISSUE') {
    const hand = onHand(item.id, location);
    if (hand - quantity < -1e-9) {
      return res.status(409).json({ error: 'Issue would drive stock negative', code: 'INSUFFICIENT_STOCK', on_hand: hand });
    }
  }
  let taskId = body.task_id != null ? Number(body.task_id) : null;
  if (taskId && !get('task', taskId)) return res.status(400).json({ error: 'task not found' });
  const unitCost = body.unit_cost != null ? Number(body.unit_cost) : (item.unit_cost != null ? Number(item.unit_cost) : null);
  const cost = unitCost != null && Number.isFinite(unitCost) ? Math.round(quantity * unitCost * 100) / 100 : null;
  const now = new Date().toISOString();
  const id = withTx(() => {
    const txnId = insertRow('material_transaction', {
      item_id: item.id,
      task_id: taskId,
      reservation_id: body.reservation_id != null ? Number(body.reservation_id) : null,
      type,
      quantity,
      location,
      unit_cost: unitCost,
      cost,
      notes: body.notes || null,
      status: 'POSTED',
      created_by: req.user.person_id || null,
      client_ref: body.client_ref || null,
      created_at: now,
    });
    // Issuing the reserved material fulfils the plan for that reservation.
    if (type === 'ISSUE' && body.reservation_id != null) {
      db.prepare("UPDATE material_reservation SET status = 'FULFILLED', updated_at = ? WHERE id = ? AND status = 'RESERVED'").run(now, Number(body.reservation_id));
    }
    return txnId;
  });
  audit(req.user, 'CREATE', 'material_transaction', id, { item_id: item.id, type, quantity, location, task_id: taskId });
  res.status(201).json(get('material_transaction', id));
});

// ---- Task reservations ----

router.get('/tasks/:id/material-reservations', (req, res) => {
  const t = get('task', Number(req.params.id));
  if (!canSeeTask(req, t)) return res.status(404).json({ error: 'Task not found' });
  const reservations = db.prepare('SELECT * FROM material_reservation WHERE task_id = ? ORDER BY item_id, id').all(t.id);
  res.json({ task_id: t.id, reservations });
});

router.post('/tasks/:id/material-reservations', (req, res) => {
  const t = get('task', Number(req.params.id));
  if (!canSeeTask(req, t)) return res.status(404).json({ error: 'Task not found' });
  if (!canManageMaterials(req) && !canFieldCapture(req, t)) {
    return res.status(403).json({ error: 'Forbidden: requires task:manage or crew membership' });
  }
  const body = req.body || {};
  if (body.client_ref) {
    const existing = byClientRef('material_reservation', body.client_ref);
    if (existing) return res.status(200).json(existing);
  }
  const item = get('material_item', Number(body.item_id));
  if (!item || item.active === 0) return res.status(400).json({ error: 'A valid active material item is required' });
  const quantity = Number(body.quantity);
  if (!Number.isFinite(quantity) || quantity <= 0) return res.status(400).json({ error: 'quantity must be a positive number' });
  const location = body.location || item.default_location || null;
  if (availableQty(item.id, location) + 1e-9 < quantity) {
    return res.status(409).json({
      error: 'Insufficient available stock to reserve', code: 'MATERIAL_SHORT',
      available: availableQty(item.id, location), on_hand: onHand(item.id, location), criticality: item.criticality,
    });
  }
  const now = new Date().toISOString();
  const id = insertRow('material_reservation', {
    item_id: item.id,
    task_id: t.id,
    quantity,
    location,
    status: 'RESERVED',
    reserved_by: req.user.person_id || null,
    notes: body.notes || null,
    client_ref: body.client_ref || null,
    created_at: now,
    updated_at: now,
  });
  audit(req.user, 'RESERVE', 'material_reservation', id, { task_id: t.id, item_id: item.id, quantity, location });
  res.status(201).json(get('material_reservation', id));
});

router.post('/material-reservations/:id/cancel', (req, res) => {
  const rv = get('material_reservation', Number(req.params.id));
  if (!rv) return res.status(404).json({ error: 'Reservation not found' });
  const t = get('task', rv.task_id);
  if (!canSeeTask(req, t)) return res.status(404).json({ error: 'Reservation not found' });
  if (!canManageMaterials(req) && !canFieldCapture(req, t)) return res.status(403).json({ error: 'Forbidden' });
  if (rv.status !== 'RESERVED') return res.status(409).json({ error: `Cannot cancel a ${rv.status} reservation` });
  db.prepare('UPDATE material_reservation SET status = ?, updated_at = ? WHERE id = ?').run('CANCELLED', new Date().toISOString(), rv.id);
  audit(req.user, 'CANCEL', 'material_reservation', rv.id, {});
  res.json(get('material_reservation', rv.id));
});

// ---- Field material usage (consume / scrap / return) ----

router.get('/tasks/:id/materials', (req, res) => {
  const t = get('task', Number(req.params.id));
  if (!canSeeTask(req, t)) return res.status(404).json({ error: 'Task not found' });
  const reservations = db.prepare('SELECT * FROM material_reservation WHERE task_id = ? ORDER BY item_id, id').all(t.id);
  const transactions = db.prepare('SELECT * FROM material_transaction WHERE task_id = ? ORDER BY created_at, id').all(t.id);
  res.json({ task_id: t.id, reservations, transactions, summary: taskMaterialSummary(t.id) });
});

router.post('/tasks/:id/material-usage', (req, res) => {
  const t = get('task', Number(req.params.id));
  if (!canSeeTask(req, t)) return res.status(404).json({ error: 'Task not found' });
  if (!canFieldCapture(req, t)) return res.status(403).json({ error: "Forbidden: requires task:execute/manage or crew membership" });
  if (t.status === 'CANCELLED') return res.status(409).json({ error: 'Cannot record material against a cancelled task' });
  const body = req.body || {};
  if (body.client_ref) {
    const existing = byClientRef('material_transaction', body.client_ref);
    if (existing) return res.status(200).json(existing);
  }
  const item = get('material_item', Number(body.item_id));
  if (!item) return res.status(400).json({ error: 'A valid material item is required' });
  const type = body.type || 'CONSUMPTION';
  if (!FIELD_TYPES.has(type)) return res.status(400).json({ error: `type must be one of: ${[...FIELD_TYPES].join(', ')}` });
  const quantity = Number(body.quantity);
  if (!Number.isFinite(quantity) || quantity <= 0) return res.status(400).json({ error: 'quantity must be a positive number' });
  if (body.reservation_id) {
    const rv = get('material_reservation', Number(body.reservation_id));
    if (!rv || rv.task_id !== t.id || rv.item_id !== item.id) {
      return res.status(400).json({ error: 'reservation_id does not match this task and item' });
    }
  }
  if (type === 'CONSUMPTION' || type === 'SCRAP') {
    const s = taskMaterialSummary(t.id);
    const outstanding = s.issued_qty - s.returned_qty - s.consumed_qty - s.scrapped_qty;
    if (outstanding + 1e-9 < quantity) {
      return res.status(409).json({ error: 'No issued stock outstanding for this task; issue material first', code: 'MATERIAL_NOT_ISSUED', outstanding: Math.round(outstanding * 1000) / 1000 });
    }
  }
  const location = body.location || item.default_location || null;
  const unitCost = body.unit_cost != null ? Number(body.unit_cost) : (item.unit_cost != null ? Number(item.unit_cost) : null);
  const cost = unitCost != null && Number.isFinite(unitCost) ? Math.round(quantity * unitCost * 100) / 100 : null;
  const now = new Date().toISOString();
  const id = insertRow('material_transaction', {
    item_id: item.id,
    task_id: t.id,
    reservation_id: body.reservation_id != null ? Number(body.reservation_id) : null,
    type,
    quantity,
    location,
    unit_cost: unitCost,
    cost,
    notes: body.notes || null,
    status: 'POSTED',
    created_by: req.user.person_id || null,
    client_ref: body.client_ref || null,
    created_at: now,
  });
  audit(req.user, 'USE', 'material_transaction', id, { task_id: t.id, item_id: item.id, type, quantity });
  res.status(201).json(get('material_transaction', id));
});

router.get('/tasks/:id/material-summary', (req, res) => {
  const t = get('task', Number(req.params.id));
  if (!canSeeTask(req, t)) return res.status(404).json({ error: 'Task not found' });
  res.json(taskMaterialSummary(t.id));
});

module.exports = router;
