const { db } = require('./db');

// Highest existing sequence across all task numbers. Scan via SQL instead of
// loading every row into JS: legacy values like TK-SCRATCH-CAP are excluded by
// the numeric GLOB, so they cannot poison the next number.
function maxTaskSeq() {
  const r = db.prepare(
    "SELECT MAX(CAST(substr(task_number, 9) AS INTEGER)) AS m FROM task WHERE task_number GLOB 'TK-[0-9][0-9][0-9][0-9]-[0-9]*'"
  ).get();
  return Number(r && r.m) || 0;
}

function currentYear() {
  return new Date().getFullYear();
}

function formatTaskNumber(seq) {
  return `TK-${currentYear()}-${String(seq).padStart(6, '0')}`;
}

function nextTaskNumber() {
  return formatTaskNumber(maxTaskSeq() + 1);
}

module.exports = { maxTaskSeq, formatTaskNumber, nextTaskNumber };
