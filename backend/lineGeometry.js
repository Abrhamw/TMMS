// Pure line-geometry helpers for the line map workspace. No DB access.
// Route coordinates are [lat, lng] pairs, matching transmission_line.route_json.
const { haversine } = require('./geo');

function haversineKm(aLat, aLng, bLat, bLng) {
  return haversine(aLat, aLng, bLat, bLng) / 1000;
}

function validRoute(route) {
  if (!Array.isArray(route) || route.length < 2) return null;
  const ok = route.every(
    (p) => Array.isArray(p) && p.length >= 2 && typeof p[0] === 'number' && typeof p[1] === 'number' && Number.isFinite(p[0]) && Number.isFinite(p[1])
  );
  return ok ? route : null;
}

// Cumulative segment lengths: returns { segments: [{ km, startKm }], totalKm }.
function routeSegments(route) {
  const segments = [];
  let totalKm = 0;
  for (let i = 1; i < route.length; i++) {
    const [aLat, aLng] = route[i - 1];
    const [bLat, bLng] = route[i];
    const km = haversineKm(aLat, aLng, bLat, bLng);
    segments.push({ km, startKm: totalKm, from: [aLat, aLng], to: [bLat, bLng] });
    totalKm += km;
  }
  return { segments, totalKm };
}

function distanceAlongRoute(route) {
  const valid = validRoute(route);
  if (!valid) return 0;
  return routeSegments(valid).totalKm;
}

// Interpolate the [lat, lng] at arc distance targetKm along the route.
function interpolate(route, targetKm) {
  if (!Array.isArray(route) || route.length === 0) return null;
  if (targetKm <= 0) return route[0].slice();
  const { segments, totalKm } = routeSegments(route);
  if (targetKm >= totalKm) return route[route.length - 1].slice();
  for (const seg of segments) {
    if (seg.startKm + seg.km >= targetKm && seg.km > 0) {
      const frac = (targetKm - seg.startKm) / seg.km;
      return [seg.from[0] + (seg.to[0] - seg.from[0]) * frac, seg.from[1] + (seg.to[1] - seg.from[1]) * frac];
    }
  }
  return route[route.length - 1].slice();
}

// Nearest point on the polyline to (lat, lng). Uses a local equirectangular
// projection in metres for the perpendicular-distance test, then reports the
// arc distance in km. Returns { km, snappedLat, snappedLng } or null.
function projectPointToRoute(route, lat, lng) {
  const valid = validRoute(route);
  if (!valid || typeof lat !== 'number' || typeof lng !== 'number' || !Number.isFinite(lat) || !Number.isFinite(lng)) {
    return null;
  }
  const mPerDegLat = 111320;
  const mPerDegLng = 111320 * Math.cos((lat * Math.PI) / 180);
  const px = lng * mPerDegLng;
  const py = lat * mPerDegLat;
  let best = null;
  let cum = 0;
  for (let i = 1; i < valid.length; i++) {
    const [aLat, aLng] = valid[i - 1];
    const [bLat, bLng] = valid[i];
    const ax = aLng * mPerDegLng;
    const ay = aLat * mPerDegLat;
    const bx = bLng * mPerDegLng;
    const by = bLat * mPerDegLat;
    const dx = bx - ax;
    const dy = by - ay;
    const len2 = dx * dx + dy * dy;
    let t = len2 > 0 ? ((px - ax) * dx + (py - ay) * dy) / len2 : 0;
    t = Math.max(0, Math.min(1, t));
    const cx = ax + dx * t;
    const cy = ay + dy * t;
    const dist = (px - cx) ** 2 + (py - cy) ** 2;
    if (!best || dist < best.dist) {
      best = { dist, km: cum + haversineKm(aLat, aLng, bLat, bLng) * t, lat: aLat + (bLat - aLat) * t, lng: aLng + (bLng - aLng) * t };
    }
    cum += haversineKm(aLat, aLng, bLat, bLng);
  }
  if (!best) return null;
  return { km: Math.round(best.km * 10) / 10, snappedLat: +best.lat.toFixed(6), snappedLng: +best.lng.toFixed(6) };
}

// Even arc-length points. `count` N includes both ends (N >= 2).
// `spacingKm` S emits 0, S, 2S ... plus one final point at the far end if the
// last step did not land on it. Returns [{ lat, lng, km }].
function spaceAlongRoute(route, opts) {
  const valid = validRoute(route);
  if (!valid) return [];
  const totalKm = distanceAlongRoute(valid);
  const out = [];
  const push = (km) => {
    const p = interpolate(valid, km);
    if (p) out.push({ lat: +p[0].toFixed(6), lng: +p[1].toFixed(6), km: Math.round(km * 10) / 10 });
  };
  if (opts && opts.count != null) {
    const n = Math.max(2, Math.min(500, Math.floor(Number(opts.count))));
    for (let i = 0; i < n; i++) push(totalKm * (i / (n - 1)));
    return out;
  }
  if (opts && opts.spacingKm != null) {
    const s = Number(opts.spacingKm);
    if (!(s > 0)) return [];
    const MAX_POINTS = 5000;
    for (let km = 0; km < totalKm - 1e-3 && out.length < MAX_POINTS; km += s) push(km);
    push(totalKm);
    return out;
  }
  return [];
}

module.exports = { haversineKm, distanceAlongRoute, projectPointToRoute, spaceAlongRoute, interpolate, routeSegments };
