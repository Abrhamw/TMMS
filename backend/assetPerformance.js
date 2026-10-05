const { ageYears, ageBaseline, computeHealth, RECOMMENDATION_LABELS } = require('./assetBaseline');

const MODEL_VERSION = 'performance-v2';

const READING_TYPES = [
  'LOAD_PCT', 'AMBIENT_C', 'TOP_OIL_C', 'WINDING_C', 'DGA_H2_PPM', 'DGA_CH4_PPM',
  'MOISTURE_PPM', 'POWER_FACTOR', 'VOLTAGE_DEV_PCT', 'RUN_HOURS', 'VIBRATION_MM_S',
  'PD_PC', 'OIL_DIELECTRIC_KV',
];

const EVENT_TYPES = [
  'THROUGH_FAULT', 'TRIP', 'OVERLOAD', 'OIL_LEAK', 'PARTIAL_DISCHARGE', 'TEMP_ALARM',
  'CORROSION_SEVERE', 'ENVIRONMENTAL',
];

const EVENT_SEVERITIES = ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'];

const SEVERITY_WEIGHT = { LOW: 0.5, MEDIUM: 1, HIGH: 1.5, CRITICAL: 2 };

const FAMILY_BY_TYPE = {
  TRANSFORMER: 'TRANSFORMER', AUTO_TRANSFORMER: 'TRANSFORMER', AUXILIARY_TRANSFORMER: 'TRANSFORMER',
  MV_CIRCUIT_BREAKER: 'BREAKER', SWITCHGEAR: 'BREAKER',
  CONDUCTOR_SPAN: 'LINE', OPGW_SPAN: 'LINE',
  TOWER: 'TOWER',
  BATTERY_BANK: 'AUX', BATTERY_CHARGER: 'AUX', CAPACITOR_BANK: 'AUX', JOINT_BOX: 'AUX',
  IED: 'CONTROL', METER: 'CONTROL', PROTECTION_RELAY: 'CONTROL', SCADA_RTU: 'CONTROL',
};

const FAMILY_FACTORS = {
  TRANSFORMER: ['loading', 'thermal', 'dga', 'moisture', 'faults', 'maintenance'],
  BREAKER: ['loading', 'switching', 'faults', 'maintenance'],
  LINE: ['loading', 'voltage', 'faults', 'maintenance'],
  TOWER: ['environment', 'maintenance'],
  AUX: ['loading', 'events', 'maintenance'],
  CONTROL: ['events', 'maintenance'],
  GENERIC: ['loading', 'events', 'maintenance'],
};

const LOADING_PROFILES = {
  TRANSFORMER: { label: 'MV capacity loading', warn: 85, critical: 100, gradient: 1.2, weight: 1.2 },
  LINE: { label: 'MV circuit loading', warn: 75, critical: 95, gradient: 1, weight: 1 },
  OTHER: { label: 'MV loading', warn: 80, critical: 100, gradient: 0.5, weight: 0.8 },
};

const LOADING_FAMILY = { TRANSFORMER: 'TRANSFORMER', LINE: 'LINE' };

function declaredCapacityMva(asset) {
  if (!asset) return null;
  const direct = Number(asset.rating_mva);
  if (Number.isFinite(direct) && direct > 0) return direct;
  let meta = asset.metadata;
  if (typeof meta === 'string') {
    try { meta = JSON.parse(meta); } catch (_) { return null; }
  }
  const value = Number(meta && (meta.rating_mva ?? meta.capacity_mva ?? meta.ratingMVA));
  return Number.isFinite(value) && value > 0 ? value : null;
}

function round1(n) {
  return Math.round(Number(n) * 10) / 10;
}

function familyOf(asset) {
  const type = String((asset && asset.asset_type) || '').toUpperCase();
  return FAMILY_BY_TYPE[type] || 'GENERIC';
}

function readingRows(readings, type) {
  return (readings || []).filter((r) => r.reading_type === type);
}

function latestValue(readings, type) {
  const rows = readingRows(readings, type)
    .slice()
    .sort((a, b) => String(b.recorded_at || '').localeCompare(String(a.recorded_at || '')));
  return rows.length ? Number(rows[0].value_num) : null;
}

function maxInWindow(readings, type, days, now) {
  const since = now - days * 864e5;
  const vals = readingRows(readings, type)
    .filter((r) => Date.parse(r.recorded_at) >= since)
    .map((r) => Number(r.value_num))
    .filter((n) => !Number.isNaN(n));
  return vals.length ? Math.max(...vals) : null;
}

function eventRows(events, type) {
  return (events || []).filter((e) => e.event_type === type);
}

function weightedEvents(events, types, days, now) {
  const since = now - days * 864e5;
  let sum = 0;
  let count = 0;
  for (const e of events || []) {
    if (!types.includes(e.event_type)) continue;
    const t = Date.parse(e.occurred_at);
    if (Number.isNaN(t) || t < since) continue;
    const weight = SEVERITY_WEIGHT[String(e.severity || 'MEDIUM').toUpperCase()] || 1;
    const decay = Math.exp(-(now - t) / (180 * 864e5));
    sum += weight * decay;
    count += 1;
  }
  return { sum, count };
}

function fLoading(ctx) {
  const family = familyOf(ctx.asset);
  const profile = LOADING_PROFILES[LOADING_FAMILY[family]] || LOADING_PROFILES.OTHER;
  const peak = maxInWindow(ctx.readings, 'LOAD_PCT', 90, ctx.now);
  if (peak == null) return null;
  const span = Math.max(1, profile.critical - profile.warn);
  let c = 0;
  if (peak > profile.critical) c = -(1 + Math.min(1.5, (peak - profile.critical) / 50));
  else if (peak > profile.warn) c = -(profile.gradient * ((peak - profile.warn) / span));
  if (!c) return null;
  const capacity = declaredCapacityMva(ctx.asset);
  const basis = capacity ? `${Math.round(peak)}% of ${capacity} MVA` : `${Math.round(peak)}% of MV rating`;
  return {
    key: 'loading',
    label: profile.label,
    value: `${Math.round(peak)}% peak`,
    contribution: round1(c),
    weight: profile.weight,
    reason: `Peak loading ${basis} in the last 90 days`,
  };
}

function fThermal(ctx) {
  const oil = maxInWindow(ctx.readings, 'TOP_OIL_C', 90, ctx.now);
  const winding = maxInWindow(ctx.readings, 'WINDING_C', 90, ctx.now);
  let c = 0;
  const bits = [];
  if (oil != null && oil > 85) { c -= Math.min(1, ((oil - 85) / 10) * 0.4); bits.push(`top-oil ${Math.round(oil)}C`); }
  if (winding != null && winding > 100) { c -= Math.min(1.2, ((winding - 100) / 15) * 0.6); bits.push(`winding ${Math.round(winding)}C`); }
  if (!bits.length) return null;
  return { key: 'thermal', label: 'Thermal', value: bits.join(' · '), contribution: round1(c), weight: 1, reason: `Elevated thermal readings (${bits.join(', ')})` };
}

function fDga(ctx) {
  const h2 = latestValue(ctx.readings, 'DGA_H2_PPM');
  const ch4 = latestValue(ctx.readings, 'DGA_CH4_PPM');
  let c = 0;
  const bits = [];
  const band = (v, a, b, p1, p2) => (v >= a ? (v >= b ? p2 : p1) : 0);
  if (h2 != null) { const p = band(h2, 100, 700, 0.5, 1.5) + (h2 >= 2000 ? 1 : 0); if (p) { c -= p; bits.push(`H2 ${Math.round(h2)}ppm`); } }
  if (ch4 != null) { const p = band(ch4, 120, 700, 0.5, 1.5); if (p) { c -= p; bits.push(`CH4 ${Math.round(ch4)}ppm`); } }
  if (!bits.length) return null;
  return { key: 'dga', label: 'Dissolved gas', value: bits.join(' · '), contribution: round1(Math.max(-3, c)), weight: 1, reason: `Dissolved-gas indicators above threshold (${bits.join(', ')})` };
}

function fMoisture(ctx) {
  const m = latestValue(ctx.readings, 'MOISTURE_PPM');
  if (m == null || m <= 20) return null;
  const c = m > 30 ? -1 : -0.5;
  return { key: 'moisture', label: 'Oil moisture', value: `${Math.round(m)}ppm`, contribution: c, weight: 0.8, reason: `Oil moisture ${Math.round(m)}ppm above the 20ppm limit` };
}

function fVoltage(ctx) {
  const v = maxInWindow(ctx.readings, 'VOLTAGE_DEV_PCT', 90, ctx.now);
  if (v == null || v <= 5) return null;
  const c = v > 10 ? -1 : -0.5;
  return { key: 'voltage', label: 'Voltage deviation', value: `${round1(v)}%`, contribution: c, weight: 0.8, reason: `Voltage deviation ${round1(v)}% exceeds 5%` };
}

function fFaults(ctx) {
  const { sum, count } = weightedEvents(ctx.events, ['THROUGH_FAULT'], 365, ctx.now);
  if (!count) return null;
  const c = -Math.min(3, sum * 0.6);
  return { key: 'faults', label: 'Through-faults', value: `${count} event(s)`, contribution: round1(c), weight: 1, reason: `${count} through-fault event(s) in the last 12 months` };
}

function fSwitching(ctx) {
  const { sum, count } = weightedEvents(ctx.events, ['TRIP'], 365, ctx.now);
  if (!count) return null;
  const c = -Math.min(2, sum * 0.4);
  return { key: 'switching', label: 'Trips', value: `${count} trip(s)`, contribution: round1(c), weight: 1, reason: `${count} trip event(s) in the last 12 months` };
}

function fOverload(ctx) {
  const { sum, count } = weightedEvents(ctx.events, ['OVERLOAD'], 365, ctx.now);
  if (!count) return null;
  const c = -Math.min(2, sum * 0.5);
  return { key: 'overload', label: 'Overloads', value: `${count} event(s)`, contribution: round1(c), weight: 1, reason: `${count} overload event(s) in the last 12 months` };
}

function fEnvironment(ctx) {
  const { sum, count } = weightedEvents(ctx.events, ['CORROSION_SEVERE', 'ENVIRONMENTAL'], 365, ctx.now);
  if (!count) return null;
  const c = -Math.min(2, sum * 0.5);
  return { key: 'environment', label: 'Environment', value: `${count} event(s)`, contribution: round1(c), weight: 1, reason: `${count} environment/corrosion event(s) in the last 12 months` };
}

function fEvents(ctx) {
  const { sum, count } = weightedEvents(ctx.events, EVENT_TYPES, 365, ctx.now);
  if (!count) return null;
  const c = -Math.min(3, sum * 0.35);
  return { key: 'events', label: 'Performance events', value: `${count} event(s)`, contribution: round1(c), weight: 1, reason: `${count} performance event(s) in the last 12 months` };
}

function fMaintenance(ctx) {
  const last = ctx.asset && ctx.asset.last_maintenance_at;
  if (!last) return null;
  const months = ageYears(last) * 12;
  if (months == null || months <= 24) return null;
  const c = months > 36 ? -1 : -0.5;
  return { key: 'maintenance', label: 'Maintenance recency', value: `${Math.round(months)} months`, contribution: c, weight: 0.8, reason: `No maintenance in the last ${Math.round(months)} months` };
}

const FACTOR_EVALUATORS = {
  loading: fLoading,
  thermal: fThermal,
  dga: fDga,
  moisture: fMoisture,
  voltage: fVoltage,
  faults: fFaults,
  switching: fSwitching,
  overload: fOverload,
  environment: fEnvironment,
  events: fEvents,
  maintenance: fMaintenance,
};

function rankRecommendation(rating, asset, factors) {
  const critical = String((asset && asset.criticality) || '').toUpperCase() === 'CRITICAL';
  const years = ageYears(asset && asset.installation_date);
  if (rating <= 2) return 'REPLACE';
  if (rating <= 4 && (critical || (years != null && years >= 40))) return 'REPLACE';
  if (rating <= 4) return 'REPAIR';
  if (rating <= 6) return critical ? 'REPAIR' : 'INSPECT';
  if (factors.some((f) => f.contribution <= -1)) return 'INSPECT';
  return 'MONITOR';
}

function evaluatePerformance(asset, readings = [], events = [], options = {}) {
  const now = options.now == null
    ? Date.now()
    : (typeof options.now === 'number' ? options.now : Date.parse(options.now));
  const family = familyOf(asset);
  const ctx = { asset, readings, events, now };
  const keys = FAMILY_FACTORS[family] || FAMILY_FACTORS.GENERIC;
  const factors = [];
  for (const key of keys) {
    const fn = FACTOR_EVALUATORS[key];
    if (!fn) continue;
    const f = fn(ctx);
    if (f) factors.push(f);
  }
  const base = options.baseRating != null
    ? Number(options.baseRating)
    : ageBaseline(ageYears(asset && asset.installation_date));
  let delta = factors.reduce((acc, f) => acc + (Number(f.contribution) || 0), 0);
  delta = delta < 0 ? Math.max(-6, delta) : 0;
  delta = round1(delta);
  const combined = Math.max(1, Math.min(10, round1(base + delta)));
  const health = computeHealth({ ...(asset || {}), condition_rating: combined });
  const recommendation = rankRecommendation(combined, asset, factors);
  const hasSignal = (readings || []).length > 0 || (events || []).length > 0;
  const reasons = factors.filter((f) => f.contribution < 0).map((f) => f.reason);
  if (!reasons.length) reasons.push('no adverse performance evidence recorded');
  return {
    base_rating: base,
    performance_delta: delta,
    combined_rating: combined,
    health_index: health.health_index,
    rul_years: health.remaining_useful_life_years,
    remaining_useful_life_years: health.remaining_useful_life_years,
    degradation_rate: delta < 0 ? delta : 0,
    factors,
    confidence: hasSignal ? 'HIGH' : 'LOW',
    recommendation,
    recommendation_label: RECOMMENDATION_LABELS[recommendation] || recommendation,
    reasons,
    family,
    model_version: MODEL_VERSION,
  };
}

module.exports = {
  MODEL_VERSION,
  READING_TYPES,
  EVENT_TYPES,
  EVENT_SEVERITIES,
  evaluatePerformance,
  familyOf,
};
