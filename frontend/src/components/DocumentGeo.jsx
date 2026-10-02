import StaticMap from './StaticMap';
import { entityColor, maxVoltageKv, boundaryRing } from '../mapFocus';

// Renders the geographic footprint of a document entity: the parent line route,
// the substation yard/fence, tower positions and the entity point itself. Used
// by both document renderers (Document.jsx and DocumentReport.jsx) so a generated
// document always carries a map when the entity has coordinates.

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const DEFAULT_LAYERS = { route: true, covered: true, trace: true, towers: true };
const pt = (lat, lng) => {
  const a = num(lat);
  const b = num(lng);
  return a != null && b != null ? [a, b] : null;
};
const routePts = (route) => (Array.isArray(route) ? route.map((p) => (Array.isArray(p) ? pt(Number(p[0]), Number(p[1])) : null)).filter(Boolean) : []);
const lineKv = (line) => (line ? num(line.voltage_kv) : null);
const subKv = (sub) => (sub ? maxVoltageKv(sub.voltage_levels) : null);

function addLine(out, line, primary) {
  if (!line) return;
  const points = routePts(line.route_json);
  if (points.length < 2) return;
  out.polylines.push({
    points,
    color: entityColor(lineKv(line), line.operational_status),
    weight: primary ? 5 : 3,
    label: line.name,
    legendLabel: `Line ${line.name || ''}`.trim(),
  });
  points.forEach((p) => out.fit.push(p));
}

function addSub(out, sub) {
  if (!sub) return;
  const color = entityColor(subKv(sub), sub.operational_status);
  const pos = pt(sub.latitude, sub.longitude);
  if (pos) {
    out.markers.push({ lat: pos[0], lng: pos[1], color, label: sub.name, sub: sub.substation_id, alwaysLabel: true, legendLabel: `Substation ${sub.name || ''}`.trim() });
    out.fit.push(pos);
  }
  // Prefer the substation's recorded boundary polygon; only fall back to a
  // synthetic fence-radius circle when no boundary geometry exists.
  const ring = boundaryRing(sub.boundary_json);
  if (ring) {
    out.polygons.push({ points: ring, color, label: `${sub.name} perimeter`, legendLabel: 'Substation perimeter' });
    ring.forEach((p) => out.fit.push(p));
  } else if (num(sub.fence_radius_m) && pos) {
    out.circles.push({ lat: pos[0], lng: pos[1], radius: sub.fence_radius_m, color, label: `${sub.name} fence`, legendLabel: 'Substation fence' });
  }
}

function addTower(out, tower, line, { cap = 400, primary = false, inspected = null } = {}) {
  if (!tower || out.markers.length >= cap) return;
  const pos = pt(tower.latitude, tower.longitude);
  if (!pos) return;
  out.markers.push({
    lat: pos[0], lng: pos[1],
    color: inspected == null ? entityColor(lineKv(line), line ? line.operational_status : null) : (inspected ? '#0d9488' : '#94a3b8'),
    radius: primary ? 8 : 4,
    flash: primary,
    label: tower.tower_id,
    sub: line ? line.name : null,
    legendLabel: 'Tower',
  });
  out.fit.push(pos);
}

const inspectedSet = (insp) => (insp && Array.isArray(insp.inspected_tower_ids)
  ? new Set(insp.inspected_tower_ids.map(Number))
  : null);

function addInspection(out, insp, L) {
  if (!insp) return;
  if (L.covered) (insp.covered_paths || []).forEach((seg) => {
    const points = routePts(seg);
    if (points.length < 2) return;
    out.polylines.push({ points, color: '#16a34a', weight: 7, label: 'Inspected span', legendLabel: 'Inspected span' });
    points.forEach((p) => out.fit.push(p));
  });
  if (L.trace) {
    const trace = (insp.trace_points || []).map((p) => pt(p.lat, p.lng)).filter(Boolean);
    if (trace.length >= 2) {
      out.polylines.push({ points: trace, color: '#ea580c', weight: 3, label: 'Crew trace', legendLabel: 'Crew trace' });
      trace.forEach((p) => out.fit.push(p));
    }
  }
  out.inspection = insp;
}

function addAssetPoint(out, asset, { voltage, flash = true } = {}) {
  const pos = asset ? pt(asset.latitude, asset.longitude) : null;
  if (!pos) return null;
  out.markers.push({
    lat: pos[0], lng: pos[1],
    color: entityColor(voltage, asset.operational_status),
    radius: flash ? 9 : 6,
    flash,
    alwaysLabel: true,
    label: asset.name || asset.asset_id,
    sub: asset.asset_id,
    legendLabel: 'Asset',
  });
  out.fit.push(pos);
  return pos;
}

function buildAsset(d, L) {
  const out = { markers: [], polylines: [], polygons: [], circles: [], fit: [], focus: null };
  const a = d.asset || {};
  const voltage = lineKv(d.line) ?? subKv(d.substation);
  if (L.route) {
    addLine(out, d.line, true);
    addSub(out, d.substation);
  }
  addTower(out, d.tower, d.line, { primary: true });
  const pos = addAssetPoint(out, a, { voltage });
  out.focus = pos ? [pos] : (out.fit.length ? out.fit : null);
  return out;
}

function buildLine(d, L) {
  const out = { markers: [], polylines: [], polygons: [], circles: [], fit: [], focus: null };
  const insp = d.inspection || null;
  const inspected = inspectedSet(insp);
  if (L.route) {
    addLine(out, d.line, true);
    addSub(out, d.from_substation);
    addSub(out, d.to_substation);
  }
  if (L.towers) {
    (d.towers || []).forEach((t) => addTower(out, t, d.line, { cap: 400, inspected: inspected ? inspected.has(Number(t.id)) : null }));
  }
  addInspection(out, insp, L);
  out.focus = out.polylines.length ? [...out.polylines.flatMap((p) => p.points), ...out.fit] : out.fit;
  return out;
}

function buildTask(d, L) {
  const out = { markers: [], polylines: [], polygons: [], circles: [], fit: [], focus: null };
  const insp = d.inspection || null;
  const inspected = inspectedSet(insp);
  const t = d.target || {};
  if (L.route && t.line) {
    addLine(out, t.line, true);
    // A line's start and end terminals, so the printed map shows where it runs.
    addSub(out, t.line.from_substation);
    addSub(out, t.line.to_substation);
  }
  if (L.route) addSub(out, t.substation);
  addTower(out, t.tower, t.line, { primary: true, inspected: t.tower && inspected ? inspected.has(Number(t.tower.id)) : null });
  if (L.towers) {
    (d.towers || []).forEach((tw) => addTower(out, tw, t.line, { cap: 400, inspected: inspected ? inspected.has(Number(tw.id)) : null }));
  }
  const voltage = lineKv(t.line) ?? subKv(t.substation);
  const assetPos = t.asset ? addAssetPoint(out, t.asset, { voltage }) : null;
  addInspection(out, insp, L);
  out.focus = assetPos ? [assetPos] : (out.polylines.length ? [...out.polylines.flatMap((p) => p.points), ...out.fit] : out.fit);
  return out;
}

function build(document, layers) {
  if (!document) return null;
  const L = { ...DEFAULT_LAYERS, ...(layers || {}) };
  if (document.entity === 'ASSET') return buildAsset(document, L);
  if (document.entity === 'LINE') return buildLine(document, L);
  if (document.entity === 'TASK') return buildTask(document, L);
  return null;
}

export default function DocumentGeo({ document, title = 'Location map', showTitle = true, layers }) {
  const geo = build(document, layers);
  if (!geo) return null;
  const hasGeometry = geo.markers.length > 0 || geo.polylines.length > 0 || geo.circles.length > 0 || geo.polygons.length > 0;
  if (!hasGeometry) return null;
  // A short, human description of what is drawn. This is what makes the printed
  // map self-explanatory: the reader knows the whole route is shown end to end
  // rather than a cropped zoom.
  const kind = { ASSET: 'Asset', LINE: 'Transmission line', TASK: 'Work target' }[document.entity] || 'Location';
  const name = document.entity_name || document.asset?.name || document.line?.name || document.target?.name;
  const towers = geo.markers.filter((m) => m.legendLabel === 'Tower').length;
  const subs = geo.markers.filter((m) => m.legendLabel && m.legendLabel.startsWith('Substation')).length;
  const routePts = geo.polylines.reduce((n, l) => n + l.points.length, 0);
  const insp = geo.inspection;
  const prog = insp && insp.total_towers ? Math.round((insp.tower_progress || 0) * 100) : null;
  const bits = [
    routePts >= 2 ? `route drawn end to end (${routePts} points)` : null,
    towers ? `${towers} tower${towers === 1 ? '' : 's'}` : null,
    subs ? `${subs} substation${subs === 1 ? '' : 's'}` : null,
    geo.circles.length || geo.polygons.length ? 'perimeter shown' : null,
    insp ? `${insp.inspected_towers}/${insp.total_towers} towers inspected${prog != null ? ` (${prog}%)` : ''}` : null,
    insp && insp.inspected_km ? `${insp.inspected_km} km covered` : null,
  ].filter(Boolean);
  return (
    <div className="target-map">
      {showTitle && <h4 className="section-title">{title}</h4>}
      <StaticMap
        width={640}
        height={300}
        markers={geo.markers}
        polylines={geo.polylines}
        polygons={geo.polygons}
        circles={geo.circles}
        focus={geo.focus && geo.focus.length ? geo.focus : null}
        ariaLabel={`Location map for ${document.entity_name || document.entity}`}
      />
      <div className="target-map-caption">
        <div><b>{kind}{name ? `: ${name}` : ''}</b>{document.entity_number ? ` (${document.entity_number})` : ''}</div>
        <div className="muted">{bits.join(' · ') || 'Location recorded'}</div>
      </div>
    </div>
  );
}
