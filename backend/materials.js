'use strict';

const { db } = require('./db');

const MATERIAL_CATEGORIES = new Set(['SPARE', 'CONSUMABLE', 'TOOL', 'PPE', 'CHEMICAL', 'FUEL', 'OTHER']);
const CRITICALITIES = new Set(['LOW', 'MEDIUM', 'HIGH', 'CRITICAL']);
const TRANSACTION_TYPES = new Set(['RECEIPT', 'ISSUE', 'RETURN', 'CONSUMPTION', 'SCRAP', 'ADJUSTMENT']);
const TASK_TYPES = new Set(['CONSUMPTION', 'SCRAP']);

// Warehouse on-hand is a derived ledger, not a mutable counter: receipts and
// returns add, issues subtract, adjustments carry their own sign. Consumption
// and scrap are task-level reconciliation of material already issued, so they
// deliberately do not move warehouse stock.
function signedQuantity(t) {
  const q = Number(t.quantity) || 0;
  if (t.type === 'RECEIPT' || t.type === 'RETURN') return q;
  if (t.type === 'ISSUE') return -q;
  if (t.type === 'ADJUSTMENT') return q;
  return 0;
}

function onHand(itemId, location) {
  const row = db.prepare(
    `SELECT IFNULL(SUM(CASE
        WHEN type IN ('RECEIPT', 'RETURN') THEN quantity
        WHEN type = 'ISSUE' THEN -quantity
        WHEN type = 'ADJUSTMENT' THEN quantity
        ELSE 0 END), 0) AS q
     FROM material_transaction
     WHERE item_id = ? AND status = 'POSTED' AND (? IS NULL OR location = ?)`
  ).get(Number(itemId), location ?? null, location ?? null);
  return round3(row.q);
}

function reservedQty(itemId, location) {
  const row = db.prepare(
    `SELECT IFNULL(SUM(quantity), 0) AS q FROM material_reservation
     WHERE item_id = ? AND status = 'RESERVED' AND (? IS NULL OR location = ?)`
  ).get(Number(itemId), location ?? null, location ?? null);
  return round3(row.q);
}

function availableQty(itemId, location) {
  return round3(onHand(itemId, location) - reservedQty(itemId, location));
}

function canFulfil(itemId, location, qty) {
  return availableQty(itemId, location) + 1e-9 >= Number(qty);
}

function round3(n) {
  return Math.round((Number(n) || 0) * 1000) / 1000;
}

function round2(n) {
  return Math.round((Number(n) || 0) * 100) / 100;
}

function itemValuation(itemId, location) {
  const item = db.prepare('SELECT unit_cost FROM material_item WHERE id = ?').get(Number(itemId));
  const qty = onHand(itemId, location);
  const unit = item && item.unit_cost != null ? Number(item.unit_cost) : 0;
  return { quantity: qty, unit_cost: unit, value: round2(qty * unit) };
}

// The per-task material picture: what was reserved, issued, returned, consumed
// and scrapped, plus the recognised actual material cost. Mirrors the labor and
// resource summaries so Phase E can add the three cost streams together.
function taskMaterialSummary(taskId) {
  const reservations = db.prepare('SELECT * FROM material_reservation WHERE task_id = ? ORDER BY item_id, id').all(taskId);
  const txns = db.prepare('SELECT * FROM material_transaction WHERE task_id = ? ORDER BY created_at, id').all(taskId);
  const sum = (type) => round3(txns.filter((t) => t.type === type).reduce((s, t) => s + (Number(t.quantity) || 0), 0));
  const cost = (types) => round2(txns.filter((t) => types.includes(t.type)).reduce((s, t) => s + (Number(t.cost) || 0), 0));
  const byItem = new Map();
  for (const t of txns) {
    const cur = byItem.get(t.item_id) || { item_id: t.item_id, issued: 0, returned: 0, consumed: 0, scrapped: 0, cost: 0 };
    if (t.type === 'ISSUE') cur.issued += Number(t.quantity) || 0;
    if (t.type === 'RETURN') cur.returned += Number(t.quantity) || 0;
    if (t.type === 'CONSUMPTION') cur.consumed += Number(t.quantity) || 0;
    if (t.type === 'SCRAP') cur.scrapped += Number(t.quantity) || 0;
    if (t.type === 'CONSUMPTION' || t.type === 'SCRAP') cur.cost += Number(t.cost) || 0;
    byItem.set(t.item_id, cur);
  }
  const issued = sum('ISSUE');
  const returned = sum('RETURN');
  const consumed = sum('CONSUMPTION');
  const scrapped = sum('SCRAP');
  return {
    task_id: Number(taskId),
    reservations: reservations.length,
    active_reservations: reservations.filter((r) => r.status === 'RESERVED').length,
    reserved_qty: round3(reservations.filter((r) => r.status === 'RESERVED').reduce((s, r) => s + (Number(r.quantity) || 0), 0)),
    issued_qty: issued,
    returned_qty: returned,
    consumed_qty: consumed,
    scrapped_qty: scrapped,
    outstanding_qty: round3(issued - returned - consumed - scrapped),
    material_cost: cost(['CONSUMPTION', 'SCRAP']),
    by_item: [...byItem.values()].map((x) => ({
      ...x,
      issued: round3(x.issued), returned: round3(x.returned),
      consumed: round3(x.consumed), scrapped: round3(x.scrapped), cost: round2(x.cost),
    })),
  };
}

module.exports = {
  MATERIAL_CATEGORIES, CRITICALITIES, TRANSACTION_TYPES, TASK_TYPES,
  signedQuantity, onHand, reservedQty, availableQty, canFulfil, itemValuation, taskMaterialSummary,
};
