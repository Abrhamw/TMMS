'use strict';

const { db } = require('./db');

const RESOURCE_CATEGORIES = new Set([
  'VEHICLE', 'CRANE', 'BUCKET_TRUCK', 'LIFTING', 'GENERATOR', 'TEST_SET', 'RELAY_TEST_KIT',
  'TRANSFORMER_TEST', 'EARTH_TESTER', 'THERMAL_CAMERA', 'OTDR', 'PPE', 'TOOL', 'OTHER',
]);
const RESOURCE_STATUSES = new Set([
  'AVAILABLE', 'RESERVED', 'ON_TASK', 'MAINTENANCE', 'CALIBRATION_DUE', 'OUT_OF_SERVICE', 'LOST', 'RETIRED',
]);

// A resource in one of these states cannot be dispatched regardless of any
// reservation: it is either broken, missing or administratively withdrawn.
const UNUSABLE_STATUSES = new Set(['MAINTENANCE', 'CALIBRATION_DUE', 'OUT_OF_SERVICE', 'LOST', 'RETIRED']);

function isCalibrationDue(r, at) {
  if (!r || !r.calibration_expiry || !at) return false;
  const exp = Date.parse(r.calibration_expiry);
  const when = Date.parse(at);
  return Number.isFinite(exp) && Number.isFinite(when) && exp < when;
}

// The status a resource actually presents at an instant: an explicit terminal
// status always wins, otherwise a lapsed calibration schedule is reflected.
function effectiveStatus(r, at) {
  if (!r) return null;
  if (r.status === 'RETIRED' || r.status === 'LOST' || r.status === 'OUT_OF_SERVICE') return r.status;
  if (isCalibrationDue(r, at)) return 'CALIBRATION_DUE';
  return r.status;
}

function isUsable(r, at) {
  if (!r || r.active === 0) return false;
  return !UNUSABLE_STATUSES.has(effectiveStatus(r, at));
}

// Reservations are half-open [from, to): a booking ending when the next begins
// is not a conflict. Only live RESERVED rows compete for a resource.
function findConflicts(resourceId, from, to, excludeId) {
  if (!resourceId || !from || !to) return [];
  return db.prepare(
    `SELECT * FROM resource_reservation
     WHERE resource_id = ? AND status = 'RESERVED' AND id != ?
       AND reserved_from < ? AND reserved_to > ?
     ORDER BY reserved_from`
  ).all(resourceId, excludeId || 0, to, from);
}

function usageHours(usage = {}) {
  if (usage.operating_hours !== undefined && usage.operating_hours !== null && usage.operating_hours !== '') {
    const n = Number(usage.operating_hours);
    return Number.isFinite(n) && n > 0 ? n : 0;
  }
  const a = Date.parse(usage.started_at);
  const b = Date.parse(usage.ended_at);
  if (Number.isNaN(a) || Number.isNaN(b) || b < a) return 0;
  return Math.round(((b - a) / 3600000) * 100) / 100;
}

function usageCost(usage = {}, resource = null) {
  const rate = usage.cost_rate != null ? Number(usage.cost_rate) : (resource && resource.cost_rate != null ? Number(resource.cost_rate) : null);
  if (rate == null || !Number.isFinite(rate)) return null;
  const n = Math.round(usageHours(usage) * rate * 100) / 100;
  return Number.isFinite(n) ? n : null;
}

function round2(n) {
  return Math.round((Number(n) || 0) * 100) / 100;
}

// A task's resource picture: what was reserved, what was actually used and what
// it cost. Mirrors taskLaborSummary so the costing phase can add them together.
function taskResourceSummary(taskId, opts = {}) {
  const include = new Set(opts.include || ['APPROVED']);
  const reservations = db.prepare('SELECT * FROM resource_reservation WHERE task_id = ? ORDER BY reserved_from').all(taskId);
  const usages = db.prepare('SELECT * FROM resource_usage WHERE task_id = ? ORDER BY started_at, id').all(taskId);
  const counted = usages.filter((u) => include.has(u.status));
  let cost = 0;
  let hours = 0;
  const byResource = new Map();
  for (const u of counted) {
    cost += Number(u.cost) || 0;
    hours += Number(u.operating_hours) || 0;
    const cur = byResource.get(u.resource_id) || { resource_id: u.resource_id, operating_hours: 0, cost: 0, entries: 0 };
    cur.operating_hours += Number(u.operating_hours) || 0;
    cur.cost += Number(u.cost) || 0;
    cur.entries += 1;
    byResource.set(u.resource_id, cur);
  }
  return {
    task_id: Number(taskId),
    reservations: reservations.length,
    active_reservations: reservations.filter((r) => r.status === 'RESERVED').length,
    usage_entries: usages.length,
    counted_entries: counted.length,
    resource_hours: round2(hours),
    resource_cost: round2(cost),
    by_resource: [...byResource.values()].map((x) => ({ ...x, operating_hours: round2(x.operating_hours), cost: round2(x.cost) })),
  };
}

module.exports = {
  RESOURCE_CATEGORIES, RESOURCE_STATUSES, UNUSABLE_STATUSES,
  isCalibrationDue, effectiveStatus, isUsable, findConflicts, usageHours, usageCost, taskResourceSummary,
};
