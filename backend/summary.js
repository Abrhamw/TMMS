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
  costComposition,
  fillMonths,
  crewReadiness,
  certificationReadiness,
};
