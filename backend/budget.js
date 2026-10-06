'use strict';

const { db, get, list } = require('./util');
const { taskCostSummary, plannedCost, committedCost } = require('./costing');
const procurement = require('./procurement');

function round2(n) {
  return Math.round((Number(n) || 0) * 100) / 100;
}

// A budget period is the calendar month (YYYY-MM) a task's spend is booked to.
// Finished work books to its real end; in-flight work books to the planned
// window so future exposure is visible before the money is spent.
function periodOf(value) {
  const d = value ? new Date(value) : new Date();
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString().slice(0, 7);
}

function taskBudgetPeriod(t) {
  if (!t) return null;
  return periodOf(t.actual_end) || periodOf(t.scheduled_start) || periodOf(t.due_date) || periodOf(t.created_at) || periodOf(new Date());
}

// Resolve the cost center a task's spend belongs to: the explicit assignment
// wins; otherwise fall back to the active default cost center of its region.
function resolveCostCenter(t) {
  if (!t) return null;
  const explicit = t.cost_center_id ? get('cost_center', t.cost_center_id) : null;
  if (explicit) return explicit;
  if (t.region_id) {
    return db.prepare('SELECT * FROM cost_center WHERE region_id = ? AND active = 1 ORDER BY id LIMIT 1').get(t.region_id) || null;
  }
  return null;
}

function budgetRows(costCenterId, period) {
  return db.prepare('SELECT * FROM budget WHERE cost_center_id = ? AND period = ?').all(costCenterId, period);
}

function budgetAmount(costCenterId, period) {
  return round2(db.prepare('SELECT IFNULL(SUM(amount), 0) AS s FROM budget WHERE cost_center_id = ? AND period = ?').get(costCenterId, period).s);
}

function scopedTasks(costCenterId, period) {
  return db.prepare('SELECT * FROM task').all().filter((t) => {
    if (taskBudgetPeriod(t) !== period) return false;
    const cc = resolveCostCenter(t);
    return cc && cc.id === costCenterId;
  });
}

function budgetStatus(costCenterId, period) {
  const cc = get('cost_center', costCenterId);
  if (!cc) return null;
  const tasks = scopedTasks(costCenterId, period);
  let planned = 0;
  let committed = 0;
  let actual = 0;
  for (const t of tasks) {
    planned += plannedCost(t.id);
    committed += committedCost(t.id);
    actual += taskCostSummary(t.id).actual_cost;
  }
  const budgeted = budgetAmount(costCenterId, period);
  const poCommitted = procurement.openCommittedForCostCenter(costCenterId, period);
  const exposure = round2(committed + actual + poCommitted);
  const available = round2(budgeted - exposure);
  return {
    cost_center_id: cc.id,
    cost_center_code: cc.code,
    cost_center_name: cc.name,
    period,
    currency: (tasks[0] && tasks[0].currency) || 'USD',
    budgeted,
    work_packages: tasks.length,
    planned: round2(planned),
    committed: round2(committed),
    po_committed: poCommitted,
    actual: round2(actual),
    exposure,
    available,
    over_budget: budgeted > 0 && exposure > budgeted,
  };
}

function taskBudget(t) {
  const cc = resolveCostCenter(t);
  const period = taskBudgetPeriod(t);
  if (!cc || !period) return { cost_center: cc || null, period, budgeted: 0, over_budget: false };
  return { cost_center: cc, ...budgetStatus(cc.id, period) };
}

// Evaluate a proposed commitment against the remaining budget. A cost center
// with no budget row defined is treated as unbudgeted (not enforced) rather
// than blocked, so the control is opt-in per cost center.
function checkCommitment(t, amount) {
  const cc = resolveCostCenter(t);
  if (!cc) return { enforced: false, over_budget: false, cost_center: null };
  const period = taskBudgetPeriod(t);
  const status = budgetStatus(cc.id, period);
  const projected = round2(status.exposure + Number(amount));
  return {
    enforced: status.budgeted > 0,
    cost_center: { id: cc.id, code: cc.code, name: cc.name },
    period,
    budgeted: status.budgeted,
    exposure_before: status.exposure,
    projected,
    available_after: round2(status.budgeted - projected),
    over_budget: status.budgeted > 0 && projected > status.budgeted,
  };
}

function overBudgetCostCenters(period) {
  return list('cost_center')
    .map((cc) => budgetStatus(cc.id, period))
    .filter((s) => s && s.over_budget);
}

// Evaluate a purchase order about to be committed against its cost center
// budget. Mirrors checkCommitment so approval and task commitments share one
// ceiling calculation.
function checkCommitmentForPo(po, amount) {
  if (!po || !po.cost_center_id) return { enforced: false, over_budget: false, cost_center: null };
  const cc = get('cost_center', po.cost_center_id);
  const period = procurement.poPeriod(po);
  const status = budgetStatus(cc.id, period);
  const projected = round2(status.exposure + Number(amount));
  return {
    enforced: status.budgeted > 0,
    cost_center: { id: cc.id, code: cc.code, name: cc.name },
    period,
    budgeted: status.budgeted,
    exposure_before: status.exposure,
    projected,
    available_after: round2(status.budgeted - projected),
    over_budget: status.budgeted > 0 && projected > status.budgeted,
  };
}

module.exports = {
  periodOf, taskBudgetPeriod, resolveCostCenter, budgetAmount, budgetStatus,
  taskBudget, checkCommitment, checkCommitmentForPo, overBudgetCostCenters,
};
