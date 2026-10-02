const { db } = require('./util');
const { coverage } = require('./inspectionTrace');

function lineCoverageFor(lineId, route) {
  const towers = db.prepare('SELECT id, km_marker, latitude, longitude FROM tower WHERE line_id = ? ORDER BY km_marker, id').all(lineId);
  const tasks = db.prepare('SELECT id, status, tower_id, tower_from_id, tower_to_id FROM task WHERE line_id = ? OR tower_id IN (SELECT id FROM tower WHERE line_id = ?)').all(lineId, lineId);
  const traceTaskIds = db.prepare('SELECT DISTINCT task_id FROM inspection_trace_point WHERE line_id = ?').all(lineId).map((r) => r.task_id);
  return coverage({ lineId, route, towers, tasks, traceTaskIds });
}

function tracePointsForLine(lineId) {
  return db.prepare('SELECT lat, lng, km, accuracy_m, recorded_at FROM inspection_trace_point WHERE line_id = ? ORDER BY recorded_at, id').all(lineId);
}

function inspectionForLine(lineId, route) {
  return { ...lineCoverageFor(lineId, route), trace_points: tracePointsForLine(lineId) };
}

module.exports = { lineCoverageFor, tracePointsForLine, inspectionForLine };
