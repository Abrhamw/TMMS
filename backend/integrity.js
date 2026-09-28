const { db } = require('./db');
const { getStandardForType } = require('./towerStandards');

function ph(n) { return Array(n).fill('?').join(','); }

// Bays are derived automatically from registered assets: each distinct bay
// label is one bay, and an indoor bay and an outdoor bay with the same label
// are different physical bays, so both dimensions participate in the key.
function countSubstationBays(substationId) {
  if (substationId == null) return 0;
  const r = db.prepare(
    `SELECT COUNT(*) c FROM (
       SELECT DISTINCT COALESCE(NULLIF(TRIM(location_type), ''), 'OUTDOOR') loc, TRIM(bay) bay
       FROM asset
       WHERE substation_id = ? AND lifecycle_status != 'REMOVED'
         AND bay IS NOT NULL AND TRIM(bay) != ''
     )`
  ).get(substationId);
  return r.c;
}

// Same rule as countSubstationBays but for every substation at once, so list
// endpoints do not run one query per row.
function substationBayCounts() {
  const out = new Map();
  for (const r of db.prepare(
    `SELECT substation_id, COUNT(*) c FROM (
       SELECT DISTINCT substation_id, COALESCE(NULLIF(TRIM(location_type), ''), 'OUTDOOR') loc, TRIM(bay) bay
       FROM asset
       WHERE substation_id IS NOT NULL AND lifecycle_status != 'REMOVED'
         AND bay IS NOT NULL AND TRIM(bay) != ''
     ) GROUP BY substation_id`
  ).all()) {
    out.set(r.substation_id, r.c);
  }
  return out;
}

function syncSubstationBayCount(substationId) {
  if (substationId == null) return false;
  const c = countSubstationBays(substationId);
  const row = db.prepare('SELECT bay_count FROM substation WHERE id = ?').get(substationId);
  if (!row || Number(row.bay_count) === Number(c)) return false;
  db.prepare('UPDATE substation SET bay_count = ? WHERE id = ?').run(c, substationId);
  return true;
}

function syncLineTowerCount(lineId) {
  if (lineId == null) return false;
  const r = db.prepare('SELECT COUNT(*) c FROM tower WHERE line_id = ?').get(lineId);
  const row = db.prepare('SELECT tower_count FROM transmission_line WHERE id = ?').get(lineId);
  if (!row || Number(row.tower_count) === Number(r.c)) return false;
  db.prepare('UPDATE transmission_line SET tower_count = ? WHERE id = ?').run(r.c, lineId);
  return true;
}

function syncTowerMirror(towerId) {
  const t = db.prepare('SELECT * FROM tower WHERE id = ?').get(towerId);
  if (!t) return { created: false, changed: false };
  const mirrors = db.prepare("SELECT * FROM asset WHERE tower_id = ? AND asset_type = 'TOWER'").all(towerId);
  const metadata = JSON.stringify({ source: 'tower', tower_type: t.tower_type, height_m: t.height_m });
  if (mirrors.length === 0) {
    const assetId = `TWR-${t.tower_id}`;
    const existing = db.prepare('SELECT * FROM asset WHERE asset_id = ?').get(assetId);
    if (existing) {
      db.prepare(
        'UPDATE asset SET tower_id = ?, asset_type = ?, name = ?, line_id = ?, latitude = ?, longitude = ?, condition_rating = ?, gps_validated = ?, metadata = ? WHERE id = ?'
      ).run(t.id, 'TOWER', t.tower_id, t.line_id, t.latitude, t.longitude, t.corrosion_rating ?? 8, t.gps_validated, metadata, existing.id);
      return { created: false, changed: true };
    }
    db.prepare(
      `INSERT INTO asset (asset_id, asset_type, line_id, tower_id, name, latitude, longitude, condition_rating, condition_assessed_at, lifecycle_status, operational_status, criticality, gps_validated, metadata)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
    ).run(
      assetId, 'TOWER', t.line_id, t.id, t.tower_id, t.latitude, t.longitude,
      t.corrosion_rating ?? 8, new Date().toISOString(), 'IN_SERVICE', 'OPERATIONAL', 'MEDIUM',
      t.gps_validated, metadata
    );
    return { created: true, changed: true };
  }
  const m = mirrors[0];
  const changed = m.name !== t.tower_id || m.line_id !== t.line_id || m.latitude !== t.latitude ||
    m.longitude !== t.longitude || (m.condition_rating ?? 8) !== (t.corrosion_rating ?? 8) ||
    m.gps_validated !== t.gps_validated || m.metadata !== metadata;
  if (changed) {
    db.prepare(
      'UPDATE asset SET name = ?, line_id = ?, latitude = ?, longitude = ?, condition_rating = ?, gps_validated = ?, metadata = ? WHERE tower_id = ? AND asset_type = ?'
    ).run(t.tower_id, t.line_id, t.latitude, t.longitude, t.corrosion_rating ?? 8, t.gps_validated, metadata, t.id, 'TOWER');
  }
  return { created: false, changed };
}

function evaluateCompliance(towerType, std, actual) {
  const actualMap = new Map(actual.map((a) => [a.component_type, a.quantity]));
  const stdMap = new Map(std.map((s) => [s.component_type, s.default_quantity]));
  const missing = [];
  const qty_mismatches = [];
  for (const s of std) {
    if (!actualMap.has(s.component_type)) missing.push(s.component_type);
    else if (Number(actualMap.get(s.component_type)) !== Number(s.default_quantity)) {
      qty_mismatches.push({ component_type: s.component_type, expected: s.default_quantity, actual: actualMap.get(s.component_type) });
    }
  }
  const extra = actual.filter((a) => !stdMap.has(a.component_type)).map((a) => a.component_type);
  const typeCounts = new Map();
  for (const a of actual) typeCounts.set(a.component_type, (typeCounts.get(a.component_type) || 0) + 1);
  const duplicates = [...typeCounts.entries()]
    .filter(([, n]) => n > 1)
    .map(([component_type, count]) => ({ component_type, count }));
  return {
    tower_type: towerType,
    standard_count: std.length,
    recorded_count: actual.length,
    missing,
    extra,
    qty_mismatches,
    duplicates,
    compliant: missing.length === 0 && extra.length === 0 && qty_mismatches.length === 0 && duplicates.length === 0,
  };
}

function towerCompliance(towerId) {
  const t = db.prepare('SELECT * FROM tower WHERE id = ?').get(towerId);
  if (!t) return null;
  const std = getStandardForType(t.tower_type);
  const actual = db.prepare('SELECT component_type, quantity FROM tower_component WHERE tower_id = ?').all(towerId);
  return evaluateCompliance(t.tower_type, std, actual);
}

// Compliance for every tower in two queries (components + towers) instead of
// N+1 per-tower queries. Returns a Map keyed by tower id. Pass `towerIds` to
// restrict the scan to one line's towers (used by /towers?line_id=...).
function towerComplianceBatch(towerIds = null) {
  const scoped = Array.isArray(towerIds) && towerIds.length > 0;
  const stdCache = new Map();
  const stdFor = (type) => {
    if (!stdCache.has(type)) stdCache.set(type, getStandardForType(type));
    return stdCache.get(type);
  };
  const byTower = new Map();
  const compSql = scoped
    ? `SELECT tower_id, component_type, quantity FROM tower_component WHERE tower_id IN (${ph(towerIds.length)}) ORDER BY tower_id, id`
    : 'SELECT tower_id, component_type, quantity FROM tower_component ORDER BY tower_id, id';
  for (const c of db.prepare(compSql).all(...(scoped ? towerIds : []))) {
    if (!byTower.has(c.tower_id)) byTower.set(c.tower_id, []);
    byTower.get(c.tower_id).push(c);
  }
  const towerSql = scoped
    ? `SELECT id, tower_type FROM tower WHERE id IN (${ph(towerIds.length)})`
    : 'SELECT id, tower_type FROM tower';
  const out = new Map();
  for (const t of db.prepare(towerSql).all(...(scoped ? towerIds : []))) {
    out.set(t.id, evaluateCompliance(t.tower_type, stdFor(t.tower_type), byTower.get(t.id) || []));
  }
  return out;
}

// Lightweight per-tower compliance for list endpoints. The lists show only the
// recorded/standard counts and a green/red flag, so this aggregates in SQLite
// (one GROUP BY over tower_component) instead of materialising a JS array per
// tower. On a 12k-tower / 244k-component register the array-building path spent
// ~1.2 s per request; this returns the same summary in a fraction of that.
// Pass `towerIds` to restrict to one line's towers.
function towerComplianceSummaryBatch(towerIds = null) {
  const scoped = Array.isArray(towerIds) && towerIds.length > 0;
  const stdCache = new Map();
  const stdFor = (type) => {
    if (!stdCache.has(type)) stdCache.set(type, getStandardForType(type));
    return stdCache.get(type);
  };
  const aggSql = `SELECT tc.tower_id,
      t.tower_type,
      COUNT(*) AS recorded_count,
      COUNT(DISTINCT tc.component_type) AS distinct_types,
      COUNT(DISTINCT CASE WHEN s.component_type IS NOT NULL THEN tc.component_type END) AS matched_types,
      SUM(CASE WHEN s.component_type IS NULL THEN 1 ELSE 0 END) AS extra_rows,
      SUM(CASE WHEN s.component_type IS NOT NULL AND CAST(tc.quantity AS INTEGER) != CAST(s.default_quantity AS INTEGER) THEN 1 ELSE 0 END) AS mismatch_rows
    FROM tower_component tc
    JOIN tower t ON t.id = tc.tower_id
    LEFT JOIN tower_component_standard s
      ON s.tower_type = t.tower_type AND s.component_type = tc.component_type
    ${scoped ? `WHERE tc.tower_id IN (${ph(towerIds.length)})` : ''}
    GROUP BY tc.tower_id`;
  const towers = scoped
    ? db.prepare(`SELECT id, tower_type FROM tower WHERE id IN (${ph(towerIds.length)})`).all(...towerIds)
    : db.prepare('SELECT id, tower_type FROM tower').all();
  const stats = new Map();
  for (const r of db.prepare(aggSql).all(...(scoped ? towerIds : []))) stats.set(r.tower_id, r);
  const out = new Map();
  for (const t of towers) {
    const std = stdFor(t.tower_type);
    const s = stats.get(t.id);
    if (!s) {
      out.set(t.id, { tower_type: t.tower_type, standard_count: std.length, recorded_count: 0, compliant: std.length === 0 });
      continue;
    }
    const missing = std.length - s.matched_types;
    const hasDup = s.recorded_count !== s.distinct_types;
    out.set(t.id, {
      tower_type: t.tower_type,
      standard_count: std.length,
      recorded_count: s.recorded_count,
      compliant: missing === 0 && s.extra_rows === 0 && s.mismatch_rows === 0 && !hasDup,
    });
  }
  return out;
}

function validateIntegrity({ regionIds } = {}) {
  const scoped = Array.isArray(regionIds) && regionIds.length > 0;
  const subWhere = scoped ? ` WHERE region_id IN (${ph(regionIds.length)})` : '';
  const lineWhere = scoped ? ` WHERE l.region_id IN (${ph(regionIds.length)})` : '';

  const substations = db.prepare(`SELECT * FROM substation${subWhere} ORDER BY substation_id`).all(...(scoped ? regionIds : []));
  const lines = db.prepare(
    `SELECT l.* FROM transmission_line l${lineWhere} ORDER BY l.line_id`
  ).all(...(scoped ? regionIds : []));

  const subOut = [];
  const subIssueIds = new Set();
  for (const s of substations) {
    const actual = countSubstationBays(s.id);
    subOut.push({ id: s.id, substation_id: s.substation_id, name: s.name, bay_count: s.bay_count, actual_bay_count: actual });
    if (Number(s.bay_count) !== Number(actual)) subIssueIds.add(s.id);
  }

  const lineOut = [];
  const towerOut = [];
  let issues = subIssueIds.size;
  for (const l of lines) {
    const towers = db.prepare('SELECT * FROM tower WHERE line_id = ? ORDER BY id').all(l.id);
    const actualTower = towers.length;
    const missingMirrors = towers.filter((t) => {
      const m = db.prepare("SELECT COUNT(*) c FROM asset WHERE tower_id = ? AND asset_type = 'TOWER'").get(t.id).c;
      return m !== 1;
    }).length;
    let nonStandard = 0;
    for (const t of towers) {
      const c = towerCompliance(t.id);
      if (c && !c.compliant) {
        nonStandard += 1;
        towerOut.push({ id: t.id, tower_id: t.tower_id, line_id: l.id, ...c });
      }
    }
    const lineIssues = (Number(l.tower_count) !== actualTower ? 1 : 0) + missingMirrors + nonStandard;
    issues += lineIssues;
    lineOut.push({
      id: l.id, line_id: l.line_id, name: l.name,
      tower_count: l.tower_count, actual_tower_count: actualTower,
      missing_mirrors: missingMirrors, non_standard_towers: nonStandard,
    });
  }

  return {
    summary: { lines: lines.length, towers: lineOut.reduce((n, l) => n + l.actual_tower_count, 0), substations: substations.length, issues },
    lines: lineOut,
    towers: towerOut,
    substations: subOut,
  };
}

function reconcileAll({ regionIds } = {}) {
  const summary = { lines_fixed: 0, towers_fixed: 0, mirrors_created: 0, substations_fixed: 0 };
  const scoped = Array.isArray(regionIds) && regionIds.length > 0;
  const subs = scoped
    ? db.prepare(`SELECT * FROM substation WHERE region_id IN (${ph(regionIds.length)})`).all(...regionIds)
    : db.prepare('SELECT * FROM substation').all();
  for (const s of subs) {
    const actual = countSubstationBays(s.id);
    if (Number(s.bay_count) !== Number(actual)) summary.substations_fixed += 1;
    syncSubstationBayCount(s.id);
  }
  const lines = scoped
    ? db.prepare(`SELECT * FROM transmission_line WHERE region_id IN (${ph(regionIds.length)})`).all(...regionIds)
    : db.prepare('SELECT * FROM transmission_line').all();
  for (const l of lines) {
    if (Number(l.tower_count) !== Number(db.prepare('SELECT COUNT(*) c FROM tower WHERE line_id = ?').get(l.id).c)) summary.lines_fixed += 1;
    syncLineTowerCount(l.id);
  }
  const towers = scoped
    ? db.prepare(`SELECT t.* FROM tower t JOIN transmission_line l ON l.id = t.line_id WHERE l.region_id IN (${ph(regionIds.length)})`).all(...regionIds)
    : db.prepare('SELECT * FROM tower').all();
  for (const t of towers) {
    const r = syncTowerMirror(t.id);
    if (r.created) summary.mirrors_created += 1;
    if (r.changed) summary.towers_fixed += 1;
  }
  return summary;
}

module.exports = {
  countSubstationBays, substationBayCounts, syncSubstationBayCount, syncLineTowerCount, syncTowerMirror,
  towerCompliance, towerComplianceBatch, towerComplianceSummaryBatch, evaluateCompliance, validateIntegrity, reconcileAll,
};
