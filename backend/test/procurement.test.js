process.env.TMMS_DB = require('node:path').join(require('node:os').tmpdir(), `tmms-proc-${process.pid}-${Date.now()}.db`);

const test = require('node:test');
const assert = require('node:assert');
const express = require('express');

const { initSchema, db } = require('../db');
const { insertRow, get } = require('../util');
initSchema();
insertRow('person', { id: 1, first_name: 'Admin', last_name: 'User', role: 'ADMIN', active: 1 });

const procurement = require('../procurement');
const budget = require('../budget');
const router = require('../routes/procurement');

const NOW = new Date().toISOString();
const PERIOD = NOW.slice(0, 7);

const app = express();
app.use(express.json());
app.use((req, _res, next) => { req.user = { id: 1, person_id: 1, role: 'ADMIN', region_id: null }; next(); });
app.use('/api', router);

let server;
let base;
test.before(async () => { await new Promise((resolve) => { server = app.listen(0, resolve); }); base = `http://127.0.0.1:${server.address().port}/api`; });
test.after(() => { if (server) server.close(); });

async function api(method, path, body) {
  const res = await fetch(`${base}${path}`, { method, headers: { 'Content-Type': 'application/json' }, body: body !== undefined ? JSON.stringify(body) : undefined });
  return { status: res.status, body: await res.json() };
}

test('purchase order totals and derived status track receipts', () => {
  const supplierId = insertRow('supplier', { code: 'SUP-T1', name: 'T1 Supplier', active: 1, created_at: NOW, updated_at: NOW });
  const poId = insertRow('purchase_order', { po_number: 'PO-T-1', supplier_id: supplierId, status: 'APPROVED', committed_amount: 200, order_date: NOW, created_at: NOW, updated_at: NOW });
  const l1 = insertRow('purchase_order_line', { purchase_order_id: poId, description: 'A', quantity: 10, unit_cost: 10, line_total: 100, received_quantity: 0, created_at: NOW, updated_at: NOW });
  insertRow('purchase_order_line', { purchase_order_id: poId, description: 'B', quantity: 5, unit_cost: 20, line_total: 100, received_quantity: 0, created_at: NOW, updated_at: NOW });

  assert.strictEqual(procurement.poTotal(poId), 200);
  assert.strictEqual(procurement.derivedStatus(poId), 'APPROVED');

  db.prepare('UPDATE purchase_order_line SET received_quantity = 4 WHERE id = ?').run(l1);
  assert.strictEqual(procurement.refreshStatus(poId), 'PARTIALLY_RECEIVED');
  assert.strictEqual(procurement.poReceivedValue(poId), 40);
  assert.strictEqual(procurement.poReceivedQty(poId), 4);

  for (const line of procurement.poLines(poId)) db.prepare('UPDATE purchase_order_line SET received_quantity = quantity WHERE id = ?').run(line.id);
  assert.strictEqual(procurement.refreshStatus(poId), 'RECEIVED');
  assert.strictEqual(procurement.poView(get('purchase_order', poId)).open_commitment, 0);
});

test('budget includes open PO commitments and nets received value', () => {
  const ccId = insertRow('cost_center', { code: 'PROC-CC-1', name: 'Proc CC', active: 1, created_at: NOW, updated_at: NOW });
  const supplierId = insertRow('supplier', { code: 'SUP-T2', name: 'T2 Supplier', active: 1, created_at: NOW, updated_at: NOW });
  const poId = insertRow('purchase_order', { po_number: 'PO-T-2', supplier_id: supplierId, cost_center_id: ccId, status: 'PARTIALLY_RECEIVED', committed_amount: 200, order_date: NOW, created_at: NOW, updated_at: NOW });
  insertRow('purchase_order_line', { purchase_order_id: poId, description: 'A', quantity: 10, unit_cost: 20, line_total: 200, received_quantity: 3, created_at: NOW, updated_at: NOW });

  assert.strictEqual(procurement.openCommittedForCostCenter(ccId, PERIOD), 140);
  insertRow('budget', { cost_center_id: ccId, period: PERIOD, amount: 500, created_at: NOW, updated_at: NOW });
  const status = budget.budgetStatus(ccId, PERIOD);
  assert.strictEqual(status.po_committed, 140);
  assert.strictEqual(status.exposure, 140);
  assert.strictEqual(status.available, 360);
  assert.strictEqual(status.over_budget, false);

  const draft = { cost_center_id: ccId, order_date: NOW };
  const check = budget.checkCommitmentForPo(draft, 400);
  assert.strictEqual(check.projected, 540);
  assert.strictEqual(check.over_budget, true);
});

test('procurement lifecycle enforces over-receipt and budget on approval', async () => {
  const ccId = insertRow('cost_center', { code: 'PROC-CC-2', name: 'Lifecycle CC', active: 1, created_at: NOW, updated_at: NOW });
  insertRow('budget', { cost_center_id: ccId, period: PERIOD, amount: 150, created_at: NOW, updated_at: NOW });
  const itemId = insertRow('material_item', { code: 'PROC-MAT-1', description: 'Breaker', unit_cost: 10, criticality: 'MEDIUM', active: 1, created_at: NOW, updated_at: NOW });
  const item2 = insertRow('material_item', { code: 'PROC-MAT-2', description: 'Cable', unit_cost: 20, criticality: 'LOW', active: 1, created_at: NOW, updated_at: NOW });

  const supplier = await api('POST', '/suppliers', { name: 'Lifecycle Supplier' });
  assert.strictEqual(supplier.status, 201);
  const supplierId = supplier.body.id;

  const po = await api('POST', '/purchase-orders', { supplier_id: supplierId, cost_center_id: ccId, order_date: NOW });
  assert.strictEqual(po.status, 201);
  assert.strictEqual(po.body.status, 'DRAFT');
  const poId = po.body.id;

  assert.strictEqual((await api('POST', `/purchase-orders/${poId}/lines`, { material_item_id: itemId, quantity: 10, unit_cost: 10 })).status, 201);
  assert.strictEqual((await api('POST', `/purchase-orders/${poId}/lines`, { material_item_id: item2, quantity: 5, unit_cost: 20 })).status, 201);

  const blocked = await api('POST', `/purchase-orders/${poId}/approve`);
  assert.strictEqual(blocked.status, 409);
  assert.strictEqual(blocked.body.code, 'BUDGET_EXCEEDED');

  const approved = await api('POST', `/purchase-orders/${poId}/approve`, { budget_override: true, budget_override_reason: 'critical spare, CEO approved' });
  assert.strictEqual(approved.status, 200);
  assert.strictEqual(approved.body.status, 'APPROVED');
  assert.strictEqual(approved.body.committed_amount, 200);

  const line1 = approved.body.lines.find((l) => l.material_item_id === itemId);
  const over = await api('POST', `/purchase-orders/${poId}/receive`, { purchase_order_line_id: line1.id, quantity: 20, location: 'WH-1' });
  assert.strictEqual(over.status, 409);
  assert.strictEqual(over.body.code, 'OVER_RECEIPT');

  const r1 = await api('POST', `/purchase-orders/${poId}/receive`, { purchase_order_line_id: line1.id, quantity: 10, location: 'WH-1' });
  assert.strictEqual(r1.status, 201);
  assert.strictEqual(r1.body.purchase_order.status, 'PARTIALLY_RECEIVED');
  assert.strictEqual(require('../materials').onHand(itemId, 'WH-1'), 10);

  const line2 = approved.body.lines.find((l) => l.material_item_id === item2);
  const r2 = await api('POST', `/purchase-orders/${poId}/receive`, { purchase_order_line_id: line2.id, quantity: 5, location: 'WH-1' });
  assert.strictEqual(r2.status, 201);
  assert.strictEqual(r2.body.purchase_order.status, 'RECEIVED');

  const receipts = await api('GET', `/purchase-orders/${poId}/receipts`);
  assert.strictEqual(receipts.body.receipts.length, 2);

  const cancel = await api('POST', `/purchase-orders/${poId}/cancel`, { reason: 'too late' });
  assert.strictEqual(cancel.status, 409);

  assert.ok(procurement.poKpis().by_status.RECEIVED >= 1);
  assert.ok(procurement.poKpis().received_value > 0);
});
