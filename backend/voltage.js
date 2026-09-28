// Voltage-level color coding for infrastructure.
//
// Kept in sync with frontend/src/mapFocus.js (VOLTAGE_BANDS / voltageColor /
// maxVoltageKv / isEnergized). The named palette is deliberately banded so that
// nominal and near-nominal ratings (e.g. 138, 220, 345) still resolve to the
// closest named level.
const VOLTAGE_BANDS = [
  { label: '500 kV', min: 450, color: '#f97316' },
  { label: '400 kV', min: 300, color: '#9333ea' },
  { label: '230 kV', min: 200, color: '#16a34a' },
  { label: '132 kV', min: 100, color: '#dc2626' },
  { label: '66 kV', min: 55, color: '#2563eb' },
  { label: '45 kV', min: 40, color: '#7c2d12' },
  { label: '33/15 kV', min: 1, color: '#eab308' },
];

const STATUS_COLOR = {
  OPERATIONAL: '#22c55e',
  ENERGIZED: '#22c55e',
  IN_SERVICE: '#22c55e',
  MAINTENANCE: '#f59e0b',
  UNDER_MAINTENANCE: '#f59e0b',
  OUT_OF_SERVICE: '#ef4444',
  DE_ENERGIZED: '#ef4444',
  DECOMMISSIONED: '#6b7280',
  RETIRED: '#6b7280',
  UNDER_CONSTRUCTION: '#3b82f6',
  DEGRADED: '#f97316',
};

const POWERED_UP = new Set(['ENERGIZED', 'OPERATIONAL', 'IN_SERVICE']);

function parseKv(v) {
  if (typeof v === 'number') return Number.isFinite(v) && v > 0 ? v : null;
  if (typeof v !== 'string') return null;
  const m = v.match(/-?\d+(?:\.\d+)?/);
  if (!m) return null;
  const n = Number(m[0]);
  return Number.isFinite(n) && n > 0 ? n : null;
}

// Normalizes the shapes voltage_levels arrives in (JSON-array string, real
// array, CSV string, scalar) into an array of strings.
function parseVoltageLevels(levels) {
  if (Array.isArray(levels)) return levels.map(String);
  if (levels == null) return [];
  if (typeof levels === 'string') {
    const s = levels.trim();
    if (s.startsWith('[')) {
      try {
        const v = JSON.parse(s);
        return Array.isArray(v) ? v.map(String) : [];
      } catch (_) { /* fall through to split */ }
    }
    return s.split(/[,;|/]/).map((x) => x.trim()).filter(Boolean);
  }
  return [String(levels)];
}

// Accepts a JSON-array string, a real array, a CSV string or a scalar and
// returns the highest positive nominal kV found.
function maxVoltageKv(levels) {
  const arr = parseVoltageLevels(levels);
  let max = null;
  for (const l of arr) {
    const kv = parseKv(l);
    if (kv != null && (max == null || kv > max)) max = kv;
  }
  return max;
}

function voltageBand(kv) {
  const v = parseKv(kv);
  if (v == null) return null;
  return VOLTAGE_BANDS.find((b) => v >= b.min) || null;
}

function voltageColor(kv) {
  const b = voltageBand(kv);
  return b ? b.color : '#6b7280';
}

function isEnergized(status) {
  return POWERED_UP.has(status);
}

// Voltage color while the equipment is energized, otherwise its status color.
function entityColor(kv, status) {
  return isEnergized(status) ? voltageColor(kv) : (STATUS_COLOR[status] || '#6b7280');
}

module.exports = {
  VOLTAGE_BANDS,
  STATUS_COLOR,
  POWERED_UP,
  parseKv,
  parseVoltageLevels,
  maxVoltageKv,
  voltageBand,
  voltageColor,
  isEnergized,
  entityColor,
};
