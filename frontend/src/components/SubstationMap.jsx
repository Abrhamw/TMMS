import StaticMap from './StaticMap';
import { entityColor, maxVoltageKv } from '../mapFocus';
import { substationDescription, assetDescription } from '../checklistFormat';

// A compact, fully static site plan for a work location that is a substation
// (or a stand-alone asset): the yard perimeter from the substation boundary
// polygon (falling back to its fence radius), the substation marker and the
// asset being worked on — drawn as plain SVG with a descriptive caption, so it
// prints identically and never overlaps other report blocks.

const num = (v) => {
  const n = typeof v === 'number' ? v : parseFloat(v);
  return Number.isFinite(n) ? n : null;
};

function ringOf(v) {
  let r = v;
  if (typeof r === 'string') {
    try { r = JSON.parse(r); } catch (_) { return null; }
  }
  if (!Array.isArray(r) || r.length < 3) return null;
  const pts = r.map((p) => {
    if (Array.isArray(p) && p.length >= 2) return [num(p[0]), num(p[1])];
    if (p && p.lat != null && p.lng != null) return [num(p.lat), num(p.lng)];
    return null;
  }).filter((p) => p && p[0] != null && p[1] != null);
  return pts.length >= 3 ? pts : null;
}

export function hasSubstationMap(target) {
  if (!target) return false;
  const s = target.substation;
  const a = target.asset;
  return !!((s && num(s.latitude) != null && num(s.longitude) != null)
    || (a && num(a.latitude) != null && num(a.longitude) != null));
}

function perimeterNote(sub, ring) {
  if (ring) return `mapped perimeter · ${ring.length} corner points`;
  if (num(sub.fence_radius_m) > 0) return `fence radius ${Math.round(num(sub.fence_radius_m))} m`;
  return null;
}

export default function SubstationMap({ target, height = 180 }) {
  if (!hasSubstationMap(target)) return null;
  const s = target.substation || null;
  const a = target.asset || null;

  const markers = [];
  const circles = [];
  const polygons = [];
  const focus = [];
  const sPos = s ? [num(s.latitude), num(s.longitude)] : null;
  const aPos = a && num(a.latitude) != null && num(a.longitude) != null ? [num(a.latitude), num(a.longitude)] : null;
  const voltage = s ? maxVoltageKv(s.voltage_levels) : null;
  const sColor = entityColor(voltage, s && s.operational_status);

  let ring = null;
  if (s && sPos && sPos[0] != null) {
    markers.push({ lat: sPos[0], lng: sPos[1], color: sColor, radius: 7, label: s.name, sub: s.substation_id, legendLabel: 'Substation' });
    focus.push(sPos);
    ring = ringOf(s.boundary_json);
    if (ring) {
      polygons.push({ points: ring, color: sColor, label: `${s.name} perimeter`, legendLabel: 'Substation perimeter' });
      ring.forEach((p) => focus.push(p));
    } else if (num(s.fence_radius_m) > 0) {
      const r = num(s.fence_radius_m);
      circles.push({ lat: sPos[0], lng: sPos[1], radius: r, color: sColor, label: `${s.name} perimeter`, legendLabel: 'Substation perimeter' });
    }
  }
  if (aPos) {
    markers.push({ lat: aPos[0], lng: aPos[1], color: '#dc2626', radius: 8, flash: true, label: a.name || a.asset_id, sub: a.asset_id, legendLabel: 'Asset' });
    focus.push(aPos);
  }

  const ringNote = s ? perimeterNote(s, ring) : null;
  const coords = sPos && sPos[0] != null ? `${Number(sPos[0]).toFixed(5)}, ${Number(sPos[1]).toFixed(5)}` : null;

  return (
    <div className="target-map">
      <StaticMap
        width={240}
        height={height}
        markers={markers}
        circles={circles}
        polygons={polygons}
        focus={focus.length ? focus : null}
        ariaLabel={s ? `Site plan of ${s.name}` : 'Site plan'}
      />
      <div className="target-map-caption">
        {s && (
          <div>
            <b>{s.name}</b>{s.substation_id ? ` (${s.substation_id})` : ''}
            {substationDescription(s) ? <> — {substationDescription(s)}</> : null}
          </div>
        )}
        {s && (
          <div className="muted">
            {[ringNote, coords].filter(Boolean).join(' · ') || 'No perimeter recorded'}
          </div>
        )}
        {a && (
          <div>
            <b>{a.name || a.asset_id}</b>
            {[a.asset_type, a.location_type].filter(Boolean).length ? ` — ${[a.asset_type, a.location_type].filter(Boolean).join(' · ')}` : null}
            {assetDescription(a) ? <> — {assetDescription(a)}</> : null}
          </div>
        )}
      </div>
    </div>
  );
}
