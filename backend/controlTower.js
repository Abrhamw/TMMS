'use strict';

const { db } = require('./util');
const { dispatchGate } = require('./readiness');
const { taskBudgetPeriod } = require('./budget');
const procurement = require('./procurement');

const OPEN_STATES = ['DRAFT', 'SCHEDULED', 'ASSIGNED', 'IN_PROGRESS', 'ON_HOLD', 'PENDING_VERIFICATION'];
const CLOSED_STATES = ['COMPLETED', 'CANCELLED', 'FAILED'];

function round2(n) {
  return Math.round((Number(n) || 0) * 100) / 100;
}

function pct(part, whole) {
  return whole ? Math.round((part / whole) * 1000) / 10 : 0;
}

function inWindow(iso, sinceMs) {
  const t = Date.parse(iso);
  return Number.isFinite(t) && t >= sinceMs;
}

function taskKpis(tasks, days) {
  const now = Date.now();
  const since = now - days * 86400000;
  const open = tasks.filter((t) => OPEN_STATES.includes(t.status));
  const overdue = open.filter((t) => t.due_date && Date.parse(t.due_date) < now);
  const dueSoon = open.filter((t) => t.due_date && Date.parse(t.due_date) >= now && Date.parse(t.due_date) <= now + 7 * 86400000);
  const completedInWindow = tasks.filter((t) => t.status === 'COMPLETED' && t.actual_end && inWindow(t.actual_end, since));
  const passed = completedInWindow.filter((t) => t.result === 'PASS').length;
  const failed = completedInWindow.filter((t) => t.result === 'FAIL').length;
  const ages = open.map((t) => (now - Date.parse(t.created_at)) / 86400000).filter((n) => Number.isFinite(n) && n >= 0);
  const byStatus = {};
  for (const t of tasks) byStatus[t.status] = (byStatus[t.status] || 0) + 1;
  return {
    total: tasks.length,
    by_status: byStatus,
    open: open.length,
    in_progress: tasks.filter((t) => t.status === 'IN_PROGRESS').length,
    pending_verification: tasks.filter((t) => t.status === 'PENDING_VERIFICATION').length,
    cost_pending: tasks.filter((t) => t.closure_state === 'COST_PENDING').length,
    financial_closed: tasks.filter((t) => t.closure_state === 'CLOSED').length,
    overdue: overdue.length,
    overdue_rate_pct: pct(overdue.length, open.length),
    due_next_7d: dueSoon.length,
    completed_in_window: completedInWindow.length,
    first_time_right_pct: pct(passed, completedInWindow.length),
    failed_in_window: failed,
    backlog_age_avg_days: ages.length ? Math.round((ages.reduce((s, n) => s + n, 0) / ages.length) * 10) / 10 : 0,
    backlog_age_max_days: ages.length ? Math.round(Math.max(...ages) * 10) / 10 : 0,
  };
}

// Readiness heat map by region plus the drill-down list of blocked tasks with
// the exact blocker codes, so a red cell can be traced to the responsible task.
function readiness(tasks) {
  const byRegion = new Map();
  const blocked = [];
  let ready = 0;
  for (const t of tasks) {
    if (!OPEN_STATES.includes(t.status)) continue;
    const gate = dispatchGate(t);
    if (gate.ready) { ready += 1; continue; }
    const regionId = t.region_id || 0;
    if (!byRegion.has(regionId)) byRegion.set(regionId, { region_id: regionId, blocked: 0, blockers: new Map(), sample_task_ids: [] });
    const cell = byRegion.get(regionId);
    cell.blocked += 1;
    if (cell.sample_task_ids.length < 5) cell.sample_task_ids.push(t.id);
    for (const b of gate.blockers) cell.blockers.set(b.code, (cell.blockers.get(b.code) || 0) + 1);
    blocked.push({ task_id: t.id, task_number: t.task_number, title: t.title, region_id: t.region_id || null, due_date: t.due_date || null, status: t.status, blockers: gate.blockers.map((b) => b.code) });
  }
  const heatmap = [...byRegion.values()]
    .map((c) => ({ region_id: c.region_id, blocked: c.blocked, top_blockers: [...c.blockers.entries()].sort((a, b) => b[1] - a[1]).map(([code, count]) => ({ code, count })), sample_task_ids: c.sample_task_ids }))
    .sort((a, b) => b.blocked - a.blocked);
  return { ready, blocked: blocked.length, heatmap, blocked_tasks: blocked };
}

function resourceKpis() {
  const rows = db.prepare('SELECT * FROM maintenance_resource WHERE active = 1').all();
  const now = Date.now();
  const byStatus = {};
  const calibrationDue = [];
  for (const r of rows) {
    byStatus[r.status] = (byStatus[r.status] || 0) + 1;
    if (r.calibration_expiry && Date.parse(r.calibration_expiry) < now && !['RETIRED', 'LOST', 'OUT_OF_SERVICE'].includes(r.status)) {
      calibrationDue.push({ resource_id: r.id, code: r.code, name: r.name, calibration_expiry: r.calibration_expiry });
    }
  }
  const reservations = db.prepare("SELECT resource_id, reserved_from, reserved_to FROM resource_reservation WHERE status = 'RESERVED' ORDER BY resource_id, reserved_from").all();
  const conflicts = [];
  let lastResource = null;
  let lastEnd = null;
  let lastStart = null;
  for (const r of reservations) {
    if (r.resource_id !== lastResource) { lastResource = r.resource_id; lastEnd = null; }
    else if (lastEnd && r.reserved_from < lastEnd) {
      conflicts.push({ resource_id: r.resource_id, from: lastStart, to: lastEnd, overlapping_from: r.reserved_from });
    }
    lastStart = r.reserved_from;
    lastEnd = r.reserved_to;
  }
  return {
    total: rows.length,
    by_status: byStatus,
    available: rows.filter((r) => r.status === 'AVAILABLE').length,
    maintenance: rows.filter((r) => r.status === 'MAINTENANCE').length,
    out_of_service: rows.filter((r) => ['OUT_OF_SERVICE', 'LOST', 'RETIRED'].includes(r.status)).length,
    calibration_due: calibrationDue.length,
    calibration_due_items: calibrationDue,
    conflicts: conflicts.length,
    conflict_items: conflicts,
  };
}

function materialKpis() {
  const items = db.prepare('SELECT * FROM material_item WHERE active = 1').all();
  // One grouped pass over the ledger instead of a balance query per item.
  const balances = db.prepare(
    `SELECT item_id, IFNULL(SUM(CASE WHEN type IN ('RECEIPT','RETURN') THEN quantity WHEN type = 'ISSUE' THEN -quantity WHEN type = 'ADJUSTMENT' THEN quantity ELSE 0 END), 0) AS on_hand
     FROM material_transaction GROUP BY item_id`
  ).all();
  const handByItem = new Map(balances.map((b) => [b.item_id, Number(b.on_hand)]));
  const belowReorder = [];
  const criticalShort = [];
  let itemsBelowReorder = 0;
  for (const it of items) {
    const hand = handByItem.get(it.id) || 0;
    if (it.reorder_point != null && hand <= Number(it.reorder_point)) {
      itemsBelowReorder += 1;
      belowReorder.push({ item_id: it.id, code: it.code, description: it.description, on_hand: Math.round(hand * 1000) / 1000, reorder_point: it.reorder_point });
    }
    if (it.criticality === 'CRITICAL' && hand <= 0) {
      criticalShort.push({ item_id: it.id, code: it.code, description: it.description, on_hand: Math.round(hand * 1000) / 1000 });
    }
  }
  const activeReservations = db.prepare("SELECT COUNT(*) c FROM material_reservation WHERE status = 'RESERVED'").get().c;
  return { total: items.length, below_reorder: itemsBelowReorder, below_reorder_items: belowReorder, critical_short: criticalShort.length, critical_short_items: criticalShort, active_reservations: activeReservations };
}

function defectKpis() {
  const now = new Date().toISOString();
  const rows = db.prepare("SELECT * FROM defect WHERE status IN ('OPEN','IN_PROGRESS','MITIGATED','RESOLVED')").all();
  const bySeverity = {};
  for (const d of rows) bySeverity[d.severity] = (bySeverity[d.severity] || 0) + 1;
  const overdue = rows.filter((d) => d.target_date && d.target_date < now);
  return { open: rows.length, by_severity: bySeverity, overdue: overdue.length, overdue_items: overdue.slice(0, 20).map((d) => ({ id: d.id, defect_number: d.defect_number, title: d.title, severity: d.severity, target_date: d.target_date, owner_person_id: d.owner_person_id })) };
}

function reliability(days) {
  const since = new Date(Date.now() - days * 86400000).toISOString();
  const repeats = db.prepare(
    `SELECT asset_id, COUNT(*) failures FROM task WHERE asset_id IS NOT NULL AND result = 'FAIL' AND actual_end >= ? GROUP BY asset_id HAVING COUNT(*) >= 2 ORDER BY failures DESC LIMIT 20`
  ).all(since);
  const defectsByAsset = db.prepare(
    "SELECT asset_id, COUNT(*) c FROM defect WHERE asset_id IS NOT NULL AND created_at >= ? GROUP BY asset_id HAVING COUNT(*) >= 2 ORDER BY c DESC LIMIT 20"
  ).all(since);
  return { repeat_failure_assets: repeats, defect_hotspot_assets: defectsByAsset };
}

function costKpis(taskIds) {
  if (!taskIds.length) return { planned: 0, committed: 0, actual: 0, variance: 0, by_category: {}, over_budget_tasks: 0 };
  const ph = taskIds.map(() => '?').join(',');
  const sum = (sql) => Number(db.prepare(sql).get(...taskIds).s) || 0;
  const planned = round2(sum(`SELECT IFNULL(SUM(amount),0) s FROM cost_estimate WHERE task_id IN (${ph})`));
  const committed = round2(sum(`SELECT IFNULL(SUM(amount),0) s FROM cost_commitment WHERE status = 'OPEN' AND task_id IN (${ph})`));
  const labor = round2(sum(`SELECT IFNULL(SUM(labor_cost),0) s FROM time_entry WHERE status = 'APPROVED' AND task_id IN (${ph})`));
  const equipment = round2(sum(`SELECT IFNULL(SUM(cost),0) s FROM resource_usage WHERE status = 'APPROVED' AND task_id IN (${ph})`));
  const material = round2(sum(`SELECT IFNULL(SUM(cost),0) s FROM material_transaction WHERE type IN ('CONSUMPTION','SCRAP') AND task_id IN (${ph})`));
  const direct = round2(sum(`SELECT IFNULL(SUM(amount),0) s FROM cost_transaction WHERE status = 'APPROVED' AND task_id IN (${ph})`));
  const verification = round2(sum(`SELECT IFNULL(SUM(cost),0) s FROM asset_maintenance_event WHERE task_id IN (${ph})`));
  const actual = round2(labor + equipment + material + direct + verification);
  const overBudget = db.prepare(`SELECT task_id FROM cost_estimate WHERE task_id IN (${ph}) GROUP BY task_id`).all(...taskIds).length;
  return {
    planned, committed, actual, variance: round2(actual - planned),
    by_category: { LABOR: labor, EQUIPMENT: equipment, MATERIAL: material, DIRECT: direct, VERIFICATION: verification },
    tasks_with_estimate: overBudget,
  };
}

function laborKpis(taskIds, days) {
  if (!taskIds.length) return { hours: 0, overtime_hours: 0, labor_cost: 0, travel_standby_minutes: 0 };
  const ph = taskIds.map(() => '?').join(',');
  const since = new Date(Date.now() - days * 86400000).toISOString();
  const row = db.prepare(
    `SELECT IFNULL(SUM(hours),0) hours, IFNULL(SUM(overtime_minutes),0) ot, IFNULL(SUM(labor_cost),0) cost,
            IFNULL(SUM(travel_minutes + standby_minutes),0) travel FROM time_entry
     WHERE status = 'APPROVED' AND work_date >= ? AND task_id IN (${ph})`
  ).get(since.slice(0, 10), ...taskIds);
  return {
    hours: round2(row.hours),
    overtime_hours: round2((Number(row.ot) || 0) / 60),
    travel_standby_minutes: Number(row.travel) || 0,
    labor_cost: round2(row.cost),
  };
}

function budgetKpis(tasks) {
  // Resolve cost centers/prices from maps loaded once, and aggregate every
  // ledger by task in a single grouped query, instead of issuing a handful of
  // SUM queries per cost-center group.
  const ccById = new Map(db.prepare('SELECT * FROM cost_center').all().map((c) => [c.id, c]));
  const regionDefault = new Map();
  for (const c of db.prepare('SELECT * FROM cost_center WHERE region_id IS NOT NULL AND active = 1 ORDER BY id').all()) {
    if (!regionDefault.has(c.region_id)) regionDefault.set(c.region_id, c);
  }
  const budgetByKey = new Map();
  for (const b of db.prepare('SELECT cost_center_id, period, IFNULL(SUM(amount),0) amount FROM budget GROUP BY cost_center_id, period').all()) {
    budgetByKey.set(`${b.cost_center_id}|${b.period}`, round2(b.amount));
  }

  const groups = new Map();
  for (const t of tasks) {
    const cc = (t.cost_center_id && ccById.get(t.cost_center_id)) || (t.region_id ? regionDefault.get(t.region_id) : null) || null;
    if (!cc) continue;
    const period = taskBudgetPeriod(t);
    const key = `${cc.id}|${period}`;
    if (!groups.has(key)) {
      groups.set(key, { cost_center_id: cc.id, code: cc.code, name: cc.name, period, budgeted: budgetByKey.get(key) || 0, task_ids: [] });
    }
    groups.get(key).task_ids.push(t.id);
  }

  const ids = tasks.map((t) => t.id);
  const byTask = (sql) => {
    if (!ids.length) return new Map();
    const ph = ids.map(() => '?').join(',');
    return new Map(db.prepare(sql.replace('/*ph*/', ph)).all(...ids).map((r) => [r.task_id, Number(r.s) || 0]));
  };
  const committedByTask = byTask(`SELECT task_id, IFNULL(SUM(amount),0) s FROM cost_commitment WHERE status = 'OPEN' AND task_id IN (/*ph*/) GROUP BY task_id`);
  const laborByTask = byTask(`SELECT task_id, IFNULL(SUM(labor_cost),0) s FROM time_entry WHERE status = 'APPROVED' AND task_id IN (/*ph*/) GROUP BY task_id`);
  const equipmentByTask = byTask(`SELECT task_id, IFNULL(SUM(cost),0) s FROM resource_usage WHERE status = 'APPROVED' AND task_id IN (/*ph*/) GROUP BY task_id`);
  const materialByTask = byTask(`SELECT task_id, IFNULL(SUM(cost),0) s FROM material_transaction WHERE type IN ('CONSUMPTION','SCRAP') AND task_id IN (/*ph*/) GROUP BY task_id`);
  const directByTask = byTask(`SELECT task_id, IFNULL(SUM(amount),0) s FROM cost_transaction WHERE status = 'APPROVED' AND task_id IN (/*ph*/) GROUP BY task_id`);
  const verificationByTask = byTask(`SELECT task_id, IFNULL(SUM(cost),0) s FROM asset_maintenance_event WHERE task_id IN (/*ph*/) GROUP BY task_id`);
  const sumFor = (map, taskIds) => taskIds.reduce((s, id) => s + (map.get(id) || 0), 0);

  let budgetedTotal = 0;
  let committedTotal = 0;
  let poCommittedTotal = 0;
  let actualTotal = 0;
  let over = 0;
  let unbudgeted = 0;
  const items = [];
  for (const g of groups.values()) {
    const committed = round2(sumFor(committedByTask, g.task_ids));
    const actual = round2(
      sumFor(laborByTask, g.task_ids) + sumFor(equipmentByTask, g.task_ids) +
      sumFor(materialByTask, g.task_ids) + sumFor(directByTask, g.task_ids) +
      sumFor(verificationByTask, g.task_ids)
    );
    const exposure = round2(committed + actual);
    const poCommitted = procurement.openCommittedForCostCenter(g.cost_center_id, g.period);
    const totalExposure = round2(exposure + poCommitted);
    const overBudget = g.budgeted > 0 && totalExposure > g.budgeted;
    if (overBudget) over += 1;
    if (g.budgeted <= 0) unbudgeted += 1;
    budgetedTotal += g.budgeted;
    committedTotal += committed;
    poCommittedTotal += poCommitted;
    actualTotal += actual;
    items.push({
      cost_center_id: g.cost_center_id, cost_center_code: g.code, cost_center_name: g.name, period: g.period,
      budgeted: g.budgeted, committed, po_committed: poCommitted, actual, exposure: totalExposure,
      available: round2(g.budgeted - totalExposure), over_budget: overBudget, work_packages: g.task_ids.length,
    });
  }
  items.sort((a, b) => (Number(b.over_budget) - Number(a.over_budget)) || (b.exposure - a.exposure));
  return {
    budgeted: round2(budgetedTotal),
    committed: round2(committedTotal),
    po_committed: round2(poCommittedTotal),
    actual: round2(actualTotal),
    available: round2(budgetedTotal - committedTotal - poCommittedTotal - actualTotal),
    over_budget_cost_centers: over,
    unbudgeted_cost_centers: unbudgeted,
    by_cost_center: items,
  };
}

function build(tasks, opts = {}) {
  const days = Number(opts.days) > 0 ? Number(opts.days) : 30;
  const ids = tasks.map((t) => t.id);
  return {
    generated_at: new Date().toISOString(),
    window_days: days,
    tasks: taskKpis(tasks, days),
    readiness: readiness(tasks),
    resources: resourceKpis(),
    materials: materialKpis(),
    defects: defectKpis(),
    costs: costKpis(ids),
    budgets: budgetKpis(tasks),
    purchasing: procurement.poKpis(),
    labor: laborKpis(ids, days),
    reliability: reliability(days),
  };
}

module.exports = { OPEN_STATES, CLOSED_STATES, taskKpis, readiness, resourceKpis, materialKpis, defectKpis, costKpis, budgetKpis, laborKpis, reliability, build };
