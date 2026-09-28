const { db } = require('./util');

function latestSubmittedExecution(taskId) {
  return db.prepare(
    'SELECT * FROM checklist_execution WHERE task_id = ? AND submitted_at IS NOT NULL ORDER BY id DESC LIMIT 1'
  ).get(taskId) || null;
}

// Display-only checklist progress: pass rate over the graded items of the
// latest submitted execution of *each* template a task is governed by, so a
// multi-checklist task reflects all of its runs. Never drives a state
// transition.
function taskProgress(taskId) {
  const items = db.prepare(
    `SELECT i.result FROM checklist_execution_item i
       JOIN (SELECT template_id, MAX(id) AS exec_id FROM checklist_execution
              WHERE task_id = ? AND submitted_at IS NOT NULL
              GROUP BY template_id) m
         ON m.exec_id = i.execution_id`
  ).all(taskId);
  if (!items.length) return { progress_pct: 0, progress_graded: 0, progress_passed: 0 };
  const graded = items.filter((i) => i.result === 'PASS' || i.result === 'FAIL').length;
  const passed = items.filter((i) => i.result === 'PASS').length;
  return {
    progress_pct: graded > 0 ? Math.round((passed / graded) * 100) : 0,
    progress_graded: graded,
    progress_passed: passed,
  };
}

module.exports = { taskProgress, latestSubmittedExecution };
