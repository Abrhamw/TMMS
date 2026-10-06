process.env.TMMS_DB = require('node:path').join(require('node:os').tmpdir(), `tmms-mat-${process.pid}-${Date.now()}.db`);

const test = require('node:test');
const assert = require('node:assert');

const { initSchema } = require('../db');
const { insertRow, get } = require('../util');
initSchema();

const { signedQuantity, onHand, reservedQty, availableQty, canFulfil, taskMaterialSummary } = require('../materials');
const { dispatchGate } = require('../readiness');

const NOW = new Date().toISOString();

function makeTask(title, regionSuffix, status = 'ASSIGNED') {
  const regionId = insertRow('region', { code: `MAT-R-${regionSuffix}`, name: 'Mat', type: 'CUSTOM', center_lat: 0, center_lng: 0, boundary: 1, status: 'ACTIVE', timezone: 'UTC' });
  return insertRow('task', {
    task_number: `TK-2026-7100${regionSuffix}`, title, task_type: 'INSPECTION', priority: 'LOW',
    status, region_id: regionId, due_date: NOW, created_at: NOW, updated_at: NOW, source: 'MANUAL',
  });
}

function makeItem(code, criticality, unitCost) {
  return insertRow('material_item', { code, description: code, category: 'SPARE', unit: 'EA', unit_cost: unitCost, criticality, active: 1, created_at: NOW, updated_at: NOW });
}

function txn(itemId, type, quantity, extra = {}) {
  return insertRow('material_transaction', {
    item_id: itemId, type, quantity, location: 'WH1', unit_cost: extra.unit_cost ?? null,
    cost: extra.cost ?? null, status: 'POSTED', created_at: NOW, ...extra,
  });
}

test('signedQuantity maps each transaction type to its stock effect', () => {
  assert.strictEqual(signedQuantity({ type: 'RECEIPT', quantity: 5 }), 5);
  assert.strictEqual(signedQuantity({ type: 'RETURN', quantity: 2 }), 2);
  assert.strictEqual(signedQuantity({ type: 'ISSUE', quantity: 4 }), -4);
  assert.strictEqual(signedQuantity({ type: 'ADJUSTMENT', quantity: -3 }), -3);
  assert.strictEqual(signedQuantity({ type: 'CONSUMPTION', quantity: 9 }), 0);
  assert.strictEqual(signedQuantity({ type: 'SCRAP', quantity: 1 }), 0);
});

test('onHand is derived from the posted ledger and reservations reduce availability', () => {
  const itemId = makeItem('MAT-LEDGER', 'MEDIUM', 10);
  txn(itemId, 'RECEIPT', 10);
  txn(itemId, 'ISSUE', 3);
  txn(itemId, 'RETURN', 1);
  txn(itemId, 'ADJUSTMENT', -2);
  assert.strictEqual(onHand(itemId), 6);
  insertRow('material_reservation', { item_id: itemId, quantity: 4, location: 'WH1', status: 'RESERVED', created_at: NOW, updated_at: NOW });
  assert.strictEqual(reservedQty(itemId), 4);
  assert.strictEqual(availableQty(itemId), 2);
  assert.strictEqual(canFulfil(itemId, null, 2), true);
  assert.strictEqual(canFulfil(itemId, null, 3), false);
});

test('taskMaterialSummary reconciles issued, returned, consumed and scrapped quantities and cost', () => {
  const taskId = makeTask('Material task', 2);
  const itemId = makeItem('MAT-TASK', 'HIGH', 12.5);
  txn(itemId, 'RECEIPT', 20);
  insertRow('material_reservation', { item_id: itemId, task_id: taskId, quantity: 4, location: 'WH1', status: 'RESERVED', created_at: NOW, updated_at: NOW });
  txn(itemId, 'ISSUE', 4, { task_id: taskId });
  txn(itemId, 'CONSUMPTION', 2, { task_id: taskId, unit_cost: 12.5, cost: 25 });
  txn(itemId, 'SCRAP', 1, { task_id: taskId, unit_cost: 12.5, cost: 12.5 });
  txn(itemId, 'RETURN', 1, { task_id: taskId });

  const summary = taskMaterialSummary(taskId);
  assert.strictEqual(summary.issued_qty, 4);
  assert.strictEqual(summary.returned_qty, 1);
  assert.strictEqual(summary.consumed_qty, 2);
  assert.strictEqual(summary.scrapped_qty, 1);
  assert.strictEqual(summary.outstanding_qty, 0);
  assert.strictEqual(summary.material_cost, 37.5);
  assert.strictEqual(summary.by_item.length, 1);
  assert.strictEqual(summary.by_item[0].cost, 37.5);
});

test('dispatchGate blocks a critical spare whose reserved quantity is no longer on hand', () => {
  const taskId = makeTask('Critical task', 3);
  const itemId = makeItem('MAT-CRIT', 'CRITICAL', 100);
  txn(itemId, 'RECEIPT', 5);
  insertRow('material_reservation', { item_id: itemId, task_id: taskId, quantity: 5, location: 'WH1', status: 'RESERVED', created_at: NOW, updated_at: NOW });
  const before = dispatchGate(get('task', taskId));
  assert.ok(!before.blockers.some((b) => b.code === 'CRITICAL_SPARE_SHORT'));

  txn(itemId, 'ISSUE', 4, { task_id: taskId });
  const after = dispatchGate(get('task', taskId));
  assert.ok(after.blockers.some((b) => b.code === 'CRITICAL_SPARE_SHORT'));
});
