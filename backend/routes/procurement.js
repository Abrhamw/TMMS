'use strict';

const express = require('express');
const { db, get, insertRow, list, nextCode, byClientRef, withTx } = require('../util');
const { can, audit } = require('../auth');
const budget = require('../budget');
const procurement = require('../procurement');

const router = express.Router();

function canManageProcurement(req) {
  return req.user.role === 'ADMIN' || can(req, 'task:manage');
}

function loadPo(req, res) {
  const po = get('purchase_order', Number(req.params.id));
  if (!po) { res.status(404).json({ error: 'Purchase order not found' }); return null; }
  return po;
}

// ---- Suppliers ----

router.get('/suppliers', (req, res) => {
  if (!can(req, 'task:read')) return res.status(403).json({ error: "Forbidden: requires 'task:read'" });
  let rows = list('supplier');
  if (req.query.active !== 'all') rows = rows.filter((s) => (req.query.active === '0' ? s.active === 0 : s.active === 1));
  res.json({ suppliers: rows });
});

router.post('/suppliers', (req, res) => {
  if (!canManageProcurement(req)) return res.status(403).json({ error: "Forbidden: requires 'task:manage' or ADMIN" });
  const body = req.body || {};
  const name = String(body.name || '').trim();
  if (!name) return res.status(400).json({ error: 'name is required' });
  const code = body.code ? String(body.code).trim() : nextCode('SUP', 'supplier', 'code', 3);
  if (db.prepare('SELECT id FROM supplier WHERE code = ?').get(code)) return res.status(409).json({ error: 'A supplier with that code already exists' });
  const now = new Date().toISOString();
  const id = insertRow('supplier', {
    code, name, contact_name: body.contact_name || null, email: body.email || null,
    phone: body.phone || null, address: body.address || null, notes: body.notes || null,
    active: 1, created_at: now, updated_at: now,
  });
  audit(req.user, 'CREATE', 'supplier', id, { code, name });
  res.status(201).json(get('supplier', id));
});

router.put('/suppliers/:id', (req, res) => {
  if (!canManageProcurement(req)) return res.status(403).json({ error: "Forbidden: requires 'task:manage' or ADMIN" });
  const s = get('supplier', Number(req.params.id));
  if (!s) return res.status(404).json({ error: 'Supplier not found' });
  const body = req.body || {};
  const patch = {
    name: body.name != null ? String(body.name).trim() : undefined,
    contact_name: body.contact_name, email: body.email, phone: body.phone,
    address: body.address, notes: body.notes,
    active: body.active != null ? (body.active ? 1 : 0) : undefined,
    updated_at: new Date().toISOString(),
  };
  const clean = Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined));
  const sets = Object.keys(clean).map((k) => `${k} = ?`).join(', ');
  db.prepare(`UPDATE supplier SET ${sets}, revision = revision + 1 WHERE id = ?`).run(...Object.values(clean), s.id);
  audit(req.user, 'UPDATE', 'supplier', s.id, clean);
  res.json(get('supplier', s.id));
});

// ---- Purchase orders ----

router.get('/purchase-orders', (req, res) => {
  if (!can(req, 'task:read')) return res.status(403).json({ error: "Forbidden: requires 'task:read'" });
  const clauses = [];
  const params = [];
  if (req.query.status) { clauses.push('status = ?'); params.push(String(req.query.status)); }
  if (req.query.supplier_id) { clauses.push('supplier_id = ?'); params.push(Number(req.query.supplier_id)); }
  if (req.query.cost_center_id) { clauses.push('cost_center_id = ?'); params.push(Number(req.query.cost_center_id)); }
  const sql = `SELECT * FROM purchase_order${clauses.length ? ` WHERE ${clauses.join(' AND ')}` : ''} ORDER BY id DESC`;
  res.json({ purchase_orders: db.prepare(sql).all(...params).map(procurement.poView) });
});

router.post('/purchase-orders', (req, res) => {
  if (!canManageProcurement(req)) return res.status(403).json({ error: "Forbidden: requires 'task:manage' or ADMIN" });
  const body = req.body || {};
  if (body.client_ref) {
    const existing = byClientRef('purchase_order', body.client_ref);
    if (existing) return res.status(200).json(procurement.poView(existing));
  }
  const supplier = get('supplier', Number(body.supplier_id));
  if (!supplier || supplier.active === 0) return res.status(400).json({ error: 'A valid active supplier is required' });
  if (body.cost_center_id != null && !get('cost_center', Number(body.cost_center_id))) return res.status(400).json({ error: 'cost_center_id not found' });
  const now = new Date().toISOString();
  const id = insertRow('purchase_order', {
    po_number: body.po_number ? String(body.po_number).trim() : nextCode('PO', 'purchase_order', 'po_number', 5),
    supplier_id: supplier.id,
    cost_center_id: body.cost_center_id != null ? Number(body.cost_center_id) : null,
    status: 'DRAFT',
    order_date: body.order_date || now,
    expected_date: body.expected_date || null,
    currency: body.currency || 'USD',
    notes: body.notes || null,
    created_by: req.user.person_id || null,
    client_ref: body.client_ref || null,
    created_at: now, updated_at: now,
  });
  audit(req.user, 'CREATE', 'purchase_order', id, { supplier_id: supplier.id });
  res.status(201).json(procurement.poView(get('purchase_order', id)));
});

router.get('/purchase-orders/:id', (req, res) => {
  const po = loadPo(req, res);
  if (!po) return;
  res.json(procurement.poView(po));
});

router.put('/purchase-orders/:id', (req, res) => {
  if (!canManageProcurement(req)) return res.status(403).json({ error: "Forbidden: requires 'task:manage' or ADMIN" });
  const po = loadPo(req, res);
  if (!po) return;
  if (po.status !== 'DRAFT') return res.status(409).json({ error: `Cannot edit a ${po.status} purchase order` });
  const body = req.body || {};
  if (body.cost_center_id != null && body.cost_center_id !== '' && !get('cost_center', Number(body.cost_center_id))) return res.status(400).json({ error: 'cost_center_id not found' });
  const patch = {
    expected_date: body.expected_date, notes: body.notes,
    currency: body.currency, order_date: body.order_date,
    cost_center_id: body.cost_center_id !== undefined ? (body.cost_center_id != null && body.cost_center_id !== '' ? Number(body.cost_center_id) : null) : undefined,
    updated_at: new Date().toISOString(),
  };
  const clean = Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined));
  const sets = Object.keys(clean).map((k) => `${k} = ?`).join(', ');
  db.prepare(`UPDATE purchase_order SET ${sets}, revision = revision + 1 WHERE id = ?`).run(...Object.values(clean), po.id);
  audit(req.user, 'UPDATE', 'purchase_order', po.id, clean);
  res.json(procurement.poView(get('purchase_order', po.id)));
});

router.post('/purchase-orders/:id/lines', (req, res) => {
  if (!canManageProcurement(req)) return res.status(403).json({ error: "Forbidden: requires 'task:manage' or ADMIN" });
  const po = loadPo(req, res);
  if (!po) return;
  if (po.status !== 'DRAFT') return res.status(409).json({ error: `Cannot add lines to a ${po.status} purchase order` });
  const body = req.body || {};
  const quantity = Number(body.quantity);
  if (!Number.isFinite(quantity) || quantity <= 0) return res.status(400).json({ error: 'quantity must be a positive number' });
  const unitCost = Number(body.unit_cost);
  if (!Number.isFinite(unitCost) || unitCost < 0) return res.status(400).json({ error: 'a non-negative unit_cost is required' });
  let item = null;
  if (body.material_item_id != null) {
    item = get('material_item', Number(body.material_item_id));
    if (!item) return res.status(400).json({ error: 'material_item_id not found' });
  }
  const now = new Date().toISOString();
  const id = insertRow('purchase_order_line', {
    purchase_order_id: po.id, material_item_id: item ? item.id : null,
    description: body.description || (item ? item.description : null),
    quantity, unit_cost: unitCost, line_total: Math.round(quantity * unitCost * 100) / 100,
    received_quantity: 0, created_at: now, updated_at: now,
  });
  audit(req.user, 'CREATE', 'purchase_order_line', id, { purchase_order_id: po.id, quantity, unit_cost: unitCost });
  res.status(201).json(get('purchase_order_line', id));
});

router.put('/purchase-orders/:id/lines/:lineId', (req, res) => {
  if (!canManageProcurement(req)) return res.status(403).json({ error: "Forbidden: requires 'task:manage' or ADMIN" });
  const po = loadPo(req, res);
  if (!po) return;
  if (po.status !== 'DRAFT') return res.status(409).json({ error: `Cannot edit lines on a ${po.status} purchase order` });
  const line = get('purchase_order_line', Number(req.params.lineId));
  if (!line || line.purchase_order_id !== po.id) return res.status(404).json({ error: 'Purchase order line not found' });
  const body = req.body || {};
  const quantity = body.quantity != null ? Number(body.quantity) : Number(line.quantity);
  const unitCost = body.unit_cost != null ? Number(body.unit_cost) : Number(line.unit_cost);
  if (!Number.isFinite(quantity) || quantity <= 0) return res.status(400).json({ error: 'quantity must be a positive number' });
  if (!Number.isFinite(unitCost) || unitCost < 0) return res.status(400).json({ error: 'a non-negative unit_cost is required' });
  db.prepare('UPDATE purchase_order_line SET quantity = ?, unit_cost = ?, line_total = ?, description = ?, updated_at = ?, revision = revision + 1 WHERE id = ?')
    .run(quantity, unitCost, Math.round(quantity * unitCost * 100) / 100, body.description != null ? body.description : line.description, new Date().toISOString(), line.id);
  audit(req.user, 'UPDATE', 'purchase_order_line', line.id, { quantity, unit_cost: unitCost });
  res.json(get('purchase_order_line', line.id));
});

router.post('/purchase-orders/:id/approve', (req, res) => {
  if (!canManageProcurement(req)) return res.status(403).json({ error: "Forbidden: requires 'task:manage' or ADMIN" });
  const po = loadPo(req, res);
  if (!po) return;
  if (po.status !== 'DRAFT') return res.status(409).json({ error: `Cannot approve a ${po.status} purchase order` });
  const lines = procurement.poLines(po.id);
  if (!lines.length) return res.status(400).json({ error: 'A purchase order needs at least one line before approval' });
  const total = procurement.poTotal(po.id);
  let budgetOverride = null;
  if (po.cost_center_id) {
    const check = budget.checkCommitmentForPo(po, total);
    if (check.over_budget) {
      const override = req.body && (req.body.budget_override === true || req.body.budget_override === 'true');
      const reason = String((req.body && req.body.budget_override_reason) || '').trim();
      if (!override || !reason) return res.status(409).json({ error: 'Budget exceeded for cost center', code: 'BUDGET_EXCEEDED', ...check });
      budgetOverride = { reason, ...check };
    }
  }
  const now = new Date().toISOString();
  db.prepare("UPDATE purchase_order SET status = 'APPROVED', committed_amount = ?, approved_by = ?, approved_at = ?, updated_at = ?, revision = revision + 1 WHERE id = ?")
    .run(total, req.user.person_id || null, now, now, po.id);
  audit(req.user, 'APPROVE', 'purchase_order', po.id, { total, budget_override: budgetOverride });
  res.json(procurement.poView(get('purchase_order', po.id)));
});

router.post('/purchase-orders/:id/cancel', (req, res) => {
  if (!canManageProcurement(req)) return res.status(403).json({ error: "Forbidden: requires 'task:manage' or ADMIN" });
  const po = loadPo(req, res);
  if (!po) return;
  if (!['DRAFT', 'APPROVED'].includes(po.status)) return res.status(409).json({ error: `Cannot cancel a ${po.status} purchase order` });
  if (procurement.poReceivedQty(po.id) > 0) return res.status(409).json({ error: 'Cannot cancel a purchase order that has receipts' });
  const reason = String((req.body && req.body.reason) || '').trim();
  if (!reason) return res.status(400).json({ error: 'A cancellation reason is required' });
  const now = new Date().toISOString();
  db.prepare("UPDATE purchase_order SET status = 'CANCELLED', cancelled_by = ?, cancelled_at = ?, cancel_reason = ?, updated_at = ?, revision = revision + 1 WHERE id = ?")
    .run(req.user.person_id || null, now, reason, now, po.id);
  audit(req.user, 'CANCEL', 'purchase_order', po.id, { reason });
  res.json(procurement.poView(get('purchase_order', po.id)));
});

// ---- Receiving against the material stock ledger ----

router.get('/purchase-orders/:id/receipts', (req, res) => {
  const po = loadPo(req, res);
  if (!po) return;
  const receipts = db.prepare('SELECT * FROM material_transaction WHERE purchase_order_id = ? ORDER BY created_at, id').all(po.id);
  res.json({ purchase_order_id: po.id, receipts });
});

router.post('/purchase-orders/:id/receive', (req, res) => {
  if (!canManageProcurement(req)) return res.status(403).json({ error: "Forbidden: requires 'task:manage' or ADMIN" });
  const po = loadPo(req, res);
  if (!po) return;
  const body = req.body || {};
  if (body.client_ref) {
    const existing = byClientRef('material_transaction', body.client_ref);
    if (existing) return res.status(200).json({ receipt: existing, purchase_order: procurement.poView(get('purchase_order', po.id)) });
  }
  if (!procurement.OPEN_PO_STATUSES.includes(po.status)) return res.status(409).json({ error: `Cannot receive against a ${po.status} purchase order` });
  const line = get('purchase_order_line', Number(body.purchase_order_line_id));
  if (!line || line.purchase_order_id !== po.id) return res.status(400).json({ error: 'purchase_order_line_id does not belong to this purchase order' });
  if (!line.material_item_id) return res.status(400).json({ error: 'This line is not linked to a material item and cannot be received into stock' });
  const quantity = Number(body.quantity);
  if (!Number.isFinite(quantity) || quantity <= 0) return res.status(400).json({ error: 'quantity must be a positive number' });
  const remaining = Number(line.quantity) - Number(line.received_quantity);
  if (quantity - remaining > 1e-9) {
    return res.status(409).json({ error: 'Receipt exceeds the quantity ordered', code: 'OVER_RECEIPT', ordered: Number(line.quantity), received: Number(line.received_quantity), remaining: Math.round(remaining * 1000) / 1000 });
  }
  let taskId = body.task_id != null ? Number(body.task_id) : null;
  if (taskId && !get('task', taskId)) return res.status(400).json({ error: 'task not found' });
  const item = get('material_item', line.material_item_id);
  const location = body.location || item.default_location || null;
  const unitCost = body.unit_cost != null ? Number(body.unit_cost) : Number(line.unit_cost);
  const cost = Math.round(quantity * unitCost * 100) / 100;
  const now = new Date().toISOString();
  const receiptId = withTx(() => {
    const id = insertRow('material_transaction', {
      item_id: item.id, task_id: taskId, type: 'RECEIPT', quantity, location,
      unit_cost: unitCost, cost, notes: body.notes || null, status: 'POSTED',
      purchase_order_id: po.id, purchase_order_line_id: line.id,
      created_by: req.user.person_id || null, client_ref: body.client_ref || null, created_at: now,
    });
    db.prepare('UPDATE purchase_order_line SET received_quantity = received_quantity + ?, updated_at = ?, revision = revision + 1 WHERE id = ?').run(quantity, now, line.id);
    procurement.refreshStatus(po.id);
    return id;
  });
  audit(req.user, 'RECEIVE', 'purchase_order', po.id, { line_id: line.id, quantity, material_transaction_id: receiptId, location });
  res.status(201).json({ receipt: get('material_transaction', receiptId), purchase_order: procurement.poView(get('purchase_order', po.id)) });
});

module.exports = router;
