process.env.TMMS_DB = require('node:path').join(require('node:os').tmpdir(), `tmms-budget-${process.pid}-${Date.now()}.db`);

const test = require('node:test');
const assert = require('node:assert');

const { initSchema } = require('../db');
const { insertRow, get, list } = require('../util');
initSchema();

const budget = require('../budget');
const tower = require('../controlTower');

const NOW = new Date().toISOString();
const PERIOD = NOW.slice(0, 7);

function region(code) {
  return insertRow('region', { code, name: code, type: 'CUSTOM', center_lat: 0, center_lng: 0, boundary: 1, status: 'ACTIVE', timezone: 'UTC' });
}

function task(regionId, number, extra = {}) {
  return insertRow('task', {
    task_number: `TK-2026-78${number}`, title: `Budget ${number}`, task_type: 'INSPECTION', priority: 'LOW',
    status: 'COMPLETED', result: 'PASS', region_id: regionId, actual_end: NOW, due_date: NOW,
    created_at: NOW, updated_at: NOW, source: 'MANUAL', ...extra,
  });
}

test('resolveCostCenter prefers explicit assignment over the region default', () => {
  const regionId = region('BUD-R1');
  const defaultCc = insertRow('cost_center', { code: 'BUD-CC-DEF', name: 'Default', region_id: regionId, active: 1, created_at: NOW, updated_at: NOW });
  const explicitCc = insertRow('cost_center', { code: 'BUD-CC-EXP', name: 'Explicit', region_id: null, active: 1, created_at: NOW, updated_at: NOW });
  const t1 = task(regionId, '0001');
  const t2 = task(regionId, '0002', { cost_center_id: explicitCc });

  assert.strictEqual(budget.resolveCostCenter(get('task', t1)).id, defaultCc);
  assert.strictEqual(budget.resolveCostCenter(get('task', t2)).id, explicitCc);
});

test('budgetStatus aggregates planned, committed and actual against the period ceiling', () => {
  const regionId = region('BUD-R2');
  const ccId = insertRow('cost_center', { code: 'BUD-CC-1', name: 'Som CC', region_id: regionId, active: 1, created_at: NOW, updated_at: NOW });
  const t = task(regionId, '0010');
  const personId = insertRow('person', { first_name: 'Bud', last_name: 'Get', role: 'STAFF', active: 1 });

  insertRow('budget', { cost_center_id: ccId, period: PERIOD, amount: 1000, created_at: NOW, updated_at: NOW });
  insertRow('cost_estimate', { task_id: t, category: 'LABOR', amount: 400, created_at: NOW, updated_at: NOW });
  insertRow('cost_commitment', { task_id: t, category: 'CONTRACTOR', amount: 200, status: 'OPEN', created_at: NOW, updated_at: NOW });
  insertRow('time_entry', { task_id: t, person_id: personId, work_date: PERIOD + '-05', kind: 'NORMAL', hours: 5, labor_cost: 100, status: 'APPROVED', created_at: NOW, updated_at: NOW });

  const status = budget.budgetStatus(ccId, PERIOD);
  assert.strictEqual(status.budgeted, 1000);
  assert.strictEqual(status.planned, 400);
  assert.strictEqual(status.committed, 200);
  assert.strictEqual(status.actual, 100);
  assert.strictEqual(status.exposure, 300);
  assert.strictEqual(status.available, 700);
  assert.strictEqual(status.over_budget, false);
});

test('checkCommitment flags an over-budget projection and is opt-in for unbudgeted centers', () => {
  const regionId = region('BUD-R3');
  const ccId = insertRow('cost_center', { code: 'BUD-CC-2', name: 'Tight CC', region_id: regionId, active: 1, created_at: NOW, updated_at: NOW });
  const bareCcId = insertRow('cost_center', { code: 'BUD-CC-BARE', name: 'Unbudgeted', region_id: null, active: 1, created_at: NOW, updated_at: NOW });
  const t = task(regionId, '0020', { cost_center_id: ccId });
  const bare = task(regionId, '0021', { cost_center_id: bareCcId });

  insertRow('budget', { cost_center_id: ccId, period: PERIOD, amount: 500, created_at: NOW, updated_at: NOW });
  insertRow('cost_commitment', { task_id: t, category: 'SERVICE', amount: 400, status: 'OPEN', created_at: NOW, updated_at: NOW });

  const over = budget.checkCommitment(get('task', t), 200);
  assert.strictEqual(over.enforced, true);
  assert.strictEqual(over.exposure_before, 400);
  assert.strictEqual(over.projected, 600);
  assert.strictEqual(over.available_after, -100);
  assert.strictEqual(over.over_budget, true);

  const ok = budget.checkCommitment(get('task', t), 50);
  assert.strictEqual(ok.over_budget, false);

  const unbudgeted = budget.checkCommitment(get('task', bare), 9999);
  assert.strictEqual(unbudgeted.enforced, false);
  assert.strictEqual(unbudgeted.over_budget, false);
});

test('control tower budgetKpis groups spend by cost center and period', () => {
  const regionId = region('BUD-R4');
  const ccId = insertRow('cost_center', { code: 'BUD-CC-3', name: 'Tower CC', region_id: regionId, active: 1, created_at: NOW, updated_at: NOW });
  const t = task(regionId, '0030', { cost_center_id: ccId });
  insertRow('budget', { cost_center_id: ccId, period: PERIOD, amount: 100, created_at: NOW, updated_at: NOW });
  insertRow('cost_commitment', { task_id: t, category: 'OTHER', amount: 250, status: 'OPEN', created_at: NOW, updated_at: NOW });

  const kpis = tower.budgetKpis(list('task'));
  assert.strictEqual(kpis.over_budget_cost_centers, 1);
  const cell = kpis.by_cost_center.find((c) => c.cost_center_id === ccId);
  assert.ok(cell);
  assert.strictEqual(cell.budgeted, 100);
  assert.strictEqual(cell.committed, 250);
  assert.strictEqual(cell.exposure, 250);
  assert.strictEqual(cell.available, -150);
  assert.strictEqual(cell.over_budget, true);
});
