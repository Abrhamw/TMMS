const express = require('express');
const { db, list, get } = require('../util');
const { isGlobal } = require('../auth');
const { taskVisible, authorizedCrewIds, readCrewIds, regionWideRead, isManager } = require('../authority');
const { taskReadiness } = require('../readiness');
const { maintenanceCostForRegions } = require('../maintenanceCost');
const { computeRegionValuation, mergeValuations } = require('./register');

const router = express.Router();

const OPEN = ['DRAFT', 'SCHEDULED', 'ASSIGNED', 'IN_PROGRESS', 'ON_HOLD', 'PENDING_VERIFICATION'];

// People attached to a region: directorate/station personnel plus the members
// of every crew stationed in the region.
function peopleInRegion(regionId) {
  const personnel = db.prepare('SELECT person_id FROM region_personnel WHERE region_id = ?').all(regionId).map((x) => x.person_id);
  const crews = db.prepare('SELECT id FROM crew WHERE region_id = ?').all(regionId).map((x) => x.id);
  const memberIds = crews.length
    ? db.prepare(`SELECT person_id FROM crew_member WHERE active = 1 AND crew_id IN (${crews.map(() => '?').join(',')})`).all(...crews).map((x) => x.person_id)
    : [];
  return new Set([...personnel, ...memberIds]);
}

// Certifications that belong to people in scope (region roles see their own
// region only; field/crew users see their own certifications via /home).
// Department managers are scoped to their own command; a region manager reads
// the whole region.
function certsInScope(user) {
  const certs = list('certification');
  if (isGlobal(user)) return certs;
  let people;
  if (isManager(user) && !regionWideRead(user)) {
    const crewIds = [...authorizedCrewIds(user)];
    const memberIds = crewIds.length
      ? db.prepare(`SELECT person_id FROM crew_member WHERE active = 1 AND crew_id IN (${crewIds.map(() => '?').join(',')})`).all(...crewIds).map((x) => x.person_id)
      : [];
    const leaderIds = list('crew').filter((c) => crewIds.includes(c.id) && c.leader_person_id).map((c) => c.leader_person_id);
    people = new Set([...memberIds, ...leaderIds]);
    if (user.person_id) people.add(user.person_id);
  } else {
    people = peopleInRegion(user.region_id);
  }
  return certs.filter((c) => people.has(c.person_id));
}

router.get('/summary', (req, res) => {
  const user = req.user;
  const now = new Date().toISOString();
  const inScope = (t) => taskVisible(user, t);
  const tasks = list('task').filter(inScope);
  const openTasks = tasks.filter((t) => OPEN.includes(t.status));
  const overdue = openTasks.filter((t) => t.due_date < now);
  const allAssets = list('asset').filter((a) => a.lifecycle_status !== 'REMOVED');
  const assets = allAssets.filter((a) => {
    if (isGlobal(user)) return true;
    if (a.substation_id) return get('substation', a.substation_id)?.region_id === user.region_id;
    if (a.line_id) return get('transmission_line', a.line_id)?.region_id === user.region_id;
    return false;
  });

  const conditionBuckets = {
    critical: assets.filter((a) => a.condition_rating <= 3).length,
    poor: assets.filter((a) => a.condition_rating >= 4 && a.condition_rating <= 5).length,
    fair: assets.filter((a) => a.condition_rating >= 6 && a.condition_rating <= 7).length,
    good: assets.filter((a) => a.condition_rating >= 8).length,
  };

  const taskByStatus = {};
  for (const t of tasks) taskByStatus[t.status] = (taskByStatus[t.status] || 0) + 1;

  const taskByType = {};
  for (const t of openTasks) taskByType[t.task_type] = (taskByType[t.task_type] || 0) + 1;

  const scopedRegions = isGlobal(user) ? list('region') : list('region').filter((r) => r.id === user.region_id);
  const regionActivity = scopedRegions.map((r) => {
    const open = openTasks.filter((t) => t.region_id === r.id);
    const gps = db.prepare('SELECT * FROM gps_validation WHERE region_id = ?').all(r.id);
    const fails = gps.filter((v) => v.result === 'FAIL').length;
    return {
      name: r.name,
      code: r.code,
      open_tasks: open.length,
      overdue: open.filter((t) => t.due_date < now).length,
      gps_validation_count: gps.length,
      gps_fail_count: fails,
    };
  });

  const recentTasks = db.prepare('SELECT * FROM task ORDER BY created_at DESC LIMIT 8').all().filter(inScope).map((t) => ({
    ...t,
    region: get('region', t.region_id),
    crew: t.crew_id ? get('crew', t.crew_id) : null,
  }));

  const certs = certsInScope(user);
  const certExpiring = certs.filter((c) => {
    const days = (new Date(c.expires_at) - new Date()) / (24 * 3600 * 1000);
    return days >= 0 && days <= 90;
  }).length;

  res.json({
    counts: {
      regions: scopedRegions.length,
      substations: list('substation').filter((s) => isGlobal(user) || s.region_id === user.region_id).length,
      lines: list('transmission_line').filter((l) => isGlobal(user) || l.region_id === user.region_id).length,
      towers: list('tower').filter((t) => {
        if (isGlobal(user)) return true;
        const l = get('transmission_line', t.line_id);
        return l && l.region_id === user.region_id;
      }).length,
      assets: assets.length,
      crews: readCrewIds(user).size,
    },
    tasks: {
      total: tasks.length,
      open: openTasks.length,
      overdue: overdue.length,
      completed: tasks.filter((t) => t.status === 'COMPLETED').length,
      completion_rate: tasks.length ? Math.round((tasks.filter((t) => t.status === 'COMPLETED').length / tasks.length) * 100) : 0,
      by_status: taskByStatus,
      by_type: taskByType,
    },
    gps: {
      validated_assets: assets.filter((a) => a.gps_validated).length,
      total_assets: assets.length,
      coverage: assets.length ? Math.round((assets.filter((a) => a.gps_validated).length / assets.length) * 100) : 0,
    },
    condition: conditionBuckets,
    cert_expiring_90d: certExpiring,
    region_activity: regionActivity,
    recent_tasks: recentTasks,
  });
});

router.get('/executive/summary', (req, res) => {
  if (!['ADMIN', 'EXECUTIVE'].includes(req.user.role)) {
    return res.status(403).json({ error: 'Forbidden: executive summary is limited to ADMIN and EXECUTIVE accounts' });
  }

  const now = new Date();
  const nowIso = now.toISOString();
  const regions = list('region');
  const regionIds = regions.map((region) => region.id);
  const tasks = list('task');
  const openTasks = tasks.filter((task) => OPEN.includes(task.status));
  const overdueTasks = openTasks.filter((task) => task.due_date && task.due_date < nowIso);
  const assets = list('asset').filter((asset) => asset.lifecycle_status !== 'REMOVED');
  const lines = list('transmission_line');
  const crews = list('crew');
  const people = list('person').filter((person) => person.active !== 0);
  const schedules = list('maintenance_schedule');
  const certifications = list('certification');
  const valuation = mergeValuations(regionIds.map((regionId) => computeRegionValuation(regionId, { global: true })));
  const cost = maintenanceCostForRegions(regionIds, {
    from: new Date(now.getTime() - 365 * 864e5).toISOString().slice(0, 10),
    to: nowIso.slice(0, 10),
    limit: 10,
  });

  const substationById = new Map(list('substation').map((substation) => [substation.id, substation]));
  const catalogRows = db.prepare("SELECT * FROM asset_catalog WHERE family != 'TOWER_PARTS'").all();
  const catalogByKey = new Map();
  for (const row of catalogRows) {
    catalogByKey.set(`${row.asset_type}|${row.sub_type || ''}`, row);
    if (!row.sub_type) catalogByKey.set(`${row.asset_type}|`, row);
  }
  const ownerMix = new Map();
  const ownerByAssetId = new Map();
  const typeMix = new Map();
  for (const asset of assets) {
    let metadata = {};
    try { metadata = typeof asset.metadata === 'string' ? JSON.parse(asset.metadata) : (asset.metadata || {}); } catch (_) { metadata = {}; }
    const substationId = asset.substation_id || null;
    const owner = metadata.owner || (substationId && substationById.get(substationId)?.owner) || 'Owner not recorded';
    ownerByAssetId.set(asset.id, owner);
    const key = `${owner}\u0000${asset.asset_type}`;
    const catalog = catalogByKey.get(`${asset.asset_type}|${asset.sub_type || ''}`) || catalogByKey.get(`${asset.asset_type}|`);
    const unitPrice = Number(catalog && catalog.default_unit_price) || 0;
    const quantity = catalog && catalog.unit_of_measure === 'KM'
      ? Math.max(Number(asset.km_to || 0) - Number(asset.km_from || 0), 1)
      : 1;
    const rcn = unitPrice > 0 ? unitPrice * quantity : 0;
    const current = rcn * (Number(asset.condition_rating) || 7) / 10;
    const row = ownerMix.get(key) || { owner, asset_type: asset.asset_type, count: 0, rcn: 0, current: 0, unpriced_count: 0 };
    row.count += 1;
    row.rcn += rcn;
    row.current += current;
    if (!unitPrice) row.unpriced_count += 1;
    ownerMix.set(key, row);
    typeMix.set(asset.asset_type, (typeMix.get(asset.asset_type) || 0) + 1);
  }

  const costStart = new Date(now.getTime() - 365 * 864e5).toISOString();
  const maintenanceCostByOwner = new Map();
  for (const event of db.prepare('SELECT asset_id, cost FROM asset_maintenance_event WHERE performed_at >= ? AND performed_at <= ?').all(costStart, nowIso)) {
    const owner = ownerByAssetId.get(event.asset_id) || 'Owner not recorded';
    const entry = maintenanceCostByOwner.get(owner) || { owner, events: 0, spend: 0 };
    entry.events += 1;
    entry.spend += Number(event.cost) || 0;
    maintenanceCostByOwner.set(owner, entry);
  }

  const taskByStatus = {};
  const taskByType = {};
  for (const task of tasks) taskByStatus[task.status] = (taskByStatus[task.status] || 0) + 1;
  for (const task of openTasks) taskByType[task.task_type] = (taskByType[task.task_type] || 0) + 1;

  const frequencyMix = {};
  for (const schedule of schedules) frequencyMix[schedule.frequency] = (frequencyMix[schedule.frequency] || 0) + 1;

  const expiredCerts = certifications.filter((cert) => cert.status !== 'REVOKED' && cert.expires_at < nowIso);
  const expiringCerts = certifications.filter((cert) => cert.status !== 'REVOKED' && cert.expires_at >= nowIso
    && new Date(cert.expires_at).getTime() <= now.getTime() + 90 * 864e5);
  const executions = db.prepare('SELECT COUNT(*) AS count FROM checklist_execution WHERE submitted_at IS NOT NULL').get().count;
  const equipment = { recommended: 0, used: 0, missed: 0, tasks_with_gaps: 0 };
  for (const task of openTasks) {
    const readiness = taskReadiness(task);
    for (const check of readiness?.equipment_checks || []) {
      equipment.recommended += 1;
      equipment[check.status === 'USED' ? 'used' : 'missed'] += 1;
    }
    if ((readiness?.equipment_to_secure || []).length) equipment.tasks_with_gaps += 1;
  }

  const condition = {
    critical: assets.filter((asset) => asset.condition_rating <= 3).length,
    poor: assets.filter((asset) => asset.condition_rating >= 4 && asset.condition_rating <= 5).length,
    fair: assets.filter((asset) => asset.condition_rating >= 6 && asset.condition_rating <= 7).length,
    good: assets.filter((asset) => asset.condition_rating >= 8).length,
  };
  const infrastructureCondition = {
    lines: Object.fromEntries(lines.reduce((counts, line) => counts.set(line.operational_status || 'UNKNOWN', (counts.get(line.operational_status || 'UNKNOWN') || 0) + 1), new Map())),
    substations: Object.fromEntries(list('substation').reduce((counts, substation) => counts.set(substation.operational_status || 'UNKNOWN', (counts.get(substation.operational_status || 'UNKNOWN') || 0) + 1), new Map())),
    towers: {
      critical: list('tower').filter((tower) => tower.corrosion_rating <= 3).length,
      poor: list('tower').filter((tower) => tower.corrosion_rating >= 4 && tower.corrosion_rating <= 5).length,
      fair: list('tower').filter((tower) => tower.corrosion_rating >= 6 && tower.corrosion_rating <= 7).length,
      good: list('tower').filter((tower) => tower.corrosion_rating >= 8).length,
    },
  };
  const recommendations = [];
  if (overdueTasks.length) recommendations.push(`${overdueTasks.length} open task(s) are overdue; prioritize owner assignment and recovery dates.`);
  if (condition.critical + condition.poor) recommendations.push(`${condition.critical + condition.poor} asset(s) are rated 5/10 or lower; review renewal and outage plans.`);
  if (equipment.missed) recommendations.push(`${equipment.missed} recommended equipment item(s) are not confirmed available on open work.`);
  if (expiredCerts.length || expiringCerts.length) recommendations.push(`${expiredCerts.length} certification(s) expired and ${expiringCerts.length} expire within 90 days; review crew eligibility.`);
  if (!recommendations.length) recommendations.push('No critical portfolio exceptions were detected in the current register.');

  const recentTasks = tasks.sort((a, b) => String(b.updated_at).localeCompare(String(a.updated_at))).slice(0, 12).map((task) => ({
    id: task.id,
    task_number: task.task_number,
    title: task.title,
    status: task.status,
    task_type: task.task_type,
    priority: task.priority,
    due_date: task.due_date,
    crew_name: task.crew_id ? get('crew', task.crew_id)?.name || null : null,
    line_name: task.line_id ? get('transmission_line', task.line_id)?.name || null : null,
  }));

  // Task numbering: task numbers are TK-<YYYY>-<seq>. Grouping by year lets the
  // board see workload issued per year; by_type_all counts every task (the
  // existing by_type only counts open work). HR: people grouped by title/role.
  const taskByNumberYear = {};
  for (const task of tasks) {
    const m = /^TK-(\d{4})-/.exec(String(task.task_number || ''));
    const key = m ? m[1] : 'Unnumbered';
    taskByNumberYear[key] = (taskByNumberYear[key] || 0) + 1;
  }
  const taskByTypeAll = {};
  for (const task of tasks) taskByTypeAll[task.task_type] = (taskByTypeAll[task.task_type] || 0) + 1;
  const peopleByRole = {};
  for (const person of people) {
    const key = (person.title || person.role || 'Unspecified').trim();
    peopleByRole[key] = (peopleByRole[key] || 0) + 1;
  }
  const certByType = {};
  for (const cert of certifications) {
    const entry = certByType[cert.cert_type] || { cert_type: cert.cert_type, total: 0, valid: 0, expired: 0, expiring: 0 };
    entry.total += 1;
    if (cert.status !== 'REVOKED' && cert.expires_at < nowIso) entry.expired += 1;
    else if (cert.status !== 'REVOKED' && cert.expires_at >= nowIso && new Date(cert.expires_at).getTime() <= now.getTime() + 90 * 864e5) entry.expiring += 1;
    else if (cert.status === 'VALID') entry.valid += 1;
    certByType[cert.cert_type] = entry;
  }

  res.json({
    generated_at: nowIso,
    currency: cost.currency.code,
    portfolio: {
      regions: regions.length,
      substations: list('substation').length,
      lines: lines.length,
      towers: list('tower').length,
      assets: assets.length,
      crews: crews.length,
      people: people.length,
      open_tasks: openTasks.length,
      overdue_tasks: overdueTasks.length,
      executions,
    },
    // The totals plus the full valuation breakdown (by class / family / location)
    // so the executive assets tab can render valuation by asset class.
    valuation: {
      ...valuation.totals,
      by_type: valuation.by_type || [],
      by_family: valuation.by_family || [],
      unpriced_types: valuation.unpriced_types || [],
    },
    condition,
    infrastructure_condition: infrastructureCondition,
    asset_mix: [...typeMix].map(([asset_type, count]) => ({ asset_type, count })).sort((a, b) => b.count - a.count),
    owner_mix: [...ownerMix.values()].sort((a, b) => a.owner.localeCompare(b.owner) || a.asset_type.localeCompare(b.asset_type)),
    maintenance_cost_by_owner: [...maintenanceCostByOwner.values()].sort((a, b) => b.spend - a.spend),
    tasks: {
      total: tasks.length,
      by_status: taskByStatus,
      by_type: taskByType,
      by_type_all: taskByTypeAll,
      by_number_year: taskByNumberYear,
      recent: recentTasks,
    },
    maintenance_cost: cost,
    schedules: { total: schedules.length, by_frequency: frequencyMix },
    workforce: {
      people: people.length,
      crews: crews.length,
      active_crews: crews.filter((crew) => crew.status === 'AVAILABLE' || crew.status === 'ON_TASK').length,
      by_role: peopleByRole,
      certifications: certifications.length,
      valid_certifications: certifications.filter((cert) => cert.status === 'VALID' && cert.expires_at >= nowIso).length,
      expired_certifications: expiredCerts.length,
      expiring_90_days: expiringCerts.length,
      by_type: Object.values(certByType).sort((a, b) => b.total - a.total),
    },
    equipment,
    recommendations,
  });
});

module.exports = router;
