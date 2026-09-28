import { entityColor, maxVoltageKv } from '../mapFocus';

// A schematic, tile-free route map for the printed location block: the line is
// drawn as a heavy route with its start and end substations named at the ends,
// and the asset (or tower) being worked on is pinned at its place along the
// route. Deliberately has no busy background so it stays legible in print and
// lets the route carry the weight.

const W = 240;
const H = 210;
const PAD = 28;

const num = (v) => {
  const n = typeof v === 'number' ? v : parseFloat(v);
  return Number.isFinite(n) ? n : null;
};
const pt = (lat, lng) => {
  const a = num(lat);
  const b = num(lng);
  return a != null && b != null ? [a, b] : null;
};
const routePts = (route) => {
  let r = route;
  if (typeof r === 'string') {
    try { r = JSON.parse(r); } catch (_) { return []; }
  }
  if (!Array.isArray(r)) return [];
  return r.map((p) => (Array.isArray(p) ? pt(p[0], p[1]) : null)).filter(Boolean);
};

// Path position at half its length, used when the work point has no coordinates.
function midOf(pts) {
  if (pts.length < 2) return pts[0] || { x: W / 2, y: H / 2 };
  const seg = [];
  let total = 0;
  for (let i = 1; i < pts.length; i += 1) {
    const d = Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y);
    seg.push(d);
    total += d;
  }
  const half = total / 2;
  let acc = 0;
  for (let i = 0; i < seg.length; i += 1) {
    if (acc + seg[i] >= half) {
      const t = seg[i] ? (half - acc) / seg[i] : 0;
      return {
        x: pts[i].x + (pts[i + 1].x - pts[i].x) * t,
        y: pts[i].y + (pts[i + 1].y - pts[i].y) * t,
      };
    }
    acc += seg[i];
  }
  return pts[pts.length - 1];
}

export function hasRouteSketch(target) {
  return !!(target && (target.line || target.tower));
}

export default function RouteSketch({ target }) {
  if (!hasRouteSketch(target)) return null;
  const line = target.line || null;
  const sub = target.substation || null;
  const tower = target.tower || null;
  const asset = target.asset || null;

  const from = (line && line.from_substation) || null;
  const to = (line && line.to_substation) || null;
  const route = line ? routePts(line.route_json) : [];
  const fromPos = from ? pt(from.latitude, from.longitude) : null;
  const toPos = to ? pt(to.latitude, to.longitude) : null;
  const towerPos = tower ? pt(tower.latitude, tower.longitude) : null;
  const assetPos = asset ? pt(asset.latitude, asset.longitude) : null;

  const pinName = tower
    ? (tower.tower_id ? `Tower ${tower.tower_id}` : 'Tower')
    : asset ? (asset.name || asset.asset_id) : null;
  const pinPos = towerPos || assetPos || null;

  let path = route;
  if (path.length < 2) path = [fromPos, toPos].filter(Boolean);

  const geo = path.length >= 2 ? path : [];
  const all = [...geo];
  if (pinPos) all.push(pinPos);

  let pts;
  let fromXY;
  let toXY;
  let pinXY;
  // Which terminal name sits on which drawn end. Defaults to route order, but
  // when the stored route runs "backwards" relative to from/to the two names
  // are swapped so each end is still labelled with the substation it is near.
  let startName = from ? from.name : null;
  let endName = to ? to.name : null;
  if (geo.length >= 2) {
    // Always north-up: latitude is the vertical axis and longitude the
    // horizontal one, scaled by the local cos(latitude) so the shape keeps its
    // true proportions. The map is a faithful copy of the real route, never a
    // rotated/schematic one, so a printed report matches the map on screen.
    const lats = all.map((p) => p[0]);
    const lngs = all.map((p) => p[1]);
    const midLat = (Math.min(...lats) + Math.max(...lats)) / 2;
    const lngK = Math.max(0.1, Math.cos((midLat * Math.PI) / 180));
    const minLat = Math.min(...lats);
    const maxLat = Math.max(...lats);
    const minLng = Math.min(...lngs);
    const maxLng = Math.max(...lngs);
    const spanA = maxLat - minLat || 1e-9;
    const spanB = (maxLng - minLng) * lngK || 1e-9;
    const scale = Math.min((W - 2 * PAD) / spanB, (H - 2 * PAD) / spanA);
    const offX = PAD + ((W - 2 * PAD) - spanB * scale) / 2;
    const offY = PAD + ((H - 2 * PAD) - spanA * scale) / 2;
    const project = (p) => ({
      x: offX + (p[1] - minLng) * lngK * scale,
      y: offY + (maxLat - p[0]) * scale,
    });
    pts = geo.map(project);
    // Terminals are pinned to the route ends (its real geometry), and the
    // from/to names label those ends — so a mis-stored substation coordinate
    // can never drag the drawn route away from where it actually runs.
    fromXY = pts[0];
    toXY = pts[pts.length - 1];
    pinXY = pinPos ? project(pinPos) : midOf(pts);
    if (fromPos && toPos) {
      const pf = project(fromPos);
      const pt2 = project(toPos);
      const d = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
      const first = pts[0];
      const last = pts[pts.length - 1];
      const same = d(first, pf) + d(last, pt2);
      const swap = d(first, pt2) + d(last, pf);
      if (swap < same) {
        startName = to ? to.name : null;
        endName = from ? from.name : null;
      }
    }
  } else {
    pts = [{ x: W / 2, y: PAD }, { x: W / 2, y: H - PAD }];
    fromXY = pts[0];
    toXY = pts[1];
    pinXY = { x: W / 2, y: H / 2 };
  }

  const kv = line ? num(line.voltage_kv) : (sub ? maxVoltageKv(sub.voltage_levels) : null);
  const status = (line && line.operational_status) || (sub && sub.operational_status) || null;
  const color = entityColor(kv, status);
  const routeStr = pts.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ');

  const endLabel = (p, name, place) => {
    const text = name || '';
    if (!text) return null;
    const half = Math.max(20, (text.length * 6.2) / 2);
    const x = Math.min(W - half - 3, Math.max(half + 3, p.x));
    const top = place === 'top';
    const y = top ? Math.max(12, p.y - 12) : Math.min(H - 4, p.y + 17);
    return <text x={x} y={y} textAnchor="middle" fontSize="10.5" fontWeight="700" fill="#0f172a">{text}</text>;
  };

  const pinColor = '#dc2626';
  const label = pinName || '';
  const tw = label.length * 6.2 + 14;
  const th = 18;
  let bx = pinXY.x + 13;
  if (bx + tw > W - 4) bx = Math.max(4, pinXY.x - 13 - tw);
  const by = Math.min(H - th - 4, Math.max(4, pinXY.y - 30));

  const routeName = line && (line.name || line.line_id) ? (line.name || line.line_id) : null;
  const ends = from || to
    ? `${(from && from.name) || 'Start'} → ${(to && to.name) || 'End'}`
    : null;
  const rating = line
    ? [kv ? `${kv} kV` : null, line.line_type, line.length_km ? `${line.length_km} km` : null].filter(Boolean).join(' · ')
    : null;
  const pinDetail = tower
    ? [tower.tower_type, tower.height_m ? `${tower.height_m} m` : null, tower.km_marker != null ? `km ${tower.km_marker}` : null].filter(Boolean).join(' · ')
    : asset ? (asset.asset_type || null) : null;

  return (
    <figure className="target-map" style={{ margin: 0 }}>
      <svg viewBox={`0 0 ${W} ${H}`} width="100%" role="img" aria-label={pinName ? `Route map with ${pinName}` : 'Route map'} style={{ display: 'block' }}>
        <rect x="1" y="1" width={W - 2} height={H - 2} rx="10" fill="#f8fafc" stroke="#e2e8f0" />
        <polyline points={routeStr} fill="none" stroke="#ffffff" strokeWidth="12" strokeLinecap="round" strokeLinejoin="round" />
        <polyline points={routeStr} fill="none" stroke={color} strokeWidth="7" strokeLinecap="round" strokeLinejoin="round" />

        <circle cx={fromXY.x} cy={fromXY.y} r="6.5" fill="#ffffff" stroke={color} strokeWidth="2.6" />
        <circle cx={toXY.x} cy={toXY.y} r="6.5" fill="#ffffff" stroke={color} strokeWidth="2.6" />
        {endLabel(fromXY, startName, fromXY.y <= toXY.y ? 'top' : 'bottom')}
        {endLabel(toXY, endName, toXY.y <= fromXY.y ? 'top' : 'bottom')}

        {pinName && (
          <g>
            <line x1={pinXY.x} y1={pinXY.y - 9} x2={(bx > pinXY.x ? bx : bx + tw)} y2={by + th / 2} stroke="#cbd5e1" strokeWidth="1" strokeDasharray="2 2" />
            <rect x={bx} y={by} width={tw} height={th} rx="5" fill="#ffffff" stroke={pinColor} strokeWidth="1" />
            <text x={bx + 7} y={by + 12.5} fontSize="10.5" fontWeight="700" fill="#0f172a">{label}</text>
            <path d="M0 0 C-6.5 -8 -9 -12 -9 -17 A9 9 0 1 1 9 -17 C9 -12 6.5 -8 0 0 Z" transform={`translate(${pinXY.x},${pinXY.y})`} fill={pinColor} stroke="#ffffff" strokeWidth="1.6" />
            <circle cx={pinXY.x} cy={pinXY.y - 17} r="3.1" fill="#ffffff" />
          </g>
        )}
      </svg>
      <figcaption className="target-map-caption">
        {routeName && <div><b>{routeName}</b>{rating ? <> — {rating}</> : null}</div>}
        {ends && <div>{ends}</div>}
        {pinName && <div><b>{pinName}</b>{pinDetail ? <> — {pinDetail}</> : null}</div>}
      </figcaption>
    </figure>
  );
}
