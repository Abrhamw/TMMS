const express = require('express');
const { db, list, get } = require('../util');
const { isGlobal } = require('../auth');
const { taskVisible, authorizedCrewIds, readCrewIds, regionWideRead, isManager, commandScope } = require('../authority');
const { taskReadiness } = require('../readiness');
const { maintenanceCostForRegions } = require('../maintenanceCost');
const { computeRegionValuation, mergeValuations } = require('./register');
const { recentRevaluationData } = require('../assetMonitor');
const { buildRecommendations } = require('../executiveRecommendations');
const { buildRegionLoad, buildInterventions, valueConcentration } = require('../summary');
const { substationBayCounts } = require('../integrity');

const router = express.Router();

const OPEN = ['DRAFT', 'SCHEDULED', 'ASSIGNED', 'IN_PROGRESS', 'ON_HOLD', 'PENDING_VERIFICATION'];

const SUMMARY_TTL_MS = 20000;
const summaryCache = new Map();

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

function computeSummary(req, res, opts = {}) {
  const allowedRegionIds = opts.allowedRegionIds || null;
  const now = new Date();
  const nowIso = now.toISOString();
  const allRegions = list('region');
  const requestedRegion = req.query.region != null && req.query.region !== '' ? Number(req.query.region) : null;
  if (requestedRegion != null && !Number.isFinite(requestedRegion)) {
    res.status(400).json({ error: 'region must be numeric' });
    return null;
  }
  const regions = requestedRegion != null
    ? allRegions.filter((region) => region.id === requestedRegion && (!allowedRegionIds || allowedRegionIds.has(region.id)))
    : (allowedRegionIds ? allRegions.filter((region) => allowedRegionIds.has(region.id)) : allRegions);
  if (requestedRegion != null && !regions.length) {
    res.status(404).json({ error: 'Region not found' });
    return null;
  }
  const regionIds = regions.map((region) => region.id);
  const regionSet = new Set(regionIds);
  const isAllRegions = requestedRegion == null && !allowedRegionIds;

  const allSubstations = list('substation');
  const substationById = new Map(allSubstations.map((substation) => [substation.id, substation]));
  const scopedSubstationIds = new Set(allSubstations.filter((s) => regionSet.has(s.region_id)).map((s) => s.id));
  const allLines = list('transmission_line');
  const lines = allLines.filter((line) => regionSet.has(line.region_id));
  const scopedLineIds = new Set(lines.map((line) => line.id));
  const scopedCrewIds = new Set(list('crew').filter((crew) => regionSet.has(crew.region_id)).map((crew) => crew.id));
  const people = isAllRegions
    ? list('person').filter((person) => person.active !== 0)
    : (() => {
        const ids = new Set();
        for (const rid of regionIds) for (const pid of peopleInRegion(rid)) ids.add(pid);
        return list('person').filter((person) => person.active !== 0 && ids.has(person.id));
      })();
  const scopedPeopleIds = new Set(people.map((person) => person.id));
  const crews = list('crew').filter((crew) => regionSet.has(crew.region_id));
  const allTasks = list('task');
  const tasks = isAllRegions ? allTasks : allTasks.filter((task) => (task.region_id != null && regionSet.has(task.region_id))
    || (task.crew_id != null && scopedCrewIds.has(task.crew_id))
    || (task.line_id != null && scopedLineIds.has(task.line_id))
    || (task.substation_id != null && scopedSubstationIds.has(task.substation_id)));
  const schedules = list('maintenance_schedule').filter((schedule) => isAllRegions
    || regionSet.has(schedule.region_id)
    || (schedule.substation_id != null && scopedSubstationIds.has(schedule.substation_id))
    || (schedule.line_id != null && scopedLineIds.has(schedule.line_id)));
  const allCertifications = list('certification');
  const certifications = isAllRegions ? allCertifications : allCertifications.filter((cert) => scopedPeopleIds.has(cert.person_id));
  const assets = list('asset').filter((asset) => asset.lifecycle_status !== 'REMOVED'
    && (isAllRegions
      || (asset.substation_id != null && scopedSubstationIds.has(asset.substation_id))
      || (asset.line_id != null && scopedLineIds.has(asset.line_id))));
  const assetPkSet = new Set(assets.map((asset) => asset.id));
  const openTasks = tasks.filter((task) => OPEN.includes(task.status));
  const overdueTasks = openTasks.filter((task) => task.due_date && task.due_date < nowIso);
  const regionValuations = regionIds.map((regionId) => computeRegionValuation(regionId, { global: true }));
  const valuation = mergeValuations(regionValuations);
  const cost = maintenanceCostForRegions(regionIds, {
    from: new Date(now.getTime() - 365 * 864e5).toISOString().slice(0, 10),
    to: nowIso.slice(0, 10),
    limit: 10,
  });

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
    if (!assetPkSet.has(event.asset_id)) continue;
    const owner = ownerByAssetId.get(event.asset_id) || 'Owner not recorded';
    const entry = maintenanceCostByOwner.get(owner) || { owner, events: 0, spend: 0 };
    entry.events += 1;
    entry.spend += Number(event.cost) || 0;
    maintenanceCostByOwner.set(owner, entry);
  }

  const ownerCurrent = new Map();
  for (const row of ownerMix.values()) ownerCurrent.set(row.owner, (ownerCurrent.get(row.owner) || 0) + row.current);
  const assetConcentration = {
    unpriced_count: valuation.totals.unpriced_count || 0,
    category: valueConcentration(valuation.by_type.map((row) => ({ label: row.label, value: row.current }))),
    owner: valueConcentration([...ownerCurrent].map(([label, value]) => ({ label, value }))),
    region: valueConcentration(regionValuations.map((part) => ({ label: part.region.name, value: part.current }))),
  };

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
  const scopedTowers = list('tower').filter((tower) => isAllRegions || scopedLineIds.has(tower.line_id));
  const infrastructureCondition = {
    lines: Object.fromEntries(lines.reduce((counts, line) => counts.set(line.operational_status || 'UNKNOWN', (counts.get(line.operational_status || 'UNKNOWN') || 0) + 1), new Map())),
    substations: Object.fromEntries(allSubstations.filter((s) => isAllRegions || regionSet.has(s.region_id)).reduce((counts, substation) => counts.set(substation.operational_status || 'UNKNOWN', (counts.get(substation.operational_status || 'UNKNOWN') || 0) + 1), new Map())),
    towers: {
      critical: scopedTowers.filter((tower) => tower.corrosion_rating <= 3).length,
      poor: scopedTowers.filter((tower) => tower.corrosion_rating >= 4 && tower.corrosion_rating <= 5).length,
      fair: scopedTowers.filter((tower) => tower.corrosion_rating >= 6 && tower.corrosion_rating <= 7).length,
      good: scopedTowers.filter((tower) => tower.corrosion_rating >= 8).length,
    },
  };
  const recommendations = [];
  if (overdueTasks.length) recommendations.push(`${overdueTasks.length} open task(s) are overdue; prioritize owner assignment and recovery dates.`);
  if (condition.critical + condition.poor) recommendations.push(`${condition.critical + condition.poor} asset(s) are rated 5/10 or lower; review renewal and outage plans.`);
  if (equipment.missed) recommendations.push(`${equipment.missed} recommended equipment item(s) are not confirmed available on open work.`);
  if (expiredCerts.length || expiringCerts.length) recommendations.push(`${expiredCerts.length} certification(s) expired and ${expiringCerts.length} expire within 90 days; review crew eligibility.`);
  if (!recommendations.length) recommendations.push('No critical portfolio exceptions were detected in the current register.');

  const assetById = new Map(list('asset').map((asset) => [asset.id, asset]));
  const regionNameSet = new Set(regions.map((region) => region.name));
  const allChanges = recentRevaluationData({ days: 180 }).changes || [];
  const degradationRows = allChanges
    .filter((change) => Number(change.delta) < 0 && (isAllRegions || regionNameSet.has(change.region)))
    .sort((a, b) => Number(a.delta) - Number(b.delta));
  const degradationAttention = degradationRows.slice(0, 8).map((change) => ({
    asset_id: change.asset_pk,
    asset_code: change.asset_code,
    asset_name: change.asset_name,
    asset_type: change.asset_type,
    region: change.region,
    current_rating: change.from_rating,
    suggested_rating: change.to_rating,
    delta: change.delta,
    health_index: change.health_index,
    recommendation: change.recommendation,
    reasons: change.reasons,
    captured_at: change.captured_at || null,
  }));
  const degradationSignal = degradationRows
    .filter((change) => isAllRegions || assetPkSet.has(change.asset_pk))
    .map((change) => ({
      asset_id: change.asset_pk,
      asset_code: change.asset_code,
      asset_name: change.asset_name,
      delta: change.delta,
      suggested_rating: change.to_rating,
      recommendation: change.recommendation,
      region: change.region,
    }));

  const loadRows = db.prepare("SELECT asset_id, COUNT(*) AS n FROM asset_reading WHERE reading_type = 'LOAD_PCT' AND value_num > 100 AND recorded_at >= ? GROUP BY asset_id").all(costStart);
  const faultRows = db.prepare("SELECT asset_id, COUNT(*) AS n FROM asset_performance_event WHERE event_type IN ('THROUGH_FAULT','OVERLOAD') AND occurred_at >= ? GROUP BY asset_id").all(costStart);
  const exposureMap = new Map();
  for (const row of [...loadRows, ...faultRows]) {
    if (!assetPkSet.has(row.asset_id)) continue;
    const entry = exposureMap.get(row.asset_id) || { asset_id: row.asset_id, factor_count: 0, asset_code: assetById.get(row.asset_id)?.asset_id || null };
    entry.factor_count += Number(row.n) || 0;
    exposureMap.set(row.asset_id, entry);
  }
  const overloadExposure = [...exposureMap.values()].sort((a, b) => b.factor_count - a.factor_count).slice(0, 10);

  const renewalRows = db.prepare(`SELECT s.asset_id, COALESCE(s.suggested_rating, s.condition_rating) AS combined_rating, s.remaining_useful_life_years, s.recommendation
    FROM asset_health_snapshot s
    JOIN (SELECT asset_id, MAX(captured_at) AS m FROM asset_health_snapshot GROUP BY asset_id) t
      ON s.asset_id = t.asset_id AND s.captured_at = t.m`).all();
  const renewalCandidates = renewalRows
    .filter((row) => assetPkSet.has(row.asset_id) && (row.recommendation === 'REPLACE' || Number(row.combined_rating) <= 3))
    .sort((a, b) => (Number(a.remaining_useful_life_years) || 0) - (Number(b.remaining_useful_life_years) || 0))
    .slice(0, 10)
    .map((row) => ({ ...row, asset_code: assetById.get(row.asset_id)?.asset_id || null }));

  const substationRegion = new Map(allSubstations.map((sub) => [sub.id, sub.region_id]));
  const lineRegion = new Map(allLines.map((line) => [line.id, line.region_id]));
  const crewRegion = new Map(list('crew').map((crew) => [crew.id, crew.region_id]));
  const regionNameById = new Map(allRegions.map((region) => [region.id, region.name]));
  const assetRegionId = new Map();
  for (const asset of assets) {
    const rid = asset.substation_id != null ? substationRegion.get(asset.substation_id)
      : (asset.line_id != null ? lineRegion.get(asset.line_id) : null);
    assetRegionId.set(asset.id, rid ?? null);
  }
  const taskRegionId = (task) => {
    if (task.region_id != null) return task.region_id;
    if (task.crew_id != null) return crewRegion.get(task.crew_id) ?? null;
    if (task.line_id != null) return lineRegion.get(task.line_id) ?? null;
    if (task.substation_id != null) return substationRegion.get(task.substation_id) ?? null;
    return null;
  };
  const bayCountBySubstation = substationBayCounts();
  const regionLoad = buildRegionLoad(regions, {
    substationsFor: (rid) => allSubstations.filter((sub) => sub.region_id === rid),
    linesFor: (rid) => lines.filter((line) => line.region_id === rid),
    assetsFor: (rid) => assets.filter((asset) => assetRegionId.get(asset.id) === rid),
    tasksFor: (rid) => tasks.filter((task) => taskRegionId(task) === rid),
    bayCountOf: (id) => bayCountBySubstation.get(id) || 0,
  });

  const interventionCandidates = [];
  for (const row of renewalCandidates) {
    const asset = assetById.get(row.asset_id);
    interventionCandidates.push({
      asset_id: row.asset_id,
      asset_code: row.asset_code || asset?.asset_id || null,
      asset_name: asset?.name || null,
      asset_type: asset?.asset_type || null,
      region: regionNameById.get(assetRegionId.get(row.asset_id)) || null,
      current_rating: asset?.condition_rating ?? null,
      suggested_rating: row.combined_rating ?? null,
      remaining_useful_life_years: row.remaining_useful_life_years ?? null,
      action: 'REPLACE',
      reason: 'Renewal or replacement recommended',
    });
  }
  for (const row of degradationAttention) {
    const code = String(row.recommendation || '').toUpperCase();
    const suggested = Number(row.suggested_rating);
    let action = null;
    if (code === 'REPLACE') action = 'REPLACE';
    else if (code === 'REPAIR') action = 'REPAIR';
    else if (Number.isFinite(suggested) && suggested <= 5) action = 'UPGRADE';
    if (!action) continue;
    interventionCandidates.push({
      asset_id: row.asset_id,
      asset_code: row.asset_code,
      asset_name: row.asset_name,
      asset_type: row.asset_type,
      region: row.region,
      current_rating: row.current_rating,
      suggested_rating: row.suggested_rating,
      delta: row.delta,
      health_index: row.health_index,
      action,
      reason: (Array.isArray(row.reasons) && row.reasons.length ? row.reasons.join('; ') : 'Condition is degrading'),
    });
  }
  for (const row of overloadExposure) {
    const asset = assetById.get(row.asset_id);
    interventionCandidates.push({
      asset_id: row.asset_id,
      asset_code: row.asset_code || asset?.asset_id || null,
      asset_name: asset?.name || null,
      asset_type: asset?.asset_type || null,
      region: regionNameById.get(assetRegionId.get(row.asset_id)) || null,
      current_rating: asset?.condition_rating ?? null,
      action: 'UPGRADE',
      reason: `${row.factor_count} overload or through-fault event(s) in 12 months`,
    });
  }
  for (const asset of assets.filter((item) => Number(item.condition_rating) <= 5)) {
    interventionCandidates.push({
      asset_id: asset.id,
      asset_code: asset.asset_id,
      asset_name: asset.name,
      asset_type: asset.asset_type,
      region: regionNameById.get(assetRegionId.get(asset.id)) || null,
      current_rating: asset.condition_rating,
      action: 'REPAIR',
      reason: Number(asset.condition_rating) <= 3 ? 'Critical condition' : 'Poor condition',
    });
  }
  const interventions = buildInterventions(interventionCandidates);

  const costComposition = (() => {
    const buckets = { planned: 0, unplanned: 0, emergency: 0, capital: 0 };
    const counts = { planned: 0, unplanned: 0, emergency: 0, capital: 0 };
    for (const row of cost.by_event_type || []) {
      const type = String(row.event_type || '').toUpperCase();
      let key = null;
      if (type === 'PREVENTIVE' || type === 'INSPECTION') key = 'planned';
      else if (type === 'CORRECTIVE' || type === 'REPAIR') key = 'unplanned';
      else if (type === 'EMERGENCY') key = 'emergency';
      else if (type === 'REPLACEMENT') key = 'capital';
      if (!key) continue;
      buckets[key] += Number(row.spend) || 0;
      counts[key] += Number(row.count) || 0;
    }
    const total = Object.values(buckets).reduce((acc, value) => acc + value, 0);
    return {
      total,
      buckets: [
        { key: 'planned', label: 'Planned', spend: buckets.planned, count: counts.planned, color: '#14532d' },
        { key: 'unplanned', label: 'Unplanned', spend: buckets.unplanned, count: counts.unplanned, color: '#d97706' },
        { key: 'emergency', label: 'Emergency', spend: buckets.emergency, count: counts.emergency, color: '#dc2626' },
        { key: 'capital', label: 'Capital', spend: buckets.capital, count: counts.capital, color: '#0e7490' },
      ],
    };
  })();

  const monthKeys = [];
  const startMonth = new Date(now.getFullYear(), now.getMonth() - 11, 1);
  for (let i = 0; i < 12; i += 1) monthKeys.push(new Date(startMonth.getFullYear(), startMonth.getMonth() + i, 1).toISOString().slice(0, 7));
  const spendByMonth = new Map((cost.monthly || []).map((row) => [row.month, Number(row.spend) || 0]));
  const spendTrend = monthKeys.map((month) => ({ month, spend: spendByMonth.get(month) || 0 }));
  const conditionRows = db.prepare('SELECT substr(captured_at, 1, 7) AS month, AVG(condition_rating) AS rating FROM asset_health_snapshot GROUP BY substr(captured_at, 1, 7)').all();
  const conditionByMonth = new Map(conditionRows.map((row) => [row.month, Number(row.rating)]));
  const conditionTrend = monthKeys.map((month) => ({ month, rating: conditionByMonth.has(month) ? Math.round(conditionByMonth.get(month) * 10) / 10 : null }));

  const assessed = assets.filter((asset) => asset.condition_rating != null);
  const meanRating = assessed.length ? assessed.reduce((acc, asset) => acc + Number(asset.condition_rating), 0) / assessed.length : null;
  const activeCrews = crews.filter((crew) => crew.status === 'AVAILABLE' || crew.status === 'ON_TASK').length;
  const workforceReadiness = {
    headcount: people.length,
    crews: crews.length,
    active_crews: activeCrews,
    available_crews: crews.filter((crew) => crew.status === 'AVAILABLE').length,
    people_with_certifications: new Set(certifications.map((cert) => cert.person_id)).size,
    valid_certifications: certifications.filter((cert) => cert.status === 'VALID' && cert.expires_at >= nowIso).length,
    expiring_90_days: expiringCerts.length,
    expired_certifications: expiredCerts.length,
    certification_readiness: certifications.length ? Math.round((certifications.filter((cert) => cert.status === 'VALID' && cert.expires_at >= nowIso).length / certifications.length) * 100) : null,
    crew_readiness: crews.length ? Math.round((activeCrews / crews.length) * 100) : null,
  };

  const structuredRecommendations = buildRecommendations({
    overdue_tasks: overdueTasks,
    low_condition: assets.filter((asset) => Number(asset.condition_rating) <= 5).map((asset) => ({ id: asset.id, asset_id: asset.asset_id, name: asset.name, condition_rating: asset.condition_rating })),
    expired_certifications: expiredCerts,
    expiring_certifications: expiringCerts,
    equipment,
    cost_concentration: [...maintenanceCostByOwner.values()].sort((a, b) => b.spend - a.spend),
    total_spend: cost.totals.spend,
    degradation: degradationSignal,
    overload_exposure: overloadExposure,
    renewal_candidates: renewalCandidates,
  }, { now });
  const recommendationText = structuredRecommendations.length ? structuredRecommendations.map((rec) => rec.title) : recommendations;

  const totalSpend = cost.totals.spend;
  const kpis = [
    { key: 'assets', label: 'Assets in service', value: assets.length, sub: `${regions.length} region(s) · ${valuation.totals.current ?? 0} current value`, tone: 'ok', spark: [] },
    { key: 'condition', label: 'Mean condition', value: meanRating != null ? Math.round(meanRating * 10) / 10 : '—', sub: `${assessed.length} of ${assets.length} assessed`, tone: meanRating != null && meanRating <= 5 ? 'bad' : meanRating != null && meanRating <= 7 ? 'warn' : 'ok', spark: conditionTrend.map((row) => row.rating).filter((v) => v != null) },
    { key: 'work', label: 'Open work orders', value: openTasks.length, sub: `${overdueTasks.length} overdue`, tone: overdueTasks.length ? 'warn' : 'ok', spark: [] },
    { key: 'spend', label: '12-month spend', value: totalSpend, sub: `${cost.currency.code} · ${cost.totals.count} events`, tone: 'ok', spark: spendTrend.map((row) => row.spend) },
    { key: 'workforce', label: 'Crew readiness', value: workforceReadiness.crew_readiness != null ? `${workforceReadiness.crew_readiness}%` : '—', sub: `${workforceReadiness.active_crews} of ${workforceReadiness.crews} crews active`, tone: workforceReadiness.crew_readiness != null && workforceReadiness.crew_readiness < 50 ? 'warn' : 'ok', spark: [] },
  ];

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

  return {
    generated_at: nowIso,
    currency: cost.currency.code,
    hero: {
      generated_at: nowIso,
      scope: requestedRegion != null ? (regions[0]?.name || `Region ${requestedRegion}`) : 'All regions',
      region_id: requestedRegion,
      regions: regions.map((region) => ({ id: region.id, name: region.name })),
    },
    kpis,
    cost_composition: costComposition,
    trends: { spend: spendTrend, condition: conditionTrend },
    degradation_attention: degradationAttention,
    workforce_readiness: workforceReadiness,
    recommendation_text: recommendationText,
    portfolio: {
      regions: regions.length,
      substations: allSubstations.filter((s) => isAllRegions || regionSet.has(s.region_id)).length,
      lines: lines.length,
      towers: scopedTowers.length,
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
    asset_concentration: assetConcentration,
    condition,
    infrastructure_condition: infrastructureCondition,
    region_load: regionLoad,
    interventions,
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
    recommendations: structuredRecommendations,
  };
}

router.get('/executive/summary', (req, res) => {
  if (!['ADMIN', 'EXECUTIVE'].includes(req.user.role)) {
    return res.status(403).json({ error: 'Forbidden: executive summary is limited to ADMIN and EXECUTIVE accounts' });
  }
  const result = scopedSummary(req, res);
  if (!result) return;
  res.json(result.summary);
});

function scopedSummary(req, res) {
  const scope = commandScope(req.user);
  const region = req.query.region != null && req.query.region !== '' ? String(req.query.region) : 'all';
  const scopeKey = scope.global ? 'global' : [...(scope.regionIds || [])].sort((a, b) => a - b).join(',');
  const key = `${scopeKey}|${region}`;
  const nowMs = Date.now();
  const hit = summaryCache.get(key);
  if (hit && nowMs - hit.at < SUMMARY_TTL_MS) return { scope, summary: hit.summary };
  const summary = computeSummary(req, res, { allowedRegionIds: scope.global ? null : scope.regionIds });
  if (!summary) return null;
  summaryCache.set(key, { at: nowMs, summary });
  return { scope, summary };
}

router.get('/dashboard/summary', (req, res) => {
  const result = scopedSummary(req, res);
  if (!result) return;
  res.json({ ...result.summary, scope: result.scope.global ? 'global' : 'region' });
});

router.get('/work/summary', (req, res) => {
  const result = scopedSummary(req, res);
  if (!result) return;
  const { scope, summary } = result;
  res.json({
    generated_at: summary.generated_at,
    scope: scope.global ? 'global' : 'region',
    tasks: summary.tasks,
    schedules: summary.schedules,
    workforce: summary.workforce,
    equipment: summary.equipment,
    recommendations: summary.recommendations,
  });
});

router.get('/reports/summary', (req, res) => {
  const result = scopedSummary(req, res);
  if (!result) return;
  const { scope, summary } = result;
  res.json({
    generated_at: summary.generated_at,
    scope: scope.global ? 'global' : 'region',
    currency: summary.currency,
    cost_composition: summary.cost_composition,
    trends: summary.trends,
    maintenance_cost: summary.maintenance_cost,
    maintenance_cost_by_owner: summary.maintenance_cost_by_owner,
    valuation: summary.valuation,
  });
});

router.get('/executive/degradation', (req, res) => {
  if (!['ADMIN', 'EXECUTIVE'].includes(req.user.role)) {
    return res.status(403).json({ error: 'Forbidden: executive views are limited to ADMIN and EXECUTIVE accounts' });
  }
  const limit = Math.max(1, Math.min(50, Number(req.query.limit) || 10));
  const changes = recentRevaluationData({ days: 180 }).changes;
  const attention = changes
    .filter((c) => Number(c.delta) < 0)
    .sort((a, b) => Number(a.delta) - Number(b.delta))
    .slice(0, limit)
    .map((c) => ({
      asset_id: c.asset_pk,
      asset_code: c.asset_code,
      asset_name: c.asset_name,
      asset_type: c.asset_type,
      region: c.region,
      current_rating: c.from_rating,
      suggested_rating: c.to_rating,
      delta: c.delta,
      health_index: c.health_index,
      recommendation: c.recommendation,
      reasons: c.reasons,
      captured_at: c.captured_at || null,
    }));
  res.json({ generated_at: new Date().toISOString(), count: attention.length, attention });
});

module.exports = router;
