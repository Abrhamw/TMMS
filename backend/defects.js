'use strict';

const { db, insertRow, nextCode } = require('./util');

const DEFECT_SEVERITIES = new Set(['LOW', 'MEDIUM', 'HIGH', 'CRITICAL']);
const DEFECT_LIKELIHOODS = new Set(['RARE', 'UNLIKELY', 'POSSIBLE', 'LIKELY', 'ALMOST_CERTAIN']);
const ROOT_CAUSES = new Set([
  'DESIGN', 'MANUFACTURING', 'INSTALLATION', 'OPERATION', 'MAINTENANCE',
  'ENVIRONMENT', 'MATERIAL', 'HUMAN', 'PROCUREMENT', 'UNKNOWN', 'OTHER',
]);
const DISPOSITIONS = new Set(['CORRECTED', 'TEMPORARY_REPAIR', 'ACCEPTED_RISK', 'NOT_A_DEFECT', 'DEFERRED_MONITORED']);

const DEFECT_STATUSES = new Set(['OPEN', 'IN_PROGRESS', 'MITIGATED', 'RESOLVED', 'CLOSED', 'ACCEPTED']);
const OPEN_DEFECT_STATUSES = new Set(['OPEN', 'IN_PROGRESS', 'MITIGATED', 'RESOLVED']);
const TERMINAL_STATUSES = new Set(['CLOSED', 'ACCEPTED']);

// Forward-only lifecycle. Reopening is explicit and always lands back at OPEN.
const TRANSITIONS = {
  OPEN: ['IN_PROGRESS', 'MITIGATED', 'RESOLVED', 'ACCEPTED'],
  IN_PROGRESS: ['MITIGATED', 'RESOLVED', 'ACCEPTED', 'OPEN'],
  MITIGATED: ['RESOLVED', 'ACCEPTED', 'OPEN'],
  RESOLVED: ['CLOSED', 'ACCEPTED', 'OPEN'],
  CLOSED: [],
  ACCEPTED: [],
};

const SEVERITY_WEIGHT = { LOW: 1, MEDIUM: 2, HIGH: 3, CRITICAL: 4 };
const LIKELIHOOD_WEIGHT = { RARE: 1, UNLIKELY: 2, POSSIBLE: 3, LIKELY: 4, ALMOST_CERTAIN: 5 };

function canTransition(from, to) {
  return (TRANSITIONS[from] || []).includes(to);
}

// Risk is severity x likelihood on a 1..20 scale, so a critical-but-rare and a
// high-and-likely defect are directly comparable.
function riskScore(severity, likelihood) {
  const s = SEVERITY_WEIGHT[severity] || 0;
  const l = LIKELIHOOD_WEIGHT[likelihood] || 0;
  return s && l ? s * l : null;
}

function isOpen(defect) {
  return !!defect && OPEN_DEFECT_STATUSES.has(defect.status);
}

function defectSummary(taskId) {
  const rows = db.prepare('SELECT * FROM defect WHERE task_id = ? ORDER BY id').all(taskId);
  return {
    task_id: Number(taskId),
    total: rows.length,
    open: rows.filter((d) => OPEN_DEFECT_STATUSES.has(d.status)).length,
    by_severity: rows.reduce((acc, d) => { acc[d.severity] = (acc[d.severity] || 0) + 1; return acc; }, {}),
    defects: rows,
  };
}

// Raise a controlled defect for a critical/high finding on a completed task and
// (when one was auto-generated) link it to the corrective task. Idempotent on
// finding_id so re-running completion side effects cannot duplicate defects.
function createDefectFromFinding(finding, task, correctiveTaskId, actorId) {
  if (!finding || !task || !['CRITICAL', 'HIGH'].includes(finding.severity)) return null;
  const existing = db.prepare('SELECT id FROM defect WHERE finding_id = ?').get(finding.id);
  if (existing) {
    if (correctiveTaskId && !db.prepare('SELECT corrective_task_id FROM defect WHERE id = ?').get(existing.id).corrective_task_id) {
      db.prepare('UPDATE defect SET corrective_task_id = ?, updated_at = ? WHERE id = ?').run(correctiveTaskId, new Date().toISOString(), existing.id);
    }
    return existing.id;
  }
  const now = new Date().toISOString();
  return insertRow('defect', {
    defect_number: nextCode('DEF', 'defect', 'defect_number', 4),
    task_id: task.id,
    finding_id: finding.id,
    asset_id: task.asset_id || null,
    region_id: task.region_id || null,
    title: finding.title,
    description: finding.detail || null,
    severity: finding.severity,
    status: 'OPEN',
    corrective_task_id: correctiveTaskId || null,
    created_by: actorId || null,
    created_at: now,
    updated_at: now,
  });
}

module.exports = {
  DEFECT_SEVERITIES, DEFECT_LIKELIHOODS, ROOT_CAUSES, DISPOSITIONS,
  DEFECT_STATUSES, OPEN_DEFECT_STATUSES, TERMINAL_STATUSES, TRANSITIONS,
  canTransition, riskScore, isOpen, defectSummary, createDefectFromFinding,
};
