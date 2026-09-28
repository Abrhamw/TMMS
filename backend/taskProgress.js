const { db } = require('./util');

function latestSubmittedExecution(taskId) {
  return db.prepare(
    'SELECT * FROM checklist_execution WHERE task_id = ? AND submitted_at IS NOT NULL ORDER BY id DESC LIMIT 1'
  ).get(taskId) || null;
}

// Display-only checklist progress: pass rate over the graded items of the
// latest submitted execution. Never drives a state transition.
function taskProgress(taskId) {
  const execRow = latestSubmittedExecution(taskId);
  if (!execRow) return { progress_pct: 0, progress_graded: 0, progress_passed: 0 };
  const items = db.prepare('SELECT result FROM checklist_execution_item WHERE execution_id = ?').all(execRow.id);
  const graded = items.filter((i) => i.result === 'PASS' || i.result === 'FAIL').length;
  const passed = items.filter((i) => i.result === 'PASS').length;
  return {
    progress_pct: graded > 0 ? Math.round((passed / graded) * 100) : 0,
    progress_graded: graded,
    progress_passed: passed,
  };
}

module.exports = { taskProgress, latestSubmittedExecution };
