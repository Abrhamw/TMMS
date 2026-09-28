import L from 'leaflet';

export const FOCUS_COLOR = '#2563eb';
export const RELATED_COLOR = '#0ea5e9';

// Voltage-level palette for infrastructure. Banded so nominal and near-nominal
// ratings (e.g. 138, 220, 345) resolve to the closest named level. Mirrors
// backend/voltage.js — keep both in sync.
export const VOLTAGE_BANDS = [
  { label: '500 kV', min: 450, color: '#f97316' },
  { label: '400 kV', min: 300, color: '#9333ea' },
  { label: '230 kV', min: 200, color: '#16a34a' },
  { label: '132 kV', min: 100, color: '#dc2626' },
  { label: '66 kV', min: 55, color: '#2563eb' },
  { label: '45 kV', min: 40, color: '#7c2d12' },
  { label: '33/15 kV', min: 1, color: '#eab308' },
];

export const STATUS_COLOR = {
  OPERATIONAL: '#22c55e', ENERGIZED: '#22c55e', IN_SERVICE: '#22c55e',
  MAINTENANCE: '#f59e0b', UNDER_MAINTENANCE: '#f59e0b',
  OUT_OF_SERVICE: '#ef4444', DE_ENERGIZED: '#ef4444',
  DECOMMISSIONED: '#6b7280', RETIRED: '#6b7280',
  UNDER_CONSTRUCTION: '#3b82f6', DEGRADED: '#f97316',
};

const POWERED_UP = new Set(['ENERGIZED', 'OPERATIONAL', 'IN_SERVICE']);

export function parseKv(v) {
  if (typeof v === 'number') return Number.isFinite(v) && v > 0 ? v : null;
  if (typeof v !== 'string') return null;
  const m = v.match(/-?\d+(?:\.\d+)?/);
  if (!m) return null;
  const n = Number(m[0]);
  return Number.isFinite(n) && n > 0 ? n : null;
}

// Normalizes the many shapes voltage_levels arrives in (JSON-array string,
// real array, CSV string, scalar) into an array of strings for display.
export function parseVoltageLevels(levels) {
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
export function maxVoltageKv(levels) {
  const arr = parseVoltageLevels(levels);
  let max = null;
  for (const l of arr) {
    const kv = parseKv(l);
    if (kv != null && (max == null || kv > max)) max = kv;
  }
  return max;
}

export function voltageBand(kv) {
  const v = parseKv(kv);
  if (v == null) return null;
  return VOLTAGE_BANDS.find((b) => v >= b.min) || null;
}

export function voltageColor(kv) {
  const b = voltageBand(kv);
  return b ? b.color : '#6b7280';
}

export function voltageLabel(kv) {
  const b = voltageBand(kv);
  return b ? b.label : (kv != null ? `${kv} kV` : '—');
}

export function isEnergized(status) {
  return POWERED_UP.has(status);
}

// Voltage color while the equipment is energized, otherwise its status color.
export function entityColor(kv, status) {
  return isEnergized(status) ? voltageColor(kv) : (STATUS_COLOR[status] || '#6b7280');
}

export function voltageChip(kv, { energized = true } = {}) {
  const color = energized ? voltageColor(kv) : '#6b7280';
  const label = voltageLabel(kv);
  return `<span class="tmms-volt-chip" style="background:${color}">${label}</span>`;
}

// Escapes a value for safe interpolation into popup HTML.
export function esc(v) {
  return String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// Small "label: value" rows rendered inside Leaflet popups. Rows with an empty
// value are skipped. `label`/`html` rows render raw with a bold value.
export function popupRows(rows) {
  return (rows || [])
    .filter(Boolean)
    .map(([k, v]) => (v == null || v === '' ? '' : `<div class="tmms-pop-row"><span>${esc(k)}</span><b>${esc(v)}</b></div>`))
    .join('');
}

export function asLatLngs(points) {
  if (!Array.isArray(points)) return [];
  const out = [];
  for (const p of points) {
    if (!p) continue;
    const lat = Array.isArray(p) ? Number(p[0]) : Number(p.lat);
    const lng = Array.isArray(p) ? Number(p[1]) : Number(p.lng);
    if (Number.isFinite(lat) && Number.isFinite(lng)) out.push([lat, lng]);
  }
  return out;
}

export function boundsOf(points) {
  const pts = asLatLngs(points);
  return pts.length ? L.latLngBounds(pts) : null;
}

export function circleCorners(lat, lng, radiusM) {
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return [];
  const r = Number(radiusM) || 0;
  if (r <= 0) return [[lat, lng]];
  const dLat = r / 111320;
  const cos = Math.max(0.1, Math.abs(Math.cos((lat * Math.PI) / 180)));
  const dLng = r / (111320 * cos);
  return [[lat - dLat, lng - dLng], [lat + dLat, lng + dLng]];
}

export function flyToPoints(map, points, { maxZoom = 15, padding = [48, 48], duration = 0.7, singleZoom = 15 } = {}) {
  const b = boundsOf(points);
  if (!map || !b || !b.isValid()) return false;
  const sw = b.getSouthWest();
  const ne = b.getNorthEast();
  if (sw.equals(ne)) {
    map.flyTo(b.getCenter(), singleZoom, { duration });
  } else {
    map.flyToBounds(b, { maxZoom, padding, duration });
  }
  return true;
}

export function mapSizeReady(map) {
  const size = map && map.getSize();
  return !!(size && size.x >= 2 && size.y >= 2);
}

export function pulseIcon(color = FOCUS_COLOR, size = 16) {
  return L.divIcon({
    className: 'tmms-focus-pin',
    html:
      `<span class="tmms-focus-ring" style="border-color:${color}"></span>` +
      `<span class="tmms-focus-core" style="background:${color};width:${size}px;height:${size}px"></span>`,
    iconSize: [size, size],
    iconAnchor: [size / 2, size / 2],
  });
}

export function flashIcon(color = '#dc2626', size = 20) {
  return L.divIcon({
    className: 'tmms-target-pin',
    html:
      `<span class="tmms-target-halo" style="border-color:${color}"></span>` +
      `<span class="tmms-target-dot" style="background:${color};width:${size}px;height:${size}px"></span>`,
    iconSize: [size, size],
    iconAnchor: [size / 2, size / 2],
  });
}

export function nearestIndex(route, lat, lng) {
  const pts = asLatLngs(route);
  let best = -1;
  let bestD = Infinity;
  for (let i = 0; i < pts.length; i += 1) {
    const d = (pts[i][0] - lat) ** 2 + (pts[i][1] - lng) ** 2;
    if (d < bestD) { bestD = d; best = i; }
  }
  return best;
}

export function relatedSegment(route, lat, lng) {
  const pts = asLatLngs(route);
  if (!pts.length) return [];
  const idx = nearestIndex(pts, lat, lng);
  if (idx < 0) return [];
  return pts.slice(Math.max(0, idx - 1), Math.min(pts.length, idx + 2));
}
