// Pure parsing + template helpers for infrastructure bulk import. No DB access:
// the route layer resolves regions/substations, enforces scope, and inserts.
//
// Two files can be imported:
//   * substations  — one record per row/Point feature
//   * lines        — one line per group of rows/features, each with optional
//                    towers (a CSV repeats the line columns on every tower row;
//                    a KML/GeoJSON file pairs LineString placemarks with the
//                    Point placemarks that carry a matching line_id property).
const { extractKmzText } = require('./geoimport');

const SUBSTATION_COLUMNS = [
  'substation_id', 'name', 'region_code', 'latitude', 'longitude',
  'voltage_levels', 'substation_type', 'operational_status', 'owner',
  'commissioned_date', 'elevation_m', 'fence_radius_m', 'boundary',
];

const LINE_COLUMNS = [
  'line_id', 'name', 'region_code', 'from_substation_code', 'to_substation_code',
  'voltage_kv', 'line_type', 'conductor_type', 'circuit_count', 'operational_status',
  'commissioned_date', 'route', 'tower_number', 'tower_id', 'latitude', 'longitude',
  'tower_type', 'tower_material', 'height_m', 'foundation_type', 'km_marker',
];

function csvCell(v) {
  const s = v == null ? '' : String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function csvRow(cells) {
  return cells.map(csvCell).join(',');
}

const SUBSTATION_TEMPLATE = [
  csvRow(SUBSTATION_COLUMNS),
  csvRow(['SS-NE1-101', 'Northport 230kV Extension', 'NE1', '11.6100', '38.1600',
    '230kV;132kV', 'SWITCHING', 'OPERATIONAL', 'EEU', '2026-01-15', '2450', '220', '']),
  csvRow(['SS-NE1-102', 'Meridian 132kV', 'NE1', '11.6280', '38.2010',
    '132kV', 'TRANSFORMER', 'OPERATIONAL', 'EEU', '2016-09-30', '2380', '180', '']),
  csvRow(['SS-C1-901', 'Sululta Yard 400/230kV', 'C1', '9.0400', '38.7700',
    '400kV;230kV', 'TRANSFORMER', 'OPERATIONAL', 'EEU', '2011-05-02', '2500', '260',
    '9.0389 38.7660;9.0397 38.7712;9.0411 38.7719;9.0403 38.7668']),
].join('\n');

const LINE_TEMPLATE = [
  csvRow(LINE_COLUMNS),
  // Line header row: no tower/coordinate columns.
  csvRow(['TL-NE1-201', 'Northport <> Meridian 230kV', 'NE1', 'SS-NE1-101', 'SS-NE1-102',
    '230', 'OVERHEAD', 'ACSR 2x630', '2', 'ENERGIZED', '2024-06-01',
    '11.6100 38.1600;11.6180 38.1820;11.6280 38.2010', '', '', '', '', '', '', '', '', '']),
  // Tower rows repeat the line columns; route/line-only columns stay blank.
  csvRow(['TL-NE1-201', '', '', '', '', '', '', '', '', '', '', '',
    '1', 'NE1-201-001', '11.6100', '38.1600', 'SUSPENSION', 'LATTICE_STEEL', '45', 'PAD', '0']),
  csvRow(['TL-NE1-201', '', '', '', '', '', '', '', '', '', '', '',
    '2', 'NE1-201-002', '11.6180', '38.1820', 'ANGLE', 'LATTICE_STEEL', '48', 'PAD', '8.5']),
  csvRow(['TL-NE1-201', '', '', '', '', '', '', '', '', '', '', '',
    '3', 'NE1-201-003', '11.6280', '38.2010', 'DEAD_END', 'LATTICE_STEEL', '50', 'PAD', '17.2']),
].join('\n');

const TEMPLATES = { substations: SUBSTATION_TEMPLATE, lines: LINE_TEMPLATE };

// Local to this module so it does not depend on a route file's private helper.
function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  const s = String(text == null ? '' : text).replace(/^\uFEFF/, '');
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (inQuotes) {
      if (ch === '"') {
        if (s[i + 1] === '"') { field += '"'; i++; } else inQuotes = false;
      } else field += ch;
    } else if (ch === '"') inQuotes = true;
    else if (ch === ',') { row.push(field); field = ''; }
    else if (ch === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
    else if (ch !== '\r') field += ch;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  if (!rows.length) return [];
  const header = rows[0].map((h) => String(h).trim().replace(/\s+/g, '_').toLowerCase());
  return rows.slice(1)
    .filter((r) => r.some((c) => String(c).trim() !== ''))
    .map((r) => {
      const out = {};
      header.forEach((h, i) => {
        if (h && r[i] !== undefined && String(r[i]).trim() !== '') out[h] = String(r[i]).trim();
      });
      return out;
    });
}

// Case/space-insensitive property lookup against a record.
function pick(rec, names) {
  if (!rec) return '';
  for (const n of names) {
    if (rec[n] !== undefined && rec[n] !== null && String(rec[n]).trim() !== '') return String(rec[n]).trim();
  }
  const lower = new Map();
  for (const k of Object.keys(rec)) lower.set(k.toLowerCase().replace(/\s+/g, '_'), k);
  for (const n of names) {
    const k = lower.get(n.toLowerCase());
    if (k && rec[k] !== undefined && rec[k] !== null && String(rec[k]).trim() !== '') return String(rec[k]).trim();
  }
  return '';
}

function num(v) {
  if (v === '' || v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

// "lat lng; lat lng", "lat,lng;lat,lng" (and newline or wkt-ish separators).
function parseCoordPairs(str) {
  const out = [];
  for (const seg of String(str || '').split(/[;\n]+/)) {
    const m = seg.trim().match(/^(-?\d+(?:\.\d+)?)[\s,]+(-?\d+(?:\.\d+)?)$/);
    if (m) out.push([Number(m[1]), Number(m[2])]);
  }
  return out;
}

function validCoord(lat, lng) {
  return Number.isFinite(lat) && Number.isFinite(lng) && lat >= -90 && lat <= 90 && lng >= -180 && lng <= 180;
}

// "230kV;132" | "230, 132" | JSON array -> '["230kV","132kV"]'.
function normalizeVoltageLevels(v) {
  let arr;
  if (Array.isArray(v)) arr = v;
  else {
    const s = String(v == null ? '' : v).trim();
    if (!s) return '[]';
    if (s.startsWith('[')) {
      try { const p = JSON.parse(s); arr = Array.isArray(p) ? p : []; } catch (_) { arr = s.split(/[;,|/]/); }
    } else arr = s.split(/[;,|/]/);
  }
  const out = arr
    .map((x) => String(x).trim())
    .filter(Boolean)
    .map((x) => (/^\d+(?:\.\d+)?$/.test(x) ? `${x}kV` : x));
  return JSON.stringify(out);
}

function firstNonEmpty(rec, names) {
  for (const n of names) {
    const v = pick(rec, [n]);
    if (v !== '') return v;
  }
  return '';
}

function decodeKmz(base64) {
  return extractKmzText(base64);
}

function kmlProperties(body) {
  const props = {};
  for (const m of String(body).matchAll(/<Data\b[^>]*\bname=["']([^"']+)["'][^>]*>([\s\S]*?)<\/Data>/gi)) {
    const key = m[1];
    const vm = m[2].match(/<value[^>]*>([\s\S]*?)<\/value>/i);
    props[key] = (vm ? vm[1] : m[2]).trim();
  }
  if (!Object.keys(props).length) {
    for (const m of String(body).matchAll(/<SimpleData\b[^>]*\bname=["']([^"']+)["'][^>]*>([\s\S]*?)<\/SimpleData>/gi)) {
      props[m[1]] = m[2].trim();
    }
  }
  return props;
}

function kmlCoordList(block) {
  const m = String(block).match(/<coordinates[^>]*>([\s\S]*?)<\/coordinates>/i);
  if (!m) return [];
  return m[1].trim().split(/\s+/).map((tok) => {
    const p = tok.split(',').map(Number);
    return p.length >= 2 && Number.isFinite(p[0]) && Number.isFinite(p[1]) ? [p[1], p[0]] : null;
  }).filter(Boolean);
}

// Parse a KML document into normalized features:
// { name, kind: 'Point'|'LineString', props, lat, lng, coords }
function featuresFromKml(kmlText) {
  const feats = [];
  for (const m of String(kmlText).matchAll(/<Placemark\b[^>]*>([\s\S]*?)<\/Placemark>/gi)) {
    const body = m[1];
    const nm = body.match(/<name[^>]*>([\s\S]*?)<\/name>/i);
    const coords = kmlCoordList(body);
    if (!coords.length) continue;
    const isPoint = /<Point[\s/>]/i.test(body);
    const props = kmlProperties(body);
    feats.push({
      name: (nm ? nm[1].trim() : '') || pick(props, ['name']) || 'Unnamed',
      kind: isPoint ? 'Point' : 'LineString',
      props,
      lat: isPoint ? coords[0][0] : null,
      lng: isPoint ? coords[0][1] : null,
      coords: isPoint ? [] : coords,
    });
  }
  return feats;
}

function featuresFromGeojson(text) {
  const g = JSON.parse(text);
  const raw = g.type === 'FeatureCollection'
    ? (g.features || [])
    : (g.type === 'Feature' ? [g] : (g.type ? [{ type: 'Feature', geometry: g, properties: {} }] : []));
  const feats = [];
  for (const f of raw) {
    const geom = f.geometry || f;
    if (!geom || !geom.type) continue;
    const props = f.properties || {};
    if (geom.type === 'Point') {
      const c = geom.coordinates || [];
      if (c.length < 2) continue;
      feats.push({ name: pick(props, ['name']) || 'Unnamed', kind: 'Point', props, lat: Number(c[1]), lng: Number(c[0]), coords: [] });
    } else if (geom.type === 'LineString') {
      const coords = (geom.coordinates || []).map((p) => [Number(p[1]), Number(p[0])]);
      if (coords.length < 2) continue;
      feats.push({ name: pick(props, ['name']) || 'Unnamed', kind: 'LineString', props, lat: null, lng: null, coords });
    } else if (geom.type === 'MultiLineString') {
      for (const line of geom.coordinates || []) {
        const coords = (line || []).map((p) => [Number(p[1]), Number(p[0])]);
        if (coords.length < 2) continue;
        feats.push({ name: pick(props, ['name']) || 'Unnamed', kind: 'LineString', props, lat: null, lng: null, coords });
      }
    }
  }
  return feats;
}

// Dispatch on the declared format. Returns { kind:'rows', rows } for CSV or
// { kind:'features', features } for KML/KMZ/GeoJSON.
function parseInfra(format, content) {
  if (typeof content !== 'string' || !content.trim()) throw new Error('content is required');
  const fmt = String(format || '').toLowerCase();
  if (fmt === 'csv') {
    const rows = parseCsv(content);
    if (!rows.length) throw new Error('CSV has no data rows');
    return { kind: 'rows', rows };
  }
  if (fmt === 'kml') {
    const features = featuresFromKml(content);
    if (!features.length) throw new Error('KML contains no usable placemarks');
    return { kind: 'features', features };
  }
  if (fmt === 'kmz') {
    const features = featuresFromKml(decodeKmz(content));
    if (!features.length) throw new Error('KMZ contains no usable placemarks');
    return { kind: 'features', features };
  }
  if (fmt === 'geojson' || fmt === 'json') {
    let features;
    try { features = featuresFromGeojson(content); } catch (e) { throw new Error(`Invalid GeoJSON: ${e.message}`); }
    if (!features.length) throw new Error('GeoJSON contains no usable features');
    return { kind: 'features', features };
  }
  throw new Error(`Unsupported format: ${format} (use csv, kml, kmz or geojson)`);
}

const SUBSTATION_ID_KEYS = ['substation_id', 'substation_code', 'substationid', 'code', 'id'];
const SUBSTATION_NAME_KEYS = ['name', 'substation_name', 'title'];
const REGION_CODE_KEYS = ['region_code', 'region', 'regioncode'];

// Every importable substation record with latitude/longitude promoted to the
// top level so the normalizer can stay format-agnostic.
function substationRecords(parsed) {
  if (parsed.kind === 'rows') {
    return parsed.rows.map((r) => ({ props: r, lat: num(pick(r, ['latitude', 'lat'])), lng: num(pick(r, ['longitude', 'lng', 'lon'])) }));
  }
  return parsed.features
    .filter((f) => f.kind === 'Point')
    .filter((f) => {
      const p = f.props || {};
      const isSub = pick(p, ['substation_id', 'substation_code', 'code', 'region_code', 'region']) !== '';
      const isTower = pick(p, ['tower_id', 'tower_code', 'tower_number', 'tower_type']) !== '';
      return isSub || !isTower;
    })
    .map((f) => ({
      props: { ...f.props, name: pick(f.props, ['name']) || f.name },
      lat: num(f.lat),
      lng: num(f.lng),
    }));
}

// Group line inputs into one object per line, preserving source order.
// CSV: rows grouped by line_id. Geo: LineString features are lines; Point
// features attach to the line named by their line_id property, or to the only
// line when the file contains exactly one.
function lineGroups(parsed) {
  if (parsed.kind === 'rows') {
    const byKey = new Map();
    const order = [];
    for (const r of parsed.rows) {
      const key = pick(r, ['line_id', 'line_code', 'line']) || '__single__';
      if (!byKey.has(key)) { byKey.set(key, { key, header: r, route: [], towers: [] }); order.push(key); }
      const g = byKey.get(key);
      const routeStr = pick(r, ['route', 'route_coords', 'geometry', 'polyline']);
      if (routeStr) {
        const pts = parseCoordPairs(routeStr);
        if (pts.length > g.route.length) g.route = pts;
      }
      const lat = num(pick(r, ['latitude', 'lat']));
      const lng = num(pick(r, ['longitude', 'lng', 'lon']));
      if (Number.isFinite(lat) && Number.isFinite(lng)) {
        g.towers.push({ props: r, lat, lng });
      } else {
        for (const [k, v] of Object.entries(r)) if (v !== '' && g.header[k] === undefined) g.header[k] = v;
      }
    }
    return order.map((k) => byKey.get(k));
  }
  const lines = parsed.features.filter((f) => f.kind === 'LineString');
  const points = parsed.features.filter((f) => f.kind === 'Point');
  const groups = lines.map((f, i) => ({
    key: pick(f.props, ['line_id', 'line_code', 'line']) || f.name || `__line_${i}__`,
    header: { ...f.props, name: pick(f.props, ['name']) || f.name },
    route: f.coords,
    towers: [],
  }));
  const single = groups.length === 1 ? groups[0] : null;
  for (const p of points) {
    const ref = pick(p.props, ['line_id', 'line_code', 'line']);
    const looksLikeTower = pick(p.props, ['tower_id', 'tower_code', 'tower_number', 'tower_type']) !== '';
    const target = ref
      ? groups.find((g) => g.key === ref || (g.header.name && String(g.header.name) === ref))
      : (looksLikeTower ? single : null);
    if (!target) continue;
    target.towers.push({ props: p.props, lat: p.lat, lng: p.lng });
  }
  return groups;
}

module.exports = {
  SUBSTATION_COLUMNS,
  LINE_COLUMNS,
  TEMPLATES,
  parseCsv,
  pick,
  num,
  parseCoordPairs,
  validCoord,
  normalizeVoltageLevels,
  firstNonEmpty,
  parseInfra,
  substationRecords,
  lineGroups,
  SUBSTATION_ID_KEYS,
  SUBSTATION_NAME_KEYS,
  REGION_CODE_KEYS,
};
