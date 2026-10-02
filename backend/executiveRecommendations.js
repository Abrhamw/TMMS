const SEVERITY_RANK = { high: 0, medium: 1, low: 2 };

function num(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function make(severity, id, title, detail, action, link, metric) {
  return { id, severity, title, detail, action, link, metric };
}

function overdueRecommendation(input) {
  const tasks = input.overdue_tasks || [];
  if (!tasks.length) return null;
  const worst = tasks.slice().sort((a, b) => String(a.due_date).localeCompare(String(b.due_date)))[0];
  const critical = tasks.filter((t) => String(t.priority || '').toUpperCase() === 'CRITICAL').length;
  const severity = critical > 0 || tasks.length > 5 ? 'high' : 'medium';
  return make(
    severity,
    'overdue-work',
    `${tasks.length} overdue work order(s)`,
    `Oldest is ${worst.task_number || worst.title} due ${String(worst.due_date).slice(0, 10)}${critical ? `; ${critical} critical priority` : ''}.`,
    'Reassign owners and set recovery dates',
    '/tasks',
    { key: 'overdue_tasks', value: tasks.length },
  );
}

function lowConditionRecommendation(input) {
  const assets = input.low_condition || [];
  if (!assets.length) return null;
  const critical = assets.filter((a) => num(a.condition_rating) <= 3);
  const worst = assets.slice().sort((a, b) => num(a.condition_rating) - num(b.condition_rating))[0];
  const severity = critical.length ? 'high' : 'medium';
  return make(
    severity,
    'low-condition',
    `${assets.length} asset(s) at or below 5/10 condition`,
    `${critical.length} are critical (<=3); worst is ${worst.asset_id || worst.name} at ${worst.condition_rating}/10.`,
    'Review renewal and outage plans',
    '/assets',
    { key: 'low_condition_assets', value: assets.length },
  );
}

function certificationRecommendation(input) {
  const expired = input.expired_certifications || [];
  const expiring = input.expiring_certifications || [];
  if (!expired.length && !expiring.length) return null;
  const severity = expired.length ? 'high' : 'medium';
  return make(
    severity,
    'certification-expiry',
    `${expired.length} expired and ${expiring.length} expiring certification(s)`,
    'Crew eligibility may be constrained where certifications lapse.',
    'Schedule recertification and review crew eligibility',
    '/workforce',
    { key: 'expired_certifications', value: expired.length },
  );
}

function equipmentRecommendation(input) {
  const equipment = input.equipment || {};
  const missed = num(equipment.missed);
  const gaps = num(equipment.tasks_with_gaps);
  if (!missed && !gaps) return null;
  return make(
    missed > 0 ? 'medium' : 'low',
    'equipment-gaps',
    `${missed} recommended equipment item(s) unconfirmed`,
    `${gaps} open task(s) list equipment to secure but availability is not confirmed.`,
    'Confirm equipment availability before dispatch',
    '/tasks',
    { key: 'equipment_missed', value: missed },
  );
}

function costConcentrationRecommendation(input) {
  const owners = input.cost_concentration || [];
  const total = num(input.total_spend);
  if (!owners.length || total <= 0) return null;
  const top = owners[0];
  const share = num(top.share) || (num(top.spend) / total) * 100;
  if (share < 35) return null;
  return make(
    share >= 60 ? 'medium' : 'low',
    'cost-concentration',
    `Spend concentrated in ${top.owner}`,
    `${Math.round(share)}% of the last 12-month spend (${top.spend}) is attributed to one owner.`,
    'Review contract coverage and outage batching',
    '/executive?tab=cost',
    { key: 'top_owner_share', value: Math.round(share) },
  );
}

function degradationRecommendations(input) {
  const rows = input.degradation || [];
  return rows
    .filter((row) => num(row.delta) < 0 || num(row.performance_delta) < 0)
    .map((row) => {
      const delta = num(row.delta) !== 0 ? num(row.delta) : num(row.performance_delta);
      const severity = delta <= -3 ? 'high' : delta <= -1.5 ? 'medium' : 'low';
      const code = row.asset_code || row.asset_id || `#${row.asset_id}`;
      return make(
        severity,
        `degradation-${row.asset_id || code}`,
        `${code} degrading (${delta})`,
        `${row.asset_name || code}${row.region ? ` · ${row.region}` : ''} suggested rating ${row.suggested_rating ?? row.combined_rating ?? '—'}/10, action ${row.recommendation || 'INSPECT'}.`,
        'Review diagnostic evidence and schedule intervention',
        `/assets?id=${row.asset_id}`,
        { key: 'performance_delta', value: delta },
      );
    });
}

function exposureRecommendation(input) {
  const rows = input.overload_exposure || [];
  if (!rows.length) return null;
  const worst = rows[0];
  const count = num(worst.factor_count) || rows.length;
  return make(
    'medium',
    'overload-exposure',
    `${rows.length} asset(s) exposed to overload or faults`,
    `Highest exposure is ${worst.asset_code || worst.asset_id}, driven by ${count} loading/fault signal(s).`,
    'Verify protection settings and loading limits',
    `/assets?id=${worst.asset_id}`,
    { key: 'exposure_assets', value: rows.length },
  );
}

function renewalRecommendation(input) {
  const rows = input.renewal_candidates || [];
  if (!rows.length) return null;
  const top = rows[0];
  return make(
    'medium',
    'renewal-candidates',
    `${rows.length} asset(s) approaching renewal`,
    `${top.asset_code || top.asset_id} is the most advanced candidate${top.remaining_useful_life_years != null ? ` (~${top.remaining_useful_life_years} yr remaining)` : ''}.`,
    'Model capital renewal scenarios',
    `/assets?id=${top.asset_id}`,
    { key: 'renewal_candidates', value: rows.length },
  );
}

function buildRecommendations(input = {}, { now } = {}) {
  const generatorInput = { ...input };
  if (now != null && generatorInput.generated_at == null) generatorInput.generated_at = now;
  const candidates = [
    overdueRecommendation(generatorInput),
    lowConditionRecommendation(generatorInput),
    certificationRecommendation(generatorInput),
    degradationRecommendations(generatorInput),
    exposureRecommendation(generatorInput),
    renewalRecommendation(generatorInput),
    equipmentRecommendation(generatorInput),
    costConcentrationRecommendation(generatorInput),
  ];
  const flat = candidates.flat().filter(Boolean);
  const seen = new Set();
  const unique = [];
  for (const rec of flat) {
    if (seen.has(rec.id)) continue;
    seen.add(rec.id);
    unique.push(rec);
  }
  return unique.sort((a, b) => {
    const rank = (SEVERITY_RANK[a.severity] ?? 9) - (SEVERITY_RANK[b.severity] ?? 9);
    if (rank !== 0) return rank;
    const impact = Math.abs(num(b.metric?.value)) - Math.abs(num(a.metric?.value));
    if (impact !== 0) return impact;
    return String(a.id).localeCompare(String(b.id));
  });
}

module.exports = { buildRecommendations, SEVERITY_RANK };
