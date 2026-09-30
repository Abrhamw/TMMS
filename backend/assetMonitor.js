// Asset-condition monitoring agent.
//
// The agent runs a *revaluation* over every asset that carries field evidence
// (maintenance events or maintenance tasks), recomputing the evidence-based
// condition suggestion and health index. It appends a change-log row to
// `asset_health_snapshot` only when the suggested rating or recommendation
// actually moves, so repeated runs are idempotent and the table reads as a
// history of condition drift rather than a per-run dump. When assets degrade,
// the caller can turn the change set into a "revaluation report" for review.
//
// It deliberately never overwrites the stored `condition_rating`: it advises,
// and an authorised evaluator confirms. This mirrors the manual evaluate flow.

const { db, get, withTx } = require('./util');
const { suggestAssetCondition, computeHealth } = require('./assetCondition');

const DEAD_LIFECYCLE = ['REMOVED', 'RETIRED', 'DECOMMISSIONED', 'DISPOSED'];

function latestSnapshot(assetId) {
  return db.prepare('SELECT * FROM asset_health_snapshot WHERE asset_id = ? ORDER BY captured_at DESC, id DESC LIMIT 1').get(assetId) || null;
}

// Assets worth revaluing: those with any recorded evidence. Assets without
// evidence only move on the age baseline, which is stable within a day.
function candidateAssets() {
  return db.prepare(
    `SELECT a.* FROM asset a WHERE a.id IN (
       SELECT asset_id FROM asset_maintenance_event WHERE asset_id IS NOT NULL
       UNION SELECT asset_id FROM task WHERE asset_id IS NOT NULL
     )`
  ).all().filter((a) => !DEAD_LIFECYCLE.includes(String(a.lifecycle_status || '').toUpperCase()));
}

function assetRegionLabel(a) {
  if (a.substation_id) {
    const s = get('substation', a.substation_id);
    if (s) return get('region', s.region_id)?.name || null;
  }
  if (a.line_id) {
    const l = get('transmission_line', a.line_id);
    if (l) return get('region', l.region_id)?.name || null;
  }
  if (a.tower_id) {
    const t = get('tower', a.tower_id);
    if (t) {
      const l = get('transmission_line', t.line_id);
      if (l) return get('region', l.region_id)?.name || null;
    }
  }
  return null;
}

// Revalue every evidence-bearing asset. Writes change-log rows for assets whose
// suggestion moved (or that have no history yet) and returns the change set.
// `onDegraded(changes)` is invoked once when any asset degraded, and may return
// a report id that is linked to the degraded snapshot rows.
function revalueAssets({ source = 'AGENT', onDegraded } = {}) {
  const now = new Date().toISOString();
  const assets = candidateAssets();
  const changes = [];
  for (const a of assets) {
    const suggestion = suggestAssetCondition(a);
    if (!suggestion) continue;
    const prev = latestSnapshot(a.id);
    const health = computeHealth({ ...a, condition_rating: suggestion.suggested_rating });
    const prevRating = prev ? prev.suggested_rating : a.condition_rating;
    const prevRec = prev ? prev.recommendation : null;
    const ratingMoved = prev == null || Math.abs(Number(suggestion.suggested_rating) - Number(prevRating)) >= 0.5;
    const recMoved = prevRec != null && prevRec !== suggestion.recommendation;
    if (!ratingMoved && !recMoved) continue;
    changes.push({
      asset_pk: a.id,
      asset_code: a.asset_id,
      asset_name: a.name || a.asset_id,
      asset_type: a.asset_type || null,
      region: assetRegionLabel(a),
      from_rating: prevRating != null ? Number(prevRating) : null,
      to_rating: suggestion.suggested_rating,
      delta: prevRating != null ? Math.round((suggestion.suggested_rating - Number(prevRating)) * 10) / 10 : 0,
      health_index: health.health_index,
      remaining_useful_life_years: health.remaining_useful_life_years,
      recommendation: suggestion.recommendation,
      recommendation_label: suggestion.recommendation_label,
      confidence: suggestion.confidence,
      reasons: suggestion.reasons || [],
      source,
    });
  }
  const degraded = changes.filter((c) => c.delta < 0);
  const improved = changes.filter((c) => c.delta > 0);
  let reportId = null;
  if (degraded.length && typeof onDegraded === 'function') {
    try {
      reportId = onDegraded(degraded, { evaluated: assets.length, changed: changes.length }) ?? null;
    } catch (_) {
      reportId = null;
    }
  }
  const stmt = db.prepare(
    `INSERT INTO asset_health_snapshot
       (asset_id, captured_at, condition_rating, suggested_rating, health_index, remaining_useful_life_years, recommendation, source, reasons, report_id)
     VALUES (?,?,?,?,?,?,?,?,?,?)`
  );
  const tx = (rows) => withTx(() => {
    for (const c of rows) {
      stmt.run(
        c.asset_pk, now, c.from_rating, c.to_rating, c.health_index, c.remaining_useful_life_years,
        c.recommendation, source, JSON.stringify(c.reasons || []), c.delta < 0 ? reportId : null
      );
    }
  });
  if (changes.length) tx(changes);
  return { evaluated: assets.length, changed: changes.length, degraded, improved, changes, report_id: reportId, at: now };
}

function changesToData(changes, meta = {}) {
  const degraded = changes.filter((c) => c.delta < 0);
  const improved = changes.filter((c) => c.delta > 0);
  const flat = changes.filter((c) => !c.delta);
  const byRec = {};
  for (const c of changes) byRec[c.recommendation] = (byRec[c.recommendation] || 0) + 1;
  const byRegion = {};
  for (const c of changes) {
    const key = c.region || 'Unassigned';
    byRegion[key] = byRegion[key] || { label: key, value: 0 };
    if (c.delta < 0) byRegion[key].value += 1;
  }
  const title = meta.title || `Asset Condition Revaluation — ${String(meta.at || new Date().toISOString()).slice(0, 10)}`;
  return {
    title,
    generated_at: meta.at || new Date().toISOString(),
    totals: { evaluated: meta.evaluated ?? changes.length, changed: changes.length, degraded: degraded.length, improved: improved.length },
    changes: [...changes].sort((a, b) => a.delta - b.delta),
    buckets: [
      { label: 'Degraded', count: degraded.length },
      { label: 'Unchanged', count: flat.length },
      { label: 'Improved', count: improved.length },
    ],
    by_recommendation: Object.entries(byRec).map(([recommendation, count]) => ({ recommendation, count })),
    by_region: Object.values(byRegion).sort((a, b) => b.value - a.value),
  };
}

// The on-demand monitoring report: read the change log (recent snapshots) and
// summarise the condition drift the agent has recorded.
function recentRevaluationData({ days = 180 } = {}) {
  const since = new Date(Date.now() - days * 864e5).toISOString();
  const rows = db.prepare(
    `SELECT s.*, a.asset_id AS asset_code, a.name AS asset_name, a.asset_type
       FROM asset_health_snapshot s JOIN asset a ON a.id = s.asset_id
      WHERE s.captured_at >= ? ORDER BY s.captured_at DESC, s.id DESC`
  ).all(since);
  const seen = new Set();
  const changes = [];
  for (const r of rows) {
    if (seen.has(r.asset_id)) continue;
    seen.add(r.asset_id);
    let reasons = [];
    try { reasons = typeof r.reasons === 'string' ? JSON.parse(r.reasons) : (r.reasons || []); } catch (_) { reasons = []; }
    changes.push({
      asset_pk: r.asset_id,
      asset_code: r.asset_code,
      asset_name: r.asset_name || r.asset_code,
      asset_type: r.asset_type || null,
      region: assetRegionLabel(get('asset', r.asset_id) || {}),
      from_rating: r.condition_rating != null ? Number(r.condition_rating) : null,
      to_rating: r.suggested_rating != null ? Number(r.suggested_rating) : null,
      delta: r.condition_rating != null && r.suggested_rating != null ? Math.round((Number(r.suggested_rating) - Number(r.condition_rating)) * 10) / 10 : 0,
      health_index: r.health_index,
      remaining_useful_life_years: r.remaining_useful_life_years,
      recommendation: r.recommendation,
      recommendation_label: r.recommendation,
      confidence: null,
      reasons,
      source: r.source,
      captured_at: r.captured_at,
    });
  }
  const latest = rows[0] ? rows[0].captured_at : null;
  return changesToData(changes, { title: 'Asset Condition Revaluation Report', at: latest || new Date().toISOString(), evaluated: seen.size });
}

function monitorSummary() {
  const last = db.prepare('SELECT * FROM asset_health_snapshot ORDER BY captured_at DESC, id DESC LIMIT 1').get();
  const total = db.prepare('SELECT COUNT(*) c FROM asset_health_snapshot').get().c;
  const since = new Date(Date.now() - 30 * 864e5).toISOString();
  const changed30 = db.prepare('SELECT COUNT(DISTINCT asset_id) c FROM asset_health_snapshot WHERE captured_at >= ?').get(since).c;
  const degraded = recentRevaluationData({ days: 180 }).changes.filter((c) => c.delta < 0).length;
  return { last_run_at: last ? last.captured_at : null, snapshots: total, assets_changed_30d: changed30, degraded, candidate_assets: candidateAssets().length };
}

module.exports = { revalueAssets, recentRevaluationData, changesToData, monitorSummary, latestSnapshot, candidateAssets };
