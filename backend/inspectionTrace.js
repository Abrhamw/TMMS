// Pure inspection-trace helpers. No DB access, no Express.
const { distanceAlongRoute, interpolate } = require('./lineGeometry');

const MAX_POINTS = 500;

function validatePoints(points) {
  if (!Array.isArray(points) || points.length < 1 || points.length > MAX_POINTS) {
    throw new Error(`points must be an array of 1..${MAX_POINTS} entries`);
  }
  return points.map((p, i) => {
    const n = i + 1;
    if (!p || typeof p !== 'object') throw new Error(`point ${n} is invalid`);
    if (p.lat == null || p.lat === '' || p.lng == null || p.lng === '') {
      throw new Error(`point ${n}: lat and lng are required`);
    }
    const lat = Number(p.lat);
    const lng = Number(p.lng);
    if (!Number.isFinite(lat) || lat < -90 || lat > 90) throw new Error(`point ${n}: lat must be -90..90`);
    if (!Number.isFinite(lng) || lng < -180 || lng > 180) throw new Error(`point ${n}: lng must be -180..180`);
    let accuracy_m = null;
    if (p.accuracy_m != null && p.accuracy_m !== '') {
      const a = Number(p.accuracy_m);
      if (!Number.isFinite(a) || a < 0) throw new Error(`point ${n}: accuracy_m must be >= 0`);
      accuracy_m = a;
    }
    let recorded_at = null;
    if (p.recorded_at != null && p.recorded_at !== '') {
      const d = new Date(p.recorded_at);
      if (Number.isNaN(d.getTime())) throw new Error(`point ${n}: recorded_at must be an ISO date`);
      recorded_at = d.toISOString();
    }
    return { lat, lng, accuracy_m, recorded_at };
  });
}

function emptyCoverage(lineId) {
  return {
    line_id: lineId, total_towers: 0, inspected_towers: 0, tower_progress: 0,
    total_km: 0, inspected_km: 0, km_progress: 0,
    covered_spans: [], covered_paths: [], inspected_tower_ids: [], trace_task_ids: [],
  };
}

function pathForSpan(route, fromKm, toKm) {
  const n = Math.max(2, Math.min(100, Math.ceil(toKm - fromKm) * 2 || 2));
  const pts = [];
  for (let i = 0; i <= n; i++) {
    const p = interpolate(route, fromKm + ((toKm - fromKm) * i) / n);
    if (p) pts.push([+p[0].toFixed(6), +p[1].toFixed(6)]);
  }
  return pts;
}

function coverage({ lineId, route, towers, tasks, traceTaskIds }) {
  const out = emptyCoverage(lineId);
  const ordered = [...(towers || [])].sort(
    (a, b) => (Number(a.km_marker) || 0) - (Number(b.km_marker) || 0) || a.id - b.id
  );
  out.total_towers = ordered.length;
  const list = tasks || [];
  const lineComplete = list.some((t) => t.status === 'COMPLETED' && t.tower_id == null);
  const completedTowers = new Set(
    list.filter((t) => t.status === 'COMPLETED' && t.tower_id != null).map((t) => Number(t.tower_id))
  );
  const inspected = new Set();
  for (const tw of ordered) {
    if (lineComplete || completedTowers.has(Number(tw.id))) inspected.add(tw.id);
  }
  out.inspected_tower_ids = ordered.filter((tw) => inspected.has(tw.id)).map((tw) => tw.id);
  out.inspected_towers = out.inspected_tower_ids.length;
  out.tower_progress = out.total_towers ? out.inspected_towers / out.total_towers : 0;
  out.trace_task_ids = [...new Set(traceTaskIds || [])];

  const validRoute = Array.isArray(route) && route.length >= 2;
  out.total_km = validRoute ? distanceAlongRoute(route) : 0;

  let spans = [];
  if (lineComplete && validRoute) {
    spans = [[0, out.total_km]];
  } else {
    for (let i = 0; i < ordered.length - 1; i++) {
      const a = ordered[i];
      const b = ordered[i + 1];
      if (!inspected.has(a.id) || !inspected.has(b.id)) continue;
      const ka = Number(a.km_marker) || 0;
      const kb = Number(b.km_marker) || 0;
      if (kb > ka) spans.push([ka, kb]);
    }
    const merged = [];
    for (const s of spans) {
      const last = merged[merged.length - 1];
      if (last && Math.abs(s[0] - last[1]) < 1e-6) last[1] = s[1];
      else merged.push([s[0], s[1]]);
    }
    spans = merged;
  }
  out.covered_spans = spans.map(([a, b]) => [Math.round(a * 10) / 10, Math.round(b * 10) / 10]);
  const rawInspectedKm = spans.reduce((sum, [a, b]) => sum + (b - a), 0);
  out.inspected_km = Math.round(rawInspectedKm * 10) / 10;
  out.km_progress = lineComplete && validRoute
    ? 1
    : (out.total_km ? Math.min(1, rawInspectedKm / out.total_km) : 0);
  out.covered_paths = validRoute ? spans.map(([a, b]) => pathForSpan(route, a, b)) : [];
  return out;
}

module.exports = { validatePoints, coverage };
