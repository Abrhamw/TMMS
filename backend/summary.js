const { parseVoltageLevels } = require('./voltage');

const COST_BUCKETS = [
  { key: 'planned', label: 'Planned', color: '#14532d', types: ['PREVENTIVE', 'INSPECTION'] },
  { key: 'unplanned', label: 'Unplanned', color: '#d97706', types: ['CORRECTIVE', 'REPAIR'] },
  { key: 'emergency', label: 'Emergency', color: '#dc2626', types: ['EMERGENCY'] },
  { key: 'capital', label: 'Capital', color: '#0e7490', types: ['REPLACEMENT'] },
];

function num(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function round1(value) {
  return Math.round(num(value) * 10) / 10;
}

function kvLabel(value) {
  if (value == null) return null;
  const match = String(value).match(/-?\d+(?:\.\d+)?/);
  if (!match) return null;
  const kv = Number(match[0]);
  return Number.isFinite(kv) && kv > 0 ? `${kv} kV` : null;
}

function conditionBands(assets = []) {
  const bands = { critical: 0, poor: 0, fair: 0, good: 0 };
  for (const asset of assets) {
    const rating = Number(asset && asset.condition_rating);
    if (!Number.isFinite(rating)) continue;
    if (rating <= 3) bands.critical += 1;
    else if (rating <= 5) bands.poor += 1;
    else if (rating <= 7) bands.fair += 1;
    else bands.good += 1;
  }
  return bands;
}

function regionEffectiveness({ lines = [], substations = [], tasks = [], assets = [] } = {}) {
  const lineOk = lines.filter((line) => String(line.operational_status || '').toUpperCase() === 'ENERGIZED').length;
  const subOk = substations.filter((sub) => String(sub.operational_status || '').toUpperCase() === 'OPERATIONAL').length;
  const availabilityDen = lines.length + substations.length;
  const availability = availabilityDen ? Math.round(((lineOk + subOk) / availabilityDen) * 100) : null;
  const delivery = tasks.length
    ? Math.round((tasks.filter((task) => task.status === 'COMPLETED').length / tasks.length) * 100)
    : null;
  const ratings = assets.map((asset) => Number(asset.condition_rating)).filter(Number.isFinite);
  const condition = ratings.length
    ? Math.round((ratings.reduce((acc, value) => acc + value, 0) / ratings.length) * 10)
    : null;
  const parts = [[availability, 0.4], [delivery, 0.3], [condition, 0.3]].filter(([value]) => value != null);
  const weight = parts.reduce((acc, [, w]) => acc + w, 0);
  const index = weight ? Math.round(parts.reduce((acc, [value, w]) => acc + value * w, 0) / weight) : null;
  return { index, availability, delivery, condition };
}

function summarizeRegion(region, { substations = [], lines = [], assets = [], tasks = [], bayCountOf = () => 0 } = {}) {
  const byVoltage = {};
  const byStatus = {};
  let totalBays = 0;
  for (const sub of substations) {
    totalBays += num(bayCountOf(sub.id));
    const status = sub.operational_status || 'UNKNOWN';
    byStatus[status] = (byStatus[status] || 0) + 1;
    for (const level of parseVoltageLevels(sub.voltage_levels)) {
      const label = kvLabel(level);
      if (label) byVoltage[label] = (byVoltage[label] || 0) + 1;
    }
  }
  let routeKm = 0;
  let circuitKm = 0;
  const lineByVoltage = {};
  for (const line of lines) {
    const length = num(line.length_km);
    const circuits = num(line.circuit_count) || 1;
    routeKm += length;
    circuitKm += length * circuits;
    const label = kvLabel(line.voltage_kv);
    if (label) {
      const entry = lineByVoltage[label] || { count: 0, km: 0 };
      entry.count += 1;
      entry.km = round1(entry.km + length);
      lineByVoltage[label] = entry;
    }
  }
  return {
    id: region.id,
    code: region.code,
    name: region.name,
    substations: {
      count: substations.length,
      by_voltage: byVoltage,
      total_bays: totalBays,
      avg_bays: substations.length ? round1(totalBays / substations.length) : 0,
      by_status: byStatus,
    },
    lines: {
      count: lines.length,
      route_km: round1(routeKm),
      circuit_km: round1(circuitKm),
      by_voltage: lineByVoltage,
    },
    assets: { count: assets.length, condition: conditionBands(assets) },
    effectiveness: regionEffectiveness({ lines, substations, tasks, assets }),
  };
}

function buildRegionLoad(regions = [], context = {}) {
  const {
    substationsFor = () => [],
    linesFor = () => [],
    assetsFor = () => [],
    tasksFor = () => [],
    bayCountOf = () => 0,
  } = context;
  return regions.map((region) => summarizeRegion(region, {
    substations: substationsFor(region.id),
    lines: linesFor(region.id),
    assets: assetsFor(region.id),
    tasks: tasksFor(region.id),
    bayCountOf,
  }));
}

const INTERVENTION_ORDER = { REPLACE: 0, UPGRADE: 1, REPAIR: 2 };
const URGENCY_ORDER = { high: 0, medium: 1, low: 2 };

function interventionUrgency(action, rating) {
  const value = Number(rating);
  if (action === 'REPLACE') return Number.isFinite(value) && value <= 3 ? 'high' : 'medium';
  if (action === 'UPGRADE') return Number.isFinite(value) && value <= 3 ? 'high' : 'medium';
  return Number.isFinite(value) && value <= 3 ? 'high' : 'low';
}

function buildInterventions(candidates = [], { limit = 40 } = {}) {
  const byAsset = new Map();
  for (const candidate of candidates) {
    if (!candidate || candidate.asset_id == null || INTERVENTION_ORDER[candidate.action] === undefined) continue;
    const existing = byAsset.get(candidate.asset_id);
    if (!existing || INTERVENTION_ORDER[candidate.action] < INTERVENTION_ORDER[existing.action]) {
      byAsset.set(candidate.asset_id, candidate);
    }
  }
  return [...byAsset.values()]
    .map((row) => ({ ...row, urgency: interventionUrgency(row.action, row.current_rating ?? row.suggested_rating) }))
    .sort((a, b) => URGENCY_ORDER[a.urgency] - URGENCY_ORDER[b.urgency]
      || (num(a.current_rating) || 11) - (num(b.current_rating) || 11)
      || String(a.asset_code || '').localeCompare(String(b.asset_code || '')))
    .slice(0, limit);
}

function conditionDistribution(assets = []) {
  const dist = { critical: 0, poor: 0, fair: 0, good: 0, assessed: 0, total: assets.length };
  for (const asset of assets) {
    const rating = asset && asset.condition_rating;
    if (rating == null || !Number.isFinite(Number(rating))) continue;
    const v = Number(rating);
    dist.assessed += 1;
    if (v <= 3) dist.critical += 1;
    else if (v <= 5) dist.poor += 1;
    else if (v <= 7) dist.fair += 1;
    else dist.good += 1;
  }
  return dist;
}

function costComposition(byEventType = []) {
  const buckets = COST_BUCKETS.map((b) => ({ key: b.key, label: b.label, color: b.color, spend: 0, count: 0 }));
  const byKey = new Map(buckets.map((b) => [b.key, b]));
  for (const row of byEventType) {
    const type = String(row.event_type || '').toUpperCase();
    const bucket = COST_BUCKETS.find((b) => b.types.includes(type));
    if (!bucket) continue;
    const target = byKey.get(bucket.key);
    target.spend += num(row.spend);
    target.count += num(row.count);
  }
  const total = buckets.reduce((acc, b) => acc + b.spend, 0);
  return { total, buckets };
}

function monthKey(date) {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1)).toISOString().slice(0, 7);
}

function fillMonths(rows = [], now = Date.now(), { months = 12, value = 'value' } = {}) {
  const end = new Date(now);
  const byMonth = new Map();
  for (const row of rows) {
    if (row && row.month != null) byMonth.set(String(row.month), num(row[value]));
  }
  const out = [];
  for (let i = months - 1; i >= 0; i -= 1) {
    const d = new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth() - i, 1));
    const key = monthKey(d);
    out.push({ month: key, [value]: byMonth.get(key) || 0 });
  }
  return out;
}

function crewReadiness(crews = []) {
  const total = crews.length;
  const active = crews.filter((crew) => crew.status === 'AVAILABLE' || crew.status === 'ON_TASK').length;
  const available = crews.filter((crew) => crew.status === 'AVAILABLE').length;
  return { total, active, available, percent: total ? Math.round((active / total) * 100) : null };
}

function certificationReadiness(certs = [], now = Date.now()) {
  const nowMs = new Date(now).getTime();
  const windowEnd = nowMs + 90 * 864e5;
  let valid = 0;
  let expiring = 0;
  let expired = 0;
  for (const cert of certs) {
    if (cert.status === 'REVOKED') continue;
    const at = new Date(cert.expires_at).getTime();
    if (!Number.isFinite(at)) continue;
    if (cert.status === 'VALID' && at >= nowMs) valid += 1;
    if (at < nowMs) expired += 1;
    else if (at <= windowEnd) expiring += 1;
  }
  const total = certs.length;
  return { total, valid, expiring, expired, percent: total ? Math.round((valid / total) * 100) : null };
}

module.exports = {
  COST_BUCKETS,
  conditionDistribution,
  conditionBands,
  costComposition,
  fillMonths,
  crewReadiness,
  certificationReadiness,
  regionEffectiveness,
  summarizeRegion,
  buildRegionLoad,
  buildInterventions,
};
