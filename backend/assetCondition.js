// Evidence-based condition assessment for assets.
//
// A rating can still be entered by hand, but the platform derives a *suggested*
// condition from the maintenance evidence actually recorded against an asset:
// failed tasks, checklist step pass/fail (critical steps weighted), field
// findings by severity, GPS mismatches, asset age and maintenance history. The
// suggestion is advisory — an authorised evaluator confirms it (or overrides it
// with a manual rating) before it becomes the stored `condition_rating`.
//
// The baseline is age-driven and the penalties are computed from the full
// evidence set, so re-running the suggestion without new evidence yields the
// same number (confirming a suggestion never ratchets the rating down again).

const { db, get } = require('./util');
const { ageYears, ageBaseline, computeHealth, RECOMMENDATION_LABELS } = require('./assetBaseline');
const { evaluatePerformance } = require('./assetPerformance');

function inClause(n) {
  return new Array(n).fill('?').join(',');
}

function rankRecommendation(rating, asset, evidence) {
  const critical = String((asset && asset.criticality) || '').toUpperCase() === 'CRITICAL';
  if (rating <= 2) return 'REPLACE';
  if (rating <= 4 && (critical || (evidence.age_years != null && evidence.age_years >= 40))) return 'REPLACE';
  if (rating <= 4) return 'REPAIR';
  if (rating <= 6) return critical ? 'REPAIR' : 'INSPECT';
  if (evidence.critical_fails > 0 || evidence.findings_critical > 0 || evidence.gps_fails > 0) return 'INSPECT';
  return 'MONITOR';
}

function suggestAssetCondition(asset) {
  if (!asset) return null;
  const reasons = [];
  const years = ageYears(asset.installation_date);
  let score = ageBaseline(years);

  const tasks = db.prepare('SELECT id, status, result FROM task WHERE asset_id = ?').all(asset.id);
  const taskIds = tasks.map((t) => t.id);
  const completed = tasks.filter((t) => t.status === 'COMPLETED');
  const failedTasks = tasks.filter((t) => t.result === 'FAIL' || t.status === 'FAILED');

  let graded = 0;
  let fails = 0;
  let criticalFails = 0;
  if (taskIds.length) {
    const items = db.prepare(
      `SELECT i.result, ci.critical_step
         FROM checklist_execution_item i
         JOIN checklist_execution e ON e.id = i.execution_id
         LEFT JOIN checklist_item ci ON ci.id = i.template_item_id
        WHERE e.task_id IN (${inClause(taskIds.length)})`
    ).all(...taskIds);
    for (const r of items) {
      if (r.result === 'PASS' || r.result === 'FAIL') graded += 1;
      if (r.result === 'FAIL') {
        fails += 1;
        if (r.critical_step) criticalFails += 1;
      }
    }
  }

  let findingsCritical = 0;
  let findingsHigh = 0;
  if (taskIds.length) {
    const rows = db.prepare(
      `SELECT severity, COUNT(*) c FROM task_finding WHERE task_id IN (${inClause(taskIds.length)}) GROUP BY severity`
    ).all(...taskIds);
    for (const r of rows) {
      if (r.severity === 'CRITICAL') findingsCritical = r.c;
      else if (r.severity === 'HIGH') findingsHigh = r.c;
    }
  }

  const gpsFails = db.prepare(
    `SELECT COUNT(*) c FROM gps_validation
      WHERE result = 'FAIL'
        AND ((target_type = 'ASSET' AND target_id = ?)${taskIds.length ? ` OR linked_task_id IN (${inClause(taskIds.length)})` : ''})`
  ).get(asset.id, ...taskIds).c;

  const events = db.prepare('SELECT * FROM asset_maintenance_event WHERE asset_id = ? ORDER BY performed_at DESC').all(asset.id);
  const lastMaint = events[0] || null;
  const lastConditionAfter = events.find((e) => e.condition_after != null) || null;
  const sinceMaint = lastMaint ? ageYears(lastMaint.performed_at) : (asset.last_maintenance_at ? ageYears(asset.last_maintenance_at) : null);

  if (failedTasks.length) {
    score -= Math.min(3, failedTasks.length * 1.5);
    reasons.push(`${failedTasks.length} failed maintenance task(s) on this asset`);
  }
  if (criticalFails) {
    score -= Math.min(3, criticalFails);
    reasons.push(`${criticalFails} critical checklist step(s) failed`);
  }
  if (fails > criticalFails) {
    score -= Math.min(2, (fails - criticalFails) * 0.5);
    reasons.push(`${fails - criticalFails} non-critical checklist step(s) failed`);
  }
  if (graded >= 4 && fails / graded > 0.4) {
    score -= 1;
    reasons.push(`high checklist failure ratio (${Math.round((fails / graded) * 100)}% of ${graded} graded steps)`);
  }
  if (findingsCritical) {
    score -= Math.min(3, findingsCritical * 1.5);
    reasons.push(`${findingsCritical} CRITICAL finding(s) recorded`);
  }
  if (findingsHigh) {
    score -= Math.min(2, findingsHigh * 0.75);
    reasons.push(`${findingsHigh} HIGH finding(s) recorded`);
  }
  if (gpsFails) {
    score -= Math.min(1, gpsFails * 0.5);
    reasons.push(`${gpsFails} GPS mismatch validation(s)`);
  }
  if (sinceMaint != null && sinceMaint >= 3) {
    score -= 1;
    reasons.push(`no maintenance in the last ${Math.round(sinceMaint)} years`);
  } else if (sinceMaint == null && years != null && years >= 10) {
    score -= 1;
    reasons.push('no maintenance history recorded');
  }
  // A recently measured post-maintenance condition pulls the suggestion toward
  // what the field actually observed.
  if (lastConditionAfter) {
    score = score * 0.5 + Number(lastConditionAfter.condition_after) * 0.5;
    reasons.push(`last recorded post-maintenance condition was ${lastConditionAfter.condition_after}/10`);
  }

  const readings = db.prepare('SELECT * FROM asset_reading WHERE asset_id = ? ORDER BY recorded_at DESC').all(asset.id);
  const perfEvents = db.prepare('SELECT * FROM asset_performance_event WHERE asset_id = ? ORDER BY occurred_at DESC').all(asset.id);
  const hasPerformance = readings.length > 0 || perfEvents.length > 0;
  const performance = hasPerformance
    ? evaluatePerformance(asset, readings, perfEvents, { baseRating: score })
    : {
      base_rating: score,
      performance_delta: 0,
      combined_rating: score,
      degradation_rate: 0,
      factors: [],
      confidence: 'LOW',
      model_version: null,
      reasons: [],
    };
  if (hasPerformance) {
    score = performance.combined_rating;
    for (const f of performance.factors) {
      if (f.contribution < 0 && !reasons.includes(f.reason)) reasons.push(f.reason);
    }
  }

  const suggested = Math.max(1, Math.min(10, Math.round(score)));
  const health = computeHealth({ ...asset, condition_rating: suggested });
  const evidence = {
    tasks: tasks.length,
    completed: completed.length,
    failed_tasks: failedTasks.length,
    checklist_graded: graded,
    checklist_fails: fails,
    critical_fails: criticalFails,
    findings_critical: findingsCritical,
    findings_high: findingsHigh,
    gps_fails: gpsFails,
    maintenance_events: events.length,
    last_maintenance_at: lastMaint ? lastMaint.performed_at : (asset.last_maintenance_at || null),
    age_years: years == null ? null : Math.round(years * 10) / 10,
  };
  const recommendation = rankRecommendation(suggested, asset, evidence);
  const hasFieldEvidence = graded > 0 || fails > 0 || findingsCritical > 0 || findingsHigh > 0 || events.length > 0;
  if (!reasons.length) reasons.push('no adverse evidence recorded — rating follows asset age');
  return {
    asset_id: asset.id,
    asset_code: asset.asset_id,
    asset_name: asset.name,
    current_rating: asset.condition_rating != null ? asset.condition_rating : null,
    suggested_rating: suggested,
    delta: asset.condition_rating != null ? suggested - Number(asset.condition_rating) : null,
    health_index: health.health_index,
    remaining_useful_life_years: health.remaining_useful_life_years,
    recommendation,
    recommendation_label: RECOMMENDATION_LABELS[recommendation],
    confidence: (hasFieldEvidence || hasPerformance) ? 'HIGH' : 'LOW',
    reasons,
    evidence,
    performance: hasPerformance ? performance : null,
    base_rating: performance.base_rating,
    performance_delta: performance.performance_delta,
    combined_rating: performance.combined_rating,
    degradation_rate: performance.degradation_rate,
    factors: performance.factors,
    generated_at: new Date().toISOString(),
  };
}

module.exports = { computeHealth, suggestAssetCondition, ageYears };
