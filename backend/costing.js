'use strict';

const { db, get } = require('./util');
const { taskLaborSummary } = require('./labor');
const { taskResourceSummary } = require('./resources');
const { taskMaterialSummary } = require('./materials');

const COST_CATEGORIES = new Set(['LABOR', 'EQUIPMENT', 'MATERIAL', 'CONTRACTOR', 'SERVICE', 'TRAVEL', 'ACCOMMODATION', 'PER_DIEM', 'OTHER']);
const COMMITMENT_STATUSES = new Set(['OPEN', 'RELEASED', 'FULFILLED']);
const CLOSURE_STATES = new Set(['OPEN', 'COST_PENDING', 'CLOSED']);

function round2(n) {
  return Math.round((Number(n) || 0) * 100) / 100;
}

function sumAmounts(table, taskId, extraWhere = '', params = []) {
  const row = db.prepare(`SELECT IFNULL(SUM(amount), 0) AS s FROM ${table} WHERE task_id = ? ${extraWhere}`).get(taskId, ...params);
  return round2(row.s);
}

function plannedCost(taskId) {
  return sumAmounts('cost_estimate', taskId);
}

function committedCost(taskId) {
  return sumAmounts('cost_commitment', taskId, "AND status = 'OPEN'");
}

function verificationCost(taskId) {
  const row = db.prepare('SELECT IFNULL(SUM(cost), 0) AS s FROM asset_maintenance_event WHERE task_id = ?').get(taskId);
  return round2(row.s);
}

// Actual cost is assembled from the immutable ledgers that already exist, so it
// can always be reconstructed from transactions rather than a single figure
// typed at verification. The optional spend recorded at verification is kept as
// its own line to avoid double counting.
function taskCostSummary(taskId) {
  const labor = taskLaborSummary(taskId).labor_cost;
  const equipment = taskResourceSummary(taskId).resource_cost;
  const material = taskMaterialSummary(taskId).material_cost;
  const direct = sumAmounts('cost_transaction', taskId, "AND status = 'APPROVED'");
  const verification = verificationCost(taskId);
  const actual = round2(labor + equipment + material + direct + verification);
  const planned = plannedCost(taskId);
  const committed = committedCost(taskId);
  const variance = round2(actual - planned);
  const t = get('task', taskId);
  const categories = {
    LABOR: labor,
    EQUIPMENT: equipment,
    MATERIAL: material,
    DIRECT: direct,
    VERIFICATION: verification,
  };
  return {
    task_id: Number(taskId),
    currency: (t && t.currency) || 'USD',
    planned_cost: planned,
    committed_cost: committed,
    actual_cost: actual,
    variance,
    variance_reason: t ? t.variance_reason || null : null,
    by_category: categories,
    unreconciled_exposure: round2(committed - actual) > 0 ? round2(committed - actual) : 0,
    cost_reconciled_at: t ? t.cost_reconciled_at || null : null,
    closure_state: t ? t.closure_state || 'OPEN' : 'OPEN',
  };
}

function taskTemplateIds(taskId) {
  const ids = new Set();
  const legacy = db.prepare('SELECT checklist_template_id FROM task WHERE id = ?').get(taskId);
  if (legacy && legacy.checklist_template_id) ids.add(Number(legacy.checklist_template_id));
  for (const r of db.prepare('SELECT template_id FROM task_checklist_template WHERE task_id = ?').all(taskId)) ids.add(Number(r.template_id));
  return [...ids];
}

function count(sql, ...params) {
  return db.prepare(sql).get(...params).c;
}

// Evaluate the multi-dimensional closure gates. Each gate reports whether it is
// satisfied, whether it blocks closure, and a human-readable detail. The task
// may move to CLOSED only when every blocking gate is satisfied; technical work
// that is done but not yet reconciled sits at COST_PENDING.
function closureGates(t) {
  if (!t) return { gates: [], ready_to_close: false, cost_pending: false };
  const id = t.id;
  const cost = taskCostSummary(id);
  const gates = [];

  const technicallyDone = t.status === 'COMPLETED' || t.status === 'CLOSED';
  gates.push({
    gate: 'TECHNICAL', blocking: true, satisfied: technicallyDone && !!t.result,
    detail: technicallyDone ? `Result recorded: ${t.result || 'not recorded'}` : `Task status is ${t.status}`,
  });

  const safetyOk = !t.permit_required || !!t.permit_approved_at;
  gates.push({
    gate: 'SAFETY_PERMIT', blocking: true, satisfied: safetyOk,
    detail: safetyOk ? (t.permit_required ? 'Permit approved' : 'No permit required') : 'Permit not approved',
  });

  const pendingLabor = count("SELECT COUNT(*) c FROM time_entry WHERE task_id = ? AND status IN ('DRAFT', 'SUBMITTED')", id);
  gates.push({
    gate: 'LABOR', blocking: true, satisfied: pendingLabor === 0,
    detail: pendingLabor === 0 ? `Labor committed: ${cost.by_category.LABOR}` : `${pendingLabor} time entr${pendingLabor === 1 ? 'y' : 'ies'} awaiting approval`,
  });

  const openReservations = count("SELECT COUNT(*) c FROM resource_reservation WHERE task_id = ? AND status = 'RESERVED'", id);
  const pendingUsage = count("SELECT COUNT(*) c FROM resource_usage WHERE task_id = ? AND status IN ('DRAFT', 'SUBMITTED')", id);
  gates.push({
    gate: 'EQUIPMENT', blocking: true, satisfied: openReservations === 0 && pendingUsage === 0,
    detail: openReservations === 0 && pendingUsage === 0 ? `Equipment cost: ${cost.by_category.EQUIPMENT}` : `${openReservations} open reservation(s), ${pendingUsage} usage entr${pendingUsage === 1 ? 'y' : 'ies'} pending`,
  });

  const openMaterialReservations = count("SELECT COUNT(*) c FROM material_reservation WHERE task_id = ? AND status = 'RESERVED'", id);
  const matSummary = taskMaterialSummary(id);
  gates.push({
    gate: 'MATERIALS', blocking: true, satisfied: openMaterialReservations === 0 && matSummary.outstanding_qty <= 0,
    detail: openMaterialReservations === 0 && matSummary.outstanding_qty <= 0
      ? `Material cost: ${cost.by_category.MATERIAL}`
      : `${openMaterialReservations} reserved, ${matSummary.outstanding_qty} issued and not reconciled`,
  });

  const pendingDirect = count("SELECT COUNT(*) c FROM cost_transaction WHERE task_id = ? AND status = 'DRAFT'", id);
  const tolerance = Math.max(1, Math.abs(cost.planned_cost) * 0.05);
  const varianceExplained = Math.abs(cost.variance) <= tolerance || !!t.variance_reason;
  const costReconciled = !!t.cost_reconciled_at && pendingDirect === 0 && varianceExplained;
  gates.push({
    gate: 'COST', blocking: true, satisfied: costReconciled,
    detail: !t.cost_reconciled_at ? 'Cost not reconciled'
      : pendingDirect > 0 ? `${pendingDirect} cost transaction(s) awaiting approval`
        : !varianceExplained ? `Variance ${cost.variance} needs a reason` : 'Cost reconciled',
  });

  const gpsRequired = taskTemplateIds(id)
    .map((tid) => get('checklist_template', tid))
    .some((tpl) => tpl && tpl.requires_gps_confirmation);
  const gpsAny = count('SELECT COUNT(*) c FROM gps_validation WHERE linked_task_id = ?', id);
  gates.push({
    gate: 'LOCATION', blocking: gpsRequired, satisfied: !gpsRequired || gpsAny > 0,
    detail: !gpsRequired ? 'No GPS requirement' : gpsAny > 0 ? 'GPS validation on record' : 'GPS validation missing',
  });

  const assetEvent = t.asset_id ? count('SELECT COUNT(*) c FROM asset_maintenance_event WHERE task_id = ?', id) : 0;
  gates.push({
    gate: 'ASSET_HISTORY', blocking: true, satisfied: !t.asset_id || assetEvent > 0,
    detail: !t.asset_id ? 'No asset linked' : assetEvent > 0 ? 'Asset maintenance event recorded' : 'Asset history not updated',
  });

  // A defect stays open until its corrective task is verified, so unresolved
  // defects block closure. The originating inspection remains traceable to the
  // final corrective action.
  const openDefects = count("SELECT COUNT(*) c FROM defect WHERE task_id = ? AND status IN ('OPEN', 'IN_PROGRESS', 'MITIGATED', 'RESOLVED')", id);
  gates.push({
    gate: 'FOLLOW_UP', blocking: true, satisfied: openDefects === 0,
    detail: openDefects === 0 ? 'No open defects' : `${openDefects} defect(s) still open`,
  });

  gates.push({
    gate: 'MANAGEMENT', blocking: false, satisfied: !!t.management_acceptance_at,
    detail: t.management_acceptance_at ? 'Management acceptance recorded' : 'Management acceptance not recorded',
  });

  const blockingGates = gates.filter((g) => g.blocking);
  const ready = blockingGates.every((g) => g.satisfied);
  const costGate = gates.find((g) => g.gate === 'COST');
  const otherBlockingReady = blockingGates.filter((g) => g.gate !== 'COST').every((g) => g.satisfied);
  return { gates, ready_to_close: ready, cost_pending: otherBlockingReady && !costGate.satisfied };
}

module.exports = {
  COST_CATEGORIES, COMMITMENT_STATUSES, CLOSURE_STATES,
  plannedCost, committedCost, verificationCost, taskCostSummary, closureGates,
};
