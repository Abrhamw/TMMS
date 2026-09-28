// Shared geofence / boundary / violation evaluation used by GPS validation and
// checklist GPS confirmation.

const { list, get } = require('./util');
const { haversine, pointInPolygon } = require('./geo');
const { projectPointToRoute } = require('./lineGeometry');

const TOLERANCE = { REGION: 1000, SUBSTATION: 500, LINE: 500, TOWER: 500, ASSET: 500 };

// A fence boundary can be stored as a JSON array of [lat,lng] pairs, an array
// of {lat,lng} objects, or a GeoJSON Polygon. Normalise to [lat,lng] pairs.
function asPolygon(value) {
  if (!value) return null;
  let poly = value;
  if (typeof poly === 'string') {
    try { poly = JSON.parse(poly); } catch (_) { return null; }
  }
  if (poly && poly.type === 'Polygon' && Array.isArray(poly.coordinates)) poly = poly.coordinates[0];
  if (poly && poly.type === 'Feature' && poly.geometry) return asPolygon(poly.geometry);
  if (!Array.isArray(poly) || poly.length < 3) return null;
  const out = [];
  for (const p of poly) {
    if (Array.isArray(p) && p.length >= 2) out.push([Number(p[0]), Number(p[1])]);
    else if (p && typeof p === 'object' && p.lat != null && p.lng != null) out.push([Number(p.lat), Number(p.lng)]);
    else return null;
  }
  return out.length >= 3 ? out : null;
}

function targetRegion(targetType, targetId) {
  if (targetType === 'ASSET') {
    const a = get('asset', Number(targetId));
    if (!a) return null;
    if (a.substation_id) return get('substation', a.substation_id)?.region_id ?? null;
    if (a.line_id) return get('transmission_line', a.line_id)?.region_id ?? null;
    if (a.tower_id) { const t = get('tower', a.tower_id); return t ? get('transmission_line', t.line_id)?.region_id ?? null : null; }
    return null;
  }
  if (targetType === 'SUBSTATION') return get('substation', Number(targetId))?.region_id ?? null;
  if (targetType === 'TOWER') { const t = get('tower', Number(targetId)); return t ? get('transmission_line', t.line_id)?.region_id ?? null : null; }
  if (targetType === 'LINE') return get('transmission_line', Number(targetId))?.region_id ?? null;
  return null;
}

// Region boundary: polygon if boundary_json exists, else radius fallback.
function regionBoundaryContains(regionId, lat, lng) {
  const region = regionId ? get('region', regionId, ['boundary_json']) : null;
  if (!region) return null;
  if (Array.isArray(region.boundary_json) && region.boundary_json.length >= 3) {
    return pointInPolygon(lat, lng, region.boundary_json);
  }
  return haversine(region.center_lat, region.center_lng, lat, lng) <= (region.boundary || 1.5) * 111320;
}

// Substation yard boundary: polygon if boundary_json exists, else radius fallback.
function substationBoundaryContains(substationId, lat, lng) {
  const s = substationId ? get('substation', substationId, ['boundary_json']) : null;
  if (!s) return null;
  if (Array.isArray(s.boundary_json) && s.boundary_json.length >= 3) {
    return pointInPolygon(lat, lng, s.boundary_json);
  }
  return haversine(s.latitude, s.longitude, lat, lng) <= (s.fence_radius_m || 220);
}

// Lines a LINE-type fence (or region-wide LINE fence) should test against.
function fenceLines(fence) {
  if (fence.target_id != null) {
    const line = get('transmission_line', fence.target_id, ['route_json']);
    return line ? [line] : [];
  }
  const all = list('transmission_line', ['route_json']);
  return fence.region_id != null ? all.filter((l) => l.region_id === fence.region_id) : all;
}

// Metres from a point to the closest transmission-line route, or null.
function lineCorridorDistance(fence, lat, lng) {
  let best = null;
  for (const line of fenceLines(fence)) {
    const p = projectPointToRoute(line.route_json, lat, lng);
    if (!p) continue;
    const d = haversine(p.snappedLat, p.snappedLng, lat, lng);
    if (best === null || d < best) best = d;
  }
  return best;
}

// True when a point falls inside a fence. Polygon boundary wins; LINE fences use
// the route corridor when a route is available; otherwise circle containment.
function fenceContains(fence, lat, lng) {
  const poly = asPolygon(fence.boundary_json);
  if (poly) return pointInPolygon(lat, lng, poly);
  if (fence.target_type === 'LINE') {
    const d = lineCorridorDistance(fence, lat, lng);
    if (d !== null) return d <= fence.radius_m;
  }
  return haversine(fence.center_lat, fence.center_lng, lat, lng) <= fence.radius_m;
}

// Distance in metres from a point to the nearest polygon edge.
function pointToPolygonMeters(poly, lat, lng) {
  const ring = poly.concat([poly[0]]);
  const p = projectPointToRoute(ring, lat, lng);
  return p ? haversine(p.snappedLat, p.snappedLng, lat, lng) : null;
}

// Signed distance to a fence edge in metres (negative = inside), best effort.
function fenceMargin(fence, lat, lng) {
  const poly = asPolygon(fence.boundary_json);
  if (poly) {
    const d = pointToPolygonMeters(poly, lat, lng);
    if (d == null) return Infinity;
    return pointInPolygon(lat, lng, poly) ? -d : d;
  }
  if (fence.target_type === 'LINE') {
    const d = lineCorridorDistance(fence, lat, lng);
    if (d !== null) return d - fence.radius_m;
  }
  return haversine(fence.center_lat, fence.center_lng, lat, lng) - fence.radius_m;
}

// Geofences that apply to a target: matching target type with no target filter
// or the exact target, plus area-wide REGION fences. Region-bound fences only
// apply to targets inside the same region; global fences apply everywhere.
function applicableGeofences(targetType, targetId, regionId) {
  return list('geofence', ['boundary_json']).filter((f) => {
    if (f.is_active !== 1) return false;
    if (f.region_id != null && (regionId == null || f.region_id !== regionId)) return false;
    if (f.target_type === 'REGION') return true;
    if (f.target_type !== targetType) return false;
    return f.target_id == null || Number(f.target_id) === Number(targetId);
  });
}

// Evaluate every applicable fence. Returns { applicable, inside, fenceId }.
// `inside` is true/false when fences apply, null when none do.
function evaluateGeofence(lat, lng, targetType, targetId, regionId) {
  const fences = applicableGeofences(targetType, targetId, regionId);
  if (fences.length === 0) return { applicable: 0, inside: null, fenceId: null };
  for (const fence of fences) {
    if (fenceContains(fence, lat, lng)) return { applicable: fences.length, inside: true, fenceId: fence.id };
  }
  let nearest = fences[0];
  let best = Infinity;
  for (const fence of fences) {
    const m = fenceMargin(fence, lat, lng);
    if (m < best) { best = m; nearest = fence; }
  }
  return { applicable: fences.length, inside: false, fenceId: nearest.id };
}

// Returns true/false when at least one geofence applies, else null.
function insideAnyGeofence(lat, lng, targetType, targetId, regionId) {
  return evaluateGeofence(lat, lng, targetType, targetId, regionId).inside;
}

// Combine boundary + geofence checks into a single violation assessment.
function evaluateViolation({ targetType, targetId, regionId, measuredLat, measuredLng, distance, tolerance }) {
  const inRegion = regionBoundaryContains(regionId, measuredLat, measuredLng);
  const inSubstation = targetType === 'SUBSTATION' ? substationBoundaryContains(targetId, measuredLat, measuredLng) : null;
  const gf = evaluateGeofence(measuredLat, measuredLng, targetType, targetId, regionId);
  let violation = null;
  if (inRegion === false) violation = 'OUTSIDE_REGION_BOUNDARY';
  else if (inSubstation === false) violation = 'OUTSIDE_SUBSTATION_BOUNDARY';
  else if (gf.inside === false) violation = 'OUTSIDE_GEOFENCE';
  else if (distance !== null && distance !== undefined && distance > tolerance) violation = 'OUT_OF_TOLERANCE';
  return { inRegion, inSubstation, inGeofence: gf.inside, geofenceId: gf.fenceId, applicableFences: gf.applicable, violation };
}

const flag = (v) => (v === null ? null : v ? 1 : 0);

module.exports = {
  TOLERANCE,
  asPolygon,
  targetRegion,
  regionBoundaryContains,
  substationBoundaryContains,
  applicableGeofences,
  evaluateGeofence,
  insideAnyGeofence,
  evaluateViolation,
  flag,
};
