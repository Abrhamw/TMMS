// A tile-free, fully static SVG map used by every printed/exported report and
// execution sheet. It draws the same geometry the interactive Leaflet view
// would — markers, routes, yards and radius perimeters — but as plain SVG, so
// nothing can overlap from stacked map panes, tile layers or zoom controls and
// the result is identical on screen and on paper.
//
// Labels are deliberately rationed: only "primary" markers (the work target and
// the infrastructure) are named, so a line with hundreds of tower dots never
// turns into a pile of overlapping captions.

const num = (v) => {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
};

function toLatLng(p) {
  if (!p) return null;
  if (Array.isArray(p)) {
    const lat = num(p[0]);
    const lng = num(p[1]);
    return lat != null && lng != null ? [lat, lng] : null;
  }
  const lat = num(p.lat);
  const lng = num(p.lng != null ? p.lng : p.lon);
  return lat != null && lng != null ? [lat, lng] : null;
}

function toList(points) {
  if (!Array.isArray(points)) return [];
  return points.map(toLatLng).filter(Boolean);
}

function circleRing(lat, lng, radiusM, steps = 40) {
  const r = num(radiusM);
  if (lat == null || lng == null || !(r > 0)) return [];
  const dLat = r / 111320;
  const dLng = r / (111320 * Math.max(0.1, Math.cos((lat * Math.PI) / 180)));
  const out = [];
  for (let i = 0; i < steps; i += 1) {
    const a = (i / steps) * Math.PI * 2;
    out.push([lat + dLat * Math.sin(a), lng + dLng * Math.cos(a)]);
  }
  return out;
}

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

export default function StaticMap({
  markers = [],
  polylines = [],
  polygons = [],
  circles = [],
  focus = null,
  radius = null,
  radiusLatLng = null,
  width = 320,
  height = 210,
  maxLabels = 14,
  ariaLabel = 'Location map',
}) {
  const W = width;
  const H = height;
  const PAD = 26;

  const markerPts = markers.map((m) => ({ m, at: toLatLng(m) })).filter((x) => x.at);
  const lineShapes = polylines
    .map((p) => ({ p, pts: toList(p.points) }))
    .filter((x) => x.pts.length >= 2);
  const polyShapes = polygons
    .map((p) => ({ p, pts: toList(p.points) }))
    .filter((x) => x.pts.length >= 3);
  const circleShapes = circles
    .map((c) => {
      const lat = num(c.lat);
      const lng = num(c.lng);
      const ring = lat != null && lng != null ? circleRing(lat, lng, c.radius) : [];
      return { c, at: [lat, lng], ring };
    })
    .filter((x) => x.ring.length >= 3);

  const all = [];
  markerPts.forEach((x) => all.push(x.at));
  lineShapes.forEach((x) => x.pts.forEach((pt) => all.push(pt)));
  polyShapes.forEach((x) => x.pts.forEach((pt) => all.push(pt)));
  circleShapes.forEach((x) => x.ring.forEach((pt) => all.push(pt)));

  const focusPts = toList(focus);
  // `focus` is a framing hint, never a hard clip: every drawn feature stays in
  // view so a long line route, a substation perimeter or a radius ring can
  // never be cropped off the edge of a printed report or a phone screen.
  const boundsPts = focusPts.length >= 2 ? focusPts.concat(all) : all;
  const hasGeometry = all.length > 0;

  if (!hasGeometry) return null;

  const lats = boundsPts.map((p) => p[0]);
  const lngs = boundsPts.map((p) => p[1]);
  let minLat = Math.min(...lats);
  let maxLat = Math.max(...lats);
  let minLng = Math.min(...lngs);
  let maxLng = Math.max(...lngs);
  const midLat = (minLat + maxLat) / 2;
  const lngK = Math.max(0.1, Math.cos((midLat * Math.PI) / 180));
  let spanA = (maxLat - minLat) || 1e-6;
  let spanB = (maxLng - minLng) * lngK || 1e-6;
  const innerW = W - 2 * PAD;
  const innerH = H - 2 * PAD;
  const scale = Math.min(innerW / spanB, innerH / spanA);
  const offX = PAD + (innerW - spanB * scale) / 2;
  const offY = PAD + (innerH - spanA * scale) / 2;
  const project = ([lat, lng]) => ({
    x: offX + (lng - minLng) * lngK * scale,
    y: offY + (maxLat - lat) * scale,
  });

  let labelCount = 0;
  // Boxes already occupied by a caption. Overlapping labels are what made dense
  // tower/substation maps unreadable, so each candidate is tried in a few spots
  // and dropped rather than drawn on top of an existing caption.
  const placed = [];
  const overlaps = (a, b) => a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
  const labelFor = (m, at) => {
    const name = m.label;
    if (!name || labelCount >= maxLabels) return null;
    const primary = m.flash || m.pulse || (num(m.radius) || 0) >= 7;
    if (!primary && !m.alwaysLabel) return null;
    const p = project(at);
    const text = String(name);
    const tw = Math.min(W - 8, text.length * 6.2 + 10);
    const th = 15;
    let bx = p.x + 10;
    if (bx + tw > W - 4) bx = Math.max(4, p.x - 10 - tw);
    const candidates = [
      clamp(p.y - 9, 4, H - 18),      // above, right
      clamp(p.y + 4, 4, H - 18),      // below
    ];
    let chosen = null;
    for (const by of candidates) {
      const box = { x: bx, y: by, w: tw, h: th };
      if (!placed.some((q) => overlaps(box, q))) { chosen = box; break; }
    }
    if (!chosen) return null;
    placed.push(chosen);
    labelCount += 1;
    return (
      <g key={`lbl-${text}-${labelCount}`}>
        <rect x={chosen.x} y={chosen.y} width={tw} height={th} rx="3.5" fill="#ffffff" stroke="#cbd5e1" strokeWidth="0.7" opacity="0.96" />
        <text x={chosen.x + 5} y={chosen.y + 11} fontSize="10" fontWeight="700" fill="#0f172a">{text}</text>
      </g>
    );
  };

  return (
    <svg viewBox={`0 0 ${W} ${H}`} width="100%" role="img" aria-label={ariaLabel} style={{ display: 'block', maxWidth: '100%' }}>
      <defs>
        <pattern id="sm-grid" width="28" height="28" patternUnits="userSpaceOnUse">
          <path d="M28 0H0V28" fill="none" stroke="#eef2f7" strokeWidth="1" />
        </pattern>
      </defs>
      <rect x="1" y="1" width={W - 2} height={H - 2} rx="10" fill="#f8fafc" stroke="#e2e8f0" />
      <rect x="1" y="1" width={W - 2} height={H - 2} rx="10" fill="url(#sm-grid)" />

      {polyShapes.map(({ p, pts }, i) => (
        <polygon
          key={`poly-${i}`}
          points={pts.map(project).map((q) => `${q.x.toFixed(1)},${q.y.toFixed(1)}`).join(' ')}
          fill={p.color || '#2563eb'}
          fillOpacity={p.fillOpacity ?? 0.08}
          stroke={p.color || '#2563eb'}
          strokeWidth={p.weight || 1.8}
        />
      ))}

      {circleShapes.map(({ c, ring }, i) => (
        <polygon
          key={`circle-${i}`}
          points={ring.map(project).map((q) => `${q.x.toFixed(1)},${q.y.toFixed(1)}`).join(' ')}
          fill={c.color || '#2563eb'}
          fillOpacity={c.fillOpacity ?? 0.06}
          stroke={c.color || '#2563eb'}
          strokeWidth={c.weight || 1.6}
          strokeDasharray={c.dashArray || '5 4'}
        />
      ))}

      {radius > 0 && radiusLatLng
        ? (() => {
          const ring = circleRing(num(radiusLatLng.lat), num(radiusLatLng.lng), radius);
          if (ring.length < 3) return null;
          return (
            <polygon
              points={ring.map(project).map((q) => `${q.x.toFixed(1)},${q.y.toFixed(1)}`).join(' ')}
              fill="#2563eb"
              fillOpacity="0.06"
              stroke="#2563eb"
              strokeWidth="1.6"
              strokeDasharray="5 4"
            />
          );
        })()
        : null}

      {lineShapes.map(({ p, pts }, i) => {
        const coords = pts.map(project).map((q) => `${q.x.toFixed(1)},${q.y.toFixed(1)}`).join(' ');
        const w = p.weight || 4;
        return (
          <g key={`line-${i}`}>
            <polyline points={coords} fill="none" stroke="#ffffff" strokeWidth={w + 5} strokeLinecap="round" strokeLinejoin="round" />
            <polyline
              points={coords}
              fill="none"
              stroke={p.color || '#b45309'}
              strokeWidth={w}
              strokeDasharray={p.dashArray || null}
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </g>
        );
      })}

      {markerPts.map(({ m, at }, i) => {
        const p = project(at);
        const color = m.color || '#14532d';
        const r = num(m.radius) || 6;
        return (
          <g key={`marker-${i}`}>
            <circle cx={p.x} cy={p.y} r={r} fill={color} stroke="#ffffff" strokeWidth="1.6" />
          </g>
        );
      })}

      {markerPts.map(({ m, at }) => labelFor(m, at))}
    </svg>
  );
}
