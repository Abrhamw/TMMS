'use strict';

const { db } = require('./db');

const PO_STATUSES = new Set(['DRAFT', 'APPROVED', 'PARTIALLY_RECEIVED', 'RECEIVED', 'CANCELLED']);
const OPEN_PO_STATUSES = ['APPROVED', 'PARTIALLY_RECEIVED'];

function round2(n) {
  return Math.round((Number(n) || 0) * 100) / 100;
}

function round3(n) {
  return Math.round((Number(n) || 0) * 1000) / 1000;
}

function poLines(poId) {
  return db.prepare('SELECT * FROM purchase_order_line WHERE purchase_order_id = ? ORDER BY id').all(Number(poId));
}

function poTotal(poId) {
  return round2(db.prepare('SELECT IFNULL(SUM(line_total), 0) AS s FROM purchase_order_line WHERE purchase_order_id = ?').get(Number(poId)).s);
}

function poReceivedValue(poId) {
  const row = db.prepare(
    'SELECT IFNULL(SUM(received_quantity * unit_cost), 0) AS s FROM purchase_order_line WHERE purchase_order_id = ?'
  ).get(Number(poId));
  return round2(row.s);
}

function poReceivedQty(poId) {
  return round3(db.prepare('SELECT IFNULL(SUM(received_quantity), 0) AS s FROM purchase_order_line WHERE purchase_order_id = ?').get(Number(poId)).s);
}

// Derive the PO status from how much of each line has been received; a fully
// received order is closed against its supplier, a partly received one stays
// committed so the outstanding balance is still visible to finance.
function derivedStatus(poId) {
  const lines = poLines(poId);
  if (!lines.length) return 'APPROVED';
  const anyReceived = lines.some((l) => Number(l.received_quantity) > 0);
  const allReceived = lines.every((l) => Number(l.received_quantity) + 1e-9 >= Number(l.quantity));
  if (allReceived) return 'RECEIVED';
  if (anyReceived) return 'PARTIALLY_RECEIVED';
  return 'APPROVED';
}

function refreshStatus(poId) {
  const po = db.prepare('SELECT * FROM purchase_order WHERE id = ?').get(Number(poId));
  if (!po || !OPEN_PO_STATUSES.includes(po.status)) return po ? po.status : null;
  const status = derivedStatus(poId);
  if (status !== po.status) {
    db.prepare('UPDATE purchase_order SET status = ?, updated_at = ?, revision = revision + 1 WHERE id = ?')
      .run(status, new Date().toISOString(), Number(poId));
  }
  return status;
}

function periodOf(value) {
  const d = value ? new Date(value) : new Date();
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString().slice(0, 7);
}

function poPeriod(po) {
  return periodOf(po.order_date) || periodOf(po.expected_date) || periodOf(po.created_at);
}

// The open (un-received) commitment a cost center carries from approved POs for
// a period. Received value has already become stock + material cost, so it is
// excluded to avoid counting the same spend twice.
function openCommittedForCostCenter(costCenterId, period) {
  if (!costCenterId) return 0;
  // Received value is folded into the same query so the outstanding commitment
  // for every open PO is computed without a per-order round trip.
  const rows = db.prepare(
    `SELECT po.id, po.committed_amount, po.order_date, po.expected_date, po.created_at,
            IFNULL((SELECT SUM(l.received_quantity * l.unit_cost) FROM purchase_order_line l WHERE l.purchase_order_id = po.id), 0) AS received_value
     FROM purchase_order po
     WHERE po.cost_center_id = ? AND po.status IN ('APPROVED', 'PARTIALLY_RECEIVED')`
  ).all(Number(costCenterId));
  let total = 0;
  for (const po of rows) {
    if (period && poPeriod(po) !== period) continue;
    total += Math.max(0, Number(po.committed_amount) - Number(po.received_value));
  }
  return round2(total);
}

function poView(po) {
  if (!po) return null;
  const lines = poLines(po.id);
  return {
    ...po,
    lines,
    total_amount: poTotal(po.id),
    received_value: poReceivedValue(po.id),
    received_quantity: poReceivedQty(po.id),
    open_commitment: round2(Math.max(0, Number(po.committed_amount) - poReceivedValue(po.id))),
  };
}

function poKpis() {
  const now = new Date().toISOString();
  const rows = db.prepare('SELECT * FROM purchase_order').all();
  // One grouped pass over the lines: received value per PO, no query per order.
  const receivedByPo = new Map(db.prepare(
    'SELECT purchase_order_id, IFNULL(SUM(received_quantity * unit_cost), 0) AS s FROM purchase_order_line GROUP BY purchase_order_id'
  ).all().map((r) => [r.purchase_order_id, round2(r.s)]));
  const open = rows.filter((p) => OPEN_PO_STATUSES.includes(p.status));
  let committed = 0;
  let received = 0;
  const overdue = [];
  for (const p of rows) received += receivedByPo.get(p.id) || 0;
  for (const p of open) {
    const receivedValue = receivedByPo.get(p.id) || 0;
    const openCommitment = Math.max(0, Number(p.committed_amount) - receivedValue);
    committed += openCommitment;
    if (p.expected_date && p.expected_date < now) {
      overdue.push({ id: p.id, po_number: p.po_number, supplier_id: p.supplier_id, expected_date: p.expected_date, status: p.status, open_commitment: round2(openCommitment) });
    }
  }
  return {
    total: rows.length,
    by_status: rows.reduce((acc, p) => { acc[p.status] = (acc[p.status] || 0) + 1; return acc; }, {}),
    open: open.length,
    committed: round2(committed),
    received_value: round2(received),
    overdue: overdue.length,
    overdue_items: overdue,
  };
}

module.exports = {
  PO_STATUSES, OPEN_PO_STATUSES,
  poLines, poTotal, poReceivedValue, poReceivedQty, derivedStatus, refreshStatus,
  poPeriod, openCommittedForCostCenter, poView, poKpis,
};
