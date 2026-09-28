// Line map workspace logic. All mutating functions run inside a caller-owned
// transaction (core.js withTx) and never call rebuildLineRoute: the line route
// is the master geometry, so saving towers must not overwrite it.
const { db, get, insertRow, updateRow } = require('./util');
const { haversineKm, projectPointToRoute } = require('./lineGeometry');
const { seedStandardComponents } = require('./towerStandards');
const { syncLineTowerCount, syncTowerMirror } = require('./integrity');

function routePrefix(lineId) {
  return String(lineId || '').replace(/^TL-/, '');
}

function parseRoute(routeJson) {
  const route = Array.isArray(routeJson) ? routeJson : [];
  const ok = route.length >= 2 && route.every(
    (p) => Array.isArray(p) && p.length >= 2 && typeof p[0] === 'number' && typeof p[1] === 'number' && Number.isFinite(p[0]) && Number.isFinite(p[1])
  );
  return ok ? route : null;
}

function projectKm(route, lat, lng, fallback) {
  const p = projectPointToRoute(route, lat, lng);
  return p ? p.km : fallback;
}

// Next free numeric suffix for a line's tower ids. Line TL-C1 with towers
// C1-001, C1-003 yields { prefix: 'C1', next: 4 }.
function nextTowerSeq(lineId) {
  const line = get('transmission_line', lineId);
  const prefix = routePrefix(line && line.line_id);
  const rows = db.prepare('SELECT tower_id FROM tower WHERE line_id = ?').all(lineId);
  const escaped = prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp('^' + escaped + '-(\\d+)$');
  let maxN = 0;
  for (const r of rows) {
    const m = re.exec(String(r.tower_id));
    if (m) maxN = Math.max(maxN, parseInt(m[1], 10));
  }
  return { prefix, next: maxN + 1 };
}

function reprojectTowers(lineId, route) {
  const towers = db.prepare('SELECT * FROM tower WHERE line_id = ?').all(lineId);
  const upd = db.prepare('UPDATE tower SET km_marker = ? WHERE id = ?');
  for (const t of towers) upd.run(projectKm(route, t.latitude, t.longitude, t.km_marker), t.id);
  return towers.length;
}

// Set the line's route (master geometry), recompute length/gps_validated, and
// re-project every existing tower's km_marker. Positions are left unchanged.
function setLineRoute(lineId, routeJson) {
  const raw = Array.isArray(routeJson) ? routeJson : [];
  if (raw.length === 0) {
    db.prepare("UPDATE transmission_line SET route_json = '[]', length_km = 0, gps_validated = 0 WHERE id = ?").run(lineId);
    return {
      line: get('transmission_line', lineId, ['route_json']),
      towers: db.prepare('SELECT * FROM tower WHERE line_id = ? ORDER BY km_marker, id').all(lineId),
    };
  }
  const route = parseRoute(routeJson);
  if (!route) throw new Error('Route must be an array of at least two [lat, lng] points');
  let length = 0;
  for (let i = 1; i < route.length; i++) {
    length += haversineKm(route[i - 1][0], route[i - 1][1], route[i][0], route[i][1]);
  }
  db.prepare('UPDATE transmission_line SET route_json = ?, length_km = ?, gps_validated = ? WHERE id = ?')
    .run(JSON.stringify(route), Math.round(length * 10) / 10, 1, lineId);
  reprojectTowers(lineId, route);
  return {
    line: get('transmission_line', lineId, ['route_json']),
    towers: db.prepare('SELECT * FROM tower WHERE line_id = ? ORDER BY km_marker, id').all(lineId),
  };
}

function assertDeletable(t) {
  const linked = db.prepare(
    "SELECT COUNT(*) c FROM task WHERE tower_id = ? AND status NOT IN ('COMPLETED','CANCELLED','FAILED')"
  ).get(t.id).c;
  if (linked > 0) throw new Error(`Cannot delete ${t.tower_id}: ${linked} open task(s)`);
  const refs = [
    ['task', db.prepare('SELECT COUNT(*) c FROM task WHERE tower_id = ?').get(t.id).c],
    ['maintenance schedule', db.prepare('SELECT COUNT(*) c FROM maintenance_schedule WHERE tower_id = ?').get(t.id).c],
    ['checklist execution', db.prepare('SELECT COUNT(*) c FROM checklist_execution WHERE tower_id = ?').get(t.id).c],
  ].filter(([, n]) => n > 0);
  if (refs.length) {
    const detail = refs.map(([name, n]) => `${n} ${name}${n === 1 ? '' : 's'}`).join(', ');
    throw new Error(`Cannot delete ${t.tower_id}: referenced by ${detail}. Remove the linked records first.`);
  }
}

function deleteTowerRow(t) {
  db.prepare('DELETE FROM asset WHERE tower_id = ?').run(t.id);
  db.prepare('DELETE FROM tower_component WHERE tower_id = ?').run(t.id);
  db.prepare('DELETE FROM tower WHERE id = ?').run(t.id);
}

const TOWER_FIELDS = ['tower_type', 'tower_material', 'foundation_type', 'height_m', 'corrosion_rating', 'gps_validated'];

// Batch create/update/delete staged by the map. Assigns ids/numbers, recomputes
// km_marker, inserts mirror assets, syncs tower_count. Caller wraps in withTx.
function batchTowers(lineId, payload = {}) {
  const line = get('transmission_line', lineId, ['route_json']);
  if (!line) throw new Error('Line not found');
  const route = parseRoute(line.route_json);
  if (!route) throw new Error('Line has no route; draw or import a route before placing towers');
  const creates = Array.isArray(payload.creates) ? payload.creates : [];
  const updates = Array.isArray(payload.updates) ? payload.updates : [];
  const deletes = Array.isArray(payload.deletes) ? payload.deletes : [];

  const deleted = [];
  for (const id of deletes) {
    const t = get('tower', Number(id));
    if (!t || t.line_id !== lineId) continue;
    assertDeletable(t);
    deleteTowerRow(t);
    deleted.push(t.id);
  }

  const seq = nextTowerSeq(lineId);
  const used = new Set(db.prepare('SELECT tower_id FROM tower').all().map((r) => r.tower_id));
  const created = [];
  for (const c of creates) {
    if (typeof c.lat !== 'number' || typeof c.lng !== 'number' || !Number.isFinite(c.lat) || !Number.isFinite(c.lng)) {
      throw new Error('Each new tower needs numeric lat and lng');
    }
    let tid;
    do {
      tid = `${seq.prefix}-${String(seq.next).padStart(3, '0')}`;
      seq.next += 1;
    } while (used.has(tid));
    used.add(tid);
    const type = c.tower_type || 'SUSPENSION';
    const id = insertRow('tower', {
      tower_id: tid,
      line_id: lineId,
      tower_number: tid,
      km_marker: projectKm(route, c.lat, c.lng, 0),
      latitude: c.lat,
      longitude: c.lng,
      tower_type: type,
      tower_material: c.tower_material || 'LATTICE_STEEL',
      height_m: c.height_m != null ? c.height_m : (line.voltage_kv >= 500 ? 55 : 38),
      foundation_type: c.foundation_type || 'PAD',
      corrosion_rating: c.corrosion_rating != null ? c.corrosion_rating : 8,
      gps_validated: c.gps_validated != null ? c.gps_validated : 1,
      revision: 1,
    });
    seedStandardComponents(id, type);
    syncTowerMirror(id);
    created.push(get('tower', id));
  }

  const updated = [];
  for (const u of updates) {
    const t = get('tower', Number(u.id));
    if (!t || t.line_id !== lineId) continue;
    const lat = typeof u.lat === 'number' && Number.isFinite(u.lat) ? u.lat : t.latitude;
    const lng = typeof u.lng === 'number' && Number.isFinite(u.lng) ? u.lng : t.longitude;
    const fields = { latitude: lat, longitude: lng, km_marker: projectKm(route, lat, lng, t.km_marker) };
    for (const f of TOWER_FIELDS) if (u[f] !== undefined) fields[f] = u[f];
    updateRow('tower', t.id, fields, [], 'revision');
    syncTowerMirror(t.id);
    updated.push(get('tower', t.id));
  }

  syncLineTowerCount(lineId);
  const lineRow = get('transmission_line', lineId);
  return { created, updated, deleted, line: { id: lineRow.id, tower_count: lineRow.tower_count } };
}

// Box-selection actions: deletes + field patches only. Caller wraps in withTx.
function bulkTowers(lineId, payload = {}) {
  const deletes = Array.isArray(payload.delete) ? payload.delete : [];
  const patches = Array.isArray(payload.patch) ? payload.patch : [];
  const deleted = [];
  for (const id of deletes) {
    const t = get('tower', Number(id));
    if (!t || t.line_id !== lineId) continue;
    assertDeletable(t);
    deleteTowerRow(t);
    deleted.push(t.id);
  }
  const patched = [];
  for (const p of patches) {
    const t = get('tower', Number(p.id));
    if (!t || t.line_id !== lineId) continue;
    const fields = {};
    for (const f of ['tower_type', 'tower_material', 'foundation_type']) if (p[f] != null) fields[f] = p[f];
    if (Object.keys(fields).length === 0) continue;
    updateRow('tower', t.id, fields, [], 'revision');
    syncTowerMirror(t.id);
    patched.push(t.id);
  }
  syncLineTowerCount(lineId);
  return { deleted, patched };
}

// Reset the given towers' components to their type's standard set. Caller wraps.
function bulkResetComponents(lineId, ids = []) {
  let towers_reset = 0;
  let components_written = 0;
  for (const id of ids) {
    const t = get('tower', Number(id));
    if (!t || t.line_id !== lineId) continue;
    db.prepare('DELETE FROM tower_component WHERE tower_id = ?').run(t.id);
    seedStandardComponents(t.id, t.tower_type);
    components_written += db.prepare('SELECT COUNT(*) c FROM tower_component WHERE tower_id = ?').get(t.id).c;
    towers_reset += 1;
  }
  return { towers_reset, components_written };
}

module.exports = { setLineRoute, nextTowerSeq, batchTowers, bulkTowers, bulkResetComponents };
