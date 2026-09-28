import StaticMap from './StaticMap';
import { entityColor, maxVoltageKv } from '../mapFocus';

// Renders the geographic footprint of a dossier entity: the parent line route,
// the substation yard/fence, tower positions and the entity point itself. Used
// by both dossier renderers (Dossier.jsx and DossierReport.jsx) so a generated
// dossier always carries a map when the entity has coordinates.

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
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
  if (num(sub.fence_radius_m) && pos) {
    out.circles.push({ lat: pos[0], lng: pos[1], radius: sub.fence_radius_m, color, label: `${sub.name} fence`, legendLabel: 'Substation fence' });
  }
}

function addTower(out, tower, line, { cap = 400, primary = false } = {}) {
  if (!tower || out.markers.length >= cap) return;
  const pos = pt(tower.latitude, tower.longitude);
  if (!pos) return;
  out.markers.push({
    lat: pos[0], lng: pos[1],
    color: entityColor(lineKv(line), line ? line.operational_status : null),
    radius: primary ? 8 : 4,
    flash: primary,
    label: tower.tower_id,
    sub: line ? line.name : null,
    legendLabel: 'Tower',
  });
  out.fit.push(pos);
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

function buildAsset(d) {
  const out = { markers: [], polylines: [], polygons: [], circles: [], fit: [], focus: null };
  const a = d.asset || {};
  const voltage = lineKv(d.line) ?? subKv(d.substation);
  addLine(out, d.line, true);
  addSub(out, d.substation);
  addTower(out, d.tower, d.line, { primary: true });
  const pos = addAssetPoint(out, a, { voltage });
  out.focus = pos ? [pos] : (out.fit.length ? out.fit : null);
  return out;
}

function buildLine(d) {
  const out = { markers: [], polylines: [], polygons: [], circles: [], fit: [], focus: null };
  addLine(out, d.line, true);
  addSub(out, d.from_substation);
  addSub(out, d.to_substation);
  (d.towers || []).forEach((t) => addTower(out, t, d.line, { cap: 400 }));
  out.focus = out.polylines.length ? out.polylines.flatMap((p) => p.points) : out.fit;
  return out;
}

function buildTask(d) {
  const out = { markers: [], polylines: [], polygons: [], circles: [], fit: [], focus: null };
  const t = d.target || {};
  if (t.line) {
    addLine(out, t.line, true);
    // A line's start and end terminals, so the printed map shows where it runs.
    addSub(out, t.line.from_substation);
    addSub(out, t.line.to_substation);
  }
  addSub(out, t.substation);
  addTower(out, t.tower, t.line, { primary: true });
  const voltage = lineKv(t.line) ?? subKv(t.substation);
  const assetPos = t.asset ? addAssetPoint(out, t.asset, { voltage }) : null;
  out.focus = assetPos ? [assetPos] : (out.polylines.length ? out.polylines.flatMap((p) => p.points) : out.fit);
  return out;
}

function build(dossier) {
  if (!dossier) return null;
  if (dossier.entity === 'ASSET') return buildAsset(dossier);
  if (dossier.entity === 'LINE') return buildLine(dossier);
  if (dossier.entity === 'TASK') return buildTask(dossier);
  return null;
}

export default function DossierGeo({ dossier, title = 'Location map' }) {
  const geo = build(dossier);
  if (!geo) return null;
  const hasGeometry = geo.markers.length > 0 || geo.polylines.length > 0 || geo.circles.length > 0 || geo.polygons.length > 0;
  if (!hasGeometry) return null;
  return (
    <div className="mt">
      <h4 className="section-title">{title}</h4>
      <StaticMap
        width={640}
        height={300}
        markers={geo.markers}
        polylines={geo.polylines}
        polygons={geo.polygons}
        circles={geo.circles}
        focus={geo.focus && geo.focus.length ? geo.focus : null}
        ariaLabel={`Location map for ${dossier.entity_name || dossier.entity}`}
      />
    </div>
  );
}
