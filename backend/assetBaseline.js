const MOUNT = 365.25 * 24 * 3600 * 1000;

function ageYears(dateStr) {
  if (!dateStr) return null;
  const t = Date.parse(dateStr);
  if (Number.isNaN(t)) return null;
  return Math.max(0, (Date.now() - t) / MOUNT);
}

function ageBaseline(years) {
  if (years == null) return 7;
  if (years < 10) return 9;
  if (years < 20) return 8;
  if (years < 30) return 7;
  if (years < 35) return 6;
  if (years < 45) return 5;
  return 4;
}

function computeHealth(asset) {
  const rating = asset && asset.condition_rating != null ? Number(asset.condition_rating) : 7;
  const years = ageYears(asset && asset.installation_date);
  const age = years == null ? 5 : years;
  const condFactor = rating / 10;
  const ageFactor = Math.max(0, 1 - age / 45);
  const h = Math.round((condFactor * 0.7 + ageFactor * 0.3) * 1000) / 10;
  return {
    health_index: Math.max(1, Math.min(100, h)),
    remaining_useful_life_years: Math.round((rating / 10) * Math.max(2, 40 - age) * 10) / 10,
  };
}

const RECOMMENDATION_LABELS = {
  REPLACE: 'Replace / plan renewal',
  REPAIR: 'Repair',
  INSPECT: 'Inspect',
  MONITOR: 'Monitor',
};

module.exports = { ageYears, ageBaseline, computeHealth, RECOMMENDATION_LABELS };
