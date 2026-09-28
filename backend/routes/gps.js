const express = require('express');
const { db, list, get, insertRow, updateRow } = require('../util');
const { haversine } = require('../geo');
const { can, audit } = require('../auth');
const { commandScope } = require('../authority');
const {
  TOLERANCE, targetRegion, evaluateViolation, asPolygon, flag,
} = require('../geofence');

const router = express.Router();

// A validation needs manual review when it failed or triggered any violation.
function reviewStatusFor(result, violation) {
  return violation || result === 'FAIL' ? 'OPEN' : 'NOT_REQUIRED';
}

function targetInScope(scope, targetType, targetId) {
  if (scope.global) return true;
  const id = Number(targetId);
  if (targetType === 'ASSET') return scope.assetIds.has(id);
  if (targetType === 'SUBSTATION') return scope.substationIds.has(id);
  if (targetType === 'LINE') return scope.lineIds.has(id);
  if (targetType === 'TOWER') return scope.towerIds.has(id);
  return false;
}

// ---- Geographic boundary / geofence checks ---------------------------------

router.get('/gps-validations', (req, res) => {
  const scope = commandScope(req.user);
  let rows = list('gps_validation').filter((v) => scope.global || scope.validationIds.has(v.id));
  const { result, target_type, region_id, q } = req.query;
  if (result) rows = rows.filter((v) => v.result === result);
  if (target_type) rows = rows.filter((v) => v.target_type === target_type);
  if (region_id) rows = rows.filter((v) => v.region_id === Number(region_id));
  for (const v of rows) {
    v.region = get('region', v.region_id);
    v.validator = v.validated_by ? get('person', v.validated_by) : null;
    if (v.target_type === 'ASSET') v.target = get('asset', v.target_id);
    if (v.target_type === 'SUBSTATION') v.target = get('substation', v.target_id);
    if (v.target_type === 'LINE') v.target = get('transmission_line', v.target_id);
    if (v.target_type === 'TOWER') v.target = get('tower', v.target_id);
  }
  if (q) rows = rows.filter((v) => v.target && String(v.target.name || v.target.substation_id || v.target.line_id || '').toLowerCase().includes(String(q).toLowerCase()));
  res.json(rows);
});

router.post('/gps-validations', (req, res) => {
  if (!can(req, 'gps:write')) return res.status(403).json({ error: 'Forbidden: requires gps:write' });
  const body = req.body;
  const region = targetRegion(body.target_type, body.target_id);
  if (!region) return res.status(404).json({ error: 'Target not found' });
  if (!targetInScope(commandScope(req.user), body.target_type, body.target_id)) return res.status(403).json({ error: 'Forbidden: target is outside your command scope' });
  const tolerance = body.tolerance_m || TOLERANCE[body.target_type] || 50;
  const distance = haversine(Number(body.expected_lat), Number(body.expected_lng), Number(body.measured_lat), Number(body.measured_lng));
  const result = distance <= tolerance ? 'PASS' : 'FAIL';
  const now = new Date().toISOString();
  const ev = evaluateViolation({
    targetType: body.target_type, targetId: body.target_id, regionId: region,
    measuredLat: Number(body.measured_lat), measuredLng: Number(body.measured_lng),
    distance, tolerance,
  });
  const id = insertRow('gps_validation', {
    ...body,
    region_id: body.region_id || region,
    distance_m: Math.round(distance),
    tolerance_m: tolerance,
    result,
    inside_geofence: flag(ev.inGeofence),
    in_region_boundary: flag(ev.inRegion),
    violation: ev.violation,
    geofence_id: ev.geofenceId,
    review_status: reviewStatusFor(result, ev.violation),
    validated_at: body.validated_at || now,
  });
  updateTargetFlag(body.target_type, body.target_id, !ev.violation && result === 'PASS' ? 1 : 0, now);
  audit(req.user, 'CREATE', 'gps_validation', id, { result, distance_m: Math.round(distance), violation: ev.violation });
  res.status(201).json(get('gps_validation', id));
});

function updateTargetFlag(targetType, targetId, valid, now) {
  try {
    if (targetType === 'ASSET') updateRow('asset', targetId, { gps_validated: valid, last_gps_validation_at: now });
    if (targetType === 'SUBSTATION') updateRow('substation', targetId, { gps_validated: valid, last_gps_validation_at: now });
    if (targetType === 'TOWER') {
      updateRow('tower', targetId, { gps_validated: valid });
      db.prepare('UPDATE asset SET gps_validated = ?, last_gps_validation_at = ? WHERE tower_id = ?').run(valid, now, targetId);
    }
    if (targetType === 'LINE') updateRow('transmission_line', targetId, { gps_validated: valid });
  } catch (_) {
    /* ignore */
  }
}

router.post('/gps-validations/bulk', (req, res) => {
  if (!can(req, 'gps:write')) return res.status(403).json({ error: 'Forbidden: requires gps:write' });
  const records = req.body.records || [];
  const now = new Date().toISOString();
  const created = [];
  for (const b of records) {
    const region = targetRegion(b.target_type, b.target_id);
    if (!region) return res.status(404).json({ error: 'Target not found' });
    if (!targetInScope(commandScope(req.user), b.target_type, b.target_id)) return res.status(403).json({ error: 'Forbidden: target is outside your command scope' });
    const tolerance = b.tolerance_m || TOLERANCE[b.target_type] || 50;
    const distance = haversine(Number(b.expected_lat), Number(b.expected_lng), Number(b.measured_lat), Number(b.measured_lng));
    const result = distance <= tolerance ? 'PASS' : 'FAIL';
    const ev = evaluateViolation({
      targetType: b.target_type, targetId: b.target_id, regionId: region,
      measuredLat: Number(b.measured_lat), measuredLng: Number(b.measured_lng),
      distance, tolerance,
    });
    const id = insertRow('gps_validation', {
      ...b,
      region_id: b.region_id || region,
      distance_m: Math.round(distance),
      tolerance_m: tolerance,
      result,
      inside_geofence: flag(ev.inGeofence),
      in_region_boundary: flag(ev.inRegion),
      violation: ev.violation,
      geofence_id: ev.geofenceId,
      review_status: reviewStatusFor(result, ev.violation),
      validated_at: b.validated_at || now,
    });
    updateTargetFlag(b.target_type, b.target_id, !ev.violation && result === 'PASS' ? 1 : 0, now);
    created.push(get('gps_validation', id));
  }
  audit(req.user, 'BULK_CREATE', 'gps_validation', null, { count: created.length });
  res.status(201).json({ created: created.length, records: created });
});

// Dry-run assessment for the capture form: computes distance, boundary and
// geofence outcome without persisting anything so the UI can give live feedback
// using exactly the same logic the server applies on save.
router.post('/gps-validations/preview', (req, res) => {
  if (!can(req, 'gps:read')) return res.status(403).json({ error: 'Forbidden: requires gps:read' });
  const body = req.body || {};
  const region = targetRegion(body.target_type, body.target_id);
  if (!region) return res.status(404).json({ error: 'Target not found' });
  if (!targetInScope(commandScope(req.user), body.target_type, body.target_id)) return res.status(403).json({ error: 'Forbidden: target is outside your command scope' });
  const tolerance = Number(body.tolerance_m) || TOLERANCE[body.target_type] || 50;
  const expectedLat = Number(body.expected_lat);
  const expectedLng = Number(body.expected_lng);
  const measuredLat = Number(body.measured_lat);
  const measuredLng = Number(body.measured_lng);
  if (![expectedLat, expectedLng, measuredLat, measuredLng].every(Number.isFinite)) {
    return res.status(400).json({ error: 'expected_lat/lng and measured_lat/lng must be numbers' });
  }
  const distance = haversine(expectedLat, expectedLng, measuredLat, measuredLng);
  const ev = evaluateViolation({
    targetType: body.target_type, targetId: body.target_id, regionId: region,
    measuredLat, measuredLng, distance, tolerance,
  });
  const matched = ev.geofenceId ? get('geofence', ev.geofenceId, ['boundary_json']) : null;
  res.json({
    region_id: region,
    distance_m: Math.round(distance),
    tolerance_m: tolerance,
    within_tolerance: distance <= tolerance,
    in_region: ev.inRegion,
    in_substation: ev.inSubstation,
    in_geofence: ev.inGeofence,
    applicable_fences: ev.applicableFences,
    matched_fence: matched ? { id: matched.id, name: matched.name, target_type: matched.target_type } : null,
    violation: ev.violation,
    will_validate: !ev.violation && distance <= tolerance,
  });
});

// Coordinate correction: re-survey corrected coordinate -> new validation + update target coords
router.post('/gps-validations/correct', (req, res) => {
  if (!can(req, 'gps:write')) return res.status(403).json({ error: 'Forbidden: requires gps:write' });
  const { target_type, target_id, new_lat, new_lng, validated_by } = req.body;
  const region = targetRegion(target_type, target_id);
  if (!targetInScope(commandScope(req.user), target_type, target_id)) return res.status(403).json({ error: 'Forbidden: target is outside your command scope' });
  let target;
  if (target_type === 'ASSET') target = get('asset', Number(target_id));
  if (target_type === 'SUBSTATION') target = get('substation', Number(target_id));
  if (target_type === 'TOWER') target = get('tower', Number(target_id));
  if (!target) return res.status(404).json({ error: 'Target not found' });
  const ev = evaluateViolation({
    targetType: target_type, targetId: target.id, regionId: region || target.region_id,
    measuredLat: Number(new_lat), measuredLng: Number(new_lng),
  });
  const id = insertRow('gps_validation', {
    target_type,
    target_id: target.id,
    region_id: region || target.region_id,
    expected_lat: target.latitude,
    expected_lng: target.longitude,
    measured_lat: Number(new_lat),
    measured_lng: Number(new_lng),
    accuracy_m: 3,
    distance_m: Math.round(haversine(target.latitude, target.longitude, Number(new_lat), Number(new_lng))),
    tolerance_m: TOLERANCE[target_type] || 50,
    result: 'MANUAL_REVIEW',
    inside_geofence: flag(ev.inGeofence),
    in_region_boundary: flag(ev.inRegion),
    violation: ev.violation,
    geofence_id: ev.geofenceId,
    review_status: ev.violation ? 'OPEN' : 'REVIEWED',
    validation_method: 'SURVEY',
    validated_by: validated_by || null,
    validated_at: new Date().toISOString(),
    notes: 'Coordinate correction applied from survey',
  });
  updateRow(target_type === 'ASSET' ? 'asset' : target_type === 'SUBSTATION' ? 'substation' : 'tower', target.id, {
    latitude: Number(new_lat),
    longitude: Number(new_lng),
    gps_validated: ev.violation ? 0 : 1,
    revision: 1,
  });
  res.json({ ok: true, validation_id: id });
});

// Geofences
const GEOFENCE_TARGETS = new Set(['REGION', 'SUBSTATION', 'LINE', 'TOWER', 'ASSET']);

function scopeRegionContains(scope, regionId) {
  if (scope.global) return true;
  return regionId != null && scope.regionIds.has(Number(regionId));
}

// Derive a bounding centre + radius for a polygon so the NOT NULL centre/radius
// columns stay valid and the circle fallback is sensible.
function polygonCircle(poly) {
  let lat = 0;
  let lng = 0;
  for (const [a, b] of poly) { lat += a; lng += b; }
  lat /= poly.length;
  lng /= poly.length;
  let radius = 0;
  for (const [a, b] of poly) {
    const d = haversine(lat, lng, a, b);
    if (d > radius) radius = d;
  }
  return { center_lat: lat, center_lng: lng, radius_m: Math.max(1, Math.round(radius)) };
}

// Validates a geofence payload. `partial` allows PUT to send only the changed
// fields; POST requires either a circle (centre + radius) or a polygon.
function geofenceFields(body, { partial = false } = {}) {
  const errors = [];
  const out = {};
  if (!partial || body.name !== undefined) {
    const name = String(body.name ?? '').trim();
    if (!name) errors.push('name is required');
    else out.name = name;
  }
  if (!partial || body.target_type !== undefined) {
    const tt = String(body.target_type ?? '').toUpperCase();
    if (!GEOFENCE_TARGETS.has(tt)) errors.push('target_type must be one of REGION, SUBSTATION, LINE, TOWER, ASSET');
    else out.target_type = tt;
  }
  if (body.target_id !== undefined) {
    if (body.target_id === null || body.target_id === '') out.target_id = null;
    else {
      const tid = Number(body.target_id);
      if (!Number.isFinite(tid)) errors.push('target_id must be a number or null');
      else out.target_id = tid;
    }
  }
  if (body.boundary_json !== undefined) {
    if (body.boundary_json === null || body.boundary_json === '') out.boundary_json = null;
    else {
      const poly = asPolygon(body.boundary_json);
      if (!poly) errors.push('boundary_json must be a polygon with at least 3 [lat,lng] points');
      else out.boundary_json = JSON.stringify(poly);
    }
  }
  const hasBoundary = out.boundary_json != null;
  const centerProvided = body.center_lat !== undefined || body.center_lng !== undefined;
  if (centerProvided || (!partial && !hasBoundary)) {
    const lat = Number(body.center_lat);
    const lng = Number(body.center_lng);
    if (!Number.isFinite(lat) || lat < -90 || lat > 90) errors.push('center_lat must be a number between -90 and 90');
    else out.center_lat = lat;
    if (!Number.isFinite(lng) || lng < -180 || lng > 180) errors.push('center_lng must be a number between -180 and 180');
    else out.center_lng = lng;
  }
  if (body.radius_m !== undefined || (!partial && !hasBoundary)) {
    const r = Number(body.radius_m);
    if (!Number.isFinite(r) || r <= 0) errors.push('radius_m must be a positive number');
    else out.radius_m = r;
  }
  if (hasBoundary) {
    const needCenter = out.center_lat === undefined || out.center_lng === undefined;
    const needRadius = out.radius_m === undefined;
    if (needCenter || needRadius) {
      const c = polygonCircle(JSON.parse(out.boundary_json));
      if (needCenter) { out.center_lat = c.center_lat; out.center_lng = c.center_lng; }
      if (needRadius) out.radius_m = c.radius_m;
    }
  }
  if (body.tolerance_m !== undefined) {
    const t = Number(body.tolerance_m);
    if (!Number.isFinite(t) || t < 0) errors.push('tolerance_m must be zero or a positive number');
    else out.tolerance_m = t;
  }
  if (body.is_active !== undefined) out.is_active = body.is_active ? 1 : 0;
  if (body.region_id !== undefined) {
    if (body.region_id === null || body.region_id === '') out.region_id = null;
    else {
      const rid = Number(body.region_id);
      if (!Number.isFinite(rid)) errors.push('region_id must be a number or null');
      else out.region_id = rid;
    }
  }
  return { errors, out };
}

// A fence tied to a single target must reference a real target and may not be a
// REGION fence. Returns an error string or null.
function fenceTargetError(targetType, targetId) {
  if (targetId == null) return null;
  if (targetType === 'REGION') return 'target_id is not allowed for REGION fences';
  const region = targetRegion(targetType, targetId);
  if (region == null) return `${targetType} target #${targetId} not found`;
  return null;
}

router.get('/geofences', (req, res) => {
  const scope = commandScope(req.user);
  res.json(list('geofence', ['boundary_json']).filter((f) => scope.global || f.region_id == null || scope.regionIds.has(f.region_id)));
});

router.post('/geofences', (req, res) => {
  if (!can(req, 'geofence:write')) return res.status(403).json({ error: 'Forbidden: requires geofence:write' });
  const scope = commandScope(req.user);
  const { errors, out } = geofenceFields(req.body);
  const targetError = fenceTargetError(out.target_type, out.target_id);
  if (targetError) errors.push(targetError);
  if (errors.length) return res.status(400).json({ error: errors.join('; ') });
  if (out.region_id === undefined && out.target_id != null) out.region_id = targetRegion(out.target_type, out.target_id);
  if (!scopeRegionContains(scope, out.region_id)) {
    return res.status(403).json({ error: 'Forbidden: geofence must belong to a region in your command scope' });
  }
  if (out.is_active === undefined) out.is_active = 1;
  if (out.tolerance_m === undefined) out.tolerance_m = 50;
  const id = insertRow('geofence', out);
  audit(req.user, 'CREATE', 'geofence', id, { ...out, boundary_json: out.boundary_json ? 'polygon' : null });
  res.status(201).json(get('geofence', id, ['boundary_json']));
});

router.put('/geofences/:id', (req, res) => {
  if (!can(req, 'geofence:write')) return res.status(403).json({ error: 'Forbidden: requires geofence:write' });
  const existing = get('geofence', Number(req.params.id), ['boundary_json']);
  if (!existing) return res.status(404).json({ error: 'Geofence not found' });
  const scope = commandScope(req.user);
  if (!scopeRegionContains(scope, existing.region_id)) return res.status(403).json({ error: 'Forbidden: geofence is outside your command scope' });
  const { errors, out } = geofenceFields(req.body, { partial: true });
  const mergedType = out.target_type ?? existing.target_type;
  const mergedTarget = out.target_id !== undefined ? out.target_id : existing.target_id;
  const targetError = fenceTargetError(mergedType, mergedTarget);
  if (targetError) errors.push(targetError);
  if (errors.length) return res.status(400).json({ error: errors.join('; ') });
  if (out.region_id !== undefined && !scopeRegionContains(scope, out.region_id)) {
    return res.status(403).json({ error: 'Forbidden: geofence must belong to a region in your command scope' });
  }
  // `cleanRow` drops null values, so clearing a nullable field needs an
  // explicit statement before the remaining fields are updated.
  if (out.boundary_json === null) { db.prepare('UPDATE geofence SET boundary_json = NULL WHERE id = ?').run(existing.id); delete out.boundary_json; }
  if (out.target_id === null) { db.prepare('UPDATE geofence SET target_id = NULL WHERE id = ?').run(existing.id); delete out.target_id; }
  if (out.region_id === null) { db.prepare('UPDATE geofence SET region_id = NULL WHERE id = ?').run(existing.id); delete out.region_id; }
  updateRow('geofence', existing.id, out);
  audit(req.user, 'UPDATE', 'geofence', existing.id, { ...out, boundary_json: out.boundary_json ? 'polygon' : undefined });
  res.json(get('geofence', existing.id, ['boundary_json']));
});

router.delete('/geofences/:id', (req, res) => {
  if (!can(req, 'geofence:write')) return res.status(403).json({ error: 'Forbidden: requires geofence:write' });
  const existing = get('geofence', Number(req.params.id));
  if (!existing) return res.status(404).json({ error: 'Geofence not found' });
  const scope = commandScope(req.user);
  if (!scopeRegionContains(scope, existing.region_id)) return res.status(403).json({ error: 'Forbidden: geofence is outside your command scope' });
  db.prepare('DELETE FROM geofence WHERE id = ?').run(existing.id);
  audit(req.user, 'DELETE', 'geofence', existing.id, { name: existing.name });
  res.json({ ok: true });
});

// Review decision for a GPS violation: Acknowledge (seen, defer), Resolve
// (accepted / handled) or Reject (false alarm). Records who decided and when.
router.post('/gps-validations/:id/review', (req, res) => {
  if (!can(req, 'gps:review')) return res.status(403).json({ error: 'Forbidden: requires gps:review' });
  const row = get('gps_validation', Number(req.params.id));
  if (!row) return res.status(404).json({ error: 'Validation not found' });
  const scope = commandScope(req.user);
  if (!scope.global && !scope.validationIds.has(row.id)) return res.status(403).json({ error: 'Forbidden: validation is outside your command scope' });
  const action = String(req.body.action ?? '').toUpperCase();
  const status = { ACKNOWLEDGE: 'ACKNOWLEDGED', RESOLVE: 'RESOLVED', REJECT: 'REJECTED' }[action];
  if (!status) return res.status(400).json({ error: 'action must be ACKNOWLEDGE, RESOLVE or REJECT' });
  const now = new Date().toISOString();
  updateRow('gps_validation', row.id, {
    review_status: status,
    reviewed_by: req.user.person_id || null,
    reviewed_at: now,
    review_note: req.body.note != null ? String(req.body.note).trim() : null,
  });
  audit(req.user, 'REVIEW', 'gps_validation', row.id, { action, status, note: req.body.note ?? null });
  res.json(get('gps_validation', row.id));
});

// Violations: GPS points outside tolerance, outside geofence, or outside the
// region/substation geographic boundary.
router.get('/violations', (req, res) => {
  const scope = commandScope(req.user);
  let rows = db.prepare(
    "SELECT * FROM gps_validation WHERE violation IS NOT NULL OR result = 'FAIL' OR inside_geofence = 0"
  ).all().filter((v) => scope.global || scope.validationIds.has(v.id));
  if (req.query.review_status) rows = rows.filter((v) => v.review_status === String(req.query.review_status).toUpperCase());
  if (req.query.violation) rows = rows.filter((v) => v.violation === req.query.violation);
  for (const v of rows) {
    v.region = get('region', v.region_id);
    v.geofence = v.geofence_id ? get('geofence', v.geofence_id) : null;
    v.reviewer = v.reviewed_by ? get('person', v.reviewed_by) : null;
    if (v.target_type === 'ASSET') v.target = get('asset', v.target_id);
    if (v.target_type === 'SUBSTATION') v.target = get('substation', v.target_id);
    if (v.target_type === 'LINE') v.target = get('transmission_line', v.target_id);
    if (v.target_type === 'TOWER') v.target = get('tower', v.target_id);
  }
  rows.sort((a, b) => b.validated_at.localeCompare(a.validated_at));
  res.json(rows);
});

router.get('/gps-summary', (req, res) => {
  const scope = commandScope(req.user);
  const scopedIds = (table) => {
    if (scope.global) return null;
    if (table === 'transmission_line') return scope.lineIds;
    if (table === 'substation') return scope.substationIds;
    if (table === 'asset') return scope.assetIds;
    if (table === 'tower') return scope.towerIds;
    return null;
  };
  const byType = (t, table) => {
    const ids = scopedIds(table);
    const total = ids ? ids.size : db.prepare(`SELECT COUNT(*) c FROM ${table}`).get().c;
    let valid;
    if (ids) {
      valid = [...ids].filter((id) => db.prepare(`SELECT gps_validated FROM ${table} WHERE id = ?`).get(id)?.gps_validated === 1).length;
    } else {
      valid = db.prepare(`SELECT COUNT(*) c FROM ${table} WHERE gps_validated = 1`).get().c;
    }
    return { target_type: t, total, validated: valid, coverage: total ? Math.round((valid / total) * 100) : 0 };
  };
  const coverage = [['ASSET', 'asset'], ['SUBSTATION', 'substation'], ['TOWER', 'tower'], ['LINE', 'transmission_line']];
  const assetInRegion = (a, regionId) => {
    if (a.substation_id) return get('substation', a.substation_id)?.region_id === regionId;
    if (a.line_id) return get('transmission_line', a.line_id)?.region_id === regionId;
    if (a.tower_id) { const t = get('tower', a.tower_id); return t ? get('transmission_line', t.line_id)?.region_id === regionId : false; }
    return false;
  };
  const regions = list('region').filter((r) => scope.global || scope.regionIds.has(r.id)).map((r) => {
    const ids = list('asset')
      .filter((a) => (scope.global || scope.assetIds.has(a.id)) && assetInRegion(a, r.id))
      .map((a) => a.id);
    const total = ids.length;
    const valid = ids.filter((id) => get('asset', id)?.gps_validated === 1).length;
    return { region: r.name, total, validated: valid, coverage: total ? Math.round((valid / total) * 100) : 0 };
  });
  const allValidations = list('gps_validation').filter((v) => scope.global || scope.validationIds.has(v.id));
  const recent = allValidations.sort((a, b) => b.validated_at.localeCompare(a.validated_at)).slice(0, 10);
  const fails = allValidations.filter((v) => v.result === 'FAIL').length;
  const violations = allValidations.filter((v) => v.result === 'FAIL' || v.violation || v.inside_geofence === 0).length;
  const reviews = { open: 0, acknowledged: 0, resolved: 0, rejected: 0, not_required: 0 };
  for (const v of allValidations) {
    const key = String(v.review_status || 'not_required').toLowerCase();
    if (reviews[key] !== undefined) reviews[key] += 1;
  }
  res.json({
    by_type: coverage.map(([t, tb]) => byType(t, tb)),
    by_region: regions,
    pass_rate: allValidations.length ? Math.round(((allValidations.length - fails) / allValidations.length) * 100) : 0,
    recent,
    total_validations: allValidations.length,
    violations,
    reviews,
  });
});

module.exports = router;
