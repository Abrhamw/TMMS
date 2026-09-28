// Shared geographic helpers: distances, polygons, point-in-polygon.

function haversine(aLat, aLng, bLat, bLng) {
  const R = 6371000;
  const dLat = ((bLat - aLat) * Math.PI) / 180;
  const dLng = ((bLng - aLng) * Math.PI) / 180;
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((aLat * Math.PI) / 180) * Math.cos((bLat * Math.PI) / 180) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(s), Math.sqrt(1 - s));
}

// Ray-casting point-in-polygon. Polygon is [[lat, lng], ...]. Returns boolean.
function pointInPolygon(lat, lng, polygon) {
  if (!Array.isArray(polygon) || polygon.length < 3) return false;
  let inside = false;
  let j = polygon.length - 1;
  for (let i = 0; i < polygon.length; i++) {
    const [yi, xi] = polygon[i];
    const [yj, xj] = polygon[j];
    const intersect =
      xi > lng !== xj > lng &&
      lat < ((yj - yi) * (lng - xi)) / (xj - xi || 1e-12) + yi;
    if (intersect) inside = !inside;
    j = i;
  }
  return inside;
}

// Build a regular polygon (clockwise) around a center point.
function polygonFromCenter(centerLat, centerLng, radiusM, sides = 14) {
  const mPerDegLat = 111320;
  const mPerDegLng = 111320 * Math.cos((centerLat * Math.PI) / 180);
  const pts = [];
  for (let i = 0; i < sides; i++) {
    const theta = (i / sides) * 2 * Math.PI;
    const dy = Math.cos(theta) * radiusM;
    const dx = Math.sin(theta) * radiusM;
    pts.push([
      Math.round((centerLat + dy / mPerDegLat) * 1e6) / 1e6,
      Math.round((centerLng + dx / mPerDegLng) * 1e6) / 1e6,
    ]);
  }
  pts.push(pts[0]);
  return pts;
}

// Whether a point lies within a boundary. boundary may be a polygon ([[lat,lng],...])
// or null; falls back to a circle of radiusM around (centerLat, centerLng).
function boundaryContains(boundary, centerLat, centerLng, lat, lng, radiusM = 200) {
  if (Array.isArray(boundary) && boundary.length >= 3) {
    return pointInPolygon(lat, lng, boundary);
  }
  return haversine(centerLat, centerLng, lat, lng) <= radiusM;
}

// Approximate polygon area in km^2 (shoelace on a local equirectangular projection).
function polygonAreaKm2(polygon) {
  if (!Array.isArray(polygon) || polygon.length < 3) return 0;
  const mPerDegLat = 111320;
  let sum = 0;
  for (let i = 0; i < polygon.length - 1; i++) {
    const [y1, x1] = polygon[i];
    const [y2, x2] = polygon[i + 1];
    const mPerDegLng = 111320 * Math.cos(((y1 + y2) / 2) * (Math.PI / 180));
    sum += (x2 * mPerDegLng - x1 * mPerDegLng) * (y1 * mPerDegLat + y2 * mPerDegLat);
  }
  return Math.abs(sum / 2) / 1e6;
}

module.exports = { haversine, pointInPolygon, polygonFromCenter, boundaryContains, polygonAreaKm2 };
